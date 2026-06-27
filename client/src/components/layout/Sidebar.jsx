import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  Zap,
  Sprout,
  ClipboardList,
  Globe,
  Search,
  Smartphone,
  CreditCard,
  Settings,
  ExternalLink,
  Moon,
  Sun,
} from 'lucide-react';
import './Sidebar.css';

const NAV = [
  {
    section: 'Workspace',
    items: [
      { to: '/', icon: LayoutDashboard, label: 'Overview', end: true },
      { to: '/feeding', icon: MessageSquare, label: 'Feeding' },
    ],
  },
  {
    section: 'Accounts',
    items: [
      { to: '/accounts', icon: Users, label: 'Ledger' },
      { to: '/activation', icon: Zap, label: 'Activation' },
      { to: '/nurturing', icon: Sprout, label: 'Nurturing' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/workorders', icon: ClipboardList, label: 'Work Orders' },
      { to: '/portal', icon: ExternalLink, label: 'Client Portal', external: true },
    ],
  },
  {
    section: 'Resources',
    items: [
      { to: '/ips', icon: Globe, label: 'IP Ledger' },
      { to: '/ip-audit', icon: Search, label: 'IP Audit' },
      { to: '/devices', icon: Smartphone, label: 'Devices' },
      { to: '/sims', icon: CreditCard, label: 'SIM Cards' },
    ],
  },
];

export default function Sidebar({ theme, onToggleTheme, version }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">
          <MessageSquare size={18} strokeWidth={2.2} />
        </div>
        <div className="sidebar-brand-text">
          <span className="sidebar-title">FeedFlow</span>
          <span className="sidebar-version">v{version || '—'}</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV.map((group) => (
          <div key={group.section} className="sidebar-group">
            <div className="sidebar-section">{group.section}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              if (item.external) {
                return (
                  <a
                    key={item.to}
                    href={item.to}
                    target="_blank"
                    rel="noreferrer"
                    className="sidebar-link"
                  >
                    <Icon size={16} strokeWidth={2} />
                    <span>{item.label}</span>
                    <ExternalLink size={12} className="sidebar-ext" />
                  </a>
                );
              }
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
                >
                  <Icon size={16} strokeWidth={2} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-footer-btn" onClick={onToggleTheme}>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <NavLink to="/settings" className="sidebar-footer-btn">
          <Settings size={16} />
          <span>Settings</span>
        </NavLink>
      </div>
    </aside>
  );
}
