(function () {
  "use strict";

  const PLAYERS_URL = "https://firebasestorage.googleapis.com/v0/b/project-4599904239656435772.firebasestorage.app/o/players_flat.json?alt=media";
  const POSITIONS = ["PG", "SG", "SF", "PF", "C"];
  const ERA_LABELS = {
    "60's": "1960s",
    "60s": "1960s",
    "70's": "1970s",
    "70s": "1970s",
    "80's": "1980s",
    "80s": "1980s",
    "90's": "1990s",
    "90s": "1990s",
    "00's": "2000s",
    "00s": "2000s",
    "10's": "2010s",
    "10s": "2010s",
    "20's": "2020s",
    "20s": "2020s"
  };
  const LIVE_ERA_LABELS = ["60's", "70's", "80's", "90's", "00's", "10's", "20's"];
  const SUPPORTED_ERAS = new Set(LIVE_ERA_LABELS.map((label) => ERA_LABELS[label]));

  const currentScript = document.currentScript;

  function readDatasetJson(name) {
    try {
      return JSON.parse(currentScript?.dataset?.[name] || "[]");
    } catch (error) {
      return [];
    }
  }

  function normalizeEraLabel(label) {
    const clean = (label || "").trim().replace(/’/g, "'");
    if (ERA_LABELS[clean]) return ERA_LABELS[clean];
    if (SUPPORTED_ERAS.has(clean)) return clean;
    return "";
  }

  function shortEraLabel(era) {
    return LIVE_ERA_LABELS.find((label) => ERA_LABELS[label] === era) || era;
  }

  function normalizeTargetPair(pair) {
    if (!Array.isArray(pair)) return null;
    const team = String(pair[0] || "").trim().toUpperCase();
    const era = normalizeEraLabel(pair[1]);
    if (!team || !era) return null;
    return [team, shortEraLabel(era)];
  }

  const rawTargets = readDatasetJson("targets");
  const rawRolls = readDatasetJson("rolls");
  const targetPairs = (Array.isArray(rawRolls) && rawRolls.length ? rawRolls : rawTargets)
    .map(normalizeTargetPair)
    .filter(Boolean);
  const fallbackTargets = Array.isArray(rawTargets)
    ? rawTargets.filter((value) => typeof value === "number" && value >= 0 && value < 1)
    : [];
  const targetCount = Math.max(targetPairs.length, fallbackTargets.length);

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

  if (targetCount === 0) {
    originalLog("[82-0 Solver] Fixed spins failed: invalid targets.");
    return;
  }

  let index = 0;
  let nextValue = null;
  let pendingIndex = -1;
  let armTimer = null;
  let ignoreLogUntil = 0;
  let lastControlKind = "spin";
  let liveData = null;
  let liveDataFailed = false;
  const warnings = new Set();
  const trackedRoster = emptyRoster();
  let pendingPlayer = null;
  let pendingPlayerFromPosition = null;
  let ignoreSlotClickUntil = 0;

  function warnOnce(key, message) {
    if (warnings.has(key)) return;
    warnings.add(key);
    originalLog(`[82-0 Solver] ${message}`);
  }

  function emptyRoster() {
    const roster = {};
    for (const pos of POSITIONS) roster[pos] = null;
    return roster;
  }

  function textLines(text) {
    return (text || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function cleanName(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function slugName(name) {
    return cleanName(name).replace(/\s+/g, "_");
  }

  function normalizePlayer(player) {
    const era = normalizeEraLabel(player.era);
    const positions = (Array.isArray(player.positions) && player.positions.length
      ? player.positions
      : [player.pos || "SF"])
      .filter((pos) => POSITIONS.includes(pos));
    return {
      ...player,
      era,
      positions: positions.length ? positions : ["SF"],
      id: player.id || `${slugName(player.player)}_${player.team}_${era}`,
      baseSlug: player.baseSlug || slugName(player.player)
    };
  }

  function buildLiveData(rawPlayers) {
    const players = rawPlayers
      .map(normalizePlayer)
      .filter((player) => player.team && player.era && SUPPORTED_ERAS.has(player.era));
    const grouped = {};
    const teamOrder = [];
    for (const player of players) {
      if (!grouped[player.team]) {
        grouped[player.team] = {};
        teamOrder.push(player.team);
      }
      (grouped[player.team][player.era] ||= []).push(player);
    }

    const combos = [];
    for (const team of teamOrder) {
      for (const shortEra of LIVE_ERA_LABELS) {
        const era = ERA_LABELS[shortEra];
        if (grouped[team]?.[era]?.length) combos.push([team, shortEra]);
      }
    }
    return { players, grouped, teamOrder, combos };
  }

  fetch(PLAYERS_URL)
    .then((response) => response.json())
    .then((players) => {
      liveData = buildLiveData(players);
      originalLog("[82-0 Solver] Fixed spins live data ready.");
    })
    .catch((error) => {
      liveDataFailed = true;
      warnOnce("players-fetch", `Fixed spins could not load live player data; using static fallback when possible. ${error?.message || error}`);
    });

  function findPlayer(name, team, era) {
    if (!liveData) return null;
    const wantedName = cleanName(name);
    return liveData.players.find((player) =>
      cleanName(player.player) === wantedName &&
      player.team === team &&
      player.era === era
    ) || null;
  }

  function teamEraMatch(line) {
    const match = String(line || "").match(/([A-Z0-9]{2,4})\s*(?:·|\||-|\s)\s*(((?:19|20)\d0s)|(?:\d{2}['’]?s))/);
    if (!match) return null;
    const era = normalizeEraLabel(match[2]);
    return era ? { team: match[1].toUpperCase(), era } : null;
  }

  function findTeamEraLine(lines, start) {
    const end = Math.min(lines.length, start + 5);
    for (let i = start; i < end; i += 1) {
      const parsed = teamEraMatch(lines[i]);
      if (parsed) return parsed;
    }
    return null;
  }

  function countRoster(roster) {
    return POSITIONS.reduce((count, pos) => count + (roster[pos] ? 1 : 0), 0);
  }

  function readRosterFromPage() {
    const roster = emptyRoster();
    const seenPositions = new Set();
    const lines = textLines(document.body.innerText);
    const start = lines.findIndex((line) => /^Roster$/i.test(line));
    if (start < 0) {
      return { roster: { ...trackedRoster }, count: countRoster(trackedRoster), uncertain: false, seen: false };
    }

    let uncertain = false;
    const end = lines.findIndex((line, lineIndex) => lineIndex > start && /^Switches$/i.test(line));
    const rosterLines = lines.slice(start + 1, end > start ? end : start + 45);
    for (let i = 0; i < rosterLines.length; i += 1) {
      const pos = rosterLines[i];
      if (!POSITIONS.includes(pos)) continue;
      seenPositions.add(pos);
      if (/^Empty$/i.test(rosterLines[i + 1] || "")) {
        trackedRoster[pos] = null;
        continue;
      }
      const name = rosterLines[i + 1] || "";
      const teamEra = findTeamEraLine(rosterLines, i + 2);
      const player = teamEra ? findPlayer(name, teamEra.team, teamEra.era) : null;
      if (player) {
        roster[pos] = player;
        trackedRoster[pos] = player;
      } else if (trackedRoster[pos]) {
        roster[pos] = trackedRoster[pos];
      } else {
        uncertain = true;
      }
    }

    for (const pos of POSITIONS) {
      if (!seenPositions.has(pos) && trackedRoster[pos]) roster[pos] = trackedRoster[pos];
    }
    return { roster, count: countRoster(roster), uncertain, seen: true };
  }

  function rosterPlayers(roster) {
    return POSITIONS.map((pos) => roster[pos]).filter(Boolean);
  }

  function canAssign(players) {
    const sorted = [...players].sort((a, b) => (a.positions?.length || 1) - (b.positions?.length || 1));
    const used = new Set();
    function backtrack(playerIndex) {
      if (playerIndex >= sorted.length) return true;
      const player = sorted[playerIndex];
      for (const pos of player.positions || [player.pos || "SF"]) {
        if (used.has(pos)) continue;
        used.add(pos);
        if (backtrack(playerIndex + 1)) return true;
        used.delete(pos);
      }
      return false;
    }
    return backtrack(0);
  }

  function canAddPlayer(roster, player) {
    const current = rosterPlayers(roster);
    const usedSlugs = new Set(current.map((item) => item.baseSlug || slugName(item.player)));
    if (usedSlugs.has(player.baseSlug || slugName(player.player))) return false;
    return canAssign([...current, player]);
  }

  function nextMatchingLine(lines, start, matchLine) {
    const end = Math.min(lines.length, start + 8);
    for (let i = start; i < end; i += 1) {
      const line = lines[i];
      if (/^(SPIN|Roster|Switches)$/i.test(line)) break;
      const match = matchLine(line);
      if (match) return match;
    }
    return "";
  }

  function currentRoll() {
    const text = document.body.innerText || "";
    const match = text.match(/Pick from\s+([A-Z0-9]{2,4})\s*(?:·|\||-)?\s*(((?:19|20)\d0s)|(?:\d{2}['’]?s))/i);
    if (match) {
      const era = normalizeEraLabel(match[2]);
      if (era) return { team: match[1].toUpperCase(), era };
    }

    const lines = textLines(text);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^TEAM$/i.test(lines[i])) continue;
      const team = nextMatchingLine(lines, i + 1, (line) => {
        const value = line.toUpperCase();
        return liveData?.teamOrder.includes(value) ? value : "";
      });
      if (!team) continue;
      const eraLabelIndex = lines.findIndex((line, lineIndex) => lineIndex > i && lineIndex < i + 8 && /^ERA$/i.test(line));
      if (eraLabelIndex < 0) continue;
      const era = nextMatchingLine(lines, eraLabelIndex + 1, normalizeEraLabel);
      if (era) return { team, era };
    }
    return null;
  }

  function candidateCombos(kind, roll, roster) {
    if (!liveData) return [];
    const candidates = [];
    for (const [team, shortEra] of liveData.combos) {
      if (kind === "team" && (!roll || shortEra !== shortEraLabel(roll.era) || team === roll.team)) continue;
      if (kind === "era" && (!roll || team !== roll.team || shortEra === shortEraLabel(roll.era))) continue;
      const era = ERA_LABELS[shortEra];
      const players = liveData.grouped[team]?.[era] || [];
      if (players.some((player) => canAddPlayer(roster, player))) candidates.push([team, shortEra]);
    }
    return candidates;
  }

  function dynamicTargetValue(kind) {
    const pair = targetPairs[index];
    if (!pair || !liveData) return null;
    const roll = kind === "spin" ? null : currentRoll();
    if (kind !== "spin" && (!roll?.team || !roll?.era)) {
      warnOnce(`roll-${index}`, "Fixed spins could not read the current TEAM/ERA for this respin; using fallback if available.");
      return null;
    }

    const rosterState = readRosterFromPage();
    if (rosterState.uncertain || (kind === "spin" && index > 0 && rosterState.count === 0 && !rosterState.seen)) {
      warnOnce(`roster-${index}`, "Fixed spins could not infer the current roster; using full-combo fallback for this later spin.");
      return null;
    }

    const candidates = candidateCombos(kind, roll, rosterState.roster);
    const comboIndex = candidates.findIndex(([team, era]) => team === pair[0] && era === pair[1]);
    if (comboIndex < 0) {
      warnOnce(`target-${index}`, `Fixed spin target unavailable in current candidate list: ${pair[0]} ${pair[1]}; using fallback if available.`);
      return null;
    }
    return (comboIndex + 0.5) / candidates.length;
  }

  function fallbackTargetValue(kind) {
    const value = fallbackTargets[index];
    if (typeof value !== "number") return null;
    if (kind !== "spin" || index > 0) {
      warnOnce(`fallback-${index}`, "Fixed spins are using static full-combo fallback for a constrained spin; the live result may differ.");
    }
    return value;
  }

  function clearArmTimer() {
    if (armTimer) clearTimeout(armTimer);
    armTimer = null;
  }

  function armNextSpin(kind, source) {
    if (index >= targetCount || nextValue !== null) return;
    if (source === "log" && Date.now() < ignoreLogUntil) return;
    if (!liveData && targetPairs[index] && !liveDataFailed) {
      warnOnce("players-loading", "Fixed spins are still loading live player data; wait for the ready message and click again.");
      return;
    }
    const value = dynamicTargetValue(kind) ?? fallbackTargetValue(kind);
    if (typeof value !== "number" || value < 0 || value >= 1) return;
    nextValue = value;
    pendingIndex = index;
    if (source === "click") ignoreLogUntil = Date.now() + 1000;
    clearArmTimer();
    armTimer = setTimeout(() => {
      nextValue = null;
      pendingIndex = -1;
      armTimer = null;
    }, 1500);
  }

  function controlKind(target) {
    if (!target) return "";
    const label = controlLabel(target);
    if (/^\s*Respin\s+team\b/i.test(label)) return "team";
    if (/^\s*Respin\s+era\b/i.test(label)) return "era";
    const text = (target.innerText || target.textContent || "").trim();
    if (/^SPIN$/i.test(text)) return "spin";
    if (/^(Team|Era)$/i.test(text)) return text.toLowerCase();
    return "";
  }

  function controlLabel(target) {
    return `${target?.getAttribute?.("aria-label") || ""} ${target?.getAttribute?.("title") || ""} ${target?.innerText || target?.textContent || ""}`.trim();
  }

  function slotLines(target) {
    return textLines(target?.innerText || target?.textContent || "");
  }

  function exactSlotPosition(target) {
    return slotLines(target).find((line) => POSITIONS.includes(line)) || "";
  }

  function compactSlotText(target) {
    return slotLines(target).join("").replace(/\s+/g, "").toUpperCase();
  }

  function compactSlotPosition(target) {
    const text = compactSlotText(target);
    return POSITIONS.find((pos) => text.endsWith(pos) && text.length > pos.length) || "";
  }

  function isCourtSlotButton(target) {
    if (!target) return false;
    if (target.classList?.contains("w-16") && target.classList.contains("h-16")) return true;
    const aria = target.getAttribute?.("aria-label") || "";
    return target.getAttribute?.("role") === "button" && POSITIONS.some((pos) => aria.startsWith(pos));
  }

  function isRosterSlotButton(target) {
    if (!target || target.tagName !== "BUTTON") return false;
    const className = String(target.className || "");
    return className.includes("rounded-[12px]") && className.includes("flex-col") && className.includes("min-w-0");
  }

  function isPositionSlotButton(target) {
    return isCourtSlotButton(target) || isRosterSlotButton(target);
  }

  function isPositionChoiceButton(target) {
    return target?.tagName === "BUTTON" && !target.disabled && !isPositionSlotButton(target) && !!exactSlotPosition(target);
  }

  function slotPosition(target) {
    if (!target) return "";
    const aria = target.getAttribute?.("aria-label") || "";
    const ariaPos = POSITIONS.find((pos) => aria.startsWith(pos));
    if (ariaPos) return ariaPos;
    return exactSlotPosition(target) || (isPositionSlotButton(target) ? compactSlotPosition(target) : "");
  }

  function slotIsEmpty(target) {
    const pos = slotPosition(target);
    const aria = target?.getAttribute?.("aria-label") || "";
    if (pos && aria.toLowerCase().includes(`${pos.toLowerCase()} empty`)) return true;
    const lines = slotLines(target);
    const compact = compactSlotText(target);
    return !!pos && lines.length > 0 && (lines.every((line) => line === pos) || compact === pos || compact === `${pos}${pos}`);
  }

  function clearPendingPlayer() {
    pendingPlayer = null;
    pendingPlayerFromPosition = null;
  }

  function setPendingPlayer(player, fromPosition = null) {
    pendingPlayer = player;
    pendingPlayerFromPosition = fromPosition;
  }

  function placePendingPlayer(position) {
    if (!position || !pendingPlayer) return false;
    const fromPosition = pendingPlayerFromPosition;
    const replacedPlayer = fromPosition && fromPosition !== position ? trackedRoster[position] : null;
    if (fromPosition && fromPosition !== position) {
      trackedRoster[fromPosition] = replacedPlayer?.id !== pendingPlayer.id ? replacedPlayer : null;
    }
    for (const pos of POSITIONS) {
      if (pos !== position && pos !== fromPosition && trackedRoster[pos]?.id === pendingPlayer.id) trackedRoster[pos] = null;
    }
    trackedRoster[position] = pendingPlayer;
    clearPendingPlayer();
    return true;
  }

  function trackFilledSlotSelection(target) {
    const pos = slotPosition(target);
    if (!pos || !isPositionSlotButton(target) || slotIsEmpty(target) || !trackedRoster[pos]) return false;
    setPendingPlayer(trackedRoster[pos], pos);
    return true;
  }

  function placementTargetFromEvent(event) {
    const direct = closestPlacementTarget(event.target);
    if (direct) return direct;
    const pointed = typeof event.clientX === "number" && typeof event.clientY === "number"
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null;
    return closestPlacementTarget(pointed);
  }

  function closestPlacementTarget(node) {
    return node?.closest?.("button, [role=button]") ||
      node?.querySelector?.("button, [role=button]") ||
      null;
  }

  function findPlayerFromCardTarget(target) {
    if (!liveData) return null;
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      const lines = textLines(node.innerText || "");
      if (lines.length < 3 || lines.length > 24) continue;
      const teamEraIndex = lines.findIndex((line) => teamEraMatch(line));
      if (teamEraIndex < 1) continue;
      const parsed = teamEraMatch(lines[teamEraIndex]);
      for (const nameIndex of [teamEraIndex - 2, teamEraIndex - 1]) {
        const player = findPlayer(lines[nameIndex], parsed.team, parsed.era);
        if (player) return player;
      }
    }
    return null;
  }

  function handleClick(event) {
    const target = event.target.closest?.("button, [role=button]");
    const kind = controlKind(target);
    if (kind) {
      lastControlKind = kind;
      clearPendingPlayer();
      armNextSpin(kind, "click");
      return;
    }

    const pos = slotPosition(target);
    if (pos && (isPositionSlotButton(target) || isPositionChoiceButton(target))) {
      if (Date.now() < ignoreSlotClickUntil) return;
      if (pendingPlayer && (isPositionChoiceButton(target) || pos !== pendingPlayerFromPosition || slotIsEmpty(target))) {
        placePendingPlayer(pos);
        return;
      }
      trackFilledSlotSelection(target);
      return;
    }

    const player = findPlayerFromCardTarget(event.target);
    if (player) setPendingPlayer(player);
  }

  function handlePointerDown(event) {
    if (pendingPlayer && event.type === "pointerdown") return;
    const target = placementTargetFromEvent(event);
    if (target) trackFilledSlotSelection(target);
  }

  function handlePointerUp(event) {
    if (!pendingPlayer) return;
    const target = placementTargetFromEvent(event);
    const pos = target ? slotPosition(target) : "";
    if (pos && isPositionSlotButton(target) && (pos !== pendingPlayerFromPosition || slotIsEmpty(target))) {
      if (placePendingPlayer(pos) && event.type === "pointerup") ignoreSlotClickUntil = Date.now() + 250;
    }
  }

  function restore() {
    clearArmTimer();
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("pointerup", handlePointerUp, true);
    document.removeEventListener("dragstart", handlePointerDown, true);
    document.removeEventListener("drop", handlePointerUp, true);
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
      clearArmTimer();
      if (pendingIndex >= 0) {
        index = Math.max(index, pendingIndex + 1);
        pendingIndex = -1;
      }
      if (index >= targetCount) restore();
      return value;
    }
    return originalRandom();
  }

  function fixedLog(...args) {
    if (typeof args[0] === "string" && args[0].includes("[v0] Starting spin animation")) {
      armNextSpin(lastControlKind || "spin", "log");
    }
    return originalLog.apply(console, args);
  }

  window.__eightyTwoZeroFixedSpins = { restore };
  document.addEventListener("click", handleClick, true);
  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("pointerup", handlePointerUp, true);
  document.addEventListener("dragstart", handlePointerDown, true);
  document.addEventListener("drop", handlePointerUp, true);
  Math.random = fixedRandom;
  console.log = fixedLog;
  originalLog(targetPairs.length ? "[82-0 Solver] Fixed spins loading live data..." : "[82-0 Solver] Fixed spins ready.");
})();
