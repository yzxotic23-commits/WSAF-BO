const fs = require('fs');
const path = require('path');

function seedUserData(userDataPath, projectRoot) {
  fs.mkdirSync(path.join(userDataPath, 'auth'), { recursive: true });

  const envPath = path.join(userDataPath, '.env');
  if (!fs.existsSync(envPath)) {
    const candidates = [
      path.join(projectRoot, '.env'),
      path.join(projectRoot, '.env.example'),
      path.join(projectRoot, 'WhatsApp-Auto-Feeding-Windows-v1.0.10', 'Docs', '.env.example'),
    ];
    for (const src of candidates) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, envPath);
        break;
      }
    }
  }

  const proxiesPath = path.join(userDataPath, 'proxies.txt');
  if (!fs.existsSync(proxiesPath)) {
    const candidates = [
      path.join(projectRoot, 'proxies.txt'),
      path.join(projectRoot, 'WhatsApp-Auto-Feeding-Windows-v1.0.10', 'Docs', 'proxies.txt'),
    ];
    let copied = false;
    for (const src of candidates) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, proxiesPath);
        copied = true;
        break;
      }
    }
    if (!copied) {
      fs.writeFileSync(proxiesPath, '# satu proxy per baris\n# socks5://user:pass@host:port\n', 'utf8');
    }
  }

  return userDataPath;
}

module.exports = { seedUserData };
