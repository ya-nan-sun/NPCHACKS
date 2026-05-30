/**
 * lobbyManager.js
 * In-memory store for all active lobbies and players.
 */

const lobbies = new Map(); // code → lobby object

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (lobbies.has(code));
  return code;
}

/**
 * Lobby shape:
 * {
 *   code: string,
 *   players: [{ id: socketId, name: string }],
 *   gameMode: string | null,
 *   status: 'waiting' | 'playing' | 'results',
 *   submissions: Map<socketId, string>,   // code submitted by each player
 *   variableSpec: string,                 // shared context shown to all players
 * }
 */

function createLobby(socketId, username) {
  const code = generateCode();
  const lobby = {
    code,
    players: [{ id: socketId, name: username }],
    gameMode: null,
    status: 'waiting',
    submissions: new Map(),
    variableSpec: null,
  };
  lobbies.set(code, lobby);
  return lobby;
}

function getLobby(code) {
  return lobbies.get(code) || null;
}

function getLobbyBySocket(socketId) {
  for (const lobby of lobbies.values()) {
    if (lobby.players.some(p => p.id === socketId)) return lobby;
  }
  return null;
}

function joinLobby(code, socketId, username) {
  const lobby = lobbies.get(code);
  if (!lobby) return { error: 'Lobby not found.' };
  if (lobby.status !== 'waiting') return { error: 'Game already in progress.' };
  if (lobby.players.length >= 12) return { error: 'Lobby is full.' };
  if (lobby.players.some(p => p.name === username)) return { error: 'That name is already taken in this lobby.' };
  lobby.players.push({ id: socketId, name: username });
  return { lobby };
}

function removePlayer(socketId) {
  const lobby = getLobbyBySocket(socketId);
  if (!lobby) return null;
  lobby.players = lobby.players.filter(p => p.id !== socketId);
  if (lobby.players.length === 0) {
    lobbies.delete(lobby.code);
    return { lobby, disbanded: true };
  }
  return { lobby, disbanded: false };
}

function getHost(lobby) {
  return lobby.players[0] || null;
}

function setGameMode(lobby, mode) {
  lobby.gameMode = mode;
}

function submitCode(lobby, socketId, code) {
  lobby.submissions.set(socketId, code);
}

function allSubmitted(lobby) {
  return lobby.players.every(p => lobby.submissions.has(p.id));
}

function deleteLobby(code) {
  lobbies.delete(code);
}

module.exports = {
  createLobby, getLobby, getLobbyBySocket,
  joinLobby, removePlayer, getHost,
  setGameMode, submitCode, allSubmitted, deleteLobby,
};
