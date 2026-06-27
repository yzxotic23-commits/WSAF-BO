import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, Square, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { PageHeader, Card, Badge, Button, Spinner } from '../components/ui';
import { apiGet, apiPost } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import './pages.css';

function groupAccountsByPair(accounts) {
  const map = new Map();
  for (const account of accounts) {
    const pairIndex = account.pairIndex ?? Math.floor(account.slot / 2);
    if (!map.has(pairIndex)) {
      map.set(pairIndex, { pairIndex, accounts: [] });
    }
    map.get(pairIndex).accounts.push(account);
  }
  return [...map.values()].sort((a, b) => a.pairIndex - b.pairIndex);
}

function isPairReady(accounts) {
  return accounts.length >= 2 && accounts.every((a) => a.authSaved);
}

export default function FeedingPage() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyPair, setBusyPair] = useState(null);

  const load = useCallback(async () => {
    try {
      setStatus(await apiGet('/api/status'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useSocket('status', setStatus);

  async function startPairFeeding(pairIndex) {
    setBusyPair(pairIndex);
    try {
      const res = await apiPost('/api/feeding/start', { pairIndex });
      if (res?.error) throw new Error(res.error);
    } catch (err) {
      window.alert(err.message || 'Could not start feeding');
    } finally {
      setBusyPair(null);
    }
  }

  async function stopFeeding(pairIndex = null) {
    setBusyPair(pairIndex != null ? pairIndex : 'stop');
    try {
      await apiPost('/api/feeding/stop', pairIndex != null ? { pairIndex } : {});
    } finally {
      setBusyPair(null);
    }
  }

  function getActiveFeedingPairs() {
    const pairs = status?.feedingActivePairs;
    if (Array.isArray(pairs) && pairs.length) return pairs;
    if (status?.feedingPairIndex != null && (status?.feedingRunning || status?.feedingStarting)) {
      return [status.feedingPairIndex];
    }
    return [];
  }

  function isPairFeeding(pairIndex) {
    return getActiveFeedingPairs().includes(pairIndex);
  }

  if (loading) return <div className="page-loading"><Spinner /></div>;

  const accounts = status?.accounts || [];
  const activePairs = getActiveFeedingPairs();
  const anyFeeding = activePairs.length > 0 || status?.feedingRunning || status?.feedingStarting;
  const pairs = useMemo(() => groupAccountsByPair(accounts), [accounts]);

  return (
    <div>
      <PageHeader
        title="Feeding"
        description="Jalankan feeding per pair — tidak semua pair sekaligus."
        actions={
          <>
            <Button variant="secondary" icon={RefreshCw} onClick={load} disabled={busyPair !== null}>
              Refresh
            </Button>
            {anyFeeding && (
              <Button variant="danger" icon={Square} onClick={() => stopFeeding()} disabled={busyPair !== null}>
                Stop all feeding
              </Button>
            )}
          </>
        }
      />

      {status?.lastFeedingComplete && (
        <Card className="banner-card">
          <div className="banner-row">
            <span>Run terakhir: {status.lastFeedingComplete.messagesSent ?? 0} pesan</span>
            <Badge tone={status.lastFeedingComplete.success ? 'success' : 'warn'}>
              {status.lastFeedingComplete.success ? 'Sukses' : 'Dihentikan'}
            </Badge>
          </div>
        </Card>
      )}

      <div className="stat-grid" style={{ marginTop: 16 }}>
        <Card>
          <div className="mini-stat-label">Pairs</div>
          <div className="mini-stat-value">{status?.pairCount ?? 0}</div>
        </Card>
        <Card>
          <div className="mini-stat-label">Online</div>
          <div className="mini-stat-value">{accounts.filter((a) => a.connected).length}</div>
        </Card>
        <Card>
          <div className="mini-stat-label">Status</div>
          <div className="mini-stat-value" style={{ fontSize: 18 }}>
            {anyFeeding
              ? activePairs.length
                ? `${activePairs.length} pair(s) active`
                : 'Running'
              : status?.feedingStarting
                ? 'Starting…'
                : 'Idle'}
          </div>
        </Card>
        <Card>
          <div className="mini-stat-label">Delay</div>
          <div className="mini-stat-value" style={{ fontSize: 16 }}>
            {status?.config?.minDelay ?? '—'}–{status?.config?.maxDelay ?? '—'}s
          </div>
        </Card>
      </div>

      {pairs.map(({ pairIndex, accounts: pairAccounts }) => {
        const ready = isPairReady(pairAccounts);
        const isActive = isPairFeeding(pairIndex);
        const labels = pairAccounts.map((a) => a.label || a.name).join(' ↔ ');

        return (
          <Card key={pairIndex} className="section-card" style={{ marginTop: 16 }}>
            <div className="card-title-row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3>Pair {pairIndex + 1}</h3>
                <p className="meta-text">{labels || '—'}</p>
              </div>
              <Button
                variant={isActive ? 'danger' : 'primary'}
                icon={isActive ? Square : Play}
                disabled={(!ready && !isActive) || busyPair !== null}
                onClick={() => (isActive ? stopFeeding(pairIndex) : startPairFeeding(pairIndex))}
              >
                {isActive ? 'Stop' : 'Start feeding'}
              </Button>
            </div>
            <div className="account-grid">
              {pairAccounts.map((a) => (
                <div key={a.slot} className="account-tile feeding-tile">
                  <div className="account-tile-top">
                    <div>
                      <div className="account-tile-name">{a.label || a.name}</div>
                      <div className="account-tile-phone">{a.phone || '—'}</div>
                    </div>
                    {a.connected ? (
                      <Wifi size={16} className="icon-online" />
                    ) : (
                      <WifiOff size={16} className="icon-offline" />
                    )}
                  </div>
                  <div className="account-tile-meta">
                    <Badge tone={a.authSaved ? 'success' : 'default'}>
                      {a.authSaved ? 'Linked' : 'Not linked'}
                    </Badge>
                  </div>
                  {a.proxyMasked && <div className="meta-text">Proxy: {a.proxyMasked}</div>}
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
