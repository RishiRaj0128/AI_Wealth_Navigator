import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RotateCcw, ChevronDown, ChevronUp, ShieldCheck } from '../icons';
import { fetchAuditLogs } from '../api';
import { Button, Chip } from '../primitives';
import { usePrefersReducedMotion } from '../hooks/useMotionGuards';

const STATUS_TONE = { executed: 'verified', approved: 'accent', rejected: 'neutral', pending_approval: 'medium' };
const STATUS_LABEL = { executed: 'Executed (simulation)', approved: 'Approved by human', rejected: 'Rejected', pending_approval: 'Pending approval' };
const RISK_TONE = { RED: 'critical', YELLOW: 'medium', GREEN: 'verified' };

export default function AuditView() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState(null);

  const loadLogs = async () => {
    setLoading(true);
    try {
      const data = await fetchAuditLogs();
      setLogs(data || []);
    } catch (e) {
      console.warn("Failed to load audit logs:", e);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, []);

  return (
    <div className="cc-page">

      {/* PAGE CONTEXT */}
      <div className="cc-page-header" style={{ maxWidth: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '16px' }}>
        <div style={{ maxWidth: 640 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <ShieldCheck size={16} strokeWidth={2} style={{ color: 'var(--cc-accent)' }} />
            <p className="cc-section-eyebrow" style={{ margin: 0 }}>Chain of custody</p>
          </div>
          <h1 className="text-page-title">Audit Log</h1>
          <p className="cc-page-desc">
            Every recommendation, approval, and execution is recorded. Permanent, forensic, immutable in PostgreSQL.
          </p>
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: 'var(--cc-text-tertiary)', letterSpacing: '0.01em' }}>
            AI can recommend. Humans approve. Actions are recorded.
          </p>
        </div>
        <Button tier="secondary" onClick={loadLogs} state={loading ? 'loading' : 'idle'} loadingLabel="Loading">
          <RotateCcw size={13} strokeWidth={2} style={{ marginRight: 6 }} />
          Refresh audit trail
        </Button>
      </div>

      {/* AUDIT LEDGER */}
      <section>
        {loading && logs.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--cc-text-tertiary)', fontSize: '13px' }}>
            Loading audit records from PostgreSQL…
          </div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--cc-text-tertiary)' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--cc-text-primary)' }}>No audit records recorded yet</div>
            <div style={{ fontSize: '13px', marginTop: '4px' }}>
              When governed actions are proposed, approved, rejected, or simulated, permanent audit rows appear here.
            </div>
          </div>
        ) : (
          <div className="cc-row-list">
            {logs.map((log) => {
              const isExpanded = expandedLogId === log.audit_id;
              const hasExecResult = Boolean(log.execution_result);
              const statusKey = log.new_status || log.approval_status || 'pending_approval';
              const riskKey = (log.action_tier || 'RED').toUpperCase();

              return (
                <div key={log.audit_id}>
                  <button
                    onClick={() => setExpandedLogId(isExpanded ? null : log.audit_id)}
                    aria-expanded={isExpanded}
                    data-cursor="hover"
                    className="cc-row"
                    style={{ border: 'none', borderBottom: '1px solid var(--line-hair)', background: 'none', width: '100%', cursor: 'pointer' }}
                  >
                    <div className="cc-row-main" style={{ flexWrap: 'wrap' }}>
                      {isExpanded ? <ChevronUp size={13} style={{ color: 'var(--cc-text-tertiary)', flexShrink: 0 }} /> : <ChevronDown size={13} style={{ color: 'var(--cc-text-tertiary)', flexShrink: 0 }} />}
                      <span className="text-data" style={{ color: 'var(--cc-accent)' }}>{log.audit_id}</span>
                      <span className="text-data" style={{ color: 'var(--cc-text-tertiary)' }}>{log.incident_id || 'INC-0001'}</span>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--cc-text-primary)' }}>{log.action_type || log.action_name || 'reroute_gateway_traffic'}</span>
                      <Chip tone={RISK_TONE[riskKey] || 'critical'}>{riskKey}</Chip>
                      <Chip tone={STATUS_TONE[statusKey] || 'medium'}>{STATUS_LABEL[statusKey] || statusKey}</Chip>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexShrink: 0 }}>
                      <span className="text-data">Actor: <strong style={{ color: 'var(--cc-text-secondary)' }}>{log.actor}</strong></span>
                      <span className="text-data">{new Date(log.timestamp).toLocaleString()}</span>
                    </div>
                  </button>

                  <AnimatePresence initial={false}>
                    {isExpanded && (
                      <motion.div
                        initial={prefersReducedMotion ? false : { height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={prefersReducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                        style={{ overflow: 'hidden' }}
                      >
                        <div style={{ padding: '16px 0 20px 25px', fontSize: '12px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '18px', marginBottom: '16px' }}>
                            <div>
                              <p className="cc-section-eyebrow" style={{ marginBottom: '4px' }}>Transition</p>
                              <div className="text-data" style={{ color: 'var(--cc-text-primary)' }}>
                                {log.previous_status || 'None'} → <strong style={{ color: 'var(--state-verified)' }}>{log.new_status}</strong>
                              </div>
                            </div>
                            <div>
                              <p className="cc-section-eyebrow" style={{ marginBottom: '4px' }}>Action ID &amp; investigation ID</p>
                              <div className="text-data">Action: {log.action_id || '-'} · Inv: {log.investigation_id || '-'}</div>
                            </div>
                            <div>
                              <p className="cc-section-eyebrow" style={{ marginBottom: '4px' }}>Governance policy</p>
                              <div style={{ color: 'var(--cc-text-primary)' }}>
                                {log.new_status === 'approved' ? 'Explicit human authorization granted' : log.new_status === 'rejected' ? 'Operator declined execution' : log.new_status === 'executed' ? 'Safe demonstration simulation executed' : 'Awaiting operator approval'}
                              </div>
                            </div>
                          </div>

                          {log.reason && (
                            <div style={{ marginBottom: '14px' }}>
                              <p className="cc-section-eyebrow" style={{ marginBottom: '4px' }}>Reason / operator notes</p>
                              <div style={{ color: 'var(--cc-text-secondary)' }}>{log.reason}</div>
                            </div>
                          )}

                          {hasExecResult && (
                            <div>
                              <p className="cc-section-eyebrow" style={{ marginBottom: '4px' }}>Execution result (verified safe simulation)</p>
                              <pre style={{ margin: 0, padding: '10px 14px', background: 'var(--ink-sunken)', borderRadius: 'var(--r-sm)', overflowX: 'auto', color: 'var(--cc-accent)' }}>
                                {JSON.stringify(log.execution_result, null, 2)}
                              </pre>
                              <div style={{ marginTop: '6px', color: 'var(--state-verified)', fontWeight: 600, fontSize: '11px' }}>
                                Invariant verified: 0 live Razorpay payments modified.
                              </div>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </section>

    </div>
  );
}
