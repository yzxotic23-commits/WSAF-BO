import { Settings } from 'lucide-react';
import { PageHeader, Card, Button } from '../components/ui';
import { apiGet } from '../lib/api';
import { useEffect, useState } from 'react';
import './pages.css';

export default function SettingsPage() {
  const [ai, setAi] = useState(null);

  useEffect(() => {
    apiGet('/api/ai/status').then(setAi).catch(() => {});
  }, []);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Konfigurasi AI, environment, dan preferensi aplikasi."
      />

      <Card>
        <div className="card-title-row">
          <Settings size={16} />
          <h3>AI Provider</h3>
        </div>
        {ai ? (
          <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
            <div>OpenAI ready: <strong>{ai.probe?.openaiReady ? 'Yes' : 'No'}</strong></div>
            <div>Ollama ready: <strong>{ai.probe?.ollamaReady ? 'Yes' : 'No'}</strong></div>
            <div>Model: <strong>{ai.probe?.model || '—'}</strong></div>
          </div>
        ) : (
          <div className="meta-text">Memuat status AI…</div>
        )}
      </Card>

      <Card style={{ marginTop: 16 }}>
        <div className="card-title-row"><h3>Environment</h3></div>
        <p className="meta-text" style={{ marginBottom: 12 }}>
          Pengaturan lanjutan (delay, pair count, proxy) dikelola via file .env di folder data aplikasi.
        </p>
        <Button variant="secondary" onClick={() => apiGet('/api/env').then((d) => alert(`PAIR_COUNT: ${d.PAIR_COUNT || '—'}`))}>
          Lihat env ringkas
        </Button>
      </Card>
    </div>
  );
}
