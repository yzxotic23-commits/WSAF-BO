import { Sprout } from 'lucide-react';
import { PageHeader, Badge, Card, Spinner } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { apiGet } from '../lib/api';
import './pages.css';

const COLS = ['registering', 'nurturing', 'standby', 'recovering'];
const LABELS = {
  registering: 'Registering',
  nurturing: 'Nurturing',
  standby: 'Standby',
  recovering: 'Recovering',
};

function dayCount(start) {
  if (!start) return null;
  const d = Math.floor((Date.now() - new Date(start)) / 86400000) + 1;
  return d;
}

export default function NurturingPage() {
  const { data, loading } = useApi(() => apiGet('/api/ams/accounts'), []);
  const accounts = data?.accounts || [];

  const groups = COLS.reduce((acc, col) => {
    acc[col] = accounts.filter((a) => a.status === col);
    return acc;
  }, {});

  if (loading) return <div className="page-loading"><Spinner /></div>;

  return (
    <div>
      <PageHeader
        title="Nurturing Pipeline"
        description="Kanban lifecycle akun dari registering hingga siap deliver."
      />

      <div className="pipeline-grid">
        {COLS.map((col) => (
          <div key={col} className="pipeline-col">
            <div className="pipeline-col-header">
              <span>{LABELS[col]}</span>
              <Badge>{groups[col].length}</Badge>
            </div>
            <div className="pipeline-col-body">
              {groups[col].length === 0 ? (
                <div className="meta-text" style={{ padding: 16, textAlign: 'center' }}>Kosong</div>
              ) : (
                groups[col].map((a) => (
                  <div key={a.id} className="pipeline-item">
                    <strong>{a.name}</strong>
                    <div className="meta-text">{a.phone_number || '—'}</div>
                    {col === 'nurturing' && a.nurture_start && (
                      <Badge tone={dayCount(a.nurture_start) >= 3 ? 'warn' : 'success'}>
                        Day {dayCount(a.nurture_start)}
                      </Badge>
                    )}
                    {a.brand_name && <div className="meta-text">{a.brand_name}</div>}
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      <Card className="section-card" style={{ marginTop: 20 }}>
        <div className="card-title-row">
          <Sprout size={16} />
          <h3>Nurturing aktif</h3>
        </div>
        <div className="meta-text">
          {groups.nurturing.length} akun sedang nurturing
          {groups.nurturing.filter((a) => dayCount(a.nurture_start) >= 3).length > 0 &&
            ` · ${groups.nurturing.filter((a) => dayCount(a.nurture_start) >= 3).length} siap review`}
        </div>
      </Card>
    </div>
  );
}
