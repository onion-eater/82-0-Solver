#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

require("./solver-core.js");

const Core = globalThis.EightyTwoZeroSolverCore;
const POSITIONS = Core.ALL_POSITIONS;
const EMPTY = -1;

function parseArgs(argv) {
  const options = {
    players: "data/players.json",
    out: "data/precomputed-depth2-standard-82.json",
    objective: "standard",
    depth: 2,
    candidateLimit: 3,
    goal: "eightyTwoZero",
    limit: 0,
    combo: "",
    noWrite: false,
    selfTest: false,
    progressEvery: 1,
    staticMemoLimit: 500000,
    tailComboLimit: 0,
    rollLimit: 0
  };

  for (const arg of argv) {
    if (arg === "--no-write") {
      options.noWrite = true;
      continue;
    }
    if (arg === "--self-test") {
      options.selfTest = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = match[2];
    if (["depth", "candidateLimit", "limit", "progressEvery", "staticMemoLimit", "tailComboLimit", "rollLimit"].includes(key)) {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0) throw new Error(`Invalid numeric value for --${match[1]}: ${value}`);
      options[key] = number;
    } else if (key in options) {
      options[key] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["standard", "adjusted"].includes(options.objective)) {
    throw new Error("--objective must be standard or adjusted");
  }
  if (!["both", "eightyTwoZero", "maxScore"].includes(options.goal)) {
    throw new Error("--goal must be both, eightyTwoZero, or maxScore");
  }
  return options;
}

function readPlayers(filePath) {
  return Core.normalizePlayers(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function baseSlug(player) {
  return player.baseSlug || String(player.player || "").toLowerCase();
}

function positionMask(player) {
  let mask = 0;
  for (const pos of player.positions || [player.pos]) {
    const index = POSITIONS.indexOf(pos);
    if (index >= 0) mask |= 1 << index;
  }
  return mask;
}

function rosterKey(roster) {
  return roster.join(".");
}

function cloneRoster(roster) {
  return roster.slice();
}

function openMask(roster) {
  let mask = 0;
  for (let i = 0; i < POSITIONS.length; i += 1) {
    if (roster[i] === EMPTY) mask |= 1 << i;
  }
  return mask;
}

function isFull(roster) {
  return openMask(roster) === 0;
}

function usedBaseSet(roster, meta) {
  const used = new Set();
  for (const playerIndex of roster) {
    if (playerIndex !== EMPTY) used.add(meta[playerIndex].baseIndex);
  }
  return used;
}

function bitCount(mask) {
  let count = 0;
  let value = mask;
  while (value) {
    value &= value - 1;
    count += 1;
  }
  return count;
}

function rosterAdditions(roster, playerIndex, meta) {
  const usedBases = usedBaseSet(roster, meta);
  if (usedBases.has(meta[playerIndex].baseIndex)) return [];

  const players = roster.filter((index) => index !== EMPTY).concat(playerIndex);
  const sorted = players.slice().sort((a, b) => bitCount(meta[a].positionMask) - bitCount(meta[b].positionMask));
  const assigned = new Map();
  const additions = new Map();
  const currentPositions = new Map();
  roster.forEach((index, positionIndex) => {
    if (index !== EMPTY) currentPositions.set(index, positionIndex);
  });

  function backtrack(index, usedMask) {
    if (index === sorted.length) {
      const next = Array(POSITIONS.length).fill(EMPTY);
      for (const assignedPlayer of players) {
        next[assigned.get(assignedPlayer)] = assignedPlayer;
      }
      const positionIndex = assigned.get(playerIndex);
      let moves = 0;
      for (const assignedPlayer of players) {
        if (assignedPlayer !== playerIndex && currentPositions.get(assignedPlayer) !== assigned.get(assignedPlayer)) {
          moves += 1;
        }
      }
      const current = additions.get(positionIndex);
      if (!current || moves < current.moves) {
        additions.set(positionIndex, { positionIndex, roster: next, moves });
      }
      return;
    }

    const assignedPlayer = sorted[index];
    let legal = meta[assignedPlayer].positionMask & ~usedMask;
    while (legal) {
      const bit = legal & -legal;
      assigned.set(assignedPlayer, Math.log2(bit));
      backtrack(index + 1, usedMask | bit);
      assigned.delete(assignedPlayer);
      legal -= bit;
    }
  }

  backtrack(0, 0);
  return POSITIONS.map((_, positionIndex) => additions.get(positionIndex)).filter(Boolean);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function mkdirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
}

function metadataFor(options, combos, totalCombos, goals, complete, startedAt, entries) {
  return {
    generatedAt: new Date().toISOString(),
    objective: options.objective,
    depth: options.depth,
    depthMeaning: "number of pick decisions expanded from the current roll before the tail estimator; depth 3 means current pick plus two later picks",
    candidateLimit: options.candidateLimit,
    rollLimit: options.rollLimit,
    tailComboLimit: options.tailComboLimit,
    staticMemoLimit: options.staticMemoLimit,
    comboCount: combos.length,
    completedComboCount: combos.filter((combo) => entries[combo.key]).length,
    totalLiveCombos: totalCombos,
    goals,
    exact: false,
    positionSwitching: true,
    complete,
    note: "Depth-limited precompute. Tail evaluator is switch-aware and uses static completion for unexpanded picks.",
    elapsedMs: Date.now() - startedAt
  };
}

function writeOutput(options, output) {
  if (options.noWrite) return;
  mkdirForFile(options.out);
  const tempPath = `${options.out}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(output, null, 2)}\n`);
  fs.renameSync(tempPath, options.out);
}

function compatibleCheckpoint(output, options, goals) {
  const metadata = output && output.metadata;
  if (!metadata || !output.entries) return false;
  return metadata.objective === options.objective
    && metadata.depth === options.depth
    && metadata.candidateLimit === options.candidateLimit
    && metadata.rollLimit === options.rollLimit
    && metadata.tailComboLimit === options.tailComboLimit
    && metadata.positionSwitching === true
    && Array.isArray(metadata.goals)
    && metadata.goals.length === goals.length
    && metadata.goals.every((goal, index) => goal === goals[index]);
}

function readCheckpoint(options, goals) {
  if (options.noWrite || !fs.existsSync(options.out)) return {};
  const output = JSON.parse(fs.readFileSync(options.out, "utf8"));
  if (!compatibleCheckpoint(output, options, goals)) return {};
  return { ...output.entries };
}

function createPrecomputer(players, options) {
  const adjusted = options.objective !== "standard";
  const ctx = Core.indexPlayers(players);
  const playerIndexById = new Map(players.map((player, index) => [player.id, index]));
  const baseIndexBySlug = new Map();
  const meta = players.map((player, index) => {
    const slug = baseSlug(player);
    if (!baseIndexBySlug.has(slug)) baseIndexBySlug.set(slug, baseIndexBySlug.size);
    return {
      index,
      id: player.id,
      name: player.player,
      team: player.team,
      era: player.era,
      baseIndex: baseIndexBySlug.get(slug),
      positionMask: positionMask(player),
      heuristic: Core.playerHeuristic(player, adjusted)
    };
  });

  const combos = [];
  const comboIndexByKey = new Map();
  for (const team of ctx.teams) {
    for (const era of ctx.eras) {
      const key = `${team}|${era}`;
      const pool = ctx.playersByCombo.get(key) || [];
      if (!pool.length) continue;
      comboIndexByKey.set(key, combos.length);
      combos.push({ key, team, era });
    }
  }

  const comboPlayers = combos.map((combo) =>
    (ctx.playersByCombo.get(combo.key) || [])
      .map((player) => playerIndexById.get(player.id))
      .filter((index) => index !== undefined)
      .sort((a, b) => meta[b].heuristic - meta[a].heuristic)
  );

  const comboIndices = combos.map((_, index) => index);
  const rollComboIndices = options.rollLimit > 0
    ? comboIndices.slice(0, options.rollLimit)
    : comboIndices;
  const tailComboIndices = options.tailComboLimit > 0
    ? comboIndices.slice(0, options.tailComboLimit)
    : comboIndices;
  const teamsForEra = new Map();
  const erasForTeam = new Map();
  for (const combo of combos) {
    if (!teamsForEra.has(combo.era)) teamsForEra.set(combo.era, []);
    teamsForEra.get(combo.era).push(comboIndexByKey.get(combo.key));
    if (!erasForTeam.has(combo.team)) erasForTeam.set(combo.team, []);
    erasForTeam.get(combo.team).push(comboIndexByKey.get(combo.key));
  }

  const rollMemo = new Map();
  const afterPickMemo = new Map();
  const comboTailPickMemo = new Map();
  const comboCompletionMemo = new Map();
  const staticCompletionMemo = new Map();
  let rollCalls = 0;

  function stateKey(state, depth, goal) {
    return `${goal}|${depth}|${state.comboIndex}|${state.teamSwitchUsed ? 1 : 0}|${state.eraSwitchUsed ? 1 : 0}|${rosterKey(state.roster)}`;
  }

  function afterPickKey(state, depth, goal) {
    return `${goal}|${depth}|${state.teamSwitchUsed ? 1 : 0}|${state.eraSwitchUsed ? 1 : 0}|${rosterKey(state.roster)}`;
  }

  function rosterPlayers(roster) {
    return roster.filter((index) => index !== EMPTY).map((index) => players[index]);
  }

  function terminalValue(roster, goal) {
    const result = Core.calculateTeamResult(rosterPlayers(roster), adjusted);
    return goal === "eightyTwoZero" ? (result.teamOvr >= Core.EIGHTY_TWO_ZERO_TEAM_OVR ? 1 : 0) : result.teamOvr;
  }

  function partialValue(roster, goal) {
    const result = Core.calculateTeamResult(rosterPlayers(roster), adjusted);
    if (goal === "eightyTwoZero") return result.teamOvr >= Core.EIGHTY_TWO_ZERO_TEAM_OVR ? 1 : 0;
    return result.teamOvr;
  }

  function pickActions(state, limit) {
    const actions = [];

    for (const playerIndex of comboPlayers[state.comboIndex]) {
      for (const addition of rosterAdditions(state.roster, playerIndex, meta)) {
        actions.push({
          type: "pick",
          playerIndex,
          positionIndex: addition.positionIndex,
          roster: addition.roster
        });
        if (limit > 0 && actions.length >= limit) return actions;
      }
    }

    return actions;
  }

  function actionLabel(action) {
    if (!action) return "none";
    if (action.type === "teamSwitch") return "use team switch";
    if (action.type === "eraSwitch") return "use era switch";
    const player = meta[action.playerIndex];
    return `pick ${player.name} at ${POSITIONS[action.positionIndex]}`;
  }

  function serializeAction(action) {
    if (!action) return null;
    if (action.type !== "pick") return { type: action.type, label: actionLabel(action) };
    const player = meta[action.playerIndex];
    return {
      type: "pick",
      playerId: player.id,
      player: player.name,
      team: player.team,
      era: player.era,
      position: POSITIONS[action.positionIndex],
      label: actionLabel(action)
    };
  }

  function immediatePickEstimate(state, goal) {
    const actions = pickActions(state, options.candidateLimit);
    if (!actions.length) {
      return staticCompletionValue(state.roster, goal, state.teamSwitchUsed, state.eraSwitchUsed);
    }
    return actions.reduce((best, action) =>
      Math.max(best, staticCompletionValue(action.roster, goal, state.teamSwitchUsed, state.eraSwitchUsed)), -Infinity);
  }

  function switchScores(state, goal) {
    const combo = combos[state.comboIndex];
    const scores = [];

    if (!state.teamSwitchUsed) {
      const value = average((teamsForEra.get(combo.era) || []).map((comboIndex) => {
        const nextState = { ...state, comboIndex, teamSwitchUsed: true };
        return immediatePickEstimate(nextState, goal);
      }));
      scores.push({ action: { type: "teamSwitch" }, value });
    }

    if (!state.eraSwitchUsed) {
      const value = average((erasForTeam.get(combo.team) || []).map((comboIndex) => {
        const nextState = { ...state, comboIndex, eraSwitchUsed: true };
        return immediatePickEstimate(nextState, goal);
      }));
      scores.push({ action: { type: "eraSwitch" }, value });
    }

    return scores;
  }

  function bestComboTailPick(roster, comboIndex) {
    const key = `${comboIndex}|${rosterKey(roster)}`;
    if (comboTailPickMemo.has(key)) return comboTailPickMemo.get(key);
    let best = null;
    for (const playerIndex of comboPlayers[comboIndex]) {
      const additions = rosterAdditions(roster, playerIndex, meta);
      if (additions.length) {
        best = { playerIndex, positionIndex: additions[0].positionIndex, roster: additions[0].roster };
        break;
      }
    }
    if (options.staticMemoLimit > 0 && comboTailPickMemo.size < options.staticMemoLimit) {
      comboTailPickMemo.set(key, best);
    }
    return best;
  }

  function applyTailPick(roster, comboIndex) {
    const pick = bestComboTailPick(roster, comboIndex);
    if (!pick) return roster;
    return cloneRoster(pick.roster);
  }

  function comboCompletionValue(roster, comboIndex, goal) {
    const key = `${goal}|${comboIndex}|${rosterKey(roster)}`;
    if (comboCompletionMemo.has(key)) return comboCompletionMemo.get(key);
    let completed = cloneRoster(roster);
    while (!isFull(completed)) {
      const next = applyTailPick(completed, comboIndex);
      if (next === completed) break;
      completed = next;
    }
    const value = isFull(completed) ? terminalValue(completed, goal) : partialValue(completed, goal);
    if (options.staticMemoLimit > 0 && comboCompletionMemo.size < options.staticMemoLimit) {
      comboCompletionMemo.set(key, value);
    }
    return value;
  }

  function rollTailValue(roster, comboIndex, goal, teamSwitchUsed, eraSwitchUsed) {
    const combo = combos[comboIndex];
    const values = [comboCompletionValue(roster, comboIndex, goal)];
    if (!teamSwitchUsed) {
      values.push(average((teamsForEra.get(combo.era) || []).map((nextComboIndex) =>
        comboCompletionValue(roster, nextComboIndex, goal)
      )));
    }
    if (!eraSwitchUsed) {
      values.push(average((erasForTeam.get(combo.team) || []).map((nextComboIndex) =>
        comboCompletionValue(roster, nextComboIndex, goal)
      )));
    }
    return Math.max(...values);
  }

  function staticCompletionValue(roster, goal, teamSwitchUsed, eraSwitchUsed) {
    const key = `${goal}|${teamSwitchUsed ? 1 : 0}|${eraSwitchUsed ? 1 : 0}|${rosterKey(roster)}`;
    if (staticCompletionMemo.has(key)) return staticCompletionMemo.get(key);

    const value = average(tailComboIndices.map((comboIndex) =>
      rollTailValue(roster, comboIndex, goal, teamSwitchUsed, eraSwitchUsed)
    ));

    if (options.staticMemoLimit > 0 && staticCompletionMemo.size < options.staticMemoLimit) {
      staticCompletionMemo.set(key, value);
    }
    return value;
  }

  function afterPickValue(state, depth, goal) {
    if (isFull(state.roster)) return terminalValue(state.roster, goal);
    if (depth <= 0) return staticCompletionValue(state.roster, goal, state.teamSwitchUsed, state.eraSwitchUsed);
    const key = afterPickKey(state, depth, goal);
    if (afterPickMemo.has(key)) return afterPickMemo.get(key);
    const value = average(rollComboIndices.map((comboIndex) =>
      rollValue({ ...state, comboIndex }, depth, goal).value
    ));
    afterPickMemo.set(key, value);
    return value;
  }

  function rollValue(state, depth, goal) {
    rollCalls += 1;
    if (isFull(state.roster)) return { value: terminalValue(state.roster, goal), action: null, topActions: [] };
    if (depth <= 0) {
      return { value: staticCompletionValue(state.roster, goal, state.teamSwitchUsed, state.eraSwitchUsed), action: null };
    }
    const key = stateKey(state, depth, goal);
    if (rollMemo.has(key)) return rollMemo.get(key);

    const scores = scoreActions(state, depth, goal);
    const result = scores.length
      ? { value: scores[0].value, action: scores[0].action }
      : { value: partialValue(state.roster, goal), action: null };
    rollMemo.set(key, result);
    return result;
  }

  function scoreActions(state, depth, goal) {
    const scores = [];
    for (const action of pickActions(state, options.candidateLimit)) {
      scores.push({
        action,
        value: afterPickValue({ ...state, roster: action.roster }, depth - 1, goal)
      });
    }
    scores.push(...switchScores(state, goal));
    scores.sort((a, b) => b.value - a.value);
    return scores;
  }

  function openingState(comboIndex) {
    return {
      roster: Array(POSITIONS.length).fill(EMPTY),
      comboIndex,
      teamSwitchUsed: false,
      eraSwitchUsed: false
    };
  }

  function runGoal(comboIndex, goal) {
    const state = openingState(comboIndex);
    const scores = scoreActions(state, options.depth, goal);
    const result = scores.length
      ? { value: scores[0].value, action: scores[0].action, topActions: scores.slice(0, 5) }
      : { value: partialValue(state.roster, goal), action: null, topActions: [] };
    rollMemo.set(stateKey(state, options.depth, goal), { value: result.value, action: result.action });
    return {
      value: result.value,
      action: serializeAction(result.action),
      topActions: result.topActions.map((score) => ({
        value: score.value,
        action: serializeAction(score.action)
      }))
    };
  }

  function stats() {
    return {
      rollCalls,
      rollMemoSize: rollMemo.size,
      afterPickMemoSize: afterPickMemo.size,
      comboTailPickMemoSize: comboTailPickMemo.size,
      comboCompletionMemoSize: comboCompletionMemo.size,
      staticCompletionMemoSize: staticCompletionMemo.size
    };
  }

  function selfTestTailMonotonicity(goal = "maxScore", limit = 200) {
    let checked = 0;
    for (const comboIndex of comboIndices) {
      for (const playerIndex of comboPlayers[comboIndex]) {
        const playerMeta = meta[playerIndex];
        for (let positionIndex = 0; positionIndex < POSITIONS.length; positionIndex += 1) {
          if (!(playerMeta.positionMask & (1 << positionIndex))) continue;
          const roster = Array(POSITIONS.length).fill(EMPTY);
          roster[positionIndex] = playerIndex;
          const both = staticCompletionValue(roster, goal, false, false);
          const noTeam = staticCompletionValue(roster, goal, true, false);
          const noEra = staticCompletionValue(roster, goal, false, true);
          const none = staticCompletionValue(roster, goal, true, true);
          if (both + 1e-9 < noTeam || both + 1e-9 < noEra || noTeam + 1e-9 < none || noEra + 1e-9 < none) {
            throw new Error(`Tail monotonicity failed for ${combos[comboIndex].key} ${playerMeta.name}`);
          }
          checked += 1;
          if (checked >= limit) return checked;
        }
      }
    }
    return checked;
  }

  return { combos, runGoal, stats, selfTestTailMonotonicity };
}

function selectedCombos(combos, options) {
  let selected = combos;
  if (options.combo) {
    const wanted = new Set(options.combo.split(",").map((item) => item.trim()).filter(Boolean));
    selected = combos.filter((combo) => wanted.has(combo.key));
    if (!selected.length) throw new Error(`No matching combo for --combo=${options.combo}`);
  }
  if (options.limit > 0) selected = selected.slice(0, options.limit);
  return selected;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const players = readPlayers(options.players);
  const precomputer = createPrecomputer(players, options);
  if (options.selfTest) {
    const maxChecked = precomputer.selfTestTailMonotonicity("maxScore");
    const perfectChecked = precomputer.selfTestTailMonotonicity("eightyTwoZero");
    console.log(`self-test ok: maxScore ${maxChecked}, eightyTwoZero ${perfectChecked}`);
    return;
  }
  const combos = selectedCombos(precomputer.combos, options);
  const goals = options.goal === "both" ? ["eightyTwoZero", "maxScore"] : [options.goal];
  const entries = readCheckpoint(options, goals);
  let stopRequested = false;
  const requestStop = () => { stopRequested = true; };

  console.log(`precompute depth=${options.depth} objective=${options.objective} candidateLimit=${options.candidateLimit}`);
  console.log(`combos=${combos.length}/${precomputer.combos.length} goals=${goals.join(",")}`);
  if (Object.keys(entries).length) console.log(`resuming with ${Object.keys(entries).length} saved entries`);

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  for (let index = 0; index < combos.length; index += 1) {
    const combo = combos[index];
    if (entries[combo.key]) {
      if (options.progressEvery > 0 && ((index + 1) % options.progressEvery === 0 || index + 1 === combos.length)) {
        console.log(`${index + 1}/${combos.length} ${combo.key} saved`);
      }
      continue;
    }

    const comboStartedAt = Date.now();
    const entry = { team: combo.team, era: combo.era };
    for (const goal of goals) entry[goal] = precomputer.runGoal(precomputer.combos.indexOf(combo), goal);
    entries[combo.key] = entry;
    writeOutput(options, {
      metadata: metadataFor(options, combos, precomputer.combos.length, goals, false, startedAt, entries),
      entries,
      stats: {
        elapsedMs: Date.now() - startedAt,
        ...precomputer.stats()
      }
    });
    if (options.progressEvery > 0 && ((index + 1) % options.progressEvery === 0 || index + 1 === combos.length)) {
      const elapsed = ((Date.now() - comboStartedAt) / 1000).toFixed(2);
      console.log(`${index + 1}/${combos.length} ${combo.key} ${elapsed}s best82=${entry.eightyTwoZero?.action?.label || "n/a"} bestMax=${entry.maxScore?.action?.label || "n/a"}`);
    }
    if (stopRequested) break;
  }

  const output = {
    metadata: metadataFor(options, combos, precomputer.combos.length, goals, !stopRequested && combos.every((combo) => entries[combo.key]), startedAt, entries),
    entries,
    stats: {
      elapsedMs: Date.now() - startedAt,
      ...precomputer.stats()
    }
  };

  writeOutput(options, output);
  if (!options.noWrite) {
    console.log(`wrote ${options.out}`);
  }
  console.log(JSON.stringify(output.stats, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}
