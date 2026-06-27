/**
 * libsignal (Baileys) menulis debug enkripsi ke console.info/warn.
 * Bukan error — hanya rotasi session E2E. Default: disembunyikan.
 * Set SUPPRESS_LIBSIGNAL_LOGS=false di .env untuk melihat lagi.
 */

const SUPPRESS = process.env.SUPPRESS_LIBSIGNAL_LOGS !== 'false';

const NOISE_PREFIXES = [
  'Closing session:',
  'Opening session:',
  'Removing old closed session:',
  'Session already closed',
  'Session already open',
  'Closing open session in favor of incoming prekey bundle',
  'Decrypted message with closed session.',
  'Migrating session to:',
  'Failed to decrypt message with any known session',
  'Session error:Error: Bad MAC',
  'Session error: Error: Bad MAC',
  'Error: Bad MAC',
  'MessageCounterError:',
  'No matching session',
  'Invalid PreKey',
];

function isLibsignalNoise(args) {
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message || String(a);
      return '';
    })
    .join(' ');
  if (!text) return false;
  return NOISE_PREFIXES.some((p) => text.includes(p));
}

function patchConsole(method) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    if (SUPPRESS && isLibsignalNoise(args)) return;
    original(...args);
  };
}

if (SUPPRESS) {
  patchConsole('info');
  patchConsole('warn');
  patchConsole('error');
}
