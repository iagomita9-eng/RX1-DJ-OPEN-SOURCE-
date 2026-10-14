import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// O mapa MIDI mora nos dados do usuário (gravável mesmo com o app instalado dentro de Program Files,
// onde a pasta do programa não pode ser escrita). No primeiro uso, copia o mapa padrão que veio junto do app.
const MAP_FILE = path.join(app.getPath('userData'), 'ddj400.json');
const BUNDLED_MAP = app.isPackaged
  ? path.join(process.resourcesPath, 'mappings', 'ddj400.json')
  : path.join(app.getAppPath(), 'mappings', 'ddj400.json');
function ensureMapFile() {
  if (fs.existsSync(MAP_FILE)) return;
  try { fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true }); fs.copyFileSync(BUNDLED_MAP, MAP_FILE); }
  catch { fs.writeFileSync(MAP_FILE, JSON.stringify({ version: 1, device: 'DDJ-400', controls: {} }, null, 2)); }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#0b0b0b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // o renderer não tem acesso direto ao Node
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required', // MIDI não conta como gesto; sem isso o áudio fica suspenso
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // Web MIDI precisa de permissão explícita no Electron.
  // Logamos cada pedido no terminal para diagnóstico (nome da permissão + origem).
  const allowed = new Set(['midi', 'midiSysex', 'media']); // 'media' = permissão de microfone, usada só para revelar os
  // NOMES dos dispositivos de saída de áudio (limite do Chromium); o app não grava nem usa o microfone.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    console.log('[permissão pedida]', permission, details.requestingUrl);
    cb(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    console.log('[permissão checada]', permission, origin);
    return allowed.has(permission);
  });

  ensureMapFile();

  // Mapa MIDI: lido/gravado como JSON (nunca hardcoded na lógica).
  ipcMain.handle('mapping:load', () => {
    try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch { return null; }
  });
  ipcMain.handle('mapping:save', (_e, map: unknown) => {
    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2), 'utf8');
    return MAP_FILE;
  });

  // Áudio: o renderer recebe os bytes e decodifica.
  const AUDIO = /\.(mp3|wav|flac)$/i;
  const readAudio = (file: string) => {
    const buf = fs.readFileSync(file);
    return { name: path.basename(file), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  ipcMain.handle('audio:open', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Áudio', extensions: ['mp3', 'wav', 'flac'] }] });
    return r.canceled || !r.filePaths[0] ? null : readAudio(r.filePaths[0]);
  });
  ipcMain.handle('audio:read', (_e, file: string) => (AUDIO.test(file) ? readAudio(file) : null));

  // Biblioteca: escolher a pasta de músicas e listar pastas/arquivos de áudio.
  ipcMain.handle('lib:pick', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('lib:list', (_e, dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && (e.isDirectory() || AUDIO.test(e.name)))
        .map(e => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }))
        .sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name, 'pt-BR', { numeric: true }) : a.dir ? -1 : 1);
      return { dir, parent: path.dirname(dir), entries };
    } catch { return null; }
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
