import React, { useState, useEffect } from 'react';
import {
  FlaskConical, Play, RefreshCw, AlertTriangle, CheckCircle2, Download,
  ArrowUpRight, ShieldAlert, Cpu, Sparkles, Layers, History
} from 'lucide-react';
import { Button, Chip, Metric, Skeleton } from '../primitives';
import { generateLabData, fetchIncidentLabRuns, downloadIncidentLabData } from '../api';

const ANOMALY_OPTIONS = [
  { value: 'auto', label: 'Auto (Real-World Mixture — 3-7 Incidents)' },
  { value: 'gateway_spike', label: 'Gateway Failure Spike (HDFC / Axis / SBI / ICICI)' },
  { value: 'refund_spike', label: 'Merchant Refund Surge (>15% Refund Rate)' },
  { value: 'duplicate_refund', label: 'Duplicate Refund Rapid Sequence' },
  { value: 'webhook_delivery_failure', label: 'Webhook Signature / Delivery Failure' },
  { value: 'none', label: 'Clean Production Baseline (No Injected Anomaly)' },
];

export default function IncidentLabView({ onSelectIncident, onNavigate }) {
  const [anomalyType, setAnomalyType] = useState('auto');
  const [paymentsCount, setPaymentsCount] = useState(800);
  const [merchantsCount, setMerchantsCount] = useState(10);
  const [customSeed, setCustomSeed] = useState('');

  const [generating, setGenerating] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  const loadRuns = async () => {
    setRunsLoading(true);
    try {
      const data = await fetchIncidentLabRuns(15);
      setRuns(data || []);
    } catch (e) {
      console.warn('Could not fetch Incident Lab runs:', e);
    } finally {
      setRunsLoading(false);
    }
  };

  useEffect(() => {
    loadRuns();
  }, []);

  const handleGenerate = async (e) => {
    if (e) e.preventDefault();
    setGenerating(true);
    setErrorMsg(null);
    try {
      const payload = {
        payments: Number(paymentsCount) || 800,
        merchants: Number(merchantsCount) || 10,
        anomaly: anomalyType,
      };
      if (customSeed && !isNaN(Number(customSeed))) {
        payload.seed = Number(customSeed);
      }
      const res = await generateLabData(payload);
      setLastResult(res);
      await loadRuns();
    } catch (err) {
      setErrorMsg(err.message || 'Generation failed.');
    } finally {
      setGenerating(false);
    }
  };

  const handleExport = async () => {
    setDownloading(true);
    try {
      await downloadIncidentLabData();
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="cc-page">
      {/* 1. Header */}
      <div className="cc-page-header" style={{ maxWidth: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{ display: 'inline-flex', padding: '4px', borderRadius: '6px', background: 'rgba(76, 111, 255, 0.12)', color: 'var(--cc-accent)' }}>
              <FlaskConical size={18} strokeWidth={2} />
            </span>
            <h1 className="text-page-title" style={{ margin: 0 }}>Incident Lab</h1>
            <Chip tone="accent">Operations Testing</Chip>
          </div>
          <p className="cc-page-desc">
            Controlled, reproducible synthetic payment lifecycle generator with anomaly injection &amp; automated detection.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <Button tier="ghost" onClick={handleExport} disabled={downloading}>
            <Download size={13} strokeWidth={2} style={{ marginRight: 6 }} />
            {downloading ? 'Preparing…' : 'Export XLSX'}
          </Button>
          <Button tier="secondary" onClick={loadRuns} disabled={runsLoading}>
            <RefreshCw size={13} strokeWidth={2} style={{ marginRight: 6 }} />
            Refresh Runs
          </Button>
        </div>
      </div>

      {errorMsg && (
        <div style={{ padding: '12px 16px', borderRadius: 'var(--r-sm)', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#f87171', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={16} />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* 2. Simulation Generator Controls */}
      <section className="cc-card" style={{ padding: '20px' }}>
        <h2 className="text-card-title" style={{ margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Cpu size={16} strokeWidth={2} style={{ color: 'var(--cc-accent)' }} />
          Generate Synthetic Production Incident
        </h2>

        <form onSubmit={handleGenerate} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--cc-text-secondary)', marginBottom: '6px' }}>
                Anomaly Scenario Pattern
              </label>
              <select
                value={anomalyType}
                onChange={(e) => setAnomalyType(e.target.value)}
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--ink-raised)',
                  border: '1px solid var(--line-solid)',
                  color: 'var(--cc-text-primary)',
                  fontSize: '13px',
                }}
              >
                {ANOMALY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--cc-text-secondary)', marginBottom: '6px' }}>
                Transaction Batch Size
              </label>
              <input
                type="number"
                min="100"
                max="2500"
                step="50"
                value={paymentsCount}
                onChange={(e) => setPaymentsCount(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--ink-raised)',
                  border: '1px solid var(--line-solid)',
                  color: 'var(--cc-text-primary)',
                  fontSize: '13px',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--cc-text-secondary)', marginBottom: '6px' }}>
                Active Merchants
              </label>
              <input
                type="number"
                min="1"
                max="10"
                value={merchantsCount}
                onChange={(e) => setMerchantsCount(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--ink-raised)',
                  border: '1px solid var(--line-solid)',
                  color: 'var(--cc-text-primary)',
                  fontSize: '13px',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--cc-text-secondary)', marginBottom: '6px' }}>
                Seed (Optional Determinism)
              </label>
              <input
                type="text"
                placeholder="Random seed e.g. 42"
                value={customSeed}
                onChange={(e) => setCustomSeed(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--ink-raised)',
                  border: '1px solid var(--line-solid)',
                  color: 'var(--cc-text-primary)',
                  fontSize: '13px',
                }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '8px' }}>
            <Button tier="primary" onClick={handleGenerate} disabled={generating}>
              <Play size={13} strokeWidth={2} style={{ marginRight: 6 }} />
              {generating ? 'Simulating & Running Detection…' : 'Generate Synthetic Incident'}
            </Button>
          </div>
        </form>
      </section>

      {/* 3. Generated Run Result */}
      {lastResult && (
        <section className="cc-card" style={{ padding: '20px', borderLeft: '4px solid var(--cc-accent)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <CheckCircle2 size={18} style={{ color: 'var(--state-verified)' }} />
              <h2 className="text-card-title" style={{ margin: 0 }}>Latest Simulation Output</h2>
              <Chip tone="verified">Run Token: {lastResult.run_token || 'Generated'}</Chip>
            </div>
            {lastResult.generation_attempts > 1 && (
              <span style={{ fontSize: '11.5px', color: 'var(--cc-text-tertiary)' }}>
                Target reached after {lastResult.generation_attempts} generation attempts
              </span>
            )}
          </div>

          <div className="cc-metric-band" style={{ marginBottom: '16px' }}>
            <Metric size="md" label="Injected Scenario" value={lastResult.injected_scenario || lastResult.anomaly_type || 'auto'} />
            <div className="cc-metric-band-divider" />
            <Metric size="md" label="Target Entity" value={lastResult.target_entity_id || 'Distributed'} />
            <div className="cc-metric-band-divider" />
            <Metric size="md" label="Payments Ingested" value={lastResult.payments_ingested ?? lastResult.num_payments} />
            <div className="cc-metric-band-divider" />
            <Metric size="md" label="Anomalies Detected" value={lastResult.anomalies_detected ?? 0} tone={lastResult.anomalies_detected > 0 ? 'critical' : 'verified'} />
          </div>

          {lastResult.incidents && lastResult.incidents.length > 0 && (
            <div>
              <p className="cc-section-eyebrow" style={{ marginBottom: '8px' }}>
                Detected Incidents ({lastResult.incidents.length})
              </p>
              <div className="cc-row-list">
                {lastResult.incidents.map((inc) => (
                  <div key={inc.incident_id} className="cc-row" style={{ justifyContent: 'space-between', padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <ShieldAlert size={16} style={{ color: inc.severity === 'critical' ? 'var(--sev-critical)' : 'var(--sev-medium)' }} />
                      <div>
                        <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--cc-text-primary)' }}>
                          {inc.title}
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--cc-text-tertiary)' }}>
                          ID: {inc.incident_id} · Score: {Number(inc.anomaly_score || 0.85).toFixed(2)} · Exposure: ₹{Number(inc.potential_exposure || 0).toLocaleString('en-IN')}
                        </div>
                      </div>
                    </div>

                    <Button
                      tier="secondary"
                      onClick={() => {
                        if (onSelectIncident) onSelectIncident(inc);
                        else if (onNavigate) onNavigate('investigation');
                      }}
                    >
                      Investigate <ArrowUpRight size={13} style={{ marginLeft: 4 }} />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* 4. Generation History Runs */}
      <section className="cc-card" style={{ padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <History size={16} style={{ color: 'var(--cc-text-secondary)' }} />
            <h2 className="text-card-title" style={{ margin: 0 }}>Incident Lab Run History</h2>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--cc-text-tertiary)' }}>
            {runs.length} recorded runs in database
          </span>
        </div>

        {runsLoading ? (
          <Skeleton variant="block" height="120px" />
        ) : runs.length === 0 ? (
          <p style={{ fontSize: '13px', color: 'var(--cc-text-tertiary)', margin: '16px 0' }}>
            No Incident Lab runs recorded yet. Generate a run above to begin testing.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line-solid)', color: 'var(--cc-text-tertiary)' }}>
                  <th style={{ padding: '8px 10px' }}>Run ID</th>
                  <th style={{ padding: '8px 10px' }}>Seed</th>
                  <th style={{ padding: '8px 10px' }}>Scenario</th>
                  <th style={{ padding: '8px 10px' }}>Target Entity</th>
                  <th style={{ padding: '8px 10px' }}>Volume</th>
                  <th style={{ padding: '8px 10px' }}>Anomalies</th>
                  <th style={{ padding: '8px 10px' }}>Generated At</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.run_id} style={{ borderBottom: '1px solid var(--line-hair)' }}>
                    <td style={{ padding: '10px 10px', fontFamily: 'monospace', color: 'var(--cc-text-secondary)' }}>
                      {r.run_id}
                    </td>
                    <td style={{ padding: '10px 10px', color: 'var(--cc-accent)', fontWeight: 600 }}>
                      {r.seed}
                    </td>
                    <td style={{ padding: '10px 10px', color: 'var(--cc-text-primary)' }}>
                      {r.anomaly_type}
                    </td>
                    <td style={{ padding: '10px 10px', color: 'var(--cc-text-secondary)' }}>
                      {r.target_entity_id || '—'}
                    </td>
                    <td style={{ padding: '10px 10px', color: 'var(--cc-text-primary)' }}>
                      {r.num_payments}
                    </td>
                    <td style={{ padding: '10px 10px' }}>
                      <Chip tone={r.anomalous_events_count > 0 ? 'medium' : 'neutral'}>
                        {r.anomalous_events_count} events
                      </Chip>
                    </td>
                    <td style={{ padding: '10px 10px', color: 'var(--cc-text-tertiary)', fontSize: '11.5px' }}>
                      {new Date(r.generated_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
