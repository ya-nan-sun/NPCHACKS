/**
 * modes/exquisite-corpse/gameHandler.js
 *
 * Registers all socket events specific to the Exquisite Corpse game mode.
 * Called once from server.js, receives the `io` instance and `lobbies` store.
 *
 * Other teams plug in their own handlers the same way:
 *   require('./modes/their-mode/gameHandler').register(io, lobbies);
 */

const engine = require('./gameEngine');

function register(io, lobbies) {

  io.on('connection', (socket) => {

    // ── Start Game ────────────────────────────────────────────────────────────
    socket.on('startGame', () => {
      const { lobbyCode } = socket.data;
      const lobby = lobbies[lobbyCode];
      if (!lobby || lobby.host !== socket.id || !lobby.gameMode) return;
      if (lobby.gameMode !== 'team') return; // only handle our mode

      const humanCount = lobby.players.length;
      const NPC_COUNT  = humanCount === 1 ? 1 : 0;

      // Inject AI players for solo mode
      for (let i = 0; i < NPC_COUNT; i++) {
        const aiId   = `__ai_${Date.now()}_${i}`;
        const aiName = `NPC_${i + 1}`;
        lobby.players.push({ id: aiId, name: aiName, isAI: true });
        lobby.aiPlayerIds.push(aiId);
      }

      lobby.status      = 'playing';
      lobby.submissions = {};

      const spec        = engine.pickRandomSpec();
      lobby.variableSpec = spec;

      io.to(lobbyCode).emit('playerListUpdated', { players: lobby.players });
      io.to(lobbyCode).emit('gameStarted', { mode: lobby.gameMode });

      setTimeout(() => {
        io.to(lobbyCode).emit('roundStarted', {
          specCode:     spec.code,
          specLabel:    spec.label,
          description:  spec.description,
          totalPlayers: lobby.players.length,
        });
      }, 800);
    });

    // ── Submit Code ───────────────────────────────────────────────────────────
    socket.on('submitCode', ({ code }) => {
      const { lobbyCode } = socket.data;
      const lobby = lobbies[lobbyCode];
      if (!lobby || lobby.status !== 'playing') return;
      if (typeof code !== 'string') return;
      if (lobby.submissions[socket.id] !== undefined) return; // no double submit

      lobby.submissions[socket.id] = code;

      const submitted = Object.keys(lobby.submissions).length;
      const total     = lobby.players.length;

      io.to(lobbyCode).emit('submissionProgress', { submitted, total });

      const allHumansSubmitted = lobby.players
        .filter(p => !p.isAI)
        .every(p => lobby.submissions[p.id] !== undefined);

      if (allHumansSubmitted && lobby.aiPlayerIds.length > 0) {
        generateAISubmissionsAndReveal(io, lobby, lobbyCode);
      } else if (submitted === total) {
        revealResults(io, lobby, lobbyCode);
      }
    });

  });
}

// ── AI Submissions ─────────────────────────────────────────────────────────────
async function generateAISubmissionsAndReveal(io, lobby, lobbyCode) {
  io.to(lobbyCode).emit('aiThinking', { count: lobby.aiPlayerIds.length });

  try {
    await Promise.all(
      lobby.aiPlayerIds.map(async (aiId) => {
        const aiName = lobby.players.find(p => p.id === aiId)?.name || 'NPC';
        const aiCode = await engine.generateAIFunction(lobby.variableSpec, aiName);
        lobby.submissions[aiId] = aiCode;
      })
    );
  } catch (err) {
    console.error('[EC] AI generation error:', err);
    lobby.aiPlayerIds.forEach(aiId => {
      if (!lobby.submissions[aiId]) {
        lobby.submissions[aiId] = `function npc_fallback() {\n  log.push('NPC had a brain freeze.');\n}`;
      }
    });
  }

  revealResults(io, lobby, lobbyCode);
}

// ── Reveal Results ─────────────────────────────────────────────────────────────
function revealResults(io, lobby, lobbyCode) {
  const submissions = lobby.players.map(p => ({
    playerName: p.name,
    isAI:       !!p.isAI,
    code:       lobby.submissions[p.id] || '// (no code submitted)',
  }));

  const assembled = engine.assembleProgram(lobby.variableSpec.code, submissions);
  const result    = engine.executeProgram(assembled);

  lobby.status = 'results';

  io.to(lobbyCode).emit('revealResults', {
    assembled,
    submissions,
    output: result.output,
    error:  result.error,
  });
}

module.exports = { register };
