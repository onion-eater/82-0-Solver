(function (root) {
  "use strict";

  const ALL_POSITIONS = ["PG", "SG", "SF", "PF", "C"];
  const STATS = ["ppg", "rpg", "apg", "spg", "bpg"];

  const ERA_BASELINES = {
    "1960s": { ppg: 30, rpg: 18, apg: 8, spg: 1.8, bpg: 1.8 },
    "1970s": { ppg: 28, rpg: 13, apg: 9, spg: 2, bpg: 2 },
    "1980s": { ppg: 28, rpg: 11, apg: 11, spg: 2.2, bpg: 2 },
    "1990s": { ppg: 27, rpg: 11, apg: 9, spg: 2, bpg: 2 },
    "2000s": { ppg: 27, rpg: 11, apg: 9, spg: 2, bpg: 2 },
    "2010s": { ppg: 28, rpg: 11, apg: 9, spg: 1.8, bpg: 1.8 },
    "2020s": { ppg: 28, rpg: 11, apg: 9, spg: 1.8, bpg: 1.8 }
  };
  const POSITION_WEIGHTS = {
    PG: { ppg: 0.4, rpg: 0.1, apg: 0.35, spg: 0.1, bpg: 0.05 },
    SG: { ppg: 0.45, rpg: 0.1, apg: 0.2, spg: 0.2, bpg: 0.05 },
    SF: { ppg: 0.45, rpg: 0.15, apg: 0.2, spg: 0.15, bpg: 0.05 },
    PF: { ppg: 0.4, rpg: 0.3, apg: 0.1, spg: 0.1, bpg: 0.1 },
    C: { ppg: 0.4, rpg: 0.35, apg: 0.1, spg: 0.05, bpg: 0.1 }
  };

  const LEGACY_PLAYERS = new Set([
    "larry bird", "tim duncan", "kevin durant", "magic johnson",
    "shaquille o'neal", "hakeem olajuwon", "bill russell", "kobe bryant",
    "oscar robertson", "karl malone", "kevin garnett", "isiah thomas",
    "tony parker", "manu ginobili", "draymond green", "scottie pippen",
    "dennis rodman", "stephen curry", "nikola jokic", "dirk nowitzki"
  ]);

  const TEAM_PPG_BASE = 133.4;
  const TEAM_RPG_BASE = 39.7;
  const TEAM_APG_BASE = 29.3;
  const TEAM_SPG_BASE = 6.1;
  const TEAM_BPG_BASE = 3.2;
  const TEAM_PPG_WEIGHT = 0.46;
  const TEAM_RPG_WEIGHT = 0.25;
  const TEAM_APG_WEIGHT = 0.18;
  const TEAM_SPG_WEIGHT = 0.07;
  const TEAM_BPG_WEIGHT = 0.04;
  const EIGHTY_TWO_ZERO_TEAM_OVR = 110;
  const LIVE_ERAS = ["1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"];
  const LIVE_ERA_SET = new Set(LIVE_ERAS);
  const STATE_PROGRESS_INTERVAL_MS = 2500;
  const ROUGH_COMBO_PLAYER_LIMIT = 8;
  const ROUGH_TAIL_ROLLOUTS = 4;
  const GREEDY_ROOT_ACTION_LIMIT = 8;

  const GRADE_THRESHOLDS = [
    { minWins: 80, grade: "S", label: "PERFECT", color: "#a855f7" },
    { minWins: 72, grade: "A+", label: "HISTORIC", color: "#22c55e" },
    { minWins: 62, grade: "A", label: "DYNASTY", color: "#22c55e" },
    { minWins: 57, grade: "B", label: "CONTENDER", color: "#3b82f6" },
    { minWins: 50, grade: "C", label: "PLAYOFF", color: "#f59e0b" },
    { minWins: 40, grade: "D", label: "LOTTERY", color: "#64748b" },
    { minWins: 0, grade: "F", label: "TANKING", color: "#ef4444" }
  ];

  function cloneRoster(roster) {
    const copy = {};
    for (const pos of ALL_POSITIONS) copy[pos] = roster?.[pos] || null;
    return copy;
  }

  function normalizePlayer(player) {
    const positions = Array.isArray(player.positions) && player.positions.length
      ? player.positions
      : [player.pos || "SF"];
    return { ...player, positions };
  }

  function normalizePlayers(players) {
    return players.map(normalizePlayer);
  }

  function safeStat(player, stat) {
    const value = player[stat];
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    return value;
  }

  function calculatePlayerRating(player, adjusted = true) {
    const exponent = adjusted ? 1.25 : 1.0;
    const baseline = ERA_BASELINES[player.era] || ERA_BASELINES["2020s"];
    let n = 0;

    if (adjusted) {
      const pos = player.positions?.[0] || player.pos || "SF";
      const weights = { ...(POSITION_WEIGHTS[pos] || POSITION_WEIGHTS.SF) };
      const missing = ["spg", "bpg"].filter((stat) => safeStat(player, stat) === null);
      if (missing.length > 0) {
        const remaining = STATS.filter((stat) => !missing.includes(stat));
        const total = remaining.reduce((sum, stat) => sum + weights[stat], 0);
        if (total > 0) {
          for (const stat of remaining) weights[stat] *= 1 / total;
        }
        for (const stat of missing) weights[stat] = 0;
      }
      for (const stat of STATS) {
        const value = safeStat(player, stat);
        if (value !== null) {
          let ratio = value / baseline[stat];
          if (ratio > 1) ratio = Math.pow(ratio, exponent);
          n += weights[stat] * ratio;
        }
      }
    } else {
      for (const stat of STATS) {
        const value = safeStat(player, stat);
        if (value !== null) n += value / baseline[stat];
      }
    }

    let rating = 60 + 40 * n;
    const numPositions = player.positions?.length || 1;
    rating += (numPositions - 1) * (adjusted ? 3 : 2);

    if (adjusted && LEGACY_PLAYERS.has((player.player || "").toLowerCase())) {
      rating += 2.5;
    }

    return Math.min(100, Math.round(rating * 10) / 10);
  }

  function calculateAdjustedSpgBpg(roster) {
    const spgVals = roster
      .filter((player) => safeStat(player, "spg") !== null && player.spg > 0)
      .map((player) => player.spg);
    const bpgVals = roster
      .filter((player) => safeStat(player, "bpg") !== null && player.bpg > 0)
      .map((player) => player.bpg);
    return {
      adjustedSpg: spgVals.reduce((a, b) => a + b, 0) * (spgVals.length > 0 ? 5 / spgVals.length : 1),
      adjustedBpg: bpgVals.reduce((a, b) => a + b, 0) * (bpgVals.length > 0 ? 5 / bpgVals.length : 1)
    };
  }

  function calculateTeamResult(roster, adjusted = true) {
    if (!roster || roster.length === 0) {
      return { teamOvr: 0, wins: 0, losses: 82, grade: "F", label: "TANKING", color: "#ef4444" };
    }

    let teamOvr;
    let wins;
    if (adjusted) {
      const ratings = roster.map((player) => calculatePlayerRating(player, true));
      const product = ratings.reduce((a, b) => a * b, 1);
      teamOvr = Math.round(1.1 * Math.pow(product, 1 / ratings.length) * 10) / 10;
      wins = Math.round(82 * Math.pow(Math.min(teamOvr / 110, 1), 2.2));
    } else {
      const totalPpg = roster.reduce((sum, player) => sum + (safeStat(player, "ppg") || 0), 0);
      const totalRpg = roster.reduce((sum, player) => sum + (safeStat(player, "rpg") || 0), 0);
      const totalApg = roster.reduce((sum, player) => sum + (safeStat(player, "apg") || 0), 0);
      const adjustedBlocks = calculateAdjustedSpgBpg(roster);
      teamOvr = Math.round(
        100 * (
          totalPpg / TEAM_PPG_BASE * TEAM_PPG_WEIGHT +
          totalRpg / TEAM_RPG_BASE * TEAM_RPG_WEIGHT +
          totalApg / TEAM_APG_BASE * TEAM_APG_WEIGHT +
          adjustedBlocks.adjustedSpg / TEAM_SPG_BASE * TEAM_SPG_WEIGHT +
          adjustedBlocks.adjustedBpg / TEAM_BPG_BASE * TEAM_BPG_WEIGHT
        ) * 10
      ) / 10;
      wins = Math.round(82 * Math.pow(Math.min(teamOvr / 110, 1), 1.15));
    }

    const losses = 82 - wins;
    const grade = GRADE_THRESHOLDS.find((candidate) => wins >= candidate.minWins) || GRADE_THRESHOLDS[GRADE_THRESHOLDS.length - 1];
    return { teamOvr, wins, losses, grade: grade.grade, label: grade.label, color: grade.color };
  }

  function findPositionAssignment(roster) {
    if (roster.length === 0) return new Map();
    const slots = ALL_POSITIONS;
    const sorted = [...roster].sort((a, b) => (a.positions?.length || 1) - (b.positions?.length || 1));
    const result = new Map();
    const used = new Set();

    function backtrack(index) {
      if (index === sorted.length) return true;
      const player = sorted[index];
      const eligible = player.positions || [player.pos];
      for (const pos of slots) {
        if (used.has(pos) || !eligible.includes(pos)) continue;
        result.set(player.id, pos);
        used.add(pos);
        if (backtrack(index + 1)) return true;
        result.delete(player.id);
        used.delete(pos);
      }
      return false;
    }

    return backtrack(0) ? result : null;
  }

  function findPositionAssignments(roster) {
    if (roster.length === 0) return [new Map()];
    const sorted = [...roster].sort((a, b) => (a.positions?.length || 1) - (b.positions?.length || 1));
    const assignments = [];
    const result = new Map();
    const used = new Set();

    function backtrack(index) {
      if (index === sorted.length) {
        assignments.push(new Map(result));
        return;
      }
      const player = sorted[index];
      const eligible = player.positions || [player.pos];
      for (const pos of ALL_POSITIONS) {
        if (used.has(pos) || !eligible.includes(pos)) continue;
        result.set(player.id, pos);
        used.add(pos);
        backtrack(index + 1);
        result.delete(player.id);
        used.delete(pos);
      }
    }

    backtrack(0);
    return assignments;
  }

  function rosterListFromIds(roster, playersById) {
    return ALL_POSITIONS.map((pos) => roster?.[pos] ? playersById.get(roster[pos]) : null).filter(Boolean);
  }

  function usedBaseSlugs(roster, playersById) {
    const used = new Set();
    for (const pos of ALL_POSITIONS) {
      const player = roster?.[pos] ? playersById.get(roster[pos]) : null;
      if (player) used.add(player.baseSlug || player.player.toLowerCase());
    }
    return used;
  }

  function openPositions(roster) {
    return ALL_POSITIONS.filter((pos) => !roster?.[pos]);
  }

  function rosterCount(roster) {
    return ALL_POSITIONS.reduce((count, pos) => count + (roster?.[pos] ? 1 : 0), 0);
  }

  function rosterAdditions(roster, player, playersById, cache = null) {
    const cacheKey = cache
      ? `${player.id}|${ALL_POSITIONS.map((pos) => roster?.[pos] || "").join("|")}`
      : "";
    if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
    const used = usedBaseSlugs(roster, playersById);
    if (used.has(player.baseSlug || player.player.toLowerCase())) {
      if (cacheKey) cache.set(cacheKey, []);
      return [];
    }
    const currentPlayers = rosterListFromIds(roster, playersById);
    const currentPositions = new Map();
    for (const pos of ALL_POSITIONS) {
      if (roster?.[pos]) currentPositions.set(roster[pos], pos);
    }

    const additions = [];
    const bestByPosition = new Map();
    for (const assignment of findPositionAssignments([...currentPlayers, player])) {
      const position = assignment.get(player.id);
      if (!position) continue;
      const nextRoster = cloneRoster(null);
      for (const assignedPlayer of [...currentPlayers, player]) {
        nextRoster[assignment.get(assignedPlayer.id)] = assignedPlayer.id;
      }
      const moves = [];
      for (const currentPlayer of currentPlayers) {
        const from = currentPositions.get(currentPlayer.id);
        const to = assignment.get(currentPlayer.id);
        if (from && to && from !== to) moves.push({ playerId: currentPlayer.id, from, to });
      }
      const current = bestByPosition.get(position);
      if (!current || moves.length < current.moves.length) {
        bestByPosition.set(position, { position, roster: nextRoster, moves });
      }
    }
    for (const pos of ALL_POSITIONS) {
      const addition = bestByPosition.get(pos);
      if (addition) additions.push(addition);
    }
    if (cacheKey) cache.set(cacheKey, additions);
    return additions;
  }

  function rosterWithAddedPlayer(roster, player, playersById) {
    return rosterAdditions(roster, player, playersById)[0]?.roster || null;
  }

  function canAddPlayerToRoster(roster, player, playersById) {
    return rosterAdditions(roster, player, playersById).length > 0;
  }

  function indexPlayers(players) {
    const normalized = normalizePlayers(players);
    const playersById = new Map();
    const playersByCombo = new Map();
    const byBaseSlug = new Map();
    const teams = new Set();
    const eras = new Set();

    for (const player of normalized) {
      playersById.set(player.id, player);
      teams.add(player.team);
      eras.add(player.era);
      const comboKey = `${player.team}|${player.era}`;
      if (!playersByCombo.has(comboKey)) playersByCombo.set(comboKey, []);
      playersByCombo.get(comboKey).push(player);
      const base = player.baseSlug || player.player.toLowerCase();
      if (!byBaseSlug.has(base)) byBaseSlug.set(base, []);
      byBaseSlug.get(base).push(player);
    }

    return {
      players: normalized,
      playersById,
      playersByCombo,
      byBaseSlug,
      teams: [...teams].sort(),
      eras: [...eras].filter((era) => LIVE_ERA_SET.has(era)).sort()
    };
  }

  function objectiveValue(roster, adjusted, goal) {
    const result = calculateTeamResult(roster, adjusted);
    return goal === "eightyTwoZero" ? (result.teamOvr >= EIGHTY_TWO_ZERO_TEAM_OVR ? 1 : 0) : result.teamOvr;
  }

  function partialTeamOvr(roster, adjusted) {
    if (!adjusted) return calculateTeamResult(roster, false).teamOvr;
    const ratings = roster.map((player) => calculatePlayerRating(player, true));
    while (ratings.length < 5) ratings.push(60);
    const product = ratings.reduce((a, b) => a * b, 1);
    return Math.round(1.1 * Math.pow(product, 1 / 5) * 10) / 10;
  }

  function partialObjectiveValue(roster, adjusted, goal) {
    const teamOvr = partialTeamOvr(roster, adjusted);
    return goal === "eightyTwoZero" ? (teamOvr >= EIGHTY_TWO_ZERO_TEAM_OVR ? 1 : 0) : teamOvr;
  }

  function playerHeuristic(player, adjusted) {
    if (adjusted) return calculatePlayerRating(player, true);
    return (
      (safeStat(player, "ppg") || 0) / TEAM_PPG_BASE * TEAM_PPG_WEIGHT +
      (safeStat(player, "rpg") || 0) / TEAM_RPG_BASE * TEAM_RPG_WEIGHT +
      (safeStat(player, "apg") || 0) / TEAM_APG_BASE * TEAM_APG_WEIGHT +
      (safeStat(player, "spg") || 0) / TEAM_SPG_BASE * TEAM_SPG_WEIGHT +
      (safeStat(player, "bpg") || 0) / TEAM_BPG_BASE * TEAM_BPG_WEIGHT
    );
  }

  function playerOverallLabel(player, adjusted) {
    if (!player) return "";
    const score = playerHeuristic(player, adjusted);
    return adjusted ? `${score.toFixed(1)} OVR` : `+${(score * 100).toFixed(1)} OVR`;
  }

  function normalizeIntegerOption(value, fallback, min) {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isInteger(number) && number >= min ? number : fallback;
  }

  function normalizeLimitOption(value) {
    if (value === null || value === undefined || value === "" || value === 0 || value === "0") return 0;
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : 0;
  }

  function nowMs() {
    return Date.now();
  }

  function hasLiveCombo(ctx, team, era) {
    return LIVE_ERA_SET.has(era) && (ctx.playersByCombo.get(`${team}|${era}`) || []).length > 0;
  }

  function liveTeamsForEra(ctx, era) {
    return ctx.teams.filter((team) => hasLiveCombo(ctx, team, era));
  }

  function liveErasForTeam(ctx, team) {
    return LIVE_ERAS.filter((era) => hasLiveCombo(ctx, team, era));
  }

  function buildPickActions(state, ctx, options, additionCache = null) {
    const adjusted = options.objective !== "standard";
    const pool = ctx.playersByCombo.get(`${state.currentTeam}|${state.currentEra}`) || [];
    let candidates = [];
    for (const player of pool) {
      for (const addition of rosterAdditions(state.roster, player, ctx.playersById, additionCache)) {
        candidates.push({ player, position: addition.position, roster: addition.roster, moves: addition.moves });
      }
    }

    let candidateTruncated = false;
    candidates.sort((a, b) => playerHeuristic(b.player, adjusted) - playerHeuristic(a.player, adjusted));
    if (options.candidateLimit > 0 && candidates.length > options.candidateLimit) {
      candidateTruncated = true;
      candidates = candidates.slice(0, options.candidateLimit);
    }

    const actions = [];
    for (const candidate of candidates) {
      actions.push({
        type: "pick",
        playerId: candidate.player.id,
        position: candidate.position,
        roster: candidate.roster,
        moves: candidate.moves || []
      });
    }
    return { actions, candidateTruncated };
  }

  function actionLabel(action, ctx, adjusted) {
    if (!action) return "none";
    if (action.type === "teamSwitch") return "use team switch";
    if (action.type === "eraSwitch") return "use era switch";
    const player = ctx.playersById.get(action.playerId);
    const suffix = playerOverallLabel(player, adjusted);
    const moves = (action.moves || []).map((move) => {
      const moved = ctx.playersById.get(move.playerId);
      return `${moved?.player || move.playerId} ${move.to}`;
    });
    const details = [suffix, moves.length ? `move ${moves.join(", ")}` : ""].filter(Boolean).join("; ");
    return `pick ${player?.player || action.playerId} at ${action.position}${details ? ` (${details})` : ""}`;
  }

  function solveExpectimax(inputState, players, rawOptions = {}) {
    const ctx = indexPlayers(players);
    const options = {
      objective: rawOptions.objective === "standard" ? "standard" : "adjusted",
      candidateLimit: normalizeIntegerOption(rawOptions.candidateLimit, 0, 0),
      maxStates: normalizeLimitOption(rawOptions.maxStates),
      timeLimitMs: normalizeLimitOption(rawOptions.timeLimitMs),
      threshold: EIGHTY_TWO_ZERO_TEAM_OVR
    };
    const adjusted = options.objective !== "standard";
    const onProgress = typeof rawOptions.onProgress === "function" ? rawOptions.onProgress : null;
    const startedAt = nowMs();
    const deadline = options.timeLimitMs > 0 ? startedAt + options.timeLimitMs : Infinity;
    const additionCache = new Map();

    const rollCombos = [];
    for (const team of ctx.teams) {
      for (const era of LIVE_ERAS) {
        if (hasLiveCombo(ctx, team, era)) rollCombos.push([team, era]);
      }
    }
    if (rollCombos.length === 0) throw new Error("No valid live team/era combos are available.");

    const roughPlayersByCombo = new Map();
    for (const [team, era] of rollCombos) {
      const key = `${team}|${era}`;
      roughPlayersByCombo.set(key, (ctx.playersByCombo.get(key) || [])
        .slice()
        .sort((a, b) => playerHeuristic(b, adjusted) - playerHeuristic(a, adjusted))
        .slice(0, ROUGH_COMBO_PLAYER_LIMIT));
    }

    function normalizeState(state) {
      return {
        roster: cloneRoster(state.roster),
        currentTeam: state.currentTeam || "",
        currentEra: state.currentEra || "",
        teamSwitchUsed: !!state.teamSwitchUsed,
        eraSwitchUsed: !!state.eraSwitchUsed
      };
    }

    function validateState(state) {
      if (!hasLiveCombo(ctx, state.currentTeam, state.currentEra)) {
        throw new Error("Select a valid live team/era combo before solving EV.");
      }
    }

    function keyFor(state) {
      const ids = ALL_POSITIONS.map((pos) => `${pos}:${state.roster[pos] || ""}`).join(",");
      return `${ids}|${state.currentTeam}|${state.currentEra}|${state.teamSwitchUsed ? 1 : 0}|${state.eraSwitchUsed ? 1 : 0}`;
    }

    const start = normalizeState(inputState);
    validateState(start);
    const startKey = keyFor(start);

    function buildActionsForState(state, actionOptions = options) {
      const pickActions = buildPickActions(state, ctx, actionOptions, additionCache);
      const actions = pickActions.actions;
      if (!state.teamSwitchUsed && liveTeamsForEra(ctx, state.currentEra).length > 0) {
        actions.push({ type: "teamSwitch" });
      }
      if (!state.eraSwitchUsed && liveErasForTeam(ctx, state.currentTeam).length > 0) {
        actions.push({ type: "eraSwitch" });
      }
      return { actions, candidateTruncated: pickActions.candidateTruncated };
    }

    function rosterAfterPick(state, action) {
      if (action.roster) return cloneRoster(action.roster);
      const roster = cloneRoster(state.roster);
      roster[action.position] = action.playerId;
      return roster;
    }

    function projectedTeamOvr(rosterIds) {
      const roster = rosterListFromIds(rosterIds, ctx.playersById);
      if (roster.length === 0) return 0;
      const open = openPositions(rosterIds).length;
      if (!adjusted) {
        return calculateTeamResult(roster, false).teamOvr + open * 20;
      }
      const ratings = roster.map((player) => calculatePlayerRating(player, true));
      while (ratings.length < ALL_POSITIONS.length) ratings.push(80);
      const product = ratings.reduce((a, b) => a * b, 1);
      return Math.round(1.1 * Math.pow(product, 1 / ratings.length) * 10) / 10;
    }

    function heuristicRosterValue(rosterIds, goal) {
      const roster = rosterListFromIds(rosterIds, ctx.playersById);
      if (openPositions(rosterIds).length === 0) return objectiveValue(roster, adjusted, goal);
      const teamOvr = projectedTeamOvr(rosterIds);
      return goal === "eightyTwoZero" ? (teamOvr >= EIGHTY_TWO_ZERO_TEAM_OVR ? 1 : 0) : teamOvr;
    }

    const roughRollMemo = new Map();
    const roughAfterPickMemo = new Map();

    function roughBestPick(state) {
      const pool = roughPlayersByCombo.get(`${state.currentTeam}|${state.currentEra}`) || [];
      const actions = [];
      for (const player of pool) {
        for (const addition of rosterAdditions(state.roster, player, ctx.playersById, additionCache)) {
          actions.push({
            type: "pick",
            playerId: player.id,
            position: addition.position,
            roster: addition.roster,
            moves: addition.moves || []
          });
        }
      }
      let bestAction = null;
      let bestValue = -Infinity;
      for (const action of actions) {
        const value = projectedTeamOvr(rosterAfterPick(state, action));
        if (value > bestValue) {
          bestValue = value;
          bestAction = action;
        }
      }
      return bestAction;
    }

    function roughRollCombo(sampleIndex, step) {
      return rollCombos[(sampleIndex * 37 + step * 17) % rollCombos.length];
    }

    function roughTailChanceAfterPick(rawState) {
      if (openPositions(rawState.roster).length === 0) {
        return objectiveValue(rosterListFromIds(rawState.roster, ctx.playersById), adjusted, "eightyTwoZero");
      }
      let hits = 0;
      for (let sample = 0; sample < ROUGH_TAIL_ROLLOUTS; sample += 1) {
        const state = normalizeState(rawState);
        let step = 0;
        while (openPositions(state.roster).length > 0 && step < ALL_POSITIONS.length) {
          const [team, era] = roughRollCombo(sample, step);
          state.currentTeam = team;
          state.currentEra = era;
          const pick = roughBestPick(state);
          if (!pick) break;
          state.roster = rosterAfterPick(state, pick);
          step += 1;
        }
        if (openPositions(state.roster).length === 0) {
          hits += objectiveValue(rosterListFromIds(state.roster, ctx.playersById), adjusted, "eightyTwoZero");
        }
      }
      return hits / ROUGH_TAIL_ROLLOUTS;
    }

    function roughChanceForRollState(rawState) {
      const state = normalizeState(rawState);
      const key = keyFor(state);
      if (roughRollMemo.has(key)) return roughRollMemo.get(key);
      const pick = roughBestPick(state);
      const value = pick
        ? roughTailChanceAfterPick({ ...state, roster: rosterAfterPick(state, pick) })
        : 0;
      roughRollMemo.set(key, value);
      return value;
    }

    function roughChanceAfterPick(rawState) {
      const state = normalizeState(rawState);
      if (openPositions(state.roster).length === 0) {
        return objectiveValue(rosterListFromIds(state.roster, ctx.playersById), adjusted, "eightyTwoZero");
      }
      const key = ALL_POSITIONS.map((pos) => `${pos}:${state.roster[pos] || ""}`).join(",");
      if (roughAfterPickMemo.has(key)) return roughAfterPickMemo.get(key);
      let total = 0;
      for (const [team, era] of rollCombos) {
        total += roughChanceForRollState({ ...state, currentTeam: team, currentEra: era });
      }
      const value = total / rollCombos.length;
      roughAfterPickMemo.set(key, value);
      return value;
    }

    function bestImmediatePickValue(state, goal) {
      const actions = buildPickActions(state, ctx, options).actions;
      if (actions.length === 0) return heuristicRosterValue(state.roster, goal);
      let best = -Infinity;
      for (const action of actions) {
        best = Math.max(best, heuristicRosterValue(rosterAfterPick(state, action), goal));
      }
      return best;
    }

    function heuristicActionValue(state, action, goal) {
      if (goal === "eightyTwoZero") {
        if (action.type === "pick") {
          const roster = rosterAfterPick(state, action);
          return roughChanceAfterPick({ ...state, roster });
        }
        let total = 0;
        let count = 0;
        if (action.type === "teamSwitch") {
          for (const team of liveTeamsForEra(ctx, state.currentEra)) {
            total += roughChanceForRollState({ ...state, currentTeam: team, teamSwitchUsed: true });
            count += 1;
          }
        } else if (action.type === "eraSwitch") {
          for (const era of liveErasForTeam(ctx, state.currentTeam)) {
            total += roughChanceForRollState({ ...state, currentEra: era, eraSwitchUsed: true });
            count += 1;
          }
        }
        return count > 0 ? total / count : roughChanceForRollState(state);
      }
      if (action.type === "pick") return heuristicRosterValue(rosterAfterPick(state, action), goal);
      let total = 0;
      let count = 0;
      if (action.type === "teamSwitch") {
        for (const team of liveTeamsForEra(ctx, state.currentEra)) {
          total += bestImmediatePickValue({ ...state, currentTeam: team, teamSwitchUsed: true }, goal);
          count += 1;
        }
      } else if (action.type === "eraSwitch") {
        for (const era of liveErasForTeam(ctx, state.currentTeam)) {
          total += bestImmediatePickValue({ ...state, currentEra: era, eraSwitchUsed: true }, goal);
          count += 1;
        }
      }
      return count > 0 ? total / count : heuristicRosterValue(state.roster, goal);
    }

    function roughMeta(rootActions) {
      return {
        rootActions,
        comboPlayerLimit: ROUGH_COMBO_PLAYER_LIMIT,
        tailRollouts: ROUGH_TAIL_ROLLOUTS
      };
    }

    const greedyComboMemo = new Map();
    const greedyStaticMemo = new Map();
    let greedyStatesVisited = 0;

    function rosterMemoKey(roster) {
      return ALL_POSITIONS.map((pos) => `${pos}:${roster?.[pos] || ""}`).join(",");
    }

    function bestGreedyPickForCombo(roster, comboKey) {
      const pool = ctx.playersByCombo.get(comboKey) || [];
      let best = null;
      let bestValue = -Infinity;
      for (const player of pool) {
        for (const addition of rosterAdditions(roster, player, ctx.playersById, additionCache)) {
          const value = projectedTeamOvr(addition.roster);
          if (value > bestValue) {
            bestValue = value;
            best = {
              type: "pick",
              playerId: player.id,
              position: addition.position,
              roster: addition.roster,
              moves: addition.moves || []
            };
          }
        }
      }
      return best;
    }

    function greedyComboCompletionValue(roster, comboKey, goal) {
      const key = `${goal}|${comboKey}|${rosterMemoKey(roster)}`;
      if (greedyComboMemo.has(key)) return greedyComboMemo.get(key);
      greedyStatesVisited += 1;
      let completed = cloneRoster(roster);
      while (openPositions(completed).length > 0) {
        const pick = bestGreedyPickForCombo(completed, comboKey);
        if (!pick) break;
        completed = rosterAfterPick({ roster: completed }, pick);
      }
      const list = rosterListFromIds(completed, ctx.playersById);
      const value = openPositions(completed).length === 0
        ? objectiveValue(list, adjusted, goal)
        : partialObjectiveValue(list, adjusted, goal);
      greedyComboMemo.set(key, value);
      return value;
    }

    function average(values) {
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    }

    function greedyRollTailValue(roster, team, era, teamSwitchUsed, eraSwitchUsed, goal) {
      const values = [greedyComboCompletionValue(roster, `${team}|${era}`, goal)];
      if (!teamSwitchUsed) {
        values.push(average(liveTeamsForEra(ctx, era).map((nextTeam) =>
          greedyComboCompletionValue(roster, `${nextTeam}|${era}`, goal)
        )));
      }
      if (!eraSwitchUsed) {
        values.push(average(liveErasForTeam(ctx, team).map((nextEra) =>
          greedyComboCompletionValue(roster, `${team}|${nextEra}`, goal)
        )));
      }
      return Math.max(...values);
    }

    function greedyFutureValue(roster, teamSwitchUsed, eraSwitchUsed, goal) {
      const key = `${goal}|${teamSwitchUsed ? 1 : 0}|${eraSwitchUsed ? 1 : 0}|${rosterMemoKey(roster)}`;
      if (greedyStaticMemo.has(key)) return greedyStaticMemo.get(key);
      const value = average(rollCombos.map(([team, era]) =>
        greedyRollTailValue(roster, team, era, teamSwitchUsed, eraSwitchUsed, goal)
      ));
      greedyStaticMemo.set(key, value);
      return value;
    }

    function greedyActionValue(state, action, goal) {
      if (action.type === "pick") {
        const roster = rosterAfterPick(state, action);
        if (openPositions(roster).length === 0) {
          return objectiveValue(rosterListFromIds(roster, ctx.playersById), adjusted, goal);
        }
        return greedyFutureValue(roster, state.teamSwitchUsed, state.eraSwitchUsed, goal);
      }
      if (action.type === "teamSwitch") {
        return average(liveTeamsForEra(ctx, state.currentEra).map((team) =>
          greedyRollTailValue(state.roster, team, state.currentEra, true, state.eraSwitchUsed, goal)
        ));
      }
      if (action.type === "eraSwitch") {
        return average(liveErasForTeam(ctx, state.currentTeam).map((era) =>
          greedyRollTailValue(state.roster, state.currentTeam, era, state.teamSwitchUsed, true, goal)
        ));
      }
      return partialObjectiveValue(rosterListFromIds(state.roster, ctx.playersById), adjusted, goal);
    }

    function emitProgress(goal, scored, details) {
      if (!onProgress || scored.length === 0) return;
      const topActions = scored.slice().sort((a, b) => b.value - a.value).slice(0, 10);
      onProgress({
        goal,
        value: topActions[0].value,
        bestAction: topActions[0].action,
        bestActionLabel: topActions[0].label,
        topActions,
        statesVisited: details.statesVisited || 0,
        memoSize: details.memoSize || 0,
        truncated: !!details.truncated,
        stateLimited: !!details.stateLimited,
        timedOut: !!details.timedOut,
        candidateTruncated: !!details.candidateTruncated,
        approximate: details.approximate !== false,
        heuristic: !!details.heuristic,
        greedy: !!details.greedy,
        rough: details.rough || null,
        stuck: !!details.stuck,
        stuckStates: details.stuckStates || 0
      });
    }

    function heuristicScoredActions(state, actions, goal) {
      return actions.map((action) => ({
        action,
        value: heuristicActionValue(state, action, goal),
        label: actionLabel(action, ctx, adjusted)
      }));
    }

    function emitHeuristicRootProgress(goal) {
      if (!onProgress) return;
      const built = buildActionsForState(start);
      emitProgress(goal, heuristicScoredActions(start, built.actions, goal), {
        candidateTruncated: built.candidateTruncated,
        heuristic: true,
        rough: goal === "eightyTwoZero" ? roughMeta(built.actions.length) : null
      });
    }

    function solveGreedyGoal(goal) {
      const state = normalizeState(start);
      const beforeStates = greedyStatesVisited;
      const built = buildActionsForState(state, { ...options, candidateLimit: GREEDY_ROOT_ACTION_LIMIT });
      const scored = built.actions.map((action) => ({
        action,
        value: greedyActionValue(state, action, goal),
        label: actionLabel(action, ctx, adjusted)
      })).sort((a, b) => b.value - a.value);
      const topActions = scored.slice(0, 10);
      if (onProgress && topActions.length) {
        emitProgress(goal, topActions, {
          statesVisited: greedyStatesVisited - beforeStates,
          memoSize: greedyComboMemo.size + greedyStaticMemo.size,
          approximate: true,
          greedy: true,
          candidateTruncated: built.candidateTruncated
        });
      }
      const best = topActions[0] || null;
      return {
        goal,
        value: best ? best.value : partialObjectiveValue(rosterListFromIds(state.roster, ctx.playersById), adjusted, goal),
        bestAction: best?.action || null,
        bestActionLabel: best ? best.label : "none",
        topActions,
        statesVisited: greedyStatesVisited - beforeStates,
        memoSize: greedyComboMemo.size + greedyStaticMemo.size,
        truncated: false,
        stateLimited: false,
        timedOut: false,
        candidateTruncated: built.candidateTruncated,
        approximate: true,
        heuristic: false,
        greedy: true,
        stuck: topActions.length === 0,
        stuckStates: topActions.length === 0 ? 1 : 0
      };
    }

    function solveLateExactGoal(goal) {
      const oneOpenMemo = new Map();
      const expectedOneOpenMemo = new Map();
      const twoOpenMemo = new Map();
      const statMemo = new Map();
      let statesVisited = 0;
      let stuckStates = 0;

      function statSummary(roster) {
        const key = rosterMemoKey(roster);
        if (statMemo.has(key)) return statMemo.get(key);
        const summary = { ppg: 0, rpg: 0, apg: 0, spg: 0, spgCount: 0, bpg: 0, bpgCount: 0 };
        for (const player of rosterListFromIds(roster, ctx.playersById)) {
          summary.ppg += safeStat(player, "ppg") || 0;
          summary.rpg += safeStat(player, "rpg") || 0;
          summary.apg += safeStat(player, "apg") || 0;
          const spg = safeStat(player, "spg");
          if (spg !== null && spg > 0) {
            summary.spg += spg;
            summary.spgCount += 1;
          }
          const bpg = safeStat(player, "bpg");
          if (bpg !== null && bpg > 0) {
            summary.bpg += bpg;
            summary.bpgCount += 1;
          }
        }
        statMemo.set(key, summary);
        return summary;
      }

      function standardObjectiveWithPlayer(summary, player) {
        const spg = safeStat(player, "spg");
        const bpg = safeStat(player, "bpg");
        const spgTotal = summary.spg + (spg !== null && spg > 0 ? spg : 0);
        const bpgTotal = summary.bpg + (bpg !== null && bpg > 0 ? bpg : 0);
        const spgCount = summary.spgCount + (spg !== null && spg > 0 ? 1 : 0);
        const bpgCount = summary.bpgCount + (bpg !== null && bpg > 0 ? 1 : 0);
        const adjustedSpg = spgCount > 0 ? spgTotal * 5 / spgCount : 0;
        const adjustedBpg = bpgCount > 0 ? bpgTotal * 5 / bpgCount : 0;
        const teamOvr = Math.round(
          100 * (
            (summary.ppg + (safeStat(player, "ppg") || 0)) / TEAM_PPG_BASE * TEAM_PPG_WEIGHT +
            (summary.rpg + (safeStat(player, "rpg") || 0)) / TEAM_RPG_BASE * TEAM_RPG_WEIGHT +
            (summary.apg + (safeStat(player, "apg") || 0)) / TEAM_APG_BASE * TEAM_APG_WEIGHT +
            adjustedSpg / TEAM_SPG_BASE * TEAM_SPG_WEIGHT +
            adjustedBpg / TEAM_BPG_BASE * TEAM_BPG_WEIGHT
          ) * 10
        ) / 10;
        return goal === "eightyTwoZero" ? (teamOvr >= EIGHTY_TWO_ZERO_TEAM_OVR ? 1 : 0) : teamOvr;
      }

      function terminalPickValue(roster, team, era) {
        let best = -Infinity;
        const baseStats = statSummary(roster);
        const open = openPositions(roster);
        if (open.length !== 1) return null;
        const pool = ctx.playersByCombo.get(`${team}|${era}`) || [];
        for (const player of pool) {
          if (rosterAdditions(roster, player, ctx.playersById, additionCache).length === 0) continue;
          const value = standardObjectiveWithPlayer(baseStats, player);
          if (value > best) best = value;
        }
        return best > -Infinity ? best : null;
      }

      function oneOpenValue(roster, team, era, teamSwitchUsed, eraSwitchUsed) {
        if (openPositions(roster).length === 0) {
          return objectiveValue(rosterListFromIds(roster, ctx.playersById), adjusted, goal);
        }
        const key = `${goal}|${team}|${era}|${teamSwitchUsed ? 1 : 0}|${eraSwitchUsed ? 1 : 0}|${rosterMemoKey(roster)}`;
        if (oneOpenMemo.has(key)) return oneOpenMemo.get(key);
        statesVisited += 1;
        const values = [];
        const terminal = terminalPickValue(roster, team, era);
        if (terminal !== null) values.push(terminal);
        if (!teamSwitchUsed) {
          values.push(average(liveTeamsForEra(ctx, era).map((nextTeam) =>
            oneOpenValue(roster, nextTeam, era, true, eraSwitchUsed)
          )));
        }
        if (!eraSwitchUsed) {
          values.push(average(liveErasForTeam(ctx, team).map((nextEra) =>
            oneOpenValue(roster, team, nextEra, teamSwitchUsed, true)
          )));
        }
        if (values.length === 0) {
          stuckStates += 1;
          const stuck = goal === "eightyTwoZero" ? 0 : -Infinity;
          oneOpenMemo.set(key, stuck);
          return stuck;
        }
        const best = Math.max(...values);
        oneOpenMemo.set(key, best);
        return best;
      }

      function oneOpenActionValue(state, action) {
        if (action.type === "pick") {
          return objectiveValue(rosterListFromIds(rosterAfterPick(state, action), ctx.playersById), adjusted, goal);
        }
        if (action.type === "teamSwitch") {
          return average(liveTeamsForEra(ctx, state.currentEra).map((team) =>
            oneOpenValue(state.roster, team, state.currentEra, true, state.eraSwitchUsed)
          ));
        }
        if (action.type === "eraSwitch") {
          return average(liveErasForTeam(ctx, state.currentTeam).map((era) =>
            oneOpenValue(state.roster, state.currentTeam, era, state.teamSwitchUsed, true)
          ));
        }
        return partialObjectiveValue(rosterListFromIds(state.roster, ctx.playersById), adjusted, goal);
      }

      function expectedOneOpenAfterRoll(roster, teamSwitchUsed, eraSwitchUsed) {
        const key = `${goal}|${teamSwitchUsed ? 1 : 0}|${eraSwitchUsed ? 1 : 0}|${rosterMemoKey(roster)}`;
        if (expectedOneOpenMemo.has(key)) return expectedOneOpenMemo.get(key);
        const value = average(rollCombos.map(([team, era]) =>
          oneOpenValue(roster, team, era, teamSwitchUsed, eraSwitchUsed)
        ));
        expectedOneOpenMemo.set(key, value);
        return value;
      }

      function twoOpenValue(rawState) {
        const state = normalizeState(rawState);
        const key = keyFor(state);
        if (twoOpenMemo.has(key)) return twoOpenMemo.get(key);
        statesVisited += 1;
        const actions = buildActionsForState(state).actions;
        if (actions.length === 0) {
          stuckStates += 1;
          const fallback = partialObjectiveValue(rosterListFromIds(state.roster, ctx.playersById), adjusted, goal);
          twoOpenMemo.set(key, fallback);
          return fallback;
        }
        let best = -Infinity;
        for (const action of actions) best = Math.max(best, twoOpenActionValue(state, action));
        twoOpenMemo.set(key, best);
        return best;
      }

      function twoOpenActionValue(state, action) {
        if (action.type === "pick") {
          const roster = rosterAfterPick(state, action);
          return expectedOneOpenAfterRoll(roster, state.teamSwitchUsed, state.eraSwitchUsed);
        }
        if (action.type === "teamSwitch") {
          return average(liveTeamsForEra(ctx, state.currentEra).map((team) =>
            twoOpenValue({ ...state, currentTeam: team, teamSwitchUsed: true })
          ));
        }
        if (action.type === "eraSwitch") {
          return average(liveErasForTeam(ctx, state.currentTeam).map((era) =>
            twoOpenValue({ ...state, currentEra: era, eraSwitchUsed: true })
          ));
        }
        return partialObjectiveValue(rosterListFromIds(state.roster, ctx.playersById), adjusted, goal);
      }

      const state = normalizeState(start);
      const actions = buildActionsForState(state).actions;
      const open = openPositions(state.roster).length;
      const actionValue = open <= 1 ? oneOpenActionValue : twoOpenActionValue;
      const scored = [];
      let lastProgressMs = startedAt;
      for (const action of actions) {
        scored.push({
          action,
          value: actionValue(state, action),
          label: actionLabel(action, ctx, adjusted)
        });
        if (onProgress && nowMs() - lastProgressMs >= STATE_PROGRESS_INTERVAL_MS) {
          lastProgressMs = nowMs();
          emitProgress(goal, scored, {
            statesVisited,
            memoSize: oneOpenMemo.size + expectedOneOpenMemo.size + twoOpenMemo.size,
            approximate: true
          });
        }
      }
      scored.sort((a, b) => b.value - a.value);
      const topActions = scored.slice(0, 10);
      if (onProgress && topActions.length) {
        emitProgress(goal, topActions, {
          statesVisited,
          memoSize: oneOpenMemo.size + expectedOneOpenMemo.size + twoOpenMemo.size,
          approximate: false
        });
      }
      const best = topActions[0] || null;
      const impossible = best && best.value === -Infinity;
      return {
        goal,
        value: best && !impossible ? best.value : partialObjectiveValue(rosterListFromIds(state.roster, ctx.playersById), adjusted, goal),
        bestAction: best && !impossible ? best.action : null,
        bestActionLabel: best && !impossible ? best.label : "no legal complete roster path",
        topActions,
        statesVisited,
        memoSize: oneOpenMemo.size + expectedOneOpenMemo.size + twoOpenMemo.size,
        truncated: false,
        stateLimited: false,
        timedOut: false,
        candidateTruncated: false,
        approximate: impossible || topActions.length === 0,
        heuristic: false,
        greedy: false,
        stuck: impossible || topActions.length === 0,
        stuckStates
      };
    }

    function solveGoal(goal, goalDeadline) {
      const memo = new Map();
      let statesVisited = 0;
      let truncated = false;
      let stateLimited = false;
      let timedOut = false;
      let candidateTruncated = false;
      let stuckStates = 0;
      let budgetExhausted = false;
      let lastProgressScored = null;
      let lastProgressHeuristic = false;
      let lastProgressMs = startedAt;

      function stop(reason) {
        truncated = true;
        budgetExhausted = true;
        if (reason === "states") stateLimited = true;
        if (reason === "time") timedOut = true;
      }

      function timeExpired() {
        if (goalDeadline === Infinity) return false;
        if (nowMs() < goalDeadline) return false;
        stop("time");
        return true;
      }

      function shouldStop() {
        return budgetExhausted || timeExpired();
      }

      function fallback(state, key, reason) {
        stop(reason || (nowMs() >= goalDeadline ? "time" : "states"));
        const fallbackRoster = rosterListFromIds(state.roster, ctx.playersById);
        const result = { value: partialObjectiveValue(fallbackRoster, adjusted, goal), action: null, topActions: [] };
        if (key) memo.set(key, result);
        return result;
      }

      function expectedAfterRoll(baseState) {
        if (openPositions(baseState.roster).length === 0) return value(baseState).value;
        let total = 0;
        let count = 0;
        for (const [team, era] of rollCombos) {
          if (shouldStop()) break;
          total += value({ ...baseState, currentTeam: team, currentEra: era }).value;
          count += 1;
        }
        return count > 0 ? total / count : fallback(baseState, null, timedOut ? "time" : "states").value;
      }

      function emitRootProgress(goal, scored, approximate, heuristic = false) {
        lastProgressScored = scored;
        lastProgressHeuristic = heuristic;
        lastProgressMs = nowMs();
        emitProgress(goal, scored, {
          statesVisited,
          memoSize: memo.size,
          truncated,
          stateLimited,
          timedOut,
          candidateTruncated,
          approximate,
          heuristic,
          stuckStates
        });
      }

      function emitStateProgress() {
        if (!onProgress || !lastProgressScored) return;
        const currentMs = nowMs();
        if (currentMs - lastProgressMs < STATE_PROGRESS_INTERVAL_MS) return;
        lastProgressMs = currentMs;
        emitProgress(goal, lastProgressScored, {
          statesVisited,
          memoSize: memo.size,
          truncated,
          stateLimited,
          timedOut,
          candidateTruncated,
          approximate: true,
          heuristic: lastProgressHeuristic,
          stuckStates
        });
      }

      function value(rawState) {
        const state = normalizeState(rawState);
        const key = keyFor(state);
        const cached = memo.get(key);
        if (cached) return cached;

        if (shouldStop()) return fallback(state, key, timedOut ? "time" : "states");
        if (options.maxStates > 0 && statesVisited >= options.maxStates) return fallback(state, key, "states");
        statesVisited += 1;
        emitStateProgress();

        const roster = rosterListFromIds(state.roster, ctx.playersById);
        if (openPositions(state.roster).length === 0) {
          const terminal = { value: objectiveValue(roster, adjusted, goal), action: null, topActions: [] };
          memo.set(key, terminal);
          return terminal;
        }

        const built = buildActionsForState(state);
        if (built.candidateTruncated) candidateTruncated = true;
        const actions = built.actions;

        if (actions.length === 0) {
          stuckStates += 1;
          const stuck = { value: 0, action: null, topActions: [], stuck: true };
          memo.set(key, stuck);
          return stuck;
        }

        const scored = [];
        for (const action of actions) {
          if (shouldStop()) break;
          let actionValue = 0;
          if (action.type === "pick") {
            const nextRoster = rosterAfterPick(state, action);
            const baseState = { ...state, roster: nextRoster };
            actionValue = openPositions(nextRoster).length === 0
              ? value(baseState).value
              : expectedAfterRoll(baseState);
          } else if (action.type === "teamSwitch") {
            let total = 0;
            const teams = liveTeamsForEra(ctx, state.currentEra);
            let count = 0;
            for (const team of teams) {
              if (shouldStop()) break;
              total += value({ ...state, currentTeam: team, teamSwitchUsed: true }).value;
              count += 1;
            }
            actionValue = count > 0 ? total / count : fallback(state, null, timedOut ? "time" : "states").value;
          } else if (action.type === "eraSwitch") {
            let total = 0;
            const eras = liveErasForTeam(ctx, state.currentTeam);
            let count = 0;
            for (const era of eras) {
              if (shouldStop()) break;
              total += value({ ...state, currentEra: era, eraSwitchUsed: true }).value;
              count += 1;
            }
            actionValue = count > 0 ? total / count : fallback(state, null, timedOut ? "time" : "states").value;
          }
          scored.push({ action, value: actionValue, label: actionLabel(action, ctx, adjusted) });
          if (onProgress && key === startKey) {
            const topActions = scored.slice().sort((a, b) => b.value - a.value).slice(0, 10);
            if (topActions[0] === scored[scored.length - 1]) {
              emitRootProgress(goal, topActions, true);
            }
          }
        }

        if (scored.length === 0) return fallback(state, key, timedOut ? "time" : "states");

        scored.sort((a, b) => b.value - a.value);
        const result = {
          value: scored[0].value,
          action: scored[0].action,
          topActions: scored.slice(0, 10)
        };
        memo.set(key, result);
        return result;
      }

      const solved = value(start);
      return {
        goal,
        value: solved.value,
        bestAction: solved.action,
        bestActionLabel: actionLabel(solved.action, ctx, adjusted),
        topActions: solved.topActions,
        statesVisited,
        memoSize: memo.size,
        truncated,
        stateLimited,
        timedOut,
        candidateTruncated,
        approximate: truncated || timedOut || candidateTruncated,
        stuck: !!solved.stuck,
        stuckStates
      };
    }

    const firstGoalDeadline = options.timeLimitMs > 0
      ? Math.min(deadline, startedAt + Math.floor(options.timeLimitMs / 2))
      : Infinity;

    let goals;
    const filled = rosterCount(start.roster);
    if (!adjusted && filled <= 2) {
      goals = {
        eightyTwoZero: solveGreedyGoal("eightyTwoZero"),
        maxScore: solveGreedyGoal("maxScore")
      };
    } else if (!adjusted) {
      goals = {
        eightyTwoZero: solveLateExactGoal("eightyTwoZero"),
        maxScore: solveLateExactGoal("maxScore")
      };
    } else {
      if (adjusted) {
        emitHeuristicRootProgress("maxScore");
        emitHeuristicRootProgress("eightyTwoZero");
      }
      goals = {
        eightyTwoZero: solveGoal("eightyTwoZero", firstGoalDeadline),
        maxScore: solveGoal("maxScore", deadline)
      };
    }
    const elapsedMs = nowMs() - startedAt;
    const currentRoster = rosterListFromIds(start.roster, ctx.playersById);
    const currentAdjusted = calculateTeamResult(currentRoster, true);
    const currentStandard = calculateTeamResult(currentRoster, false);

    return {
      value: goals.maxScore.value,
      bestAction: goals.maxScore.bestAction,
      bestActionLabel: goals.maxScore.bestActionLabel,
      topActions: goals.maxScore.topActions,
      goals,
      currentAdjusted,
      currentStandard,
      elapsedMs,
      statesVisited: goals.maxScore.statesVisited,
      memoSize: goals.maxScore.memoSize,
      truncated: goals.maxScore.truncated,
      stateLimited: goals.maxScore.stateLimited,
      timedOut: goals.maxScore.timedOut,
      candidateTruncated: goals.maxScore.candidateTruncated,
      approximate: goals.maxScore.approximate,
      stuck: goals.maxScore.stuck,
      stuckStates: goals.maxScore.stuckStates,
      options
    };
  }

  function findBestAdjustedLineup(players) {
    const ctx = indexPlayers(players);
    const dp = Array.from({ length: 32 }, () => null);
    dp[0] = { score: 0, ids: [] };

    for (const versions of ctx.byBaseSlug.values()) {
      const next = dp.map((entry) => entry ? { score: entry.score, ids: entry.ids.slice() } : null);
      for (let mask = 0; mask < 32; mask += 1) {
        const entry = dp[mask];
        if (!entry) continue;
        for (const player of versions) {
          const eligible = player.positions || [player.pos];
          for (let posIndex = 0; posIndex < ALL_POSITIONS.length; posIndex += 1) {
            const bit = 1 << posIndex;
            const pos = ALL_POSITIONS[posIndex];
            if ((mask & bit) || !eligible.includes(pos)) continue;
            const newMask = mask | bit;
            const rating = calculatePlayerRating(player, true);
            const score = entry.score + Math.log(Math.max(rating, 0.0001));
            if (!next[newMask] || score > next[newMask].score) {
              const ids = entry.ids.slice();
              ids[posIndex] = player.id;
              next[newMask] = { score, ids };
            }
          }
        }
      }
      for (let i = 0; i < dp.length; i += 1) dp[i] = next[i];
    }

    const best = dp[31];
    const roster = best.ids.map((id) => ctx.playersById.get(id));
    return {
      roster: ALL_POSITIONS.map((position, index) => ({ position, player: roster[index] })),
      adjusted: calculateTeamResult(roster, true),
      standard: calculateTeamResult(roster, false)
    };
  }

  function findPlayer(players, name, team, era) {
    const cleanName = (name || "").toLowerCase().replace(/\s+/g, " ").trim();
    const cleanTeam = (team || "").trim();
    const cleanEra = (era || "").trim();
    return players.find((player) =>
      player.player.toLowerCase() === cleanName &&
      (!cleanTeam || player.team === cleanTeam) &&
      (!cleanEra || player.era === cleanEra)
    ) || null;
  }

  root.EightyTwoZeroSolverCore = {
    ALL_POSITIONS,
    EIGHTY_TWO_ZERO_TEAM_OVR,
    ERA_BASELINES,
    POSITION_WEIGHTS,
    LEGACY_PLAYERS,
    normalizePlayers,
    safeStat,
    calculatePlayerRating,
    calculateTeamResult,
    playerHeuristic,
    findPositionAssignment,
    indexPlayers,
    rosterWithAddedPlayer,
    canAddPlayerToRoster,
    solveExpectimax,
    findBestAdjustedLineup,
    findPlayer
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
