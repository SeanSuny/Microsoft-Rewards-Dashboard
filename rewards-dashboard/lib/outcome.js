"use strict";

const STOP_EXIT_CODES = [130, 137, 143];
// Mirrors the Store: only these signals mean an intentional stop.
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP"];

/**
 * The live verdict on a finished run, from the Control API's /status payload:
 * null while it hasn't finished, otherwise "success" | "stopped" | "error".
 * (Non-null is also how server.js knows a run is no longer active.)
 *
 * The Control API reports `partial` both for a run that finished with some
 * features incomplete AND for one whose process exited non-zero partway. They
 * are told apart by RUN-END: `run.totals` is set only once the script logged
 * its final summary. A partial run that reached it is a finished run (a
 * success - "partial" is about features). One that never did didn't complete.
 * This mirrors Store.closeRunOnExit, which records the same case as "crashed".
 */
function completedBotOutcome(bot) {
  const run = bot?.run;
  if (!run?.finished) return null;

  const exit = bot.lastExit;
  // An explicit failure outranks anything that merely looks like a stop.
  if (run.status === "failed") return "error";
  if (run.status === "stopped" || run.status === "cancelled") return "stopped";
  if (exit?.error) return "error";
  if (STOP_SIGNALS.includes(exit?.signal) || STOP_EXIT_CODES.includes(exit?.code)) {
    return "stopped";
  }
  // Any other signal (SIGSEGV, SIGABRT...) is the process crashing.
  if (exit?.signal) return "error";
  if (run.status === "partial") return run.totals ? "success" : "error";
  if (exit?.code != null && exit.code !== 0) return "error";
  return "success";
}

module.exports = { completedBotOutcome };
