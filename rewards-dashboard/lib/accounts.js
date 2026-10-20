"use strict";

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

/**
 * @param apiAccounts  rows from the Control API's GET /accounts
 * @param observed     rows from Store.snapshotAccounts()
 * @param histories    Store.allAccountHistories() — email -> point history
 * @param activities   Store.accountActivities() — email -> latest run's activity results
 */
function mergeAccounts(apiAccounts, observed, histories, activities = {}) {
  const configured = Array.isArray(apiAccounts) ? apiAccounts : [];
  const seen = Array.isArray(observed) ? observed : [];
  const byEmail = new Map();
  for (const row of seen) {
    const key = normalizeEmail(row && row.email);
    if (key && !byEmail.has(key)) byEmail.set(key, row);
  }

  const claimed = new Set();
  const merged = configured.map((acc) => {
    const identity = normalizeEmail(acc && acc.email);
    const local = (identity && byEmail.get(identity)) || null;
    if (local) claimed.add(identity);
    return buildRow({ config: acc, local, histories, activities });
  });

  for (const row of seen) {
    const identity = normalizeEmail(row && row.email);
    if (!identity || claimed.has(identity)) continue;
    merged.push(buildRow({ config: null, local: row, histories, activities }));
    claimed.add(identity);
  }

  return merged;
}

function parseCounts(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildRow({ config, local, histories, activities }) {
  const email = (local && local.email) || (config && config.email) || "unknown";
  const history = (local && histories && histories[local.email]) || [];
  const apiProtection = config ? (config.streakProtection ?? null) : null;
  const dayActivities = (local && activities && activities[local.email]) || [];

  return {
    // identity
    key: email,
    email,
    index: config ? config.index : null,
    configured: Boolean(config),
    observed: Boolean(local),

    // configuration (Control API, straight from the bot's .env)
    geoLocale:
      (local && local.geoLocale) || (config && config.geoLocale) || null,
    langCode: config ? config.langCode : null,
    hasTotp: config ? Boolean(config.hasTotp) : null,
    hasRecoveryEmail: config ? Boolean(config.hasRecoveryEmail) : null,
    proxy: config ? config.proxy : null,

    // stats the API derives from its own in-memory run history
    apiRuns: config ? (config.runs ?? 0) : 0,
    apiTotalCollected: config ? (config.totalCollected ?? 0) : 0,
    successStreak: config ? (config.successStreak ?? 0) : 0,
    apiLastRunAt: config ? (config.lastRunAt ?? null) : null,
    apiLastCollected: config ? (config.lastCollected ?? null) : null,
    apiLastSuccess: config ? (config.lastSuccess ?? null) : null,

    // what the dashboard itself observed in the log stream
    status: local ? local.status : "idle",
    userName: local ? local.userName : null,
    lastStartAt: local ? local.lastStartAt : null,
    lastEndAt: local ? local.lastEndAt : null,
    lastGained: local ? local.lastGained : null,
    lastPoints: local ? local.lastPoints : null,
    lastDurationSec: local ? local.lastDurationSec : null,
    lastOutcome: local ? (local.lastOutcome ?? null) : null,
    // Per-activity results and tallies parsed from the bot's own log lines.
    activities: dayActivities,
    activityCounts: local ? parseCounts(local.lastActivityCounts) : null,
    earnable: local ? parseCounts(local.lastEarnable) : null,
    // Once we've observed an account finish, our own record is the answer: a
    // clean result must not fall back to an older error the API still holds.
    lastError:
      local && local.lastEndAt
        ? local.lastError
        : (local && local.lastError) || (config && config.lastError) || null,
    streakProtectionEnabled:
      local && local.streakProtectionEnabled != null
        ? Boolean(local.streakProtectionEnabled)
        : (apiProtection?.enabled ?? null),
    streakProtectionRemainingDays:
      local && local.streakProtectionRemainingDays != null
        ? local.streakProtectionRemainingDays
        : (apiProtection?.remainingDays ?? null),
    streakCounter:
      local && local.streakCounter != null
        ? local.streakCounter
        : (apiProtection?.streakCounter ?? null),
    streakProtectionUpdatedAt:
      (local && local.streakProtectionUpdatedAt) ||
      apiProtection?.updatedAt ||
      null,

    historyCount: history.length,
  };
}

module.exports = { normalizeEmail, mergeAccounts };
