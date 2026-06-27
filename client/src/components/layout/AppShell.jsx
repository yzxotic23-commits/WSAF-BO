import Sidebar from './Sidebar';
import './AppShell.css';
import '../../styles/ams-embed.css';

export default function AppShell({
  children, embedded, theme, onToggleTheme, version, connected,
}) {
  if (embedded) {
    return (
      <div className="app-shell ams-embed">
        <main className="app-content app-content--embedded">{children}</main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar theme={theme} onToggleTheme={onToggleTheme} version={version} />
      <div className="app-main">
        <div className="app-status-bar">
          <span className={`conn-dot${connected ? ' on' : ''}`} />
          <span>{connected ? 'Live' : 'Reconnecting…'}</span>
        </div>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
