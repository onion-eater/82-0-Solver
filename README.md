# 82-0 Solver Chrome Extension

Minimal unpacked Chrome extension for analyzing live states in the
[82-0.com](https://www.82-0.com/) NBA simulator.

The extension adds a small overlay to the game page. It reads the current roll,
roster, switch state, and then recommends actions for two goals:

- maximize expected final Standard team OVR
- maximize the chance of reaching 82-0

## Install And Run

No build step or package install is required.

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the repository folder, the folder that contains `manifest.json`.
6. Open `https://www.82-0.com/`.
7. Click the extension icon to hide or show the overlay.

If you edit the extension files, reload the unpacked extension on
`chrome://extensions` and refresh the 82-0 tab.

## Overlay Controls

- `read`: read the visible team, era, switches, and roster.
- `pool`: show strong legal players from the current team/era pool.
- `solve`: run the EV solver in a Web Worker.
- `spins`: configure five fixed spins and inject the fixed-spin helper.

The fixed-spin helper is intentionally user-triggered. It injects a page-context
script because a normal content script cannot override the page's `Math.random`.

## Data

Bundled player data lives in `data/players.json`. It is static extension data and
is loaded locally by the content script and worker.

The optional first-pick estimate table lives in
`data/precomputed-depth2-standard-82.json`.

## Precomputing

Generate or resume the first-pick precompute table with:

```sh
node precompute-depth.js
```

The default output is `data/precomputed-depth2-standard-82.json`.

Current defaults:

- Standard scoring only
- 82-0 goal only
- depth `2`: current pick plus one later pick are expanded
- top `3` pick actions per expanded roll
- remaining picks use a switch-aware greedy tail estimate

The extension uses this table only when the roster has `0` filled slots and both
switches are unused. Later states are solved at runtime based on the current
roster size, not by roll number.

## Scoring

The extension's default objective is Standard scoring.

Standard team OVR:

```text
100 * (
  totalPPG / 133.4 * 0.46 +
  totalRPG / 39.7  * 0.25 +
  totalAPG / 29.3  * 0.18 +
  adjustedSPG / 6.1 * 0.07 +
  adjustedBPG / 3.2 * 0.04
)
```

SPG and BPG are adjusted separately:

```text
sum(non-null and > 0 stat) * 5 / count(non-null and > 0 stat)
```

Standard wins:

```text
wins = round(82 * min(teamOvr / 110, 1) ^ 1.15)
```

A Standard team OVR of `110` or higher is treated as sufficient for 82-0.

The solver also contains adjusted-rating helpers for parity checks, but the UI
always runs Standard scoring.

## Solver Methodology

The live simulator is modeled as a finite-horizon decision problem.

State includes:

- roster assignments for `PG`, `SG`, `SF`, `PF`, `C`
- current team and era roll
- whether the team switch has been used
- whether the era switch has been used

Legal actions are:

- pick a legal player from the current `team|era` pool
- use the team switch if available
- use the era switch if available

Pick legality:

- a player can be assigned to any slot in `player.positions`
- duplicate real players are blocked by `baseSlug`
- existing multi-position players may be moved if that makes the new pick legal

Switch behavior:

- team switch averages over every live team for the current era
- era switch averages over every live era for the current team
- self-rerolls are included because the simulator can reroll to the same combo

Runtime solving depends on filled roster size:

- `0` filled slots: use the precomputed first-pick 82-0 estimate when available
- `0-2` filled slots: use a greedy all-combo tail estimate for live feedback
- `3-4` filled slots: use exact bitmask-style DP for the remaining picks
- `5` filled slots: score the terminal roster directly

For late-game states, the overlay first shows a greedy estimate and then keeps
updating the state count while exact search runs.

The worker reports both max-score and 82-0 recommendations. These can differ,
so the overlay displays both.

## Verification

Useful local checks:

```sh
node --check background.js
node --check content.js
node --check solver-core.js
node --check ev-worker.js
node --check fixed-spins.js
node --check roll-listener.js
node --check precompute-depth.js
node precompute-depth.js --self-test
```

Manifest and bundled JSON smoke check:

```sh
node -e "for (const f of ['manifest.json','data/players.json','data/precomputed-depth2-standard-82.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('ok')"
```

## Privacy And Permissions

The extension runs only on:

- `https://82-0.com/*`
- `https://www.82-0.com/*`

It does not collect credentials, cookies, or browsing history. It reads visible
game state from the 82-0 page and stores only the fixed-spin sequence in page
`localStorage`.
