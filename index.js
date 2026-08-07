const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
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

// --- GAME LOGIC HELPERS ---

function isValidPhom(cards) {
    if (!cards || cards.length < 3) return false;
    let firstRank = cards[0].rank;
    if (cards.every(c => c.rank === firstRank)) return true;
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
                if (isValidPhom(sub)) phoms.push(sub);
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
    if (!meld || meld.length === 0) return false;
    if (meld[0].rank === card.rank) {
        let isSap = meld.every(c => c.rank === meld[0].rank);
        if (isSap && meld.length < 4) return true;
    }
    if (meld[0].suit === card.suit) {
        let sorted = [...meld].sort((a, b) => a.rank - b.rank);
        if (card.rank === sorted[0].rank - 1 || card.rank === sorted[sorted.length - 1].rank + 1) {
            let combined = [...meld, card].sort((a, b) => a.rank - b.rank);
            let isSanh = combined.every((c, idx) => idx === 0 || c.rank === combined[idx-1].rank + 1);
            if (isSanh) return true;
        }
    }
    return false;
}

function evaluatePokerHand(cards) {
    // Poker Hand Evaluator - Returns { name, value, bestCards, tieBreakers }
    // value: 1-9 ranking (High Card to Straight Flush)
    // tieBreakers: array of card ranks (2-14, Ace=14) for comparison

    const getVal = (r) => (r === 1 ? 14 : r);
    const rankCounts = {};
    const suitGroups = { 0: [], 1: [], 2: [], 3: [] };

    cards.forEach(c => {
        const val = getVal(c.rank);
        rankCounts[val] = (rankCounts[val] || 0) + 1;
        suitGroups[c.suit].push(c);
    });

    // Helper to get kickers (highest cards excluding specific ranks)
    const getKickers = (allCards, excludeRanks, num) => {
        return allCards.filter(c => !excludeRanks.includes(getVal(c.rank)))
                       .sort((a, b) => getVal(b.rank) - getVal(a.rank))
                       .slice(0, num);
    };

    // 1. Flush Check
    let flushSuit = -1;
    for (let s = 0; s < 4; s++) {
        if (suitGroups[s].length >= 5) {
            flushSuit = s;
            break;
        }
    }

    // 2. Straight Check (Best 5 consecutive)
    const sortedUniqueCards = [];
    const seenRanks = new Set();
    [...cards].sort((a, b) => getVal(b.rank) - getVal(a.rank)).forEach(c => {
        if (!seenRanks.has(getVal(c.rank))) {
            sortedUniqueCards.push(c);
            seenRanks.add(getVal(c.rank));
        }
    });

    let bestStraight = null;
    for (let i = 0; i <= sortedUniqueCards.length - 5; i++) {
        if (getVal(sortedUniqueCards[i].rank) === getVal(sortedUniqueCards[i + 4].rank) + 4) {
            bestStraight = sortedUniqueCards.slice(i, i + 5);
            break;
        }
    }
    // Wheel (A-2-3-4-5)
    if (!bestStraight && [14, 5, 4, 3, 2].every(r => seenRanks.has(r))) {
        bestStraight = sortedUniqueCards.filter(c => [14, 5, 4, 3, 2].includes(getVal(c.rank))).sort((a, b) => getVal(b.rank) - getVal(a.rank));
        const ace = bestStraight.shift();
        bestStraight.push(ace);
    }

    // 3. Straight Flush
    if (flushSuit !== -1) {
        const fCards = suitGroups[flushSuit].sort((a, b) => getVal(b.rank) - getVal(a.rank));
        const fRanks = new Set(fCards.map(c => getVal(c.rank)));

        for (let i = 0; i <= fCards.length - 5; i++) {
            if (getVal(fCards[i].rank) === getVal(fCards[i + 4].rank) + 4) {
                const sf = fCards.slice(i, i + 5);
                return { name: "Thùng Phá Sảnh", value: 9, bestCards: sf, tieBreakers: [getVal(sf[0].rank)] };
            }
        }
        if ([14, 5, 4, 3, 2].every(r => fRanks.has(r))) {
            const wheel = fCards.filter(c => [14, 5, 4, 3, 2].includes(getVal(c.rank))).sort((a, b) => getVal(b.rank) - getVal(a.rank));
            return { name: "Thùng Phá Sảnh", value: 9, bestCards: wheel, tieBreakers: [5] };
        }
    }

    const counts = Object.entries(rankCounts).map(([rank, count]) => ({ rank: Number(rank), count }));
    counts.sort((a, b) => b.count - a.count || b.rank - a.rank);

    // 4. Four of a Kind
    if (counts[0].count === 4) {
        const main = cards.filter(c => getVal(c.rank) === counts[0].rank);
        const kickers = getKickers(cards, [counts[0].rank], 1);
        return { name: "Tứ Quý", value: 8, bestCards: [...main, ...kickers], tieBreakers: [counts[0].rank, getVal(kickers[0].rank)] };
    }

    // 5. Full House
    if (counts[0].count === 3 && (counts[1] && counts[1].count >= 2)) {
        const trips = cards.filter(c => getVal(c.rank) === counts[0].rank);
        const pair = cards.filter(c => getVal(c.rank) === counts[1].rank).slice(0, 2);
        return { name: "Cù Lũ", value: 7, bestCards: [...trips, ...pair], tieBreakers: [counts[0].rank, counts[1].rank] };
    }

    // 6. Flush
    if (flushSuit !== -1) {
        const fCards = suitGroups[flushSuit].sort((a, b) => getVal(b.rank) - getVal(a.rank)).slice(0, 5);
        return { name: "Thùng", value: 6, bestCards: fCards, tieBreakers: fCards.map(c => getVal(c.rank)) };
    }

    // 7. Straight
    if (bestStraight) {
        const high = (getVal(bestStraight[0].rank) === 14 && getVal(bestStraight[1].rank) === 5) ? 5 : getVal(bestStraight[0].rank);
        return { name: "Sảnh", value: 5, bestCards: bestStraight, tieBreakers: [high] };
    }

    // 8. Three of a Kind
    if (counts[0].count === 3) {
        const trips = cards.filter(c => getVal(c.rank) === counts[0].rank);
        const kickers = getKickers(cards, [counts[0].rank], 2);
        return { name: "Sám Cô", value: 4, bestCards: [...trips, ...kickers], tieBreakers: [counts[0].rank, ...kickers.map(c => getVal(c.rank))] };
    }

    // 9. Two Pair
    if (counts[0].count === 2 && (counts[1] && counts[1].count === 2)) {
        const p1 = cards.filter(c => getVal(c.rank) === counts[0].rank);
        const p2 = cards.filter(c => getVal(c.rank) === counts[1].rank);
        const kickers = getKickers(cards, [counts[0].rank, counts[1].rank], 1);
        return { name: "Thú", value: 3, bestCards: [...p1, ...p2, ...kickers], tieBreakers: [counts[0].rank, counts[1].rank, getVal(kickers[0].rank)] };
    }

    // 10. Pair
    if (counts[0].count === 2) {
        const pair = cards.filter(c => getVal(c.rank) === counts[0].rank);
        const kickers = getKickers(cards, [counts[0].rank], 3);
        return { name: "Đôi", value: 2, bestCards: [...pair, ...kickers], tieBreakers: [counts[0].rank, ...kickers.map(c => getVal(c.rank))] };
    }

    const highCards = cards.sort((a, b) => getVal(b.rank) - getVal(a.rank)).slice(0, 5);
    return { name: "Mậu Thầu", value: 1, bestCards: highCards, tieBreakers: highCards.map(c => getVal(c.rank)) };
}

class Room {
    constructor(id) {
        this.id = id;
        this.players = [];
        this.deck = [];
        this.drawPile = [];
        this.tableDiscards = [[], [], [], [], [], [], [], []];
        this.currentTurnIdx = 0;
        this.dealerIdx = 0;
        this.gameStarted = false;
        this.lastDiscardedCard = null;
        this.lastDiscardedPlayerIdx = -1;
        this.turnStep = 'ACTION';
        this.meldStartIdx = -1;
        this.botTimeout = null;
        this.history = [];
        this.gameMode = 'PHOM';
        this.maxPlayers = 4;

        // Poker specific
        this.pot = 0;
        this.communityCards = [];
        this.currentBet = 0;
        this.pokerPhase = 'PREFLOP';
        this.minRaise = 10;
        this.smallBlind = 5;
        this.bigBlind = 10;
    }

    addPlayer(socketId, clientId, name, isBot = false) {
        if (this.players.length >= this.maxPlayers) return false;
        this.players.push({
            socketId, clientId, name, isBot,
            hand: [], melds: [], eaten: [], discards: [], discardCount: 0,
            balance: 0, isMom: false, isU: false, score: 0, placement: 0,
            hasLaidMelds: false,
            currentBet: 0, isFolded: false, isAllIn: false, hasActed: false, pokerResult: null
        });
        return true;
    }

    initGame() {
        if (this.gameMode === 'PHOM') {
            this.initPhomGame();
        } else {
            this.initPokerGame();
        }
    }

    initPhomGame() {
        this.gameStarted = true;
        this.tableDiscards = [[], [], [], [], [], [], [], []];
        this.lastDiscardedCard = null;
        this.lastDiscardedPlayerIdx = -1;
        this.createDeck();
        this.shuffleDeck();
        this.dealCards();
        this.broadcastGameStart();
        this.checkBotTurn();
    }

    initPokerGame() {
        this.gameStarted = true;
        this.players.forEach(p => {
            p.hand = []; p.currentBet = 0; p.isFolded = false; p.hasActed = false; p.pokerResult = null;
        });
        this.pot = 0;
        this.communityCards = [];
        this.pokerPhase = 'PREFLOP';
        this.currentBet = 0;
        this.turnStep = 'DEALING';
        this.tableDiscards = Array.from({ length: 8 }, () => []);

        this.createDeck();
        this.shuffleDeck();
        this.dealCards();

        const numPlayers = this.players.length;

        // Define Blinds based on player count
        let sbIdx, bbIdx, utgIdx;
        if (numPlayers === 2) {
            sbIdx = this.dealerIdx;
            bbIdx = (this.dealerIdx + 1) % 2;
            utgIdx = this.dealerIdx; // SB acts first pre-flop
        } else {
            sbIdx = (this.dealerIdx + 1) % numPlayers;
            bbIdx = (this.dealerIdx + 2) % numPlayers;
            utgIdx = (this.dealerIdx + 3) % numPlayers;
        }

        const sbAmount = this.smallBlind || 5;
        const bbAmount = this.bigBlind || 10;

        this.players[sbIdx].balance -= sbAmount;
        this.players[sbIdx].currentBet = sbAmount;
        this.players[bbIdx].balance -= bbAmount;
        this.players[bbIdx].currentBet = bbAmount;
        this.currentBet = bbAmount;
        this.pot = sbAmount + bbAmount;

        this.broadcastUpdate('GAME_START');

        setTimeout(() => {
            this.turnStep = 'ACTION';
            this.currentTurnIdx = utgIdx;
            this.broadcastUpdate();
            this.checkBotTurn();
        }, 3000);
    }

    handlePokerAction(clientId, payload) {
        const pIdx = this.players.findIndex(p => p.clientId === clientId);
        if (pIdx !== this.currentTurnIdx) return;

        const player = this.players[pIdx];
        if (player.isFolded || player.isAllIn) return;

        const { action, raiseVal } = payload;
        let actionTaken = false;

        switch (action) {
            case 'CHECK':
                if (player.currentBet === this.currentBet) {
                    player.hasActed = true;
                    actionTaken = true;
                }
                break;
            case 'CALL':
                let callAmount = this.currentBet - player.currentBet;
                if (callAmount >= player.balance) {
                    callAmount = player.balance;
                    player.isAllIn = true;
                }
                player.balance -= callAmount;
                player.currentBet += callAmount;
                this.pot += callAmount;
                player.hasActed = true;
                actionTaken = true;
                break;
            case 'RAISE':
                let raiseAmount = this.minRaise;
                let isAllInMode = (raiseVal === 'allin');

                if (isAllInMode) {
                    raiseAmount = player.balance;
                } else if (raiseVal) {
                    raiseAmount = parseInt(raiseVal);
                }

                if (raiseAmount >= player.balance) {
                    raiseAmount = player.balance;
                    player.isAllIn = true;
                }

                const newTotal = player.currentBet + raiseAmount;
                const oldBet = this.currentBet;

                player.balance -= raiseAmount;
                player.currentBet = newTotal;
                this.pot += raiseAmount;
                this.currentBet = Math.max(this.currentBet, player.currentBet);

                if (this.currentBet > oldBet) {
                    this.players.forEach(p => { if (!p.isFolded && !p.isAllIn) p.hasActed = false; });
                }

                player.hasActed = true;
                actionTaken = true;
                break;
            case 'FOLD':
                player.isFolded = true;
                player.hasActed = true;
                actionTaken = true;
                break;
        }

        if (actionTaken) {
            this.finishPokerTurn();
        }
    }

    finishPokerTurn() {
        const activePlayers = this.players.filter(p => !p.isFolded);
        const numPlayers = this.players.length;

        if (activePlayers.length === 1) {
            activePlayers[0].balance += this.pot;
            this.endPokerGame();
            return;
        }

        this.currentTurnIdx = (this.currentTurnIdx + 1) % numPlayers;

        const canActPlayers = activePlayers.filter(p => !p.isAllIn);
        const allActed = activePlayers.every(p => p.hasActed || p.isAllIn);
        const allMatched = canActPlayers.every(p => p.currentBet === this.currentBet);

        if ((allActed && allMatched) || (canActPlayers.length <= 1 && allActed)) {
            setTimeout(() => this.nextPokerPhase(), 1000);
        } else {
            if (this.players[this.currentTurnIdx].isFolded || this.players[this.currentTurnIdx].isAllIn) {
                this.finishPokerTurn();
            } else {
                this.broadcastUpdate();
                if (this.players[this.currentTurnIdx].isBot) {
                    setTimeout(() => this.runBotPokerAI(), 1000);
                }
            }
        }
    }

    runBotPokerAI() {
        const bot = this.players[this.currentTurnIdx];
        if (!bot || !bot.isBot) return;

        const rand = Math.random();
        let action = 'CHECK';

        if (bot.currentBet < this.currentBet) {
            if (rand < 0.1) action = 'FOLD';
            else action = 'CALL';
        } else {
            if (rand < 0.1 && this.currentBet < 50000) action = 'RAISE';
            else action = 'CHECK';
        }

        this.handlePokerAction(bot.clientId, action);
    }

    nextPokerPhase() {
        this.players.forEach(p => { p.currentBet = 0; p.hasActed = false; });
        this.currentBet = 0;

        switch (this.pokerPhase) {
            case 'PREFLOP': this.pokerPhase = 'FLOP'; break;
            case 'FLOP': this.pokerPhase = 'TURN'; break;
            case 'TURN': this.pokerPhase = 'RIVER'; break;
            case 'RIVER': this.pokerShowdown(); return;
        }

        this.broadcastUpdate();

        const activePlayers = this.players.filter(p => !p.isFolded);
        const canActPlayers = activePlayers.filter(p => !p.isAllIn);

        if (canActPlayers.length <= 1) {
            // No more betting possible, proceed automatically
            setTimeout(() => this.nextPokerPhase(), 2000);
            return;
        }

        const numPlayers = this.players.length;
        this.currentTurnIdx = (this.dealerIdx + 1) % numPlayers;
        if (this.players[this.currentTurnIdx].isFolded || this.players[this.currentTurnIdx].isAllIn) {
            this.finishPokerTurn();
        } else {
            if (this.players[this.currentTurnIdx].isBot) {
                setTimeout(() => this.runBotPokerAI(), 1000);
            }
        }
    }

    pokerShowdown() {
        const activePlayers = this.players.filter(p => !p.isFolded);
        activePlayers.forEach(p => {
            p.pokerResult = evaluatePokerHand([...p.hand, ...this.communityCards]);
        });

        // Sort by hand rank, then by tie-breakers
        activePlayers.sort((a, b) => {
            if (b.pokerResult.value !== a.pokerResult.value) {
                return b.pokerResult.value - a.pokerResult.value;
            }
            const len = Math.max(a.pokerResult.tieBreakers.length, b.pokerResult.tieBreakers.length);
            for (let i = 0; i < len; i++) {
                const valA = a.pokerResult.tieBreakers[i] || 0;
                const valB = b.pokerResult.tieBreakers[i] || 0;
                if (valB !== valA) return valB - valA;
            }
            return 0;
        });

        // Identify all winners
        const best = activePlayers[0].pokerResult;
        const winners = activePlayers.filter(p => {
            const res = p.pokerResult;
            if (res.value !== best.value) return false;
            if (res.tieBreakers.length !== best.tieBreakers.length) return false;
            return res.tieBreakers.every((v, i) => v === best.tieBreakers[i]);
        });

        const share = Math.floor(this.pot / winners.length);
        winners.forEach(w => w.balance += share);
        if (this.pot % winners.length !== 0) winners[0].balance += (this.pot % winners.length);

        this.endPokerGame();
    }

    endPokerGame() {
        this.gameStarted = false;
        this.turnStep = 'GAME_OVER';
        this.pokerPhase = 'SHOWDOWN';
        this.broadcastUpdate('GAME_OVER');
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
            p.currentBet = 0; p.isFolded = false; p.isAllIn = false; p.hasActed = false; p.pokerResult = null;
        });
        this.drawPile = [...this.deck];
        const numPlayers = this.players.length;

        if (this.gameMode === 'PHOM') {
            let cardsToDeal = 9 * numPlayers + 1;
            let curr = this.dealerIdx;
            let dealt = 0;
            while (dealt < cardsToDeal) {
                let limit = (curr === this.dealerIdx) ? 10 : 9;
                if (this.players[curr].hand.length < limit) {
                    this.players[curr].hand.push(this.drawPile.pop());
                    dealt++;
                }
                curr = (curr + 1) % numPlayers;
            }
        } else {
            // Poker deal: 2 cards each, starting from player after dealer
            for (let i = 0; i < 2; i++) {
                for (let j = 0; j < numPlayers; j++) {
                    const targetIdx = (this.dealerIdx + 1 + j) % numPlayers;
                    this.players[targetIdx].hand.push(this.drawPile.pop());
                }
            }
            // 5 Community cards
            this.communityCards = [];
            for (let i = 0; i < 5; i++) {
                this.communityCards.push(this.drawPile.pop());
            }
        }

        this.currentTurnIdx = this.dealerIdx;
        if (this.gameMode === 'PHOM') {
            this.turnStep = (this.players[this.currentTurnIdx].hand.length === 10) ? 'DISCARD' : 'ACTION';
        }
        // In Poker, turnStep is managed by initPokerGame (DEALING -> ACTION)

        if (this.gameMode === 'PHOM') {
            this.players.forEach(p => {
                if (getBestPartitions(p.hand).racs.length === 0) {
                    p.isU = true;
                    this.endGame();
                }
            });
        }
    }

    getGameState(clientId, isGameOver = false) {
        const isShowdown = (this.gameMode === 'POKER' && this.pokerPhase === 'SHOWDOWN');
        const isFinal = isGameOver || isShowdown || (this.turnStep === 'GAME_OVER');

        return {
            roomId: this.id,
            gameMode: this.gameMode,
            players: this.players.map((p) => ({
                id: p.clientId, name: p.name, isBot: p.isBot,
                handCardCount: p.hand.length,
                hand: (p.clientId === clientId || isFinal) ? p.hand : null,
                melds: p.melds, eaten: p.eaten, discards: p.discards,
                balance: p.balance, isMom: p.isMom, isU: p.isU,
                score: p.score, placement: p.placement, hasLaidMelds: p.hasLaidMelds,
                currentBet: p.currentBet, isFolded: p.isFolded, isAllIn: p.isAllIn,
                pokerResult: isFinal ? p.pokerResult : null
            })),
            tableDiscards: this.tableDiscards,
            drawPileCount: this.drawPile.length,
            currentTurnIdx: this.currentTurnIdx,
            dealerIdx: this.dealerIdx,
            lastDiscardedCard: this.lastDiscardedCard,
            lastDiscardedPlayerIdx: this.lastDiscardedPlayerIdx,
            turnStep: this.turnStep,
            pokerPhase: this.pokerPhase,
            communityCards: (this.gameMode === 'POKER') ? this.communityCards : [],
            pot: this.pot,
            currentBet: this.currentBet,
            maxPlayers: this.maxPlayers
        };
    }

    broadcastGameStart() {
        this.players.forEach(p => {
            if (p.socketId) io.to(p.socketId).emit('message', { type: 'GAME_START', payload: this.getGameState(p.clientId) });
        });
    }

    broadcastUpdate(type = 'GAME_STATE_UPDATE') {
        this.players.forEach(p => {
            if (p.socketId) io.to(p.socketId).emit('message', { type: type, payload: this.getGameState(p.clientId) });
        });
    }

    broadcastGameOver() {
        console.log(`Ván đấu ${this.id} kết thúc!`);
        this.players.forEach(p => {
            if (p.socketId) io.to(p.socketId).emit('message', { type: 'GAME_OVER', payload: this.getGameState(p.clientId, true) });
        });
    }

    nextTurn() {
        const numPlayers = this.players.length;
        this.currentTurnIdx = (this.currentTurnIdx + 1) % numPlayers;
        this.turnStep = 'ACTION';

        // Nếu nọc hết, người tiếp theo bắt đầu hạ phỏm
        if (this.drawPile.length === 0) {
             this.startMeldPhase();
        } else {
            this.broadcastUpdate();
            this.checkBotTurn();
        }
    }

    startMeldPhase() {
        const numPlayers = this.players.length;
        this.meldStartIdx = (this.lastDiscardedPlayerIdx + 1) % numPlayers;
        this.currentTurnIdx = this.meldStartIdx;
        this.turnStep = 'LAY_MELDS';
        console.log(`Bắt đầu hạ phỏm tại người chơi ${this.currentTurnIdx}`);
        this.broadcastUpdate();
        this.checkBotTurn();
    }

    performMeldAndSend(playerIdx) {
        const player = this.players[playerIdx];
        if (player.hasLaidMelds) return;
        player.hasLaidMelds = true;

        let partition = getBestPartitions(player.hand);
        player.melds = [...player.melds, ...partition.phoms];
        partition.phoms.forEach(phom => {
            phom.forEach(c => {
                let idx = player.hand.findIndex(h => h.id === c.id);
                if (idx !== -1) player.hand.splice(idx, 1);
            });
        });

        if (player.hand.length === 0) player.isU = true;

        // Tự động gửi bài cho người khác
        let hasNewSends = true;
        while (hasNewSends && !player.isU) {
            let found = false;
            for (let i = 0; i < player.hand.length; i++) {
                let card = player.hand[i];
                for (let target of this.players) {
                    if (!target.hasLaidMelds) continue;
                    let allTargetPhoms = [...target.melds, ...target.eaten];
                    for (let pIdx = 0; pIdx < allTargetPhoms.length; pIdx++) {
                        if (canExtendMeld(allTargetPhoms[pIdx], card)) {
                            player.hand.splice(i, 1);
                            allTargetPhoms[pIdx].push(card);
                            found = true; break;
                        }
                    }
                    if (found) break;
                }
                if (found) break;
            }
            if (!found) hasNewSends = false;
        }

        if (player.hand.length === 0) player.isU = true;

        let nextIdx = (playerIdx + 1) % 4;
        if (nextIdx === this.meldStartIdx || player.isU) {
            this.endGame();
        } else {
            this.currentTurnIdx = nextIdx;
            this.turnStep = 'LAY_MELDS';
            this.broadcastUpdate();
            this.checkBotTurn();
        }
    }

    endGame() {
        if (!this.gameStarted) return;
        this.gameStarted = false;
        if (this.botTimeout) clearTimeout(this.botTimeout);

        const numPlayers = this.players.length;

        // Tính toán Móm và Điểm số cuối cùng
        this.players.forEach(p => {
            let pPart = getBestPartitions(p.hand);
            let totalPhoms = p.melds.length + p.eaten.length;
            p.isMom = (totalPhoms === 0);
            p.score = p.isMom ? 999 : (p.isU ? 0 : pPart.score);
        });

        // Xếp hạng
        let sorted = [...this.players].sort((a, b) => {
            if (a.isU && !b.isU) return -1;
            if (!a.isU && b.isU) return 1;
            if (a.isMom && !b.isMom) return 1;
            if (!a.isMom && b.isMom) return -1;
            if (a.score !== b.score) return a.score - b.score;
            // Nếu bằng điểm, người hạ bài trước (gần meldStartIdx hơn) sẽ thắng
            return 0;
        });

        sorted.forEach((p, idx) => p.placement = idx + 1);

        // Chốt điểm (tạm thời giữ logic cũ cho 4p, các số người khác xử lý cơ bản)
        let winner = sorted[0];
        if (winner.isU) {
            this.players.forEach(p => {
                if (p.clientId === winner.clientId) p.balance += (numPlayers - 1) * 2;
                else p.balance -= 2;
            });
        } else {
            if (numPlayers === 4) {
                if (sorted[0]) sorted[0].balance += 2;
                if (sorted[1]) sorted[1].balance += 1;
                if (sorted[2]) sorted[2].balance -= 1;
                if (sorted[3]) sorted[3].balance -= 2;
            } else {
                sorted[0].balance += numPlayers - 1;
                for (let i = 1; i < numPlayers; i++) sorted[i].balance -= 1;
            }
        }

        this.dealerIdx = (this.dealerIdx + 1) % numPlayers;
        this.broadcastGameOver();
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
                        this.tableDiscards[this.lastDiscardedPlayerIdx].pop();
                        this.lastDiscardedCard = null;
                        this.turnStep = 'DISCARD';
                        ate = true;
                    }
                }
            }
            if (!ate) {
                if (this.drawPile.length > 0) { bot.hand.push(this.drawPile.pop()); this.turnStep = 'DISCARD'; }
                else { this.startMeldPhase(); return; }
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
            this.performMeldAndSend(this.currentTurnIdx);
        }
    }

    handleEatPenalty(payerIdx, earnerIdx) {
        let isChot = (this.players[payerIdx].discardCount === 4);
        let points = isChot ? 2 : 1;
        this.players[payerIdx].balance -= points;
        this.players[earnerIdx].balance += points;
        this.players[payerIdx].discardCount--;
    }
}

const rooms = {};
const socketToRoom = {};

io.on('connection', (socket) => {
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
                newRoom.gameMode = payload.gameMode || 'PHOM';
                newRoom.maxPlayers = (newRoom.gameMode === 'POKER') ? 8 : 4;

                newRoom.addPlayer(socket.id, clientId, payload.name || 'Chủ phòng');
                rooms[newId] = newRoom; socketToRoom[socket.id] = newId;
                socket.join(newId);
                const playerList = newRoom.players.map(p => ({ id: p.clientId, name: p.name, isBot: p.isBot }));
                socket.emit('message', { type: 'JOIN_SUCCESS', payload: {
                    roomId: newId,
                    playerCount: 1,
                    isHost: true,
                    gameMode: newRoom.gameMode,
                    players: playerList
                } });
                break;
            }
            case 'JOIN_ROOM': {
                const rId = payload.roomId ? payload.roomId.toUpperCase() : '';
                const r = rooms[rId];
                if (r && r.players.length < r.maxPlayers) {
                    r.addPlayer(socket.id, clientId, payload.name || 'Người chơi');
                    socketToRoom[socket.id] = rId; socket.join(rId);

                    const playerList = r.players.map(p => ({ id: p.clientId, name: p.name, isBot: p.isBot }));

                    socket.emit('message', { type: 'JOIN_SUCCESS', payload: {
                        roomId: rId,
                        playerCount: r.players.length,
                        isHost: false,
                        gameMode: r.gameMode,
                        players: playerList
                    } });

                    io.to(rId).emit('message', { type: 'PLAYER_JOINED', payload: {
                        playerCount: r.players.length,
                        maxPlayers: r.maxPlayers,
                        players: playerList
                    } });
                } else { socket.emit('message', { type: 'ERROR', payload: { message: 'Phòng đầy hoặc không tồn tại.' } }); }
                break;
            }
            case 'ADD_BOT': {
                if (room && room.players.length < room.maxPlayers) {
                    const botNames = ['Lâm Híp', 'Bác Ba Phi', 'Chị Hoa', 'Anh Bốn', 'Ông Năm', 'Bà Sáu', 'Bảy Núi', 'Tám Tài'];
                    const botId = `bot-${Date.now()}-${room.players.length}`;
                    room.addPlayer(null, botId, botNames[room.players.length] || 'Máy', true);

                    const playerList = room.players.map(p => ({ id: p.clientId, name: p.name, isBot: p.isBot }));
                    io.to(roomId).emit('message', { type: 'PLAYER_JOINED', payload: {
                        playerCount: room.players.length,
                        maxPlayers: room.maxPlayers,
                        players: playerList
                    } });
                }
                break;
            }
            case 'PLAYER_ACTION': {
                if (!room) return;
                const pIdx = room.players.findIndex(p => p.clientId === clientId);
                if (pIdx !== room.currentTurnIdx) return;
                const { action, cardId, cardIds } = payload;
                const p = room.players[pIdx];

                if (action === 'DRAW' && room.turnStep === 'ACTION' && room.gameMode === 'PHOM') {
                    if (room.drawPile.length > 0) { p.hand.push(room.drawPile.pop()); room.turnStep = 'DISCARD'; }
                    else { room.startMeldPhase(); }
                } else if (action === 'DISCARD' && room.turnStep === 'DISCARD' && room.gameMode === 'PHOM') {
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
                        const fullPhom = [eatenCard, ...caCards];
                        if (isValidPhom(fullPhom)) {
                            p.hand = p.hand.filter(c => !cardIds.includes(c.id));
                            p.eaten.push(fullPhom);
                            room.handleEatPenalty(room.lastDiscardedPlayerIdx, pIdx);
                            room.tableDiscards[room.lastDiscardedPlayerIdx].pop();
                            room.lastDiscardedCard = null;
                            room.turnStep = 'DISCARD';
                        } else {
                            socket.emit('message', { type: 'ERROR', payload: { message: 'Phỏm không hợp lệ!' } });
                            return;
                        }
                    }
                } else if (action === 'LAY_MELDS') {
                    if (room.turnStep === 'DISCARD') {
                        if (getBestPartitions(p.hand).racs.length <= 1) {
                            p.isU = true; room.endGame(); return;
                        }
                    } else if (room.turnStep === 'LAY_MELDS') {
                        room.performMeldAndSend(pIdx);
                    }
                }
                room.broadcastUpdate();
                room.checkBotTurn();
                break;
            }
            case 'POKER_ACTION': {
                if (room) room.handlePokerAction(clientId, payload);
                break;
            }
            case 'POKER_SETUP_COMPLETE': {
                if (room) {
                    room.gameMode = 'POKER';
                    room.pokerPhase = 'WAITING_TO_START';

                    if (payload.smallBlind) room.smallBlind = payload.smallBlind;
                    if (payload.bigBlind) {
                        room.bigBlind = payload.bigBlind;
                        room.minRaise = payload.bigBlind;
                    }

                    if (payload.chipBalances) {
                        room.players.forEach(p => {
                            if (payload.chipBalances[p.clientId]) p.balance = payload.chipBalances[p.clientId];
                        });
                    }
                    room.broadcastUpdate('POKER_SETUP_SYNC');
                }
                break;
            }
            case 'START_POKER_DEALING': {
                if (room) room.initPokerGame();
                break;
            }
            case 'REQUEST_START_GAME': {
                if (room) {
                    room.gameMode = payload.gameMode || 'PHOM';
                    room.initGame();
                }
                break;
            }
            case 'KICK_PLAYER': {
                if (room && payload.targetId) {
                    const targetIdx = room.players.findIndex(p => p.clientId === payload.targetId);
                    if (targetIdx !== -1) {
                        const target = room.players[targetIdx];
                        if (target.socketId) {
                            io.to(target.socketId).emit('message', { type: 'ERROR', payload: { message: 'Bạn đã bị chủ phòng đuổi khỏi phòng.' } });
                            // Force disconnect or just leave? Better to force leave room
                        }
                        room.players.splice(targetIdx, 1);

                        const playerList = room.players.map(p => ({ id: p.clientId, name: p.name, isBot: p.isBot }));
                        io.to(roomId).emit('message', { type: 'PLAYER_JOINED', payload: {
                            playerCount: room.players.length,
                            maxPlayers: room.maxPlayers,
                            players: playerList
                        } });
                    }
                }
                break;
            }
            case 'SET_PLAYER_CHIP': {
                if (room && payload.targetId) {
                    const target = room.players.find(p => p.clientId === payload.targetId);
                    if (target) {
                        target.balance = parseInt(payload.amount) || 0;
                        room.broadcastUpdate();
                    }
                }
                break;
            }
        }
    });
    socket.on('disconnect', () => {
        const roomId = socketToRoom[socket.id];
        if (rooms[roomId]) {
            const r = rooms[roomId];
            if (r.botTimeout) clearTimeout(r.botTimeout);

            const pIdx = r.players.findIndex(p => p.socketId === socket.id);
            if (pIdx !== -1) {
                const p = r.players[pIdx];
                r.players.splice(pIdx, 1);
                console.log(`Người chơi ${p.name} rời phòng ${roomId}`);

                if (r.players.length === 0) {
                    delete rooms[roomId];
                    console.log(`Phòng ${roomId} đã bị xóa do không còn ai.`);
                } else {
                    io.to(roomId).emit('message', { type: 'PLAYER_LEFT', payload: { clientId: p.clientId } });
                }
            }
        }
        delete socketToRoom[socket.id];
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
