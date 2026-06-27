import { useCallback, useEffect, useState } from 'react';
import { Activity, Users, ShieldAlert, TrendingUp } from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
} from 'recharts';
import { PageHeader, StatCard, Card, Badge, DataTable, Spinner } from '../components/ui';
import { apiGet } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import './pages.css';

const PIE_COLORS = ['#0f7b6c', '#d9730d', '#e03e3e'];

function auditTone(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'success') return 'success';
  if (s === 'restrict') return 'warn';
  if (s === 'banned') return 'danger';
  return 'default';
}

export default function OverviewPage() {
  const [audit, setAudit] = useState(null);
  const [status, setStatus] = useState(null);
  const [ams, setAms] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [auditData, statusData, amsData] = await Promise.all([
        apiGet('/api/audit?limit=100'),
        apiGet('/api/status'),
        apiGet('/api/ams/summary'),
      ]);
      setAudit(auditData);
      setStatus(statusData);
      setAms(amsData);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useSocket('status', setStatus);
  useSocket('audit', (data) => {
    if (data?.summary) setAudit((prev) => ({ ...prev, summary: data.summary, entries: data.entries || prev?.entries }));
  });

  if (loading) {
    return <div className="page-loading"><Spinner /></div>;
  }

  const summary = audit?.summary || {};
  const accounts = status?.accounts || [];
  const online = accounts.filter((a) => a.connected).length;
  const pieData = [
    { name: 'Success', value: summary.successVolume || 0 },
    { name: 'Restrict', value: summary.restrictVolume || 0 },
    { name: 'Banned', value: summary.bannedVolume || 0 },
  ];

  const ipChart = (summary.byIp || []).slice(0, 6).map((r) => ({
    ip: r.ip.length > 16 ? `${r.ip.slice(0, 14)}…` : r.ip,
    success: r.success,
    restrict: r.restrict,
    banned: r.banned,
  }));

  const auditRows = (audit?.entries || []).slice(0, 20).map((e, i) => ({
    id: e.id || i,
    dateTime: e.dateTime || '—',
    accountName: e.accountName || '—',
    feedingStatus: e.feedingStatus || '—',
    ipAddress: e.ipAddress || '—',
  }));

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Ringkasan feeding, kesehatan akun WhatsApp, dan status AMS dalam satu tempat."
      />

      <div className="stat-grid">
        <StatCard label="Akun online" value={online} hint={`dari ${accounts.length} slot`} tone="accent" />
        <StatCard label="Feeding volume" value={summary.totalFeedingVolume ?? 0} tone="default" />
        <StatCard label="Success rate" value={`${summary.successRate ?? 0}%`} hint={`${summary.successVolume ?? 0} sukses`} tone="success" />
        <StatCard label="AMS accounts" value={ams?.accounts?.total ?? 0} hint="Total di ledger" tone="default" />
      </div>

      <div className="grid-2" style={{ marginBottom: 24 }}>
        <Card>
          <div className="card-title-row">
            <Activity size={16} />
            <h3>Feeding outcomes</h3>
          </div>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} dataKey="value" innerRadius={55} outerRadius={85} paddingAngle={2}>
                  {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="legend-row">
            <span><Badge tone="success">Success {summary.successVolume ?? 0}</Badge></span>
            <span><Badge tone="warn">Restrict {summary.restrictVolume ?? 0}</Badge></span>
            <span><Badge tone="danger">Banned {summary.bannedVolume ?? 0}</Badge></span>
          </div>
        </Card>

        <Card>
          <div className="card-title-row">
            <TrendingUp size={16} />
            <h3>IP performance</h3>
          </div>
          <div className="chart-box">
            {ipChart.length ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={ipChart}>
                  <XAxis dataKey="ip" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="success" stackId="a" fill="#0f7b6c" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="restrict" stackId="a" fill="#d9730d" />
                  <Bar dataKey="banned" stackId="a" fill="#e03e3e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="ff-empty-desc" style={{ padding: 40, textAlign: 'center' }}>Belum ada data IP</div>
            )}
          </div>
        </Card>
      </div>

      <Card className="section-card">
        <div className="card-title-row">
          <Users size={16} />
          <h3>Akun WhatsApp</h3>
          {status?.feedingRunning && <Badge tone="wa">Feeding aktif</Badge>}
        </div>
        <div className="account-grid">
          {accounts.length === 0 ? (
            <div className="ff-empty-desc">Belum ada akun dikonfigurasi</div>
          ) : (
            accounts.map((a) => (
              <div key={a.slot} className="account-tile">
                <div className="account-tile-name">{a.label || a.name}</div>
                <div className="account-tile-phone">{a.phone || 'Belum terhubung'}</div>
                <Badge tone={a.connected ? 'success' : a.linking ? 'warn' : 'default'}>
                  {a.feedingActive ? 'Feeding' : a.linking ? 'Linking' : a.connected ? 'Online' : 'Offline'}
                </Badge>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card className="section-card" style={{ marginTop: 16 }}>
        <div className="card-title-row">
          <ShieldAlert size={16} />
          <h3>Audit log terbaru</h3>
        </div>
        <DataTable
          columns={[
            { key: 'dateTime', label: 'Waktu' },
            { key: 'accountName', label: 'Akun' },
            { key: 'feedingStatus', label: 'Status', render: (r) => <Badge tone={auditTone(r.feedingStatus)}>{r.feedingStatus}</Badge> },
            { key: 'ipAddress', label: 'IP' },
          ]}
          rows={auditRows}
        />
      </Card>
    </div>
  );
}
