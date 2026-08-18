'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DRAW_TIME = 60;          // seconds per drawing turn
const CHOOSE_TIME = 12;        // seconds a drawer has to pick a word
const ROUND_END_DELAY = 10000;  // ms the correct word is shown before next turn
const MIN_PLAYERS_TO_START = 2;
const WORD_CHOICES = 4;

const DEFAULT_WORDS = [
  'apple', 'banana', 'guitar', 'elephant', 'mountain', 'rainbow', 'bicycle',
  'castle', 'dragon', 'football', 'sandwich', 'volcano', 'penguin', 'rocket',
  'umbrella', 'butterfly', 'campfire', 'skateboard', 'lighthouse', 'octopus',
  'pyramid', 'snowman', 'telescope', 'waterfall', 'jellyfish', 'kangaroo',
  'helicopter', 'sunflower', 'treasure', 'volleyball'
];

// roomCode -> Room
const rooms = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function parseWordList(raw) {
  if (typeof raw !== 'string') return [];
  const seen = new Set();
  const words = [];
  raw.split(',').forEach((w) => {
    const clean = w.trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    words.push(clean);
  });
  return words;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function publicPlayers(room) {
  // The host/owner is a spectator and is never included here - only actual
  // drawing/guessing participants show up on the scoreboard.
  return room.players.map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    connected: p.connected,
    isDrawing: p.id === room.currentDrawerId
  }));
}

function roomState(room) {
  return {
    code: room.code,
    ownerId: room.ownerId,
    ownerName: room.ownerName,
    players: publicPlayers(room),
    state: room.state,
    wordsRemaining: room.wordBank.length,
    // Round-by-round score card: each entry is one finished round's point
    // deltas, so the client can render a running table without having to
    // reconstruct history from individual roundEnd events.
    scoreHistory: room.scoreHistory
  };
}

function broadcastRoomState(room) {
  io.to(room.code).emit('roomUpdate', roomState(room));
}

function systemChat(room, text) {
  io.to(room.code).emit('chatMessage', {
    system: true,
    playerName: null,
    text,
    ts: Date.now()
  });
}

function connectedPlayers(room) {
  return room.players.filter((p) => p.connected);
}

function clearRoomTimers(room) {
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
  if (room.phaseTimeout) {
    clearTimeout(room.phaseTimeout);
    room.phaseTimeout = null;
  }
}

function maskWord(word) {
  return word.replace(/[^\s-]/g, '_');
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------
function startGame(room) {
  room.state = 'starting';
  room.turnOrder = shuffle(connectedPlayers(room).map((p) => p.id));
  room.turnPointer = -1;
  room.roundsCompleted = 0;
  room.scoreHistory = [];
  room.players.forEach((p) => { p.score = 0; });
  broadcastRoomState(room);
  beginNextTurn(room);
}

function pickNextDrawerId(room) {
  if (room.turnOrder.length === 0) return null;
  for (let i = 0; i < room.turnOrder.length; i++) {
    room.turnPointer = (room.turnPointer + 1) % room.turnOrder.length;
    const candidateId = room.turnOrder[room.turnPointer];
    const player = room.players.find((p) => p.id === candidateId);
    if (player && player.connected) return candidateId;
  }
  return null;
}

function beginNextTurn(room) {
  clearRoomTimers(room);
  room.currentWord = null;
  room.currentDrawerId = null;
  room.correctGuessers = new Set();
  room.attemptedGuessers = new Set();
  room.roundGuessLog = [];
  room.drawingLog = [];
  // Snapshot everyone's score so the round-end score card can show each
  // player's point delta for just this round.
  room.players.forEach((p) => { p.roundStartScore = p.score; });

  if (room.wordBank.length === 0) {
    return endGame(room);
  }

  const drawerId = pickNextDrawerId(room);
  if (!drawerId) {
    return endGame(room);
  }

  const drawer = room.players.find((p) => p.id === drawerId);
  room.currentDrawerId = drawerId;
  room.currentDrawerName = drawer.name;
  room.state = 'choosing';

  const numChoices = Math.min(WORD_CHOICES, room.wordBank.length);
  const indices = shuffle(room.wordBank.map((_, i) => i)).slice(0, numChoices);
  room.pendingChoiceIndices = indices;
  const choices = indices.map((i) => room.wordBank[i]);

  broadcastRoomState(room);
  systemChat(room, `${drawer.name} is choosing a word...`);

  io.to(drawerId).emit('chooseWord', { choices, timeLeft: CHOOSE_TIME });
  room.players.forEach((p) => {
    if (p.id !== drawerId) {
      io.to(p.id).emit('waitingForWord', { drawerName: drawer.name, timeLeft: CHOOSE_TIME });
    }
  });
  // The host is a spectator, not part of room.players - notify them separately.
  if (room.ownerId) {
    io.to(room.ownerId).emit('waitingForWord', { drawerName: drawer.name, timeLeft: CHOOSE_TIME });
  }

  // Auto-pick if the drawer doesn't choose in time
  room.phaseTimeout = setTimeout(() => {
    if (room.state === 'choosing') {
      selectWordForRoom(room, choices[0]);
    }
  }, CHOOSE_TIME * 1000);
}

function selectWordForRoom(room, word) {
  if (room.state !== 'choosing') return;
  clearRoomTimers(room);

  // Permanently remove the chosen word from the global bank.
  const idx = room.wordBank.findIndex((w) => w.toLowerCase() === word.toLowerCase());
  if (idx !== -1) room.wordBank.splice(idx, 1);

  room.currentWord = word;
  room.state = 'drawing';
  room.timeLeft = DRAW_TIME;
  room.drawingLog = [];

  const drawer = room.players.find((p) => p.id === room.currentDrawerId);
  broadcastRoomState(room);

  io.to(room.currentDrawerId).emit('roundStart', {
    drawerId: drawer.id,
    drawerName: drawer.name,
    isDrawer: true,
    word: room.currentWord,
    wordLength: room.currentWord.length,
    timeLeft: room.timeLeft
  });

  room.players.forEach((p) => {
    if (p.id !== room.currentDrawerId) {
      io.to(p.id).emit('roundStart', {
        drawerId: drawer.id,
        drawerName: drawer.name,
        isDrawer: false,
        maskedWord: maskWord(room.currentWord),
        wordLength: room.currentWord.length,
        timeLeft: room.timeLeft
      });
    }
  });

  // The host wrote the word list, so there's no spoiler risk in showing them
  // the real word - it also lets them follow along as a spectator.
  if (room.ownerId) {
    io.to(room.ownerId).emit('roundStart', {
      drawerId: drawer.id,
      drawerName: drawer.name,
      isDrawer: false,
      isOwner: true,
      word: room.currentWord,
      wordLength: room.currentWord.length,
      timeLeft: room.timeLeft
    });
  }

  room.tickInterval = setInterval(() => {
    room.timeLeft -= 1;
    io.to(room.code).emit('timerUpdate', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      endTurn(room, 'timeout');
    }
  }, 1000);
}

function endTurn(room, reason) {
  if (room.state !== 'drawing' && room.state !== 'choosing') return;
  clearRoomTimers(room);
  room.state = 'roundEnd';
  room.roundsCompleted += 1;

  const word = room.currentWord;
  const drawerName = room.currentDrawerName || null;

  // Build this round's score-card row: every player's point delta since the
  // snapshot taken at the start of the turn, plus their running total.
  const roundScores = room.players.map((p) => ({
    playerId: p.id,
    playerName: p.name,
    pointsEarned: p.score - (p.roundStartScore ?? p.score),
    total: p.score
  }));
  room.scoreHistory.push({
    round: room.roundsCompleted,
    drawerName,
    word: word || null,
    scores: roundScores
  });

  broadcastRoomState(room);
  io.to(room.code).emit('roundEnd', {
    word: word || null,
    drawerName,
    reason,
    scores: publicPlayers(room),
    // Every guess made this round - right or wrong - is withheld from other
    // players while it's live; this is the first moment everyone (players +
    // host) sees who guessed what.
    guesses: room.roundGuessLog,
    roundScores
  });

  room.currentDrawerId = null;
  room.currentDrawerName = null;
  room.currentWord = null;

  room.phaseTimeout = setTimeout(() => {
    beginNextTurn(room);
  }, ROUND_END_DELAY);
}

function endGame(room, options = {}) {
  clearRoomTimers(room);
  room.state = 'gameEnd';
  room.currentDrawerId = null;
  room.currentWord = null;

  const finalScores = publicPlayers(room);
  const winner = finalScores.reduce(
    (best, p) => (!best || p.score > best.score ? p : best),
    null
  );

  broadcastRoomState(room);
  io.to(room.code).emit('gameEnd', {
    finalScores,
    winner: winner ? { playerName: winner.name, score: winner.score } : null,
    terminatedByOwner: !!options.terminatedByOwner
  });
}

// ---------------------------------------------------------------------------
// Socket handling
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.data.roomCode = null;

  socket.on('createRoom', ({ playerName, words }, ack) => {
    const name = (playerName || '').trim().slice(0, 20) || 'Host';
    const customWords = parseWordList(words);
    const wordBank = customWords.length >= 3 ? customWords : DEFAULT_WORDS.slice();

    const code = generateRoomCode();
    const room = {
      code,
      ownerId: socket.id,
      ownerName: name,
      // The room owner is a host/spectator: they supplied the word list, so
      // they never draw, guess, or score - they are intentionally NOT added
      // to room.players.
      players: [],
      wordBank,
      state: 'lobby',
      turnOrder: [],
      turnPointer: -1,
      currentDrawerId: null,
      currentDrawerName: null,
      currentWord: null,
      pendingChoiceIndices: [],
      correctGuessers: new Set(),
      attemptedGuessers: new Set(),
      roundGuessLog: [],
      scoreHistory: [],
      drawingLog: [],
      tickInterval: null,
      phaseTimeout: null,
      timeLeft: 0,
      roundsCompleted: 0
    };
    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;

    if (typeof ack === 'function') {
      ack({ ok: true, roomCode: code, playerId: socket.id, role: 'owner' });
    }
    broadcastRoomState(room);
  });

  socket.on('joinRoom', ({ playerName, roomCode }, ack) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Room not found.' });
      return;
    }
    const name = (playerName || '').trim().slice(0, 20) || 'Player';
    const nameTaken = room.players.some((p) => p.connected && p.name.toLowerCase() === name.toLowerCase())
      || (room.ownerName && room.ownerName.toLowerCase() === name.toLowerCase());
    if (nameTaken) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Name already taken in this room.' });
      return;
    }

    room.players.push({ id: socket.id, name, score: 0, connected: true });
    if (room.state !== 'lobby') {
      room.turnOrder.push(socket.id);
    }

    socket.join(code);
    socket.data.roomCode = code;

    if (typeof ack === 'function') {
      ack({ ok: true, roomCode: code, playerId: socket.id, role: 'player' });
    }

    systemChat(room, `${name} joined the room.`);
    broadcastRoomState(room);

    // Bring the newcomer up to speed if a round is already in progress.
    if (room.state === 'drawing' && room.currentWord) {
      socket.emit('roundStart', {
        drawerId: room.currentDrawerId,
        drawerName: room.currentDrawerName,
        isDrawer: false,
        maskedWord: maskWord(room.currentWord),
        wordLength: room.currentWord.length,
        timeLeft: room.timeLeft
      });
      socket.emit('canvasSync', { log: room.drawingLog });
    } else if (room.state === 'choosing') {
      socket.emit('waitingForWord', { drawerName: room.currentDrawerName, timeLeft: CHOOSE_TIME });
    }
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.ownerId !== socket.id) return;
    if (room.state !== 'lobby') return;
    if (connectedPlayers(room).length < MIN_PLAYERS_TO_START) {
      socket.emit('errorMsg', `Need at least ${MIN_PLAYERS_TO_START} players to start.`);
      return;
    }
    if (room.wordBank.length === 0) {
      socket.emit('errorMsg', 'Word bank is empty.');
      return;
    }
    startGame(room);
  });

  socket.on('endGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.ownerId !== socket.id) return;
    if (room.state === 'lobby' || room.state === 'gameEnd') return;
    systemChat(room, `${room.ownerName} (Host) ended the game.`);
    endGame(room, { terminatedByOwner: true });
  });

  socket.on('endRound', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.ownerId !== socket.id) return;
    // A round only ever ends when the clock runs out or the host cuts it
    // short - never automatically just because everyone's guessed.
    if (room.state !== 'drawing' && room.state !== 'choosing') return;
    systemChat(room, `${room.ownerName} (Host) ended the round.`);
    endTurn(room, 'ownerEndedRound');
  });

  socket.on('selectWord', ({ word }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.state !== 'choosing' || room.currentDrawerId !== socket.id) return;
    const idx = room.pendingChoiceIndices
      .map((i) => room.wordBank[i])
      .findIndex((w) => w.toLowerCase() === (word || '').toLowerCase());
    if (idx === -1) return;
    selectWordForRoom(room, room.wordBank[room.pendingChoiceIndices[idx]]);
  });

  socket.on('drawStep', (step) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.state !== 'drawing' || room.currentDrawerId !== socket.id) return;
    room.drawingLog.push(step);
    socket.to(room.code).emit('drawStep', step);
  });

  socket.on('clearCanvas', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.currentDrawerId !== socket.id) return;
    room.drawingLog = [];
    socket.to(room.code).emit('clearCanvas');
  });

  socket.on('chatMessage', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const isOwnerSender = room.ownerId === socket.id;
    const player = room.players.find((p) => p.id === socket.id);
    if (!isOwnerSender && !player) return;

    // The host is a spectator: they watch and moderate, but never chat -
    // reject anything sent from the owner's socket outright.
    if (isOwnerSender) return;

    const clean = (text || '').trim().slice(0, 200);
    if (!clean) return;

    const isDrawing = room.state === 'drawing';
    const isDrawer = room.currentDrawerId === socket.id;

    // Drawers cannot chat during their own turn.
    if (isDrawing && isDrawer) return;

    if (isDrawing && !isDrawer) {
      // Each player gets exactly one guess per round - once it's used
      // (right or wrong), further messages this round are rejected.
      if (room.attemptedGuessers.has(socket.id)) {
        socket.emit('chatMessage', {
          system: true,
          playerName: null,
          text: "You've already used your one guess for this round.",
          ts: Date.now()
        });
        return;
      }
      room.attemptedGuessers.add(socket.id);

      const isCorrect = clean.toLowerCase() === room.currentWord.toLowerCase();
      let points = 0;

      if (isCorrect) {
        room.correctGuessers.add(socket.id);
        points = Math.max(room.timeLeft * 3, 10);
        player.score += points;
        const drawer = room.players.find((p) => p.id === room.currentDrawerId);
        if (drawer) drawer.score += 15;
        broadcastRoomState(room);
      }

      // The guess itself - right or wrong - is logged for the round-end
      // reveal, which shows everyone who guessed what once the round is over.
      room.roundGuessLog.push({ playerName: player.name, text: clean, correct: isCorrect, points });

      // Live feedback stays private to the guesser and the host (who already
      // knows the word); other players learn nothing until the round ends.
      socket.emit('chatMessage', {
        system: true,
        playerName: null,
        text: isCorrect ? `You guessed it! (+${points} pts)` : "Guess submitted - that was your one attempt this round.",
        ts: Date.now()
      });
      if (room.ownerId) {
        io.to(room.ownerId).emit('chatMessage', {
          system: false,
          playerName: `${player.name}${isCorrect ? ' (correct!)' : ' (wrong)'}`,
          text: clean,
          ts: Date.now()
        });
      }

      // The round keeps running regardless of who's guessed - it only ends
      // on timeout or when the host cuts it short via 'endRound'.
      return;
    }

    // Outside a live round (lobby / choosing a word / between rounds) chat is
    // normal, open banter.
    io.to(room.code).emit('chatMessage', {
      system: false,
      playerName: player.name,
      text: clean,
      ts: Date.now()
    });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    const wasOwner = room.ownerId === socket.id;
    const player = room.players.find((p) => p.id === socket.id);
    const wasDrawer = room.currentDrawerId === socket.id;

    if (player) {
      room.players = room.players.filter((p) => p.id !== socket.id);
      systemChat(room, `${player.name} left the room.`);
    }

    if (wasOwner) {
      systemChat(room, `${room.ownerName} (Host) has left.`);
      if (room.state === 'lobby' && room.players.length > 0) {
        // Promote the next player in line to host so the room isn't stranded
        // without anyone able to start the game.
        const promoted = room.players.shift();
        room.ownerId = promoted.id;
        room.ownerName = promoted.name;
        systemChat(room, `${promoted.name} is now the host.`);
      } else {
        // Mid-game (or nobody left to promote): the game keeps running for
        // the remaining players without a spectating host.
        room.ownerId = null;
      }
    }

    if (!room.ownerId && room.players.length === 0) {
      clearRoomTimers(room);
      rooms.delete(code);
      return;
    }

    if (wasDrawer && (room.state === 'drawing' || room.state === 'choosing')) {
      // The drawer leaving is the one thing that still force-ends a round
      // immediately - there's nobody left to draw. Any other player leaving
      // just updates the room state; the round itself keeps running.
      endTurn(room, 'drawerLeft');
    } else {
      broadcastRoomState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sketch & Guess running at http://localhost:${PORT}`);
});
