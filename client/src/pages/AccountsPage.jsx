import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { PageHeader, Badge, Button, DataTable, Spinner } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { apiGet, apiPost } from '../lib/api';
import './pages.css';

const STATUS_TONES = {
  registering: 'accent',
  nurturing: 'success',
  standby: 'warn',
  in_use: 'wa',
  recovering: 'warn',
  dead: 'danger',
};

export default function AccountsPage() {
  const [filter, setFilter] = useState('');
  const { data, loading, reload } = useApi(() => apiGet('/api/ams/accounts'), []);
  const accounts = data?.accounts || [];

  const filtered = useMemo(() => {
    if (!filter) return accounts;
    return accounts.filter((a) => a.status === filter);
  }, [accounts, filter]);

  const counts = useMemo(() => {
    const c = {};
    for (const a of accounts) c[a.status] = (c[a.status] || 0) + 1;
    return c;
  }, [accounts]);

  const rows = filtered.map((a) => ({ ...a, id: a.id }));

  return (
    <div>
      <PageHeader
        title="Account Ledger"
        description="Semua akun WhatsApp dan status lifecycle-nya."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => document.getElementById('new-acct-modal')?.showModal()}>
            Tambah akun
          </Button>
        }
      />

      <div className="filter-tabs">
        {['', 'registering', 'nurturing', 'standby', 'in_use', 'recovering', 'dead'].map((s) => (
          <button
            key={s || 'all'}
            type="button"
            className={`filter-tab${filter === s ? ' active' : ''}`}
            onClick={() => setFilter(s)}
          >
            {s || 'Semua'}
            <span className="filter-count">{s ? counts[s] || 0 : accounts.length}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="page-loading"><Spinner /></div>
      ) : (
        <DataTable
          columns={[
            { key: 'name', label: 'Nama' },
            { key: 'phone_number', label: 'Telepon', render: (r) => r.phone_number || '—' },
            { key: 'status', label: 'Status', render: (r) => <Badge tone={STATUS_TONES[r.status]}>{r.status}</Badge> },
            { key: 'site_name', label: 'Site', render: (r) => r.site_name || '—' },
            { key: 'brand_name', label: 'Brand', render: (r) => r.brand_name || '—' },
            { key: 'ip_address', label: 'IP', render: (r) => r.ip_address || '—' },
            { key: 'owner', label: 'Owner', render: (r) => r.owner || '—' },
          ]}
          rows={rows}
        />
      )}

      <dialog id="new-acct-modal" className="ff-dialog">
        <form
          method="dialog"
          onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            await apiPost('/api/ams/accounts', {
              name: fd.get('name'),
              phone_number: fd.get('phone') || null,
              status: fd.get('status') || 'registering',
            });
            e.target.closest('dialog').close();
            reload();
          }}
        >
          <h3>Tambah akun</h3>
          <label>Nama<input name="name" required /></label>
          <label>Telepon<input name="phone" placeholder="+60…" /></label>
          <label>Status
            <select name="status" defaultValue="registering">
              <option value="registering">Registering</option>
              <option value="nurturing">Nurturing</option>
              <option value="standby">Standby</option>
            </select>
          </label>
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => document.getElementById('new-acct-modal').close()}>Batal</Button>
            <Button variant="primary" type="submit">Simpan</Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
