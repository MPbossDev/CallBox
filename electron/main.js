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

const { app, BrowserWindow, session, ipcMain, desktopCapturer } = require('electron');
const path = require('path');

let mainWindow = null;

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
