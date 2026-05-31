/**
 * server.js — shared lobby infrastructure
 *
 * Handles: createLobby, joinLobby, selectGameMode, leaveLobby, disconnect
 * Does NOT handle: any game-mode-specific logic (startGame, submitCode, etc.)
 *
 * Each game mode registers its own socket handlers via:
 *   require('./modes/<name>/gameHandler').register(io, lobbies);
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/**
 * Shared lobby store — passed to every game mode handler.
 *
 * lobbies[code] = {
 *   host:         socketId,
 *   players:      [{ id, name, isAI? }],
 *   gameMode:     string | null,
 *   status:       'waiting' | 'playing' | 'results',
 *   submissions:  { socketId: code },
 *   variableSpec: object | null,
 *   aiPlayerIds:  string[],
 * }
 */
const lobbies = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ── Register game mode handlers ───────────────────────────────────────────────
// Each team adds their handler here when ready.
require('./modes/exquisite-corpse/gameHandler').register(io, lobbies);
// require('./modes/classic/gameHandler').register(io, lobbies);
// require('./modes/speed-round/gameHandler').register(io, lobbies);
// require('./modes/chaos/gameHandler').register(io, lobbies);

// ── Shared lobby events ───────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Create Lobby ────────────────────────────────────────────────────────────
  socket.on('createLobby', ({ username }) => {
    let code;
    do { code = generateCode(); } while (lobbies[code]);

    lobbies[code] = {
      host:         socket.id,
      players:      [{ id: socket.id, name: username }],
      gameMode:     null,
      status:       'waiting',
      submissions:  {},
      variableSpec: null,
      aiPlayerIds:  [],
    };

    socket.join(code);
    socket.data.lobbyCode = code;
    socket.data.username  = username;

    socket.emit('lobbyJoined', {
      code,
      players:  lobbies[code].players,
      isHost:   true,
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
    socket.data.username  = username;

    socket.emit('lobbyJoined', {
      code,
      players:  lobby.players,
      isHost:   false,
      gameMode: lobby.gameMode,
    });

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

  // ── Leave Lobby ─────────────────────────────────────────────────────────────
  socket.on('leaveLobby',  () => handleLeave(socket));
  socket.on('disconnect',  () => handleLeave(socket));
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

  if (lobby.host === socket.id) {
    lobby.host = lobby.players[0].id;
    io.to(lobby.host).emit('promotedToHost');
  }

  io.to(lobbyCode).emit('playerListUpdated', { players: lobby.players });
  io.to(lobbyCode).emit('playerLeft', { name: username });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
