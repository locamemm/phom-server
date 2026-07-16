const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    allowEIO3: true
});

const PORT = process.env.PORT || 8080;

// Game Constants
const SUITS = [0, 1, 2, 3];
const RANKS = Array.from({ length: 13 }, (_, i) => i);

class Card {
    constructor(suit, rankIndex) {
        this.suit = suit;
        this.rankIndex = rankIndex;
        this.rank = rankIndex + 1;
        this.id = `card-${suit}-${rankIndex}`;
    }
}

class Room {
    constructor(id) {
        this.id = id;
        this.players = [];
        this.deck = [];
        this.drawPileCount = 0;
        this.tableDiscards = [[], [], [], []];
        this.currentTurnIdx = 0;
        this.dealerIdx = 0;
        this.gameStarted = false;
    }

    addPlayer(socketId, clientId, name, isBot = false) {
        if (this.players.length >= 4) return false;
        this.players.push({
            socketId,
            clientId,
            name,
            isBot,
            hand: [],
            melds: [],
            eaten: [],
            discards: [],
            isMom: false,
            isU: false
        });
        return true;
    }

    initGame() {
        this.gameStarted = true;
        this.createDeck();
        this.shuffleDeck();
        this.dealCards();
    }

    createDeck() {
        this.deck = [];
        for (let s of SUITS) {
            for (let r of RANKS) {
                this.deck.push(new Card(s, r));
            }
        }
    }

    shuffleDeck() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    dealCards() {
        this.players.forEach(p => p.hand = []);
        let cardsToDeal = 9 * 4 + 1;
        let curr = this.dealerIdx;
        let dealt = 0;
        while (dealt < cardsToDeal) {
            let limit = (curr === this.dealerIdx) ? 10 : 9;
            if (this.players[curr].hand.length < limit) {
                this.players[curr].hand.push(this.deck.pop());
                dealt++;
            }
            curr = (curr + 1) % 4;
        }
        this.drawPileCount = this.deck.length;
        this.currentTurnIdx = this.dealerIdx;
    }

    getGameState(clientId) {
        return {
            roomId: this.id,
            players: this.players.map((p, idx) => ({
                id: p.clientId,
                name: p.name,
                isBot: p.isBot,
                handCardCount: p.hand.length,
                hand: p.clientId === clientId ? p.hand : null,
                melds: p.melds,
                eaten: p.eaten,
                discards: p.discards
            })),
            tableDiscards: this.tableDiscards,
            drawPileCount: this.drawPileCount,
            currentTurnIdx: this.currentTurnIdx,
            dealerIdx: this.dealerIdx
        };
    }
}

const rooms = {};
// Map socket.id to roomId for fast lookup
const socketToRoom = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    const clientId = socket.id;

    socket.emit('message', { type: 'REGISTER', payload: { clientId } });

    socket.on('message', (data) => {
        const { type, payload } = data;

        switch (type) {
            case 'CREATE_ROOM': {
                const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
                const room = new Room(roomId);
                room.addPlayer(socket.id, clientId, payload.name || 'Chủ phòng');
                rooms[roomId] = room;
                socketToRoom[socket.id] = roomId;
                socket.join(roomId);
                socket.emit('message', { type: 'JOIN_SUCCESS', payload: { roomId, playerCount: 1, isHost: true } });
                console.log(`Room created: ${roomId} by ${socket.id}`);
                break;
            }

            case 'JOIN_ROOM': {
                const roomId = payload.roomId ? payload.roomId.toUpperCase() : '';
                const room = rooms[roomId];
                if (room && room.players.length < 4) {
                    room.addPlayer(socket.id, clientId, payload.name || 'Người chơi');
                    socketToRoom[socket.id] = roomId;
                    socket.join(roomId);
                    socket.emit('message', { type: 'JOIN_SUCCESS', payload: { roomId, playerCount: room.players.length, isHost: false } });
                    io.to(roomId).emit('message', { type: 'PLAYER_JOINED', payload: { playerCount: room.players.length } });

                    if (room.players.length === 4) {
                        room.initGame();
                        room.players.forEach(p => {
                            if (p.socketId) io.to(p.socketId).emit('message', { type: 'GAME_START', payload: room.getGameState(p.clientId) });
                        });
                    }
                } else {
                    socket.emit('message', { type: 'ERROR', payload: { message: 'Phòng không tồn tại hoặc đã đầy.' } });
                }
                break;
            }

            case 'ADD_BOT': {
                const roomId = socketToRoom[socket.id];
                const room = rooms[roomId];
                console.log(`ADD_BOT request for room: ${roomId}`);
                if (room && room.players.length < 4) {
                    const botNames = ['Lâm Híp', 'Bác Ba Phi', 'Chị Hoa', 'Anh Bốn'];
                    const name = botNames[room.players.length] || `Bot ${room.players.length}`;
                    room.addPlayer(null, `bot-${Date.now()}-${room.players.length}`, name, true);

                    io.to(roomId).emit('message', { type: 'PLAYER_JOINED', payload: { playerCount: room.players.length } });
                    console.log(`Bot added to room ${roomId}. Total: ${room.players.length}`);

                    if (room.players.length === 4) {
                        room.initGame();
                        room.players.forEach(p => {
                            if (p.socketId) {
                                io.to(p.socketId).emit('message', { type: 'GAME_START', payload: room.getGameState(p.clientId) });
                            }
                        });
                    }
                }
                break;
            }

            case 'PLAYER_ACTION': {
                const roomId = socketToRoom[socket.id];
                const room = rooms[roomId];
                if (!room) return;

                const playerIdx = room.players.findIndex(p => p.clientId === clientId);
                if (playerIdx !== room.currentTurnIdx) return;

                const { action } = payload;
                if (action === 'DISCARD') {
                    room.currentTurnIdx = (room.currentTurnIdx + 1) % 4;
                }

                room.players.forEach(p => {
                    if (p.socketId) {
                        io.to(p.socketId).emit('message', { type: 'GAME_STATE_UPDATE', payload: room.getGameState(p.clientId) });
                    }
                });
                break;
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete socketToRoom[socket.id];
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
