importScripts("solver-core.js");

let players = null;

self.onmessage = async (event) => {
  const message = event.data || {};
  try {
    if (message.type === "INIT") {
      players = EightyTwoZeroSolverCore.normalizePlayers(message.players || []);
      self.postMessage({ type: "INIT_DONE", count: players.length });
      return;
    }

    if (!players) throw new Error("Worker has no player data yet.");

    if (message.type === "SOLVE_EV") {
      const result = EightyTwoZeroSolverCore.solveExpectimax(
        message.state,
        players,
        {
          ...(message.options || {}),
          onProgress: (progress) => {
            self.postMessage({ type: "SOLVE_EV_PROGRESS", id: message.id, progress });
          }
        }
      );
      self.postMessage({ type: "SOLVE_EV_DONE", id: message.id, result });
      return;
    }

  } catch (error) {
    self.postMessage({ type: "ERROR", id: message.id, error: String(error && error.message ? error.message : error) });
  }
};
