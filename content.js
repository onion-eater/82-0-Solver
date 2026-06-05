(function () {
  "use strict";

  const Core = window.EightyTwoZeroSolverCore;
  const POSITIONS = Core.ALL_POSITIONS;
  const overlayId = "eighty-two-zero-solver";
  let players = [];
  let playerIndex = null;
  let precomputedOpenings = null;
  let precomputedOpeningsReady = null;
  let worker = null;
  let workerReady = null;
  let workerEpoch = 0;
  let requestId = 0;
  let pendingPlayerId = null;
  let pendingPlayerFromPosition = null;
  let trackingInstalled = false;
  let rollListenerInstalled = false;
  let lastConsoleRoll = null;
  let solvingEv = false;
  let activeEvView = null;
  let activeTab = "solve";
  let lastAutoSolveKey = "";
  let spinPollToken = 0;
  let pendingSpinRollKey = "";
  let pendingSpinActive = false;
  let pendingSpinHasResult = false;
  let pendingSpinCounted = false;
  let spinResultSequence = 0;
  let trackedRosterOverrideUntil = 0;
  let rosterTextAutoFilled = false;
  const trackedRoster = {};
  for (const pos of POSITIONS) trackedRoster[pos] = null;

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
  const DEFAULT_FIXED_SPIN_ROLLS = [
    ["GSW", "60's"],
    ["ATL", "60's"],
    ["LAL", "60's"],
    ["CHI", "80's"],
    ["SAC", "60's"]
  ];
  const FIXED_SPIN_STORAGE_KEY = "eightyTwoZeroFixedSpinRolls";
  let fixedSpinRolls = loadFixedSpinRolls();
  const runtimeApi = (() => {
    if (typeof chrome !== "undefined" && chrome.runtime) return chrome.runtime;
    if (typeof browser !== "undefined" && browser.runtime) return browser.runtime;
    return null;
  })();
  const assetBaseUrl = (() => {
    const script = document.currentScript || document.querySelector('script[src$="/content.js"]');
    if (!script?.src) return "";
    return new URL(".", script.src).href;
  })();

  function extensionUrl(path) {
    if (runtimeApi?.getURL) return runtimeApi.getURL(path);
    if (assetBaseUrl) return new URL(path, assetBaseUrl).href;
    throw new Error("Extension asset URL unavailable. Reload the unpacked extension and refresh the page.");
  }

  function normalizeFixedSpinRolls(raw) {
    const rows = Array.isArray(raw) ? raw : [];
    return DEFAULT_FIXED_SPIN_ROLLS.map((fallback, index) => {
      const row = rows[index] || fallback;
      const team = String(Array.isArray(row) ? row[0] : row?.team || "").trim().toUpperCase();
      const era = normalizeEraLabel(Array.isArray(row) ? row[1] : row?.era);
      return [team || fallback[0], era || normalizeEraLabel(fallback[1])];
    });
  }

  function loadFixedSpinRolls() {
    try {
      return normalizeFixedSpinRolls(JSON.parse(localStorage.getItem(FIXED_SPIN_STORAGE_KEY) || "null"));
    } catch (error) {
      return normalizeFixedSpinRolls(null);
    }
  }

  function saveFixedSpinRolls() {
    try {
      localStorage.setItem(FIXED_SPIN_STORAGE_KEY, JSON.stringify(fixedSpinRolls));
    } catch (error) {
      // Ignore storage failures; the current in-page config still works.
    }
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "style") Object.assign(node.style, value);
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children || []) node.appendChild(child);
    return node;
  }

  function getOverlay() {
    return document.getElementById(overlayId);
  }

  async function loadPlayers() {
    if (players.length) return players;
    const response = await fetch(extensionUrl("data/players.json"));
    players = Core.normalizePlayers(await response.json());
    playerIndex = Core.indexPlayers(players);
    ensureTracking();
    return players;
  }

  async function loadPrecomputedOpenings() {
    if (precomputedOpenings) return precomputedOpenings;
    if (precomputedOpeningsReady) return precomputedOpeningsReady;
    precomputedOpeningsReady = fetch(extensionUrl("data/precomputed-depth2-standard-82.json"))
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null)
      .then((table) => {
        precomputedOpenings = table || { entries: {} };
        return precomputedOpenings;
      });
    return precomputedOpeningsReady;
  }

  function ensureTracking() {
    if (trackingInstalled) return;
    document.addEventListener("click", trackGameClick, true);
    document.addEventListener("pointerdown", trackGamePointerDown, true);
    document.addEventListener("pointerup", trackGamePointerUp, true);
    trackingInstalled = true;
  }

  function ensureRollListener() {
    if (rollListenerInstalled) return;
    window.addEventListener("eighty-two-zero-roll-log", handleRollLog);
    const script = document.createElement("script");
    script.src = extensionUrl("roll-listener.js");
    script.onload = () => {
      script.remove();
      if (!rollListenerInstalled) window.dispatchEvent(new Event("eighty-two-zero-restore-roll-listener"));
    };
    script.onerror = () => {
      rollListenerInstalled = false;
      window.removeEventListener("eighty-two-zero-roll-log", handleRollLog);
      setStatus("roll log unavailable; using page text");
      script.remove();
    };
    document.documentElement.appendChild(script);
    rollListenerInstalled = true;
  }

  function disableRollListener() {
    if (!rollListenerInstalled) return;
    window.dispatchEvent(new Event("eighty-two-zero-restore-roll-listener"));
    window.removeEventListener("eighty-two-zero-roll-log", handleRollLog);
    rollListenerInstalled = false;
    lastConsoleRoll = null;
  }

  function attachWorker(newWorker) {
    newWorker.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.id && message.id !== requestId) return;
      if (message.type === "ERROR") {
        setSolvingEv(false);
        setStatus("error");
        writeOutput(`Error: ${message.error}`);
      } else if (message.type === "INIT_DONE") {
        if (!solvingEv) setStatus(`loaded ${message.count} player-seasons`);
      } else if (message.type === "SOLVE_EV_PROGRESS") {
        renderEvProgress(message.progress);
      } else if (message.type === "SOLVE_EV_DONE") {
        setSolvingEv(false);
        renderEvResult(message.result);
      }
    });
    return newWorker;
  }

  async function createBlobWorker() {
    const [coreSource, workerSource] = await Promise.all([
      fetch(extensionUrl("solver-core.js")).then((response) => response.text()),
      fetch(extensionUrl("ev-worker.js")).then((response) => response.text())
    ]);
    const source = `${coreSource}\n${workerSource.replace(/^\s*importScripts\("solver-core\.js"\);\s*/, "")}`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      const blobWorker = new Worker(url);
      URL.revokeObjectURL(url);
      return blobWorker;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  async function ensureWorker() {
    if (worker) return worker;
    if (workerReady) return workerReady;
    const epoch = workerEpoch;
    workerReady = (async () => {
      let newWorker = null;
      try {
        newWorker = attachWorker(new Worker(extensionUrl("ev-worker.js")));
      } catch (error) {
        newWorker = attachWorker(await createBlobWorker());
      }
      if (epoch !== workerEpoch) {
        newWorker.terminate();
        throw new Error("stale worker");
      }
      worker = newWorker;
      worker.postMessage({ type: "INIT", players });
      return worker;
    })().catch((error) => {
      workerReady = null;
      throw error;
    });
    return workerReady;
  }

  function resetWorker() {
    workerEpoch += 1;
    if (worker) worker.terminate();
    worker = null;
    workerReady = null;
  }

  function setStatus(text) {
    const node = document.querySelector(`#${overlayId} [data-role=status]`);
    if (node) node.textContent = text;
  }

  function writeOutput(text) {
    const node = document.querySelector(`#${overlayId} [data-role=output]`);
    if (!node) return;
    node.style.whiteSpace = "pre-wrap";
    node.textContent = text;
  }

  function setSolvingEv(active) {
    solvingEv = active;
    const button = document.querySelector(`#${overlayId} [data-action=solve]`);
    if (button) {
      button.disabled = false;
      button.textContent = "solve";
    }
  }

  function value(selector) {
    return document.querySelector(`#${overlayId} ${selector}`)?.value || "";
  }

  function checked(selector) {
    return !!document.querySelector(`#${overlayId} ${selector}`)?.checked;
  }

  function pageTextLines() {
    return document.body.innerText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
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

  function isSupportedEra(era) {
    return SUPPORTED_ERAS.has(era);
  }

  function isKnownTeam(team) {
    return !!playerIndex?.teams.includes(team);
  }

  function parseCurrentRoll(text) {
    const match = text.match(/Pick from\s+([A-Z0-9]{2,4})\s*(?:·|\||-)?\s*(((?:19|20)\d0s)|(?:\d{2}['’]?s))/i);
    if (match) {
      const era = normalizeEraLabel(match[2]);
      if (era) return { team: match[1].toUpperCase(), era };
    }

    const lines = pageTextLines();
    for (let i = 0; i < lines.length - 3; i += 1) {
      const team = lines[i].toUpperCase();
      const era = normalizeEraLabel(lines[i + 1]);
      if (isKnownTeam(team) && era && /^Team$/i.test(lines[i + 2]) && /^Era$/i.test(lines[i + 3])) {
        return { team, era };
      }
    }

    return null;
  }

  function applyRollToForm(roll) {
    const teamSelect = document.querySelector(`#${overlayId} [name=team]`);
    const eraSelect = document.querySelector(`#${overlayId} [name=era]`);
    if (!teamSelect || !eraSelect) return;
    teamSelect.value = roll.team;
    eraSelect.value = roll.era;
  }

  function rollKey(roll) {
    return roll ? `${roll.team}|${roll.era}` : "";
  }

  function currentFormRollKey() {
    const team = value("[name=team]");
    const era = value("[name=era]");
    return team && era ? `${team}|${era}` : "";
  }

  function markSpinPending() {
    pendingSpinRollKey = currentFormRollKey();
    pendingSpinActive = true;
    pendingSpinHasResult = false;
    pendingSpinCounted = false;
  }

  function markSpinResult() {
    pendingSpinHasResult = true;
    if (pendingSpinActive && !pendingSpinCounted) {
      spinResultSequence += 1;
      pendingSpinCounted = true;
    }
  }

  function clearPendingSpin() {
    pendingSpinRollKey = "";
    pendingSpinActive = false;
    pendingSpinHasResult = false;
    pendingSpinCounted = false;
  }

  function pendingRollResolved(roll) {
    return !!roll && (!pendingSpinRollKey || rollKey(roll) !== pendingSpinRollKey || pendingSpinHasResult);
  }

  function handleRollLog(event) {
    const detail = event.detail || {};
    if (detail.type === "spin-start") {
      markSpinPending();
      lastConsoleRoll = null;
      setStatus("spin started");
      return;
    }
    if (detail.type === "roll") {
      const team = String(detail.team || "").trim().toUpperCase();
      const era = normalizeEraLabel(detail.era || detail.decade);
      if (!team || !era) return;
      lastConsoleRoll = { team, era };
      markSpinResult();
      if (pendingRollResolved(lastConsoleRoll)) {
        applyRollToForm(lastConsoleRoll);
        setStatus(`roll logged: ${team} ${era}`);
      } else {
        setStatus("waiting for reroll...");
      }
      setTimeout(refreshPageState, 50);
      return;
    }
    if (detail.type === "spin-complete") {
      markSpinResult();
      setTimeout(refreshPageState, 50);
    }
  }

  function pollForSpinResult() {
    const token = ++spinPollToken;
    markSpinPending();
    let attempts = 0;
    const tick = () => {
      if (token !== spinPollToken) return;
      if (attempts >= 14) markSpinResult();
      refreshPageState();
      attempts += 1;
      if (attempts < 15) setTimeout(tick, 400);
      else clearPendingSpin();
    };
    setTimeout(tick, 600);
  }

  function switchButtonUsed(label) {
    const matching = [...document.querySelectorAll("button")]
      .filter((button) => !button.closest(`#${overlayId}`))
      .filter((button) => button.textContent.trim().toLowerCase() === label.toLowerCase());
    if (matching.length === 0) return null;

    const states = matching.map((button) => {
      const className = String(button.className || "");
      return button.disabled ||
        button.getAttribute("aria-disabled") === "true" ||
        className.includes("cursor-not-allowed") ||
        className.includes("line-through");
    });
    return states.every((state) => state === states[0]) ? states[0] : null;
  }

  function parseSwitchState(text) {
    const teamFromButton = switchButtonUsed("Team");
    const eraFromButton = switchButtonUsed("Era");
    const teamUsed = teamFromButton !== null
      ? teamFromButton
      : (/Team Switch\s+Used/i.test(text) || /Team\s+Used/i.test(text) ? true : null);
    const eraUsed = eraFromButton !== null
      ? eraFromButton
      : (/Era Switch\s+Used/i.test(text) || /Era\s+Used/i.test(text) ? true : null);
    return { teamSwitchUsed: teamUsed, eraSwitchUsed: eraUsed };
  }

  function courtSlotButtons() {
    return [...document.querySelectorAll("button, [role=button]")]
      .filter((button) => !button.closest(`#${overlayId}`))
      .filter(isCourtSlotButton);
  }

  function isCourtSlotButton(button) {
    if (!button) return false;
    if (button.classList?.contains("w-16") && button.classList.contains("h-16")) return true;
    const aria = button.getAttribute?.("aria-label") || "";
    return button.getAttribute?.("role") === "button" && POSITIONS.some((pos) => aria.startsWith(pos));
  }

  function isPositionChoiceButton(button) {
    return button?.tagName === "BUTTON" && !button.disabled && !isCourtSlotButton(button) && !!slotPosition(button);
  }

  function slotLines(button) {
    return (button.innerText || button.textContent || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function slotPosition(button) {
    const aria = button.getAttribute?.("aria-label") || "";
    const ariaPos = POSITIONS.find((pos) => aria.startsWith(pos));
    return ariaPos || slotLines(button).find((line) => POSITIONS.includes(line)) || "";
  }

  function slotIsEmpty(button) {
    const pos = slotPosition(button);
    const aria = button.getAttribute?.("aria-label") || "";
    if (pos && aria.toLowerCase().includes(`${pos.toLowerCase()} empty`)) return true;
    const lines = slotLines(button);
    return !!pos && lines.length > 0 && lines.every((line) => line === pos);
  }

  function reconcileTrackedRosterWithSlots() {
    for (const button of courtSlotButtons()) {
      const pos = slotPosition(button);
      if (pos && slotIsEmpty(button)) trackedRoster[pos] = null;
    }
  }

  function clearPendingPlayer() {
    pendingPlayerId = null;
    pendingPlayerFromPosition = null;
  }

  function setPendingPlayer(playerId, fromPosition = null) {
    pendingPlayerId = playerId;
    pendingPlayerFromPosition = fromPosition;
  }

  function placePendingPlayer(position) {
    if (!position || !pendingPlayerId) return false;
    if (pendingPlayerFromPosition && pendingPlayerFromPosition !== position) {
      trackedRoster[pendingPlayerFromPosition] = null;
    }
    for (const pos of POSITIONS) {
      if (pos !== position && trackedRoster[pos] === pendingPlayerId) trackedRoster[pos] = null;
    }
    trackedRoster[position] = pendingPlayerId;
    clearPendingPlayer();
    trackedRosterOverrideUntil = Date.now() + 1000;
    writeRosterToForm(trackedRoster);
    setStatus(`position move tracked: ${Object.values(trackedRoster).filter(Boolean).length}/5 roster`);
    setTimeout(refreshPageState, 300);
    return true;
  }

  function setTrackedRoster(roster) {
    for (const pos of POSITIONS) trackedRoster[pos] = roster?.[pos] || null;
  }

  function writeRosterToForm(roster) {
    const lines = [];
    for (const pos of POSITIONS) {
      const player = roster?.[pos] ? playerIndex.playersById.get(roster[pos]) : null;
      if (player) lines.push(`${pos}: ${player.player} | ${player.team} | ${player.era}`);
    }
    document.querySelector(`#${overlayId} [name=roster]`).value = lines.join("\n");
    rosterTextAutoFilled = true;
  }

  function inferFinalPendingPlacement() {
    if (!pendingPlayerId || !playerIndex) return false;
    const current = parseRosterFromPage();
    if (Object.values(current).filter(Boolean).length !== POSITIONS.length - 1) return false;
    const player = playerIndex.playersById.get(pendingPlayerId);
    if (!player) return false;
    const nextRoster = Core.rosterWithAddedPlayer(current, player, playerIndex.playersById);
    if (!nextRoster || Object.values(nextRoster).filter(Boolean).length !== POSITIONS.length) return false;
    setTrackedRoster(nextRoster);
    clearPendingPlayer();
    setTimeout(refreshPageState, 300);
    return true;
  }

  function unreadableFilledPositions(roster) {
    const positions = new Set();
    for (const button of courtSlotButtons()) {
      const pos = slotPosition(button);
      if (pos && !slotIsEmpty(button) && !roster[pos]) positions.add(pos);
    }
    return [...positions];
  }

  function findPlayerFromCardTarget(target) {
    if (!players.length) return null;
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      if (node.closest?.(`#${overlayId}`)) return null;
      const lines = (node.innerText || "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length < 3 || lines.length > 20) continue;

      const teamEraIndex = lines.findIndex((line) => /[A-Z0-9]{2,4}\s*·\s*(?:19|20)\d0s/.test(line));
      if (teamEraIndex < 2) continue;

      const teamEraMatch = lines[teamEraIndex].match(/([A-Z0-9]{2,4})\s*·\s*((?:19|20)\d0s)/);
      const name = lines[teamEraIndex - 2];
      if (!teamEraMatch || !name) continue;
      const player = Core.findPlayer(players, name, teamEraMatch[1], teamEraMatch[2]);
      if (player) return player;
    }
    return null;
  }

  function parseRosterText(text) {
    const roster = {};
    for (const line of (text || "").split(/\n+/)) {
      const match = line.match(/^(PG|SG|SF|PF|C)\s*[:,-]\s*(.+?)\s*(?:\|\s*([A-Z0-9]{2,4})\s*\|\s*((?:19|20)\d0s))?\s*$/i);
      if (!match) continue;
      const player = Core.findPlayer(players, match[2], match[3], match[4]);
      if (player) roster[match[1].toUpperCase()] = player.id;
    }
    return roster;
  }

  function placementTargetFromEvent(event) {
    const direct = event.target.closest?.("button, [role=button]");
    if (direct) return direct;
    return document.elementFromPoint(event.clientX, event.clientY)?.closest?.("button, [role=button]") || null;
  }

  function playerIdForPosition(pos) {
    return trackedRoster[pos] || parseRosterFromPage()[pos] || parseRosterText(value("[name=roster]"))[pos];
  }

  function trackFilledSlotSelection(target) {
    const pos = slotPosition(target);
    if (!pos || !isCourtSlotButton(target) || slotIsEmpty(target)) return false;
    const playerId = playerIdForPosition(pos);
    if (!playerId) return false;
    setPendingPlayer(playerId, pos);
    return true;
  }

  function trackGamePointerDown(event) {
    if (!players.length || event.target.closest?.(`#${overlayId}`)) return;
    const target = placementTargetFromEvent(event);
    if (target) trackFilledSlotSelection(target);
  }

  function trackGamePointerUp(event) {
    if (!players.length || !pendingPlayerId || event.target.closest?.(`#${overlayId}`)) return;
    const target = placementTargetFromEvent(event);
    const pos = target ? slotPosition(target) : "";
    if (pos && (isCourtSlotButton(target) || isPositionChoiceButton(target)) && (pos !== pendingPlayerFromPosition || slotIsEmpty(target))) {
      placePendingPlayer(pos);
    }
  }

  function trackGameClick(event) {
    if (!players.length || event.target.closest?.(`#${overlayId}`)) return;

    const clickedButton = event.target.closest?.("button");
    const placementTarget = placementTargetFromEvent(event);
    if (placementTarget && (isCourtSlotButton(placementTarget) || isPositionChoiceButton(placementTarget))) {
      const pos = slotPosition(placementTarget);
      if (pos && pendingPlayerId && (isPositionChoiceButton(placementTarget) || pos !== pendingPlayerFromPosition || slotIsEmpty(placementTarget))) {
        placePendingPlayer(pos);
        return;
      }
      trackFilledSlotSelection(placementTarget);
      return;
    }
    if (clickedButton && /^SPIN$/i.test(clickedButton.textContent.trim())) {
      clearPendingPlayer();
      pollForSpinResult();
      return;
    }
    if (clickedButton && /^(Team|Era)$/i.test(clickedButton.textContent.trim())) {
      clearPendingPlayer();
      pollForSpinResult();
      return;
    }

    const player = findPlayerFromCardTarget(event.target);
    if (player) {
      setPendingPlayer(player.id);
      inferFinalPendingPlacement();
    }
  }

  function parseRosterFromPage() {
    if (!players.length) return {};
    const lines = pageTextLines();
    const start = lines.findIndex((line) => line === "Roster");
    const end = lines.findIndex((line, index) => index > start && line === "Switches");
    const rosterLines = start >= 0 ? lines.slice(start + 1, end > start ? end : start + 40) : lines;
    const roster = {};

    for (let i = 0; i < rosterLines.length; i += 1) {
      const pos = rosterLines[i];
      if (!POSITIONS.includes(pos)) continue;
      if (rosterLines[i + 1] === "Empty") {
        roster[pos] = null;
        continue;
      }
      const name = rosterLines[i + 1];
      const teamEra = rosterLines[i + 2] || "";
      const teamEraMatch = teamEra.match(/([A-Z0-9]{2,4})\s*(?:·|\||-|\s)\s*((?:19|20)\d0s)/);
      if (!teamEraMatch) {
        roster[pos] = null;
        continue;
      }
      const team = teamEraMatch[1];
      const era = teamEraMatch[2];
      const player = Core.findPlayer(players, name, team, era);
      roster[pos] = player ? player.id : null;
      if (roster[pos]) trackedRoster[pos] = roster[pos];
    }

    reconcileTrackedRosterWithSlots();
    if (Date.now() < trackedRosterOverrideUntil) {
      for (const pos of POSITIONS) {
        const playerId = trackedRoster[pos];
        if (!playerId) continue;
        for (const other of POSITIONS) {
          if (other !== pos && roster[other] === playerId) roster[other] = null;
        }
        roster[pos] = playerId;
      }
    } else {
      for (const pos of POSITIONS) {
        if (!roster[pos] && trackedRoster[pos]) roster[pos] = trackedRoster[pos];
      }
    }

    return roster;
  }

  function fillSelects() {
    if (!playerIndex) return;
    const teamSelect = document.querySelector(`#${overlayId} [name=team]`);
    const eraSelect = document.querySelector(`#${overlayId} [name=era]`);
    if (!teamSelect || !eraSelect) return;

    if (teamSelect.options.length <= 1) {
      for (const team of playerIndex.teams) {
        teamSelect.appendChild(el("option", { value: team, text: team }));
      }
    }
    if (eraSelect.options.length <= 1) {
      for (const era of playerIndex.eras.filter(isSupportedEra)) {
        eraSelect.appendChild(el("option", { value: era, text: era }));
      }
    }
    renderSpinConfig();
  }

  function updateFixedSpinRollsFromInputs() {
    const rows = [];
    for (let index = 0; index < DEFAULT_FIXED_SPIN_ROLLS.length; index += 1) {
      const team = value(`[data-spin-team="${index}"]`).trim().toUpperCase();
      const era = normalizeEraLabel(value(`[data-spin-era="${index}"]`));
      rows.push([team, era]);
    }
    fixedSpinRolls = normalizeFixedSpinRolls(rows);
    saveFixedSpinRolls();
  }

  function renderSpinConfig() {
    const node = document.querySelector(`#${overlayId} [data-role=spin-config]`);
    if (!node || !playerIndex) return;
    node.replaceChildren();

    fixedSpinRolls.forEach(([team, era], index) => {
      const teamSelect = el("select", { "data-spin-team": String(index), title: `spin ${index + 1} team` });
      for (const teamOption of playerIndex.teams) {
        teamSelect.appendChild(el("option", { value: teamOption, text: teamOption }));
      }
      teamSelect.value = playerIndex.teams.includes(team) ? team : DEFAULT_FIXED_SPIN_ROLLS[index][0];

      const eraSelect = el("select", { "data-spin-era": String(index), title: `spin ${index + 1} era` });
      for (const eraLabel of LIVE_ERA_LABELS) {
        const fullEra = ERA_LABELS[eraLabel];
        eraSelect.appendChild(el("option", { value: fullEra, text: eraLabel }));
      }
      eraSelect.value = isSupportedEra(era) ? era : normalizeEraLabel(DEFAULT_FIXED_SPIN_ROLLS[index][1]);

      teamSelect.addEventListener("change", updateFixedSpinRollsFromInputs);
      eraSelect.addEventListener("change", updateFixedSpinRollsFromInputs);
      node.appendChild(el("div", { class: "spin-row" }, [
        el("span", { class: "spin-index", text: String(index + 1) }),
        teamSelect,
        eraSelect
      ]));
    });
  }

  function readStateFromForm() {
    const roster = {};
    for (const pos of POSITIONS) roster[pos] = null;

    const manual = value("[name=roster]").trim();
    if (manual && !rosterTextAutoFilled) {
      Object.assign(roster, parseRosterText(manual));
    } else {
      Object.assign(roster, parseRosterFromPage());
    }

    return {
      roster,
      currentTeam: value("[name=team]"),
      currentEra: value("[name=era]"),
      teamSwitchUsed: checked("[name=teamSwitchUsed]"),
      eraSwitchUsed: checked("[name=eraSwitchUsed]")
    };
  }

  function rosterList(roster) {
    return POSITIONS
      .map((pos) => roster[pos] ? playerIndex.playersById.get(roster[pos]) : null)
      .filter(Boolean);
  }

  function liveFinalRecord(text) {
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const index = lines.findIndex((line) => /^PROJECTED RECORD$/i.test(line));
    return index >= 0 ? lines[index + 1] || "" : "";
  }

  function finalPageReport(text, roster) {
    const list = rosterList(roster);
    if (list.length !== POSITIONS.length || !/PROJECTED RECORD/i.test(text)) return "";
    const standard = Core.calculateTeamResult(list, false);
    const lines = ["Final page read:"];
    const liveRecord = liveFinalRecord(text);
    if (liveRecord) lines.push(`Live record: ${liveRecord}`);
    lines.push(`Standard: ${standard.teamOvr.toFixed(1)} OVR, ${standard.wins}-${standard.losses}`);
    for (const pos of POSITIONS) {
      const player = playerIndex.playersById.get(roster[pos]);
      if (player) lines.push(`${pos}: ${player.player} | ${player.team} | ${player.era}`);
    }
    return lines.join("\n");
  }

  function refreshPageState() {
    const text = document.body.innerText;
    const parsedRoll = parseCurrentRoll(text);
    let roll = null;
    if (pendingRollResolved(lastConsoleRoll)) roll = lastConsoleRoll;
    else if (pendingRollResolved(parsedRoll)) roll = parsedRoll;
    else if (!pendingSpinRollKey) roll = parsedRoll || lastConsoleRoll;
    const waitingForReroll = pendingSpinActive && !roll;
    const switches = parseSwitchState(text);
    const roster = parseRosterFromPage();

    if (roll) {
      applyRollToForm(roll);
    } else {
      document.querySelector(`#${overlayId} [name=team]`).value = "";
      document.querySelector(`#${overlayId} [name=era]`).value = "";
    }
    const teamSwitchInput = document.querySelector(`#${overlayId} [name=teamSwitchUsed]`);
    const eraSwitchInput = document.querySelector(`#${overlayId} [name=eraSwitchUsed]`);
    if (roll && switches.teamSwitchUsed !== null) teamSwitchInput.checked = switches.teamSwitchUsed;
    else if (!roll) teamSwitchInput.checked = false;
    if (roll && switches.eraSwitchUsed !== null) eraSwitchInput.checked = switches.eraSwitchUsed;
    else if (!roll) eraSwitchInput.checked = false;

    const lines = [];
    for (const pos of POSITIONS) {
      const player = roster[pos] ? playerIndex.playersById.get(roster[pos]) : null;
      if (player) lines.push(`${pos}: ${player.player} | ${player.team} | ${player.era}`);
    }
    document.querySelector(`#${overlayId} [name=roster]`).value = lines.join("\n");
    rosterTextAutoFilled = true;

    const rosterCount = Object.values(roster).filter(Boolean).length;
    const unreadable = unreadableFilledPositions(roster);
    const rosterNote = unreadable.length ? `${rosterCount}/5 roster, unreadable: ${unreadable.join("/")}` : `${rosterCount}/5 roster`;
    const finalReport = finalPageReport(text, roster);
    if (waitingForReroll) {
      setStatus(`waiting for reroll, ${rosterNote}`);
      writeOutput("waiting for new team/era...");
    } else if (finalReport) {
      setStatus(`final page read: ${rosterNote}`);
      writeOutput(finalReport);
    } else {
      setStatus(`page state read: ${roll ? `${roll.team} ${roll.era}` : "roll not found"}, ${rosterNote}`);
    }
    maybeAutoSolve(roll, roster, unreadable);
  }

  function autoSolveKey(roll) {
    return `${rollKey(roll)}|${checked("[name=teamSwitchUsed]") ? 1 : 0}|${checked("[name=eraSwitchUsed]") ? 1 : 0}|${spinResultSequence}`;
  }

  function maybeAutoSolve(roll, roster, unreadable) {
    if (!roll || unreadable.length > 0) return;
    if (Object.values(roster).filter(Boolean).length >= POSITIONS.length) return;
    if (pendingSpinActive) {
      if (!pendingRollResolved(roll)) return;
      clearPendingSpin();
    }
    const key = autoSolveKey(roll);
    if (key === lastAutoSolveKey) return;
    lastAutoSolveKey = key;
    setTimeout(() => {
      solveEv();
    }, 0);
  }

  function formatGoalValue(goal, value) {
    return goal === "eightyTwoZero" ? `${(value * 100).toFixed(1)}%` : `${value.toFixed(3)} OVR`;
  }

  function zeroEightyTwoLine(goalResult) {
    if (goalResult.goal !== "eightyTwoZero" || goalResult.heuristic || goalResult.value !== 0) return "";
    return goalResult.approximate ? "no positive 82-0 edge found yet" : "no positive 82-0 path found";
  }

  function goalBadge(goalResult) {
    if (!goalResult) return "searching";
    if (goalResult.precomputed) return "precomputed estimate";
    if (goalResult.greedy) return "greedy estimate";
    if (goalResult.heuristic) return "rough";
    if (goalResult.timedOut) return "time budget";
    if (goalResult.stateLimited || (goalResult.truncated && !goalResult.timedOut)) return "state limit";
    if (goalResult.approximate) return "partial search";
    return "exact";
  }

  function goalValueText(goalResult) {
    if (!goalResult) return "";
    if (goalResult.goal === "maxScore") return `Expected: ${goalResult.value.toFixed(3)} OVR`;
    const prefix = goalResult.precomputed ? "Precomputed estimate" : goalResult.greedy ? "Greedy chance" : goalResult.heuristic ? "Rough chance" : "Chance";
    return `${prefix}: ${formatGoalValue(goalResult.goal, goalResult.value)}`;
  }

  function goalActionText(goalResult) {
    if (!goalResult) return "searching...";
    return zeroEightyTwoLine(goalResult) || goalResult.bestActionLabel || "none";
  }

  function sourceText(goalResult) {
    if (!goalResult) return "";
    if (goalResult.precomputed) return goalResult.precomputeNote || "source: precomputed 82-0 opening estimate";
    if (goalResult.greedy) {
      const root = goalResult.candidateTruncated ? "top current candidates" : "all current actions";
      return `${goalResult.statesVisited || 0} states, source: greedy ${root}/all-combo tail`;
    }
    const states = `${goalResult.statesVisited || 0} states`;
    if (goalResult.rough) {
      return `${states}, rough all ${goalResult.rough.rootActions} actions/top${goalResult.rough.comboPlayerLimit}/tail${goalResult.rough.tailRollouts}`;
    }
    return states;
  }

  function goalCard(label, goalResult) {
    const card = el("div", {
      class: `goal-card${goalResult?.precomputed ? " precomputed" : ""}`
    });
    card.appendChild(el("div", { class: "goal-head" }, [
      el("span", { class: "goal-label", text: label }),
      el("span", { class: "goal-badge", text: goalBadge(goalResult) })
    ]));
    card.appendChild(el("div", { class: "goal-action", text: goalActionText(goalResult) }));
    if (goalResult) card.appendChild(el("div", { class: "goal-value", text: goalValueText(goalResult) }));
    const source = sourceText(goalResult);
    if (source) card.appendChild(el("div", { class: "goal-source", text: source }));
    return card;
  }

  function renderEvView(view, done) {
    if (!view) return;
    const node = document.querySelector(`#${overlayId} [data-role=output]`);
    if (!node) return;
    const maxStates = view.goals.maxScore?.statesVisited || 0;
    const eightyTwoZeroStates = view.goals.eightyTwoZero?.statesVisited || 0;
    node.style.whiteSpace = "normal";
    node.replaceChildren(
      el("div", { class: "ev-summary" }, [
        el("span", { text: done ? "done" : "running" }),
        el("span", { text: "standard" }),
        el("span", { text: `${view.currentStandard.teamOvr.toFixed(1)} OVR` }),
        el("span", { text: `${view.currentStandard.wins}-${view.currentStandard.losses}` })
      ]),
      el("div", { class: "state-summary", text: `${maxStates + eightyTwoZeroStates} states total` }),
      goalCard("max score", view.goals.maxScore),
      goalCard("82-0", view.goals.eightyTwoZero)
    );
  }

  function currentResultsForState(state) {
    const list = rosterList(state.roster);
    return {
      currentStandard: Core.calculateTeamResult(list, false)
    };
  }

  function rosterSize(roster) {
    return Object.values(roster || {}).filter(Boolean).length;
  }

  function isFirstPlayerState(state) {
    return rosterSize(state.roster) === 0 && !state.teamSwitchUsed && !state.eraSwitchUsed;
  }

  function precomputedGoalResult(state, table) {
    const entry = table?.entries?.[`${state.currentTeam}|${state.currentEra}`]?.eightyTwoZero;
    if (!entry) return null;
    const metadata = table?.metadata || {};
    const positionNote = metadata.positionSwitching ? "/position switching" : "";
    return {
      goal: "eightyTwoZero",
      value: entry.value,
      bestActionLabel: entry.action?.label || "none",
      topActions: entry.topActions || [],
      statesVisited: 0,
      approximate: true,
      precomputed: true,
      precomputeNote: `source: precomputed 82-0 first-player estimate, depth ${metadata.depth || "?"}/top${metadata.candidateLimit || "?"}/tail${positionNote}`
    };
  }

  function shouldKeepPrecomputedGoal(current, next) {
    return !!current?.precomputed && (!next || next.heuristic || next.approximate);
  }

  function renderEvProgress(progress) {
    if (!activeEvView || !progress?.goal) return;
    if (shouldKeepPrecomputedGoal(activeEvView.goals[progress.goal], progress)) return;
    activeEvView.goals[progress.goal] = progress;
    renderEvView(activeEvView, false);
  }

  function renderEvResult(result) {
    const goals = { ...(result.goals || {}) };
    if (shouldKeepPrecomputedGoal(activeEvView?.goals?.eightyTwoZero, goals.eightyTwoZero)) {
      goals.eightyTwoZero = activeEvView.goals.eightyTwoZero;
    }
    activeEvView = {
      options: result.options,
      currentStandard: result.currentStandard,
      goals
    };
    renderEvView(activeEvView, true);
  }

  function validateRollState(state) {
    const unreadable = unreadableFilledPositions(state.roster);
    if (unreadable.length > 0) {
      return `Filled slot${unreadable.length === 1 ? "" : "s"} ${unreadable.join(", ")} cannot be read from page initials. Enter roster lines manually or start a new game with the extension active.`;
    }
    if (!state.currentTeam || !state.currentEra) {
      return "Current team and era are required. Click read page or select them manually.";
    }
    if (
      !playerIndex.teams.includes(state.currentTeam) ||
      !isSupportedEra(state.currentEra) ||
      !(playerIndex.playersByCombo.get(`${state.currentTeam}|${state.currentEra}`) || []).length
    ) {
      return `Invalid current roll: ${state.currentTeam || "?"} ${state.currentEra || "?"}.`;
    }
    return "";
  }

  function currentPoolReport() {
    const state = readStateFromForm();
    const error = validateRollState(state);
    if (error) {
      writeOutput(error);
      return;
    }
    const adjusted = false;
    const used = new Set();
    for (const id of Object.values(state.roster)) {
      const player = id ? playerIndex.playersById.get(id) : null;
      if (player) used.add(player.baseSlug || player.player.toLowerCase());
    }

    const pool = playerIndex.playersByCombo.get(`${state.currentTeam}|${state.currentEra}`) || [];
    const available = pool
      .filter((player) => {
        if (used.has(player.baseSlug || player.player.toLowerCase())) return false;
        return Core.canAddPlayerToRoster(state.roster, player, playerIndex.playersById);
      })
      .sort((a, b) => Core.playerHeuristic(b, adjusted) - Core.playerHeuristic(a, adjusted))
      .slice(0, 20);

    const lines = [`Pool ${state.currentTeam} ${state.currentEra} (standard): ${available.length} shown`];
    for (const player of available) {
      const slots = (player.positions || [player.pos]).join("/");
      const score = Core.playerHeuristic(player, adjusted);
      lines.push(`${score.toFixed(3)} standard score ${player.player} (${slots})`);
    }
    writeOutput(lines.join("\n"));
  }

  function readSolverOptions() {
    return {
      options: {
        objective: "standard",
        candidateLimit: 0,
        maxStates: 0,
        timeLimitMs: 0
      }
    };
  }

  async function solveEv() {
    await loadPlayers();
    const state = readStateFromForm();
    const error = validateRollState(state);
    if (error) {
      setStatus("state incomplete");
      writeOutput(error);
      return;
    }
    const solverOptions = readSolverOptions();
    if (solverOptions.error) {
      setStatus("invalid solver options");
      writeOutput(solverOptions.error);
      return;
    }
    const summary = currentResultsForState(state);
    activeEvView = {
      options: solverOptions.options,
      currentStandard: summary.currentStandard,
      goals: {}
    };
    if (solverOptions.options.objective === "standard" && isFirstPlayerState(state)) {
      const table = await loadPrecomputedOpenings();
      const precomputed = precomputedGoalResult(state, table);
      if (precomputed) activeEvView.goals.eightyTwoZero = precomputed;
    }
    const id = ++requestId;
    resetWorker();
    setSolvingEv(true);
    setStatus("calculating...");
    renderEvView(activeEvView, false);
    try {
      const evWorker = await ensureWorker();
      evWorker.postMessage({
        type: "SOLVE_EV",
        id,
        state,
        options: solverOptions.options
      });
    } catch (error) {
      if (id !== requestId) return;
      setSolvingEv(false);
      setStatus("worker failed");
      writeOutput(`Worker failed: ${error && error.message ? error.message : error}`);
    }
  }

  function makeDraggable(box) {
    const handle = box.querySelector("[data-role=drag]");
    if (!handle) return;
    let drag = null;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: box.offsetLeft,
        top: box.offsetTop
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const maxLeft = Math.max(0, window.innerWidth - box.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - box.offsetHeight);
      const left = Math.min(maxLeft, Math.max(0, drag.left + event.clientX - drag.startX));
      const top = Math.min(maxTop, Math.max(0, drag.top + event.clientY - drag.startY));
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.right = "auto";
    });

    handle.addEventListener("pointerup", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      handle.releasePointerCapture(event.pointerId);
    });
  }

  function makeResizable(box) {
    const handle = box.querySelector("[data-role=resize]");
    if (!handle) return;
    let resize = null;

    handle.addEventListener("pointerdown", (event) => {
      resize = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        width: box.offsetWidth,
        height: box.offsetHeight
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!resize || event.pointerId !== resize.pointerId) return;
      const maxWidth = Math.max(240, window.innerWidth - box.offsetLeft);
      const maxHeight = Math.max(180, window.innerHeight - box.offsetTop);
      const width = Math.min(maxWidth, Math.max(240, resize.width + event.clientX - resize.startX));
      const height = Math.min(maxHeight, Math.max(180, resize.height + event.clientY - resize.startY));
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      box.style.maxHeight = "none";
    });

    handle.addEventListener("pointerup", (event) => {
      if (!resize || event.pointerId !== resize.pointerId) return;
      resize = null;
      handle.releasePointerCapture(event.pointerId);
    });
  }

  function toggleMinimized() {
    const box = getOverlay();
    if (!box) return;
    const body = box.querySelector("[data-role=body]");
    const button = box.querySelector("[data-action=minimize]");
    const resize = box.querySelector("[data-role=resize]");
    const header = box.querySelector("[data-role=drag]");
    const minimized = body.style.display !== "none";
    body.style.display = minimized ? "none" : "block";
    if (resize) resize.style.display = minimized ? "none" : "block";
    if (header) header.style.marginBottom = minimized ? "0" : "4px";
    if (minimized) {
      box.dataset.widthBeforeMinimize = box.style.width || "";
      box.dataset.heightBeforeMinimize = box.style.height || "";
      box.dataset.minWidthBeforeMinimize = box.style.minWidth || "";
      box.dataset.minHeightBeforeMinimize = box.style.minHeight || "";
      box.dataset.paddingBottomBeforeMinimize = box.style.paddingBottom || "";
      box.style.width = "96px";
      box.style.height = "auto";
      box.style.minWidth = "0";
      box.style.minHeight = "0";
      box.style.paddingBottom = "6px";
      box.style.overflow = "hidden";
    } else {
      box.style.width = box.dataset.widthBeforeMinimize || "min(400px, calc(100vw - 20px))";
      box.style.height = box.dataset.heightBeforeMinimize || "";
      box.style.minWidth = box.dataset.minWidthBeforeMinimize || "240px";
      box.style.minHeight = box.dataset.minHeightBeforeMinimize || "180px";
      box.style.paddingBottom = box.dataset.paddingBottomBeforeMinimize || "14px";
      box.style.overflow = "auto";
    }
    if (button) button.textContent = minimized ? "+" : "-";
  }

  function fixedSpinTargetValues() {
    const teamOrder = [];
    const erasByTeam = new Map();
    for (const player of players) {
      if (!player.team || !isSupportedEra(player.era)) continue;
      if (!erasByTeam.has(player.team)) {
        erasByTeam.set(player.team, new Set());
        teamOrder.push(player.team);
      }
      erasByTeam.get(player.team).add(player.era);
    }

    const combos = [];
    for (const team of teamOrder) {
      const eras = erasByTeam.get(team);
      for (const shortEra of LIVE_ERA_LABELS) {
        const era = ERA_LABELS[shortEra];
        if (eras.has(era)) combos.push([team, era]);
      }
    }
    if (combos.length === 0) throw new Error("No live spin combos found in bundled player data.");

    const comboIndexes = new Map();
    combos.forEach(([team, era], index) => {
      comboIndexes.set(`${team}|${era}`, index);
    });

    updateFixedSpinRollsFromInputs();
    return fixedSpinRolls.map(([team, selectedEra]) => {
      const era = normalizeEraLabel(selectedEra);
      const index = comboIndexes.get(`${team}|${era}`);
      if (index === undefined) throw new Error(`Fixed spin target unavailable: ${team} ${shortEraLabel(era)}.`);
      return (index + 0.5) / combos.length;
    });
  }

  async function fixSpins() {
    try {
      await loadPlayers();
      const script = document.createElement("script");
      script.src = extensionUrl("fixed-spins.js");
      script.dataset.targets = JSON.stringify(fixedSpinTargetValues());
      script.onload = () => script.remove();
      script.onerror = () => {
        setStatus("fixed spins failed");
        script.remove();
      };
      document.documentElement.appendChild(script);
      setStatus("fixed spins injected");
    } catch (error) {
      setStatus("fixed spins failed");
      writeOutput(`Fixed spins failed: ${error && error.message ? error.message : error}`);
    }
  }

  function setActiveTab(tab) {
    activeTab = tab;
    const box = getOverlay();
    if (!box) return;
    for (const button of box.querySelectorAll("[data-tab]")) {
      const selected = button.dataset.tab === tab;
      button.dataset.active = selected ? "true" : "false";
      button.setAttribute("aria-selected", selected ? "true" : "false");
    }
    for (const panel of box.querySelectorAll("[data-panel]")) {
      panel.hidden = panel.dataset.panel !== tab;
    }
  }

  function buildOverlay() {
    if (getOverlay()) return;
    const box = el("div", {
      id: overlayId,
      style: {
        position: "fixed",
        zIndex: "2147483647",
        top: "10px",
        right: "10px",
        width: "min(400px, calc(100vw - 20px))",
        minWidth: "240px",
        minHeight: "180px",
        maxHeight: "92vh",
        overflow: "auto",
        background: "white",
        color: "black",
        border: "2px solid black",
        padding: "6px",
        paddingBottom: "14px",
        font: "11px Arial, sans-serif"
      }
    });

    box.innerHTML = `
      <style>
        #${overlayId} button,
        #${overlayId} select,
        #${overlayId} summary,
        #${overlayId} label,
        #${overlayId} input[type="checkbox"] {
          cursor: pointer;
        }
        #${overlayId} .tabs {
          display: flex;
          gap: 4px;
          margin-bottom: 5px;
        }
        #${overlayId} .tab {
          flex: 1 1 0;
          border: 1px solid black;
          background: white;
          color: black;
          padding: 3px 4px;
          font-size: 11px;
        }
        #${overlayId} .tab[data-active="true"] {
          background: black;
          color: white;
        }
        #${overlayId} .row {
          display: flex;
          gap: 4px;
          align-items: center;
          margin-bottom: 4px;
        }
        #${overlayId} .action-row {
          display: flex;
          flex-wrap: nowrap;
          gap: 4px;
          margin: 5px 0;
        }
        #${overlayId} .action-row button {
          flex: 1 1 0;
          min-width: 0;
          border: 1px solid black;
          background: white;
          color: black;
          padding: 2px 3px;
          font-size: 11px;
          white-space: nowrap;
        }
        #${overlayId} .ev-summary {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-bottom: 4px;
          font-size: 10px;
        }
        #${overlayId} .ev-summary span,
        #${overlayId} .goal-badge {
          border: 1px solid #999;
          padding: 1px 3px;
          background: #f7f7f7;
        }
        #${overlayId} .state-summary,
        #${overlayId} .goal-source,
        #${overlayId} .goal-value {
          font-size: 10px;
          color: #333;
        }
        #${overlayId} .goal-card {
          border: 1px solid #999;
          padding: 5px;
          margin-top: 5px;
          background: white;
        }
        #${overlayId} .goal-card.precomputed {
          border-color: black;
        }
        #${overlayId} .goal-head {
          display: flex;
          justify-content: space-between;
          gap: 6px;
          align-items: center;
        }
        #${overlayId} .goal-label,
        #${overlayId} .goal-action {
          font-weight: bold;
        }
        #${overlayId} .goal-action {
          margin-top: 3px;
          font-size: 12px;
          line-height: 1.2;
        }
        #${overlayId} .spin-config {
          display: grid;
          gap: 4px;
          margin-bottom: 6px;
        }
        #${overlayId} .spin-row {
          display: grid;
          grid-template-columns: 16px minmax(0, 1fr) minmax(0, 1fr);
          gap: 4px;
          align-items: center;
        }
        #${overlayId} .spin-row select {
          min-width: 0;
          border: 1px solid black;
          background: white;
          color: black;
          font-size: 11px;
        }
        #${overlayId} .spin-index {
          font-weight: bold;
          text-align: right;
        }
      </style>
      <div data-role="drag" style="cursor: move; user-select: none; font-weight: bold; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
        <span style="flex: 1;">82-0</span>
        <button type="button" data-action="minimize" title="minimize" style="border: 1px solid black; background: white; color: black; padding: 0 5px; font-size: 11px; cursor: pointer;">-</button>
      </div>
      <div data-role="body">
        <div data-role="status" style="margin-bottom: 4px;">not loaded</div>
        <div class="tabs" role="tablist">
          <button type="button" class="tab" data-tab="solve" data-active="true" aria-selected="true">solve</button>
          <button type="button" class="tab" data-tab="spins" data-active="false" aria-selected="false">spins</button>
        </div>
        <div data-panel="solve">
          <div class="row">
            <select name="team" style="font-size: 11px; min-width: 0; flex: 1;"><option value="">team</option></select>
            <select name="era" style="font-size: 11px; min-width: 0; flex: 1;"><option value="">era</option></select>
            <span style="font-size: 10px; border: 1px solid #999; padding: 1px 3px;">standard</span>
          </div>
          <div style="display: flex; gap: 8px; margin-bottom: 4px;">
            <label><input type="checkbox" name="teamSwitchUsed"> team used</label>
            <label><input type="checkbox" name="eraSwitchUsed"> era used</label>
          </div>
          <details>
            <summary>roster</summary>
            <textarea name="roster" rows="4" cols="40" style="width: 100%; box-sizing: border-box; font-size: 11px;"></textarea>
          </details>
          <div class="action-row">
            <button type="button" data-action="refresh" title="read page">read</button>
            <button type="button" data-action="pool" title="current pool">pool</button>
            <button type="button" data-action="solve" title="solve EV">solve</button>
          </div>
          <div data-role="output" style="white-space: pre-wrap; font-size: 11px; margin: 0;"></div>
        </div>
        <div data-panel="spins" hidden>
          <div style="font-weight: bold; margin-bottom: 4px;">fixed sequence</div>
          <div class="spin-config" data-role="spin-config"></div>
          <div class="action-row">
            <button type="button" data-action="fix-spins" title="fix spins">fix spins</button>
          </div>
        </div>
      </div>
      <div data-role="resize" title="resize" style="position: absolute; right: 2px; bottom: 2px; width: 12px; height: 12px; cursor: nwse-resize; border-right: 2px solid black; border-bottom: 2px solid black;"></div>
    `;

    document.documentElement.appendChild(box);
    makeDraggable(box);
    makeResizable(box);
    box.querySelector("[data-action=refresh]").addEventListener("click", refreshPageState);
    box.querySelector("[data-action=pool]").addEventListener("click", currentPoolReport);
    box.querySelector("[data-action=solve]").addEventListener("click", solveEv);
    box.querySelector("[data-action=fix-spins]").addEventListener("click", fixSpins);
    box.querySelector("[data-action=minimize]").addEventListener("click", toggleMinimized);
    for (const button of box.querySelectorAll("[data-tab]")) {
      button.addEventListener("click", () => setActiveTab(button.dataset.tab));
    }
    setActiveTab(activeTab);
    box.querySelector("[name=roster]").addEventListener("input", () => { rosterTextAutoFilled = false; });
  }

  async function show() {
    buildOverlay();
    getOverlay().style.display = "block";
    await loadPlayers();
    fillSelects();
    ensureRollListener();
    ensureWorker().catch((error) => {
      if (String(error && error.message ? error.message : error) === "stale worker") return;
      setStatus("worker failed");
      writeOutput(`Worker failed: ${error && error.message ? error.message : error}`);
    });
    refreshPageState();
  }

  function hide() {
    const overlay = getOverlay();
    if (overlay) overlay.style.display = "none";
    disableRollListener();
  }

  async function toggle() {
    const overlay = getOverlay();
    if (overlay && overlay.style.display !== "none") {
      hide();
      return;
    }
    await show();
  }

  if (runtimeApi?.onMessage?.addListener) {
    runtimeApi.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "SHOW_82_SOLVER") {
        show().then(() => sendResponse({ ok: true })).catch((error) => {
          sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
        });
        return true;
      }
      if (message.type === "HIDE_82_SOLVER") {
        hide();
        sendResponse({ ok: true });
        return true;
      }
      if (message.type === "TOGGLE_82_SOLVER") {
        toggle().then(() => sendResponse({ ok: true })).catch((error) => {
          sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
        });
        return true;
      }
      return false;
    });
  }

  if (/^https:\/\/(www\.)?82-0\.com\//.test(location.href)) {
    show();
  }
})();
