const { contextBridge, ipcRenderer } = require('electron');

const portArg = process.argv.find((a) => a.startsWith('--api-port='));
const port = portArg ? portArg.split('=')[1] : '47821';

contextBridge.exposeInMainWorld('desktop', {
  apiUrl: `http://127.0.0.1:${port}`,
  isElectron: true,
  openTerminal: (command) => ipcRenderer.invoke('open-terminal', command),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  getAppRoot: () => ipcRenderer.invoke('get-app-root'),
  reloadEnv: () => ipcRenderer.invoke('reload-env'),
});
