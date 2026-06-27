const fs = require('fs');
const css = fs.readFileSync('client/dist/assets/index-BaqgFg_X.css', 'utf8');
const keys = [
  'wa-list-header',
  'wa-list-header-top',
  'wa-list-header-brand',
  'wa-list-header-name',
  'wa-list-header-stats',
  'wa-stat-pill',
  'wa-main-topbar',
  'wa-main-topbar-title',
  'wa-icon-btn',
  'wa-toolbar-btn',
  'wa-list-header-toolbar',
  'wa-header-icon-btn',
  'wa-conv-header',
  'wa-conv-body',
  'wa-conv-messages',
  'wa-messages',
  'wa-chat-view',
  'wa-chat-panel',
  'wa-msg-bubble',
  'wa-sidebar',
  'wa-main',
  'wa-update-banner',
];
for (const k of keys) {
  const re = new RegExp(`\\.${k.replace(/-/g, '\\-')}[^{]*\\{[^}]+\\}`, 'g');
  const m = css.match(re);
  if (m) console.log(`--- ${k} ---\n${m.join('\n')}\n`);
}
