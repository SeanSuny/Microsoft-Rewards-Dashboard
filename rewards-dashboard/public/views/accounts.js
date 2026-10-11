import * as U from "../util.js";
import { cached } from "../api.js";

let accountsPayload = null;
let rootEl = null;
let mounted = false;
let context = null;

const launching = new Set();
const selectedForBatch = new Set();
const expandedAccounts = new Set();
const expandedFeatures = new Set();
let batchRunning = false;

// Two-step delete: a key must be "armed" by a first click before a second
// click on the confirm button actually deletes anything, so there's no way
// to remove an account's dashboard data with a single accidental click.
const deleteArmed = new Set();
const deleting = new Set();

const SOURCE_LABELS = {
  search: "Search",
  bonus: "Bonus search",
  read: "Read",
  checkIn: "Check-in",
  claimReward: "Claim reward",
  claimBonus: "Claim bonus",
  urlReward: "URL reward",
  visualSearch: "Visual search",
  appReward: "App reward",
  punchcard: "Punchcard",
  searchOnBing: "Search activity",
  "daily-set": "Daily Set",
  "more-promotions": "More promotions",
  "punchcard-child": "Punchcard",
  "punchcard-data": "Punchcard",
  "app-data": "App data",
  "daily-check-in": "Daily Check-In",
  "read-to-earn": "Read to Earn",
  "visual-search": "Visual search",
  "visual search": "Visual search",
  "bonus-search": "Bonus search",
  "browser-search-api-report": "Experimental API search",
  "search-on-bing": "Explore on Bing",
  "url-reward": "Website reward",
  "doEnsureStreakProtection": "Streak protection",
  doActivateSearchPerk: "Search perk",
  doClaimBonusPoints: "Bonus point claim",
  doVisualSearch: "Visual search",
};

function controlState() {
  const status = context?.status;
  const usable = Boolean(status?.reachable && status?.authOk !== false);
  const running = Boolean(status?.botRunning);
  return { usable, running };
}

function selectableAccounts() {
  return (accountsPayload?.accounts || []).filter(
    (account) => account.configured && Number.isInteger(account.index),
  );
}

async function runAccount(account) {
  if (!context || !account.configured || !Number.isInteger(account.index)) return;

  launching.add(account.index);
  render(rootEl);
  try {
    await context.api.control("start", { accountIndex: account.index });
    context.toast(
      `Started ACCOUNT_${account.index} only (${account.email}).`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    launching.delete(account.index);
    render(rootEl);
  }
}

async function deleteAccount(account) {
  if (!context) return;

  deleteArmed.delete(account.key);
  expandedFeatures.delete(account.key);
  deleting.add(account.key);
  render(rootEl);
  try {
    await context.api.deleteDashboardAccount(account.email);
    context.toast(`Removed ${account.email} from the dashboard.`, "success");
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    deleting.delete(account.key);
    render(rootEl);
  }
}

async function runSelectedAccounts() {
  if (!context) return;
  const configured = selectableAccounts();
  const selectedIndexes = configured
    .filter((a) => selectedForBatch.has(a.index))
    .map((a) => a.index);
  if (!selectedIndexes.length) return;

  // The control API only accepts an exclusion list, so a "run these x of y"
  // request is expressed as "exclude everyone else".
  const excludedAccountIndexes = configured
    .filter((a) => !selectedForBatch.has(a.index))
    .map((a) => a.index);
  const startBody = excludedAccountIndexes.length ? { excludedAccountIndexes } : {};

  batchRunning = true;
  render(rootEl);
  try {
    await context.api.control("start", startBody);
    context.toast(
      `Started ${selectedIndexes.length}/${configured.length} selected accounts.`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    batchRunning = false;
    render(rootEl);
  }
}

function renderBatchToolbar(root) {
  const configured = selectableAccounts();
  const configuredIndexes = new Set(configured.map((a) => a.index));
  // Drop selections for accounts that disappeared (e.g. .env edited).
  for (const index of [...selectedForBatch]) {
    if (!configuredIndexes.has(index)) selectedForBatch.delete(index);
  }

  const { usable, running } = controlState();
  const count = selectedForBatch.size;
  const total = configured.length;

  U.$("#accountsSelectedCountValue", root).textContent = `${count}/${total}`;

  const allBtn = U.$("#accountsSelectAll", root);
  allBtn.checked = total > 0 && count === total;
  allBtn.indeterminate = count > 0 && count < total;
  allBtn.disabled = total === 0;

  const runBtn = U.$("#accountsRunSelected", root);
  runBtn.disabled = !usable || running || batchRunning || count === 0;
  U.$(".accounts-run-selected-label", runBtn).textContent = batchRunning ? "Starting\u2026" : "Run selected";
}

function featureLabel(activity) {
  const name = cleanFeatureText(activity.activity || activity.name || "Activity");
  const legacyPromotion = /^(Daily set|More promotions):\s*["“](.+?)["”]$/i.exec(name);
  const sourceKey = name.charAt(0).toLowerCase() + name.slice(1);
  const category = SOURCE_LABELS[name] || SOURCE_LABELS[sourceKey] || SOURCE_LABELS[name.toLowerCase()] || legacyPromotion?.[1] || name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/\b\w/g, char => char.toUpperCase());
  const title = cleanFeatureText(activity.title || legacyPromotion?.[2] || "");
  return cleanFeatureText(title ? `${category}: ${title}` : category);
}

function cleanFeatureText(value) {
  return String(value).trim().replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "");
}

function featureState(reason, status) {
  if (/unavailable|not available|quota unavailable|perk unavailable/i.test(reason)) return "unavailable";
  if (status === "failed" || /\bfailed\b/i.test(reason)) return "failed";
  if (status === "skipped" || /\bskipped\b/i.test(reason)) return "skipped";
  return "unconfirmed";
}

function partialReasonFeatures(reason) {
  if (!reason) return [];
  return reason.split(/;\s*/).map(item => {
    const promotion = /^More promotions:\s*["“](.+?)["”]:\s*(.*)$/i.exec(item);
    const match = /^([^:]+):\s*(.*)$/.exec(item);
    if (!match) return null;
    const promotionTitle = /^More promotions\s*\((.+)\)$/i.exec(match[1].trim());
    const label = promotion?.[1] || promotionTitle?.[1] || match[1].trim();
    const detail = promotion?.[2] || match[2];
    return { label, state: featureState(detail, "unconfirmed"), reason: detail };
  }).filter(Boolean);
}

function featureChips(account) {
  const activities = Array.isArray(account.activities) ? account.activities : [];
  const earned = new Map();
  const outstanding = new Map();
  const activityLabels = new Set();

  function addChip(collection, key, label, detail, reason) {
    let chip = collection.get(key);
    if (!chip) {
      chip = { label, detail, count: 0, reasons: new Set() };
      collection.set(key, chip);
    }
    chip.count += 1;
    if (reason) chip.reasons.add(reason);
  }

  for (const activity of activities) {
    const label = featureLabel(activity);
    const key = label.toLowerCase();
    const reason = [activity.reason, activity.message].filter(Boolean).join("; ");
    const alreadyComplete = activity.status === "skipped" && /already[- ]complete|offer-state-confirmed/i.test(reason);
    if (activity.status === "confirmed" || activity.status === "completed" || alreadyComplete) {
      const points = alreadyComplete
        ? "already complete"
        : activity.pointsKnown === false || activity.pointsGained == null
        ? "points unverified"
        : `${U.fmtSigned(Number(activity.pointsGained))} pts`;
      addChip(earned, `${key}|${points.toLowerCase()}`, label, points, reason);
      activityLabels.add(key);
    } else if (["unconfirmed", "skipped", "failed", "unavailable"].includes(activity.status)) {
      const state = featureState(reason, activity.status);
      addChip(outstanding, `${key}|${state}`, label, state, reason);
      activityLabels.add(key);
    }
  }

  for (const item of partialReasonFeatures(account.lastError)) {
    const label = cleanFeatureText(item.label);
    const key = label.toLowerCase();
    if (activityLabels.has(key)) continue;
    addChip(outstanding, `${key}|${item.state}`, label, item.state, item.reason);
  }

  if (!earned.size) {
    for (const [source, points] of Object.entries(account.live?.bySource || {})) {
      if (Number(points) <= 0) continue;
      const label = SOURCE_LABELS[source] || source.replace(/[-_]/g, " ").replace(/\b\w/g, char => char.toUpperCase());
      addChip(earned, `${label.toLowerCase()}|${points}`, label, `${U.fmtSigned(Number(points))} pts`);
    }
  }

  const renderChips = (chips, className) => [...chips.values()].map((chip) => {
    const count = chip.count > 1 ? ` x${chip.count}` : "";
    const title = [...chip.reasons].join("; ") || chip.label;
    return `<span class="point-source ${className}" title="${U.escapeAttr(title)}"><strong>${U.escapeHtml(chip.label)}</strong> ${U.escapeHtml(chip.detail + count)}</span>`;
  });

  return [...renderChips(earned, "point-source--complete"), ...renderChips(outstanding, "point-source--target")].join("");
}

function earnableChips(account) {
  const earnable = account.earnable || account.live?.earnable;
  if (!earnable) return "";
  const labels = { mobile: "Mobile", browser: "Desktop", app: "App" };
  return Object.entries(labels).filter(([key]) => Number(earnable[key]) > 0).map(([key, label]) =>
    `<span class="point-source point-source--target"><strong>${label}</strong> ${U.escapeHtml(U.fmtNumber(earnable[key]))} earnable</span>`,
  ).join("");
}

function protectionPresentation(account) {
  if (account.streakProtectionEnabled == null) return null;

  const remaining = account.streakProtectionRemainingDays;
  const days =
    remaining == null
      ? "days unavailable"
      : `${remaining} protection day${remaining === 1 ? "" : "s"} left`;
  const state = account.streakProtectionEnabled ? "On" : "Off";
  const streak =
    account.streakCounter == null
      ? "streak unavailable"
      : `${U.fmtNumber(account.streakCounter)} day${account.streakCounter === 1 ? "" : "s"} current streak`;

  return {
    state,
    days,
    streak,
    pillClass:
      account.streakProtectionEnabled && remaining !== 0
        ? "pill-success"
        : remaining === 0
          ? "pill-warn"
          : "pill-idle",
  };
}

function kv(items) {
  return `<dl class="kv">${items
    .map(
      ([k, v]) =>
        `<div><dt>${U.escapeHtml(k)}</dt><dd>${U.escapeHtml(String(v))}</dd></div>`,
    )
    .join("")}</dl>`;
}

function detailGroups(a, protection) {
  const groups = [];

  groups.push([
    "Configuration",
    [
      ["Configured in .env", a.configured ? "Yes" : "No \u2014 seen in logs only"],
      ...(a.geoLocale ? [["Geo locale", a.geoLocale]] : []),
      ...(a.langCode ? [["Language", a.langCode]] : []),
      ...(a.hasTotp != null ? [["TOTP secret", a.hasTotp ? "Set" : "Not set"]] : []),
      ...(a.hasRecoveryEmail != null
        ? [["Recovery email", a.hasRecoveryEmail ? "Set" : "Not set"]]
        : []),
      [
        "Proxy",
        a.proxy
          ? `${a.proxy.url}${a.proxy.port ? `:${a.proxy.port}` : ""}${a.proxy.hasCredentials ? " (authenticated)" : ""}`
          : "None",
      ],
    ],
  ]);

  groups.push([
    "Streak &amp; protection",
    [
      ["Success streak", `${a.successStreak} run${a.successStreak === 1 ? "" : "s"}`],
      ...(protection
        ? [
          [
            "Current streak",
            a.streakCounter == null
              ? "Unavailable"
              : `${U.fmtNumber(a.streakCounter)} day${a.streakCounter === 1 ? "" : "s"}`,
          ],
          ["Streak protection", protection.state === "On" ? "Enabled" : "Disabled"],
          [
            "Protection days remaining",
            a.streakProtectionRemainingDays == null
              ? "Unavailable"
              : `${a.streakProtectionRemainingDays} day${a.streakProtectionRemainingDays === 1 ? "" : "s"}`,
          ],
          ...(a.streakProtectionUpdatedAt
            ? [["Protection status checked", U.fmtRelative(a.streakProtectionUpdatedAt)]]
            : []),
        ]
        : []),
    ],
  ]);

  groups.push([
    "Run history",
    [
      ["Runs recorded by the API", U.fmtNumber(a.apiRuns)],
      ["Points collected (API history)", U.fmtSigned(a.apiTotalCollected)],
      ["Last duration", U.fmtDuration(a.lastDurationSec)],
      ["History points loaded", U.fmtNumber(a.historyCount)],
    ],
  ]);

  return `<div class="acc-detail-groups">${groups
    .map(
      ([title, items]) => `
        <div class="acc-detail-group">
            <h3 class="acc-detail-group-title">${title}</h3>
            ${kv(items)}
        </div>`,
    )
    .join("")}</div>`;
}

function renderAccountPanel(a, live) {
  const protection = protectionPresentation(a);
  const { usable, running } = controlState();

  // Accounts now start one at a time (accountDelay), so mid-run there can be
  // several accounts that already finished this run while another is still
  // going - `live` just means "has a record in this run", true for both.
  // a.status is this account's own last-observed outcome (idle/running/
  // success/error), so it correctly tells finished accounts apart from the
  // one actually in progress right now.
  // Mirrors overview.js: while waiting between accounts, the one named by
  // pendingDelay.nextEmail is up next, so it reads as "pending" rather than
  // whatever its last-observed status happened to be.
  const nextAccountEmail = context?.status?.pendingDelay?.nextEmail || null;
  const statusKey = launching.has(a.index)
    ? "starting"
    : a.status !== "running" && nextAccountEmail && a.email === nextAccountEmail
      ? "pending"
      : a.status;

  const runButton =
    a.configured && Number.isInteger(a.index)
      ? `<button type="button" class="btn btn-primary btn-small acc-run-button" data-run-account="${a.index}" aria-label="Run only ACCOUNT_${a.index}" ${!usable || running || launching.has(a.index) ? "disabled" : ""
      } title="Run only ACCOUNT_${a.index}"><i class="ph ph-play acc-run-icon" aria-hidden="true"></i><span class="acc-run-label">${launching.has(a.index) ? "Starting\u2026" : "Run only"}</span></button>`
      : "";

  const selectCheckbox =
    a.configured && Number.isInteger(a.index)
      ? `<label class="check acc-batch-select" title="Include ACCOUNT_${a.index} in a batch run">
          <input type="checkbox" data-select-account="${a.index}" aria-label="Select ACCOUNT_${a.index} for a batch run" ${selectedForBatch.has(a.index) ? "checked" : ""}>
          <span>Select</span>
        </label>`
      : "";

  const isExpanded = expandedAccounts.has(a.key);
  const detailsId = `acc-details-${U.escapeAttr(a.key)}`;

  const isDeleting = deleting.has(a.key);
  const deleteBlocked = a.status === "running" || launching.has(a.index);
  const deleteButton = deleteArmed.has(a.key)
    ? `<span class="acc-delete-confirm">
        <button type="button" class="btn btn-icon btn-small" data-cancel-delete="${U.escapeAttr(a.key)}" aria-label="Cancel delete" ${isDeleting ? "disabled" : ""} title="Cancel delete"><i class="ph ph-x" aria-hidden="true"></i></button>
        <button type="button" class="btn btn-danger btn-icon btn-small" data-confirm-delete="${U.escapeAttr(a.key)}" aria-label="Confirm delete account" ${isDeleting ? "disabled" : ""} title="Permanently remove this account and its history from the dashboard">
          <i class="ph ph-trash" aria-hidden="true"></i>
        </button>
      </span>`
    : `<button type="button" class="btn btn-danger btn-icon btn-small" data-arm-delete="${U.escapeAttr(a.key)}" aria-label="Delete account" ${deleteBlocked ? "disabled" : ""} title="${deleteBlocked ? "The account must be idle to delete it" : "Remove this account and its history from the dashboard"}"><i class="ph ph-trash" aria-hidden="true"></i></button>`;

  const protectionChip = protection
    ? `<span class="account-rail-icon ${protection.pillClass}" role="img" aria-label="Streak protection ${protection.state.toLowerCase()}" title="Streak protection is ${protection.state.toLowerCase()}; ${U.escapeAttr(protection.days)}"><i class="ph ${a.streakProtectionEnabled ? "ph-shield-check" : "ph-shield"}" aria-hidden="true"></i></span>`
    : "";
  const status = U.pillParts(statusKey);
  const statusIcons = {
    full: "ph-check-circle",
    success: "ph-check-circle",
    partial: "ph-warning-circle",
    done: "ph-check-circle",
    error: "ph-x-circle",
    crashed: "ph-x-circle",
    interrupted: "ph-pause-circle",
    stopped: "ph-pause-circle",
    running: "ph-circle-notch",
    starting: "ph-circle-notch",
    stopping: "ph-stop-circle",
    pending: "ph-clock",
    idle: "ph-minus-circle",
  };
  const statusRail = `
    <aside class="account-status-rail" aria-label="Account status">
      <span class="account-rail-icon ${status.cls}" role="img" aria-label="${U.escapeAttr(status.label)}" title="${U.escapeAttr(status.label)}"><i class="ph ${statusIcons[statusKey] || statusIcons.idle}" aria-hidden="true"></i></span>
    </aside>`;
  const featureChipsHtml = [
    featureChips({ ...(live || {}), lastError: a.lastError || live?.error }),
    earnableChips(live || {}),
  ].filter(Boolean).join("");
  const featuresOpen = expandedFeatures.has(a.key);
  const featureDetails = `<details class="account-feature-details" data-feature-details="${U.escapeAttr(a.key)}" ${featuresOpen ? "open" : ""}>
      <summary><span class="acc-detail-toggle account-feature-caret" aria-hidden="true">\u25b8</span><span>Activity Status</span></summary>
      <div class="account-feature-chips">${featureChipsHtml || '<span class="point-source">No feature results reported</span>'}</div>
    </details>`;

  return `
    <div class="panel account-detail-panel">
      <div class="account-primary-row">
        ${statusRail}
        <div class="account-card-main">
          <div class="panel-head">
            <h2>
                <button type="button" class="acc-detail-toggle" data-toggle-details="${U.escapeAttr(a.key)}" aria-expanded="${isExpanded}" aria-controls="${detailsId}" title="${isExpanded ? "Collapse details" : "Expand details"}">\u25b8</button>
              ${U.escapeHtml(a.email)}
            </h2>
            ${a.index != null ? `<span class="tag-mini acc-tag-account-id">ACCOUNT_${a.index}</span>` : ""}
            ${a.configured ? "" : '<span class="tag-mini">unconfigured</span>'}
          </div>
        </div>
        <span class="acc-detail-actions">${selectCheckbox}${runButton}</span>
      </div>
      <div class="panel-body account-detail-body" id="${detailsId}" ${isExpanded ? "" : "hidden"}>
        ${detailGroups(a, protection)}
      </div>
      <div class="account-secondary-row">
        <aside class="account-protection-rail" aria-label="Streak protection">${protectionChip}</aside>
        ${featureDetails}
        <div class="acc-feature-actions">${deleteButton}</div>
      </div>
    </div>`;
}

function render(root) {
  const container = U.$("#accountsContainer", root);
  const accounts = accountsPayload?.accounts || [];

  const liveByEmail = new Map(
    (context?.status?.bot?.run?.accounts || []).map((la) => [la.email, la]),
  );
  const errEl = U.$("#accountsError", root);
  if (errEl) {
    errEl.hidden = !accountsPayload?.apiError;
    if (accountsPayload?.apiError) errEl.textContent = accountsPayload.apiError;
  }

  if (!accounts.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1.25rem">No accounts configured or observed yet.</p>';
    renderBatchToolbar(root);
    return;
  }

  container.innerHTML = accounts.map(a => {
    const live = liveByEmail.get(a.email) || null;
    return renderAccountPanel(a, live);
  }).join("");

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.runAccount);
      const account = accounts.find((a) => a.index === index);
      if (account) runAccount(account);
    }),
  );

  container.querySelectorAll("input[data-select-account]").forEach((input) =>
    input.addEventListener("change", () => {
      const index = Number(input.dataset.selectAccount);
      if (input.checked) selectedForBatch.add(index);
      else selectedForBatch.delete(index);
      renderBatchToolbar(root);
    }),
  );

  container.querySelectorAll("details[data-feature-details]").forEach((details) =>
    details.addEventListener("toggle", () => {
      const key = details.dataset.featureDetails;
      if (details.open) expandedFeatures.add(key);
      else expandedFeatures.delete(key);
    }),
  );

  container.querySelectorAll("button[data-toggle-details]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.toggleDetails;
      if (expandedAccounts.has(key)) expandedAccounts.delete(key);
      else expandedAccounts.add(key);
      render(root);
    }),
  );

  container.querySelectorAll("button[data-arm-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      deleteArmed.add(btn.dataset.armDelete);
      render(root);
    }),
  );

  container.querySelectorAll("button[data-cancel-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      deleteArmed.delete(btn.dataset.cancelDelete);
      render(root);
    }),
  );

  container.querySelectorAll("button[data-confirm-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.confirmDelete;
      const account = accounts.find((a) => a.key === key);
      if (account) deleteAccount(account);
    }),
  );

  renderBatchToolbar(root);
}

export default {
  id: "accounts",
  label: "Accounts",
  interval: 10000,

  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    root.innerHTML = `
      <p class="notice notice--warn" id="accountsError" hidden></p>
      <div class="panel batch-select-box" id="accountsBatchToolbar">
          <div class="batch-select-header">
              <h2 class="batch-select-title">Batch run</h2>
              <div class="batch-select-controls">
                  <label class="check">
                      <input type="checkbox" id="accountsSelectAll">
                      <span>Select all</span>
                  </label>
                  <span class="hint" id="accountsSelectedCount"><span id="accountsSelectedCountValue">0/0</span><span class="accounts-selected-label"> selected</span></span>
                  <button type="button" class="btn btn-primary btn-small accounts-run-selected" id="accountsRunSelected" aria-label="Run selected accounts" title="Run selected accounts" disabled><i class="ph ph-play accounts-run-selected-icon" aria-hidden="true"></i><span class="accounts-run-selected-label">Run selected</span></button>
              </div>
          </div>
      </div>
      <div id="accountsContainer">
          <p class="empty-note" style="padding:1.25rem">Loading accounts configuration details&hellip;</p>
      </div>
      <p class="hint" style="margin-top: 1.5rem;">Accounts are configured in the bot&rsquo;s <code>.env</code> (<code>ACCOUNT_N_*</code>).
      The control API exposes full local email addresses but never sends passwords, recovery addresses, TOTP secrets, or proxy credentials.</p>
    `;
    mounted = true;

    U.$("#accountsSelectAll", root).addEventListener("change", (e) => {
      const configured = selectableAccounts();
      if (e.target.checked) configured.forEach((a) => selectedForBatch.add(a.index));
      else selectedForBatch.clear();
      render(root);
    });

    U.$("#accountsRunSelected", root).addEventListener("click", () => {
      runSelectedAccounts();
    });
  },

  async refresh(ctx) {
    context = ctx;
    accountsPayload = await cached("accounts", ctx.api.accounts, 5000);
    this.redraw(ctx);
  },

  redraw(ctx) {
    context = ctx || context;
    if (!mounted || !accountsPayload) return;
    render(rootEl);
  }
};