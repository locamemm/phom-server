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
        this.drawPile = [];
        this.tableDiscards = [[], [], [], []];
        this.currentTurnIdx = 0;
        this.dealerIdx = 0;
        this.gameStarted = false;
        this.lastDiscardedCard = null;
        this.lastDiscardedPlayerIdx = -1;
        this.turnStep = 'ACTION'; // 'ACTION' or 'DISCARD'
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
            discardCount: 0
        });
        return true;
    }

    initGame() {
        this.gameStarted = true;
        this.tableDiscards = [[], [], [], []];
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
        this.players.forEach(p => { p.hand = []; p.discards = []; p.eaten = []; p.melds = []; p.discardCount = 0; });
        this.drawPile = [...this.deck];
        let cardsToDeal = 9 * 4 + 1;
        let curr = this.dealerIdx;
        let dealt = 0;
        while (dealt < cardsToDeal) {
            let limit = (curr === this.dealerIdx) ? 10 : 9;
            if (this.players[curr].hand.length < limit) {
                this.players[curr].hand.push(this.drawPile.pop());
                dealt++;
            }
            curr = (curr + 1) % 4;
        }
        this.currentTurnIdx = this.dealerIdx;
        this.turnStep = this.players[this.currentTurnIdx].hand.length === 10 ? 'DISCARD' : 'ACTION';
    }

    getGameState(clientId) {
        return {
            roomId: this.id,
            players: this.players.map((p) => ({
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
            drawPileCount: this.drawPile.length,
            currentTurnIdx: this.currentTurnIdx,
            dealerIdx: this.dealerIdx,
            lastDiscardedCard: this.lastDiscardedCard,
            turnStep: this.turnStep
        };
    }
}

const rooms = {};
const socketToRoom = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    const clientId = socket.id;

    socket.emit('message', { type: 'REGISTER', payload: { clientId } });

    socket.on('message', (data) => {
        const { type, payload } = data;
        const roomId = socketToRoom[socket.id];
        const room = rooms[roomId];

        switch (type) {
            case 'CREATE_ROOM': {
                const newRoomId = Math.random().toString(36).substring(2, 8).toUpperCase();
                const newRoom = new Room(newRoomId);
                newRoom.addPlayer(socket.id, clientId, payload.name || 'Chủ phòng');
                rooms[newRoomId] = newRoom;
                socketToRoom[socket.id] = newRoomId;
                socket.join(newRoomId);
                socket.emit('message', { type: 'JOIN_SUCCESS', payload: { roomId: newRoomId, playerCount: 1, isHost: true } });
                break;
            }

            case 'JOIN_ROOM': {
                const jRoomId = payload.roomId ? payload.roomId.toUpperCase() : '';
                const jRoom = rooms[jRoomId];
                if (jRoom && jRoom.players.length < 4) {
                    jRoom.addPlayer(socket.id, clientId, payload.name || 'Người chơi');
                    socketToRoom[socket.id] = jRoomId;
                    socket.join(jRoomId);
                    socket.emit('message', { type: 'JOIN_SUCCESS', payload: { roomId: jRoomId, playerCount: jRoom.players.length, isHost: false } });
                    io.to(jRoomId).emit('message', { type: 'PLAYER_JOINED', payload: { playerCount: jRoom.players.length } });

                    if (jRoom.players.length === 4) {
                        jRoom.initGame();
                        jRoom.players.forEach(p => {
                            if (p.socketId) io.to(p.socketId).emit('message', { type: 'GAME_START', payload: jRoom.getGameState(p.clientId) });
                        });
                    }
                } else {
                    socket.emit('message', { type: 'ERROR', payload: { message: 'Phòng không tồn tại hoặc đã đầy.' } });
                }
                break;
            }

            case 'ADD_BOT': {
                if (room && room.players.length < 4) {
                    const botNames = ['Lâm Híp', 'Bác Ba Phi', 'Chị Hoa', 'Anh Bốn'];
                    const name = botNames[room.players.length] || `Bot ${room.players.length}`;
                    room.addPlayer(null, `bot-${Date.now()}`, name, true);
                    io.to(roomId).emit('message', { type: 'PLAYER_JOINED', payload: { playerCount: room.players.length } });
                    if (room.players.length === 4) {
                        room.initGame();
                        room.players.forEach(p => {
                            if (p.socketId) io.to(p.socketId).emit('message', { type: 'GAME_START', payload: room.getGameState(p.clientId) });
                        });
                    }
                }
                break;
            }

            case 'PLAYER_ACTION': {
                if (!room) return;
                const playerIdx = room.players.findIndex(p => p.clientId === clientId);
                if (playerIdx !== room.currentTurnIdx) return;

                const { action, cardId, cardIds } = payload;
                const player = room.players[playerIdx];

                if (action === 'DRAW' && room.turnStep === 'ACTION') {
                    if (room.drawPile.length > 0) {
                        player.hand.push(room.drawPile.pop());
                        room.turnStep = 'DISCARD';
                    }
                } else if (action === 'DISCARD' && room.turnStep === 'DISCARD') {
                    const cIdx = player.hand.findIndex(c => c.id === cardId);
                    if (cIdx !== -1) {
                        const card = player.hand.splice(cIdx, 1)[0];
                        room.tableDiscards[playerIdx].push(card);
                        room.lastDiscardedCard = card;
                        room.lastDiscardedPlayerIdx = playerIdx;
                        player.discardCount++;

                        // Chuyển lượt
                        room.currentTurnIdx = (room.currentTurnIdx + 1) % 4;
                        room.turnStep = 'ACTION';
                    }
                } else if (action === 'EAT' && room.turnStep === 'ACTION') {
                    if (room.lastDiscardedCard && cardIds) {
                        const eatenCard = room.lastDiscardedCard;
                        const caCards = player.hand.filter(c => cardIds.includes(c.id));

                        if (caCards.length >= 2) {
                            // Xóa cạ khỏi tay
                            player.hand = player.hand.filter(c => !cardIds.includes(c.id));
                            // Thêm phỏm ăn vào danh sách
                            player.eaten.push([eatenCard, ...caCards]);
                            // Xóa bài khỏi bàn
                            room.tableDiscards[room.lastDiscardedPlayerIdx].pop();
                            room.lastDiscardedCard = null;
                            room.turnStep = 'DISCARD';
                        }
                    }
                }

                // Gửi cập nhật cho mọi người
                room.players.forEach(p => {
                    if (p.socketId) io.to(p.socketId).emit('message', { type: 'GAME_STATE_UPDATE', payload: room.getGameState(p.clientId) });
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
