// client/app.js
//
// Lógica do renderer do Electron. Cuida de:
//   1) navegação entre as 3 telas (início, nome, chamada)
//   2) conexão com o servidor de sinalização (Socket.IO)
//   3) conexões WebRTC ponto-a-ponto (malha entre até 3 participantes)
//   4) microfone, compartilhamento de tela e controles da chamada
//
// nodeIntegration está habilitado no Electron (ver electron/main.js), então
// podemos usar require() diretamente aqui, como em um script Node comum.

const { io } = require('socket.io-client');
const { ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_URL = 'http://localhost:3000';
const ICE_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function getServerUrl() {
  return localStorage.getItem('callbox:serverUrl') || DEFAULT_SERVER_URL;
}
function setServerUrl(url) {
  localStorage.setItem('callbox:serverUrl', url);
}

// ---------------------------------------------------------------------------
// Referências de elementos
// ---------------------------------------------------------------------------

const screens = {
  home: document.getElementById('home-screen'),
  name: document.getElementById('name-screen'),
  call: document.getElementById('call-screen'),
};

const roomCodeInput = document.getElementById('room-code-input');
const homeError = document.getElementById('home-error');
const btnJoin = document.getElementById('btn-join');
const btnCreate = document.getElementById('btn-create');

const btnToggleSettings = document.getElementById('btn-toggle-settings');
const settingsBox = document.getElementById('settings-box');
const serverUrlInput = document.getElementById('server-url-input');
const btnSaveServer = document.getElementById('btn-save-server');

const nameInput = document.getElementById('name-input');
const nameError = document.getElementById('name-error');
const btnConfirmName = document.getElementById('btn-confirm-name');
const btnBackName = document.getElementById('btn-back-name');

const roomCodeLabel = document.getElementById('room-code-label');
const btnCopyRoom = document.getElementById('btn-copy-room');
const btnCopyRoom2 = document.getElementById('btn-copy-room-2');
const participantsGrid = document.getElementById('participants-grid');
const callArea = document.querySelector('.call-area');

const screenShareView = document.getElementById('screen-share-view');
const screenShareVideo = document.getElementById('screen-share-video');
const screenShareOwner = document.getElementById('screen-share-owner');

const btnMic = document.getElementById('btn-mic');
const btnScreen = document.getElementById('btn-screen');
const btnLeave = document.getElementById('btn-leave');

const screenPickerOverlay = document.getElementById('screen-picker-overlay');
const screenPickerGrid = document.getElementById('screen-picker-grid');
const btnScreenPickerCancel = document.getElementById('btn-screen-picker-cancel');

const audioSinksContainer = document.getElementById('audio-sinks');
const toastEl = document.getElementById('toast');

// ---------------------------------------------------------------------------
// Estado da aplicação
// ---------------------------------------------------------------------------

let socket = null;
let myName = '';
let pendingAction = null; // 'join' | 'create'
let roomCode = '';

let localStream = null;   // áudio do microfone
let screenStream = null;  // vídeo (+ áudio) da tela compartilhada
let micEnabled = true;
let sharingScreen = false;

const peers = {};             // { peerId: { pc, makingOffer, ignoreOffer, isPolite, readyForNegotiation } }
const participantsInfo = {};  // { peerId: { name } }
let currentScreenSharerId = null; // 'local' ou o id de quem está compartilhando

let audioCtx = null;
const levelMonitors = {}; // { key: { analyser, raf } }  key = 'local' ou peerId

// ---------------------------------------------------------------------------
// Navegação entre telas
// ---------------------------------------------------------------------------

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

function showToast(message, type = 'info', duration = 3500) {
  toastEl.textContent = message;
  toastEl.className = 'toast';
  if (type === 'error') toastEl.classList.add('toast-error');
  if (type === 'success') toastEl.classList.add('toast-success');
  toastEl.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add('hidden'), duration);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem caracteres ambíguos
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ---------------------------------------------------------------------------
// Tela inicial
// ---------------------------------------------------------------------------

serverUrlInput.value = getServerUrl();

btnToggleSettings.addEventListener('click', () => {
  settingsBox.classList.toggle('hidden');
});

btnSaveServer.addEventListener('click', () => {
  const url = serverUrlInput.value.trim();
  if (url) {
    setServerUrl(url);
    showToast('Endereço do servidor salvo.', 'success');
  }
});

btnJoin.addEventListener('click', () => {
  const code = roomCodeInput.value.trim();
  if (!code) {
    return showFieldError(homeError, 'Digite o código da sala.');
  }
  pendingAction = 'join';
  roomCode = code.toUpperCase();
  homeError.classList.add('hidden');
  showScreen('name');
  nameInput.focus();
});

btnCreate.addEventListener('click', () => {
  pendingAction = 'create';
  roomCode = generateRoomCode();
  homeError.classList.add('hidden');
  showScreen('name');
  nameInput.focus();
});

function showFieldError(el, message) {
  el.textContent = message;
  el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Tela de nome
// ---------------------------------------------------------------------------

btnBackName.addEventListener('click', () => {
  showScreen('home');
});

btnConfirmName.addEventListener('click', confirmNameAndJoin);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmNameAndJoin();
});

async function confirmNameAndJoin() {
  const name = nameInput.value.trim();
  if (!name) {
    return showFieldError(nameError, 'Digite um nome para continuar.');
  }
  nameError.classList.add('hidden');
  myName = name;

  btnConfirmName.disabled = true;
  btnConfirmName.textContent = 'Entrando...';

  try {
    await setupLocalAudio();
  } catch (err) {
    btnConfirmName.disabled = false;
    btnConfirmName.textContent = 'Entrar';
    return showFieldError(nameError, mediaErrorMessage(err));
  }

  connectAndJoin();
}

function mediaErrorMessage(err) {
  if (err && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) {
    return 'Não foi possível acessar seu microfone. Verifique se ele está conectado.';
  }
  if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
    return 'Permita o acesso ao microfone nas configurações do Windows.';
  }
  return 'Não foi possível acessar seu microfone.';
}

async function setupLocalAudio() {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
}

// ---------------------------------------------------------------------------
// Conexão com o servidor + entrada na sala
// ---------------------------------------------------------------------------

function connectAndJoin() {
  const url = getServerUrl();

  try {
    socket = io(url, { reconnectionAttempts: 10, timeout: 8000 });
  } catch (err) {
    btnConfirmName.disabled = false;
    btnConfirmName.textContent = 'Entrar';
    return showFieldError(nameError, 'Não foi possível conectar ao servidor.');
  }

  socket.on('connect_error', () => {
    if (!screens.call.classList.contains('hidden')) {
      showToast('Não foi possível conectar ao servidor.', 'error');
    } else {
      btnConfirmName.disabled = false;
      btnConfirmName.textContent = 'Entrar';
      showFieldError(nameError, 'Não foi possível conectar ao servidor.');
      socket.close();
    }
  });

  socket.on('disconnect', () => {
    if (!screens.call.classList.contains('hidden')) {
      showToast('Conexão perdida. Tentando reconectar...', 'error', 6000);
    }
  });

  socket.on('reconnect', () => {
    showToast('Conexão restabelecida.', 'success');
  });

  socket.on('connect', () => {
    socket.emit('join-room', { roomCode, userName: myName }, (response) => {
      if (!response || !response.success) {
        const msg = (response && response.message) || 'Não foi possível entrar na sala.';
        btnConfirmName.disabled = false;
        btnConfirmName.textContent = 'Entrar';
        showFieldError(nameError, msg);
        socket.close();
        socket = null;
        return;
      }

      roomCode = response.roomCode;
      enterCallScreen(response.participants);
    });
  });

  registerSignalingHandlers();
}

function enterCallScreen(existingParticipants) {
  roomCodeLabel.textContent = roomCode;
  showScreen('call');
  btnConfirmName.disabled = false;
  btnConfirmName.textContent = 'Entrar';

  renderParticipants();
  startLevelMonitor('local', localStream);

  if (pendingAction === 'create') {
    copyToClipboard(roomCode);
    showToast(`Sala criada! Código ${roomCode} copiado para a área de transferência.`, 'success', 5000);
  }

  // Conecta (como iniciador) com quem já estava na sala
  existingParticipants.forEach(({ id, name }) => {
    participantsInfo[id] = { name };
    createPeerConnection(id, /* isInitiator */ true);
    renderParticipants();
  });
}

// ---------------------------------------------------------------------------
// Sinalização (Socket.IO) <-> WebRTC
// ---------------------------------------------------------------------------

function registerSignalingHandlers() {
  socket.on('user-joined', ({ id, name }) => {
    participantsInfo[id] = { name };
    // Quem já está na sala espera a oferta de quem entrou agora.
    renderParticipants();
    showToast(`${name} entrou na sala.`);
  });

  socket.on('user-left', ({ id }) => {
    const name = participantsInfo[id]?.name || 'Alguém';
    closePeerConnection(id);
    delete participantsInfo[id];
    if (currentScreenSharerId === id) stopShowingRemoteScreen();
    renderParticipants();
    showToast(`${name} saiu da sala.`);
  });

  socket.on('offer', async ({ from, sdp }) => {
    let state = peers[from];
    if (!state) {
      state = createPeerConnection(from, /* isInitiator */ false);
    }
    const { pc } = state;

    const offerCollision = pc.signalingState !== 'stable' || state.makingOffer;
    state.ignoreOffer = !state.isPolite && offerCollision;
    if (state.ignoreOffer) return;

    try {
      await pc.setRemoteDescription(sdp);
      await pc.setLocalDescription();
      socket.emit('answer', { to: from, sdp: pc.localDescription });
      state.readyForNegotiation = true;
    } catch (err) {
      console.error('Erro ao processar oferta:', err);
    }
  });

  socket.on('answer', async ({ from, sdp }) => {
    const state = peers[from];
    if (!state) return;
    try {
      await state.pc.setRemoteDescription(sdp);
    } catch (err) {
      console.error('Erro ao processar resposta:', err);
    }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const state = peers[from];
    if (!state) return;
    try {
      await state.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!state.ignoreOffer) console.error('Erro ao adicionar ICE candidate:', err);
    }
  });
}

function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  const state = {
    pc,
    makingOffer: false,
    ignoreOffer: false,
    // "Polite peer" (padrão de negociação perfeita do WebRTC): definido de
    // forma determinística comparando os IDs, para os dois lados concordarem.
    isPolite: socket.id < peerId,
    readyForNegotiation: isInitiator,
  };
  peers[peerId] = state;

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }
  if (screenStream) {
    screenStream.getTracks().forEach((track) => pc.addTrack(track, screenStream));
  }

  pc.onnegotiationneeded = async () => {
    if (!state.readyForNegotiation) return;
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('offer', { to: peerId, sdp: pc.localDescription });
    } catch (err) {
      console.error('Erro ao negociar conexão:', err);
    } finally {
      state.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { to: peerId, candidate });
  };

  pc.ontrack = (event) => handleRemoteTrack(peerId, event);

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      showToast('Conexão perdida. Tentando reconectar...', 'error');
    }
  };

  return state;
}

function closePeerConnection(peerId) {
  const state = peers[peerId];
  if (!state) return;
  state.pc.onicecandidate = null;
  state.pc.ontrack = null;
  state.pc.onnegotiationneeded = null;
  state.pc.close();
  delete peers[peerId];

  stopLevelMonitor(peerId);
  const audioEl = document.getElementById(`audio-${peerId}`);
  if (audioEl) audioEl.remove();
}

function handleRemoteTrack(peerId, event) {
  const track = event.track;

  if (track.kind === 'audio') {
    let audioEl = document.getElementById(`audio-${peerId}`);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `audio-${peerId}`;
      audioEl.autoplay = true;
      audioSinksContainer.appendChild(audioEl);
    }
    audioEl.srcObject = new MediaStream([track]);
    startLevelMonitor(peerId, new MediaStream([track]));
    return;
  }

  if (track.kind === 'video') {
    showRemoteScreen(peerId, new MediaStream([track]));
    track.addEventListener('ended', () => {
      if (currentScreenSharerId === peerId) stopShowingRemoteScreen();
    });
  }
}

// ---------------------------------------------------------------------------
// Renderização dos participantes
// ---------------------------------------------------------------------------

function renderParticipants() {
  participantsGrid.innerHTML = '';

  addParticipantCard('local', myName, true);
  Object.entries(participantsInfo).forEach(([id, info]) => {
    addParticipantCard(id, info.name, false);
  });
}

function addParticipantCard(id, name, isMe) {
  const card = document.createElement('div');
  card.className = 'participant-card' + (isMe ? ' is-me' : '');
  card.id = `card-${id}`;

  const isSharing = currentScreenSharerId === id;
  const micOff = isMe && !micEnabled;

  card.innerHTML = `
    <div class="avatar" id="avatar-${id}">${initials(name)}</div>
    <div class="participant-name">
      <span class="status-dot"></span>
      ${escapeHtml(name)}${isMe ? ' (você)' : ''}
      <span class="mic-icon ${micOff ? 'muted' : ''}">${micOff ? '🔇' : '🎙'}</span>
    </div>
    ${isSharing ? '<span class="sharing-badge">Compartilhando tela</span>' : ''}
  `;

  participantsGrid.appendChild(card);
}

function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Compartilhamento de tela
// ---------------------------------------------------------------------------

btnScreen.addEventListener('click', () => {
  if (sharingScreen) stopScreenShare();
  else startScreenShare();
});

// ---------------------------------------------------------------------------
// Seletor de tela/janela
//
// No Windows, o Electron não abre um picker nativo do sistema operacional
// para getDisplayMedia() (isso só existe no macOS 15+). Por isso o processo
// principal (electron/main.js) pede as fontes disponíveis via
// desktopCapturer e manda para cá, e aqui mostramos essa grade de
// miniaturas para o usuário escolher. A escolha volta para o main process
// por IPC, que então libera o getDisplayMedia() no navegador com a fonte
// certa.
// ---------------------------------------------------------------------------

ipcRenderer.on('callbox:screen-picker:open', (_event, sources) => {
  openScreenPicker(sources);
});

function openScreenPicker(sources) {
  screenPickerGrid.innerHTML = '';

  sources.forEach((source) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'screen-picker-item';

    const img = document.createElement('img');
    img.src = source.thumbnailDataUrl || '';
    img.alt = source.name;

    const label = document.createElement('span');
    label.className = 'screen-picker-item-name';
    label.textContent = source.name;

    item.appendChild(img);
    item.appendChild(label);

    item.addEventListener('click', () => {
      closeScreenPicker(source.id);
    });

    screenPickerGrid.appendChild(item);
  });

  screenPickerOverlay.classList.remove('hidden');
}

function closeScreenPicker(chosenId) {
  screenPickerOverlay.classList.add('hidden');
  screenPickerGrid.innerHTML = '';
  ipcRenderer.send('callbox:screen-picker:choice', chosenId || null);
}

btnScreenPickerCancel.addEventListener('click', () => closeScreenPicker(null));

screenPickerOverlay.addEventListener('click', (e) => {
  if (e.target === screenPickerOverlay) closeScreenPicker(null);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !screenPickerOverlay.classList.contains('hidden')) {
    closeScreenPicker(null);
  }
});

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    // Usuário cancelou o seletor de tela/janela: não é um erro de verdade.
    if (err && err.name === 'NotAllowedError') return;
    console.error('Erro ao compartilhar tela:', err);
    showToast('Não foi possível compartilhar a tela.', 'error');
    return;
  }

  sharingScreen = true;
  btnScreen.classList.add('on');
  currentScreenSharerId = 'local';

  showLocalScreenPreview(screenStream);
  renderParticipants();

  // Adiciona as faixas da tela a todas as conexões existentes.
  Object.values(peers).forEach(({ pc }) => {
    screenStream.getTracks().forEach((track) => pc.addTrack(track, screenStream));
  });

  // Se o usuário parar o compartilhamento pelo próprio seletor do sistema.
  screenStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (sharingScreen) stopScreenShare();
  });
}

function stopScreenShare() {
  if (!screenStream) return;

  screenStream.getTracks().forEach((track) => {
    track.stop();
    Object.values(peers).forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track === track);
      if (sender) pc.removeTrack(sender);
    });
  });

  screenStream = null;
  sharingScreen = false;
  btnScreen.classList.remove('on');

  if (currentScreenSharerId === 'local') stopShowingRemoteScreen();
  renderParticipants();
}

function showLocalScreenPreview(stream) {
  screenShareVideo.srcObject = stream;
  // O áudio capturado por getDisplayMedia() é o MESMO áudio que já está
  // tocando no sistema de quem está compartilhando (YouTube, jogo, música,
  // apresentação — qualquer fonte). Se este elemento de vídeo (que só serve
  // de PRÉVIA local) também reproduzir esse áudio, quem compartilha ouve
  // tudo em dobro/eco. A faixa de áudio continua sendo enviada normalmente
  // pelo WebRTC para os outros participantes — apenas a reprodução LOCAL
  // desta prévia é silenciada.
  screenShareVideo.muted = true;
  screenShareOwner.textContent = `${myName} (você) está compartilhando a tela`;
  screenShareView.classList.remove('hidden');
  callArea.classList.add('sharing');
}

function showRemoteScreen(peerId, stream) {
  // Regra simples: só uma tela é exibida por vez (o app é para 2-3 pessoas).
  currentScreenSharerId = peerId;
  screenShareVideo.srcObject = stream;
  // Aqui o vídeo é de outra pessoa (não foi originado por nós), então o
  // áudio dela (se algum dia vier junto por esse mesmo elemento) deve tocar
  // normalmente — é a única forma dos outros participantes ouvirem.
  screenShareVideo.muted = false;
  const name = participantsInfo[peerId]?.name || 'Um participante';
  screenShareOwner.textContent = `${name} está compartilhando a tela`;
  screenShareView.classList.remove('hidden');
  callArea.classList.add('sharing');
  renderParticipants();
}

function stopShowingRemoteScreen() {
  currentScreenSharerId = null;
  screenShareVideo.srcObject = null;
  screenShareVideo.muted = false;
  screenShareView.classList.add('hidden');
  callArea.classList.remove('sharing');
  renderParticipants();
}

// ---------------------------------------------------------------------------
// Microfone
// ---------------------------------------------------------------------------

btnMic.addEventListener('click', () => {
  micEnabled = !micEnabled;
  if (localStream) {
    localStream.getAudioTracks().forEach((track) => (track.enabled = micEnabled));
  }
  btnMic.classList.toggle('active', micEnabled);
  btnMic.querySelector('.control-label').textContent = micEnabled ? 'Mudo' : 'Mudo(x)';
  renderParticipants();
  if (!micEnabled) showToast('Microfone desligado.');
});

// ---------------------------------------------------------------------------
// Copiar código da sala
// ---------------------------------------------------------------------------

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

[btnCopyRoom, btnCopyRoom2].forEach((btn) => {
  btn.addEventListener('click', () => {
    copyToClipboard(roomCode);
    showToast('Código copiado para a área de transferência.', 'success');
  });
});

// ---------------------------------------------------------------------------
// Sair da chamada
// ---------------------------------------------------------------------------

btnLeave.addEventListener('click', leaveCall);

function leaveCall() {
  if (socket) {
    socket.emit('leave-room');
    socket.close();
    socket = null;
  }

  Object.keys(peers).forEach(closePeerConnection);

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }

  stopLevelMonitor('local');
  Object.keys(participantsInfo).forEach((id) => delete participantsInfo[id]);
  audioSinksContainer.innerHTML = '';

  micEnabled = true;
  sharingScreen = false;
  currentScreenSharerId = null;
  pendingAction = null;

  btnMic.classList.add('active');
  btnMic.querySelector('.control-label').textContent = 'Mudo';
  btnScreen.classList.remove('on');
  screenShareView.classList.add('hidden');
  callArea.classList.remove('sharing');

  roomCodeInput.value = '';
  nameInput.value = '';

  showScreen('home');
}

// ---------------------------------------------------------------------------
// Indicador visual de quem está falando (anel ao redor do avatar)
// ---------------------------------------------------------------------------

function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function startLevelMonitor(key, stream) {
  if (!stream || stream.getAudioTracks().length === 0) return;
  stopLevelMonitor(key);

  const ctx = getAudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const level = Math.min(1, avg / 90);

    const avatarEl = document.getElementById(`avatar-${key}`);
    const cardEl = document.getElementById(`card-${key}`);
    if (avatarEl) {
      avatarEl.style.setProperty('--level', level.toFixed(2));
      if (cardEl) cardEl.classList.toggle('speaking', level > 0.18);
    }

    levelMonitors[key].raf = requestAnimationFrame(tick);
  }

  levelMonitors[key] = { analyser, source, raf: requestAnimationFrame(tick) };
}

function stopLevelMonitor(key) {
  const monitor = levelMonitors[key];
  if (!monitor) return;
  cancelAnimationFrame(monitor.raf);
  try { monitor.source.disconnect(); } catch (_e) {}
  delete levelMonitors[key];
}
