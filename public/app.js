'use strict';

const socket = io();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let myId = null;
let myRoomCode = null;
let isOwner = false;
let isDrawer = false;
let currentState = 'lobby';
let drawing = false;
let lastPoint = null;
let latestScoreHistory = [];
let latestPlayers = [];

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------
const screens = {
  entry: document.getElementById('screen-entry'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game')
};

const el = {
  inputName: document.getElementById('input-name'),
  inputWords: document.getElementById('input-words'),
  inputCode: document.getElementById('input-code'),
  btnCreate: document.getElementById('btn-create'),
  btnJoin: document.getElementById('btn-join'),
  entryError: document.getElementById('entry-error'),
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabPanels: document.querySelectorAll('.tab-panel'),

  lobbyRoomCode: document.getElementById('lobby-room-code'),
  lobbyHostLine: document.getElementById('lobby-host-line'),
  lobbyPlayers: document.getElementById('lobby-players'),
  lobbyWordCount: document.getElementById('lobby-word-count'),
  btnStart: document.getElementById('btn-start'),
  lobbyWaitMsg: document.getElementById('lobby-wait-msg'),

  scorecardTable: document.getElementById('scorecard-table'),
  btnEndRound: document.getElementById('btn-end-round'),
  btnEndGame: document.getElementById('btn-end-game'),
  statusWord: document.getElementById('status-word'),
  statusRole: document.getElementById('status-role'),
  statusTimer: document.getElementById('status-timer'),
  canvas: document.getElementById('draw-canvas'),
  overlayChoose: document.getElementById('overlay-choose'),
  chooseButtons: document.getElementById('choose-buttons'),
  overlayWaiting: document.getElementById('overlay-waiting'),
  waitingText: document.getElementById('waiting-text'),
  overlayRoundEnd: document.getElementById('overlay-roundend'),
  roundEndText: document.getElementById('roundend-text'),
  overlayRoundGuesses: document.getElementById('overlay-round-guesses'),
  roundEndGuesses: document.getElementById('roundend-guesses'),
  btnCloseRoundGuesses: document.getElementById('btn-close-round-guesses'),
  overlayGameEnd: document.getElementById('overlay-gameend'),
  gameEndWinner: document.getElementById('gameend-winner'),
  gameEndScores: document.getElementById('gameend-scores'),
  btnReload: document.getElementById('btn-reload'),
  toolbar: document.getElementById('toolbar'),
  colorPicker: document.getElementById('color-picker'),
  swatches: document.getElementById('swatches'),
  brushSize: document.getElementById('brush-size'),
  btnClear: document.getElementById('btn-clear'),

  chatLog: document.getElementById('chat-log'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  chatHostNote: document.getElementById('chat-host-note')
};

const ctx = el.canvas.getContext('2d');
ctx.lineJoin = 'round';
ctx.lineCap = 'round';

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

function hideAllOverlays() {
  el.overlayChoose.classList.add('hidden');
  el.overlayWaiting.classList.add('hidden');
  el.overlayRoundEnd.classList.add('hidden');
  el.overlayRoundGuesses.classList.add('hidden');
  el.overlayGameEnd.classList.add('hidden');
}

// Builds a Player x Round score-card table: each cell is the point delta a
// player earned that round, with a running Total column on the right.
function renderScoreTable(tableEl, scoreHistory, players) {
  if (!scoreHistory.length || !players.length) {
    tableEl.innerHTML = '<tr><td>No rounds completed yet.</td></tr>';
    return;
  }

  const sortedPlayers = players.slice().sort((a, b) => b.score - a.score);

  const headerCells = [`<th>Player</th>`]
    .concat(scoreHistory.map((r) => `<th>R${r.round}</th>`))
    .concat(['<th class="total">Total</th>'])
    .join('');

  const rows = sortedPlayers.map((p) => {
    const cells = scoreHistory.map((r) => {
      const entry = r.scores.find((s) => s.playerId === p.id);
      if (!entry) return '<td class="zero">–</td>';
      const val = entry.pointsEarned;
      const cls = val > 0 ? 'positive' : 'zero';
      return `<td class="${cls}">${val > 0 ? `+${val}` : val}</td>`;
    }).join('');
    const rowClass = p.isDrawing ? ' class="drawing"' : '';
    const name = `${p.isDrawing ? '✏️ ' : ''}${escapeHtml(p.name)}`;
    return `<tr${rowClass}><td>${name}</td>${cells}<td class="total">${p.score}</td></tr>`;
  }).join('');

  tableEl.innerHTML = `<thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody>`;
}

// ---------------------------------------------------------------------------
// Entry screen: tabs + create/join
// ---------------------------------------------------------------------------
el.tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    el.tabBtns.forEach((b) => b.classList.remove('active'));
    el.tabPanels.forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

function setEntryError(msg) {
  el.entryError.textContent = msg || '';
}

el.btnCreate.addEventListener('click', () => {
  const playerName = el.inputName.value.trim();
  if (!playerName) return setEntryError('Please enter your name.');
  setEntryError('');
  el.btnCreate.disabled = true;
  socket.emit('createRoom', { playerName, words: el.inputWords.value }, (res) => {
    el.btnCreate.disabled = false;
    if (!res.ok) return setEntryError(res.error || 'Could not create room.');
    myId = res.playerId;
    myRoomCode = res.roomCode;
    isOwner = true;
    showScreen('lobby');
  });
});

el.btnJoin.addEventListener('click', () => {
  const playerName = el.inputName.value.trim();
  const roomCode = el.inputCode.value.trim().toUpperCase();
  if (!playerName) return setEntryError('Please enter your name.');
  if (roomCode.length !== 5) return setEntryError('Room code must be 5 characters.');
  setEntryError('');
  el.btnJoin.disabled = true;
  socket.emit('joinRoom', { playerName, roomCode }, (res) => {
    el.btnJoin.disabled = false;
    if (!res.ok) return setEntryError(res.error || 'Could not join room.');
    myId = res.playerId;
    myRoomCode = res.roomCode;
    isOwner = false;
    showScreen('lobby');
  });
});

// ---------------------------------------------------------------------------
// Lobby / room state
// ---------------------------------------------------------------------------
el.btnStart.addEventListener('click', () => {
  socket.emit('startGame');
});

socket.on('errorMsg', (msg) => {
  setEntryError(msg);
  // eslint-disable-next-line no-alert
  alert(msg);
});

socket.on('roomUpdate', (state) => {
  currentState = state.state;
  isOwner = state.ownerId === myId;
  el.statusRole.classList.toggle('hidden', !isOwner);
  latestScoreHistory = state.scoreHistory || [];
  latestPlayers = state.players;

  // The host is watch-only - never gets a chat box, only the log.
  el.chatForm.classList.toggle('hidden', isOwner);
  el.chatHostNote.classList.toggle('hidden', !isOwner);

  const canEndGame = isOwner && state.state !== 'lobby' && state.state !== 'gameEnd';
  el.btnEndGame.classList.toggle('hidden', !canEndGame);

  const canEndRound = isOwner && (state.state === 'drawing' || state.state === 'choosing');
  el.btnEndRound.classList.toggle('hidden', !canEndRound);

  // Score card sidebar is always visible and live - re-render on every update.
  renderScoreTable(el.scorecardTable, latestScoreHistory, latestPlayers);

  if (state.state === 'lobby') {
    renderLobby(state);
    showScreen('lobby');
  } else {
    showScreen('game');
  }
});

el.btnCloseRoundGuesses.addEventListener('click', () => {
  el.overlayRoundGuesses.classList.add('hidden');
});

el.btnEndGame.addEventListener('click', () => {
  // eslint-disable-next-line no-alert
  if (confirm('End the game now for everyone and reveal the final scores?')) {
    socket.emit('endGame');
  }
});

el.btnEndRound.addEventListener('click', () => {
  // A round never ends just because everyone's guessed - only the clock
  // running out or this button does it - so this is a deliberate action,
  // not something that needs a confirm dialog in the way.
  socket.emit('endRound');
});

function renderLobby(state) {
  el.lobbyRoomCode.textContent = state.code;
  el.lobbyHostLine.textContent = state.ownerName
    ? `Hosted by ${state.ownerName} (spectating, won't play)`
    : 'No host currently connected.';
  el.lobbyPlayers.innerHTML = '';
  state.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(p.name)}</span>`;
    el.lobbyPlayers.appendChild(li);
  });
  el.lobbyWordCount.textContent = `${state.wordsRemaining} word(s) in the bank.`;

  if (isOwner) {
    el.btnStart.classList.remove('hidden');
    el.lobbyWaitMsg.classList.add('hidden');
  } else {
    el.btnStart.classList.add('hidden');
    el.lobbyWaitMsg.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Turn flow
// ---------------------------------------------------------------------------
socket.on('waitingForWord', ({ drawerName }) => {
  hideAllOverlays();
  isDrawer = false;
  setCanvasInteractive(false);
  el.waitingText.textContent = `Waiting for ${drawerName} to choose a word…`;
  el.overlayWaiting.classList.remove('hidden');
  el.statusWord.textContent = '';
  clearCanvasLocal();
});

socket.on('chooseWord', ({ choices }) => {
  hideAllOverlays();
  isDrawer = true;
  setCanvasInteractive(false); // can't draw until a word is picked
  el.chooseButtons.innerHTML = '';
  choices.forEach((word) => {
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = word;
    btn.addEventListener('click', () => {
      socket.emit('selectWord', { word });
      el.overlayChoose.classList.add('hidden');
    });
    el.chooseButtons.appendChild(btn);
  });
  el.overlayChoose.classList.remove('hidden');
  clearCanvasLocal();
});

socket.on('roundStart', (payload) => {
  hideAllOverlays();
  clearCanvasLocal();
  isDrawer = payload.isDrawer;
  setCanvasInteractive(isDrawer);
  el.toolbar.classList.toggle('hidden', !isDrawer);
  el.chatInput.disabled = isDrawer;
  el.chatInput.placeholder = isDrawer ? "You can't chat while drawing" : 'Type your guess…';

  if (isDrawer) {
    el.statusWord.textContent = payload.word.toUpperCase();
  } else if (payload.isOwner) {
    // The host already wrote the word list, so they get the real word too.
    el.statusWord.textContent = `${payload.word.toUpperCase()} (visible to you as host)`;
  } else {
    el.statusWord.textContent = payload.maskedWord.split('').join(' ');
  }
  updateTimer(payload.timeLeft);
});

socket.on('timerUpdate', ({ timeLeft }) => updateTimer(timeLeft));

function updateTimer(timeLeft) {
  el.statusTimer.textContent = timeLeft;
  el.statusTimer.style.color = timeLeft <= 5 ? 'var(--danger)' : '';
}

socket.on('roundEnd', ({ word, drawerName, reason, guesses }) => {
  hideAllOverlays();
  setCanvasInteractive(false);
  el.chatInput.disabled = true;
  isDrawer = false;
  el.toolbar.classList.add('hidden');

  let msg;
  if (reason === 'drawerLeft') {
    msg = word
      ? `${drawerName || 'The drawer'} left. The word was "${word}".`
      : `${drawerName || 'The drawer'} left before finishing this round.`;
  } else if (reason === 'ownerEndedRound') {
    msg = word ? `The host ended the round. The word was "${word}".` : 'The host ended the round.';
  } else {
    // reason === 'timeout'
    msg = `Time's up! The word was "${word}".`;
  }
  el.roundEndText.textContent = msg;
  el.overlayRoundEnd.classList.remove('hidden');
  el.statusWord.textContent = word ? word.toUpperCase() : '';

  // Every guess made this round - right or wrong - was hidden while the
  // round was live; a dedicated pop-out (separate from the reveal banner
  // above) is the first place everyone sees who guessed what.
  el.roundEndGuesses.innerHTML = '';
  if (guesses && guesses.length) {
    guesses.forEach((g) => {
      const li = document.createElement('li');
      li.className = g.correct ? 'correct' : 'wrong';
      li.innerHTML = `<span>${g.correct ? '✅' : '❌'} <strong>${escapeHtml(g.playerName)}</strong>: "${escapeHtml(g.text)}"</span>` +
        (g.correct ? `<span class="guess-points">+${g.points}</span>` : '');
      el.roundEndGuesses.appendChild(li);
    });
  } else if (word) {
    const li = document.createElement('li');
    li.className = 'info';
    li.textContent = 'No one guessed this round.';
    el.roundEndGuesses.appendChild(li);
  }
  if ((guesses && guesses.length) || word) {
    el.overlayRoundGuesses.classList.remove('hidden');
  }
});

socket.on('gameEnd', ({ finalScores, winner, terminatedByOwner }) => {
  hideAllOverlays();
  setCanvasInteractive(false);
  el.chatInput.disabled = true;
  el.toolbar.classList.add('hidden');

  const prefix = terminatedByOwner ? 'Game ended by the host. ' : '';
  el.gameEndWinner.textContent = winner
    ? `${prefix}🏆 ${winner.playerName} wins with ${winner.score} points!`
    : `${prefix}No players scored this game.`;

  const sorted = finalScores.slice().sort((a, b) => b.score - a.score);
  el.gameEndScores.innerHTML = '';
  sorted.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${i === 0 ? '🥇 ' : ''}${escapeHtml(p.name)}</span><span>${p.score} pts</span>`;
    el.gameEndScores.appendChild(li);
  });
  el.overlayGameEnd.classList.remove('hidden');
});

el.btnReload.addEventListener('click', () => window.location.reload());

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  socket.emit('chatMessage', { text });
  el.chatInput.value = '';
});

socket.on('chatMessage', ({ system, playerName, text }) => {
  const div = document.createElement('div');
  div.className = 'chat-line' + (system ? ' system' : '');
  if (system) {
    div.textContent = text;
  } else {
    div.innerHTML = `<span class="name">${escapeHtml(playerName)}:</span>${escapeHtml(text)}`;
  }
  appendChat(div);
});

function appendChat(node) {
  el.chatLog.appendChild(node);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Canvas drawing
// ---------------------------------------------------------------------------
const SWATCH_COLORS = ['#1a1a1a', '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#ffffff'];
SWATCH_COLORS.forEach((c, i) => {
  const s = document.createElement('div');
  s.className = 'swatch' + (i === 0 ? ' active' : '');
  s.style.background = c;
  s.addEventListener('click', () => {
    el.colorPicker.value = c;
    document.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
    s.classList.add('active');
  });
  el.swatches.appendChild(s);
});

function setCanvasInteractive(active) {
  el.canvas.classList.toggle('locked', !active);
}

function getCanvasPoint(e) {
  const rect = el.canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const scaleX = el.canvas.width / rect.width;
  const scaleY = el.canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  };
}

function drawSegment(x0, y0, x1, y1, color, size) {
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function clearCanvasLocal() {
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
}

function startDraw(e) {
  if (!isDrawer || currentState !== 'drawing') return;
  drawing = true;
  lastPoint = getCanvasPoint(e);
}

function moveDraw(e) {
  if (!drawing || !isDrawer || currentState !== 'drawing') return;
  const p = getCanvasPoint(e);
  const color = el.colorPicker.value;
  const size = Number(el.brushSize.value);
  drawSegment(lastPoint.x, lastPoint.y, p.x, p.y, color, size);
  socket.emit('drawStep', { x0: lastPoint.x, y0: lastPoint.y, x1: p.x, y1: p.y, color, size });
  lastPoint = p;
}

function endDraw() {
  drawing = false;
  lastPoint = null;
}

el.canvas.addEventListener('mousedown', startDraw);
el.canvas.addEventListener('mousemove', moveDraw);
window.addEventListener('mouseup', endDraw);
el.canvas.addEventListener('mouseleave', endDraw);

el.canvas.addEventListener('touchstart', (e) => { e.preventDefault(); startDraw(e); }, { passive: false });
el.canvas.addEventListener('touchmove', (e) => { e.preventDefault(); moveDraw(e); }, { passive: false });
el.canvas.addEventListener('touchend', (e) => { e.preventDefault(); endDraw(); }, { passive: false });

el.btnClear.addEventListener('click', () => {
  if (!isDrawer) return;
  clearCanvasLocal();
  socket.emit('clearCanvas');
});

socket.on('drawStep', ({ x0, y0, x1, y1, color, size }) => {
  drawSegment(x0, y0, x1, y1, color, size);
});

socket.on('clearCanvas', () => clearCanvasLocal());

socket.on('canvasSync', ({ log }) => {
  clearCanvasLocal();
  log.forEach(({ x0, y0, x1, y1, color, size }) => drawSegment(x0, y0, x1, y1, color, size));
});
