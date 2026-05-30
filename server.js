const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// lobbies[code] = { host: socketId, players: [{id, name}], gameMode: null }
const lobbies = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  socket.on('createLobby', ({ username }) => {
    let code;
    do { code = generateCode(); } while (lobbies[code]);

    lobbies[code] = { host: socket.id, players: [{ id: socket.id, name: username }], gameMode: null };
    socket.join(code);
    socket.data.lobbyCode = code;
    socket.data.username = username;

    socket.emit('lobbyJoined', { code, players: lobbies[code].players, isHost: true, gameMode: null });
  });

  socket.on('joinLobby', ({ username, code }) => {
    const lobby = lobbies[code];
    if (!lobby) {
      socket.emit('joinError', { message: 'Lobby not found. Check the code and try again.' });
      return;
    }
    if (lobby.players.length >= 12) {
      socket.emit('joinError', { message: 'Lobby is full (max 12 players).' });
      return;
    }

    lobby.players.push({ id: socket.id, name: username });
    socket.join(code);
    socket.data.lobbyCode = code;
    socket.data.username = username;

    socket.emit('lobbyJoined', { code, players: lobby.players, isHost: false, gameMode: lobby.gameMode });
    socket.to(code).emit('playerListUpdated', { players: lobby.players });
  });

  socket.on('selectGameMode', ({ mode }) => {
    const { lobbyCode } = socket.data;
    const lobby = lobbies[lobbyCode];
    if (!lobby || lobby.host !== socket.id) return;
    lobby.gameMode = mode;
    io.to(lobbyCode).emit('gameModeSelected', { mode });
  });

  socket.on('startGame', () => {
    const { lobbyCode } = socket.data;
    const lobby = lobbies[lobbyCode];
    if (!lobby || lobby.host !== socket.id || !lobby.gameMode) return;
    io.to(lobbyCode).emit('gameStarted', { mode: lobby.gameMode });
  });

  socket.on('leaveLobby', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

function handleLeave(socket) {
  const { lobbyCode, username } = socket.data;
  if (!lobbyCode || !lobbies[lobbyCode]) return;

  const lobby = lobbies[lobbyCode];
  lobby.players = lobby.players.filter((p) => p.id !== socket.id);
  socket.leave(lobbyCode);
  socket.data.lobbyCode = null;

  if (lobby.players.length === 0) {
    delete lobbies[lobbyCode];
    return;
  }

  // Pass host to next player if host left
  if (lobby.host === socket.id) {
    lobby.host = lobby.players[0].id;
    io.to(lobby.host).emit('promotedToHost');
  }

  io.to(lobbyCode).emit('playerListUpdated', { players: lobby.players });
  io.to(lobbyCode).emit('playerLeft', { name: username });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running → http://localhost:${PORT}`));
