// server/server.js
//
// Servidor de sinalização do CallBox.
// Responsabilidades: criar/gerenciar salas, avisar quem entrou/saiu
// e repassar as mensagens de sinalização do WebRTC (offer, answer, ice-candidate).
//
// O áudio e a tela NUNCA passam por este servidor. Ele só conecta os
// participantes para que o WebRTC (peer-to-peer) possa assumir depois.
//
// v1.1.0 — CONTAS DE USUÁRIO
// Além da sinalização, o servidor agora também é a autoridade de identidade
// do CallBox: cuida de cadastro/login, guarda as contas de forma persistente
// (arquivo JSON em disco, com hash de senha) e passa a EXIGIR uma sessão
// autenticada válida antes de aceitar qualquer socket de sinalização. Ou
// seja: quem entra numa sala deixa de ser "um nome que o cliente mandou" e
// passa a ser "uma conta que o servidor validou".

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;
const MAX_USERS_PER_ROOM = 3;

app.use(express.json());

// CORS manual e minimalista para as rotas REST de contas (cadastro/login/
// sessão). Evita adicionar mais uma dependência (`cors`) só para isso — o
// app não é um site público, é o cliente Electron do próprio CallBox
// falando com o próprio servidor.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------------------------------------------------------------------------
// v1.1.0 — Persistência de contas
//
// Solução escolhida: um arquivo JSON em disco (server/data/accounts.json),
// escrito de forma atômica (grava em .tmp e só então renomeia — nunca deixa
// o arquivo corrompido se o processo cair no meio de uma escrita).
//
// Por quê um arquivo em vez de um banco de verdade (Postgres, Mongo etc.)?
// O CallBox é um app para poucas pessoas (2-3 amigos por sala) e o pedido
// explícito foi priorizar simplicidade e custo zero. Um arquivo JSON dá
// conta perfeitamente desse volume de contas, não exige nenhum serviço
// pago nem infraestrutura nova, e é trivial de inspecionar/fazer backup.
//
// ⚠️ LIMITAÇÃO IMPORTANTE (hospedagens com disco efêmero):
// Se este servidor estiver hospedado em um plano gratuito cujo sistema de
// arquivos é efêmero (ex: Render Free, que apaga o disco a cada novo
// deploy), o arquivo accounts.json sobrevive a reinícios/"sleep" normais
// do serviço, mas é perdido quando uma NOVA versão é publicada (novo
// deploy). Isso é uma limitação da hospedagem, não desta implementação —
// ver detalhes no relatório final.
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const JWT_SECRET_FILE = path.join(DATA_DIR, 'jwt-secret.txt');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// A chave usada para assinar os tokens de sessão também precisa ser
// persistida (senão, todo restart do servidor invalidaria a sessão de
// todo mundo). Gerada uma única vez, na primeira execução.
function loadOrCreateJwtSecret() {
  if (fs.existsSync(JWT_SECRET_FILE)) {
    return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(JWT_SECRET_FILE, secret, 'utf8');
  return secret;
}

const JWT_SECRET = loadOrCreateJwtSecret();
const SESSION_EXPIRES_IN = '30d';

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return {};
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('[contas] Erro ao ler accounts.json — iniciando com armazenamento vazio:', err);
    return {};
  }
}

function saveAccounts(data) {
  const tmpFile = `${ACCOUNTS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, ACCOUNTS_FILE);
}

// Chave: nome de usuário em minúsculas -> { id, username, passwordHash, createdAt }
let accounts = loadAccounts();

function generateAccountId() {
  let id;
  do {
    id = 'CB-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  } while (Object.values(accounts).some((acc) => acc.id === id));
  return id;
}

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

function validateUsername(username) {
  if (!username || typeof username !== 'string') return 'Preencha todos os campos.';
  if (!USERNAME_REGEX.test(username)) {
    return 'Nome de usuário deve ter de 3 a 20 caracteres (letras, números ou _).';
  }
  return null;
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return 'Preencha todos os campos.';
  if (password.length < 6) return 'A senha deve ter pelo menos 6 caracteres.';
  return null;
}

// Nunca devolve passwordHash para o cliente.
function publicAccount(acc) {
  return { id: acc.id, username: acc.username };
}

function signSession(acc) {
  return jwt.sign({ sub: acc.id, username: acc.username }, JWT_SECRET, {
    expiresIn: SESSION_EXPIRES_IN,
  });
}

// Confirma a assinatura/validade do token E que a conta referenciada ainda
// existe (protege contra um token antigo apontar pra uma conta removida).
function verifySessionToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
  if (!payload || !payload.username || !payload.sub) return null;

  const account = accounts[String(payload.username).toLowerCase()];
  if (!account || account.id !== payload.sub) return null;

  return account;
}

// ---------------------------------------------------------------------------
// Rotas REST — cadastro, login e validação de sessão
// ---------------------------------------------------------------------------

app.post('/api/auth/register', (req, res) => {
  const { username, password, confirmPassword } = req.body || {};

  if (!username || !password || !confirmPassword) {
    return res.status(400).json({ success: false, message: 'Preencha todos os campos.' });
  }

  const trimmedUsername = String(username).trim();

  const usernameError = validateUsername(trimmedUsername);
  if (usernameError) return res.status(400).json({ success: false, message: usernameError });

  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ success: false, message: passwordError });

  if (password !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'As senhas não coincidem.' });
  }

  const key = trimmedUsername.toLowerCase();
  if (accounts[key]) {
    return res.status(409).json({ success: false, message: 'Nome de usuário já está em uso.' });
  }

  // bcrypt/Argon2-style hashing — a senha em si nunca é armazenada.
  const passwordHash = bcrypt.hashSync(password, 10);
  const account = {
    id: generateAccountId(),
    username: trimmedUsername,
    passwordHash,
    createdAt: new Date().toISOString(),
  };

  accounts[key] = account;
  saveAccounts(accounts);

  console.log(`[contas] Nova conta criada: ${trimmedUsername} (${account.id})`);

  const token = signSession(account);
  res.json({ success: true, token, account: publicAccount(account) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Preencha todos os campos.' });
  }

  const key = String(username).trim().toLowerCase();
  const account = accounts[key];

  // Mensagem sempre genérica — não revela se o usuário existe ou não,
  // para dificultar enumeração de contas.
  const genericError = { success: false, message: 'Usuário ou senha incorretos.' };

  if (!account) return res.status(401).json(genericError);

  const passwordOk = bcrypt.compareSync(String(password), account.passwordHash);
  if (!passwordOk) return res.status(401).json(genericError);

  const token = signSession(account);
  res.json({ success: true, token, account: publicAccount(account) });
});

app.get('/api/auth/session', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return res.status(401).json({ valid: false });

  const account = verifySessionToken(token);
  if (!account) return res.status(401).json({ valid: false });

  res.json({ valid: true, account: publicAccount(account) });
});

app.get('/', (_req, res) => {
  res.send('Servidor de sinalização do CallBox está no ar.');
});

// Rota simples de checagem de saúde (útil para hospedagens gratuitas)
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: Object.keys(rooms).length, accounts: Object.keys(accounts).length });
});

// ---------------------------------------------------------------------------
// v1.1.0 — Autenticação do socket de sinalização
//
// Antes desta versão, o servidor confiava no nome que o cliente mandava ao
// entrar numa sala. Agora, TODO socket precisa apresentar um token de
// sessão válido (o mesmo emitido no login/cadastro) já na conexão — quem
// não apresentar, ou apresentar um token inválido/expirado, é recusado
// antes mesmo de poder entrar numa sala. A identidade (id + nome de
// usuário) fica em socket.data.account e é ela — nunca um nome solto vindo
// do cliente — que passa a definir quem é quem dentro das salas.
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const account = token ? verifySessionToken(token) : null;

  if (!account) {
    return next(new Error('unauthorized'));
  }

  socket.data.account = publicAccount(account);
  next();
});

// Estado das salas em memória. Nada é salvo em disco/banco de dados — as
// salas continuam sendo efêmeras, só as CONTAS são persistidas.
// Formato: { "ABC123": { "<socketId>": { name, accountId }, ... } }
const rooms = {};

io.on('connection', (socket) => {
  const account = socket.data.account;
  console.log(`[conexão] novo socket: ${socket.id} — conta ${account.username} (${account.id})`);

  socket.on('join-room', ({ roomCode }, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};

    const code = String(roomCode || '').trim().toUpperCase();

    if (!code) {
      return callback({ success: false, message: 'Código da sala inválido.' });
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
    const participants = currentIds.map((id) => ({
      id,
      name: rooms[code][id].name,
      accountId: rooms[code][id].accountId,
    }));

    // O nome/identidade vem SEMPRE da conta autenticada (socket.data.account),
    // nunca de um campo enviado solto pelo cliente.
    rooms[code][socket.id] = { name: account.username, accountId: account.id };
    socket.join(code);
    socket.data.roomCode = code;

    socket.to(code).emit('user-joined', { id: socket.id, name: account.username, accountId: account.id });

    callback({ success: true, roomCode: code, participants });

    console.log(`[sala ${code}] ${account.username} entrou (${currentIds.length + 1}/${MAX_USERS_PER_ROOM})`);
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

  // Estado de mudo/desmutado do microfone, só para atualizar o ícone dos
  // outros participantes na interface. Não carrega áudio nem nada sensível
  // — é só um "avisa a sala" simples, no mesmo padrão de repasse acima.
  socket.on('mic-state', ({ muted }) => {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.to(code).emit('mic-state', { id: socket.id, muted: !!muted });
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

  const account = socket.data.account;
  delete rooms[code][socket.id];
  socket.to(code).emit('user-left', { id: socket.id });
  socket.leave(code);
  socket.data.roomCode = null;

  console.log(`[sala ${code}] ${(account && account.username) || socket.id} saiu`);

  if (Object.keys(rooms[code]).length === 0) {
    delete rooms[code];
    console.log(`[sala ${code}] removida (ficou vazia)`);
  }
}

server.listen(PORT, () => {
  console.log(`Servidor CallBox rodando em http://localhost:${PORT}`);
});
