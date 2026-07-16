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

// --- AI LOGIC HELPERS ---
function findAllPhoms(cards) {
    let phoms = [];
    for (let r = 1; r <= 13; r++) {
        let rankCards = cards.filter(c => c.rank === r);
        if (rankCards.length >= 3) {
            phoms.push(rankCards);
            if (rankCards.length === 4) {
                for (let i = 0; i < 4; i++) {
                    phoms.push(rankCards.filter((_, idx) => idx !== i));
                }
            }
        }
    }
    for (let s = 0; s < 4; s++) {
        let suitCards = cards.filter(c => c.suit === s).sort((a, b) => a.rank - b.rank);
        for (let i = 0; i < suitCards.length; i++) {
            for (let len = 3; len <= suitCards.length - i; len++) {
                let sub = suitCards.slice(i, i + len);
                let isConsec = true;
                for (let k = 1; k < sub.length; k++) {
                    if (sub[k].rank !== sub[k-1].rank + 1) {
                        isConsec = false;
                        break;
                    }
                }
                if (isConsec) phoms.push(sub);
            }
        }
    }
    return phoms;
}

function getBestPartitions(cards) {
    let allPhoms = findAllPhoms(cards);
    let bestScore = Infinity;
    let bestPhoms = [];
    let bestRacs = [...cards];
    function backtrack(index, currentPhoms, usedCardIds) {
        let currentRacs = cards.filter(c => !usedCardIds.has(c.id));
        let totalRubbishScore = currentRacs.reduce((sum, c) => sum + c.rank, 0);
        let totalPhomCards = cards.length - currentRacs.length;
        let scoreIndex = (totalPhomCards * -1000) + totalRubbishScore;
        if (scoreIndex < bestScore) {
            bestScore = scoreIndex;
            bestPhoms = [...currentPhoms];
            bestRacs = currentRacs;
        }
        for (let i = index; i < allPhoms.length; i++) {
            let phom = allPhoms[i];
            let overlap = phom.some(c => usedCardIds.has(c.id));
            if (!overlap) {
                phom.forEach(c => usedCardIds.add(c.id));
                currentPhoms.push(phom);
                backtrack(i + 1, currentPhoms, usedCardIds);
                currentPhoms.pop();
                phom.forEach(c => usedCardIds.delete(c.id));
            }
        }
    }
    backtrack(0, [], new Set());
    return { phoms: bestPhoms, racs: bestRacs, score: bestRacs.reduce((sum, c) => sum + c.rank, 0) };
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
        this.turnStep = 'ACTION';
        this.botTimeout = null;
    }

    addPlayer(socketId, clientId, name, isBot = false) {
        if (this.players.length >= 4) return false;
        this.players.push({
            socketId, clientId, name, isBot,
            hand: [], melds: [], eaten: [], discards: [], discardCount: 0
        });
        return true;
    }

    initGame() {
        console.log(`Initializing game for room ${this.id}`);
        this.gameStarted = true;
        this.tableDiscards = [[], [], [], []];
        this.lastDiscardedCard = null;
        this.lastDiscardedPlayerIdx = -1;
        this.createDeck();
        this.shuffleDeck();
        this.dealCards();
        this.broadcastGameStart();
        this.checkBotTurn();
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
                id: p.clientId, name: p.name, isBot: p.isBot,
                handCardCount: p.hand.length,
                hand: p.clientId === clientId ? p.hand : null,
                melds: p.melds, eaten: p.eaten, discards: p.discards
            })),
            tableDiscards: this.tableDiscards,
            drawPileCount: this.drawPile.length,
            currentTurnIdx: this.currentTurnIdx,
            dealerIdx: this.dealerIdx,
            lastDiscardedCard: this.lastDiscardedCard,
            turnStep: this.turnStep
        };
    }

    broadcastGameStart() {
        console.log(`Broadcasting GAME_START to room ${this.id}`);
        this.players.forEach(p => {
            if (p.socketId) {
                io.to(p.socketId).emit('message', {
                    type: 'GAME_START',
                    payload: this.getGameState(p.clientId)
                });
            }
        });
    }

    broadcastUpdate() {
        this.players.forEach(p => {
            if (p.socketId) {
                io.to(p.socketId).emit('message', {
                    type: 'GAME_STATE_UPDATE',
                    payload: this.getGameState(p.clientId)
                });
            }
        });
    }

    checkBotTurn() {
        if (!this.gameStarted) return;
        const player = this.players[this.currentTurnIdx];
        if (player && player.isBot) {
            if (this.botTimeout) clearTimeout(this.botTimeout);
            this.botTimeout = setTimeout(() => this.runBotAI(), 1500);
        }
    }

    runBotAI() {
        const bot = this.players[this.currentTurnIdx];
        if (!bot || !bot.isBot || !this.gameStarted) return;

        console.log(`Bot AI thinking: ${bot.name} (Step: ${this.turnStep})`);

        if (this.turnStep === 'ACTION') {
            let ate = false;
            if (this.lastDiscardedCard && this.lastDiscardedPlayerIdx !== this.currentTurnIdx) {
                const testHand = [...bot.hand, this.lastDiscardedCard];
                const withEat = getBestPartitions(testHand);
                const withoutEat = getBestPartitions(bot.hand);

                if (withEat.phoms.length > withoutEat.phoms.length) {
                    const phom = withEat.phoms.find(p => p.some(c => c.id === this.lastDiscardedCard.id));
                    if (phom) {
                        const caIds = phom.filter(c => c.id !== this.lastDiscardedCard.id).map(c => c.id);
                        bot.hand = bot.hand.filter(c => !caIds.includes(c.id));
                        bot.eaten.push([this.lastDiscardedCard, ...phom.filter(c => c.id !== this.lastDiscardedCard.id)]);
                        this.tableDiscards[this.lastDiscardedPlayerIdx].pop();
                        this.lastDiscardedCard = null;
                        this.turnStep = 'DISCARD';
                        ate = true;
                        console.log(`Bot ${bot.name} ATE card`);
                    }
                }
            }

            if (!ate) {
                if (this.drawPile.length > 0) {
                    bot.hand.push(this.drawPile.pop());
                    this.turnStep = 'DISCARD';
                    console.log(`Bot ${bot.name} DREW card`);
                } else {
                    this.currentTurnIdx = (this.currentTurnIdx + 1) % 4;
                    this.turnStep = 'ACTION';
                }
            }
            this.broadcastUpdate();
            this.checkBotTurn();
        } else if (this.turnStep === 'DISCARD') {
            const partition = getBestPartitions(bot.hand);
            const discardCard = partition.racs.length > 0
                ? partition.racs.sort((a,b) => b.rank - a.rank)[0]
                : bot.hand[0];

            if (discardCard) {
                const idx = bot.hand.findIndex(c => c.id === discardCard.id);
                bot.hand.splice(idx, 1);
                this.tableDiscards[this.currentTurnIdx].push(discardCard);
                this.lastDiscardedCard = discardCard;
                this.lastDiscardedPlayerIdx = this.currentTurnIdx;
                bot.discardCount++;
                console.log(`Bot ${bot.name} DISCARDED ${discardCard.id}`);
            }

            this.currentTurnIdx = (this.currentTurnIdx + 1) % 4;
            this.turnStep = 'ACTION';
            this.broadcastUpdate();
            this.checkBotTurn();
        }
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
                const newId = Math.random().toString(36).substring(2, 8).toUpperCase();
                const newRoom = new Room(newId);
                newRoom.addPlayer(socket.id, clientId, payload.name || 'Chủ phòng');
                rooms[newId] = newRoom;
                socketToRoom[socket.id] = newId;
                socket.join(newId);
                socket.emit('message', { type: 'JOIN_SUCCESS', payload: { roomId: newId, playerCount: 1, isHost: true } });
                break;
            }
            case 'JOIN_ROOM': {
                const rId = payload.roomId ? payload.roomId.toUpperCase() : '';
                const r = rooms[rId];
                if (r && r.players.length < 4) {
                    r.addPlayer(socket.id, clientId, payload.name || 'Người chơi');
                    socketToRoom[socket.id] = rId;
                    socket.join(rId);
                    socket.emit('message', { type: 'JOIN_SUCCESS', payload: { roomId: rId, playerCount: r.players.length, isHost: false } });
                    io.to(rId).emit('message', { type: 'PLAYER_JOINED', payload: { playerCount: r.players.length } });
                    if (r.players.length === 4) r.initGame();
                } else {
                    socket.emit('message', { type: 'ERROR', payload: { message: 'Phòng đầy hoặc không tồn tại.' } });
                }
                break;
            }
            case 'ADD_BOT': {
                if (room && room.players.length < 4) {
                    const botNames = ['Lâm Híp', 'Bác Ba Phi', 'Chị Hoa', 'Anh Bốn'];
                    const botId = `bot-${Date.now()}-${room.players.length}`;
                    room.addPlayer(null, botId, botNames[room.players.length] || 'Máy', true);
                    io.to(roomId).emit('message', { type: 'PLAYER_JOINED', payload: { playerCount: room.players.length } });
                    if (room.players.length === 4) room.initGame();
                }
                break;
            }
            case 'PLAYER_ACTION': {
                if (!room) return;
                const pIdx = room.players.findIndex(p => p.clientId === clientId);
                if (pIdx !== room.currentTurnIdx) return;
                const { action, cardId, cardIds } = payload;
                const p = room.players[pIdx];

                if (action === 'DRAW' && room.turnStep === 'ACTION') {
                    if (room.drawPile.length > 0) { p.hand.push(room.drawPile.pop()); room.turnStep = 'DISCARD'; }
                } else if (action === 'DISCARD' && room.turnStep === 'DISCARD') {
                    const cIdx = p.hand.findIndex(c => c.id === cardId);
                    if (cIdx !== -1) {
                        const card = p.hand.splice(cIdx, 1)[0];
                        room.tableDiscards[pIdx].push(card);
                        room.lastDiscardedCard = card;
                        room.lastDiscardedPlayerIdx = pIdx;
                        p.discardCount++;
                        room.currentTurnIdx = (room.currentTurnIdx + 1) % 4;
                        room.turnStep = 'ACTION';
                    }
                } else if (action === 'EAT' && room.turnStep === 'ACTION') {
                    if (room.lastDiscardedCard && cardIds) {
                        const caCards = p.hand.filter(c => cardIds.includes(c.id));
                        if (caCards.length >= 2) {
                            p.hand = p.hand.filter(c => !cardIds.includes(c.id));
                            p.eaten.push([room.lastDiscardedCard, ...caCards]);
                            room.tableDiscards[room.lastDiscardedPlayerIdx].pop();
                            room.lastDiscardedCard = null;
                            room.turnStep = 'DISCARD';
                        }
                    }
                }
                room.broadcastUpdate();
                room.checkBotTurn();
                break;
            }
        }
    });
    socket.on('disconnect', () => {
        // Xử lý khi người chơi thoát để tránh lỗi treo bot
        const roomId = socketToRoom[socket.id];
        if (rooms[roomId]) {
            const r = rooms[roomId];
            if (r.botTimeout) clearTimeout(r.botTimeout);
        }
        delete socketToRoom[socket.id];
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
