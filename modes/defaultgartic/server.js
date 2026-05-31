const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const problems = require('./problems.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const lobbies = {};
const games = {};

const ROUND_SECONDS = 90;

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

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



// ── Lobby ─────────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('createLobby', ({ username }) => {
    let code;
    do { code = generateCode(); } while (lobbies[code]);
    lobbies[code] = { host: socket.id, players: [{ id: socket.id, name: username }] };
    socket.join(code);
    socket.data.lobbyCode = code;
    socket.data.username = username;
    socket.emit('lobbyJoined', { code, players: lobbies[code].players, isHost: true });
  });

  socket.on('joinLobby', ({ username, code }) => {
    const lobby = lobbies[code];
    if (!lobby) return socket.emit('joinError', { message: 'Lobby not found. Check the code.' });
    if (games[code]) return socket.emit('joinError', { message: 'Game already in progress.' });
    if (lobby.players.length >= 8) return socket.emit('joinError', { message: 'Lobby full (max 8).' });
    lobby.players.push({ id: socket.id, name: username });
    socket.join(code);
    socket.data.lobbyCode = code;
    socket.data.username = username;
    socket.emit('lobbyJoined', { code, players: lobby.players, isHost: false });
    socket.to(code).emit('playerListUpdated', { players: lobby.players });
  });

  socket.on('startGame', () => {
    const { lobbyCode } = socket.data;
    const lobby = lobbies[lobbyCode];
    if (!lobby || lobby.host !== socket.id) return;
    if (lobby.players.length < 2)
      return socket.emit('startError', { message: 'Need at least 2 players.' });

    const players = [...lobby.players];
    const pool = shuffled(problems).slice(0, players.length);
    games[lobbyCode] = {
      phase: 'coding',
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
    };
    startRound(lobbyCode);
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
    io.to(lobbyCode).emit('guessResult', {
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
    io.to(lobbyCode).emit('solutionRevealed', { solution: game.currentProblem.solution });
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
    io.to(lobbyCode).emit('chatMessage', { playerName: username, text: text.trim() });
  });

  socket.on('leaveLobby', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

// ── Game logic ────────────────────────────────────────────────────────────────

function startRound(lobbyCode) {
  const game = games[lobbyCode];
  game.phase = 'coding';
  game.code = '';
  game.solutionRevealed = false;
  game.guessedPlayerIds = new Set();
  game.timeRemaining = ROUND_SECONDS;

  const coderIdx = game.roundIndex % game.players.length;
  const coder = game.players[coderIdx];
  const problem = game.problemPool[game.roundIndex];
  game.currentProblem = problem;

  const base = {
    coderName: coder.name,
    coderId: coder.id,
    roundIndex: game.roundIndex,
    totalRounds: game.totalRounds,
    timeRemaining: game.timeRemaining,
    difficulty: problem.difficulty,
    tags: problem.tags,
  };

  const wrongOptions = shuffled(problems.filter(p => p.id !== problem.id))
    .slice(0, 3)
    .map(p => p.hint);
  const options = shuffled([problem.hint, ...wrongOptions]);

  io.to(coder.id).emit('roundStart', {
    ...base,
    isCoder: true,
    problemName: problem.name,
    description: problem.description,
  });

  game.players.forEach(p => {
    if (p.id === coder.id) return;
    io.to(p.id).emit('roundStart', { ...base, isCoder: false, options });
  });

  if (game.timerInterval) clearInterval(game.timerInterval);
  game.timerInterval = setInterval(() => {
    game.timeRemaining--;
    io.to(lobbyCode).emit('timerTick', { timeRemaining: game.timeRemaining });
    if (game.timeRemaining <= 0) endRound(lobbyCode);
  }, 1000);
}

function endRound(lobbyCode) {
  const game = games[lobbyCode];
  if (game.phase !== 'coding') return;
  game.phase = 'results';
  clearInterval(game.timerInterval);

  const coderIdx = game.roundIndex % game.players.length;
  const coder = game.players[coderIdx];
  let coderDelta = 0;
  if (game.guessedPlayerIds.size > 0) coderDelta += 30;
  if (game.solutionRevealed) coderDelta -= 20;
  game.scores[coder.id] = (game.scores[coder.id] || 0) + coderDelta;

  const scores = game.players.map(p => ({
    id: p.id,
    name: p.name,
    score: game.scores[p.id] || 0,
    isCoder: p.id === coder.id,
  })).sort((a, b) => b.score - a.score);

  io.to(lobbyCode).emit('roundEnd', {
    problemName: game.currentProblem.name,
    solution: game.currentProblem.solution,
    scores,
    roundIndex: game.roundIndex,
    totalRounds: game.totalRounds,
    isLastRound: game.roundIndex >= game.totalRounds - 1,
  });
}

function endGame(lobbyCode) {
  const game = games[lobbyCode];
  game.phase = 'gameover';
  clearInterval(game.timerInterval);

  const finalScores = game.players.map(p => ({
    id: p.id,
    name: p.name,
    score: game.scores[p.id] || 0,
  })).sort((a, b) => b.score - a.score);

  io.to(lobbyCode).emit('gameOver', { finalScores });
  delete games[lobbyCode];
}

function handleLeave(socket) {
  const { lobbyCode, username } = socket.data;
  if (!lobbyCode || !lobbies[lobbyCode]) return;

  const lobby = lobbies[lobbyCode];
  lobby.players = lobby.players.filter(p => p.id !== socket.id);
  socket.leave(lobbyCode);
  socket.data.lobbyCode = null;

  if (lobby.players.length === 0) {
    delete lobbies[lobbyCode];
    const game = games[lobbyCode];
    if (game) { clearInterval(game.timerInterval); delete games[lobbyCode]; }
    return;
  }

  if (lobby.host === socket.id) {
    lobby.host = lobby.players[0].id;
    io.to(lobby.host).emit('promotedToHost');
  }

  const game = games[lobbyCode];
  if (game && game.phase === 'coding') {
    game.players = game.players.filter(p => p.id !== socket.id);
    game.guessedPlayerIds.delete(socket.id);
    delete game.scores[socket.id];

    if (game.players.length < 2) {
      clearInterval(game.timerInterval);
      delete games[lobbyCode];
      io.to(lobbyCode).emit('gameAborted', { message: 'Not enough players. Game ended.' });
      return;
    }

    const coderIdx = game.roundIndex % game.players.length;
    const coder = game.players[coderIdx];
    if (!coder) endRound(lobbyCode);

    const guessers = game.players.filter(p => p.id !== (coder && coder.id));
    if (game.guessedPlayerIds.size >= guessers.length) endRound(lobbyCode);
  }

  io.to(lobbyCode).emit('playerListUpdated', { players: lobby.players });
  io.to(lobbyCode).emit('playerLeft', { name: username });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`LeetCode game → http://localhost:${PORT}`));
