import { useCallback, useEffect, useState } from 'react';
import { Zap, CheckCircle2 } from 'lucide-react';
import { PageHeader, Card, Button, Badge, StatCard, Spinner } from '../components/ui';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import './pages.css';

function checklist(a, wsafAccounts) {
  const wsaf = wsafAccounts.find((w) => w.slot === a.wsaf_slot);
  return {
    sim: !!a.sim_id,
    device: !!a.device_id,
    ip: !!a.ip_id,
    phone: !!(a.phone_number && a.phone_number.trim()),
    slot: a.wsaf_slot != null,
    linked: !!(wsaf && wsaf.connected),
  };
}

function progress(c) {
  const keys = ['sim', 'device', 'ip', 'phone', 'slot', 'linked'];
  return Math.round((keys.filter((k) => c[k]).length / keys.length) * 100);
}

export default function ActivationPage() {
  const [queue, setQueue] = useState([]);
  const [selected, setSelected] = useState(null);
  const [resources, setResources] = useState({ sims: [], devices: [], ips: [] });
  const [wsafStatus, setWsafStatus] = useState({ accounts: [] });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [acct, sims, devices, ips, status] = await Promise.all([
      apiGet('/api/ams/accounts?status=registering'),
      apiGet('/api/ams/sims'),
      apiGet('/api/ams/devices'),
      apiGet('/api/ams/ips?active=1'),
      apiGet('/api/status'),
    ]);
    setQueue(acct.accounts || []);
    setResources({ sims, devices, ips });
    setWsafStatus(status);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useSocket('status', setWsafStatus);

  const account = queue.find((a) => a.id === selected);
  const c = account ? checklist(account, wsafStatus.accounts || []) : null;
  const pct = c ? progress(c) : 0;

  async function patch(body) {
    const updated = await apiPatch(`/api/ams/accounts/${selected}`, body);
    setQueue((q) => q.map((a) => (a.id === selected ? updated : a)));
  }

  async function activate() {
    await patch({ status: 'nurturing', reason: 'Activation complete', changed_by: 'activation-desk' });
    setSelected(null);
    load();
  }

  if (loading) return <div className="page-loading"><Spinner /></div>;

  return (
    <div>
      <PageHeader
        title="Activation Desk"
        description="Proses onboarding akun baru — assign resource, link WhatsApp, lalu mulai nurturing."
        actions={
          <Button variant="primary" icon={Zap} onClick={async () => {
            const name = prompt('Nama akun baru:');
            if (!name) return;
            const created = await apiPost('/api/ams/accounts', { name, status: 'registering' });
            await load();
            setSelected(created.id);
          }}>
            Aktivasi baru
          </Button>
        }
      />

      <div className="stat-grid">
        <StatCard label="Pending" value={queue.length} tone="accent" />
        <StatCard label="Ready" value={queue.filter((a) => progress(checklist(a, wsafStatus.accounts || [])) >= 83).length} tone="warn" />
        <StatCard label="Linked" value={queue.filter((a) => checklist(a, wsafStatus.accounts || []).linked).length} tone="success" />
      </div>

      <div className="wizard-layout">
        <Card>
          <div className="card-title-row"><h3>Antrian aktivasi</h3></div>
          {queue.length === 0 ? (
            <p className="ff-empty-desc">Tidak ada akun dalam status registering.</p>
          ) : (
            queue.map((a) => {
              const p = progress(checklist(a, wsafStatus.accounts || []));
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`pipeline-item${selected === a.id ? ' active' : ''}`}
                  style={{ width: '100%', textAlign: 'left', marginBottom: 8, border: selected === a.id ? '1px solid var(--ff-accent)' : undefined }}
                  onClick={() => setSelected(a.id)}
                >
                  <strong>{a.name}</strong>
                  <span className="meta-text">{a.phone_number || 'No phone'} · {p}%</span>
                </button>
              );
            })
          )}
        </Card>

        <Card>
          {!account ? (
            <div className="ff-empty-desc" style={{ padding: 32, textAlign: 'center' }}>
              Pilih akun dari antrian
            </div>
          ) : (
            <>
              <div className="card-title-row">
                <h3>{account.name}</h3>
                <Badge tone="accent">{pct}%</Badge>
              </div>

              <div className={`step-card${c.sim && c.device && c.ip ? ' done' : ''}`}>
                <div className="step-title">1. Resources</div>
                <div className="step-fields">
                  <select id="act-sim" defaultValue={account.sim_id || ''}>
                    <option value="">— SIM —</option>
                    {resources.sims.map((s) => <option key={s.id} value={s.id}>{s.phone_number}</option>)}
                  </select>
                  <select id="act-device" defaultValue={account.device_id || ''}>
                    <option value="">— Device —</option>
                    {resources.devices.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
                  </select>
                  <select id="act-ip" defaultValue={account.ip_id || ''}>
                    <option value="">— IP —</option>
                    {resources.ips.map((ip) => <option key={ip.id} value={ip.id}>{ip.address}</option>)}
                  </select>
                  <Button variant="secondary" size="sm" onClick={() => patch({
                    sim_id: document.getElementById('act-sim').value || null,
                    device_id: document.getElementById('act-device').value || null,
                    ip_id: document.getElementById('act-ip').value || null,
                  })}>Simpan</Button>
                </div>
              </div>

              <div className={`step-card${c.phone ? ' done' : ''}`}>
                <div className="step-title">2. Phone</div>
                <div className="step-fields">
                  <input id="act-phone" defaultValue={account.phone_number || ''} placeholder="+60…" />
                  <Button variant="secondary" size="sm" onClick={() => patch({ phone_number: document.getElementById('act-phone').value })}>Simpan</Button>
                </div>
              </div>

              <div className={`step-card${c.slot ? ' done' : ''}`}>
                <div className="step-title">3. WSAF Slot</div>
                <div className="step-fields">
                  <select id="act-slot" defaultValue={account.wsaf_slot ?? ''}>
                    <option value="">— Slot —</option>
                    {(wsafStatus.accounts || []).map((w) => (
                      <option key={w.slot} value={w.slot}>Slot {w.slot} — {w.label}</option>
                    ))}
                  </select>
                  <Button variant="secondary" size="sm" onClick={() => patch({ wsaf_slot: parseInt(document.getElementById('act-slot').value, 10) })}>Assign</Button>
                </div>
              </div>

              <div className={`step-card${c.linked ? ' done' : ''}`}>
                <div className="step-title">4. Link WhatsApp</div>
                <Button variant="secondary" size="sm" disabled={account.wsaf_slot == null} onClick={() => apiPost(`/api/connect/${account.wsaf_slot}`, { method: 'qr' })}>
                  Mulai QR link
                </Button>
              </div>

              <Button variant="primary" icon={CheckCircle2} style={{ width: '100%', marginTop: 12 }} disabled={pct < 100} onClick={activate}>
                Aktifkan → Nurturing
              </Button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
