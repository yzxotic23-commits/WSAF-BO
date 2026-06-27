import { useEffect, useState } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import OverviewPage from './pages/OverviewPage';
import FeedingPage from './pages/FeedingPage';
import AccountsPage from './pages/AccountsPage';
import ActivationPage from './pages/ActivationPage';
import NurturingPage from './pages/NurturingPage';
import SettingsPage from './pages/SettingsPage';
import {
  IpsPage, DevicesPage, SimsPage, WorkOrdersPage, IpAuditPage,
} from './pages/ResourcePages';
import { useSocketStatus } from './hooks/useSocket';
import { apiGet } from './lib/api';
import { isAmsEmbed } from './lib/embed';

function App() {
  const embedded = isAmsEmbed();
  const [theme, setTheme] = useState(() => (
    embedded ? 'light' : (localStorage.getItem('ff-theme') || 'light')
  ));
  const [version, setVersion] = useState('');
  const connected = useSocketStatus();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ff-theme', theme);
  }, [theme]);

  useEffect(() => {
    apiGet('/api/health').then((h) => setVersion(h.version)).catch(() => {});
  }, []);

  return (
    <HashRouter>
      <AppShell
        embedded={embedded}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        version={version}
        connected={connected}
      >
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/feeding" element={<FeedingPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/activation" element={<ActivationPage />} />
          <Route path="/nurturing" element={<NurturingPage />} />
          <Route path="/workorders" element={<WorkOrdersPage />} />
          <Route path="/ips" element={<IpsPage />} />
          <Route path="/ip-audit" element={<IpAuditPage />} />
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/sims" element={<SimsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* Legacy paths → new routes */}
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
          <Route path="/ams/*" element={<Navigate to="/accounts" replace />} />
        </Routes>
      </AppShell>
    </HashRouter>
  );
}

export default App;
