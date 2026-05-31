const problems = require('./problems.json');

const games = {};
const ROUND_SECONDS = 90;

let _io; // set in register()

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalizeGuess(s) {
  return s.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function checkGuess(text, problem) {
  const n = normalizeGuess;
  return n(text) === n(problem.name)
    || n(text) === n(problem.slug.replace(/-/g, ' '))
    || text === problem.hint;
}

function recordCorrectGuess(game, socketId) {
  game.guessedPlayerIds.add(socketId);
  const points = Math.round(50 + 50 * (game.timeRemaining / ROUND_SECONDS));
  game.scores[socketId] = (game.scores[socketId] || 0) + points;
}

// ── Game lifecycle ────────────────────────────────────────────────────────────

function startRound(lobbyCode) {
  const game = games[lobbyCode];
  if (!game) return;
  game.phase = 'coding';
  game.code = '';
  game.solutionRevealed = false;
  game.guessedPlayerIds = new Set();
  game.timeRemaining = ROUND_SECONDS;

  const coder = game.players[game.roundIndex % game.players.length];
  const problem = game.problemPool[game.roundIndex];
  game.currentProblem = problem;

  const wrongOptions = shuffled(problems.filter(p => p.id !== problem.id))
    .slice(0, 3).map(p => p.hint);
  const options = shuffled([problem.hint, ...wrongOptions]);

  const base = {
    coderName: coder.name, coderId: coder.id,
    roundIndex: game.roundIndex, totalRounds: game.totalRounds,
    timeRemaining: game.timeRemaining,
    difficulty: problem.difficulty, tags: problem.tags,
  };

  _io.to(coder.id).emit('roundStart', {
    ...base, isCoder: true,
    problemName: problem.name, description: problem.description,
  });

  game.players.forEach(p => {
    if (p.id === coder.id) return;
    _io.to(p.id).emit('roundStart', { ...base, isCoder: false, options });
  });

  if (game.timerInterval) clearInterval(game.timerInterval);
  game.timerInterval = setInterval(() => {
    game.timeRemaining--;
    _io.to(lobbyCode).emit('timerTick', { timeRemaining: game.timeRemaining });
    if (game.timeRemaining <= 0) endRound(lobbyCode);
  }, 1000);
}

function endRound(lobbyCode) {
  const game = games[lobbyCode];
  if (!game || game.phase !== 'coding') return;
  game.phase = 'results';
  clearInterval(game.timerInterval);

  const coder = game.players[game.roundIndex % game.players.length];
  let coderDelta = 0;
  if (game.guessedPlayerIds.size > 0) coderDelta += 30;
  if (game.solutionRevealed) coderDelta -= 20;
  game.scores[coder.id] = (game.scores[coder.id] || 0) + coderDelta;

  const scores = game.players.map(p => ({
    id: p.id, name: p.name,
    score: game.scores[p.id] || 0,
    isCoder: p.id === coder.id,
  })).sort((a, b) => b.score - a.score);

  _io.to(lobbyCode).emit('roundEnd', {
    problemName: game.currentProblem.name,
    solution: game.currentProblem.solution,
    scores, roundIndex: game.roundIndex,
    totalRounds: game.totalRounds,
    isLastRound: game.roundIndex >= game.totalRounds - 1,
  });
}

function endGame(lobbyCode) {
  const game = games[lobbyCode];
  if (!game) return;
  game.phase = 'gameover';
  clearInterval(game.timerInterval);

  const finalScores = game.players.map(p => ({
    id: p.id, name: p.name, score: game.scores[p.id] || 0,
  })).sort((a, b) => b.score - a.score);

  _io.to(lobbyCode).emit('gameOver', { finalScores });
  delete games[lobbyCode];
}

// ── Called from root server when host starts classic game ─────────────────────

function startClassicGame(lobbyCode, lobby) {
  const players = [...lobby.players];
  const pool = shuffled(problems).slice(0, players.length);

  // Timeout: start round even if not all players navigated in time
  const rejoinTimeout = setTimeout(() => {
    const game = games[lobbyCode];
    if (game && game.phase === 'waiting') startRound(lobbyCode);
  }, 15000);

  games[lobbyCode] = {
    phase: 'waiting',
    players,
    roundIndex: 0,
    totalRounds: players.length,
    problemPool: pool,
    currentProblem: null,
    code: '',
    solutionRevealed: false,
    guessedPlayerIds: new Set(),
    scores: Object.fromEntries(players.map(p => [p.id, 0])),
    timeRemaining: ROUND_SECONDS,
    timerInterval: null,
    rejoinedCount: 0,
    rejoinTimeout,
  };
}

// ── Called from root server handleLeave ───────────────────────────────────────

function cleanupGame(lobbyCode, socketId) {
  const game = games[lobbyCode];
  if (!game) return;

  if (game.phase === 'waiting') {
    game.players = game.players.filter(p => p.id !== socketId);
    return;
  }

  if (game.phase === 'coding') {
    game.players = game.players.filter(p => p.id !== socketId);
    game.guessedPlayerIds.delete(socketId);
    delete game.scores[socketId];

    if (game.players.length < 2) {
      clearInterval(game.timerInterval);
      delete games[lobbyCode];
      _io.to(lobbyCode).emit('gameAborted', { message: 'Not enough players. Game ended.' });
      return;
    }

    const coder = game.players[game.roundIndex % game.players.length];
    if (!coder) { endRound(lobbyCode); return; }
    const guessers = game.players.filter(p => p.id !== coder.id);
    if (game.guessedPlayerIds.size >= guessers.length) endRound(lobbyCode);
  }
}

// ── Socket handlers ───────────────────────────────────────────────────────────

function register(io, lobbies) {
  _io = io;

  io.on('connection', (socket) => {

    // Players arrive at /classic page with URL params and rejoin here
    socket.on('classicRejoin', ({ code, username }) => {
      const game = games[code];
      const lobby = lobbies[code];
      if (!game || !lobby) {
        socket.emit('classicRejoinError', { message: 'Game not found.' });
        return;
      }

      // Find player by username and remap to new socket ID
      const player = game.players.find(p => p.name === username);
      if (!player) {
        socket.emit('classicRejoinError', { message: 'Player not found in this game.' });
        return;
      }

      const oldId = player.id;
      player.id = socket.id;

      // Remap scores + guesses
      if (game.scores[oldId] !== undefined) {
        game.scores[socket.id] = game.scores[oldId];
        delete game.scores[oldId];
      }
      if (game.guessedPlayerIds.has(oldId)) {
        game.guessedPlayerIds.delete(oldId);
        game.guessedPlayerIds.add(socket.id);
      }

      // Update lobby record
      const lobbyPlayer = lobby.players.find(p => p.name === username);
      if (lobbyPlayer) lobbyPlayer.id = socket.id;
      const isHost = lobby.host === oldId;
      if (isHost) lobby.host = socket.id;

      socket.join(code);
      socket.data.lobbyCode = code;
      socket.data.username = username;

      socket.emit('classicRejoined', { isHost });

      // Start first round once everyone is in (or after timeout)
      game.rejoinedCount = (game.rejoinedCount || 0) + 1;
      if (game.phase === 'waiting' && game.rejoinedCount >= game.players.length) {
        clearTimeout(game.rejoinTimeout);
        startRound(code);
      }
    });

    socket.on('codeUpdate', ({ code }) => {
      const { lobbyCode } = socket.data;
      const game = games[lobbyCode];
      if (!game || game.phase !== 'coding') return;
      const coder = game.players[game.roundIndex % game.players.length];
      if (socket.id !== coder.id) return;
      game.code = code;
      socket.to(lobbyCode).emit('codeBroadcast', { code });
    });

    socket.on('submitGuess', ({ text }) => {
      const { lobbyCode } = socket.data;
      const game = games[lobbyCode];
      if (!game || game.phase !== 'coding') return;
      const coder = game.players[game.roundIndex % game.players.length];
      if (socket.id === coder.id) return;
      if (game.guessedPlayerIds.has(socket.id)) return;

      const correct = checkGuess(text, game.currentProblem);
      if (correct) recordCorrectGuess(game, socket.id);
      _io.to(lobbyCode).emit('guessResult', {
        playerId: socket.id, playerName: socket.data.username, text, correct,
      });

      const guessers = game.players.filter(p => p.id !== coder.id);
      if (game.guessedPlayerIds.size >= guessers.length) endRound(lobbyCode);
    });

    socket.on('requestSolution', () => {
      const { lobbyCode } = socket.data;
      const game = games[lobbyCode];
      if (!game || game.phase !== 'coding') return;
      const coder = game.players[game.roundIndex % game.players.length];
      if (socket.id !== coder.id || game.solutionRevealed) return;
      game.solutionRevealed = true;
      game.code = game.currentProblem.solution;
      _io.to(lobbyCode).emit('solutionRevealed', { solution: game.currentProblem.solution });
    });

    socket.on('nextRound', () => {
      const { lobbyCode } = socket.data;
      const lobby = lobbies[lobbyCode];
      const game = games[lobbyCode];
      if (!game || game.phase !== 'results') return;
      if (!lobby || lobby.host !== socket.id) return;
      game.roundIndex++;
      if (game.roundIndex >= game.totalRounds) endGame(lobbyCode);
      else startRound(lobbyCode);
    });

    socket.on('sendChat', ({ text }) => {
      const { lobbyCode, username } = socket.data;
      if (!lobbyCode || !text.trim()) return;
      _io.to(lobbyCode).emit('chatMessage', { playerName: username, text: text.trim() });
    });

  });
}

function isTransitioning(lobbyCode) {
  return !!(games[lobbyCode] && games[lobbyCode].phase === 'waiting');
}

module.exports = { register, startClassicGame, cleanupGame, isTransitioning };
