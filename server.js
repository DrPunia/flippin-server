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
