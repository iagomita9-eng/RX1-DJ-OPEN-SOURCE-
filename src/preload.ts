import { contextBridge, ipcRenderer } from 'electron';

// Única ponte entre a UI e o sistema de arquivos.
contextBridge.exposeInMainWorld('api', {
  loadMapping: () => ipcRenderer.invoke('mapping:load'),
  pickFolder: () => ipcRenderer.invoke('lib:pick'),
  listDir: (dir: string) => ipcRenderer.invoke('lib:list', dir),
  readAudio: (file: string) => ipcRenderer.invoke('audio:read', file),
  openAudio: () => ipcRenderer.invoke('audio:open'),
  saveMapping: (map: unknown) => ipcRenderer.invoke('mapping:save', map),
});
