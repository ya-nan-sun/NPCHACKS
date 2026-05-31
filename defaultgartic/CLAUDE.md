# NPC Hacks — LeetCode Skribbl

## Concept
Skribbl.io but with LeetCode. One player (the **Coder**) is given a LeetCode problem and writes code live. Other players (the **Guessers**) watch the code appear in real time and pick from 4 multiple-choice options describing what the algorithm solves. If the Coder doesn't know how to solve it, they can reveal the reference solution. All players can chat during rounds.

## Stack
- **Backend**: Node.js + Express + Socket.io (`defaultgartic/server.js`) — port 3001
- **Frontend**: Vanilla JS, single `defaultgartic/public/index.html` (no framework)
- **Code editor**: CodeMirror 5 (CDN, Dracula theme) — editable for coder, `readOnly: 'nocursor'` for guessers
- **LeetCode problems**: Static curated JSON — `defaultgartic/problems.json`
- **Code execution**: Not implemented — coder writes manually, no test running
- **No AI/external APIs** — all logic is local

## How to Run
```
node defaultgartic/server.js
# open http://localhost:3001
```
Requires ≥2 players in the lobby before the host can start.

## Current State — FULLY IMPLEMENTED
All screens and game logic working end-to-end.

### Files
| File | Purpose |
|---|---|
| `defaultgartic/server.js` | Full game server: lobby + game state + socket events |
| `defaultgartic/public/index.html` | Full client: all 6 screens, CodeMirror editor, socket handling |
| `defaultgartic/problems.json` | 12 curated LeetCode problems with descriptions, hints, and JS solutions |

### Screens (all built)
1. **Login** — enter display name
2. **Menu** — create or join lobby by code
3. **Lobby** — player list, host starts game (min 2 players)
4. **Game** — split layout: CodeMirror editor left; problem/options + chat right
5. **Results** — reveals problem name, reference solution, scores after each round
6. **Game Over** — podium + full leaderboard

## Game Screen Layout
```
┌─────────────────────────────────────────────────┐
│ Round 1/4 | PlayerName is coding | ⏱ 1:30      │
├────────────────────────────┬────────────────────┤
│                            │ [Problem desc]      │  ← coder sees full description
│   CodeMirror editor        │ OR                  │
│   (editable for coder,     │ [2×2 option grid]   │  ← guessers see 4 hint buttons
│    read-only for guessers) │ [Difficulty + tags] │
│                            ├────────────────────┤
│                            │ Chat               │  ← all players
│                            │ [chat feed]        │
│                            │ [text input →]     │
└────────────────────────────┴────────────────────┘
```

## Multiple Choice Mechanic
- Server generates 4 options: **current problem's `hint`** + 3 random wrong `hint`s from the pool, shuffled
- Options are algorithm-goal descriptions (e.g. "Find two numbers that add up to a target") — **not** problem names
- Guessers click one option; all 4 buttons lock immediately
- Clicked button turns green (correct) or red (wrong)
- Correct answer is never sent to guessers until `roundEnd`

## Problems Dataset Schema
```js
{ id, name, slug, difficulty, tags[], hint, description, solution }
```
- `hint` — short goal description shown as a multiple choice option (e.g. "Find the contiguous subarray with the largest sum")
- `description` — full LeetCode problem text shown only to the coder

| # | Name | Difficulty | Hint |
|---|---|---|---|
| 1 | Two Sum | Easy | Find two numbers in an array that add up to a target value and return their indices |
| 20 | Valid Parentheses | Easy | Check whether every opening bracket is closed in the correct order |
| 70 | Climbing Stairs | Easy | Count distinct ways to reach the top taking 1 or 2 steps at a time |
| 121 | Best Time to Buy and Sell Stock | Easy | Find the maximum profit from a single buy and sell |
| 53 | Maximum Subarray | Medium | Find the contiguous subarray with the largest sum |
| 3 | Longest Substring Without Repeating Characters | Medium | Find the longest substring with all unique characters |
| 238 | Product of Array Except Self | Medium | Compute the product of all other elements for each position without division |
| 200 | Number of Islands | Medium | Count connected groups of land cells in a 2D grid |
| 322 | Coin Change | Medium | Find the minimum number of coins needed to make up a target amount |
| 56 | Merge Intervals | Medium | Combine all overlapping intervals into the smallest set |
| 347 | Top K Frequent Elements | Medium | Return the K most frequently occurring numbers |
| 139 | Word Break | Medium | Determine if a string can be segmented into valid dictionary words |

## Game State Shape (server-side)
```js
{
  phase: 'coding' | 'results' | 'gameover',
  players: [{ id, name }],
  roundIndex: Number,         // 0-based
  totalRounds: Number,        // = players.length (each player codes once)
  problemPool: [...],         // shuffled problems, one per round
  currentProblem: { id, name, slug, difficulty, tags, hint, description, solution },
  code: String,               // latest coder content (debounced 300ms)
  solutionRevealed: Boolean,
  guessedPlayerIds: Set,      // socket IDs who answered correctly this round
  scores: { [socketId]: Number },
  timeRemaining: Number,      // counts down from 90
  timerInterval: Interval,
}
```

## Scoring
- **Guesser correct**: `Math.round(50 + 50 * (timeRemaining / 90))` — range 50–100 pts
- **Coder**: +30 if at least one guesser answered correctly
- **Coder**: -20 if solution was revealed (stacks with the +30)
- Scores accumulate across all rounds

## Guess Validation (`checkGuess`)
Matches if submitted text equals (normalized): problem name, slug, or `hint` exactly.
Options are exact hint strings so button clicks always match cleanly.

## Socket Events
| Event | Direction | Payload |
|---|---|---|
| `createLobby` | client→server | `{ username }` |
| `joinLobby` | client→server | `{ username, code }` |
| `startGame` | client→server | — (host only) |
| `codeUpdate` | coder→server | `{ code }` |
| `submitGuess` | guesser→server | `{ text }` (hint string from clicked option) |
| `requestSolution` | coder→server | — |
| `nextRound` | client→server | — (host only, during results phase) |
| `sendChat` | client→server | `{ text }` |
| `leaveLobby` | client→server | — |
| `lobbyJoined` | server→client | `{ code, players, isHost }` |
| `joinError` / `startError` | server→client | `{ message }` |
| `playerListUpdated` | server→all | `{ players }` |
| `promotedToHost` | server→client | — |
| `roundStart` | server→client | coder: full problem + description; guessers: `difficulty, tags, options[]` |
| `timerTick` | server→all | `{ timeRemaining }` |
| `codeBroadcast` | server→guessers | `{ code }` |
| `guessResult` | server→all | `{ playerId, playerName, text, correct }` |
| `solutionRevealed` | server→all | `{ solution }` |
| `roundEnd` | server→all | `{ problemName, solution, scores, roundIndex, totalRounds, isLastRound }` |
| `gameOver` | server→all | `{ finalScores }` |
| `gameAborted` | server→all | `{ message }` |
| `chatMessage` | server→all | `{ playerName, text }` |

## Key Invariants — Do Not Break
- **Never send `problemName`, `hint` identity, or `solution` to guessers** during coding — `roundStart` emits different payloads per player via individual `io.to(socketId)` calls
- **Options are hints, not names** — wrong options are drawn from other problems' `hint` fields
- **Debounce code sync at 300ms** on the client — never per-keypress
- **`endRound` has a phase guard** (`if (game.phase !== 'coding') return`) — prevents double-fire
- **No code execution on the server** — no Judge0, no eval
- **Stay vanilla JS** — no React, Vue, or other frameworks
- **No AI/external APIs** — fully self-contained

## Known Gaps / Future Work
- No reconnection handling — refreshing mid-game loses the session
- Problems pool is only 12 — capped at 8 players to avoid repeats
- No spectator mode
- Mobile layout not optimized
