import { PageHeader, Badge, DataTable, Spinner } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { apiGet } from '../lib/api';
import './pages.css';

export function makeResourcePage({ title, description, endpoint, columns }) {
  return function ResourcePage() {
    const { data, loading } = useApi(() => apiGet(endpoint), [endpoint]);
    const rows = (Array.isArray(data) ? data : data?.accounts || []).map((r) => ({ ...r, id: r.id }));

    return (
      <div>
        <PageHeader title={title} description={description} />
        {loading ? (
          <div className="page-loading"><Spinner /></div>
        ) : (
          <DataTable columns={columns} rows={rows} />
        )}
      </div>
    );
  };
}

export const IpsPage = makeResourcePage({
  title: 'IP Ledger',
  description: 'Daftar proxy dan IP yang dipakai akun.',
  endpoint: '/api/ams/ips',
  columns: [
    { key: 'address', label: 'Address', render: (r) => `${r.address}${r.port ? `:${r.port}` : ''}` },
    { key: 'active', label: 'Status', render: (r) => <Badge tone={r.active ? 'success' : 'default'}>{r.active ? 'Active' : 'Inactive'}</Badge> },
    { key: 'risk_count', label: 'Risk' },
    { key: 'in_use', label: 'In use', render: (r) => (r.in_use ? 'Yes' : 'No') },
  ],
});

export const DevicesPage = makeResourcePage({
  title: 'Devices',
  description: 'Perangkat fisik di shelf/site.',
  endpoint: '/api/ams/devices',
  columns: [
    { key: 'code', label: 'Code' },
    { key: 'site_name', label: 'Site', render: (r) => r.site_name || '—' },
    { key: 'shelf', label: 'Shelf', render: (r) => r.shelf || '—' },
    { key: 'status', label: 'Status', render: (r) => <Badge>{r.status}</Badge> },
  ],
});

export const SimsPage = makeResourcePage({
  title: 'SIM Cards',
  description: 'Kartu SIM dan saldo/expiry.',
  endpoint: '/api/ams/sims',
  columns: [
    { key: 'phone_number', label: 'Number' },
    { key: 'telco', label: 'Telco', render: (r) => r.telco || '—' },
    { key: 'balance', label: 'Balance', render: (r) => r.balance ?? '—' },
    { key: 'status', label: 'Status', render: (r) => <Badge tone={r.status === 'ok' ? 'success' : 'warn'}>{r.status}</Badge> },
  ],
});

export const WorkOrdersPage = makeResourcePage({
  title: 'Work Orders',
  description: 'Permintaan operasional dari tim atau klien.',
  endpoint: '/api/ams/workorders',
  columns: [
    { key: 'ref', label: 'Ref' },
    { key: 'title', label: 'Title' },
    { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status', render: (r) => <Badge tone={r.status === 'done' ? 'success' : 'accent'}>{r.status}</Badge> },
    { key: 'brand_name', label: 'Brand', render: (r) => r.brand_name || '—' },
  ],
});

export const IpAuditPage = makeResourcePage({
  title: 'IP Audit',
  description: 'Riwayat audit dan risiko per IP.',
  endpoint: '/api/ams/ips/with-audit',
  columns: [
    { key: 'address', label: 'IP', render: (r) => `${r.address}${r.port ? `:${r.port}` : ''}` },
    { key: 'risk_count', label: 'Risk' },
    { key: 'last_audit_result', label: 'Last audit', render: (r) => r.last_audit_result || 'Never' },
    { key: 'last_audited_at', label: 'Audited at', render: (r) => r.last_audited_at || '—' },
  ],
});
