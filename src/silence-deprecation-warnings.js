/**
 * Node DEP0040: modul built-in `punycode` deprecated (Node 21+).
 * Muncul dari dependency (uri-js / tr46 via Baileys, OpenAI, dll.) — bukan bug app.
 * Set SUPPRESS_DEPRECATION_WARNINGS=false di .env untuk melihat lagi.
 */

if (process.env.SUPPRESS_DEPRECATION_WARNINGS !== 'false') {
  const HIDDEN = new Set(['DEP0040']);

  process.on('warning', (warning) => {
    if (HIDDEN.has(warning.code)) return;
    console.warn(`${warning.name}: ${warning.message}`);
  });
}
