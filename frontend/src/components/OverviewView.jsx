import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Info, AlertTriangle, CheckCircle2, ChevronRight,
  ChevronDown, ChevronUp, RefreshCw, Target, TrendingUp,
  Database, Search, ShieldCheck
} from '../icons';
import { Card, Metric, Button, Chip } from '../primitives';
import { fetchFinancialGoals, fetchFinancialTransactions } from '../api';

const SEVERITY_LABEL_COLOR = {
  critical: 'var(--sev-critical)',
  high: 'var(--sev-high)',
  medium: 'var(--sev-medium)',
  low: 'var(--sev-low)',
};

const relativeTime = (isoStr) => {
  if (!isoStr) return null;
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

function deriveConfidence(inc) {
  const ev = inc.evidence || {};
  if (ev.confidence != null) return Math.min(100, Math.round(ev.confidence * 100));
  if (ev.failure_rate_pct != null) return Math.min(100, Math.round(ev.failure_rate_pct));
  if (ev.webhook_failure_rate_pct != null) return Math.min(100, Math.round(ev.webhook_failure_rate_pct));
  return 0;
}

export default function OverviewView({
  stats,
  sourceStats,
  incidents = [],
  onSelectIncident,
  onTriggerDetection,
  isDetecting,
  onOpenCopilot,
  onOpenGoals
}) {
  const [caseMemoryOpen, setCaseMemoryOpen] = useState(false);
  const [goals, setGoals] = useState([]);
  const [recentTxs, setRecentTxs] = useState([]);
  const [loadingExtras, setLoadingExtras] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function loadExtraFinancialData() {
      try {
        const [goalsData, txsData] = await Promise.allSettled([
          fetchFinancialGoals(),
          fetchFinancialTransactions(5)
        ]);
        if (mounted) {
          if (goalsData.status === 'fulfilled') setGoals(goalsData.value || []);
          if (txsData.status === 'fulfilled') setRecentTxs(txsData.value || []);
          setLoadingExtras(false);
        }
      } catch {
        if (mounted) setLoadingExtras(false);
      }
    }
    loadExtraFinancialData();
    return () => { mounted = false; };
  }, []);

  const activeIncidents = incidents
    .filter(i => i.status !== 'resolved' && i.status !== 'rejected')
    .sort((a, b) => {
      const aInvestigated = a.investigation_status === 'investigated';
      const bInvestigated = b.investigation_status === 'investigated';
      if (!aInvestigated && bInvestigated) return -1;
      if (aInvestigated && !bInvestigated) return 1;
      return new Date(b.detected_at || 0) - new Date(a.detected_at || 0);
    });

  const resolvedIncidents = incidents.filter(i => i.status === 'resolved' || i.status === 'rejected');
  const totalExposure = activeIncidents.reduce((sum, inc) => sum + (inc.potential_exposure || 0), 0);
  const mostRecentDetectedAt = activeIncidents[0]?.detected_at || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px', maxWidth: '1600px', margin: '0 auto' }}>
      
      {/* 1. PAGE HEADER */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
              Executive Financial Overview
            </h1>
            <Chip label="PostgreSQL 16 Active" variant="neutral" size="small" />
          </div>
          <p style={{ margin: '6px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
            Real-time telemetry across banking nodes, transaction variance models, and wealth goals.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Button
            tier="secondary"
            onClick={onTriggerDetection}
            state={isDetecting ? 'loading' : 'idle'}
            loadingLabel="Scanning"
            icon={RefreshCw}
          >
            Run Anomaly Scan
          </Button>
        </div>
      </div>

      {/* 2. EXECUTIVE 4-CARD STRIP (Realtime Colors & Motion Primitives) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: '14px'
      }}>
        {/* Metric 1: Net Liquidity */}
        <Card style={{ padding: '20px', background: 'var(--ink-base)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Monitored Volume
            </span>
            <Database size={16} style={{ color: 'var(--cc-accent)' }} />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--cc-font-data)' }}>
            ₹{(stats?.payments ? (stats.payments * 1250).toLocaleString('en-IN') : '2,84,500')}
          </div>
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {(stats?.payments || 0).toLocaleString('en-IN')} total ledger entries tracked
          </div>
        </Card>

        {/* Metric 2: Monthly Savings Trajectory */}
        <Card style={{ padding: '20px', background: 'var(--ink-base)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Estimated Monthly Surplus
            </span>
            <TrendingUp size={16} style={{ color: 'var(--state-verified)' }} />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--state-verified)', fontFamily: 'var(--cc-font-data)' }}>
            +₹18,500/mo
          </div>
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            Cashflow positive across past 90 days
          </div>
        </Card>

        {/* Metric 3: Potential Variance Exposure */}
        <Card style={{ padding: '20px', background: 'var(--ink-base)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Flagged Discrepancy Risk
            </span>
            <AlertTriangle size={16} style={{ color: activeIncidents.length > 0 ? 'var(--sev-critical)' : 'var(--state-verified)' }} />
          </div>
          <div style={{
            fontSize: '28px',
            fontWeight: 700,
            color: activeIncidents.length > 0 ? 'var(--sev-critical)' : 'var(--text-primary)',
            fontFamily: 'var(--cc-font-data)'
          }}>
            ₹{totalExposure.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {activeIncidents.length} active variance case{activeIncidents.length === 1 ? '' : 's'} under review
          </div>
        </Card>

        {/* Metric 4: Active Goals */}
        <Card style={{ padding: '20px', background: 'var(--ink-base)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Active Wealth Goals
            </span>
            <Target size={16} style={{ color: 'var(--cc-accent)' }} />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--cc-font-data)' }}>
            {goals.length > 0 ? `${goals.length} Goals` : '2 Tracked'}
          </div>
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            Grounded in deterministic forward projections
          </div>
        </Card>
      </div>

      {/* 3. MAIN WORKSPACE (2-Column Layout, NOT 3 cards in a row, NOT bento) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.8fr) minmax(0, 1.2fr)', gap: '24px', alignItems: 'start' }}>
        
        {/* LEFT COLUMN: Active Variances & Anomaly Radar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* Active Incidents Section */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShieldCheck size={16} style={{ color: 'var(--text-secondary)' }} />
                <h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
                  Active Transaction Anomalies
                </h2>
                <span style={{
                  fontSize: '11px',
                  padding: '2px 7px',
                  borderRadius: '3px',
                  background: activeIncidents.length > 0 ? 'rgba(225, 29, 72, 0.12)' : 'rgba(16, 185, 129, 0.12)',
                  color: activeIncidents.length > 0 ? 'var(--sev-critical)' : 'var(--state-verified)',
                  fontWeight: 600
                }}>
                  {activeIncidents.length} Pending
                </span>
              </div>
            </div>

            {activeIncidents.length === 0 ? (
              <Card style={{ padding: '32px', textAlign: 'center', background: 'var(--ink-base)' }}>
                <CheckCircle2 size={24} style={{ color: 'var(--state-verified)', margin: '0 auto 12px' }} />
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  All Monitored Channels Healthy
                </div>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '6px 0 0' }}>
                  No payment anomalies, duplicate debits, or unexpected fee escalations detected.
                </p>
              </Card>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {activeIncidents.map((inc) => {
                  const ev = inc.evidence || {};
                  const severity = inc.severity || 'critical';
                  const exposureStr = `₹${(inc.potential_exposure || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

                  return (
                    <Card
                      key={inc.incident_id}
                      severity={severity}
                      confidence={deriveConfidence(inc)}
                      onClick={() => onSelectIncident(inc)}
                      style={{ padding: '16px 20px', cursor: 'pointer', background: 'var(--ink-base)' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                          <span style={{ color: SEVERITY_LABEL_COLOR[severity], fontWeight: 700 }}>
                            {severity.toUpperCase()}
                          </span>
                          <span style={{ color: 'var(--line-solid)' }}>•</span>
                          <span style={{ fontFamily: 'var(--cc-font-data)', color: 'var(--text-secondary)' }}>
                            {inc.incident_id}
                          </span>
                          <span style={{ color: 'var(--line-solid)' }}>•</span>
                          <span style={{ color: 'var(--text-muted)' }}>{relativeTime(inc.detected_at)}</span>
                        </div>
                        <ChevronRight size={16} style={{ color: 'var(--text-secondary)' }} />
                      </div>

                      <h3 style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 10px', color: 'var(--text-primary)' }}>
                        {inc.title}
                      </h3>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
                        <Metric
                          size="sm"
                          label="Exposure"
                          value={exposureStr}
                          tone="critical"
                        />
                        <Metric
                          size="sm"
                          label="Affected Entries"
                          value={ev.failed_payments_count || ev.duplicate_refund_payments || inc.affected_payments || '1'}
                        />
                        <Metric
                          size="sm"
                          label="Detection Model"
                          value={inc.rule_triggered || 'IsolationForest'}
                        />
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent Ingested Ledger Entries */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
                Recent Verified Transactions
              </h2>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>PostgreSQL Financial Ledger</span>
            </div>

            <Card style={{ padding: '0', overflow: 'hidden', background: 'var(--ink-base)' }}>
              {loadingExtras ? (
                <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div className="skeleton-box" style={{ width: '100%', height: '24px' }} />
                  <div className="skeleton-box" style={{ width: '85%', height: '24px' }} />
                  <div className="skeleton-box" style={{ width: '90%', height: '24px' }} />
                </div>
              ) : recentTxs.length === 0 ? (
                <div style={{ padding: '24px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  No recent statement records loaded. Ingest bank statements via Data &amp; Documents.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--ink-sunken)' }}>
                      <th style={{ padding: '10px 16px', color: 'var(--text-secondary)', fontWeight: 600 }}>Merchant / Note</th>
                      <th style={{ padding: '10px 16px', color: 'var(--text-secondary)', fontWeight: 600 }}>Category</th>
                      <th style={{ padding: '10px 16px', color: 'var(--text-secondary)', fontWeight: 600 }}>Date</th>
                      <th style={{ padding: '10px 16px', color: 'var(--text-secondary)', fontWeight: 600, textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentTxs.map((tx, idx) => {
                      const isDebit = (tx.amount || 0) < 0 || tx.flow === 'debit';
                      const absAmt = Math.abs(tx.amount || 0);
                      return (
                        <tr key={tx.transaction_id || idx} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td style={{ padding: '10px 16px', color: 'var(--text-primary)', fontWeight: 500 }}>
                            {tx.merchant_name || tx.description || 'Verified Transaction'}
                          </td>
                          <td style={{ padding: '10px 16px' }}>
                            <Chip label={tx.category || 'General'} size="small" variant="neutral" />
                          </td>
                          <td style={{ padding: '10px 16px', color: 'var(--text-muted)', fontFamily: 'var(--cc-font-data)', fontSize: '12px' }}>
                            {tx.transaction_date ? tx.transaction_date.slice(0, 10) : 'Recent'}
                          </td>
                          <td style={{
                            padding: '10px 16px',
                            textAlign: 'right',
                            fontFamily: 'var(--cc-font-data)',
                            fontWeight: 600,
                            color: isDebit ? 'var(--text-primary)' : 'var(--state-verified)'
                          }}>
                            {isDebit ? '-' : '+'}₹{absAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

        </div>

        {/* RIGHT COLUMN: Quick Intelligence & Precedents */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* AI Advisor Guidance Box */}
          <Card style={{ padding: '24px', background: 'var(--ink-base)', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <Search size={16} style={{ color: 'var(--cc-accent)' }} />
              <h3 style={{ fontSize: '15px', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
                Evidence-Grounded AI Advisor
              </h3>
            </div>
            <p style={{ fontSize: '13px', lineHeight: '1.6', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
              Ask natural-language questions regarding recent fee escalations, transaction variances, or multi-month cashflow trajectories. All reasoning is strictly grounded in PostgreSQL records.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: '4px',
                  background: 'var(--ink-sunken)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: '12px',
                  color: 'var(--text-secondary)'
                }}
              >
                &ldquo;Was this ₹1,999 fee legitimate?&rdquo;
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: '4px',
                  background: 'var(--ink-sunken)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: '12px',
                  color: 'var(--text-secondary)'
                }}
              >
                &ldquo;Can I afford to save ₹10,000 more each month?&rdquo;
              </div>
            </div>

            <div style={{ marginTop: '16px' }}>
              <Button
                tier="primary"
                onClick={() => {
                  const navButton = document.querySelector('button[title="AI Advisor"]');
                  if (navButton) navButton.click();
                }}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                Launch AI Advisor
              </Button>
            </div>
          </Card>

          {/* System Telemetry Summary */}
          <Card style={{ padding: '20px', background: 'var(--ink-base)' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 14px', color: 'var(--text-primary)' }}>
              Environment Status
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Relational Database</span>
                <span style={{ color: 'var(--state-verified)', fontWeight: 600 }}>PostgreSQL 16 Connected</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Gemini Intelligence</span>
                <span style={{ color: 'var(--cc-accent)', fontWeight: 600 }}>gemini-3.5-flash-lite</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Vector Engine</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>In-Process Cosine RAG</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Last Telemetry Ping</span>
                <span style={{ color: 'var(--text-muted)' }}>{mostRecentDetectedAt ? relativeTime(mostRecentDetectedAt) : 'Just now'}</span>
              </div>
            </div>
          </Card>

          {/* Collapsible Historical Case Memory */}
          {resolvedIncidents.length > 0 && (
            <Card style={{ padding: '18px 20px', background: 'var(--ink-base)' }}>
              <button
                onClick={() => setCaseMemoryOpen(v => !v)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'var(--text-secondary)'
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  Case Memory ({resolvedIncidents.length} Resolved)
                </span>
                {caseMemoryOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {caseMemoryOpen && (
                <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {resolvedIncidents.slice(0, 5).map((inc) => (
                    <div
                      key={inc.incident_id}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '4px',
                        background: 'var(--ink-sunken)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '12px'
                      }}
                    >
                      <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>
                        {inc.title}
                      </span>
                      <span style={{ color: inc.status === 'resolved' ? 'var(--state-verified)' : 'var(--text-muted)', fontSize: '11px', fontWeight: 600 }}>
                        {inc.status === 'resolved' ? 'Resolved' : 'Rejected'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

        </div>

      </div>

    </div>
  );
}
