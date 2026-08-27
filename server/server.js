// server/server.js
//
// Servidor de sinalização do CallBox.
// Responsabilidades: criar/gerenciar salas, avisar quem entrou/saiu
// e repassar as mensagens de sinalização do WebRTC (offer, answer, ice-candidate).
//
// O áudio e a tela NUNCA passam por este servidor. Ele só conecta os
// participantes para que o WebRTC (peer-to-peer) possa assumir depois.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;
const MAX_USERS_PER_ROOM = 3;

// Estado das salas em memória. Nada é salvo em disco/banco de dados.
// Formato: { "ABC123": { "<socketId>": { name: "Marcos" }, ... } }
const rooms = {};

app.get('/', (_req, res) => {
  res.send('Servidor de sinalização do CallBox está no ar.');
});

// Rota simples de checagem de saúde (útil para hospedagens gratuitas)
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: Object.keys(rooms).length });
});

io.on('connection', (socket) => {
  console.log(`[conexão] novo socket: ${socket.id}`);

  socket.on('join-room', ({ roomCode, userName }, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};

    const code = String(roomCode || '').trim().toUpperCase();
    const name = String(userName || '').trim();

    if (!code) {
      return callback({ success: false, message: 'Código da sala inválido.' });
    }
    if (!name) {
      return callback({ success: false, message: 'Informe um nome antes de entrar.' });
    }

    if (!rooms[code]) {
      rooms[code] = {};
    }

    const currentIds = Object.keys(rooms[code]);

    if (currentIds.length >= MAX_USERS_PER_ROOM) {
      return callback({ success: false, message: 'Esta sala já está cheia.', reason: 'room-full' });
    }

    // Lista de quem já está na sala, para o recém-chegado poder
    // iniciar as conexões WebRTC com cada um deles.
    const participants = currentIds.map((id) => ({ id, name: rooms[code][id].name }));

    rooms[code][socket.id] = { name };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.userName = name;

    socket.to(code).emit('user-joined', { id: socket.id, name });

    callback({ success: true, roomCode: code, participants });

    console.log(`[sala ${code}] ${name} entrou (${currentIds.length + 1}/${MAX_USERS_PER_ROOM})`);
  });

  // Repasse de sinalização WebRTC. O servidor só encaminha, não interpreta.
  socket.on('offer', ({ to, sdp }) => {
    if (to && sdp) socket.to(to).emit('offer', { from: socket.id, sdp });
  });

  socket.on('answer', ({ to, sdp }) => {
    if (to && sdp) socket.to(to).emit('answer', { from: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (to && candidate) socket.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
    console.log(`[desconexão] socket: ${socket.id}`);
  });
});

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  if (!code || !rooms[code]) return;

  const name = socket.data.userName;
  delete rooms[code][socket.id];
  socket.to(code).emit('user-left', { id: socket.id });
  socket.leave(code);
  socket.data.roomCode = null;

  console.log(`[sala ${code}] ${name || socket.id} saiu`);

  if (Object.keys(rooms[code]).length === 0) {
    delete rooms[code];
    console.log(`[sala ${code}] removida (ficou vazia)`);
  }
}

server.listen(PORT, () => {
  console.log(`Servidor CallBox rodando em http://localhost:${PORT}`);
});
