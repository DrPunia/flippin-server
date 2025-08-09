// server.js - Flippin real-time server (Node.js + Socket.IO)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow all origins for now (tighten later to your domain)
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// Animal list (same used by client)
const ANIMALS = [
  { name: 'lion', emoji: '🦁' },
  { name: 'elephant', emoji: '🐘' },
  { name: 'fox', emoji: '🦊' },
  { name: 'frog', emoji: '🐸' },
  { name: 'cat', emoji: '🐱' },
  { name: 'dog', emoji: '🐶' },
  { name: 'panda', emoji: '🐼' },
  { name: 'rabbit', emoji: '🐰' },
  { name: 'tiger', emoji: '🐯' },
  { name: 'bear', emoji: '🐻' }
];

// In-memory rooms map
const rooms = {};

// Helpers
function shuffle(arr){
  for(let i = arr.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createNewGameState(){
  const cards = [];
  for(let i=0;i<ANIMALS.length;i++){
    const a = ANIMALS[i];
    cards.push({ pairId: i, animal: a.name, emoji: a.emoji, revealed: false, matched: false });
    cards.push({ pairId: i, animal: a.name, emoji: a.emoji, revealed: false, matched: false });
  }
  shuffle(cards);
  return {
    id: null,
    cards,
    players: [], // { id, name, matches, asked, extra, prevMatches }
    flipped: [], // indices currently revealed this turn
    currentPlayer: 0, // index into players
    timer: { remaining: 300, running: false, intervalId: null },
    log: [] // {type:'q'|'a'|'info', text, by}
  };
}

function questionsLeft(player){
  return 5 + (player.extra || 0) - (player.asked || 0);
}

function broadcastState(roomId){
  const r = rooms[roomId];
  if (!r) return;
  io.to(roomId).emit('state', {
    cards: r.cards,
    players: r.players.map(p => ({ name: p.name, matches: p.matches, asked: p.asked || 0, extra: p.extra || 0 })),
    currentPlayer: r.currentPlayer,
    timer: { remaining: r.timer.remaining, running: r.timer.running },
    log: r.log
  });
}

function startTimer(roomId){
  const r = rooms[roomId];
  if (!r) return;
  if (r.timer.running) return;
  r.timer.running = true;
  r.timer.intervalId = setInterval(()=>{
    r.timer.remaining -= 1;
    io.to(roomId).emit('timer', r.timer.remaining);
    if (r.timer.remaining <= 0){
      clearInterval(r.timer.intervalId);
      r.timer.running = false;
      io.to(roomId).emit('timeUp');
      r.log.unshift({ type:'info', text: 'Time is up.' });
      broadcastState(roomId);
    }
  }, 1000);
}

function pauseTimer(roomId){
  const r = rooms[roomId];
  if(!r) return;
  if (r.timer.intervalId) clearInterval(r.timer.intervalId);
  r.timer.running = false;
  io.to(roomId).emit('timerPaused');
}

function resumeTimer(roomId){
  const r = rooms[roomId];
  if(!r) return;
  if (r.timer.running) return;
  startTimer(roomId);
}

// Socket handlers
io.on('connection', socket => {
  console.log('conn', socket.id);

  // Create a room and join as player 1
  socket.on('createRoom', (cb) => {
    const roomId = Math.random().toString(36).slice(2,8);
    const g = createNewGameState();
    g.id = roomId;
    rooms[roomId] = g;
    // add player as Player 1
    g.players.push({ id: socket.id, name: 'Player 1', matches: 0, asked: 0, extra: 0, prevMatches: 0 });
    socket.join(roomId);
    console.log('room created', roomId);
    broadcastState(roomId);
    cb && cb({ ok: true, roomId, state: { players: g.players.length }});
  });

  // Join existing room
  socket.on('joinRoom', ({ roomId, name }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb && cb({ error: 'Room not found' });
    if (room.players.length >= 2) return cb && cb({ error: 'Room full' });
    room.players.push({ id: socket.id, name: name || 'Player 2', matches: 0, asked: 0, extra: 0, prevMatches: 0 });
    socket.join(roomId);
    // start timer when both players present
    room.log.unshift({ type: 'info', text: `${name || 'Player 2'} joined.` });
    broadcastState(roomId);
    startTimer(roomId);
    cb && cb({ ok: true, state: room });
  });

  // Flip card
  socket.on('flip', ({ roomId, idx }, cb) => {
    const room = rooms[roomId];
    if (!room) return;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;
    // not player's turn?
    if (room.currentPlayer !== playerIndex) return cb && cb({ error: 'Not your turn' });
    const card = room.cards[idx];
    if (!card || card.revealed || card.matched) return;
    // reveal
    card.revealed = true;
    room.flipped.push(idx);
    broadcastState(roomId);

    if (room.flipped.length === 2){
      const [a,b] = room.flipped;
      if (room.cards[a].pairId === room.cards[b].pairId){
        // match
        room.cards[a].matched = room.cards[b].matched = true;
        const p = room.players[playerIndex];
        p.matches = (p.matches || 0) + 1;
        // award extra question on every 3 matches
        if (p.matches % 3 === 0 && p.matches !== p.prevMatches){
          p.extra = (p.extra || 0) + 1;
          p.prevMatches = p.matches;
          room.log.unshift({ type:'info', text: `${p.name} earned an extra question.` });
        }
        room.log.unshift({ type:'info', text: `${room.players[playerIndex].name} found a pair (${room.cards[a].animal}).` });
        // pause timer and prompt asker to ask a question
        pauseTimer(roomId);
        broadcastState(roomId);
        // Ask only the winner to ask question
        io.to(room.players[playerIndex].id).emit('askQuestion', { remaining: questionsLeft(room.players[playerIndex]) });
      } else {
        // not match: flip back after short delay and switch turn
        setTimeout(()=>{
          room.cards[a].revealed = room.cards[b].revealed = false;
          room.flipped = [];
          room.currentPlayer = 1 - room.currentPlayer;
          room.log.unshift({ type:'info', text: `No match — ${room.players[room.currentPlayer].name}'s turn.` });
          broadcastState(roomId);
        }, 900);
      }
      // clear flipped if matched (we waited for Q&A)
      if (room.cards[a].matched && room.cards[b].matched){
        room.flipped = [];
        broadcastState(roomId);
      }
    }
    cb && cb({ ok: true });
  });

  // Player asks a question (after win)
  socket.on('askQuestion', ({ roomId, text }, cb) => {
    const room = rooms[roomId];
    if (!room) return;
    const askerIndex = room.players.findIndex(p => p.id === socket.id);
    if (askerIndex === -1) return;
    const asker = room.players[askerIndex];
    // reduce count if available
    if (questionsLeft(asker) <= 0) {
      socket.emit('noQuestions');
      return cb && cb({ error: 'No questions left' });
    }
    asker.asked = (asker.asked || 0) + 1;
    room.log.unshift({ type:'q', by: asker.name, text });
    // send question to opponent only
    const opponent = room.players.find(p => p.id !== socket.id);
    if (opponent){
      io.to(opponent.id).emit('questionForAnswer', { from: asker.name, text });
    }
    // keep paused until answer
    broadcastState(roomId);
    cb && cb({ ok: true });
  });

  // Opponent answers question
  socket.on('answerQuestion', ({ roomId, text }, cb) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id) || { name: 'Unknown' };
    room.log.unshift({ type: 'a', by: p.name, text });
    // broadcast the Q&A and resume timer
    io.to(roomId).emit('questionAnswered', { by: p.name, text });
    resumeTimer(roomId);
    broadcastState(roomId);
    cb && cb({ ok: true });
  });

  // handle disconnect: remove player and notify room
  socket.on('disconnect', () => {
    // find any rooms this socket was in
    for(const roomId of Object.keys(rooms)){
      const r = rooms[roomId];
      const idx = r.players.findIndex(p => p.id === socket.id);
      if (idx !== -1){
        const name = r.players[idx].name;
        r.players.splice(idx,1);
        r.log.unshift({ type:'info', text: `${name} disconnected.`});
        // notify remaining player
        io.to(roomId).emit('state', { players: r.players, cards: r.cards, currentPlayer: r.currentPlayer, timer: r.timer, log: r.log });
        // cleanup room if empty
        if (r.players.length === 0){
          if (r.timer.intervalId) clearInterval(r.timer.intervalId);
          delete rooms[roomId];
        }
      }
    }
  });

}); // end io.on

// Basic healthcheck
app.get('/', (req, res) => res.send('Flippin socket server is running'));

// Start
server.listen(PORT, () => {
  console.log('Server listening on port', PORT);
});
