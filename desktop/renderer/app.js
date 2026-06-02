const accountList = document.getElementById('account-list');
const logOutput = document.getElementById('log-output');
const qrImage = document.getElementById('qr-image');
const qrStatus = document.getElementById('qr-status');
const pairingCode = document.getElementById('pairing-code');
const appMeta = document.getElementById('app-meta');

function appendLog(entry) {
  const line = `[${new Date(entry.time || Date.now()).toLocaleTimeString()}] ${entry.message || ''}`;
  logOutput.textContent += `${line}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;

  if (entry.type === 'qr' && entry.qrImage) {
    qrImage.src = entry.qrImage;
    qrImage.hidden = false;
    pairingCode.hidden = true;
    qrStatus.textContent = `Scan QR untuk ${entry.session}`;
  }
  if (entry.type === 'pairing' && entry.code) {
    pairingCode.textContent = entry.code;
    pairingCode.hidden = false;
    qrImage.hidden = true;
    qrStatus.textContent = `Pairing code — ${entry.session}`;
  }
}

async function refreshAccounts() {
  const accounts = await window.waApp.listAccounts();
  accountList.innerHTML = '';

  for (const acc of accounts) {
    const li = document.createElement('li');
    const status = acc.connected
      ? 'Online'
      : acc.valid
        ? 'Session tersimpan'
        : 'Belum link';
    li.innerHTML = `
      <strong>${acc.name}</strong>
      <span class="account-meta">${status}${acc.phone ? ` · ${acc.phone}` : ''}</span>
      <div class="btn-row">
        <button type="button" data-action="connect" data-name="${acc.name}">Connect (QR)</button>
        <button type="button" data-action="disconnect" data-name="${acc.name}">Disconnect</button>
        <button type="button" data-action="logout" data-name="${acc.name}">Logout</button>
      </div>
    `;
    accountList.appendChild(li);
  }
}

accountList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const name = btn.dataset.name;
  const action = btn.dataset.action;

  if (action === 'connect') {
    qrStatus.textContent = `Menghubungkan ${name}...`;
    await window.waApp.connectAccount({ name, method: 'qr' });
  } else if (action === 'disconnect') {
    await window.waApp.disconnectAccount(name);
  } else if (action === 'logout') {
    await window.waApp.logoutAccount(name);
  }
  await refreshAccounts();
});

document.getElementById('btn-start-feeding').addEventListener('click', async () => {
  const language = document.getElementById('feed-language').value;
  const res = await window.waApp.startFeeding({ language });
  if (!res.ok) appendLog({ message: res.error || 'Feeding gagal start' });
});

document.getElementById('btn-stop-feeding').addEventListener('click', () => {
  window.waApp.stopFeeding();
});

document.getElementById('btn-save-env').addEventListener('click', async () => {
  await window.waApp.writeEnv(document.getElementById('env-editor').value);
  appendLog({ message: '.env disimpan' });
  await refreshAccounts();
});

document.getElementById('btn-save-proxies').addEventListener('click', async () => {
  await window.waApp.writeProxies(document.getElementById('proxies-editor').value);
  appendLog({ message: 'proxies.txt disimpan' });
});

document.getElementById('btn-open-data').addEventListener('click', () => {
  window.waApp.openDataFolder();
});

document.getElementById('btn-codex-hint').addEventListener('click', async () => {
  const { hint } = await window.waApp.codexLoginHint();
  alert(hint);
});

async function init() {
  const info = await window.waApp.getInfo();
  appMeta.textContent = `${info.platform} · data: ${info.userDataPath}`;

  document.getElementById('env-editor').value = await window.waApp.readEnv();
  document.getElementById('proxies-editor').value = await window.waApp.readProxies();

  window.waApp.onLog(appendLog);
  await refreshAccounts();
}

init().catch((err) => {
  appendLog({ message: `Init error: ${err.message}` });
});
