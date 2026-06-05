(function () {
  "use strict";

  const existing = window.__eightyTwoZeroRollListener;
  if (existing?.restore) existing.restore();

  const RESTORE_EVENT = "eighty-two-zero-restore-roll-listener";
  const originalLog = console.log;

  function emit(detail) {
    window.dispatchEvent(new CustomEvent("eighty-two-zero-roll-log", { detail }));
  }

  function readRoll(args) {
    const data = args.find((arg) => arg && typeof arg === "object" && typeof arg.team === "string");
    if (!data) return null;
    return { team: data.team, era: data.decade || data.era || "" };
  }

  function log(...args) {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("[v0] Starting spin animation")) {
      emit({ type: "spin-start" });
    } else if (first.includes("[v0] Pre-determined final result")) {
      const roll = readRoll(args);
      if (roll) emit({ type: "roll", team: roll.team, era: roll.era });
    } else if (first.includes("[v0] Animation complete")) {
      emit({ type: "spin-complete" });
    }
    return originalLog.apply(console, args);
  }

  function restore() {
    if (console.log === log) console.log = originalLog;
    window.removeEventListener(RESTORE_EVENT, restore);
    if (window.__eightyTwoZeroRollListener?.restore === restore) {
      delete window.__eightyTwoZeroRollListener;
    }
  }

  window.addEventListener(RESTORE_EVENT, restore);
  window.__eightyTwoZeroRollListener = { restore };
  console.log = log;
})();
