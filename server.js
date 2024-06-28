const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI || 'your_mongodb_uri';

app.use(express.static(path.join(__dirname)));

mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err));

const roomSchema = new mongoose.Schema({
    roomID: String,
    players: [{
        playerID: String,
        playerName: String,
        socketID: String,
        connected: { type: Boolean, default: true }
    }],
    numOfPlayers: Number,
    createdAt: { type: Date, default: Date.now },
    shuffledDeck: [Object],
    hostID: String,
    hostName: String,
    gameStarted: { type: Boolean, default: false },
    startTime: String
});

const Room = mongoose.model('Room', roomSchema);

const numOfEntries = 107;
let arrayToShuffle = Array.from({ length: numOfEntries }, (_, index) => ({ pos: index }));

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

app.get('/api/room/:roomID/players', async (req, res) => {
    const { roomID } = req.params;
    try {
        const room = await Room.findOne({ roomID });
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        res.json(room);
    } catch (error) {
        console.error('Error retrieving players:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/room/:roomID/deck', async (req, res) => {
    const { roomID } = req.params;
    try {
        const room = await Room.findOne({ roomID });
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        res.json(room.shuffledDeck);
    } catch (error) {
        console.error('Error retrieving shuffled deck:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

io.on('connection', (socket) => {
    // console.log('New client connected');

    socket.on('joinRoom', async ({ roomID, playerID, playerName, numOfPlayers, isHost }) => {
        try {
            let room = await Room.findOne({ roomID });

            if (isHost) {
                if (!room) {
                    const shuffledDeck = shuffleArray(arrayToShuffle);
                    room = new Room({
                        roomID,
                        players: [{ playerID, playerName, socketID: socket.id, connected: true }],
                        numOfPlayers,
                        hostID: playerID,
                        hostName: playerName,
                        shuffledDeck,
                        gameStarted: false
                    });
                    await room.save();
                    socket.join(roomID);
                } else {
                    const hostPlayer = room.players.find(p => p.playerID === playerID);
                    if (hostPlayer) {
                        hostPlayer.connected = true;
                        hostPlayer.socketID = socket.id;
                        room.hostID = playerID;
                        room.hostName = playerName;
                        room.numOfPlayers = numOfPlayers;
                        room.startTime = new Date().getTime()
                        await room.save();
                        socket.join(roomID);
                        io.in(roomID).emit('startGame', { players: room.players, deck: room.shuffledDeck });
                    } else {
                        socket.emit('joinRoomError', { message: 'Host player not found in the room.' });
                        return;
                    }
                }
            } else {
                setTimeout(async () => {
                    room = await Room.findOne({ roomID });
                    if (!room) {
                        socket.emit('joinRoomError', { message: 'Room not found' });
                    } else if (room.gameStarted) {
                        socket.emit('gameStarted', { message: 'Game has already started. You cannot join the room.' });
                    } else {
                        const existingPlayer = room.players.find(p => p.playerID === playerID);
                        if (existingPlayer) {
                            existingPlayer.connected = true;
                            existingPlayer.socketID = socket.id;
                        } else {
                            room.players.push({ playerID, playerName, socketID: socket.id, connected: true });
                        }
                        await room.save();
                        socket.join(roomID);
                        const playersCount = room.players.filter(p => p.connected).length;
                        io.in(roomID).emit('waiting', { playersCount, numOfPlayers: room.numOfPlayers });

                        if (playersCount === room.numOfPlayers) {
                            room.gameStarted = true;
                            room.startTime = new Date().getTime()
                            await room.save();
                            io.in(roomID).emit('startGame', { players: room.players, deck: room.shuffledDeck });
                        }
                    }
                }, 5000);
            }
        } catch (error) {
            console.error('Error joining room:', error);
            socket.emit('joinRoomError', { message: 'Error joining room. Please try again.' });
        }
    });

    socket.on('disconnect', async () => {
        // console.log('Client disconnected');
        const room = await Room.findOne({ 'players.socketID': socket.id });
        if (room) {
            const player = room.players.find(p => p.socketID === socket.id);
            if (player) {
                player.connected = false;
                await room.save();
                io.in(room.roomID).emit('singlePlayerDisconnected', { room });
            }
        }
    });

    socket.on("movePlayed", (data) => {
        io.in(data.roomID).emit('movePlayedBy', data);
    });

    socket.on("gamefinished", async (data) => {
        const roomID = data.roomID
        const playerID = data.playerID
        const room = await Room.findOne({ roomID });
        const startTime = room.startTime

        const url = 'https://html5-gaming-bot.web.app/unogame';
        const sign = 'EvzuKF61x9oKOQwh9xrmEmyFIulPNh';

        const data = {
            method: 'win',
            roomID: roomID,
            winnerID: playerID,
            timeStart: startTime
        };
        try {
            await axios.post(url, data, {
                headers: {
                    'sign': sign
                }
            }).then(async () => {
                io.in(data.roomID).emit('gamefinished', ({playerID}));
                await Room.deleteOne({ roomID })
            })

        } catch (error) {
            console.log('Error sending game result:', error);
        }

    });

    socket.on("colorSelected", (data) => {
        // console.log('Color selected:', data);
        io.in(data.roomID).emit('colorSelectedBy', data);
    });

    socket.on("drawFourSelected", (data) => {
        // console.log('Draw four selected:', data);
        io.in(data.roomID).emit('drawFourSelectedBy', data);
    });

});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
