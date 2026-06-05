(function () {
  "use strict";

  const currentScript = document.currentScript;
  let targets = [];
  try {
    targets = JSON.parse(currentScript?.dataset?.targets || "[]");
  } catch (error) {
    targets = [];
  }

  const existing = window.__eightyTwoZeroFixedSpins;
  const legacyOriginals = window.__eightyTwoZeroFixedSpinsOriginals;
  if (existing?.restore) {
    existing.restore();
  } else if (legacyOriginals?.random && legacyOriginals?.log) {
    Math.random = legacyOriginals.random;
    console.log = legacyOriginals.log;
  }
  delete window.__eightyTwoZeroFixedSpinsOriginals;

  const originalRandom = Math.random;
  const originalLog = console.log;

  if (!Array.isArray(targets) || targets.length === 0 || targets.some((value) => typeof value !== "number" || value < 0 || value >= 1)) {
    originalLog("[82-0 Solver] Fixed spins failed: invalid targets.");
    return;
  }

  let index = 0;
  let nextValue = null;

  function restore() {
    if (Math.random === fixedRandom) Math.random = originalRandom;
    if (console.log === fixedLog) console.log = originalLog;
    if (window.__eightyTwoZeroFixedSpins?.restore === restore) {
      delete window.__eightyTwoZeroFixedSpins;
    }
  }

  function fixedRandom() {
    if (nextValue !== null) {
      const value = nextValue;
      nextValue = null;
      if (index >= targets.length) restore();
      return value;
    }
    return originalRandom();
  }

  function fixedLog(...args) {
    if (typeof args[0] === "string" && args[0].includes("[v0] Starting spin animation") && index < targets.length) {
      nextValue = targets[index];
      index += 1;
    }
    return originalLog.apply(console, args);
  }

  window.__eightyTwoZeroFixedSpins = { restore };
  Math.random = fixedRandom;
  console.log = fixedLog;
  originalLog("[82-0 Solver] Fixed spins ready.");
})();
