"use strict";

/**
 * activityStore.js — persistence + ingestion for the structured activity data.
 *
 * Why snapshots instead of normalised rows: the model (activityModel.js) is
 * recomputed on read, so changing a catalog entry or cause mapping re-labels
 * every stored day without a migration. Each snapshot is a trimmed copy of one
 * account's slice of one run (~5-10 KB), keyed by (run_id, email).
 *
 * Data sources:
 *   GET /history     -> the durable record (completion, bySource, streaks...)
 *   GET /status.run  -> extras that /history omits (earnable, searchSummary,
 *                       browserPhases, appQuotaState). Only the latest finished
 *                       run is there, so it must be captured at run end.
 * When the upstream script adds those fields to /history, attachExtras()
 * simply becomes a no-op: the keys are already present on the snapshot.
 */

const zlib = require("node:zlib");
const { normalizeRun, buildDaysFromEntries, compactDay } = require("./activityModel");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_account_snapshots (
  run_id   TEXT NOT NULL,
  email    TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (run_id, email)
);
CREATE INDEX IF NOT EXISTS idx_ras_email_ended
  ON run_account_snapshots (email, ended_at);
`;

const EXTRA_KEYS = ["earnable", "searchSummary", "browserPhases", "appQuotaState"];
const DETAIL_LISTS = ["completed", "incomplete", "unavailable", "notApplicable"];
const DAY_MS = 24 * 3600 * 1000;
const RETRY_BACKOFF_MS = 60 * 1000;

function trimDetail(d) {
  const out = {};
  for (const k of [
    "activity", "label", "platform", "status", "reason", "category",
    "pointsGained", "pointsKnown", "title", "offerId", "message",
    "balanceBefore", "balanceAfter",
  ])
    if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  return out;
}

function trimAccount(a) {
  const completion = a.completion || {};
  const out = {
    level: a.level ?? null,
    pointsProgress: a.pointsProgress ?? null,
    pointsRemaining: a.pointsRemaining ?? null,
    lifetimeEarn: a.lifetimeEarn ?? null,
    status: a.status ?? null,
    success: a.success ?? null,
    error: a.error ?? null,
    durationSeconds: a.durationSeconds ?? null,
    resetAt: a.resetAt ?? null,
    resetAtSource: a.resetAtSource ?? null,
    initialPoints: a.initialPoints ?? null,
    currentBalance: a.currentBalance ?? null,
    collected: a.collected ?? 0,
    pointsKnown: a.pointsKnown ?? null,
    bySource: a.bySource || {},
    unattributed: a.unattributed ?? 0,
    streaks: a.streaks || [],
    streakProtection: a.streakProtection ?? null,
    edgeBrowsing: a.edgeBrowsing ?? null,
    completion: {
      counts: completion.counts || null,
      omitted: completion.omitted || 0,
    },
  };
  for (const list of DETAIL_LISTS)
    out.completion[list] = (completion[list] || []).map(trimDetail);
  for (const k of EXTRA_KEYS) if (a[k] !== undefined) out[k] = a[k];
  return out;
}

class ActivityStore {
  /**
   * @param {import("node:sqlite").DatabaseSync} db  the dashboard's existing DB
   * @param {{retentionDays?: number, log?: Function}} [opts]
   */
  constructor(db, { retentionDays = 120, log = () => {} } = {}) {
    this.db = db;
    this.retentionDays = retentionDays;
    this.log = log;
    db.exec(SCHEMA);
    this.stmts = {
      insert: db.prepare(
        `INSERT OR IGNORE INTO run_account_snapshots (run_id, email, ended_at, snapshot)
         VALUES (?, ?, ?, ?)`,
      ),
      byRun: db.prepare(
        "SELECT email, snapshot FROM run_account_snapshots WHERE run_id = ?",
      ),
      update: db.prepare(
        "UPDATE run_account_snapshots SET snapshot = ? WHERE run_id = ? AND email = ?",
      ),
      since: db.prepare(
        `SELECT snapshot FROM run_account_snapshots
         WHERE ended_at >= ? ORDER BY ended_at ASC`,
      ),
      prune: db.prepare("DELETE FROM run_account_snapshots WHERE ended_at < ?"),
      count: db.prepare("SELECT COUNT(*) AS n FROM run_account_snapshots"),
    };
    this._seenRuns = new Set(); // run ids already ingested, even if empty
    this._pendingExtras = new Map(); // runId -> status accounts, if history lags
    this._inFlight = null;
    this._retryAt = 0;
    this.booted = false;
    // Bumped whenever stored data changes; drives the cached payload + ETag.
    // The epoch keeps ETags unique across restarts.
    this.version = 0;
    this._epoch = Date.now().toString(36);
    this._payloads = new Map();
  }

  get size() {
    return this.stmts.count.get().n;
  }

  /** Ingest GET /history records (either shape). Returns snapshots added. */
  ingestRecords(records) {
    let added = 0;
    for (const rec of records || []) {
      if (!rec) continue;
      const runId = rec.runId || (rec.exit && rec.exit.runId) || null;
      if (runId) this._seenRuns.add(runId);
      for (const entry of normalizeRun(rec)) {
        const id = runId || `${rec.startedAt}`;
        const stored = {
          runId: id,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          email: entry.email,
          account: trimAccount(entry.account),
        };
        const res = this.stmts.insert.run(
          id,
          entry.email,
          entry.endedAt || entry.startedAt || new Date().toISOString(),
          JSON.stringify(stored),
        );
        added += Number(res.changes);
      }
      if (added) this.version++;
      if (runId && this._pendingExtras.has(runId)) {
        this.attachExtras(runId, this._pendingExtras.get(runId));
        this._pendingExtras.delete(runId);
      }
    }
    return added;
  }

  /** Merge /status run extras into the stored snapshots of one run. */
  attachExtras(runId, statusAccounts) {
    if (!runId || !Array.isArray(statusAccounts)) return 0;
    const rows = this.stmts.byRun.all(runId);
    if (!rows.length) {
      // History hasn't produced this run yet; keep the extras for ingest.
      this._pendingExtras.set(runId, statusAccounts);
      if (this._pendingExtras.size > 5)
        this._pendingExtras.delete(this._pendingExtras.keys().next().value);
      return 0;
    }
    const byEmail = new Map(
      statusAccounts
        .filter((a) => a && a.email)
        .map((a) => [String(a.email).trim().toLowerCase(), a]),
    );
    let updated = 0;
    for (const row of rows) {
      const src = byEmail.get(row.email);
      if (!src) continue;
      const stored = JSON.parse(row.snapshot);
      let changed = false;
      for (const k of EXTRA_KEYS)
        if (src[k] !== undefined && stored.account[k] === undefined) {
          stored.account[k] = src[k];
          changed = true;
        }
      if (changed) {
        this.stmts.update.run(JSON.stringify(stored), runId, row.email);
        updated++;
      }
    }
    if (updated) this.version++;
    return updated;
  }

  prune(now = Date.now()) {
    const cutoff = new Date(now - this.retentionDays * DAY_MS).toISOString();
    const removed = Number(this.stmts.prune.run(cutoff).changes);
    if (removed) this.version++;
    return removed;
  }

  /**
   * Serialised, gzipped API payload for GET /api/activity-days, rebuilt only
   * when the data changes (or the hour rolls over, since the window moves).
   * @returns {{etag:string, json:Buffer, gzip:Buffer}}
   */
  payload({ days = 14, now = Date.now() } = {}) {
    const hour = Math.floor(now / 3600000);
    const hit = this._payloads.get(days);
    if (hit && hit.version === this.version && hit.hour === hour) return hit;
    const full = this.daysAll({ days, now });
    const accounts = {};
    for (const [email, list] of Object.entries(full.accounts))
      accounts[email] = list.map(compactDay);
    const json = Buffer.from(JSON.stringify({ accounts }));
    const built = {
      version: this.version,
      hour,
      etag: `W/"${this._epoch}-${this.version}-${hour}-${days}"`,
      json,
      gzip: zlib.gzipSync(json),
    };
    this._payloads.set(days, built);
    return built;
  }

  /**
   * Day tables for every account.
   * @returns {{ accounts: Record<string, object[]> }}  newest day first
   */
  daysAll({ days = 14, now = Date.now() } = {}) {
    const cutoff = new Date(now - (days + 2) * DAY_MS).toISOString();
    const entries = this.stmts
      .since.all(cutoff)
      .map((r) => JSON.parse(r.snapshot));
    const built = buildDaysFromEntries(entries);
    const accounts = {};
    for (const [email, byDay] of built) {
      accounts[email] = [...byDay.values()]
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, days);
    }
    return { accounts };
  }

  // -- sync from the Control API -------------------------------------------

  needsSync(status) {
    if (Date.now() < this._retryAt) return false; // back off after a failure
    if (!this.booted) return true;
    const id = status && status.lastExit && status.lastExit.runId;
    return Boolean(id && !this._seenRuns.has(id));
  }

  /**
   * Pull /history (and, for the run that just ended, /status extras).
   * Safe to call often: concurrent calls share one in-flight request.
   */
  sync(client, status, { limit = 20 } = {}) {
    if (this._inFlight) return this._inFlight;
    this._inFlight = (async () => {
      try {
        const data = await client.get(`/history?limit=${limit}`);
        const added = this.ingestRecords(data.runs || []);
        const run = status && status.run;
        // Script >= beta6 stamps the run's own id on /status.run.
        const runId =
          (run && run.finished && run.runId) ||
          (status && status.lastExit && status.lastExit.runId);
        if (runId && run && run.finished && Array.isArray(run.accounts))
          this.attachExtras(runId, run.accounts);
        this.booted = true;
        if (added) this.prune();
        this._retryAt = 0;
        return { added };
      } catch (e) {
        this._retryAt = Date.now() + RETRY_BACKOFF_MS;
        throw e;
      } finally {
        this._inFlight = null;
      }
    })();
    return this._inFlight;
  }

  /** Fire-and-forget wrapper for event handlers. */
  syncSoon(client, status) {
    this.sync(client, status).catch((e) =>
      this.log("warn", `Activity sync failed: ${e.message}`),
    );
  }
}

module.exports = { ActivityStore, trimAccount, SCHEMA };
