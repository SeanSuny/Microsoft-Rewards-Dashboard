"use strict";

/**
 * activityModel.js — turns the Control API's structured run data into a
 * per-account, per-Rewards-day activity table.
 *
 * Input shapes accepted (both are the same data, differently trimmed):
 *   - GET /history record:      { runId, startedAt, endedAt, accounts: [...] }
 *   - config/run-history.json:  { runId, startedAt, endedAt, run: { accounts: [...] } }
 * Optional extras (earnable, searchSummary, browserPhases) exist only on
 * GET /status -> run.accounts[], so attachExtras() merges them in by email.
 *
 * Nothing here touches the DB, the network, or the DOM.
 */

// ---------------------------------------------------------------------------
// Catalog: script activity id -> table group. Unknown ids fall into "other"
// (and are reported in day.unmapped) so a new script release can't silently
// disappear from the table.
// ---------------------------------------------------------------------------
const GROUPS = {
  search: { label: "Searches", order: 10 },
  "mobile-search": { label: "Mobile search quota", order: 11 },
  "daily-set": { label: "Daily Set", order: 20 },
  "more-promotions": { label: "More Promos", order: 30 },
  punchcards: { label: "Punch Cards", order: 40 },
  "read-to-earn": { label: "Read to Earn", order: 50 },
  "daily-check-in": { label: "Daily Check-in", order: 60 },
  "bonus-claim": { label: "Bonus Claim", order: 70 },
  "visual-search": { label: "Visual Search", order: 80 },
  "streak-protection": { label: "Streak Protection", order: 90 },
  "edge-browsing": { label: "Edge Browsing", order: 100 },
  "search-perk": { label: "Search Perk", order: 110 },
  other: { label: "Other", order: 900 },
};

const ACTIVITY_GROUP = {
  search: "search",
  "browser-search-api-report": "search", // informational, hidden below
  "mobile-search-quota": "mobile-search",
  "daily-set": "daily-set",
  "more-promotions": "more-promotions",
  "punchcard-child": "punchcards",
  "read-to-earn": "read-to-earn",
  "daily-check-in": "daily-check-in",
  doClaimBonusPoints: "bonus-claim",
  "visual-search": "visual-search",
  doEnsureStreakProtection: "streak-protection",
  "edge-browsing": "edge-browsing",
  doActivateSearchPerk: "search-perk",
};

// Activities that carry no user-visible outcome of their own.
const HIDDEN_ACTIVITIES = new Set(["browser-search-api-report"]);

// ---------------------------------------------------------------------------
// Classification. The script already sorts every result into one of
// completed / incomplete / unavailable / notApplicable. We keep that and only
// split "incomplete" by reason code, because that bucket mixes "the script
// couldn't read the state" with "something needs attention".
// ---------------------------------------------------------------------------
const UNVERIFIED_REASONS = new Set([
  "quota-unavailable",
  "activation-data-unavailable",
  "offer-not-confirmed",
  "claim-not-confirmed",
  "claimable-bonus-unknown",
  "offer-progress-unchanged",
  "switch-unavailable",
  "desktop-token-unavailable",
]);
const ATTENTION_REASONS = new Set([
  "ambiguous-target",
  "activation-control-missing",
  "search-attempt-limit-reached",
]);
// Not a failure: the step simply isn't done yet. Excluded from the verdict.
const INFORMATIONAL_PENDING = new Set(["step-incomplete"]);

/**
 * @returns {{state:string, cause:string, informational?:boolean}}
 * state: done | pending | unverified | attention | unavailable | n/a
 */
function classifyDetail(d, ctx = {}) {
  switch (d.category) {
    case "completed":
      return { state: "done", cause: "confirmed" };
    case "unavailable":
      return { state: "unavailable", cause: "not-offered" };
    case "notApplicable":
      return { state: "n/a", cause: "not-applicable" };
    default:
  }
  // category === "incomplete"
  if (
    d.activity === "visual-search" &&
    d.reason === "activation-control-missing" &&
    ctx.hasVisualSearchStreak === false
  ) {
    // Accounts that never receive a Visual Search streak always hit this.
    return { state: "unavailable", cause: "likely-not-offered" };
  }
  if (d.status === "failed") return { state: "attention", cause: "failed" };
  if (INFORMATIONAL_PENDING.has(d.reason))
    return { state: "pending", cause: d.reason, informational: true };
  if (ATTENTION_REASONS.has(d.reason))
    return { state: "attention", cause: d.reason };
  if (UNVERIFIED_REASONS.has(d.reason))
    return { state: "unverified", cause: d.reason };
  return { state: "unverified", cause: d.reason || "unknown-reason" };
}

// ---------------------------------------------------------------------------
// Rewards day. The day does NOT roll at local midnight: the script reports the
// next reset (08:00Z in the sample data). Preference order:
//   1. account.resetAt            (script >= beta6; resetAtSource "service" or
//                                  "estimated" local midnight)
//   2. streaks[].resetAt          (older records)
//   3. a fixed UTC hour           (runs with neither)
// The day is named after the UTC date of its midpoint (reset - 12h), which is
// the calendar date the reset window belongs to for any timezone within
// roughly +/-12h of UTC.
// ---------------------------------------------------------------------------
const DEFAULT_RESET_HOUR_UTC = 8;
const HOUR = 3600 * 1000;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

function rewardsDayKey(entry, resetHourUtc = DEFAULT_RESET_HOUR_UTC) {
  const own = Date.parse(entry.account.resetAt);
  const resetAt = Number.isFinite(own)
    ? own
    : (entry.account.streaks || []).map((s) => Date.parse(s.resetAt)).find(Number.isFinite);
  if (resetAt) return isoDate(resetAt - 12 * HOUR);
  const ts = Date.parse(entry.endedAt || entry.startedAt);
  return isoDate(ts - resetHourUtc * HOUR);
}

// ---------------------------------------------------------------------------
// Run record normalisation
// ---------------------------------------------------------------------------
const normEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");

/** One flat entry per (run, account), whichever record shape came in. */
function normalizeRun(record) {
  const accounts =
    (record && (record.accounts || (record.run && record.run.accounts))) || [];
  return accounts
    .filter((a) => a && a.email)
    .map((a) => {
      const live = a.live || {};
      return {
        runId: record.runId || (record.run && record.run.runId) || null,
        startedAt: record.startedAt,
        endedAt: record.endedAt || record.startedAt,
        email: normEmail(a.email),
        account: {
          ...a,
          bySource: a.bySource || live.bySource || {},
          unattributed: a.unattributed ?? live.unattributed ?? 0,
          collected: a.collected ?? a.collectedPoints ?? 0,
          currentBalance: a.currentBalance ?? a.finalPoints ?? null,
          completion: a.completion || {},
          streaks: a.streaks || [],
        },
      };
    });
}

/** Merge GET /status run extras (earnable, searchSummary, ...) into entries. */
function attachExtras(entries, statusRunAccounts) {
  const byEmail = new Map(
    (statusRunAccounts || []).map((a) => [normEmail(a.email), a]),
  );
  for (const e of entries) {
    const x = byEmail.get(e.email);
    if (!x) continue;
    for (const k of ["earnable", "searchSummary", "browserPhases", "appQuotaState"])
      if (x[k] !== undefined) e.account[k] = x[k];
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Day merge
// ---------------------------------------------------------------------------
const DETAIL_LISTS = ["completed", "incomplete", "unavailable", "notApplicable"];

const itemKey = (d) =>
  d.offerId ? `offer:${d.offerId}` : `${d.activity}:${d.platform || "-"}`;

function detailsOf(completion) {
  return DETAIL_LISTS.flatMap((cat) =>
    (completion[cat] || []).map((d) => ({ ...d, category: cat })),
  );
}

/**
 * Rough points for an activity whose credit the script could not verify
 * (pointsKnown === false), from the account balance observed before and after
 * it (script >= beta6). The script itself warns this difference "is not
 * verified activity credit", so it is only ever shown as an estimate and is
 * never added to any total.
 */
function estimateFromBalance(d) {
  if (d.pointsKnown) return 0;
  const { balanceBefore: before, balanceAfter: after } = d;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0;
  return Math.max(0, after - before);
}

function mergeItems(entries) {
  const items = new Map();
  for (const e of entries) {
    const ctx = {
      hasVisualSearchStreak: e.account.streaks.some(
        (s) => s.partner === "visualsearch",
      ),
    };
    for (const d of detailsOf(e.account.completion)) {
      const c = classifyDetail(d, ctx);
      const pts = d.pointsGained || 0;
      const prev = items.get(itemKey(d));
      if (!prev) {
        items.set(itemKey(d), {
          key: itemKey(d),
          activity: d.activity,
          label: d.label || d.activity,
          title: d.title || null,
          offerId: d.offerId || null,
          platform: d.platform || null,
          state: c.state,
          cause: c.cause,
          informational: Boolean(c.informational),
          reason: d.reason || null,
          message: d.message || null,
          points: pts,
          pointsKnown: Boolean(d.pointsKnown),
          estimatedPoints: estimateFromBalance(d),
          runs: 1,
          lastRunId: e.runId,
        });
        continue;
      }
      prev.runs += 1;
      prev.points += pts; // each run reports only what it earned itself
      prev.estimatedPoints += estimateFromBalance(d);
      prev.pointsKnown = prev.pointsKnown || Boolean(d.pointsKnown);
      prev.lastRunId = e.runId;
      if (d.title && !prev.title) prev.title = d.title;
      // A completed item is never downgraded by a later "already done / not
      // confirmed" report (e.g. check-in: offer-progress-unchanged).
      if (prev.state !== "done") {
        Object.assign(prev, {
          state: c.state,
          cause: c.cause,
          informational: Boolean(c.informational),
          reason: d.reason || null,
          message: d.message || null,
        });
      } else if (pts > 0 && c.state === "done") {
        prev.reason = d.reason || prev.reason; // keep the run that earned
        prev.message = d.message || prev.message;
      }
    }
  }
  return [...items.values()];
}

const SEVERITY = ["attention", "pending", "unverified"];

function groupItems(items) {
  const groups = new Map();
  const unmapped = new Set();
  for (const it of items) {
    if (HIDDEN_ACTIVITIES.has(it.activity)) continue;
    let gid = ACTIVITY_GROUP[it.activity];
    if (!gid) {
      gid = "other";
      unmapped.add(it.activity);
    }
    if (!groups.has(gid))
      groups.set(gid, {
        id: gid,
        label: GROUPS[gid].label,
        order: GROUPS[gid].order,
        items: [],
      });
    groups.get(gid).items.push(it);
  }

  for (const g of groups.values()) {
    const counts = { done: 0, pending: 0, unverified: 0, attention: 0, unavailable: 0, "n/a": 0 };
    for (const it of g.items) counts[it.state] += 1;
    g.counts = counts;
    g.points = g.items.reduce((s, it) => s + it.points, 0);
    g.estimatedPoints = g.items.reduce((s, it) => s + (it.pointsKnown ? 0 : it.estimatedPoints), 0);
    // False when a completed item never reported its points (e.g. punchcard
    // steps), so the UI can show "?" instead of a misleading 0.
    g.pointsKnown = !g.items.some((it) => it.state === "done" && !it.pointsKnown);
    const active = g.items.filter((it) => it.state !== "unavailable" && it.state !== "n/a");
    if (!active.length) {
      g.state = counts.unavailable ? "unavailable" : "n/a";
    } else if (active.every((it) => it.state === "done")) {
      g.state = "done";
    } else if (active.some((it) => it.state === "done")) {
      g.state = "partial";
    } else {
      g.state = SEVERITY.find((s) => counts[s]) || "unverified";
    }
    g.actionable = g.items.some(
      (it) => (it.state === "attention" || it.state === "pending") && !it.informational,
    );
  }
  return { groups: [...groups.values()].sort((a, b) => a.order - b.order), unmapped: [...unmapped] };
}

function dayVerdict(groups) {
  let attention = 0, pending = 0, unverified = 0;
  for (const g of groups)
    for (const it of g.items) {
      if (it.state === "attention") attention++;
      else if (it.state === "pending" && !it.informational) pending++;
      else if (it.state === "unverified") unverified++;
    }
  const state = attention ? "attention" : pending ? "pending" : unverified ? "complete-unverified" : "complete";
  return { state, attention, pending, unverified };
}

function latestStreaks(entries) {
  const byPartner = new Map();
  for (const e of entries)
    for (const s of e.account.streaks) {
      const prev = byPartner.get(s.partner);
      if (!prev || Date.parse(s.updatedAt || 0) >= Date.parse(prev.updatedAt || 0))
        byPartner.set(s.partner, s);
    }
  return [...byPartner.values()];
}

function buildAccountDay(email, day, entries) {
  entries = [...entries].sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const items = mergeItems(entries);
  const { groups, unmapped } = groupItems(items);

  const gained = entries.reduce((s, e) => s + (e.account.collected || 0), 0);
  const unattributed = entries.reduce((s, e) => s + (e.account.unattributed || 0), 0);
  const attributed = groups.reduce((s, g) => s + g.points, 0);
  const first = entries[0].account;
  const last = entries[entries.length - 1].account;
  const withSearch = entries.filter((e) => e.account.searchSummary);
  const withEarnable = entries.filter((e) => e.account.earnable);

  return {
    email,
    day,
    runs: entries.map((e) => e.runId),
    groups,
    unmapped,
    verdict: dayVerdict(groups),
    resetAt: last.resetAt || null,
    resetAtSource: last.resetAtSource || null,
    points: {
      gained,
      attributed,
      unattributed,
      // How much of the unattributed total balance bracketing links to
      // specific activities. Informational only; never part of a total.
      estimatedUnattributed: Math.min(
        Math.max(0, unattributed),
        groups.reduce((s, g) => s + g.estimatedPoints, 0),
      ),
      // gained should equal attributed + unattributed; false means the script
      // reported a total our per-item points don't explain.
      reconciled: gained === attributed + unattributed,
      balanceStart: first.initialPoints ?? null,
      balanceEnd: last.currentBalance,
    },
    searchSummary: withSearch.length
      ? ["mobile", "desktop", "bonus", "apiReport"].reduce((o, k) => {
          o[k] = withSearch.reduce((s, e) => s + (e.account.searchSummary[k] || 0), 0);
          return o;
        }, {})
      : null,
    earnable: withEarnable.length
      ? withEarnable[withEarnable.length - 1].account.earnable
      : null,
    streaks: latestStreaks(entries),
    streakProtection: last.streakProtection || null,
    level: last.level ?? null,
    pointsProgress: last.pointsProgress ?? null,
    pointsRemaining: last.pointsRemaining ?? null,
  };
}

/**
 * The API-size view of a day: everything the UI renders, minus bookkeeping it
 * never reads (ids, keys, raw reason codes, per-item run counts). Roughly half
 * the bytes of the full object; the stored snapshots are unaffected.
 */
function compactDay(day) {
  const { runs, groups, ...rest } = day;
  return {
    ...rest,
    runCount: runs.length,
    groups: groups.map(({ items, actionable, ...g }) => ({
      ...g,
      items: items.map((it) => {
        const out = {
          title: it.title || undefined,
          label: it.label,
          platform: it.platform || undefined,
          state: it.state,
          cause: it.cause,
          points: it.points,
          pointsKnown: it.pointsKnown,
        };
        if (!it.title && !it.label) out.activity = it.activity;
        if (it.estimatedPoints) out.estimatedPoints = it.estimatedPoints;
        // The cause already says it for confirmed items; keep the script's
        // wording only where the UI may need it as a fallback.
        if (it.state !== "done" && it.message) out.message = it.message;
        return out;
      }),
    })),
  };
}

/**
 * @param {object[]} records  GET /history runs (or run-history.json entries)
 * @returns {Map<string, Map<string, object>>}  email -> day -> accountDay
 */
function buildDays(records, opts = {}) {
  return buildDaysFromEntries(records.flatMap(normalizeRun), opts);
}

/** Same as buildDays, but takes already-normalised (run, account) entries. */
function buildDaysFromEntries(entries, { resetHourUtc = DEFAULT_RESET_HOUR_UTC } = {}) {
  const grouped = new Map();
  for (const entry of entries) {
    const day = rewardsDayKey(entry, resetHourUtc);
    const k = `${entry.email}|${day}`;
    if (!grouped.has(k)) grouped.set(k, { email: entry.email, day, entries: [] });
    grouped.get(k).entries.push(entry);
  }
  const out = new Map();
  for (const { email, day, entries } of grouped.values()) {
    if (!out.has(email)) out.set(email, new Map());
    out.get(email).set(day, buildAccountDay(email, day, entries));
  }
  return out;
}

module.exports = {
  GROUPS,
  ACTIVITY_GROUP,
  classifyDetail,
  rewardsDayKey,
  normalizeRun,
  attachExtras,
  mergeItems,
  buildAccountDay,
  buildDays,
  buildDaysFromEntries,
  compactDay,
};
