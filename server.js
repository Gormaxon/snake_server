// Snake Battle - Multiplayer Server
// Run with: npm start

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = 3000;

// Serve static files (HTML, CSS, JS, assets)
app.use(express.static('.'));

// Game rooms storage
const rooms = new Map();

// Generate random 6-character room code
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude similar chars (I, O, 1, 0)
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Room class to manage game state
class GameRoom {
    constructor(code, hostId) {
        this.code = code;
        this.hostId = hostId;
        this.players = new Map();
        this.gameStarted = false;
        this.maxPlayers = 8;
        this.createdAt = Date.now();
    }

    addPlayer(socketId, username, color) {
        this.players.set(socketId, {
            id: socketId,
            username: username,
            color: color,
            darkerColor: color + '99',
            x: Math.random() * 1920, // Will be set properly on game start
            y: Math.random() * 1080,
            angle: Math.random() * Math.PI * 2,
            segments: [],
            length: 30,
            score: 0,
            alive: true
        });
    }

    removePlayer(socketId) {
        this.players.delete(socketId);
        
        // If host left, assign new host to first remaining player
        if (socketId === this.hostId && this.players.size > 0) {
            this.hostId = Array.from(this.players.keys())[0];
        }
    }

    getPlayerCount() {
        return this.players.size;
    }

    getPlayersData() {
        return Array.from(this.players.values());
    }

    isEmpty() {
        return this.players.size === 0;
    }

    isFull() {
        return this.players.size >= this.maxPlayers;
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`✅ Player connected: ${socket.id}`);
    
    // ===== CREATE ROOM (HOST) =====
    socket.on('createRoom', (data) => {
        let roomCode;
        // Generate unique room code
        do {
            roomCode = generateRoomCode();
        } while (rooms.has(roomCode));
        
        const room = new GameRoom(roomCode, socket.id);
        room.addPlayer(socket.id, data.username, data.color);
        rooms.set(roomCode, room);
        
        socket.join(roomCode);
        socket.currentRoom = roomCode;
        
        console.log(`🎮 Room created: ${roomCode} by ${data.username}`);
        
        socket.emit('roomCreated', {
            code: roomCode,
            isHost: true,
            hostId: socket.id,
            players: room.getPlayersData(),
            maxPlayers: room.maxPlayers
        });
    });
    
    // ===== JOIN ROOM =====
    socket.on('joinRoom', (data) => {
        const roomCode = data.code.toUpperCase();
        const room = rooms.get(roomCode);
        
        if (!room) {
            socket.emit('joinError', { message: 'Room not found!' });
            return;
        }
        
        if (room.gameStarted) {
            socket.emit('joinError', { message: 'Game already in progress!' });
            return;
        }
        
        if (room.isFull()) {
            socket.emit('joinError', { message: `Room is full! (${room.maxPlayers} players max)` });
            return;
        }
        
        room.addPlayer(socket.id, data.username, data.color);
        socket.join(roomCode);
        socket.currentRoom = roomCode;
        
        console.log(`👋 ${data.username} joined room ${roomCode}`);
        
        // Notify player who just joined
        socket.emit('roomJoined', {
            code: roomCode,
            isHost: socket.id === room.hostId,
            hostId: room.hostId,
            players: room.getPlayersData(),
            maxPlayers: room.maxPlayers
        });
        
        // Notify all OTHER players in room
        socket.to(roomCode).emit('playerJoined', {
            players: room.getPlayersData(),
            newPlayerId: socket.id,
            newPlayerName: data.username
        });
    });
    
    // ===== START GAME (Host only) =====
    socket.on('startGame', () => {
        const roomCode = socket.currentRoom;
        const room = rooms.get(roomCode);
        
        if (!room) return;
        
        if (socket.id !== room.hostId) {
            socket.emit('error', { message: 'Only the host can start the game!' });
            return;
        }
        
        // Removed minimum player requirement - can start with any number
        
        room.gameStarted = true;
        
        console.log(`🚀 Game started in room ${roomCode} with ${room.getPlayerCount()} players`);
        io.to(roomCode).emit('gameStarted', {
            players: room.getPlayersData()
        });
    });
    
    // ===== PLAYER MOVEMENT UPDATE =====
    socket.on('playerUpdate', (data) => {
        const roomCode = socket.currentRoom;
        const room = rooms.get(roomCode);
        
        if (!room || !room.gameStarted) return;
        
        const player = room.players.get(socket.id);
        if (!player || !player.alive) return;
        
        // Update player state on server
        player.x = data.x;
        player.y = data.y;
        player.angle = data.angle;
        player.segments = data.segments;
        player.length = data.length;
        player.score = data.score;
        
        // Broadcast to OTHER players in room (not sender)
        socket.to(roomCode).emit('playerMoved', {
            id: socket.id,
            x: data.x,
            y: data.y,
            angle: data.angle,
            segments: data.segments,
            length: data.length,
            score: data.score
        });
    });
    
    // ===== FOOD EATEN =====
    socket.on('foodEaten', (data) => {
        const roomCode = socket.currentRoom;
        if (!roomCode) return;
        
        // Broadcast to ALL players (including sender for confirmation)
        io.to(roomCode).emit('foodEaten', {
            foodIndex: data.foodIndex,
            eatenBy: socket.id,
            newFood: data.newFood // New food position from client
        });
    });
    
    // ===== PLAYER DIED =====
    socket.on('playerDied', (data) => {
        const roomCode = socket.currentRoom;
        const room = rooms.get(roomCode);
        
        if (!room) return;
        
        const player = room.players.get(socket.id);
        if (player) {
            player.alive = false;
        }
        
        console.log(`💀 ${player ? player.username : 'Player'} died in room ${roomCode}`);
        
        // Notify all players
        io.to(roomCode).emit('playerDied', {
            id: socket.id,
            username: player ? player.username : 'Unknown',
            segments: data.segments,
            x: data.x,
            y: data.y
        });
    });
    
    // ===== POWERUP PICKED UP =====
    socket.on('powerupPickup', (data) => {
        const roomCode = socket.currentRoom;
        if (!roomCode) return;
        
        // Broadcast to all players to remove powerup
        io.to(roomCode).emit('powerupPickup', {
            powerupIndex: data.powerupIndex,
            pickedBy: socket.id
        });
    });
    
    // ===== DUEL CHALLENGE =====
    socket.on('duelChallenge', (data) => {
        const roomCode = socket.currentRoom;
        if (!roomCode) return;
        
        io.to(roomCode).emit('duelChallenge', {
            challengerId: socket.id,
            opponentId: data.opponentId
        });
    });
    
    // ===== DUEL RESULT =====
    socket.on('duelResult', (data) => {
        const roomCode = socket.currentRoom;
        if (!roomCode) return;
        
        io.to(roomCode).emit('duelResult', {
            winnerId: data.winnerId,
            loserId: data.loserId
        });
    });
    
    // ===== LEAVE ROOM =====
    socket.on('leaveRoom', () => {
        handlePlayerLeave(socket);
    });
    
    // ===== DISCONNECT =====
    socket.on('disconnect', () => {
        console.log(`❌ Player disconnected: ${socket.id}`);
        handlePlayerLeave(socket);
    });
    
    // Handle player leaving/disconnecting
    function handlePlayerLeave(socket) {
        const roomCode = socket.currentRoom;
        if (!roomCode) return;
        
        const room = rooms.get(roomCode);
        if (!room) return;
        
        const player = room.players.get(socket.id);
        const username = player ? player.username : 'Unknown';
        
        console.log(`👋 ${username} left room ${roomCode}`);
        
        room.removePlayer(socket.id);
        
        // Notify remaining players
        io.to(roomCode).emit('playerLeft', {
            id: socket.id,
            username: username,
            players: room.getPlayersData(),
            newHostId: room.hostId
        });
        
        // Delete room if empty
        if (room.isEmpty()) {
            rooms.delete(roomCode);
            console.log(`🗑️  Room ${roomCode} deleted (empty)`);
        }
        
        socket.leave(roomCode);
        socket.currentRoom = null;
    }
});

// Clean up old/stale rooms every 5 minutes
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes idle
    
    rooms.forEach((room, code) => {
        if (room.isEmpty() || (!room.gameStarted && now - room.createdAt > maxAge)) {
            rooms.delete(code);
            console.log(`🗑️  Room ${code} cleaned up (timeout)`);
        }
    });
}, 5 * 60 * 1000);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        activeRooms: rooms.size,
        timestamp: new Date().toISOString()
    });
});

// Start server
http.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║  🐍 SNAKE BATTLE - Multiplayer Server   ║
╠══════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}      ║
║  WebSocket: Ready for connections        ║
║  Status:    Online ✅                     ║
╚══════════════════════════════════════════╝
    `);
});
