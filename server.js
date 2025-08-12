// server.js - Flippin real-time server (Node.js + Socket.IO)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

const ANIMALS = [
    { name: 'lion', emoji: '🦁' }, { name: 'elephant', emoji: '🐘' },
    { name: 'fox', emoji: '🦊' }, { name: 'frog', emoji: '🐸' },
    { name: 'cat', emoji: '🐱' }, { name: 'dog', emoji: '🐶' },
    { name: 'panda', emoji: '🐼' }, { name: 'rabbit', emoji: '🐰' },
    { name: 'tiger', emoji: '🐯' }, { name: 'bear', emoji: '🐻' }
];

const rooms = {};

// --- Helper Functions ---

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        // This is the missing line that defines j
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
        players: [],
        flipped: [],
        currentPlayer: 0,
        timer: { remaining: 180, running: false, intervalId: null },
        log: [],
        gameOver: false
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
        chatLog: r.log.filter(item => item.type === 'q' || item.type === 'a') // Send only chat messages
    });
}

function checkGameOver(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameOver) return;

    const totalMatches = (room.players[0]?.matches || 0) + (room.players[1]?.matches || 0);
    let winner = null;

    if (totalMatches === 10) {
        pauseTimer(roomId);
        room.gameOver = true;
        winner = room.players[0].matches > room.players[1].matches ? room.players[0] : room.players[1];
        if (room.players[0].matches === room.players[1].matches) winner = { name: "It's a tie!" };
    } else if (room.timer.remaining <= 0) {
        room.gameOver = true;
        winner = room.players[0].matches > room.players[1].matches ? room.players[0] : (room.players[1]?.matches > room.players[0]?.matches ? room.players[1] : null);
        if (room.players[0].matches === room.players[1]?.matches) winner = { name: "It's a tie!" };
    }

    if (winner) {
        io.to(roomId).emit('gameOver', { winnerName: winner.name });
    }
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
            checkGameOver(roomId); // Check for winner when time is up
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

io.on('connection', socket => {
    const playerName = socket.handshake.query.name || `Player #${Math.floor(Math.random() * 1000)}`;
    console.log('Connection established:', playerName, socket.id);
    const ROOM_ID = 'default';

    const room = rooms[ROOM_ID] ?? (rooms[ROOM_ID] = createNewGameState());
    socket.join(ROOM_ID);

    if (room.players.length < 2 && !room.players.find(p => p.id === socket.id)) {
        room.players.push({
            id: socket.id,
            name: playerName,
            matches: 0, asked: 0, extra: 0, prevMatches: 0
        });
        room.log.unshift({ type: 'info', text: `${playerName} has joined.` });
    }

    if (room.players.length === 2 && !room.timer.running && !room.gameOver) {
        startTimer(ROOM_ID);
    }

    socket.emit('roomAssigned', { roomId: ROOM_ID });
    broadcastState(ROOM_ID);

    socket.on('rematch', (_, cb) => {
        const room = rooms[ROOM_ID];
        if (!room) return cb && cb({ ok: false, error: 'No game found.' });
        if (room.players.length !== 2) return cb && cb({ ok: false, error: 'Waiting for opponent.' });

        const playerNames = room.players.map(p => p.name);
        const newGame = createNewGameState();
        newGame.players = room.players.map((p, i) => ({ ...p, name: playerNames[i], matches: 0, asked: 0, extra: 0, prevMatches: 0 }));
        rooms[ROOM_ID] = newGame;
        
        startTimer(ROOM_ID);
        broadcastState(ROOM_ID);
        io.to(ROOM_ID).emit('gameReset');
        cb && cb({ ok: true });
    });

    socket.on('flip', ({ idx }, cb) => {
        const room = rooms[ROOM_ID];
        if (!room || room.gameOver) return;
        
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex === -1 || room.currentPlayer !== playerIndex) {
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

            if (cardA.pairId === cardB.pairId) {
                cardA.matched = cardB.matched = true;
                const player = room.players[playerIndex];
                player.matches++;
                room.log.unshift({ type: 'info', text: `${player.name} found a pair (${cardA.animal}).` });
                room.flipped = [];
                
                pauseTimer(ROOM_ID);
                broadcastState(ROOM_ID);
                io.to(player.id).emit('askQuestion', { remaining: questionsLeft(player) });
                checkGameOver(ROOM_ID);
            } else {
                setTimeout(() => {
                    cardA.revealed = cardB.revealed = false;
                    room.flipped = [];
                    room.currentPlayer = 1 - room.currentPlayer;
                    room.log.unshift({ type: 'info', text: `No match. It's now ${room.players[room.currentPlayer]?.name}'s turn.` });
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
        if (!asker) return;
        asker.asked = (asker.asked || 0) + 1;
        room.log.unshift({ type: 'q', by: asker.name, text });
        
        const opponent = room.players.find(p => p.id !== socket.id);
        if (opponent) io.to(opponent.id).emit('questionForAnswer', { from: asker.name, text });
        
        broadcastState(ROOM_ID);
        cb && cb({ ok: true });
    });

    socket.on('answerQuestion', ({ text }, cb) => {
        const room = rooms[ROOM_ID];
        if (!room) return;
        const answerer = room.players.find(p => p.id === socket.id) || { name: 'Unknown' };
        room.log.unshift({ type: 'a', by: answerer.name, text });
        
        io.to(ROOM_ID).emit('questionAnswered', { by: answerer.name, text });
        if (!room.gameOver) resumeTimer(ROOM_ID);
        broadcastState(ROOM_ID);
        cb && cb({ ok: true });
    });

    socket.on('disconnect', () => {
        console.log('Disconnection:', socket.id);
        const room = rooms[ROOM_ID];
        if (room) {
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                const name = room.players[idx].name;
                room.players.splice(idx, 1);
                room.log.unshift({ type: 'info', text: `${name} has disconnected.` });
                
                pauseTimer(ROOM_ID);
                if (room.players.length < 2) room.gameOver = true;
                broadcastState(ROOM_ID);
                
                if (room.players.length === 0) {
                    if (room.timer.intervalId) clearInterval(room.timer.intervalId);
                    delete rooms[ROOM_ID];
                    console.log(`Cleaned up empty room: ${ROOM_ID}`);
                }
            }
        }
    });
});

app.get('/', (req, res) => res.send('Flippin socket server is running'));
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
