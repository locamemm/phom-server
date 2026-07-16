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

// --- AI & GAME LOGIC HELPERS ---

function isValidPhom(cards) {
    if (cards.length < 3 || cards.length > 4) return false;
    // Check Sap (same rank)
    let firstRank = cards[0].rank;
    if (cards.every(c => c.rank === firstRank)) return true;
    // Check Sanh (same suit, consecutive)
    let firstSuit = cards[0].suit;
    if (cards.every(c => c.suit === firstSuit)) {
        let ranks = cards.map(c => c.rank).sort((a, b) => a - b);
        for (let i = 1; i < ranks.length; i++) {
            if (ranks[i] !== ranks[i - 1] + 1) return false;
        }
        return true;
    }
    return false;
}

function findAllPhoms(cards) {
    let phoms = [];
    for (let r = 1; r <= 13; r++) {
        let rankCards = cards.filter(c => c.rank === r);
        if (rankCards.length >= 3) {
            phoms.push(rankCards);
            if (rankCards.length === 4) {
                for (let i = 0; i < 4; i++) phoms.push(rankCards.filter((_, idx) => idx !== i));
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
                    if (sub[k].rank !== sub[k-1].rank + 1) { isConsec = false; break; }
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
            if (!phom.some(c => usedCardIds.has(c.id))) {
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

function canExtendMeld(meld, card) {
    if (meld.length === 0) return false;
    if (meld[0].rank === card.rank) {
        let isSap = meld.every(c => c.rank === meld[0].rank);
        if (isSap && meld.length < 4) return true;
    }
    if (meld[0].suit === card.suit) {
        let sorted = [...meld].sort((a, b) => a.rank - b.rank);
        let min = sorted[0].rank;
        let max = sorted[sorted.length - 1].rank;
        if (card.rank === min - 1 || card.rank === max + 1) {
            let isSanh = sorted.every((c, idx) => idx === 0 || c.rank === sorted[idx-1].rank + 1);
            if (isSanh) return true;
        }
    }
    return false;
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
        this.turnStep = 'ACTION'; // 'ACTION', 'DISCARD', 'LAY_MELDS', 'SEND_CARDS'
        this.meldStartIdx = -1;
        this.roundNum = 1;
        this.botTimeout = null;
    }

    addPlayer(socketId, clientId, name, isBot = false) {
        if (this.players.length >= 4) return false;
        this.players.push({
            socketId, clientId, name, isBot,
            hand: [], melds: [], eaten: [], discards: [], discardCount: 0,
            balance: 0, isMom: false, isU: false, score: 0, placement: 0,
            hasLaidMelds: false
        });
        return true;
    }

    initGame() {
        console.log(`Initializing game for room ${this.id}`);
        this.gameStarted = true;
        this.tableDiscards = [[], [], [], []];
        this.lastDiscardedCard = null;
        this.lastDiscardedPlayerIdx = -1;
        this.roundNum = 1;
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
        this.players.forEach(p => {
            p.hand = []; p.discards = []; p.eaten = []; p.melds = []; p.discardCount = 0;
            p.isMom = false; p.isU = false; p.hasLaidMelds = false;
        });
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

    getGameState(clientId, isGameOver = false) {
        return {
            roomId: this.id,
            players: this.players.map((p) => ({
                id: p.clientId, name: p.name, isBot: p.isBot,
                handCardCount: p.hand.length,
                hand: (p.clientId === clientId || isGameOver) ? p.hand : null, // reveal all hands if game over
                melds: p.melds, eaten: p.eaten, discards: p.discards,
                balance: p.balance, isMom: p.isMom, isU: p.isU,
                score: p.score, placement: p.placement, hasLaidMelds: p.hasLaidMelds
            })),
            tableDiscards: this.tableDiscards,
            drawPileCount: this.drawPile.length,
            currentTurnIdx: this.currentTurnIdx,
            dealerIdx: this.dealerIdx,
            lastDiscardedCard: this.lastDiscardedCard,
            turnStep: this.turnStep,
            roundNum: this.roundNum,
            meldStartIdx: this.meldStartIdx
        };
    }

    broadcastGameStart() {
        this.players.forEach(p => {
            if (p.socketId) io.to(p.socketId).emit('message', { type: 'GAME_START', payload: this.getGameState(p.clientId) });
        });
    }

    broadcastUpdate() {
        this.players.forEach(p => {
            if (p.socketId) io.to(p.socketId).emit('message', { type: 'GAME_STATE_UPDATE', payload: this.getGameState(p.clientId) });
        });
    }

    broadcastGameOver() {
        this.players.forEach(p => {
            if (p.socketId) io.to(p.socketId).emit('message', { type: 'GAME_OVER', payload: this.getGameState(p.clientId, true) });
        });
    }

    nextTurn() {
        this.currentTurnIdx = (this.currentTurnIdx + 1) % 4;
        this.turnStep = 'ACTION';
        if (this.currentTurnIdx === this.dealerIdx) {
            this.roundNum++;
        }

        // Check if game should move to meld phase
        if (this.drawPile.length === 0) {
             // If draw pile empty and next player cannot eat last discarded
             // For simplicity, we just move to meld phase if drawPile empty after a turn
             this.startMeldPhase();
        } else {
            this.broadcastUpdate();
            this.checkBotTurn();
        }
    }

    startMeldPhase() {
        this.meldStartIdx = (this.lastDiscardedPlayerIdx + 1) % 4;
        this.currentTurnIdx = this.meldStartIdx;
        this.turnStep = 'LAY_MELDS';
        this.broadcastUpdate();
        this.checkBotTurn();
    }

    applyEatShift(eatenPlayerIdx) {
        let target = eatenPlayerIdx;
        let prev1 = (target - 1 + 4) % 4;
        let prev2 = (target - 2 + 4) % 4;
        let prev3 = (target - 3 + 4) % 4;

        let shifts = [
            { from: prev1, to: target },
            { from: prev2, to: prev1 },
            { from: prev3, to: prev2 }
        ];

        shifts.forEach(s => {
            if (this.tableDiscards[s.from].length > this.tableDiscards[s.to].length) {
                let slot = this.tableDiscards[s.from];
                if (slot.length > 0) {
                    let card = slot.pop();
                    this.tableDiscards[s.to].push(card);
                    this.players[s.from].discardCount--;
                    this.players[s.to].discardCount++;
                }
            }
        });
    }

    handleEatPenalty(payerIdx, earnerIdx) {
        let isChot = (this.players[payerIdx].discardCount === 4);
        let points = isChot ? 2 : 1;
        this.players[payerIdx].balance -= points;
        this.players[earnerIdx].balance += points;
        this.players[payerIdx].discardCount--;
    }

    endGame() {
        this.gameStarted = false;
        // Determine U, Mom and Scores
        this.players.forEach(p => {
            let partition = getBestPartitions(p.hand);
            let allPhoms = [...p.melds, ...p.eaten, ...partition.phoms];
            p.isMom = (allPhoms.length === 0);
            p.score = p.isMom ? 999 : (p.isU ? 0 : partition.score);
        });

        let sorted = [...this.players].sort((a, b) => {
            if (a.isU && !b.isU) return -1;
            if (!a.isU && b.isU) return 1;
            if (a.isMom && !b.isMom) return 1;
            if (!a.isMom && b.isMom) return -1;
            if (a.score !== b.score) return a.score - b.score;
            let distA = (a.currentTurnIdx - this.meldStartIdx + 4) % 4;
            let distB = (b.currentTurnIdx - this.meldStartIdx + 4) % 4;
            return distA - distB;
        });

        sorted.forEach((p, idx) => p.placement = idx + 1);

        // Point changes (simplified)
        let winner = sorted[0];
        if (winner.isU) {
            this.players.forEach(p => {
                if (p.id === winner.id) p.balance += 6;
                else p.balance -= 2;
            });
        } else {
            let nonMom = this.players.filter(p => !p.isMom).length;
            if (nonMom === 0) { /* Draw */ }
            else if (nonMom === 1) {
                winner.balance += 3;
                this.players.filter(p => p.isMom).forEach(p => p.balance -= 1);
            } else {
                // Nhất +2, Nhì +1, Ba -1, Bét -2 (simplified)
                sorted[0].balance += 2; sorted[1].balance += 1;
                sorted[2].balance -= 1; sorted[3].balance -= 2;
            }
        }

        // Set dealer for next game
        this.dealerIdx = winner.id ? this.players.findIndex(p => p.clientId === winner.clientId) : (this.dealerIdx + 1) % 4;

        this.broadcastGameOver();
    }

    checkBotTurn() {
        if (!this.gameStarted) {
             // Maybe someone U?
             return;
        }
        const player = this.players[this.currentTurnIdx];
        if (player && player.isBot) {
            if (this.botTimeout) clearTimeout(this.botTimeout);
            this.botTimeout = setTimeout(() => this.runBotAI(), 1500);
        }
    }

    runBotAI() {
        const bot = this.players[this.currentTurnIdx];
        if (!bot || !bot.isBot) return;

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
                        this.handleEatPenalty(this.lastDiscardedPlayerIdx, this.currentTurnIdx);
                        this.applyEatShift(this.lastDiscardedPlayerIdx);
                        this.tableDiscards[this.lastDiscardedPlayerIdx].pop();
                        this.lastDiscardedCard = null;
                        this.turnStep = 'DISCARD';
                        ate = true;
                    }
                }
            }
            if (!ate) {
                if (this.drawPile.length > 0) {
                    bot.hand.push(this.drawPile.pop());
                    this.turnStep = 'DISCARD';
                } else { this.startMeldPhase(); return; }
            }
            this.broadcastUpdate();
            this.checkBotTurn();
        } else if (this.turnStep === 'DISCARD') {
            const partition = getBestPartitions(bot.hand);
            if (partition.racs.length === 0) { bot.isU = true; this.endGame(); return; }
            const discardCard = partition.racs.sort((a,b) => b.rank - a.rank)[0] || bot.hand[0];
            const idx = bot.hand.findIndex(c => c.id === discardCard.id);
            bot.hand.splice(idx, 1);
            this.tableDiscards[this.currentTurnIdx].push(discardCard);
            this.lastDiscardedCard = discardCard;
            this.lastDiscardedPlayerIdx = this.currentTurnIdx;
            bot.discardCount++;
            if (getBestPartitions(bot.hand).racs.length === 0) { bot.isU = true; this.endGame(); return; }
            this.nextTurn();
        } else if (this.turnStep === 'LAY_MELDS') {
            bot.hasLaidMelds = true;
            let partition = getBestPartitions(bot.hand);
            bot.melds = partition.phoms;
            partition.phoms.forEach(phom => {
                phom.forEach(c => {
                    let cIdx = bot.hand.findIndex(ch => ch.id === c.id);
                    if (cIdx !== -1) bot.hand.splice(cIdx, 1);
                });
            });
            if (bot.hand.length === 0) { bot.isU = true; this.endGame(); return; }
            this.turnStep = 'SEND_CARDS';
            this.broadcastUpdate();
            this.checkBotTurn();
        } else if (this.turnStep === 'SEND_CARDS') {
            let hasNewSends = true;
            while (hasNewSends) {
                let found = false;
                for (let card of bot.hand) {
                    for (let targetPlayer of this.players) {
                        if (!targetPlayer.hasLaidMelds) continue;
                        let allTargetPhoms = [...targetPlayer.melds, ...targetPlayer.eaten];
                        for (let meldIdx = 0; meldIdx < allTargetPhoms.length; meldIdx++) {
                            if (canExtendMeld(allTargetPhoms[meldIdx], card)) {
                                let removed = bot.hand.splice(bot.hand.indexOf(card), 1)[0];
                                // simplify: just push to melds
                                targetPlayer.melds[0].push(removed);
                                found = true; break;
                            }
                        }
                        if (found) break;
                    }
                    if (found) break;
                }
                if (!found) hasNewSends = false;
            }
            if (bot.hand.length === 0) { bot.isU = true; this.endGame(); return; }
            let nextIdx = (this.currentTurnIdx + 1) % 4;
            if (nextIdx === this.meldStartIdx) { this.endGame(); }
            else { this.currentTurnIdx = nextIdx; this.turnStep = 'LAY_MELDS'; this.broadcastUpdate(); this.checkBotTurn(); }
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
                    if (room.drawPile.length > 0) {
                        p.hand.push(room.drawPile.pop());
                        room.turnStep = 'DISCARD';
                    } else { room.startMeldPhase(); }
                } else if (action === 'DISCARD' && room.turnStep === 'DISCARD') {
                    const cIdx = p.hand.findIndex(c => c.id === cardId);
                    if (cIdx !== -1) {
                        const card = p.hand.splice(cIdx, 1)[0];
                        room.tableDiscards[pIdx].push(card);
                        room.lastDiscardedCard = card;
                        room.lastDiscardedPlayerIdx = pIdx;
                        p.discardCount++;
                        if (getBestPartitions(p.hand).racs.length === 0) { p.isU = true; room.endGame(); return; }
                        room.nextTurn();
                    }
                } else if (action === 'EAT' && room.turnStep === 'ACTION') {
                    if (room.lastDiscardedCard && cardIds) {
                        const eatenCard = room.lastDiscardedCard;
                        const caCards = p.hand.filter(c => cardIds.includes(c.id));
                        if (caCards.length >= 2) {
                            p.hand = p.hand.filter(c => !cardIds.includes(c.id));
                            p.eaten.push([eatenCard, ...caCards]);
                            room.handleEatPenalty(room.lastDiscardedPlayerIdx, pIdx);
                            room.applyEatShift(room.lastDiscardedPlayerIdx);
                            room.tableDiscards[room.lastDiscardedPlayerIdx].pop();
                            room.lastDiscardedCard = null;
                            room.turnStep = 'DISCARD';
                        }
                    }
                } else if (action === 'LAY_MELDS' && (room.turnStep === 'LAY_MELDS' || room.turnStep === 'DISCARD')) {
                    if (room.turnStep === 'DISCARD') {
                        if (getBestPartitions(p.hand).racs.length <= 1) {
                            p.isU = true; room.endGame(); return;
                        }
                    }
                    p.hasLaidMelds = true;
                    let partition = getBestPartitions(p.hand);
                    p.melds = partition.phoms;
                    partition.phoms.forEach(ph => ph.forEach(c => {
                        let i = p.hand.findIndex(ch => ch.id === c.id);
                        if (i !== -1) p.hand.splice(i, 1);
                    }));
                    if (p.hand.length === 0) { p.isU = true; room.endGame(); return; }
                    room.turnStep = 'SEND_CARDS';
                } else if (action === 'SEND_CARDS' && room.turnStep === 'SEND_CARDS') {
                    // Manual send not implemented yet, just skip to next player
                    let nextIdx = (room.currentTurnIdx + 1) % 4;
                    if (nextIdx === room.meldStartIdx) { room.endGame(); }
                    else { room.currentTurnIdx = nextIdx; room.turnStep = 'LAY_MELDS'; }
                }
                room.broadcastUpdate();
                room.checkBotTurn();
                break;
            }
        }
    });
    socket.on('disconnect', () => { delete socketToRoom[socket.id]; });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
