/* Bug Blackjack — client.
 *
 * Flow:
 *   setup (place bet) → waiting (others placing bets) → playing → dealer turn → scoreboard
 *
 * Exposed as window.BugBlackjack with init({ socket, showScreen, onExit }) and start().
 */
window.BugBlackjack = (function () {
  let socket, showScreen, onExit, root;

  const OUTCOME_LABEL = {
    win: 'Win!', 'dealer-bust': 'Dealer Busts!', natural: 'Natural 21!',
    lose: 'Loss', bust: 'Bust!', push: 'Push', fold: 'Folded',
  };

  let ui = {
    chips: 0, startChips: 1000, target: 12,
    bet: 50, phase: 'setup',
    canHit: false, canDouble: false,
    standings: [],
  };

  // Dealer snippets collected during the dealer's live turn (before full reveal).
  let dealerLive   = [];
  let playerHand   = [];
  let currentBet   = 0;
  let dealerModel  = 'Claude';

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Topbar ────────────────────────────────────────────────────────────────
  function topbar() {
    return `
      <div class="bb-topbar">
        <div class="bb-title"><span class="chip-emoji">🃏</span> Bug Blackjack</div>
        <div class="bb-chips">
          <div class="label">Chips</div>
          <div class="value">${ui.chips.toLocaleString()}</div>
        </div>
      </div>`;
  }

  // ── Snippet renderer ──────────────────────────────────────────────────────
  function renderSnippet(snip, reveal) {
    const lines = (snip.code || '').replace(/\n$/, '').split('\n');
    const buggyLines = new Set(reveal && snip.bugs ? snip.bugs.map(b => Number(b.line)) : []);

    const codeHtml = lines.map((line, i) => {
      const n   = i + 1;
      const cls = reveal && buggyLines.has(n) ? 'ln buggy' : 'ln';
      return `<span class="${cls}">${esc(line) || ' '}</span>`;
    }).join('');

    const head = reveal
      ? `<span class="${snip.bugCount === 0 ? 'bb-snippet-count clean' : 'bb-snippet-count'}">${snip.bugCount} ${snip.bugCount === 1 ? 'bug' : 'bugs'}</span>`
      : `<span class="bb-snippet-count" style="color:#6b7280">? bugs</span>`;

    const bugList = reveal && snip.bugs && snip.bugs.length
      ? '<div class="bb-buglist">' + snip.bugs.map(b => `
          <div class="bb-bug">
            <span class="tag">${esc(b.type || 'bug')}</span>
            <span class="loc">line ${esc(b.line)}</span>
            <span>${esc(b.description || '')}</span>
          </div>`).join('') + '</div>'
      : '';

    return `
      <div class="bb-snippet">
        <div class="bb-snippet-head">
          <span class="bb-snippet-lang">java${snip.title ? ' · ' + esc(snip.title) : ''}</span>
          ${head}
        </div>
        <pre class="bb-code">${codeHtml}</pre>
        ${bugList}
      </div>`;
  }

  // ── Standings mini-table ──────────────────────────────────────────────────
  function renderStandings() {
    if (!ui.standings || ui.standings.length <= 1) return '';
    const sorted = [...ui.standings].sort((a, b) => b.chips - a.chips);
    const rows = sorted.map((p, i) => `
      <tr class="${p.isMe ? 'bb-row-me' : ''}">
        <td style="color:#6b7280">#${i + 1}</td>
        <td>${esc(p.name)}${p.isMe ? ' <span style="color:#6b7280;font-size:0.7rem">(you)</span>' : ''}</td>
        <td style="text-align:right;font-family:monospace;color:#fde047;font-weight:700">${p.chips.toLocaleString()}</td>
      </tr>`).join('');
    return `
      <div class="bb-label" style="margin-top:20px">Standings</div>
      <table class="bb-scoreboard" style="margin-bottom:0">
        <tbody>${rows}</tbody>
      </table>`;
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  function renderSetup() {
    ui.phase = 'setup';
    root.innerHTML = `
      <div class="bb-wrap">
        ${topbar()}
        <div class="bb-panel">
          <div class="bb-label">Place your bet</div>
          <div class="bb-bet-row">
            <input type="number" id="bb-bet" class="bb-bet-input" min="1" value="${ui.bet}" />
            <button class="bb-chip-btn" data-add="25">+25</button>
            <button class="bb-chip-btn" data-add="100">+100</button>
            <button class="bb-chip-btn" data-add="500">+500</button>
            <button class="bb-chip-btn allin" id="bb-allin">All in</button>
          </div>
          ${renderStandings()}
          <div id="bb-setup-error" class="error-msg" style="margin-top:14px"></div>
          <button class="btn btn-success" id="bb-deal" style="margin-top:16px">Ready — aim for ${ui.target} bugs</button>
          <button class="btn btn-secondary" id="bb-exit" style="margin-top:8px">Leave Table</button>
        </div>
      </div>`;

    const betInput = root.querySelector('#bb-bet');
    betInput.addEventListener('input', () => { ui.bet = Math.max(0, Math.floor(Number(betInput.value) || 0)); });
    root.querySelectorAll('[data-add]').forEach(el =>
      el.addEventListener('click', () => { ui.bet = Math.min(ui.chips, (ui.bet || 0) + Number(el.dataset.add)); betInput.value = ui.bet; })
    );
    root.querySelector('#bb-allin').addEventListener('click', () => { ui.bet = ui.chips; betInput.value = ui.bet; });
    root.querySelector('#bb-deal').addEventListener('click', placeBet);
    root.querySelector('#bb-exit').addEventListener('click', exit);
  }

  function placeBet() {
    const errEl = root.querySelector('#bb-setup-error');
    const bet = Math.floor(Number(root.querySelector('#bb-bet').value) || 0);
    if (bet <= 0)       { errEl.textContent = 'Place a bet to continue.'; errEl.classList.add('show'); return; }
    if (bet > ui.chips) { errEl.textContent = 'Not enough chips.';        errEl.classList.add('show'); return; }
    errEl.classList.remove('show');
    ui.bet = bet;
    currentBet = bet;
    socket.emit('bb:placeBet', { bet });
    renderWaiting([]);
  }

  // ── Waiting for others ────────────────────────────────────────────────────
  function renderWaiting(players) {
    ui.phase = 'waiting';
    const rows = players.map(p => `
      <li class="player-item">
        <span class="player-name">${esc(p.name)}</span>
        <span style="color:${p.ready ? '#34d399' : '#6b7280'};font-size:0.8rem">${p.ready ? 'Ready ✓' : 'Placing bet…'}</span>
      </li>`).join('');

    root.innerHTML = `
      <div class="bb-wrap">
        ${topbar()}
        <div class="bb-panel">
          <div class="bb-dealing"><span class="spinner"></span>Waiting for other players…</div>
          ${players.length ? `<ul class="player-list" style="margin-top:16px">${rows}</ul>` : ''}
        </div>
      </div>`;
  }

  // ── Playing ───────────────────────────────────────────────────────────────
  function renderDealing(msg) {
    root.innerHTML = `
      <div class="bb-wrap">
        ${topbar()}
        <div class="bb-panel">
          <div class="bb-dealing"><span class="spinner"></span>${esc(msg || 'Generating code…')}</div>
        </div>
      </div>`;
  }

  function renderTable(busy) {
    ui.phase = 'playing';
    const playerSnips = playerHand.map(s => renderSnippet(s, false)).join('');
    const dealerBack  = `<div class="bb-cardback">face-down snippet</div>`;

    const actions = busy
      ? `<div class="bb-dealing"><span class="spinner"></span>Generating snippet…</div>`
      : `<div class="bb-actions">
           <button class="btn btn-primary"   id="bb-hit"   ${ui.canHit    ? '' : 'disabled'}>Hit</button>
           <button class="btn btn-success"   id="bb-stand">Stand</button>
           <button class="btn btn-secondary" id="bb-dd"    ${ui.canDouble ? '' : 'disabled'}>Double Down</button>
           <button class="btn btn-danger"    id="bb-fold">Fold</button>
         </div>`;

    root.innerHTML = `
      <div class="bb-wrap">
        ${topbar()}
        <div class="bb-panel">
          <div class="bb-hand">
            <div class="bb-hand-head">
              <div class="bb-hand-title">Dealer</div>
              <div class="bb-hand-meta">hits until ${ui.dealerStandsAt || 9} bugs</div>
            </div>
            ${renderSnippet(dealerVisible, false)}
            ${dealerBack}
          </div>
          <div class="bb-hand">
            <div class="bb-hand-head">
              <div class="bb-hand-title">You</div>
              <div class="bb-hand-meta">bet ${currentBet} · target ${ui.target}</div>
            </div>
            ${playerSnips}
          </div>
          <div class="bb-hint" style="margin-bottom:12px">Count the bugs — go over ${ui.target} and you bust.</div>
          ${actions}
        </div>
      </div>`;

    if (!busy) {
      root.querySelector('#bb-hit').addEventListener('click', () => {
        socket.emit('bb:hit');
        renderTable(true);
      });
      root.querySelector('#bb-stand').addEventListener('click', () => {
        socket.emit('bb:stand');
        renderWaitingForDealer();
      });
      root.querySelector('#bb-dd').addEventListener('click', () => {
        if (!ui.canDouble) return;
        socket.emit('bb:double');
        renderDealing('Doubling down…');
      });
      root.querySelector('#bb-fold').addEventListener('click', () => {
        socket.emit('bb:fold');
        renderWaitingForDealer();
      });
    }
  }

  // Shown after standing/folding while waiting for other players + dealer.
  function renderWaitingForDealer() {
    ui.phase = 'waiting-dealer';
    const playerSnips = playerHand.map(s => renderSnippet(s, false)).join('');
    root.innerHTML = `
      <div class="bb-wrap">
        ${topbar()}
        <div class="bb-panel">
          <div class="bb-hand">
            <div class="bb-hand-head"><div class="bb-hand-title">Your hand (stood)</div></div>
            ${playerSnips}
          </div>
          <div class="bb-dealing" style="margin-top:12px"><span class="spinner"></span>Waiting for other players and dealer…</div>
        </div>
      </div>`;
  }

  // ── Dealer turn (live) ────────────────────────────────────────────────────
  function renderDealerTurn(thinking) {
    ui.phase = 'dealer-playing';
    const playerSnips = playerHand.map(s => renderSnippet(s, false)).join('');
    const dealerSnips = dealerLive.map(s => renderSnippet(s, false)).join('');

    root.innerHTML = `
      <div class="bb-wrap">
        ${topbar()}
        <div class="bb-panel">
          <div class="bb-hand">
            <div class="bb-hand-head">
              <div class="bb-hand-title">Dealer</div>
              <div class="bb-hand-meta">hitting until ${ui.dealerStandsAt || 9} bugs</div>
            </div>
            ${dealerSnips}
            ${thinking ? `<div class="bb-dealing"><span class="spinner"></span>Dealer drawing next snippet…</div>` : ''}
          </div>
          <div class="bb-hand">
            <div class="bb-hand-head"><div class="bb-hand-title">Your hand</div></div>
            ${playerSnips}
          </div>
        </div>
      </div>`;
  }

  // ── Scoreboard ────────────────────────────────────────────────────────────
  function renderScoreboard(data) {
    ui.phase = 'scoreboard';

    const dealerSnips  = data.dealer.map(s => renderSnippet(s, true)).join('');
    const myEntry      = data.scoreboard.find(p => p.socketId === socket.id);
    const myPlayerSnips = myEntry ? myEntry.hand.map(s => renderSnippet(s, true)).join('') : '';

    const rows = [...data.scoreboard]
      .sort((a, b) => b.chips - a.chips)
      .map((p, i) => {
        const isMe    = p.socketId === socket.id;
        const up      = p.delta > 0;
        const down    = p.delta < 0;
        const delta   = up ? `+${p.delta}` : `${p.delta}`;
        const outcome = OUTCOME_LABEL[p.outcome] || p.outcome;
        return `
          <tr class="${isMe ? 'bb-row-me' : ''}">
            <td>#${i + 1}</td>
            <td>${esc(p.name)}${isMe ? ' <span style="color:#6b7280;font-size:0.75rem">(you)</span>' : ''}</td>
            <td style="text-align:center">${p.playerTotal}</td>
            <td style="text-align:center">${esc(outcome)}</td>
            <td style="text-align:right;color:${up ? '#34d399' : down ? '#f87171' : '#9ca3af'};font-weight:700;font-family:monospace">${delta}</td>
            <td style="text-align:right;font-family:monospace;color:#fde047">${p.chips.toLocaleString()}</td>
          </tr>`;
      }).join('');

    const outOfChips = myEntry && myEntry.chips <= 0;

    root.innerHTML = `
      <div class="bb-wrap">
        ${topbar()}

        <div class="bb-panel">
          <div class="bb-label" style="margin-bottom:12px">Scoreboard — dealer had ${data.dealerTotal} bugs</div>
          <table class="bb-scoreboard">
            <thead>
              <tr>
                <th>#</th><th>Player</th><th style="text-align:center">Bugs</th>
                <th style="text-align:center">Result</th>
                <th style="text-align:right">+/−</th>
                <th style="text-align:right">Chips</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>

        <div class="bb-panel">
          <div class="bb-label">Dealer hand — ${data.dealerTotal} bugs</div>
          ${dealerSnips}
        </div>

        ${myEntry ? `
        <div class="bb-panel">
          <div class="bb-label">Your hand — ${myEntry.playerTotal} bugs</div>
          ${myPlayerSnips}
        </div>` : ''}

        <div class="bb-panel">
          ${outOfChips
            ? `<div class="bb-busted-note">You're out of chips!</div>
               <button class="btn btn-primary" id="bb-rebuy">Buy back in (${ui.startChips} chips)</button>`
            : `<button class="btn btn-success" id="bb-next">Play Next Round</button>`}
          <button class="btn btn-secondary" id="bb-exit2" style="margin-top:8px">Cash Out & Leave</button>
        </div>
      </div>`;

    root.querySelector('#bb-next')  ?.addEventListener('click', () => { socket.emit('bb:nextRound'); socket.emit('bb:init'); });
    root.querySelector('#bb-rebuy') ?.addEventListener('click', () => { ui.chips = ui.startChips; renderSetup(); });
    root.querySelector('#bb-exit2')  .addEventListener('click', exit);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  let dealerVisible = null;

  function exit() {
    if (typeof onExit === 'function') onExit();
  }

  // ── Socket listeners ──────────────────────────────────────────────────────
  function registerListeners() {
    socket.on('bb:state', s => {
      ui.chips          = s.chips;
      ui.startChips     = s.startChips;
      ui.target         = s.target;
      ui.dealerStandsAt = s.dealerStandsAt;
      ui.standings      = s.standings || [];
      if (ui.bet > ui.chips) ui.bet = Math.min(50, ui.chips);
      renderSetup();
    });

    socket.on('bb:betStatus', ({ players }) => {
      if (ui.phase === 'waiting') renderWaiting(players);
    });

    socket.on('bb:dealing', d => {
      if (ui.phase === 'setup' || ui.phase === 'waiting') {
        renderDealing(d && d.stage === 'double' ? 'Doubling down…' : 'Dealing…');
      }
    });

    socket.on('bb:dealt', d => {
      dealerLive    = [];
      playerHand    = d.player;
      dealerVisible = d.dealerVisible;
      currentBet    = d.bet;
      ui.chips      = d.chips;
      ui.canHit     = d.canHit;
      ui.canDouble  = d.canDouble;
      renderTable(false);
    });

    socket.on('bb:playerSnippet', d => {
      playerHand[d.index] = d.snippet;
      ui.canHit    = !!d.canHit;
      ui.canDouble = !!d.canDouble;
      if (!d.doubled) renderTable(false);
      else renderDealing('Doubling down — waiting for dealer…');
    });

    // Dealer flips hidden card — switch to dealer-turn view.
    socket.on('bb:dealerFlip', d => {
      dealerLive = [dealerVisible, d.snippet];
      renderDealerTurn(false);
    });

    socket.on('bb:dealerThinking', () => {
      renderDealerTurn(true);
    });

    socket.on('bb:dealerSnippet', d => {
      dealerLive.push(d.snippet);
      renderDealerTurn(false);
    });

    socket.on('bb:roundOver', data => {
      const me = data.scoreboard.find(p => p.socketId === socket.id);
      if (me) ui.chips = me.chips;
      renderScoreboard(data);
    });

    socket.on('bb:error', d => {
      if (ui.phase === 'setup') {
        const errEl = root.querySelector('#bb-setup-error');
        if (errEl) { errEl.textContent = d.message; errEl.classList.add('show'); }
      } else if (window.showToast) {
        window.showToast(d.message || 'Error');
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function init(opts) {
    socket     = opts.socket;
    showScreen = opts.showScreen;
    onExit     = opts.onExit;
    root       = document.getElementById('bb-root');
    registerListeners();
  }

  function start() {
    if (!root) root = document.getElementById('bb-root');
    showScreen('bugjack');
    renderDealing('Loading table…');
    socket.emit('bb:init');
  }

  return { init, start };
})();
