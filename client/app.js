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
// v1.0.10 — usamos o módulo `clipboard` nativo do Electron (em vez de
// `navigator.clipboard`) para copiar/colar o código da sala. Como
// nodeIntegration está habilitado (ver electron/main.js), esse módulo já
// está disponível diretamente aqui via require(), sem precisar de nenhuma
// dependência nova. Diferente de `navigator.clipboard`, que no Chromium
// depende de permissões/foco de página e pode falhar silenciosamente sem
// avisar nada, `clipboard.writeText`/`clipboard.readText` são chamadas
// síncronas do próprio sistema operacional — é a forma correta de mexer
// no clipboard dentro de um app Electron com nodeIntegration.
const { ipcRenderer, clipboard } = require('electron');

async function mostrarVersao() {
    const versao = await ipcRenderer.invoke('get-app-version');
    const elemento = document.getElementById('app-version');

    if (elemento) {
        elemento.textContent = `CallBox v${versao}`;
    }
}

mostrarVersao();

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_URL = 'https://callbox-server.onrender.com';
const ICE_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// v1.0.8 — as duas opções de qualidade oferecidas ao iniciar o
// compartilhamento de tela. Valores pensados para um app de chamadas (nem
// exagerados, nem baixos demais): priorizam legibilidade de texto/imagem
// sem prejudicar a estabilidade. `degradationPreference` diz ao WebRTC o
// que sacrificar primeiro se a conexão não aguentar o alvo escolhido —
// resolução (30 FPS — HD, prioriza nitidez/estabilidade) ou um equilíbrio
// que preserva mais a fluidez (60 FPS — FHD).
const SCREEN_SHARE_PRESETS = {
  hd30: {
    label: '30 FPS — HD',
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 2_500_000,
    degradationPreference: 'maintain-resolution',
  },
  fhd60: {
    label: '60 FPS — FHD',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 6_000_000,
    degradationPreference: 'balanced',
  },
};

function getServerUrl() {
  // v1.1.1 — No app PUBLICADO, o servidor é SEMPRE o oficial
  // (DEFAULT_SERVER_URL). Isso evita que um valor antigo salvo no
  // localStorage dessa instalação (ex: um endereço de teste local, como
  // http://localhost:3000) passe a apontar silenciosamente para um
  // servidor errado, sem nenhum aviso na tela — foi exatamente isso que
  // quebrou o cadastro/login na V1.1.0.
  //
  // `isPackagedApp` já existe no app (definido logo abaixo, via IPC com
  // electron/main.js) e é usado para decidir o gate de atualização —
  // reaproveitamos aqui, sem precisar mexer no processo principal.
  //
  // Em modo DEV (npm run dev / electron .) continuamos respeitando o
  // override manual, que é útil para apontar para um servidor local
  // durante o desenvolvimento.
  if (isPackagedApp) return DEFAULT_SERVER_URL;
  return localStorage.getItem('callbox:serverUrl') || DEFAULT_SERVER_URL;
}
function setServerUrl(url) {
  localStorage.setItem('callbox:serverUrl', url);
}

const MIC_DEVICE_KEY = 'callbox:micDeviceId';
function getMicDeviceId() {
  return localStorage.getItem(MIC_DEVICE_KEY) || '';
}
function setMicDeviceId(id) {
  if (id) localStorage.setItem(MIC_DEVICE_KEY, id);
  else localStorage.removeItem(MIC_DEVICE_KEY);
}

// v1.0.8 — saída de áudio (alto-falante/fone) escolhida antes da call.
const SPEAKER_DEVICE_KEY = 'callbox:speakerDeviceId';
function getSpeakerDeviceId() {
  return localStorage.getItem(SPEAKER_DEVICE_KEY) || '';
}
function setSpeakerDeviceId(id) {
  if (id) localStorage.setItem(SPEAKER_DEVICE_KEY, id);
  else localStorage.removeItem(SPEAKER_DEVICE_KEY);
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
const btnPasteRoom = document.getElementById('btn-paste-room');
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

const micSelect = document.getElementById('mic-select');
const micSelectCall = document.getElementById('mic-select-call');
const speakerSelect = document.getElementById('speaker-select');
const micMeterFill = document.getElementById('mic-meter-fill');
const btnTestSound = document.getElementById('btn-test-sound');
const micTestStatus = document.getElementById('mic-test-status');

// v1.0.9 — painel de configurações durante a call.
const btnSettings = document.getElementById('btn-settings');
const settingsOverlay = document.getElementById('settings-overlay');
const btnSettingsClose = document.getElementById('btn-settings-close');
const micSelectSettings = document.getElementById('settings-mic-select');
const speakerSelectSettings = document.getElementById('settings-speaker-select');
const btnTestSoundSettings = document.getElementById('btn-test-sound-settings');

const btnBindMute = document.getElementById('btn-bind-mute');
const btnBindMuteReset = document.getElementById('btn-bind-mute-reset');
const btnBindScreen = document.getElementById('btn-bind-screen');
const btnBindScreenReset = document.getElementById('btn-bind-screen-reset');

const callDurationEl = document.getElementById('call-duration');

const volumePopover = document.getElementById('volume-popover');
const volumePopoverName = document.getElementById('volume-popover-name');
const volumePopoverSlider = document.getElementById('volume-popover-slider');
const volumePopoverPercent = document.getElementById('volume-popover-percent');
const volumePopoverMuteBtn = document.getElementById('volume-popover-mute');

const enableAudioBanner = document.getElementById('enable-audio-banner');
const btnEnableAudio = document.getElementById('btn-enable-audio');

const updateGate = document.getElementById('update-gate');
const updateStateChecking = document.getElementById('update-state-checking');
const updateStateAvailable = document.getElementById('update-state-available');
const updateStateDownloading = document.getElementById('update-state-downloading');
const updateStateInstalling = document.getElementById('update-state-installing');
const updateStateRestarting = document.getElementById('update-state-restarting');
const updateStateError = document.getElementById('update-state-error');
const updateCurrentVersionEl = document.getElementById('update-current-version');
const updateNewVersionEl = document.getElementById('update-new-version');
const updateChangelogBody = document.getElementById('update-changelog-body');
const updateDownloadingVersionEl = document.getElementById('update-downloading-version');
const updateProgressFill = document.getElementById('update-progress-fill');
const updateProgressLabel = document.getElementById('update-progress-label');
const btnInstallUpdate = document.getElementById('btn-install-update');
const btnRetryUpdate = document.getElementById('btn-retry-update');

const roomCodeLabel = document.getElementById('room-code-label');
const btnCopyRoom = document.getElementById('btn-copy-room');
const btnCopyRoom2 = document.getElementById('btn-copy-room-2');
const participantsGrid = document.getElementById('participants-grid');
const callArea = document.querySelector('.call-area');

const screenShareView = document.getElementById('screen-share-view');
const screenShareVideo = document.getElementById('screen-share-video');
const screenShareOwner = document.getElementById('screen-share-owner');
const btnToggleShareAudio = document.getElementById('btn-toggle-share-audio');
const screenSharesPanel = document.getElementById('screen-shares-panel');
const screenSharesList = document.getElementById('screen-shares-list');
const connectionStatusEl = document.getElementById('connection-status');

const btnMic = document.getElementById('btn-mic');
const btnScreen = document.getElementById('btn-screen');
const btnLeave = document.getElementById('btn-leave');

const screenPickerOverlay = document.getElementById('screen-picker-overlay');
const screenPickerGrid = document.getElementById('screen-picker-grid');
const btnScreenPickerCancel = document.getElementById('btn-screen-picker-cancel');

const screenQualityOverlay = document.getElementById('screen-quality-overlay');
const btnQualityHd30 = document.getElementById('btn-quality-hd30');
const btnQualityFhd60 = document.getElementById('btn-quality-fhd60');
const btnQualityCancel = document.getElementById('btn-quality-cancel');

const audioSinksContainer = document.getElementById('audio-sinks');
const toastEl = document.getElementById('toast');

// ---------------------------------------------------------------------------
// v1.0.6 — gate de atualização obrigatória
//
// Roda ANTES de qualquer outra coisa, pra decidir se mostra a tela inicial
// normalmente (modo dev, sem updater) ou se bloqueia tudo com a tela de
// "verificando atualização" enquanto o processo principal consulta o
// GitHub Releases. É uma chamada IPC síncrona de propósito: evita o "flash"
// da tela inicial por trás do gate.
// ---------------------------------------------------------------------------

const isPackagedApp = ipcRenderer.sendSync('callbox:is-packaged');

if (isPackagedApp) {
  screens.home.classList.add('hidden');
  updateGate.classList.remove('hidden');
  showUpdateGateState('checking');
}

function showUpdateGateState(state) {
  [
    updateStateChecking,
    updateStateAvailable,
    updateStateDownloading,
    updateStateInstalling,
    updateStateRestarting,
    updateStateError,
  ].forEach((el) => el.classList.add('hidden'));

  const map = {
    checking: updateStateChecking,
    available: updateStateAvailable,
    downloading: updateStateDownloading,
    installing: updateStateInstalling,
    restarting: updateStateRestarting,
    error: updateStateError,
  };
  if (map[state]) map[state].classList.remove('hidden');
}

// Formata as notas da release num changelog simples. `releaseNotes` do
// electron-updater pode vir como string (uma versão) ou como lista de
// { version, note } (quando várias versões são puladas de uma vez) — nunca
// como texto fixo de uma versão específica escrito aqui no código.
function renderChangelog(releaseNotes) {
  updateChangelogBody.innerHTML = '';

  const notes = [];
  if (typeof releaseNotes === 'string' && releaseNotes.trim()) {
    notes.push(releaseNotes);
  } else if (Array.isArray(releaseNotes)) {
    releaseNotes.forEach((entry) => {
      if (entry && entry.note) notes.push(entry.note);
    });
  }

  if (notes.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'Melhorias e correções.';
    updateChangelogBody.appendChild(p);
    return;
  }

  notes.forEach((noteHtml) => {
    updateChangelogBody.appendChild(changelogNoteToElement(noteHtml));
  });
}

// O corpo da Release do GitHub pode conter marcações simples (linhas
// começando com "-" ou "*" viram lista). Tudo é tratado como texto (nunca
// HTML) antes de ser inserido, para não correr risco de injeção.
function changelogNoteToElement(rawNote) {
  const text = String(rawNote).replace(/<[^>]*>/g, ''); // remove marcação HTML, se vier
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const bulletLines = lines.filter((l) => /^[-*•]\s+/.test(l));

  if (bulletLines.length > 0 && bulletLines.length === lines.length) {
    const ul = document.createElement('ul');
    lines.forEach((line) => {
      const li = document.createElement('li');
      li.textContent = line.replace(/^[-*•]\s+/, '');
      ul.appendChild(li);
    });
    return ul;
  }

  const p = document.createElement('p');
  p.textContent = lines.join(' ');
  return p;
}

ipcRenderer.on('callbox:update:not-available', () => {
  // Sem atualização pendente (ou a checagem falhou) — libera o gate de
  // atualização normalmente. A checagem NUNCA bloqueia o uso, só uma
  // atualização já confirmada bloqueia.
  //
  // v1.1.0: em vez de ir direto para a Home, passamos para o gate de
  // autenticação (contas de usuário) — Home só é liberada com sessão
  // válida (ver startAuthFlow() mais abaixo).
  updateGate.classList.add('hidden');
  startAuthFlow();
});

ipcRenderer.on('callbox:update:available', (_event, { version, currentVersion, releaseNotes }) => {
  updateCurrentVersionEl.textContent = currentVersion || '';
  updateNewVersionEl.textContent = version || '';
  renderChangelog(releaseNotes);
  showUpdateGateState('available');
});

ipcRenderer.on('callbox:update:progress', (_event, { percent }) => {
  updateDownloadingVersionEl.textContent = `CallBox ${updateNewVersionEl.textContent}`;
  updateProgressFill.style.width = `${percent}%`;
  updateProgressLabel.textContent = `${percent}%`;
  showUpdateGateState('downloading');
});

ipcRenderer.on('callbox:update:downloaded', () => {
  showUpdateGateState('installing');
  // Pequena pausa só pra pessoa conseguir ler a mensagem antes do app
  // fechar sozinho para instalar — o processo principal reinicia o app
  // automaticamente logo em seguida.
  setTimeout(() => showUpdateGateState('restarting'), 900);
});

ipcRenderer.on('callbox:update:download-error', () => {
  showUpdateGateState('error');
});

btnInstallUpdate.addEventListener('click', () => {
  ipcRenderer.send('callbox:update:download');
});

btnRetryUpdate.addEventListener('click', () => {
  ipcRenderer.send('callbox:update:download');
});

// ---------------------------------------------------------------------------
// v1.1.0 — Contas de usuário: gate de autenticação obrigatório
//
// Funciona no mesmo espírito do gate de atualização acima: uma camada que
// cobre a tela inteira, sem "Depois"/"Pular"/"Fechar" e sem clique-fora pra
// remover. Enquanto não existir uma sessão válida, a Home (e por
// consequência criar/entrar em sala) fica inacessível por trás dela.
//
// A identidade do usuário (id + nome de usuário) SEMPRE vem do servidor,
// nunca é inventada localmente — o token de sessão emitido no login/
// cadastro é o que prova, a cada ação, quem a pessoa é.
// ---------------------------------------------------------------------------

const authGate = document.getElementById('auth-gate');
const authStateChecking = document.getElementById('auth-state-checking');
const authStateLogin = document.getElementById('auth-state-login');
const authStateRegister = document.getElementById('auth-state-register');

const loginUsernameInput = document.getElementById('login-username-input');
const loginPasswordInput = document.getElementById('login-password-input');
const loginError = document.getElementById('login-error');
const btnLoginSubmit = document.getElementById('btn-login-submit');
const btnGotoRegister = document.getElementById('btn-goto-register');

const registerUsernameInput = document.getElementById('register-username-input');
const registerPasswordInput = document.getElementById('register-password-input');
const registerConfirmInput = document.getElementById('register-confirm-input');
const registerError = document.getElementById('register-error');
const btnRegisterSubmit = document.getElementById('btn-register-submit');
const btnGotoLogin = document.getElementById('btn-goto-login');

const accountBadge = document.getElementById('account-badge');
const accountBadgeUsername = document.getElementById('account-badge-username');
const accountBadgeId = document.getElementById('account-badge-id');
const accountBadgeAvatar = document.getElementById('account-badge-avatar');
const btnOpenAccount = document.getElementById('btn-open-account');
const btnLogout = document.getElementById('btn-logout');
const callAccountLabel = document.getElementById('call-account-label');

// v1.2.0 — Central da Conta
const accountCenterOverlay = document.getElementById('account-center-overlay');
const accountStateMain = document.getElementById('account-state-main');
const accountStateUsername = document.getElementById('account-state-username');
const accountStatePassword = document.getElementById('account-state-password');
const accountStateDelete = document.getElementById('account-state-delete');

const btnAccountClose = document.getElementById('btn-account-close');
const accountAvatarLarge = document.getElementById('account-avatar-large');
const btnChangeAvatar = document.getElementById('btn-change-avatar');
const avatarFileInput = document.getElementById('avatar-file-input');
const accountAvatarStatus = document.getElementById('account-avatar-status');
const accountMainUsername = document.getElementById('account-main-username');
const accountMainId = document.getElementById('account-main-id');
const accountMainCreated = document.getElementById('account-main-created');

const btnGotoChangeUsername = document.getElementById('btn-goto-change-username');
const btnGotoChangePassword = document.getElementById('btn-goto-change-password');
const btnGotoDeleteAccount = document.getElementById('btn-goto-delete-account');

const btnUsernameBack = document.getElementById('btn-username-back');
const usernameCurrentLabel = document.getElementById('username-current-label');
const newUsernameInput = document.getElementById('new-username-input');
const usernameChangePasswordInput = document.getElementById('username-change-password-input');
const btnUsernameSubmit = document.getElementById('btn-username-submit');
const usernameChangeError = document.getElementById('username-change-error');

const btnPasswordBack = document.getElementById('btn-password-back');
const passwordCurrentInput = document.getElementById('password-current-input');
const passwordNewInput = document.getElementById('password-new-input');
const passwordConfirmInput = document.getElementById('password-confirm-input');
const btnPasswordSubmit = document.getElementById('btn-password-submit');
const passwordChangeError = document.getElementById('password-change-error');

const btnDeleteBack = document.getElementById('btn-delete-back');
const deletePasswordInput = document.getElementById('delete-password-input');
const deleteConfirmInput = document.getElementById('delete-confirm-input');
const btnDeleteSubmit = document.getElementById('btn-delete-submit');
const deleteAccountError = document.getElementById('delete-account-error');

if (!isPackagedApp) {
  // Modo dev: não existe verificação de atualização (ver setupAutoUpdater
  // em main.js), então vamos direto para o gate de autenticação. Essa
  // chamada precisa acontecer só a partir daqui — depois que authGate e os
  // demais elementos do auth-gate acima já foram inicializados — senão
  // startAuthFlow() tenta acessar `authGate` antes de ele existir
  // (ReferenceError: Cannot access 'authGate' before initialization).
  startAuthFlow();
}

// Token de sessão (JWT emitido pelo servidor) + dados públicos da conta
// logada. Vivem só em memória no processo do renderer — a cópia que
// sobrevive entre aberturas do CallBox fica criptografada em disco (ver
// callbox:session:* no electron/main.js), nunca em localStorage.
let authToken = null;
let currentAccount = null; // { id, username }

async function sessionGetToken() {
  try {
    return await ipcRenderer.invoke('callbox:session:get');
  } catch (err) {
    console.error('Erro ao ler sessão salva:', err);
    return null;
  }
}
async function sessionSetToken(token) {
  try {
    return await ipcRenderer.invoke('callbox:session:set', token);
  } catch (err) {
    console.error('Erro ao salvar sessão:', err);
    return false;
  }
}
async function sessionClearToken() {
  try {
    return await ipcRenderer.invoke('callbox:session:clear');
  } catch (err) {
    console.error('Erro ao limpar sessão:', err);
    return false;
  }
}

// Pequeno wrapper de fetch contra o mesmo servidor de sinalização (rotas
// REST /api/auth/*). Nunca deixa uma falha de rede virar uma exceção não
// tratada — sempre volta como { ok:false } com uma mensagem amigável.
async function apiRequest(path, { method = 'GET', body, token } = {}) {
  const base = getServerUrl().replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Log de diagnóstico: mostra qual servidor o app tentou usar e o motivo
    // da falha de rede. Nunca inclui headers/body (token, senha etc.).
    console.error(`[apiRequest] Falha ao conectar em ${base}${path}:`, err && err.message);
    return { ok: false, status: 0, data: { message: 'Não foi possível conectar ao servidor.' } };
  }

  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    data = {};
  }
  return { ok: res.ok, status: res.status, data };
}

function showAuthGateState(state) {
  [authStateChecking, authStateLogin, authStateRegister].forEach((el) => el.classList.add('hidden'));
  const map = { checking: authStateChecking, login: authStateLogin, register: authStateRegister };
  if (map[state]) map[state].classList.remove('hidden');
}

function clearAuthErrors() {
  loginError.classList.add('hidden');
  registerError.classList.add('hidden');
}

// v1.2.0 — preenche um elemento .avatar com a foto do usuário (se houver)
// ou com as iniciais do nome, reaproveitando o mesmo padrão visual já usado
// nos cards de participante da call.
function renderAvatarInto(el, account) {
  if (!el || !account) return;
  if (account.avatarDataUrl) {
    el.style.backgroundImage = `url("${account.avatarDataUrl}")`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = 'none';
    el.textContent = initials(account.username);
  }
}

function updateAccountBadge() {
  if (!currentAccount) {
    accountBadge.classList.add('hidden');
    if (callAccountLabel) callAccountLabel.textContent = '';
    return;
  }
  accountBadgeUsername.textContent = currentAccount.username;
  accountBadgeId.textContent = currentAccount.id;
  renderAvatarInto(accountBadgeAvatar, currentAccount);
  accountBadge.classList.remove('hidden');
  if (callAccountLabel) callAccountLabel.textContent = `👤 ${currentAccount.username}`;
}

// Ponto de entrada do fluxo de autenticação: roda uma vez, no boot do app
// (depois do gate de atualização resolver, ou direto em modo dev). Tenta
// reaproveitar uma sessão salva; se não houver uma válida, mostra o login.
async function startAuthFlow() {
  authGate.classList.remove('hidden');
  clearAuthErrors();
  showAuthGateState('checking');

  const savedToken = await sessionGetToken();

  if (savedToken) {
    const { ok, data } = await apiRequest('/api/auth/session', { token: savedToken });
    if (ok && data.valid && data.account) {
      authToken = savedToken;
      currentAccount = data.account;
      finishAuthFlow();
      return;
    }
    // Token ausente/expirado/inválido — não deixa uma conta antiga
    // "autenticada" sem realmente ser: limpa e pede login de novo.
    await sessionClearToken();
  }

  showAuthGateState('login');
}

// Login/cadastro validados com sucesso: remove o bloqueio e libera a Home,
// exatamente como a atualização obrigatória libera o app quando conclui.
function finishAuthFlow() {
  authGate.classList.add('hidden');
  updateAccountBadge();
  showScreen('home');
}

btnGotoRegister.addEventListener('click', () => {
  clearAuthErrors();
  showAuthGateState('register');
});
btnGotoLogin.addEventListener('click', () => {
  clearAuthErrors();
  showAuthGateState('login');
});

async function doLogin() {
  const username = loginUsernameInput.value.trim();
  const password = loginPasswordInput.value;

  if (!username || !password) {
    return showFieldError(loginError, 'Preencha todos os campos.');
  }

  loginError.classList.add('hidden');
  btnLoginSubmit.disabled = true;
  btnLoginSubmit.textContent = 'Entrando...';

  const { ok, data } = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });

  btnLoginSubmit.disabled = false;
  btnLoginSubmit.textContent = 'ENTRAR';

  if (!ok || !data.success) {
    // Mensagem genérica do servidor ("Usuário ou senha incorretos.") —
    // nunca revelamos aqui se o usuário existe ou não.
    return showFieldError(loginError, data.message || 'Não foi possível entrar.');
  }

  authToken = data.token;
  currentAccount = data.account;
  await sessionSetToken(authToken);
  loginPasswordInput.value = '';
  finishAuthFlow();
}

async function doRegister() {
  const username = registerUsernameInput.value.trim();
  const password = registerPasswordInput.value;
  const confirmPassword = registerConfirmInput.value;

  if (!username || !password || !confirmPassword) {
    return showFieldError(registerError, 'Preencha todos os campos.');
  }
  if (password !== confirmPassword) {
    return showFieldError(registerError, 'As senhas não coincidem.');
  }

  registerError.classList.add('hidden');
  btnRegisterSubmit.disabled = true;
  btnRegisterSubmit.textContent = 'Criando...';

  const { ok, data } = await apiRequest('/api/auth/register', {
    method: 'POST',
    body: { username, password, confirmPassword },
  });

  btnRegisterSubmit.disabled = false;
  btnRegisterSubmit.textContent = 'CRIAR CONTA';

  if (!ok || !data.success) {
    return showFieldError(registerError, data.message || 'Não foi possível criar a conta.');
  }

  authToken = data.token;
  currentAccount = data.account;
  await sessionSetToken(authToken);
  registerPasswordInput.value = '';
  registerConfirmInput.value = '';
  showToast('Conta criada com sucesso!', 'success');
  finishAuthFlow();
}

btnLoginSubmit.addEventListener('click', doLogin);
[loginUsernameInput, loginPasswordInput].forEach((el) => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
});

btnRegisterSubmit.addEventListener('click', doRegister);
[registerUsernameInput, registerPasswordInput, registerConfirmInput].forEach((el) => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });
});

// "Sair da conta" só existe na Home (nunca durante uma call — para chegar
// à Home a pessoa já precisa ter saído de qualquer chamada em andamento
// primeiro), então não há uma call ativa para tratar aqui.
btnLogout.addEventListener('click', async () => {
  await sessionClearToken();
  authToken = null;
  currentAccount = null;
  updateAccountBadge();
  loginUsernameInput.value = '';
  loginPasswordInput.value = '';
  clearAuthErrors();
  showAuthGateState('login');
  authGate.classList.remove('hidden');
  showToast('Você saiu da conta.');
});

// ---------------------------------------------------------------------------
// v1.2.0 — Central da Conta ("Minha Conta")
//
// Painel dentro da própria janela (mesmo padrão do modal de Configurações
// da call), usando o sistema de autenticação já existente — nenhuma conta
// nova, nenhum token novo além do que já é emitido no login/cadastro.
// Toda validação de segurança (senha atual, dono da conta) é feita no
// SERVIDOR; aqui só cuidamos de UI e chamadas via apiRequest().
// ---------------------------------------------------------------------------

function formatCreatedAt(createdAtIso) {
  if (!createdAtIso) return 'Não disponível (conta anterior a esta atualização)';
  try {
    const date = new Date(createdAtIso);
    if (Number.isNaN(date.getTime())) return 'Não disponível';
    return date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (err) {
    return 'Não disponível';
  }
}

function showAccountCenterState(state) {
  [accountStateMain, accountStateUsername, accountStatePassword, accountStateDelete]
    .forEach((el) => el.classList.add('hidden'));
  const map = {
    main: accountStateMain,
    username: accountStateUsername,
    password: accountStatePassword,
    delete: accountStateDelete,
  };
  if (map[state]) map[state].classList.remove('hidden');
}

function clearAccountCenterErrors() {
  [usernameChangeError, passwordChangeError, deleteAccountError, accountAvatarStatus]
    .forEach((el) => el && el.classList.add('hidden'));
}

function renderAccountCenterMain() {
  if (!currentAccount) return;
  renderAvatarInto(accountAvatarLarge, currentAccount);
  accountMainUsername.textContent = currentAccount.username;
  accountMainId.textContent = `ID: ${currentAccount.id}`;
  accountMainCreated.textContent = `Conta criada em: ${formatCreatedAt(currentAccount.createdAt)}`;
}

function openAccountCenter() {
  if (!currentAccount) return;
  clearAccountCenterErrors();
  newUsernameInput.value = '';
  usernameChangePasswordInput.value = '';
  passwordCurrentInput.value = '';
  passwordNewInput.value = '';
  passwordConfirmInput.value = '';
  deletePasswordInput.value = '';
  deleteConfirmInput.value = '';
  usernameCurrentLabel.textContent = currentAccount.username;
  renderAccountCenterMain();
  showAccountCenterState('main');
  accountCenterOverlay.classList.remove('hidden');
}

function closeAccountCenter() {
  accountCenterOverlay.classList.add('hidden');
}

btnOpenAccount.addEventListener('click', openAccountCenter);
if (callAccountLabel) callAccountLabel.addEventListener('click', openAccountCenter);
btnAccountClose.addEventListener('click', closeAccountCenter);
accountCenterOverlay.addEventListener('click', (e) => {
  if (e.target === accountCenterOverlay) closeAccountCenter();
});

btnGotoChangeUsername.addEventListener('click', () => {
  clearAccountCenterErrors();
  usernameCurrentLabel.textContent = currentAccount.username;
  newUsernameInput.value = '';
  usernameChangePasswordInput.value = '';
  showAccountCenterState('username');
});
btnGotoChangePassword.addEventListener('click', () => {
  clearAccountCenterErrors();
  passwordCurrentInput.value = '';
  passwordNewInput.value = '';
  passwordConfirmInput.value = '';
  showAccountCenterState('password');
});
btnGotoDeleteAccount.addEventListener('click', () => {
  clearAccountCenterErrors();
  deletePasswordInput.value = '';
  deleteConfirmInput.value = '';
  showAccountCenterState('delete');
});

btnUsernameBack.addEventListener('click', () => { clearAccountCenterErrors(); showAccountCenterState('main'); });
btnPasswordBack.addEventListener('click', () => { clearAccountCenterErrors(); showAccountCenterState('main'); });
btnDeleteBack.addEventListener('click', () => { clearAccountCenterErrors(); showAccountCenterState('main'); });

// ---- Alterar username --------------------------------------------------

async function doChangeUsername() {
  const newUsername = newUsernameInput.value.trim();
  const currentPassword = usernameChangePasswordInput.value;

  if (!newUsername || !currentPassword) {
    return showFieldError(usernameChangeError, 'Preencha todos os campos.');
  }

  usernameChangeError.classList.add('hidden');
  btnUsernameSubmit.disabled = true;
  btnUsernameSubmit.textContent = 'Salvando...';

  const { ok, data } = await apiRequest('/api/account/username', {
    method: 'POST',
    token: authToken,
    body: { newUsername, currentPassword },
  });

  btnUsernameSubmit.disabled = false;
  btnUsernameSubmit.textContent = 'Salvar alterações';

  if (!ok || !data.success) {
    return showFieldError(usernameChangeError, data.message || 'Não foi possível concluir a operação. Tente novamente.');
  }

  // v1.2.0 — o servidor reemite o token com o novo username; atualizamos a
  // sessão local (memória + armazenamento criptografado) para não derrubar
  // o login, e refletimos a mudança imediatamente em toda a interface.
  authToken = data.token;
  currentAccount = data.account;
  await sessionSetToken(authToken);

  updateAccountBadge();
  renderAccountCenterMain();
  usernameChangePasswordInput.value = '';
  showToast('Username alterado com sucesso.', 'success');
  showAccountCenterState('main');
}

btnUsernameSubmit.addEventListener('click', doChangeUsername);
[newUsernameInput, usernameChangePasswordInput].forEach((el) => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doChangeUsername(); });
});

// ---- Alterar senha -------------------------------------------------------

async function doChangePassword() {
  const currentPassword = passwordCurrentInput.value;
  const newPassword = passwordNewInput.value;
  const confirmPassword = passwordConfirmInput.value;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return showFieldError(passwordChangeError, 'Preencha todos os campos.');
  }
  if (newPassword !== confirmPassword) {
    return showFieldError(passwordChangeError, 'As senhas não coincidem.');
  }

  passwordChangeError.classList.add('hidden');
  btnPasswordSubmit.disabled = true;
  btnPasswordSubmit.textContent = 'Alterando...';

  const { ok, data } = await apiRequest('/api/account/password', {
    method: 'POST',
    token: authToken,
    body: { currentPassword, newPassword, confirmPassword },
  });

  btnPasswordSubmit.disabled = false;
  btnPasswordSubmit.textContent = 'Alterar senha';

  if (!ok || !data.success) {
    return showFieldError(passwordChangeError, data.message || 'Não foi possível concluir a operação. Tente novamente.');
  }

  passwordCurrentInput.value = '';
  passwordNewInput.value = '';
  passwordConfirmInput.value = '';
  showToast('Senha alterada com sucesso.', 'success');
  showAccountCenterState('main');
}

btnPasswordSubmit.addEventListener('click', doChangePassword);
[passwordCurrentInput, passwordNewInput, passwordConfirmInput].forEach((el) => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doChangePassword(); });
});

// ---- Alterar avatar --------------------------------------------------

const AVATAR_MAX_SOURCE_BYTES = 8 * 1024 * 1024; // 8MB — limite do arquivo escolhido, antes de comprimir
const AVATAR_TARGET_SIZE = 256; // px — o avatar é redimensionado no client antes de enviar

// Redimensiona/comprime a imagem escolhida via <canvas> antes de enviar,
// para nunca depender de o usuário já ter uma imagem pequena — e para
// manter o payload enviado ao servidor sempre pequeno.
function fileToCompressedAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Arquivo não parece ser uma imagem válida.'));
      img.onload = () => {
        const size = AVATAR_TARGET_SIZE;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // "cover": corta a imagem num quadrado central, sem distorcer.
        const scale = Math.max(size / img.width, size / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        ctx.drawImage(img, (size - drawW) / 2, (size - drawH) / 2, drawW, drawH);

        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

btnChangeAvatar.addEventListener('click', () => avatarFileInput.click());

avatarFileInput.addEventListener('change', async () => {
  const file = avatarFileInput.files && avatarFileInput.files[0];
  avatarFileInput.value = ''; // permite escolher o mesmo arquivo de novo depois
  if (!file) return;

  accountAvatarStatus.classList.add('hidden');

  if (!file.type || !file.type.startsWith('image/')) {
    return showFieldError(accountAvatarStatus, 'Escolha um arquivo de imagem.');
  }
  if (file.size > AVATAR_MAX_SOURCE_BYTES) {
    return showFieldError(accountAvatarStatus, 'Imagem muito grande. Escolha uma imagem menor.');
  }

  btnChangeAvatar.disabled = true;

  let dataUrl;
  try {
    dataUrl = await fileToCompressedAvatarDataUrl(file);
  } catch (err) {
    btnChangeAvatar.disabled = false;
    return showFieldError(accountAvatarStatus, err.message || 'Não foi possível processar a imagem.');
  }

  const { ok, data } = await apiRequest('/api/account/avatar', {
    method: 'POST',
    token: authToken,
    body: { avatarDataUrl: dataUrl },
  });

  btnChangeAvatar.disabled = false;

  if (!ok || !data.success) {
    return showFieldError(accountAvatarStatus, data.message || 'Não foi possível concluir a operação. Tente novamente.');
  }

  currentAccount = data.account;
  updateAccountBadge();
  renderAccountCenterMain();
  showToast('Avatar atualizado com sucesso.', 'success');
});

// ---- Excluir conta ---------------------------------------------------

async function doDeleteAccount() {
  const currentPassword = deletePasswordInput.value;
  const confirm = deleteConfirmInput.value;

  if (!currentPassword) {
    return showFieldError(deleteAccountError, 'Preencha todos os campos.');
  }
  if (confirm.trim().toUpperCase() !== 'EXCLUIR') {
    return showFieldError(deleteAccountError, 'Digite EXCLUIR para confirmar.');
  }

  deleteAccountError.classList.add('hidden');
  btnDeleteSubmit.disabled = true;
  btnDeleteSubmit.textContent = 'Excluindo...';

  const { ok, data } = await apiRequest('/api/account/delete', {
    method: 'POST',
    token: authToken,
    body: { currentPassword, confirm },
  });

  btnDeleteSubmit.disabled = false;
  btnDeleteSubmit.textContent = 'Excluir minha conta';

  if (!ok || !data.success) {
    return showFieldError(deleteAccountError, data.message || 'Não foi possível concluir a operação. Tente novamente.');
  }

  // Mesma limpeza de sessão do logout: encerra a sessão local, fecha a
  // Central da Conta e devolve a pessoa para a tela de login — a conta
  // excluída não existe mais no servidor, então nenhum token antigo volta
  // a funcionar (ver requireAuth/verifySessionToken no server.js).
  closeAccountCenter();
  await sessionClearToken();
  authToken = null;
  currentAccount = null;
  updateAccountBadge();
  loginUsernameInput.value = '';
  loginPasswordInput.value = '';
  clearAuthErrors();
  showAuthGateState('login');
  authGate.classList.remove('hidden');
  showToast('Conta excluída com sucesso.');
}

btnDeleteSubmit.addEventListener('click', doDeleteAccount);
[deletePasswordInput, deleteConfirmInput].forEach((el) => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doDeleteAccount(); });
});

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
// v1.0.8 — preset de qualidade (30 FPS—HD ou 60 FPS—FHD) do compartilhamento
// de tela em andamento. Usado para aplicar a mesma configuração de
// bitrate/FPS às conexões que forem abertas DEPOIS que o compartilhamento
// já começou (ex: alguém entra na sala no meio do compartilhamento).
let currentScreenSharePreset = null;
let pendingMicErrorMessage = null; // erro de mic ocorrido antes de entrar na call
let micTrackRetryTimeout = null;
let micTestStream = null; // stream temporária usada só no teste da tela de nome
let micTestLevelRaf = null;
let hasEnteredCallOnce = false; // diferencia 1ª entrada de reconexão automática

// v1.0.9 — duração da chamada. Guardamos o TIMESTAMP de início (não um
// contador incrementado a cada tick) justamente para o tempo mostrado ser
// sempre o decorrido real (Date.now() - início), mesmo que a janela perca
// foco e o setInterval atrase ou pule ticks.
let callDurationStartTs = null;
let callDurationInterval = null;

const peers = {};             // { peerId: { pc, makingOffer, ignoreOffer, isPolite, readyForNegotiation, micSender, screenVideoSender, screenAudioSender } }
const participantsInfo = {};  // { peerId: { name } }
const micMuted = {};          // { peerId: boolean } — estado de mudo dos OUTROS participantes

// v1.0.9 — volume individual por participante (só para o usuário LOCAL,
// nunca afeta o que os outros ouvem). peerId é o socket.id — muda a cada
// reconexão/nova sessão, então não é um identificador estável o bastante
// para persistir entre calls; a preferência dura apenas a sessão atual (ver
// seção "Volume individual" mais abaixo para detalhes).
const participantVolumes = {}; // { peerId: { volume: 0..1, muted: boolean } }

// v1.0.5 — compartilhamento de tela múltiplo: várias pessoas podem
// compartilhar ao mesmo tempo. `remoteScreenShares` guarda TODOS os
// compartilhamentos remotos ativos; `watchingId` diz qual deles (ou o
// próprio, 'local') está em destaque na tela grande no momento.
const remoteScreenShares = {}; // { peerId: { stream } }
let watchingId = null;         // 'local' | peerId | null
let screenAudioManuallyMuted = false; // usuário silenciou manualmente o áudio da tela em destaque

let audioCtx = null;
const levelMonitors = {}; // { key: { analyser, raf } }  key = 'local' ou peerId
const pendingAudioEls = new Set(); // elementos <audio> que o autoplay bloqueou

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

// v1.1.0 — a identidade dentro da sala agora é a conta autenticada, não um
// nome livre digitado aqui. O campo continua existindo (só pra mostrar
// quem vai entrar, no mesmo lugar de sempre), mas vem preenchido com o
// nome de usuário da conta e travado — quem manda de verdade é o servidor,
// a partir do token de sessão, de qualquer forma.
function prefillNameFromAccount() {
  if (currentAccount) {
    nameInput.value = currentAccount.username;
    nameInput.readOnly = true;
  }
}

btnJoin.addEventListener('click', () => {
  const code = roomCodeInput.value.trim();
  if (!code) {
    return showFieldError(homeError, 'Digite o código da sala.');
  }
  pendingAction = 'join';
  roomCode = code.toUpperCase();
  homeError.classList.add('hidden');
  prefillNameFromAccount();
  showScreen('name');
  nameInput.focus();
  startMicTest();
});

btnCreate.addEventListener('click', () => {
  pendingAction = 'create';
  roomCode = generateRoomCode();
  homeError.classList.add('hidden');
  prefillNameFromAccount();
  showScreen('name');
  nameInput.focus();
  startMicTest();
});

// v1.0.10 — botão "Colar": lê o clipboard real do sistema operacional e
// coloca o conteúdo no campo de código. Se o clipboard estiver vazio ou
// não puder ser lido, mostra um aviso — nunca finge que colou algo.
btnPasteRoom.addEventListener('click', () => {
  let text = '';
  try {
    text = clipboard.readText();
  } catch (err) {
    console.error('Erro ao ler a área de transferência:', err);
    return showFieldError(homeError, 'Não foi possível ler a área de transferência.');
  }

  text = (text || '').trim();

  if (!text) {
    return showFieldError(homeError, 'Não há nenhum código na área de transferência.');
  }

  homeError.classList.add('hidden');
  roomCodeInput.value = text.toUpperCase().slice(0, 8);
  roomCodeInput.focus();
});

function showFieldError(el, message) {
  el.textContent = message;
  el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Tela de nome
// ---------------------------------------------------------------------------

btnBackName.addEventListener('click', () => {
  stopMicTest();
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
    // NÃO bloqueia a entrada: quem está sem microfone disponível (sem
    // permissão, sem dispositivo, etc.) ainda consegue entrar na sala e
    // ouvir os outros participantes normalmente — só não transmite áudio
    // até resolver o problema (o botão de mic na call permite tentar de
    // novo a qualquer momento).
    console.error('Erro ao acessar o microfone:', err);
    localStream = null;
    pendingMicErrorMessage = mediaErrorMessage(err);
  }

  connectAndJoin();
}

function mediaErrorMessage(err) {
  if (err && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) {
    return 'Nenhum microfone encontrado. Verifique se ele está conectado.';
  }
  if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
    return 'Permita o acesso ao microfone nas configurações do Windows.';
  }
  if (err && err.name === 'NotReadableError') {
    return 'Não foi possível usar o microfone — ele pode estar em uso por outro programa (ex: outra chamada aberta).';
  }
  if (err && err.name === 'OverconstrainedError') {
    return 'O microfone selecionado não está mais disponível. Usando o microfone padrão.';
  }
  return 'Não foi possível acessar seu microfone.';
}

// Pede o microfone já tratando o caso do dispositivo salvo ter sido
// removido (ex: fone USB desconectado) — nesse caso volta pro padrão do
// sistema em vez de simplesmente falhar.
async function getMicStream(deviceId) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
  } catch (err) {
    if (err && err.name === 'OverconstrainedError' && deviceId) {
      setMicDeviceId('');
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw err;
  }
}

function attachMicWatchers(track) {
  track.addEventListener('ended', handleMicTrackEnded);
  track.addEventListener('mute', handleMicTrackMuted);
  track.addEventListener('unmute', handleMicTrackUnmuted);
}

function handleMicTrackEnded() {
  // O dispositivo sumiu (desconectado, ou outro app tomou acesso
  // exclusivo). Avisa, tenta recuperar automaticamente UMA vez (sem ficar
  // pedindo permissão em loop) e, se não conseguir, deixa claro que dá pra
  // tentar de novo clicando no botão de mic.
  if (!localStream) return;
  const wasEnabled = micEnabled;

  showToast('Seu microfone ficou indisponível (desconectado ou em uso por outro programa). Tentando reconectar...', 'error', 5000);
  localStream = null;
  stopLevelMonitor('local');
  setMicButtonState('error');
  renderParticipants();

  clearTimeout(micTrackRetryTimeout);
  micTrackRetryTimeout = setTimeout(async () => {
    try {
      const stream = await getMicStream(getMicDeviceId());
      const track = stream.getAudioTracks()[0];
      track.enabled = wasEnabled;
      attachMicWatchers(track);
      localStream = stream;
      applyMicTrackToAllPeers(track);
      startLevelMonitor('local', localStream);
      setMicButtonState(wasEnabled ? 'on' : 'muted');
      showToast('Microfone reconectado.', 'success');
    } catch (err) {
      setMicButtonState('unavailable');
      showToast(mediaErrorMessage(err), 'error', 6000);
    }
    renderParticipants();
  }, 1500);
}

function handleMicTrackMuted() {
  showToast('Sinal do microfone interrompido momentaneamente.', 'error', 3000);
}

function handleMicTrackUnmuted() {
  // Volta ao normal sozinho — não precisa de nenhuma ação aqui.
}

async function setupLocalAudio() {
  // Se a pessoa já testou o microfone na tela anterior, reaproveita esse
  // stream em vez de pedir permissão de novo.
  const testTrack = micTestStream && micTestStream.getAudioTracks()[0];
  if (testTrack && testTrack.readyState === 'live') {
    localStream = micTestStream;
    micTestStream = null; // agora pertence à call — stopMicTest() não deve parar
    if (micTestLevelRaf) cancelAnimationFrame(micTestLevelRaf);
    micTestLevelRaf = null;
  } else {
    localStream = await getMicStream(getMicDeviceId());
  }

  const track = localStream.getAudioTracks()[0];
  attachMicWatchers(track);
}

// ---------------------------------------------------------------------------
// Seleção e teste de microfone (tela de nome + troca durante a call)
// ---------------------------------------------------------------------------

async function populateMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const savedMicId = getMicDeviceId();

    [micSelect, micSelectCall, micSelectSettings].forEach((select) => {
      if (!select) return;
      select.innerHTML = '';
      mics.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microfone ${i + 1}`;
        select.appendChild(opt);
      });
      if (savedMicId && mics.some((d) => d.deviceId === savedMicId)) {
        select.value = savedMicId;
      }
    });

    // v1.0.8 — saída de áudio (alto-falante/fone), escolhida antes da call
    // do mesmo jeito que o microfone. Só existe no navegador/Electron se
    // HTMLMediaElement.setSinkId estiver disponível (Chromium tem).
    const speakerSelects = [speakerSelect, speakerSelectSettings].filter(Boolean);
    if (speakerSelects.length > 0) {
      const speakers = devices.filter((d) => d.kind === 'audiooutput');
      const savedSpeakerId = getSpeakerDeviceId();
      const sinkSupported = typeof HTMLMediaElement !== 'undefined'
        && typeof HTMLMediaElement.prototype.setSinkId === 'function';

      speakerSelects.forEach((select) => {
        select.innerHTML = '';
        if (!sinkSupported || speakers.length === 0) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'Padrão do sistema';
          select.appendChild(opt);
          select.disabled = true;
        } else {
          select.disabled = false;
          speakers.forEach((d, i) => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Saída de áudio ${i + 1}`;
            select.appendChild(opt);
          });
          if (savedSpeakerId && speakers.some((d) => d.deviceId === savedSpeakerId)) {
            select.value = savedSpeakerId;
          }
        }
      });
    }
  } catch (err) {
    console.error('Erro ao listar dispositivos de áudio:', err);
  }
}

// Aplica a saída de áudio escolhida a um elemento <audio>/<video> específico.
// Silencioso quando o navegador não suporta setSinkId ou nada foi escolhido
// (nesse caso o dispositivo padrão do sistema continua sendo usado).
async function applySpeakerToElement(el) {
  if (!el || typeof el.setSinkId !== 'function') return;
  const id = getSpeakerDeviceId();
  if (!id) return;
  try {
    await el.setSinkId(id);
  } catch (err) {
    console.error('Erro ao aplicar dispositivo de saída de áudio:', err);
  }
}

// Reaplica a saída de áudio escolhida a tudo que já está tocando (usado
// quando o usuário troca a saída durante a call).
function applySpeakerToAllAudioEls() {
  audioSinksContainer.querySelectorAll('audio').forEach((el) => applySpeakerToElement(el));
  applySpeakerToElement(screenShareVideo);
}

function syncSpeakerSelectValue(value) {
  [speakerSelect, speakerSelectSettings].forEach((sel) => {
    if (sel) sel.value = value;
  });
}

if (speakerSelect) {
  speakerSelect.addEventListener('change', () => {
    setSpeakerDeviceId(speakerSelect.value);
    syncSpeakerSelectValue(speakerSelect.value);
    applySpeakerToAllAudioEls();
  });
}

if (speakerSelectSettings) {
  speakerSelectSettings.addEventListener('change', () => {
    setSpeakerDeviceId(speakerSelectSettings.value);
    syncSpeakerSelectValue(speakerSelectSettings.value);
    applySpeakerToAllAudioEls();
  });
}

// Só reagimos a devicechange atualizando a lista — nunca reabrindo o
// microfone sozinho, pra não ficar pedindo permissão sem o usuário pedir.
navigator.mediaDevices.addEventListener?.('devicechange', () => {
  populateMicDevices().catch(() => {});
});

async function startMicTest() {
  stopMicTest();
  micTestStatus.textContent = 'Testando microfone...';
  micTestStatus.classList.remove('error-text');

  try {
    micTestStream = await getMicStream(getMicDeviceId());
    await populateMicDevices();
    micTestStatus.textContent = 'Microfone detectado. Fale algo para testar o nível.';
    startMicTestMeter(micTestStream);
  } catch (err) {
    micTestStream = null;
    micTestStatus.textContent = mediaErrorMessage(err);
    micTestStatus.classList.add('error-text');
  }
}

function startMicTestMeter(stream) {
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
    micMeterFill.style.transform = `scaleX(${level.toFixed(2)})`;
    micTestLevelRaf = requestAnimationFrame(tick);
  }
  tick();
}

function stopMicTest() {
  if (micTestLevelRaf) cancelAnimationFrame(micTestLevelRaf);
  micTestLevelRaf = null;
  if (micTestStream) {
    micTestStream.getTracks().forEach((t) => t.stop());
    micTestStream = null;
  }
  if (micMeterFill) micMeterFill.style.transform = 'scaleX(0)';
}

function playTestTone() {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.55);
  } catch (err) {
    showToast('Não foi possível tocar o som de teste.', 'error');
  }
}

btnTestSound.addEventListener('click', playTestTone);
if (btnTestSoundSettings) btnTestSoundSettings.addEventListener('click', playTestTone);

function syncMicSelectValue(value) {
  [micSelect, micSelectCall, micSelectSettings].forEach((sel) => {
    if (sel) sel.value = value;
  });
}

micSelect.addEventListener('change', () => {
  setMicDeviceId(micSelect.value);
  syncMicSelectValue(micSelect.value);
  startMicTest();
});

if (micSelectCall) {
  micSelectCall.addEventListener('change', () => {
    setMicDeviceId(micSelectCall.value);
    syncMicSelectValue(micSelectCall.value);
    switchMicDevice(micSelectCall.value);
  });
}

if (micSelectSettings) {
  micSelectSettings.addEventListener('change', () => {
    setMicDeviceId(micSelectSettings.value);
    syncMicSelectValue(micSelectSettings.value);
    switchMicDevice(micSelectSettings.value);
  });
}

// Troca o microfone SEM interromper a chamada: usa replaceTrack() nas
// conexões já existentes em vez de remover/adicionar faixa (o que exigiria
// renegociar e poderia causar um corte perceptível).
async function switchMicDevice(deviceId) {
  if (!localStream) return; // ainda sem microfone ativo na call
  try {
    const newStream = await getMicStream(deviceId);
    const newTrack = newStream.getAudioTracks()[0];
    newTrack.enabled = micEnabled;

    const oldTrack = localStream.getAudioTracks()[0];
    if (oldTrack) oldTrack.stop();

    localStream = newStream;
    attachMicWatchers(newTrack);
    applyMicTrackToAllPeers(newTrack);
    startLevelMonitor('local', localStream);
    showToast('Microfone alterado.', 'success');
  } catch (err) {
    showToast(mediaErrorMessage(err), 'error');
  }
}

// ---------------------------------------------------------------------------
// v1.0.9 — painel de configurações durante a call
// ---------------------------------------------------------------------------

if (btnSettings) {
  btnSettings.addEventListener('click', openSettingsPanel);
}

function openSettingsPanel() {
  populateMicDevices().catch(() => {});
  renderBinds();
  settingsOverlay.classList.remove('hidden');
}

function closeSettingsPanel() {
  if (recordingBindAction) stopRecordingBind();
  renderBinds();
  settingsOverlay.classList.add('hidden');
}

if (btnSettingsClose) btnSettingsClose.addEventListener('click', closeSettingsPanel);

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettingsPanel();
});

// ---------------------------------------------------------------------------
// Conexão com o servidor + entrada na sala
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Status da conexão (indicador 🟢/🟡/🔴 no cabeçalho da chamada)
// ---------------------------------------------------------------------------

function setConnectionStatus(state) {
  if (!connectionStatusEl) return;
  connectionStatusEl.classList.remove('status-green', 'status-yellow', 'status-red');
  if (state === 'connected') {
    connectionStatusEl.textContent = '🟢 Conectado';
    connectionStatusEl.classList.add('status-green');
  } else if (state === 'reconnecting') {
    connectionStatusEl.textContent = '🟡 Reconectando...';
    connectionStatusEl.classList.add('status-yellow');
  } else {
    connectionStatusEl.textContent = '🔴 Desconectado';
    connectionStatusEl.classList.add('status-red');
  }
}

// Combina o estado do socket de sinalização com o estado de cada
// RTCPeerConnection para decidir um único status simples de mostrar.
function updateConnectionStatus() {
  if (!socket || !socket.connected) {
    setConnectionStatus('reconnecting');
    return;
  }
  const anyUnstable = Object.values(peers).some((state) => {
    const cs = state.pc.connectionState;
    return cs === 'connecting' || cs === 'disconnected' || cs === 'new';
  });
  setConnectionStatus(anyUnstable ? 'reconnecting' : 'connected');
}

function connectAndJoin() {
  const url = getServerUrl();

  try {
    // v1.1.0 — o socket de sinalização agora exige um token de sessão
    // válido (ver io.use() no servidor). É esse token, não o campo de
    // nome, que define quem o servidor considera que está entrando.
    socket = io(url, { reconnectionAttempts: 10, timeout: 8000, auth: { token: authToken } });
  } catch (err) {
    btnConfirmName.disabled = false;
    btnConfirmName.textContent = 'Entrar';
    return showFieldError(nameError, 'Não foi possível conectar ao servidor.');
  }

  socket.on('connect_error', (err) => {
    // Sessão inválida/expirada bem no momento de conectar ao servidor de
    // sinalização: não dá pra continuar como se estivesse autenticado —
    // manda de volta para o login em vez de deixar a call quebrada.
    if (err && err.message === 'unauthorized') {
      socket.close();
      socket = null;
      btnConfirmName.disabled = false;
      btnConfirmName.textContent = 'Entrar';
      showScreen('home');
      authToken = null;
      currentAccount = null;
      updateAccountBadge();
      sessionClearToken();
      showAuthGateState('login');
      authGate.classList.remove('hidden');
      showFieldError(loginError, 'Sua sessão expirou. Entre novamente.');
      return;
    }

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
      setConnectionStatus('reconnecting');
    }
  });

  socket.on('reconnect', () => {
    showToast('Conexão com o servidor restabelecida.', 'success');
    updateConnectionStatus();
  });

  socket.on('reconnect_failed', () => {
    if (!screens.call.classList.contains('hidden')) {
      setConnectionStatus('disconnected');
      showToast('Não foi possível restabelecer a conexão. Verifique sua internet.', 'error', 8000);
    }
  });

  socket.on('connect', () => {
    // Isto roda tanto na primeira entrada quanto em TODO reconnect
    // automático do Socket.IO (que pode acontecer a qualquer momento se a
    // rede cair e voltar). Sem esta limpeza, as conexões WebRTC e os
    // elementos de áudio da sessão anterior ficariam órfãos, e a
    // reentrada na sala criaria PeerConnections duplicadas para as mesmas
    // pessoas.
    resetRemoteCallState();

    socket.emit('join-room', { roomCode }, (response) => {
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
      const isReconnect = hasEnteredCallOnce;
      enterCallScreen(response.participants);
      updateConnectionStatus();
      if (isReconnect) showToast('Reconectado à sala.', 'success');
    });
  });

  registerSignalingHandlers();
}

// Fecha todas as conexões WebRTC e limpa o estado de "quem está na sala"
// (participantes, áudios remotos, tela compartilhada de outra pessoa),
// preservando o microfone e a tela LOCAIS. Chamada sempre antes de
// (re)entrar numa sala, para nunca acumular estado de uma sessão anterior.
function resetRemoteCallState() {
  Object.keys(peers).forEach(closePeerConnection);
  Object.keys(participantsInfo).forEach((id) => delete participantsInfo[id]);
  Object.keys(micMuted).forEach((id) => delete micMuted[id]);
  Object.keys(participantVolumes).forEach((id) => delete participantVolumes[id]);
  closeVolumePopover();
  // closePeerConnection já remove cada compartilhamento remoto individualmente
  // (ver abaixo), mas garantimos aqui também para nunca deixar resíduo de uma
  // sessão anterior após uma reconexão.
  Object.keys(remoteScreenShares).forEach((id) => delete remoteScreenShares[id]);
  renderScreenShares();
}

function enterCallScreen(existingParticipants) {
  roomCodeLabel.textContent = roomCode;
  showScreen('call');
  btnConfirmName.disabled = false;
  btnConfirmName.textContent = 'Entrar';

  populateMicDevices().catch(() => {});
  renderParticipants();
  startLevelMonitor('local', localStream);
  startCallDurationTimer();

  if (pendingMicErrorMessage) {
    setMicButtonState('unavailable');
    showToast(pendingMicErrorMessage, 'error', 6000);
    pendingMicErrorMessage = null;
  } else {
    setMicButtonState(micEnabled ? 'on' : 'muted');
  }

  if (pendingAction === 'create' && !hasEnteredCallOnce) {
    copyToClipboard(roomCode);
    showToast(`Sala criada! Código ${roomCode} copiado para a área de transferência.`, 'success', 5000);
  }

  hasEnteredCallOnce = true;

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
    closePeerConnection(id); // já remove o compartilhamento de tela dela, se houver
    delete participantsInfo[id];
    delete micMuted[id];
    delete participantVolumes[id];
    if (currentVolumePopoverPeerId === id) closeVolumePopover();
    renderParticipants();
    showToast(`${name} saiu da sala.`);
  });

  socket.on('mic-state', ({ id, muted }) => {
    micMuted[id] = !!muted;
    renderParticipants();
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
    // Referências dos RTCRtpSender de cada faixa nesta conexão específica,
    // para poder trocar (replaceTrack) ou remover a faixa certa depois,
    // sem precisar adivinhar procurando em pc.getSenders().
    micSender: null,
    screenVideoSender: null,
    screenAudioSender: null,
  };
  peers[peerId] = state;

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      state.micSender = pc.addTrack(track, localStream);
    });
  }
  if (screenStream) {
    screenStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, screenStream);
      if (track.kind === 'video') {
        state.screenVideoSender = sender;
        // Alguém pode entrar na sala DEPOIS que o compartilhamento já
        // começou — aplica a mesma qualidade escolhida no seletor também
        // para esta conexão nova.
        if (currentScreenSharePreset) applyScreenShareEncodingParams(sender, currentScreenSharePreset);
      } else {
        state.screenAudioSender = sender;
      }
    });
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
    updateConnectionStatus();
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
  // Um mesmo participante pode ter tido DOIS elementos de áudio (mic +
  // tela) — ver handleRemoteTrack abaixo. Remove os dois, se existirem.
  removeRemoteAudioEl(peerId, 'mic');
  removeRemoteAudioEl(peerId, 'screen');
  removeRemoteScreenShare(peerId);
}

function remoteAudioElId(peerId, sourceKind) {
  return `audio-${peerId}-${sourceKind}`;
}

function removeRemoteAudioEl(peerId, sourceKind) {
  const el = document.getElementById(remoteAudioElId(peerId, sourceKind));
  if (el) {
    pendingAudioEls.delete(el);
    el.remove();
  }
}

// ---------------------------------------------------------------------------
// Faixas remotas: microfone x áudio da tela compartilhada
//
// CAUSA RAIZ do "só ouço o áudio da tela, não a voz da pessoa" (e variações
// como "não ouço ninguém"): o código antigo colocava QUALQUER faixa de
// áudio recebida (`track.kind === 'audio'`) no MESMO <audio id="audio-
// PEERID">, não importa se ela vinha do microfone ou do compartilhamento de
// tela. Como cada `srcObject = new MediaStream([track])` SUBSTITUI o que
// já estava tocando naquele elemento, a última faixa de áudio a chegar
// (mic ou tela, dependendo da ordem de negociação) "apagava" a outra —
// mesmo as duas sendo enviadas corretamente e chegando como
// MediaStreamTrack's distintas.
//
// A correção: cada participante pode ter até DOIS elementos <audio>
// simultâneos — um para o microfone e outro para o áudio da tela — nunca
// compartilhados entre si. Para saber a qual dos dois uma faixa de áudio
// recebida pertence (o WebRTC não manda essa informação "de graça"), usamos
// o MediaStream com que ela chegou: no lado de quem envia, o áudio do
// microfone é sempre adicionado usando `localStream` (que só tem áudio),
// e o áudio da tela é sempre adicionado usando `screenStream` (que tem
// vídeo + áudio juntos no MESMO MediaStream). Então, do lado de quem
// recebe, se o `MediaStream` associado à faixa de áudio também contém uma
// faixa de vídeo, essa faixa de áudio só pode ser do compartilhamento de
// tela; caso contrário, é o microfone.
function handleRemoteTrack(peerId, event) {
  const track = event.track;
  const stream = (event.streams && event.streams[0]) || new MediaStream([track]);

  if (track.kind === 'video') {
    addRemoteScreenShare(peerId, stream);
    track.addEventListener('ended', () => {
      removeRemoteScreenShare(peerId);
    });
    return;
  }

  if (track.kind === 'audio') {
    const isScreenAudio = stream.getVideoTracks().length > 0;
    const sourceKind = isScreenAudio ? 'screen' : 'mic';
    const elId = remoteAudioElId(peerId, sourceKind);

    let audioEl = document.getElementById(elId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = elId;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioSinksContainer.appendChild(audioEl);
      applySpeakerToElement(audioEl);
      // v1.0.9 — volume individual: se o usuário já tinha ajustado o volume
      // desta pessoa nesta sessão (ex: reconexão), reaplica no elemento novo.
      if (!isScreenAudio) applyParticipantVolume(peerId);
    }

    // Sempre um MediaStream próprio desta faixa específica — nunca
    // reaproveitamos o srcObject de outra fonte de áudio deste participante.
    const trackStream = new MediaStream([track]);
    audioEl.srcObject = trackStream;

    // Quando é áudio de tela compartilhada, só deixamos audível a do
    // compartilhamento que está em destaque no momento (evita misturar o
    // áudio de duas telas compartilhadas ao mesmo tempo — ver
    // updateScreenAudioMuting()).
    if (isScreenAudio) updateScreenAudioMuting();

    tryPlayAudioEl(audioEl);

    // O anel de "está falando" no avatar reflete a VOZ da pessoa, não o
    // áudio da tela dela — por isso só monitoramos o nível do microfone.
    if (!isScreenAudio) {
      startLevelMonitor(peerId, trackStream);
    }

    track.addEventListener('ended', () => {
      removeRemoteAudioEl(peerId, sourceKind);
      if (!isScreenAudio) stopLevelMonitor(peerId);
    });
  }
}

// Alguns navegadores/versões do Electron podem bloquear o autoplay de
// mídia não-silenciada. Se isso acontecer, guardamos o elemento e mostramos
// um botão simples para o usuário liberar o áudio com um clique (não
// deixamos a pessoa sem áudio sem explicar o motivo).
function tryPlayAudioEl(audioEl) {
  const playPromise = audioEl.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      pendingAudioEls.add(audioEl);
      enableAudioBanner.classList.remove('hidden');
    });
  }
}

btnEnableAudio.addEventListener('click', () => {
  pendingAudioEls.forEach((el) => {
    el.play().catch(() => {});
  });
  pendingAudioEls.clear();
  enableAudioBanner.classList.add('hidden');
});

// ---------------------------------------------------------------------------
// v1.0.9 — duração da chamada
// ---------------------------------------------------------------------------

// Só (re)inicia se ainda não estiver rodando — enterCallScreen() também é
// chamada em reconexões automáticas, e o contador não deve zerar nesse caso.
function startCallDurationTimer() {
  if (callDurationStartTs) return;
  callDurationStartTs = Date.now();
  updateCallDurationDisplay();
  callDurationInterval = setInterval(updateCallDurationDisplay, 1000);
}

function updateCallDurationDisplay() {
  if (!callDurationStartTs || !callDurationEl) return;
  callDurationEl.textContent = formatDuration(Date.now() - callDurationStartTs);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function stopCallDurationTimer() {
  clearInterval(callDurationInterval);
  callDurationInterval = null;
  callDurationStartTs = null;
  if (callDurationEl) callDurationEl.textContent = '00:00:00';
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

  const isSharing = id === 'local' ? sharingScreen : !!remoteScreenShares[id];
  const micOff = isMe ? !micEnabled : !!micMuted[id];
  const locallyMuted = !isMe && !!participantVolumes[id]?.muted;
  if (locallyMuted) card.classList.add('locally-muted');

  card.innerHTML = `
    <div class="avatar" id="avatar-${id}">${initials(name)}</div>
    <div class="participant-name">
      <span class="status-dot"></span>
      ${escapeHtml(name)}${isMe ? ' (você)' : ''}
      <span class="mic-icon ${micOff ? 'muted' : ''}">${micOff ? '🔇' : '🎙'}</span>
    </div>
    ${isSharing ? '<span class="sharing-badge">Compartilhando tela</span>' : ''}
    ${locallyMuted ? '<span class="participant-locally-muted-badge">🔇 Silenciado (local)</span>' : ''}
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
// v1.0.9 — volume individual por participante (estilo Discord)
//
// Clique com o botão ESQUERDO num participante (que não seja você mesmo)
// abre um popover pequeno com um slider de 0-100% e um botão de silenciar.
// Isso NUNCA passa pelo servidor nem afeta o que os outros ouvem — é só o
// elemento <audio> local daquela pessoa que tem seu volume ajustado
// (HTMLMediaElement.volume), então é sempre e só o usuário LOCAL que é
// afetado. Aplica-se ao áudio do MICROFONE da pessoa (a voz dela); o áudio
// de tela compartilhada continua no controle separado que já existia
// (botão de mudo da tela em destaque).
// ---------------------------------------------------------------------------

let currentVolumePopoverPeerId = null;

function getParticipantVolumeState(peerId) {
  if (!participantVolumes[peerId]) participantVolumes[peerId] = { volume: 1, muted: false };
  return participantVolumes[peerId];
}

function applyParticipantVolume(peerId) {
  const el = document.getElementById(remoteAudioElId(peerId, 'mic'));
  if (!el) return;
  const state = getParticipantVolumeState(peerId);
  el.volume = state.muted ? 0 : state.volume;
}

participantsGrid.addEventListener('click', (e) => {
  if (e.button !== 0) return; // só botão esquerdo (clique com o direito dispara 'contextmenu', não 'click')
  const card = e.target.closest('.participant-card');
  if (!card) return;
  const peerId = card.id.replace(/^card-/, '');
  if (peerId === 'local') return; // não faz sentido ajustar o próprio volume
  openVolumePopover(peerId, card);
});

function openVolumePopover(peerId, cardEl) {
  currentVolumePopoverPeerId = peerId;
  const state = getParticipantVolumeState(peerId);

  volumePopoverName.textContent = participantsInfo[peerId]?.name || 'Participante';
  volumePopoverSlider.value = String(Math.round(state.volume * 100));
  volumePopoverPercent.textContent = `${Math.round(state.volume * 100)}%`;
  updateVolumeMuteButtonUI(state.muted);

  volumePopover.classList.remove('hidden');
  positionVolumePopover(cardEl);
}

function positionVolumePopover(cardEl) {
  const rect = cardEl.getBoundingClientRect();
  const popRect = volumePopover.getBoundingClientRect();

  let left = rect.left;
  const maxLeft = window.innerWidth - popRect.width - 8;
  if (left > maxLeft) left = maxLeft;
  if (left < 8) left = 8;

  let top = rect.bottom + 8;
  const maxTop = window.innerHeight - popRect.height - 8;
  if (top > maxTop) top = Math.max(8, rect.top - popRect.height - 8);

  volumePopover.style.left = `${left}px`;
  volumePopover.style.top = `${top}px`;
}

function closeVolumePopover() {
  currentVolumePopoverPeerId = null;
  volumePopover.classList.add('hidden');
}

function updateVolumeMuteButtonUI(muted) {
  volumePopoverMuteBtn.textContent = muted ? '🔊 Reativar áudio' : '🔇 Silenciar';
  volumePopoverMuteBtn.classList.toggle('active', muted);
}

volumePopoverSlider.addEventListener('input', () => {
  if (!currentVolumePopoverPeerId) return;
  const value = Number(volumePopoverSlider.value) / 100;
  const state = getParticipantVolumeState(currentVolumePopoverPeerId);
  state.volume = value;
  // Arrastar o slider acima de 0 tira automaticamente do mudo (padrão do
  // Discord) — evita a pessoa mexer no volume achando que já não está mais
  // silenciada e continuar sem ouvir nada.
  if (value > 0 && state.muted) {
    state.muted = false;
    updateVolumeMuteButtonUI(false);
  }
  volumePopoverPercent.textContent = `${Math.round(value * 100)}%`;
  applyParticipantVolume(currentVolumePopoverPeerId);
  renderParticipants();
});

volumePopoverMuteBtn.addEventListener('click', () => {
  if (!currentVolumePopoverPeerId) return;
  const state = getParticipantVolumeState(currentVolumePopoverPeerId);
  state.muted = !state.muted;
  updateVolumeMuteButtonUI(state.muted);
  applyParticipantVolume(currentVolumePopoverPeerId);
  renderParticipants();
});

// Fecha ao clicar fora (mas não quando o clique for no próprio popover, ou
// em outro card — nesse caso o listener acima já troca para o novo).
document.addEventListener('click', (e) => {
  if (volumePopover.classList.contains('hidden')) return;
  if (volumePopover.contains(e.target)) return;
  if (e.target.closest('.participant-card')) return;
  closeVolumePopover();
});

// ---------------------------------------------------------------------------
// Compartilhamento de tela
// ---------------------------------------------------------------------------

btnScreen.addEventListener('click', () => {
  if (btnScreen.disabled) return;
  if (sharingScreen) stopScreenShare();
  else openScreenQualityPicker();
});

// ---------------------------------------------------------------------------
// v1.0.8 — escolha de qualidade (30 FPS—HD / 60 FPS—FHD) antes de iniciar o
// compartilhamento de tela.
// ---------------------------------------------------------------------------

function openScreenQualityPicker() {
  screenQualityOverlay.classList.remove('hidden');
}

function closeScreenQualityPicker() {
  screenQualityOverlay.classList.add('hidden');
}

btnQualityHd30.addEventListener('click', () => {
  closeScreenQualityPicker();
  startScreenShare(SCREEN_SHARE_PRESETS.hd30);
});

btnQualityFhd60.addEventListener('click', () => {
  closeScreenQualityPicker();
  startScreenShare(SCREEN_SHARE_PRESETS.fhd60);
});

btnQualityCancel.addEventListener('click', closeScreenQualityPicker);

screenQualityOverlay.addEventListener('click', (e) => {
  if (e.target === screenQualityOverlay) closeScreenQualityPicker();
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

// ---------------------------------------------------------------------------
// v1.0.9 — binds (atalhos de teclado individuais)
//
// Cada usuário escolhe sua própria combinação — não existe um padrão
// obrigatório igual para todos, só um padrão INICIAL que cada um pode
// trocar. As duas ações desta versão SEMPRE chamam exatamente a mesma
// função que o botão correspondente (.click()), então bind e botão nunca
// podem se comportar de forma diferente.
// ---------------------------------------------------------------------------

const BINDS_STORAGE_KEY = 'callbox:binds';
const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta'];

const DEFAULT_BINDS = {
  muteMic: { keys: ['Control', 'Shift', 'M'], label: 'Ctrl + Shift + M' },
  shareScreen: { keys: ['Control', 'Shift', 'S'], label: 'Ctrl + Shift + S' },
};

function cloneDefaultBinds() {
  return JSON.parse(JSON.stringify(DEFAULT_BINDS));
}

function getBinds() {
  try {
    const raw = localStorage.getItem(BINDS_STORAGE_KEY);
    if (!raw) return cloneDefaultBinds();
    const parsed = JSON.parse(raw);
    return {
      muteMic: (parsed && parsed.muteMic && Array.isArray(parsed.muteMic.keys)) ? parsed.muteMic : DEFAULT_BINDS.muteMic,
      shareScreen: (parsed && parsed.shareScreen && Array.isArray(parsed.shareScreen.keys)) ? parsed.shareScreen : DEFAULT_BINDS.shareScreen,
    };
  } catch (_e) {
    return cloneDefaultBinds();
  }
}

function saveBinds(binds) {
  localStorage.setItem(BINDS_STORAGE_KEY, JSON.stringify(binds));
}

function normalizeKeyName(key) {
  // Teclas de uma letra só (ex: 'm') sempre em maiúscula, pro combo ficar
  // estável independente do estado do Shift no momento da captura.
  return key.length === 1 ? key.toUpperCase() : key;
}

function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');
  const key = normalizeKeyName(e.key);
  if (!MODIFIER_KEYS.includes(key)) parts.push(key);
  return parts;
}

function comboEquals(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return [...a].sort().join('+') === [...b].sort().join('+');
}

function comboLabel(parts) {
  const mods = MODIFIER_KEYS.filter((m) => parts.includes(m)).map((m) => (m === 'Control' ? 'Ctrl' : m));
  const rest = parts.filter((p) => !MODIFIER_KEYS.includes(p));
  return [...mods, ...rest].join(' + ');
}

let recordingBindAction = null; // 'muteMic' | 'shareScreen' | null

function renderBinds() {
  const binds = getBinds();
  if (btnBindMute) {
    btnBindMute.textContent = binds.muteMic.label;
    btnBindMute.classList.remove('recording');
  }
  if (btnBindScreen) {
    btnBindScreen.textContent = binds.shareScreen.label;
    btnBindScreen.classList.remove('recording');
  }
}

function startRecordingBind(action) {
  recordingBindAction = action;
  const btn = action === 'muteMic' ? btnBindMute : btnBindScreen;
  if (btn) {
    btn.classList.add('recording');
    btn.textContent = 'Pressione uma tecla...';
  }
}

function stopRecordingBind() {
  recordingBindAction = null;
}

function finalizeBindRecording(e) {
  const key = normalizeKeyName(e.key);

  if (MODIFIER_KEYS.includes(key)) {
    // Só um modificador sozinho ainda não é um atalho válido — espera a
    // próxima tecla (mantendo o modificador atual pressionado ou não).
    e.preventDefault();
    return;
  }

  e.preventDefault();

  if (key === 'Escape') {
    stopRecordingBind();
    renderBinds();
    return;
  }

  const parts = comboFromEvent(e);
  const binds = getBinds();
  const otherAction = recordingBindAction === 'muteMic' ? 'shareScreen' : 'muteMic';

  if (comboEquals(parts, binds[otherAction].keys)) {
    showToast('Essa combinação já está sendo usada por outro atalho.', 'error');
    stopRecordingBind();
    renderBinds();
    return;
  }

  binds[recordingBindAction] = { keys: parts, label: comboLabel(parts) };
  saveBinds(binds);
  stopRecordingBind();
  renderBinds();
  showToast('Atalho salvo.', 'success');
}

function tryTriggerBind(e) {
  const parts = comboFromEvent(e);
  if (parts.length === 0) return;

  // Não sequestra digitação normal em campos de texto — a não ser que o
  // atalho tenha algum modificador (Ctrl/Shift/Alt/Meta), que nunca conflita
  // com digitação comum.
  const active = document.activeElement;
  const isTyping = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
  const hasModifier = parts.some((p) => MODIFIER_KEYS.includes(p));
  if (isTyping && !hasModifier) return;

  const binds = getBinds();
  if (comboEquals(parts, binds.muteMic.keys)) {
    e.preventDefault();
    btnMic.click(); // mesma ação do botão de mudo — nunca uma implementação separada
  } else if (comboEquals(parts, binds.shareScreen.keys)) {
    e.preventDefault();
    btnScreen.click(); // mesma ação do botão de compartilhar tela
  }
}

if (btnBindMute) btnBindMute.addEventListener('click', () => startRecordingBind('muteMic'));
if (btnBindScreen) btnBindScreen.addEventListener('click', () => startRecordingBind('shareScreen'));

if (btnBindMuteReset) {
  btnBindMuteReset.addEventListener('click', () => {
    const binds = getBinds();
    binds.muteMic = DEFAULT_BINDS.muteMic;
    saveBinds(binds);
    renderBinds();
    showToast('Atalho restaurado ao padrão.', 'success');
  });
}

if (btnBindScreenReset) {
  btnBindScreenReset.addEventListener('click', () => {
    const binds = getBinds();
    binds.shareScreen = DEFAULT_BINDS.shareScreen;
    saveBinds(binds);
    renderBinds();
    showToast('Atalho restaurado ao padrão.', 'success');
  });
}

// Listener único: dá prioridade à gravação de um bind, depois ao Esc para
// fechar o que estiver aberto, e só então checa se a tecla corresponde a
// algum atalho configurado.
document.addEventListener('keydown', (e) => {
  if (recordingBindAction) {
    finalizeBindRecording(e);
    return;
  }

  if (e.key === 'Escape') {
    if (!screenPickerOverlay.classList.contains('hidden')) {
      closeScreenPicker(null);
    } else if (!screenQualityOverlay.classList.contains('hidden')) {
      closeScreenQualityPicker();
    } else if (!settingsOverlay.classList.contains('hidden')) {
      closeSettingsPanel();
    } else if (!volumePopover.classList.contains('hidden')) {
      closeVolumePopover();
    }
    return;
  }

  if (!screens.call.classList.contains('hidden')) {
    tryTriggerBind(e);
  }
});

// v1.0.8 — aplica bitrate máximo, FPS máximo e a preferência de degradação
// (o que sacrificar primeiro quando a conexão não aguenta o alvo) no sender
// de vídeo da tela compartilhada. Isso é o que efetivamente diz ao WebRTC
// para tentar entregar a qualidade escolhida no seletor (30 FPS—HD ou
// 60 FPS—FHD) — sem forçar nada que a conexão/computador não aguente: se
// não der para manter o alvo, o próprio WebRTC reduz sozinho, sem quebrar
// o compartilhamento.
async function applyScreenShareEncodingParams(sender, preset) {
  if (!sender || !preset) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = preset.maxBitrate;
    params.encodings[0].maxFramerate = preset.frameRate;
    params.degradationPreference = preset.degradationPreference;
    await sender.setParameters(params);
  } catch (err) {
    console.error('Erro ao ajustar qualidade do compartilhamento de tela:', err);
  }
}

async function startScreenShare(preset) {
  btnScreen.disabled = true;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate, max: preset.frameRate },
      },
      audio: true,
    });
  } catch (err) {
    btnScreen.disabled = false;
    // Usuário cancelou o seletor de tela/janela: não é um erro de verdade.
    if (err && err.name === 'NotAllowedError') return;
    console.error('Erro ao compartilhar tela:', err);
    showToast('Não foi possível compartilhar a tela.', 'error');
    return;
  }
  btnScreen.disabled = false;
  currentScreenSharePreset = preset;

  const videoTrack = screenStream.getVideoTracks()[0];
  if (videoTrack) {
    // 'detail' pede ao encoder para priorizar nitidez de texto/imagem em
    // vez de suavidade de movimento — o mais adequado para compartilhar
    // tela (documentos, planilhas, código), que é o foco do CallBox.
    try { videoTrack.contentHint = 'detail'; } catch (_e) {}
  }

  sharingScreen = true;
  btnScreen.classList.add('on');

  // Coloca automaticamente o próprio compartilhamento em destaque — o
  // usuário pode trocar para assistir a tela de outra pessoa a qualquer
  // momento pela lista de compartilhamentos, sem precisar sair da call.
  watchShare('local');
  renderParticipants();

  // Adiciona as faixas da tela a todas as conexões existentes, aplicando a
  // qualidade escolhida na faixa de vídeo.
  Object.values(peers).forEach((state) => {
    screenStream.getTracks().forEach((track) => {
      const sender = state.pc.addTrack(track, screenStream);
      if (track.kind === 'video') {
        state.screenVideoSender = sender;
        applyScreenShareEncodingParams(sender, preset);
      } else {
        state.screenAudioSender = sender;
      }
    });
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
    Object.values(peers).forEach((state) => {
      const sender = track.kind === 'video' ? state.screenVideoSender : state.screenAudioSender;
      if (!sender) return;
      state.pc.removeTrack(sender);
      if (track.kind === 'video') state.screenVideoSender = null;
      else state.screenAudioSender = null;
    });
  });

  screenStream = null;
  sharingScreen = false;
  currentScreenSharePreset = null;
  btnScreen.classList.remove('on');

  // Se o usuário estava assistindo a própria tela, renderScreenShares()
  // escolhe automaticamente outro compartilhamento disponível (se houver)
  // sem precisar sair da call; se não houver nenhum, some a visualização.
  renderScreenShares();
  renderParticipants();
}

// ---------------------------------------------------------------------------
// v1.0.5 — múltiplos compartilhamentos de tela simultâneos
//
// Várias pessoas podem compartilhar ao mesmo tempo (remoteScreenShares
// guarda todas). O usuário escolhe qual assistir (watchShare) sem precisar
// sair da call; as demais continuam disponíveis na lista de
// "Compartilhamentos". O áudio de cada tela é mantido separado do
// microfone (ver handleRemoteTrack) e só o áudio da tela em destaque fica
// audível (ver updateScreenAudioMuting), para nunca misturar duas telas.
// ---------------------------------------------------------------------------

function activeShareEntries() {
  const entries = [];
  if (sharingScreen) entries.push({ id: 'local', name: `${myName} (você)` });
  Object.keys(remoteScreenShares).forEach((id) => {
    entries.push({ id, name: participantsInfo[id]?.name || 'Participante' });
  });
  return entries;
}

function addRemoteScreenShare(peerId, stream) {
  const isNew = !remoteScreenShares[peerId];
  remoteScreenShares[peerId] = { stream };
  if (isNew) {
    showToast(`${participantsInfo[peerId]?.name || 'Um participante'} começou a compartilhar a tela.`);
  }
  renderScreenShares();
}

function removeRemoteScreenShare(peerId) {
  if (!remoteScreenShares[peerId]) return;
  delete remoteScreenShares[peerId];
  renderScreenShares();
}

// Reconstrói a lista de compartilhamentos disponíveis e garante que sempre
// exista um em destaque quando houver pelo menos um ativo (nunca deixa a
// visualização "travada" numa tela que já não existe mais).
function renderScreenShares() {
  const entries = activeShareEntries();

  if (entries.length === 0) {
    screenSharesPanel.classList.add('hidden');
    screenSharesList.innerHTML = '';
  } else {
    screenSharesPanel.classList.remove('hidden');
    screenSharesList.innerHTML = '';
    entries.forEach(({ id, name }) => {
      const card = document.createElement('div');
      card.className = 'share-card' + (id === watchingId ? ' active' : '');
      card.innerHTML = `
        <span class="share-card-icon">🖥️</span>
        <span class="share-card-name">${escapeHtml(name)}</span>
        <button type="button" class="btn btn-tiny share-card-btn" data-share-id="${id}">
          ${id === watchingId ? 'Assistindo' : 'Assistir'}
        </button>
      `;
      screenSharesList.appendChild(card);
    });
    screenSharesList.querySelectorAll('.share-card-btn').forEach((btn) => {
      btn.addEventListener('click', () => watchShare(btn.dataset.shareId));
    });
  }

  // [].some(...) é sempre false, então quando não há nenhum compartilhamento
  // ativo o "válido" é justamente watchingId já estar em null — senão
  // watchShare(null) chamaria renderScreenShares() de novo pra sempre.
  const stillValid = entries.length === 0
    ? watchingId === null
    : entries.some((e) => e.id === watchingId);
  if (!stillValid) {
    watchShare(entries.length > 0 ? entries[0].id : null);
    return; // watchShare já chama renderScreenShares() de novo com o estado certo
  }

  callArea.classList.toggle('sharing', entries.length > 0);
  renderParticipants();
}

// Coloca um compartilhamento (o próprio ou o de outra pessoa) em destaque
// na visualização grande — o usuário pode trocar quantas vezes quiser sem
// sair da chamada.
function watchShare(id) {
  watchingId = id;

  if (!id) {
    screenShareVideo.srcObject = null;
    screenShareView.classList.add('hidden');
    btnToggleShareAudio.classList.add('hidden');
    renderScreenShares();
    return;
  }

  if (id === 'local') {
    screenShareVideo.srcObject = screenStream;
    // O áudio capturado por getDisplayMedia() é o MESMO áudio que já está
    // tocando no sistema de quem compartilha. Se esta PRÉVIA local também
    // reproduzisse esse áudio, quem compartilha ouviria tudo em dobro/eco.
    // A faixa de áudio continua sendo enviada normalmente pelo WebRTC para
    // os outros participantes — só a reprodução local é silenciada.
    screenShareVideo.muted = true;
    screenShareOwner.textContent = `${myName} (você) está compartilhando a tela`;
    btnToggleShareAudio.classList.add('hidden');
  } else {
    const entry = remoteScreenShares[id];
    screenShareVideo.srcObject = entry ? entry.stream : null;
    screenShareVideo.muted = false;
    applySpeakerToElement(screenShareVideo);
    const name = participantsInfo[id]?.name || 'Um participante';
    screenShareOwner.textContent = `${name} está compartilhando a tela`;
    btnToggleShareAudio.classList.remove('hidden');
  }

  screenShareView.classList.remove('hidden');
  updateScreenAudioMuting();
  renderScreenShares();
}

// Garante que só o áudio do compartilhamento em destaque seja ouvido —
// os áudios de telas que não estão sendo assistidas ficam silenciados no
// próprio elemento <audio>, sem afetar o microfone de ninguém.
function updateScreenAudioMuting() {
  Object.keys(remoteScreenShares).forEach((peerId) => {
    const el = document.getElementById(remoteAudioElId(peerId, 'screen'));
    if (el) el.muted = peerId !== watchingId || screenAudioManuallyMuted;
  });
}

btnToggleShareAudio.addEventListener('click', () => {
  screenAudioManuallyMuted = !screenAudioManuallyMuted;
  btnToggleShareAudio.textContent = screenAudioManuallyMuted ? '🔇' : '🔊';
  updateScreenAudioMuting();
});

// ---------------------------------------------------------------------------
// Microfone
// ---------------------------------------------------------------------------

// Aplica a faixa de microfone (nova ou trocada) em todas as conexões já
// abertas: troca no lugar (replaceTrack) quando já existe uma faixa sendo
// enviada para aquele participante, ou adiciona (addTrack) quando a
// conexão nunca teve microfone (ex: pessoa entrou sem mic e ativou depois).
function applyMicTrackToAllPeers(track) {
  Object.values(peers).forEach((state) => {
    if (state.micSender) {
      state.micSender.replaceTrack(track).catch((err) => {
        console.error('Erro ao trocar a faixa de áudio do microfone:', err);
      });
    } else {
      state.micSender = state.pc.addTrack(track, localStream);
    }
  });
}

function setMicButtonState(uiState) {
  btnMic.classList.remove('active', 'mic-error');
  const label = btnMic.querySelector('.control-label');
  if (uiState === 'on') {
    btnMic.classList.add('active');
    label.textContent = 'Mudo';
  } else if (uiState === 'muted') {
    label.textContent = 'Mudo(x)';
  } else if (uiState === 'error') {
    btnMic.classList.add('mic-error');
    label.textContent = 'Reconectando';
  } else if (uiState === 'unavailable') {
    btnMic.classList.add('mic-error');
    label.textContent = 'Sem mic';
  }
}

function broadcastMicState() {
  if (socket && socket.connected) socket.emit('mic-state', { muted: !micEnabled });
}

btnMic.addEventListener('click', async () => {
  if (!localStream) {
    // Sem microfone ativo no momento: só tenta pedir de novo quando o
    // usuário clica (nunca sozinho em loop), pra não ficar reabrindo o
    // pedido de permissão sem necessidade.
    setMicButtonState('error');
    try {
      localStream = await getMicStream(getMicDeviceId());
      const track = localStream.getAudioTracks()[0];
      track.enabled = true;
      micEnabled = true;
      attachMicWatchers(track);
      applyMicTrackToAllPeers(track);
      startLevelMonitor('local', localStream);
      setMicButtonState('on');
      showToast('Microfone ativado.', 'success');
      broadcastMicState();
    } catch (err) {
      setMicButtonState('unavailable');
      showToast(mediaErrorMessage(err), 'error', 6000);
    }
    renderParticipants();
    return;
  }

  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((track) => (track.enabled = micEnabled));
  setMicButtonState(micEnabled ? 'on' : 'muted');
  broadcastMicState();
  renderParticipants();
  if (!micEnabled) showToast('Microfone desligado.');
});

// ---------------------------------------------------------------------------
// Copiar código da sala
// ---------------------------------------------------------------------------

// v1.0.10 — copia usando o clipboard nativo do Electron (síncrono) em vez de
// navigator.clipboard (assíncrono e, neste app, silenciosamente ineficaz).
// Só retorna sucesso se a escrita realmente aconteceu.
function copyToClipboard(text) {
  try {
    clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('Erro ao copiar código para a área de transferência:', err);
    return false;
  }
}

[btnCopyRoom, btnCopyRoom2].forEach((btn) => {
  btn.addEventListener('click', () => {
    const copiado = copyToClipboard(roomCode);
    if (copiado) {
      showToast('Código copiado para a área de transferência.', 'success');
    } else {
      showToast('Não foi possível copiar o código.', 'error');
    }
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

  clearTimeout(micTrackRetryTimeout);
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
  stopCallDurationTimer();
  Object.keys(participantsInfo).forEach((id) => delete participantsInfo[id]);
  Object.keys(micMuted).forEach((id) => delete micMuted[id]);
  Object.keys(remoteScreenShares).forEach((id) => delete remoteScreenShares[id]);
  audioSinksContainer.innerHTML = '';
  pendingAudioEls.clear();
  enableAudioBanner.classList.add('hidden');

  micEnabled = true;
  sharingScreen = false;
  currentScreenSharePreset = null;
  watchingId = null;
  screenAudioManuallyMuted = false;
  pendingAction = null;
  pendingMicErrorMessage = null;
  hasEnteredCallOnce = false;

  settingsOverlay.classList.add('hidden');
  if (recordingBindAction) stopRecordingBind();
  closeVolumePopover();
  // Volume individual é local à sessão (peerId muda a cada reconexão, então
  // não daria pra reaplicar de forma confiável na próxima call — ver seção
  // "Volume individual" mais abaixo).
  Object.keys(participantVolumes).forEach((id) => delete participantVolumes[id]);

  setMicButtonState('on');
  btnScreen.classList.remove('on');
  screenShareView.classList.add('hidden');
  screenSharesPanel.classList.add('hidden');
  screenSharesList.innerHTML = '';
  btnToggleShareAudio.classList.add('hidden');
  btnToggleShareAudio.textContent = '🔊';
  callArea.classList.remove('sharing');
  setConnectionStatus('connected');

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

// ---------------------------------------------------------------------------
// Atualização automática — ver bloco no topo do arquivo (gate obrigatório,
// v1.0.6). Este bloco final não é mais necessário: o antigo banner opcional
// ("Depois" / instalar mais tarde) foi substituído pela tela cheia
// obrigatória, já que a atualização deixou de ser algo que dá pra ignorar.
// ---------------------------------------------------------------------------
