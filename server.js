// server.js - Flippin real-time server (Node.js + Socket.IO)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow all origins for development.
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// Animal list for creating card pairs
const ANIMALS = [
    { name: 'lion', emoji: '🦁' }, { name: 'elephant', emoji: '🐘' },
    { name: 'fox', emoji: '🦊' }, { name: 'frog', emoji: '🐸' },
    { name: 'cat', emoji: '🐱' }, { name: 'dog', emoji: '🐶' },
    { name: 'panda', emoji: '🐼' }, { name: 'rabbit', emoji: '🐰' },
    { name: 'tiger', emoji: '🐯' }, { name: 'bear', emoji: '🐻' }
];

// In-memory storage for game rooms
const rooms = {};

// --- Helper Functions ---

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function createNewGameState() {
    const cards = [];
    for (let i = 0; i < ANIMALS.length; i++) {
        const a = ANIMALS[i];
        cards.push({ pairId: i, animal: a.name, emoji: a.emoji, revealed: false, matched: false });
        cards.push({ pairId: i, animal: a.name, emoji: a.emoji, revealed: false, matched: false });
    }
    shuffle(cards);
    return {
        id: 'default',
        cards,
        players: [], // { id, name, matches, asked, extra, prevMatches }
        flipped: [], // Indices of cards revealed this turn
        currentPlayer: 0, // Index into players array
        timer: { remaining: 180, running: false, intervalId: null },
        log: [] // History of game events
    };
}

function questionsLeft(player) {
    return 5 + (player.extra || 0) - (player.asked || 0);
}

function broadcastState(roomId) {
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

function startTimer(roomId) {
    const r = rooms[roomId];
    if (!r || r.timer.running) return;
    r.timer.running = true;
    r.timer.intervalId = setInterval(() => {
        r.timer.remaining -= 1;
        io.to(roomId).emit('timer', r.timer.remaining);
        if (r.timer.remaining <= 0) {
            clearInterval(r.timer.intervalId);
            r.timer.running = false;
            io.to(roomId).emit('timeUp');
            r.log.unshift({ type: 'info', text: 'Time is up.' });
            broadcastState(roomId);
        }
    }, 1000);
}

function pauseTimer(roomId) {
    const r = rooms[roomId];
    if (!r || !r.timer.running) return;
    clearInterval(r.timer.intervalId);
    r.timer.running = false;
    io.to(roomId).emit('timerPaused');
}

function resumeTimer(roomId) {
    const r = rooms[roomId];
    if (!r || r.timer.running) return;
    startTimer(roomId);
}

// --- Main Socket Connection Handler ---
io.on('connection', socket => {
    console.log('Connection established:', socket.id);
    const ROOM_ID = 'default';

    const room = rooms[ROOM_ID] ?? (rooms[ROOM_ID] = createNewGameState());
    socket.join(ROOM_ID);

    if (room.players.length < 2 && !room.players.find(p => p.id === socket.id)) {
        const playerName = room.players.length === 0 ? 'Player 1' : 'Player 2';
        room.players.push({
            id: socket.id,
            name: playerName,
            matches: 0, asked: 0, extra: 0, prevMatches: 0
        });
        room.log.unshift({ type: 'info', text: `${playerName} has joined.` });
    }

    if (room.players.length === 2 && !room.timer.running) {
        startTimer(ROOM_ID);
    }

    socket.emit('roomAssigned', { roomId: ROOM_ID });
    broadcastState(ROOM_ID);

    socket.on('rematch', (_, cb) => {
        const room = rooms[ROOM_ID];
        if (!room) return cb && cb({ ok: false, error: 'No game found.' });
        if (room.players.length !== 2) return cb && cb({ ok: false, error: 'Waiting for opponent.' });

        const newGame = createNewGameState();
        newGame.players = room.players.map(p => ({ ...p, matches: 0, asked: 0, extra: 0, prevMatches: 0 }));
        rooms[ROOM_ID] = newGame;
        
        startTimer(ROOM_ID);
        broadcastState(ROOM_ID);
        cb && cb({ ok: true });
    });

    socket.on('flip', ({ idx }, cb) => {
        const room = rooms[ROOM_ID];
        if (!room) return;
        
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1) return;

        if (room.currentPlayer !== playerIndex) {
            return cb && cb({ ok: false, error: "Not your turn." });
        }

        const card = room.cards[idx];
        if (!card || card.revealed || card.matched || room.flipped.length >= 2) return;

        card.revealed = true;
        room.flipped.push(idx);
        broadcastState(ROOM_ID);

        if (room.flipped.length === 2) {
            const [idxA, idxB] = room.flipped;
            const cardA = room.cards[idxA];
            const cardB = room.cards[idxB];

            if (cardA.pairId === cardB.pairId) { // It's a match
                cardA.matched = cardB.matched = true;
                const player = room.players[playerIndex];
                player.matches++;
                if (player.matches % 3 === 0 && player.matches !== player.prevMatches) {
                    player.extra = (player.extra || 0) + 1;
                    player.prevMatches = player.matches;
                    room.log.unshift({ type: 'info', text: `${player.name} earned an extra question.` });
                }
                room.log.unshift({ type: 'info', text: `${player.name} found a pair (${cardA.animal}).` });
                room.flipped = [];
                
                pauseTimer(ROOM_ID);
                broadcastState(ROOM_ID);
                io.to(player.id).emit('askQuestion', { remaining: questionsLeft(player) });
            } else { // Not a match
                setTimeout(() => {
                    cardA.revealed = cardB.revealed = false;
                    room.flipped = [];
                    room.currentPlayer = 1 - room.currentPlayer; // Switch turns
                    room.log.unshift({ type: 'info', text: `No match. It's now ${room.players[room.currentPlayer].name}'s turn.` });
                    broadcastState(ROOM_ID);
                }, 900);
            }
        }
        cb && cb({ ok: true });
    });

    socket.on('askQuestion', ({ text }, cb) => {
        const room = rooms[ROOM_ID];
        if (!room) return;

        const asker = room.players.find(p => p.id === socket.id);
        if (!asker || questionsLeft(asker) <= 0) {
            return cb && cb({ ok: false, error: 'No questions left or invalid player.' });
        }

        asker.asked = (asker.asked || 0) + 1;
        room.log.unshift({ type: 'q', by: asker.name, text });
        
        const opponent = room.players.find(p => p.id !== socket.id);
        if (opponent) {
            io.to(opponent.id).emit('questionForAnswer', { from: asker.name, text });
        }
        
        broadcastState(ROOM_ID);
        cb && cb({ ok: true });
    });

    socket.on('answerQuestion', ({ text }, cb) => {
        const room = rooms[ROOM_ID];
        if (!room) return;

        const answerer = room.players.find(p => p.id === socket.id) || { name: 'Unknown' };
        room.log.unshift({ type: 'a', by: answerer.name, text });
        
        io.to(ROOM_ID).emit('questionAnswered', { by: answerer.name, text });
        resumeTimer(ROOM_ID);
        broadcastState(ROOM_ID);
        cb && cb({ ok: true });
    });

    socket.on('disconnect', () => {
        console.log('Disconnection:', socket.id);
        for (const roomId of Object.keys(rooms)) {
            const r = rooms[roomId];
            const idx = r.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                const name = r.players[idx].name;
                r.players.splice(idx, 1);
                r.log.unshift({ type: 'info', text: `${name} has disconnected.` });
                
                pauseTimer(roomId);
                broadcastState(roomId);
                
                if (r.players.length === 0) {
                    if (r.timer.intervalId) clearInterval(r.timer.intervalId);
                    delete rooms[roomId];
                    console.log(`Cleaned up empty room: ${roomId}`);
                }
                break;
            }
        }
    });
});

// Basic healthcheck
app.get('/', (req, res) => {
    res.send('Flippin socket server is running');
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
