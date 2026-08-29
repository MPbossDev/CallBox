// electron/main.js
//
// Processo principal do Electron. Abre a janela do aplicativo, concede
// as permissões de mídia (microfone / compartilhamento de tela) e
// implementa a captura de tela real usando desktopCapturer +
// session.setDisplayMediaRequestHandler.
//
// IMPORTANTE SOBRE COMPARTILHAMENTO DE TELA NO WINDOWS:
// A opção "useSystemPicker" do Electron (que abriria o seletor NATIVO do
// sistema operacional) só é suportada no macOS 15+. No Windows ela não faz
// nada sozinha — é obrigatório o app fornecer manualmente a fonte de vídeo
// (tela ou janela) através de `desktopCapturer.getSources()`. Por isso,
// aqui pedimos as fontes disponíveis e mostramos um seletor próprio (uma
// janela simples com miniaturas) para o usuário escolher o que compartilhar.

const { app, BrowserWindow, session, ipcMain, desktopCapturer, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;

// O renderer precisa saber, ANTES de desenhar qualquer tela, se está rodando
// empacotado (só nesse caso existe verificação de atualização) — assim ele
// decide se mostra a tela de "verificando atualização" ou vai direto pra
// tela inicial (modo dev). É síncrono de propósito: roda antes do primeiro
// desenho da página, evitando um "flash" da tela inicial atrás do gate.
ipcMain.on('callbox:is-packaged', (event) => {
  event.returnValue = app.isPackaged;
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

// ---------------------------------------------------------------------------
// v1.1.0 — Persistência segura da sessão (contas de usuário)
//
// O token de sessão (emitido pelo servidor no login/cadastro) NUNCA é salvo
// em localStorage nem em texto puro num arquivo de configuração. Em vez
// disso, usamos `safeStorage` do Electron, que criptografa o valor usando o
// cofre de credenciais do próprio sistema operacional (DPAPI no Windows,
// Keychain no macOS, Secret Service/kwallet no Linux) antes de gravar em
// disco, em `userData` (fora da pasta do app). Isso é o que permite o
// usuário continuar logado entre uma abertura e outra do CallBox sem jamais
// guardar a senha em lugar nenhum — só um token de sessão criptografado.
// ---------------------------------------------------------------------------

const SESSION_FILE = path.join(app.getPath('userData'), 'callbox-session.dat');

ipcMain.handle('callbox:session:get', () => {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE);
    if (raw.length === 0) return null;
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(raw);
    }
    // Fallback raro (ex: alguns ambientes Linux sem cofre de credenciais
    // disponível): sem criptografia de SO, ainda assim gravamos fora do
    // localStorage/config do app. Ver limitações no relatório final.
    return raw.toString('utf8');
  } catch (err) {
    console.error('[sessão] Erro ao ler sessão salva:', err);
    return null;
  }
});

ipcMain.handle('callbox:session:set', (_event, token) => {
  try {
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(String(token))
      : Buffer.from(String(token), 'utf8');
    fs.writeFileSync(SESSION_FILE, data);
    return true;
  } catch (err) {
    console.error('[sessão] Erro ao salvar sessão:', err);
    return false;
  }
});

ipcMain.handle('callbox:session:clear', () => {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    return true;
  } catch (err) {
    console.error('[sessão] Erro ao limpar sessão:', err);
    return false;
  }
});

// Guarda as fontes (screens/windows) da requisição de compartilhamento de
// tela em andamento, para que possamos casar a escolha do usuário (que
// volta do renderer só com o "id") com o objeto de fonte original que o
// Electron exige no callback.
let pendingSources = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#101114',
    autoHideMenuBar: true,
    webPreferences: {
      // Simplificação intencional: como é um app local para 2-3 amigos
      // (não um site público), habilitamos nodeIntegration para que o
      // client/app.js possa usar diretamente o socket.io-client e o
      // ipcRenderer via require().
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'client', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Compartilhamento de tela real
// ---------------------------------------------------------------------------

// Serializa as fontes para mandar por IPC (não dá pra mandar thumbnails como
// NativeImage cru de forma confiável, então convertemos para data URL).
function serializeSources(sources) {
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnailDataUrl: source.thumbnail && !source.thumbnail.isEmpty()
      ? source.thumbnail.toDataURL()
      : null,
  }));
}

async function handleDisplayMediaRequest(_request, callback) {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 300, height: 200 },
      fetchWindowIcons: true,
    });

    if (!sources.length) {
      // Nenhuma tela/janela disponível para capturar.
      callback({});
      return;
    }

    pendingSources = sources;

    // Pede para o renderer mostrar o seletor e espera a escolha do usuário.
    mainWindow.webContents.send('callbox:screen-picker:open', serializeSources(sources));

    const chosenId = await new Promise((resolve) => {
      ipcMain.once('callbox:screen-picker:choice', (_event, sourceId) => {
        resolve(sourceId);
      });
    });

    const chosenSource = pendingSources.find((s) => s.id === chosenId);
    pendingSources = [];

    if (!chosenSource) {
      // Usuário cancelou o seletor.
      callback({});
      return;
    }

    callback({ video: chosenSource, audio: 'loopback' });
  } catch (err) {
    console.error('Erro ao capturar fontes de tela:', err);
    callback({});
  }
}

app.whenReady().then(() => {
  // Autoriza automaticamente os pedidos de mídia (microfone/tela).
  // O Windows continua exibindo seu próprio aviso de permissão de microfone
  // na primeira vez que o app for usado.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const permissoesLiberadas = ['media', 'audioCapture', 'videoCapture', 'display-capture'];
    callback(permissoesLiberadas.includes(permission));
  });

  // Trata os pedidos de getDisplayMedia() do renderer.
  // useSystemPicker:true não atrapalha no Windows (só é usado no macOS 15+);
  // quando o SO não tem picker nativo, nosso handler acima é chamado
  // normalmente e mostramos nosso próprio seletor.
  session.defaultSession.setDisplayMediaRequestHandler(handleDisplayMediaRequest, {
    useSystemPicker: true,
  });

  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Atualização automática OBRIGATÓRIA (electron-updater + GitHub Releases)
//
// Fluxo (v1.0.6):
//   1) Assim que a janela termina de carregar, verificamos se há uma release
//      mais nova publicada no GitHub Releases.
//   2) Se NÃO houver (ou a checagem falhar, ex: sem internet), liberamos o
//      app normalmente — a checagem em si NUNCA bloqueia o uso.
//   3) Se houver, o renderer mostra uma tela cheia obrigatória (sem "Depois",
//      sem X, sem clique-fora) com a versão nova e as notas da release
//      (changelog dinâmico, direto do corpo da Release do GitHub).
//   4) Ao clicar "Instalar agora", baixamos com progresso visível.
//   5) Terminando o download, instalamos e reiniciamos automaticamente —
//      sem exigir um segundo clique.
//   6) Se o DOWNLOAD falhar (já confirmado que existe atualização), a tela
//      de erro só permite tentar de novo — nunca continuar na versão antiga.
// ---------------------------------------------------------------------------

// Fase atual do updater, usada só para decidir se um 'error' do
// electron-updater é uma falha de CHECAGEM (não bloqueia) ou uma falha de
// DOWNLOAD (deve bloquear e pedir nova tentativa).
let updatePhase = 'idle'; // 'idle' | 'checking' | 'available' | 'downloading'

function setupAutoUpdater() {
  // Em desenvolvimento (npm run dev / electron .) o app não está
  // empacotado e não existe app-update.yml, então o electron-updater
  // sempre falharia a checagem. Não faz sentido verificar atualização
  // nesse caso — só faz sentido no .exe instalado.
  if (!app.isPackaged) {
    console.log('[updater] Rodando em modo dev — verificação de atualização desativada.');
    return;
  }

  // Nós mesmos controlamos quando baixar, para poder mostrar a tela de
  // "nova versão disponível" com o changelog ANTES de começar a baixar
  // qualquer coisa. O reinício, porém, é automático assim que o download
  // termina (ver 'update-downloaded' abaixo) — a atualização é obrigatória.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }

  autoUpdater.on('update-available', (info) => {
    updatePhase = 'available';
    sendToRenderer('callbox:update:available', {
      version: info.version,
      currentVersion: app.getVersion(),
      // releaseNotes vem do corpo da Release publicada no GitHub — pode ser
      // uma string (uma versão) ou uma lista de { version, note } quando o
      // usuário está pulando várias versões de uma vez. O renderer trata os
      // dois formatos, então nenhuma versão específica fica hardcoded aqui.
      releaseNotes: info.releaseNotes || null,
    });
  });

  autoUpdater.on('update-not-available', () => {
    updatePhase = 'idle';
    sendToRenderer('callbox:update:not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('callbox:update:progress', { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendToRenderer('callbox:update:downloaded', { version: info.version });
    // Dá um instante pro usuário ver a mensagem de conclusão antes de
    // fechar/reiniciar — depois disso o instalador do NSIS assume e
    // atualiza a instalação existente (não cria uma instalação nova).
    setTimeout(() => {
      autoUpdater.quitAndInstall();
    }, 1500);
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Erro:', err == null ? err : err.message);

    if (updatePhase === 'downloading') {
      // Já sabíamos que existe uma atualização obrigatória e o download
      // falhou — não podemos deixar a pessoa seguir usando a versão antiga.
      sendToRenderer('callbox:update:download-error');
    } else {
      // Erro na CHECAGEM (ex: sem internet, GitHub fora do ar): nunca
      // impede o uso do app — libera normalmente, como se não houvesse
      // atualização disponível.
      updatePhase = 'idle';
      sendToRenderer('callbox:update:not-available');
    }
  });

  ipcMain.on('callbox:update:download', () => {
    updatePhase = 'downloading';
    sendToRenderer('callbox:update:progress', { percent: 0 });
    autoUpdater.downloadUpdate().catch((err) => {
      console.error('[updater] Falha ao baixar atualização:', err);
    });
  });

  // Só depois que a página terminou de carregar (garante que app.js já
  // registrou os listeners de IPC) é que verificamos — assim nenhum evento
  // se perde e a tela de "verificando" some no momento certo.
  mainWindow.webContents.once('did-finish-load', () => {
    updatePhase = 'checking';
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] Falha ao verificar atualização:', err);
      updatePhase = 'idle';
      sendToRenderer('callbox:update:not-available');
    });
  });
}
