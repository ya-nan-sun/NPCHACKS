const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const engine = require('./gameEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// lobbies[code] = { host, players, gameMode, status, submissions, variableSpec }
const lobbies = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {

  // ── Create Lobby ────────────────────────────────────────────────────────────
  socket.on('createLobby', ({ username }) => {
    let code;
    do { code = generateCode(); } while (lobbies[code]);

    lobbies[code] = {
      host: socket.id,
      players: [{ id: socket.id, name: username }],
      gameMode: null,
      status: 'waiting',
      submissions: {},
      variableSpec: null,
    };

    socket.join(code);
    socket.data.lobbyCode = code;
    socket.data.username = username;

    socket.emit('lobbyJoined', {
      code,
      players: lobbies[code].players,
      isHost: true,
      gameMode: null,
    });
  });

  // ── Join Lobby ──────────────────────────────────────────────────────────────
  socket.on('joinLobby', ({ username, code }) => {
    const lobby = lobbies[code];

    if (!lobby) {
      socket.emit('joinError', { message: 'Lobby not found. Check the code and try again.' });
      return;
    }
    if (lobby.status !== 'waiting') {
      socket.emit('joinError', { message: 'Game already in progress.' });
      return;
    }
    if (lobby.players.length >= 12) {
      socket.emit('joinError', { message: 'Lobby is full (max 12 players).' });
      return;
    }
    if (lobby.players.some(p => p.name === username)) {
      socket.emit('joinError', { message: 'That name is already taken in this lobby.' });
      return;
    }

    lobby.players.push({ id: socket.id, name: username });
    socket.join(code);
    socket.data.lobbyCode = code;
    socket.data.username = username;

    // Tell the joining player their full lobby state
    socket.emit('lobbyJoined', {
      code,
      players: lobby.players,
      isHost: false,
      gameMode: lobby.gameMode,
    });

    // Tell everyone else the player list updated
    socket.to(code).emit('playerListUpdated', { players: lobby.players });
  });

  // ── Select Game Mode ────────────────────────────────────────────────────────
  socket.on('selectGameMode', ({ mode }) => {
    const { lobbyCode } = socket.data;
    const lobby = lobbies[lobbyCode];
    if (!lobby || lobby.host !== socket.id) return;
    lobby.gameMode = mode;
    io.to(lobbyCode).emit('gameModeSelected', { mode });
  });

  // ── Start Game ──────────────────────────────────────────────────────────────
  socket.on('startGame', () => {
    const { lobbyCode } = socket.data;
    const lobby = lobbies[lobbyCode];
    if (!lobby || lobby.host !== socket.id || !lobby.gameMode) return;
    if (lobby.players.length < 2) {
      socket.emit('joinError', { message: 'Need at least 2 players to start.' });
      return;
    }

    lobby.status = 'playing';
    lobby.submissions = {};

    const spec = engine.pickRandomSpec();
    lobby.variableSpec = spec;

    io.to(lobbyCode).emit('gameStarted', { mode: lobby.gameMode });

    // Small delay so the screen transition happens before game data arrives
    setTimeout(() => {
      io.to(lobbyCode).emit('roundStarted', {
        specCode: spec.code,
        specLabel: spec.label,
        description: spec.description,
        totalPlayers: lobby.players.length,
      });
    }, 800);
  });

  // ── Submit Code ─────────────────────────────────────────────────────────────
  socket.on('submitCode', ({ code }) => {
    const { lobbyCode } = socket.data;
    const lobby = lobbies[lobbyCode];
    if (!lobby || lobby.status !== 'playing') return;
    if (typeof code !== 'string') return;

    // Only record first submission per player
    if (lobby.submissions[socket.id] !== undefined) return;

    lobby.submissions[socket.id] = code;

    const submitted = Object.keys(lobby.submissions).length;
    const total = lobby.players.length;

    io.to(lobbyCode).emit('submissionProgress', { submitted, total });

    if (submitted === total) {
      // Build submissions in player order
      const submissions = lobby.players.map(p => ({
        playerName: p.name,
        code: lobby.submissions[p.id] || '// (no code submitted)',
      }));

      const assembled = engine.assembleProgram(lobby.variableSpec.code, submissions);
      const result = engine.executeProgram(assembled);

      lobby.status = 'results';

      io.to(lobbyCode).emit('revealResults', {
        assembled,
        submissions,
        output: result.output,
        error: result.error,
      });
    }
  });

  // ── Leave Lobby ─────────────────────────────────────────────────────────────
  socket.on('leaveLobby', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

// ── Handle Leave / Disconnect ─────────────────────────────────────────────────
function handleLeave(socket) {
  const { lobbyCode, username } = socket.data;
  if (!lobbyCode || !lobbies[lobbyCode]) return;

  const lobby = lobbies[lobbyCode];
  lobby.players = lobby.players.filter(p => p.id !== socket.id);
  socket.leave(lobbyCode);
  socket.data.lobbyCode = null;

  if (lobby.players.length === 0) {
    delete lobbies[lobbyCode];
    return;
  }

  // Promote next player to host if host left
  if (lobby.host === socket.id) {
    lobby.host = lobby.players[0].id;
    io.to(lobby.host).emit('promotedToHost');
  }

  io.to(lobbyCode).emit('playerListUpdated', { players: lobby.players });
  io.to(lobbyCode).emit('playerLeft', { name: username });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
