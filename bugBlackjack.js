// Bug Blackjack — lobby-based authoritative server logic.
//
// All players in a lobby share the same dealer hand.
// Round flow:
//   1. Each player places a bet  →  bb:placeBet
//   2. Once all players have bet, the server deals automatically
//   3. Players play independently (hit / stand / double / fold)
//   4. When the last player is done, the dealer plays out live
//   5. bb:roundOver is broadcast to the lobby with a full scoreboard

const { generateSnippet } = require('./snippets');

const START_CHIPS    = 1000;
const DEALER_STANDS  = 9;
const TARGET         = 12;
const MAX_SNIPPETS   = 8;

// Blackjack-style deck scaled for 15-line snippets (max 4 bugs each).
const DECK = [1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 4];
const drawCard = () => DECK[Math.floor(Math.random() * DECK.length)];

// chips persists for the duration of a socket connection
const playerChips = new Map(); // socketId → number

// one round per lobby while a game is in progress
const lobbyRounds = new Map(); // lobbyCode → LobbyRound

function getChips(id)        { if (!playerChips.has(id)) playerChips.set(id, START_CHIPS); return playerChips.get(id); }
function setChips(id, n)     { playerChips.set(id, n); }

const generate      = (bugCount) => generateSnippet('easy', bugCount);
const pub           = (s) => ({ language: s.language, title: s.title || null, code: s.code });
const rev           = (s) => ({ language: s.language, title: s.title || null, code: s.code, bugs: s.bugs, bugCount: s.bugCount });
const sumBugs       = (snips) => snips.reduce((a, s) => a + s.bugCount, 0);

// ── Lobby-level round operations ──────────────────────────────────────────────

async function startRound(lobbyCode, lobby, round, io) {
  round.status = 'playing';
  io.to(lobbyCode).emit('bb:dealing', { stage: 'deal' });

  // Deal shared dealer hand + one snippet per player, all in parallel.
  const playerIds = Object.keys(round.bets);
  const [d1, d2, ...playerSnips] = await Promise.all([
    generate(drawCard()),
    generate(drawCard()),
    ...playerIds.map(() => generate(drawCard())),
  ]);

  round.dealer.snippets = [d1, d2];

  playerIds.forEach((sid, i) => {
    const { name, chips, bet } = round.bets[sid];
    const hand = [playerSnips[i]];
    round.players[sid] = { name, chips, bet, hand, status: 'playing', delta: 0, doubled: false, folded: false };

    io.to(sid).emit('bb:dealt', {
      player:            [pub(playerSnips[i])],
      dealerVisible:     pub(d1),
      dealerHiddenCount: 1,
      bet,
      chips,
      canHit:    sumBugs(hand) < TARGET,
      canDouble: bet * 2 <= chips,
    });
  });
}

async function runDealer(lobbyCode, io) {
  const round = lobbyRounds.get(lobbyCode);
  if (!round || round.dealerBusy) return;
  round.status     = 'dealer';
  round.dealerBusy = true;

  // Flip the hidden card so all players see it.
  io.to(lobbyCode).emit('bb:dealerFlip', { snippet: pub(round.dealer.snippets[1]) });

  while (sumBugs(round.dealer.snippets) < DEALER_STANDS && round.dealer.snippets.length < MAX_SNIPPETS) {
    io.to(lobbyCode).emit('bb:dealerThinking');
    const snip = await generate(drawCard());
    round.dealer.snippets.push(snip);
    io.to(lobbyCode).emit('bb:dealerSnippet', { snippet: pub(snip) });
  }

  settleAll(lobbyCode, io);
}

function settleAll(lobbyCode, io) {
  const round = lobbyRounds.get(lobbyCode);
  if (!round) return;
  round.status = 'done';

  const dt          = sumBugs(round.dealer.snippets);
  const dealerBust  = dt > TARGET;
  const dealerNat   = dt === TARGET && round.dealer.snippets.length <= 2;

  const scoreboard = Object.entries(round.players).map(([sid, ps]) => {
    const pt     = sumBugs(ps.hand);
    const effBet = ps.doubled ? ps.bet * 2 : ps.bet;
    let delta = 0, outcome = '';

    if (ps.folded)                                           { delta = -Math.ceil(ps.bet / 2); outcome = 'fold'; }
    else if (pt > TARGET)                                    { delta = -effBet;                  outcome = 'bust'; }
    else if (pt === TARGET && ps.hand.length <= 2 && !ps.doubled && !dealerNat)
                                                             { delta = Math.round(ps.bet * 1.5); outcome = 'natural'; }
    else if (dealerBust)                                     { delta = effBet;                   outcome = 'dealer-bust'; }
    else if (pt > dt)                                        { delta = effBet;                   outcome = 'win'; }
    else if (pt < dt)                                        { delta = -effBet;                  outcome = 'lose'; }
    else                                                     { delta = 0;                        outcome = 'push'; }

    const newChips = ps.chips + delta;
    setChips(sid, newChips);

    return { socketId: sid, name: ps.name, playerTotal: pt, hand: ps.hand.map(rev), outcome, delta, chips: newChips };
  });

  io.to(lobbyCode).emit('bb:roundOver', {
    dealer:      round.dealer.snippets.map(rev),
    dealerTotal: dt,
    target:      TARGET,
    scoreboard,
  });

  lobbyRounds.delete(lobbyCode);
}

function checkAllDone(lobbyCode, io) {
  const round = lobbyRounds.get(lobbyCode);
  if (!round || round.status !== 'playing' || round.dealerBusy) return;
  const allDone = Object.values(round.players).every(ps => ps.status !== 'playing');
  if (allDone) runDealer(lobbyCode, io);
}

// ── Per-socket handler registration ──────────────────────────────────────────

function registerBugBlackjack(io, socket, lobbies) {
  const err         = (msg) => socket.emit('bb:error', { message: msg });
  const code        = () => socket.data.lobbyCode;
  const lobby       = () => lobbies[code()];
  const round       = () => lobbyRounds.get(code());
  const myState     = () => round() && round().players[socket.id];

  socket.on('bb:init', () => {
    const lob = lobby();
    const standings = lob
      ? lob.players.map(p => ({ name: p.name, chips: getChips(p.id), isMe: p.id === socket.id }))
      : [{ name: socket.data.username, chips: getChips(socket.id), isMe: true }];

    socket.emit('bb:state', {
      chips:          getChips(socket.id),
      startChips:     START_CHIPS,
      target:         TARGET,
      dealerStandsAt: DEALER_STANDS,
      standings,
    });
  });

  socket.on('bb:placeBet', async ({ bet }) => {
    const lob = lobby();
    if (!lob) return err('Not in a lobby.');

    const chips  = getChips(socket.id);
    const amount = Math.floor(Number(bet) || 0);
    if (amount <= 0)      return err('Enter a valid bet.');
    if (amount > chips)   return err('Not enough chips.');

    let r = round();
    if (r && r.status !== 'betting') return err('A round is already in progress.');

    if (!r) {
      r = { status: 'betting', dealer: { snippets: [] }, bets: {}, players: {}, dealerBusy: false };
      lobbyRounds.set(code(), r);
    }

    r.bets[socket.id] = { name: socket.data.username, chips, bet: amount };

    // Broadcast readiness so everyone can see who has bet.
    const betStatus = lob.players.map(p => ({
      id: p.id, name: p.name, ready: !!r.bets[p.id],
    }));
    io.to(code()).emit('bb:betStatus', { players: betStatus });

    // Auto-start once every player in the lobby has bet.
    if (lob.players.every(p => r.bets[p.id])) {
      await startRound(code(), lob, r, io);
    }
  });

  socket.on('bb:hit', async () => {
    const r  = round();
    const ps = myState();
    if (!r || !ps || ps.status !== 'playing') return;
    if (sumBugs(ps.hand) >= TARGET)           return err('You cannot hit — stand instead.');
    if (ps.hand.length >= MAX_SNIPPETS)       return err('Maximum snippets reached.');

    socket.emit('bb:dealing', { stage: 'hit' });
    const snip = await generate(drawCard());
    ps.hand.push(snip);
    const canHit = ps.hand.length < MAX_SNIPPETS && sumBugs(ps.hand) < TARGET;

    socket.emit('bb:playerSnippet', {
      snippet:  pub(snip),
      index:    ps.hand.length - 1,
      canHit,
      canDouble: false,
    });

    // Auto-stand if hitting brought them to/over target.
    if (sumBugs(ps.hand) >= TARGET) {
      ps.status = sumBugs(ps.hand) > TARGET ? 'busted' : 'stood';
      checkAllDone(code(), io);
    }
  });

  socket.on('bb:stand', () => {
    const ps = myState();
    if (!ps || ps.status !== 'playing') return;
    ps.status = 'stood';

    // Emit dealerFlip + dealerSnippets only when ALL are done (handled in runDealer).
    checkAllDone(code(), io);
  });

  socket.on('bb:double', async () => {
    const r  = round();
    const ps = myState();
    if (!r || !ps || ps.status !== 'playing') return;
    if (ps.hand.length !== 1)   return err('Can only double on your opening hand.');
    if (ps.bet * 2 > ps.chips)  return err('Not enough chips to double.');

    ps.doubled = true;
    socket.emit('bb:dealing', { stage: 'double' });
    const snip = await generate(drawCard());
    ps.hand.push(snip);

    socket.emit('bb:playerSnippet', { snippet: pub(snip), index: 1, canHit: false, canDouble: false, doubled: true });
    ps.status = sumBugs(ps.hand) > TARGET ? 'busted' : 'stood';
    checkAllDone(code(), io);
  });

  socket.on('bb:fold', () => {
    const ps = myState();
    if (!ps || ps.status !== 'playing') return;
    ps.folded = true;
    ps.status  = 'folded';
    checkAllDone(code(), io);
  });

  socket.on('bb:nextRound', () => {
    // Client asks to go back to betting — only valid when no round is active.
    if (!round()) {
      socket.emit('bb:state', { chips: getChips(socket.id), startChips: START_CHIPS, target: TARGET, dealerStandsAt: DEALER_STANDS });
    }
  });
}

function cleanupBugBlackjack(socketId) {
  playerChips.delete(socketId);
  // If the player was mid-round, auto-fold them.
  for (const [, round] of lobbyRounds) {
    const ps = round.players[socketId];
    if (ps && ps.status === 'playing') {
      ps.folded = true;
      ps.status  = 'folded';
    }
    const bet = round.bets && round.bets[socketId];
    if (bet) delete round.bets[socketId];
  }
}

module.exports = { registerBugBlackjack, cleanupBugBlackjack };
