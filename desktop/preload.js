const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('waApp', {
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  connectAccount: (payload) => ipcRenderer.invoke('accounts:connect', payload),
  disconnectAccount: (name) => ipcRenderer.invoke('accounts:disconnect', { name }),
  logoutAccount: (name) => ipcRenderer.invoke('accounts:logout', { name }),
  startFeeding: (options) => ipcRenderer.invoke('feeding:start', options),
  stopFeeding: () => ipcRenderer.invoke('feeding:stop'),
  feedingStatus: () => ipcRenderer.invoke('feeding:status'),
  readEnv: () => ipcRenderer.invoke('env:read'),
  writeEnv: (content) => ipcRenderer.invoke('env:write', content),
  readProxies: () => ipcRenderer.invoke('proxies:read'),
  writeProxies: (content) => ipcRenderer.invoke('proxies:write', content),
  openDataFolder: () => ipcRenderer.invoke('shell:open-data-folder'),
  codexLoginHint: () => ipcRenderer.invoke('shell:codex-login-hint'),
  onLog: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('log', listener);
    return () => ipcRenderer.removeListener('log', listener);
  },
});
