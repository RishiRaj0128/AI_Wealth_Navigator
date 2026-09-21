import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X, FileText, AlertTriangle, ChevronDown, ChevronUp, RotateCcw } from '../icons';
import {
  uploadFinancialDocument, fetchFinancialDocuments, fetchFinancialSummary,
  fetchFinancialTransactions, askCopilot, fetchCopilotRuns, fetchCopilotRun,
  financialDocumentDownloadUrl, fetchFinancialDocumentPreview, deleteFinancialDocument
} from '../api';
import { Metric, Button, Chip, Skeleton } from '../primitives';
import { usePrefersReducedMotion } from '../hooks/useMotionGuards';

const SUGGESTED_QUESTIONS = [
  "Find unusual transactions",
  "Why did spending increase?",
  "Compare this month vs last month",
  "Find recurring payments",
  "Explain my largest charges"
];

const DOC_TYPE_OPTIONS = [
  { value: '', label: 'Auto-detect' },
  { value: 'bank_statement', label: 'Bank Statement' },
  { value: 'credit_card_statement', label: 'Credit Card Statement' },
  { value: 'transaction_csv', label: 'Transaction CSV' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'fee_policy', label: 'Fee / Policy Document' },
  { value: 'refund_report', label: 'Refund Report' }
];

const STATUS_TONE = { ready: 'verified', processing: 'accent', partial: 'medium', failed: 'critical' };
const STATUS_LABEL = { ready: 'Ready', processing: 'Processing', partial: 'Ready (search only)', failed: 'Failed' };

const LOADING_PHASES = [
  "Analyzing your financial data…",
  "Retrieving relevant evidence…",
  "Preparing your answer…"
];

// Intentional loading, not a generic spinner: a small status line + a
// Skeleton standing in the exact shape the real answer is about to take
// (a lede line + two evidence rows), so the transition into the real
// content reads as a continuation rather than content "suddenly appearing".
function AnswerLoading() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPhase(p => (p + 1) % LOADING_PHASES.length), 1600);
    return () => clearInterval(id);
  }, []);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--cc-text-tertiary)', fontSize: '12.5px', marginBottom: '14px' }}>
        <span className="spinner"></span>
        <span>{LOADING_PHASES[phase]}</span>
      </div>
      <Skeleton variant="text" lines={2} />
      <div style={{ marginTop: '18px' }}>
        <Skeleton variant="block" height="52px" />
      </div>
    </div>
  );
}

// The investigation-result surface. Deliberately not a "chat bubble" —
// answer as the lede, then labeled evidence sections separated by
// whitespace/dividers, matching the rest of this system's card-free
// composition rather than nested boxes-within-a-box.
function AnswerBody({ report, incidents, onSelectIncident, onViewTransactions }) {
  const matchedIncidentFor = (merchant) => {
    if (!merchant || !incidents) return null;
    const lower = merchant.toLowerCase();
    return incidents.find(inc => inc.target_entity_id && inc.target_entity_id.toLowerCase().includes(lower)) || null;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        {report.insufficient_evidence && (
          <Chip tone="medium" className="cc-mb-8">Insufficient evidence</Chip>
        )}
        <p style={{ fontSize: '17px', lineHeight: '1.5', color: 'var(--cc-text-primary)', margin: '6px 0 0', fontWeight: 550 }}>
          {report.answer}
        </p>
      </div>

      {report.primary_drivers?.length > 0 && (
        <div>
          <p className="cc-section-eyebrow" style={{ marginBottom: '8px' }}>Primary drivers</p>
          <div className="cc-row-list">
            {report.primary_drivers.map((d, i) => (
              <div key={i} className="cc-row" style={{ padding: '8px 0' }}>
                <span style={{ color: 'var(--cc-text-secondary)', fontSize: '13px' }}>{d.label}</span>
                <span className="text-data" style={{ color: d.direction === 'increase' ? 'var(--sev-critical)' : 'var(--state-verified)', fontWeight: 700 }}>
                  {d.direction === 'increase' ? '+' : '−'}₹{Math.abs(d.amount).toLocaleString('en-IN')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {report.notable_transactions?.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <p className="cc-section-eyebrow" style={{ margin: 0 }}>Notable transactions</p>
            <button onClick={onViewTransactions} data-cursor="hover" style={{ background: 'none', border: 'none', color: 'var(--cc-accent)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>
              View all transactions
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {report.notable_transactions.map((t, i) => {
              const matched = matchedIncidentFor(t.merchant);
              return (
                <div key={i} style={{ paddingBottom: '10px', borderBottom: '1px solid var(--line-hair)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                    <span style={{ fontSize: '13px', color: 'var(--cc-text-primary)', fontWeight: 600 }}>{t.merchant}</span>
                    <span className="text-data" style={{ color: 'var(--sev-critical)', fontWeight: 700 }}>₹{Number(t.amount).toLocaleString('en-IN')}</span>
                  </div>
                  <div className="text-data" style={{ marginTop: '2px' }}>{t.date} · {t.reason}</div>
                  {matched && (
                    <button
                      onClick={() => onSelectIncident && onSelectIncident(matched)}
                      data-cursor="hover"
                      style={{ marginTop: '8px', display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: '1px solid var(--sev-critical)', color: 'var(--sev-critical)', fontSize: '11px', fontWeight: 600, padding: '4px 10px', borderRadius: 'var(--r-sm)', cursor: 'pointer' }}>
                      <AlertTriangle size={11} strokeWidth={2} />
                      Related MoneyOps incident found: open investigation
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {report.evidence?.length > 0 && (
        <div>
          <p className="cc-section-eyebrow" style={{ marginBottom: '8px' }}>Evidence</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {report.evidence.map((e, i) => (
              <div key={i} style={{ fontSize: '12px', color: 'var(--cc-text-tertiary)', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <Chip tone={e.type === 'calculation' ? 'accent' : e.type === 'document' ? 'neutral' : 'verified'}>
                  {e.type === 'calculation' ? 'Calc' : e.type === 'document' ? 'Doc' : 'Txn'}
                </Chip>
                <span style={{ paddingTop: '2px' }}>
                  {e.filename && <strong style={{ color: 'var(--cc-text-secondary)' }}>{e.filename}{e.page ? ` (p.${e.page})` : ''}{e.section ? ` (${e.section})` : ''}: </strong>}
                  {e.detail}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {report.sources_consulted?.length > 0 && (
        <div>
          <p className="cc-section-eyebrow" style={{ marginBottom: '8px' }}>Sources consulted</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {report.sources_consulted.map((s, i) => (
              <Chip key={i}>
                <FileText size={11} strokeWidth={2} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                {s.filename}{s.page ? ` · p.${s.page}` : ''}{s.section ? ` · ${s.section}` : ''}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function FinancialCopilotView({ incidents, onSelectIncident }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [summary, setSummary] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [runs, setRuns] = useState([]);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadType, setUploadType] = useState('');
  const [uploadAccount, setUploadAccount] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState(null);

  const [query, setQuery] = useState('');
  const [asking, setAsking] = useState(false);
  const [conversation, setConversation] = useState([]); // [{id, question, status, report, error, run_id, model, timestamp}]
  const [showTransactions, setShowTransactions] = useState(false);
  const [transactionList, setTransactionList] = useState([]);

  // History accordion — purely a read-only preview of a stored run. Never
  // touches `conversation` (the active chat) and never calls askCopilot.
  // expandedHistoryIds is a Set so independent rows can be open at once;
  // historyDetailCache holds fetched financial_analysis_runs detail so
  // re-toggling the same row never re-fetches, let alone re-runs Gemini.
  const [expandedHistoryIds, setExpandedHistoryIds] = useState(() => new Set());
  const [historyDetailCache, setHistoryDetailCache] = useState({});
  const [historyLoadingId, setHistoryLoadingId] = useState(null);
  const queryInputRef = useRef(null);

  const [previewDoc, setPreviewDoc] = useState(null); // {document, transactions, chunks}
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const conversationEndRef = useRef(null);

  const loadAll = useCallback(async () => {
    try {
      const [s, docs, runHistory] = await Promise.all([
        fetchFinancialSummary().catch(() => null),
        fetchFinancialDocuments().catch(() => []),
        fetchCopilotRuns(15).catch(() => [])
      ]);
      setSummary(s);
      setDocuments(docs || []);
      setRuns(runHistory || []);
    } catch (e) {
      console.error('Failed to load Financial Copilot data:', e);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation.length, conversation[conversation.length - 1]?.status]);

  const handleUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    setUploadNotice(null);
    try {
      const result = await uploadFinancialDocument(uploadFile, uploadType || null, uploadAccount || null);
      if (result.processing_status === 'ready') {
        setUploadNotice({ type: 'success', text: `${result.filename} indexed: ${result.transactions_extracted} transactions extracted, ${result.chunks_embedded}/${result.chunks_created} chunks embedded.` });
      } else {
        setUploadNotice({ type: 'error', text: `${result.filename} failed to process: ${result.error_message || 'Unknown error'}` });
      }
      setUploadFile(null);
      await loadAll();
    } catch (e) {
      setUploadNotice({ type: 'error', text: e.message });
    } finally {
      setUploading(false);
    }
  };

  const handleAsk = async (q) => {
    const question = (q || query).trim();
    if (!question || asking) return;

    const turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setConversation(prev => [...prev, { id: turnId, question, status: 'loading', timestamp: new Date().toISOString() }]);
    setQuery('');
    setAsking(true);

    try {
      const result = await askCopilot(question);
      setConversation(prev => prev.map(t => t.id === turnId
        ? { ...t, status: 'done', report: result.report, run_id: result.run_id, model: result.model }
        : t));
      await loadAll();
    } catch (e) {
      setConversation(prev => prev.map(t => t.id === turnId ? { ...t, status: 'error', error: e.message } : t));
    } finally {
      setAsking(false);
    }
  };

  // Toggling a history row is purely a local read: it never mutates
  // `conversation` and the only network call it can make is fetching the
  // already-stored run detail (GET /financial/copilot/runs/{id}) — never
  // askCopilot, so opening/closing history can never trigger a Gemini call.
  const toggleHistory = async (run) => {
    setExpandedHistoryIds(prev => {
      const next = new Set(prev);
      if (next.has(run.run_id)) {
        next.delete(run.run_id);
      } else {
        next.add(run.run_id);
      }
      return next;
    });

    if (historyDetailCache[run.run_id]) return; // already fetched — no re-fetch, no re-run

    setHistoryLoadingId(run.run_id);
    try {
      const detail = await fetchCopilotRun(run.run_id);
      const isError = detail.response && detail.response.error;
      setHistoryDetailCache(prev => ({
        ...prev,
        [run.run_id]: {
          question: detail.query,
          isError,
          report: isError ? null : detail.response,
          error: isError ? detail.response.error : null,
          model: detail.model,
          timestamp: detail.created_at
        }
      }));
    } catch (e) {
      console.error('Failed to load history entry:', e);
    } finally {
      setHistoryLoadingId(null);
    }
  };

  // "Continue this investigation" deliberately does NOT call askCopilot on
  // its own — it only moves the historical question into the active input
  // box so the user's own next "Ask" click is the one real, intentional
  // Gemini request. This can never duplicate a financial_analysis_runs
  // record, since nothing is submitted until the user acts.
  const handleContinueInvestigation = (runId) => {
    const cached = historyDetailCache[runId];
    if (!cached) return;
    setQuery(cached.question);
    setExpandedHistoryIds(prev => {
      const next = new Set(prev);
      next.delete(runId);
      return next;
    });
    queryInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    queryInputRef.current?.focus();
  };

  const handleViewTransactions = async () => {
    try {
      const txns = await fetchFinancialTransactions(100);
      setTransactionList(txns);
      setShowTransactions(true);
    } catch (e) {
      console.error(e);
    }
  };

  const handleView = async (doc) => {
    if (!doc.has_raw_content) return;
    if (doc.content_type === 'application/pdf') {
      window.open(financialDocumentDownloadUrl(doc.document_id, 'inline'), '_blank');
      return;
    }
    setPreviewLoading(true);
    try {
      const data = await fetchFinancialDocumentPreview(doc.document_id);
      setPreviewDoc(data);
    } catch (e) {
      console.error(e);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDelete = async (documentId) => {
    setDeletingId(documentId);
    try {
      await deleteFinancialDocument(documentId);
      setConfirmDeleteId(null);
      await loadAll();
    } catch (e) {
      console.error(e);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="cc-page">

      {/* PAGE CONTEXT */}
      <div className="cc-page-header" style={{ maxWidth: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '16px' }}>
        <div style={{ maxWidth: 640 }}>
          <p className="cc-section-eyebrow" style={{ color: 'var(--cc-accent)' }}>Financial Intelligence Copilot</p>
          <h1 className="text-page-title">What are we investigating?</h1>
          <p className="cc-page-desc">
            Hybrid retrieval over your uploaded statements and policies: structured PostgreSQL analytics,
            document RAG, and Gemini reasoning, always grounded in real evidence.
          </p>
        </div>
        <Button tier="primary" onClick={() => setShowUpload(v => !v)}>
          <Plus size={13} strokeWidth={2} style={{ marginRight: 6 }} />
          Upload financial data
        </Button>
      </div>

      {showUpload && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'flex-end', padding: '16px 0', borderTop: '1px solid var(--line-hair)', borderBottom: '1px solid var(--line-hair)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label className="cc-section-eyebrow" style={{ margin: 0 }}>File (PDF, CSV, XLSX)</label>
            <input type="file" accept=".pdf,.csv,.xlsx,.xls" onChange={e => setUploadFile(e.target.files[0] || null)} style={{ fontSize: '12px', color: 'var(--cc-text-primary)' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label className="cc-section-eyebrow" style={{ margin: 0 }}>Document type</label>
            <select value={uploadType} onChange={e => setUploadType(e.target.value)} style={{ padding: '7px 10px', borderRadius: 'var(--r-sm)', background: 'var(--ink-raised)', border: '1px solid var(--line-solid)', color: 'var(--cc-text-primary)', fontSize: '12px' }}>
              {DOC_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label className="cc-section-eyebrow" style={{ margin: 0 }}>Account name (optional)</label>
            <input type="text" value={uploadAccount} onChange={e => setUploadAccount(e.target.value)} placeholder="Primary Business Account"
              style={{ padding: '7px 10px', borderRadius: 'var(--r-sm)', background: 'var(--ink-raised)', border: '1px solid var(--line-solid)', color: 'var(--cc-text-primary)', fontSize: '12px' }} />
          </div>
          <Button tier="secondary" onClick={handleUpload} disabled={!uploadFile} state={uploading ? 'loading' : 'idle'} loadingLabel="Processing">
            Ingest document
          </Button>
        </div>
      )}

      {uploadNotice && (
        <p style={{ margin: 0, fontSize: '12.5px', color: uploadNotice.type === 'success' ? 'var(--state-verified)' : 'var(--sev-critical)' }}>
          {uploadNotice.text}
        </p>
      )}

      {/* CONNECTED DATA — hierarchy, not four identical boxes */}
      <div className="cc-metric-band">
        <Metric size="lg" label="Total volume" value={`₹${(summary?.total_volume_inr ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} sub="Across all transactions" />
        <div className="cc-metric-band-divider" />
        <Metric size="lg" label="Transactions" value={(summary?.transactions ?? 0).toLocaleString('en-IN')} sub="Structured, in PostgreSQL" />
        <div className="cc-metric-band-divider" />
        <Metric size="sm" label="Documents" value={summary?.documents ?? 0} sub={`${summary?.documents_ready ?? 0} ready for retrieval`} />
        <div className="cc-metric-band-divider" />
        <Metric size="sm" label="Accounts" value={summary?.accounts ?? 0} sub="Derived from uploads" />
      </div>

      {/* DOCUMENT LIBRARY — source material index, not icon cards */}
      <section>
        <p className="cc-section-eyebrow" style={{ marginBottom: '4px' }}>Context</p>
        <h2 className="text-card-title" style={{ margin: '0 0 12px' }}>Connected documents</h2>
        {documents.length === 0 ? (
          <p style={{ fontSize: '13px', color: 'var(--cc-text-tertiary)' }}>No documents uploaded yet.</p>
        ) : (
          <div className="cc-row-list">
            {documents.map(d => {
              const isCsv = d.content_type && d.content_type.includes('csv');
              const isPdf = d.content_type === 'application/pdf';
              return (
                <div key={d.document_id} className="cc-row" style={{ alignItems: 'flex-start' }}>
                  <div className="cc-row-main" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <Chip tone={STATUS_TONE[d.processing_status] || 'accent'}>{STATUS_LABEL[d.processing_status] || 'Processing'}</Chip>
                      <span style={{ fontSize: '13px', color: 'var(--cc-text-primary)', fontWeight: 600 }}>{d.filename}</span>
                      <span className="text-data">{d.document_type}</span>
                    </div>
                    <div className="text-data" style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                      <span>{d.chunk_count} chunk{d.chunk_count === 1 ? '' : 's'} indexed</span>
                      <span>{d.transaction_count} transaction{d.transaction_count === 1 ? '' : 's'} extracted</span>
                      <span>Uploaded {new Date(d.uploaded_at).toLocaleString()}</span>
                      {!d.has_raw_content && <span style={{ color: 'var(--sev-medium)' }}>Original file unavailable</span>}
                    </div>
                    {(d.processing_status === 'failed' || d.processing_status === 'partial') && d.error_message && (
                      <div style={{ fontSize: '11px', color: d.processing_status === 'failed' ? 'var(--sev-critical)' : 'var(--sev-medium)' }}>{d.error_message}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    {d.has_raw_content && (
                      <button onClick={() => handleView(d)} disabled={previewLoading} data-cursor="hover"
                        style={{ background: 'none', border: '1px solid var(--line-solid)', color: 'var(--cc-accent)', fontSize: '11px', fontWeight: 600, padding: '4px 10px', borderRadius: 'var(--r-sm)', cursor: 'pointer' }}>
                        {isPdf ? 'View' : isCsv ? 'Preview' : 'View'}
                      </button>
                    )}
                    {d.has_raw_content && (
                      <a href={financialDocumentDownloadUrl(d.document_id, 'attachment')} data-cursor="hover"
                        style={{ background: 'none', border: '1px solid var(--line-hair)', color: 'var(--cc-text-tertiary)', fontSize: '11px', fontWeight: 600, padding: '4px 10px', borderRadius: 'var(--r-sm)', textDecoration: 'none' }}>
                        Download
                      </a>
                    )}
                    {confirmDeleteId === d.document_id ? (
                      <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <span style={{ fontSize: '11px', color: 'var(--sev-medium)' }}>Delete permanently?</span>
                        <Button tier="ghost" tone="critical" onClick={() => handleDelete(d.document_id)} state={deletingId === d.document_id ? 'loading' : 'idle'} loadingLabel="Removing">
                          Yes, delete
                        </Button>
                        <button onClick={() => setConfirmDeleteId(null)} data-cursor="hover" style={{ background: 'none', border: '1px solid var(--line-hair)', color: 'var(--cc-text-tertiary)', fontSize: '11px', padding: '4px 10px', borderRadius: 'var(--r-sm)', cursor: 'pointer' }}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmDeleteId(d.document_id)} data-cursor="hover"
                        style={{ background: 'none', border: '1px solid var(--line-hair)', color: 'var(--cc-text-tertiary)', fontSize: '11px', fontWeight: 600, padding: '4px 10px', borderRadius: 'var(--r-sm)', cursor: 'pointer' }}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* PREVIEW MODAL (CSV/XLSX table preview) */}
      {previewDoc && (
        <div onClick={() => setPreviewDoc(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(4,6,8,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth: '900px', width: '100%', maxHeight: '80vh', overflowY: 'auto', padding: '24px', background: 'var(--ink-base)', border: '1px solid var(--line-solid)', borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-float)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--cc-text-primary)' }}>{previewDoc.document.filename}</div>
              <button onClick={() => setPreviewDoc(null)} data-cursor="hover" style={{ background: 'none', border: 'none', color: 'var(--cc-text-tertiary)', cursor: 'pointer' }}><X size={16} /></button>
            </div>
            {previewDoc.transactions.length > 0 ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line-hair)' }}>
                      <th className="cc-section-eyebrow" style={{ padding: '0 8px 8px' }}>Date</th>
                      <th className="cc-section-eyebrow" style={{ padding: '0 8px 8px' }}>Merchant</th>
                      <th className="cc-section-eyebrow" style={{ padding: '0 8px 8px' }}>Category</th>
                      <th className="cc-section-eyebrow" style={{ padding: '0 8px 8px' }}>Type</th>
                      <th className="cc-section-eyebrow" style={{ padding: '0 8px 8px', textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewDoc.transactions.map(t => (
                      <tr key={t.transaction_id} style={{ borderBottom: '1px solid var(--line-hair)' }}>
                        <td className="text-data" style={{ padding: '8px' }}>{new Date(t.transaction_date).toLocaleDateString()}</td>
                        <td style={{ padding: '8px', color: 'var(--cc-text-primary)' }}>{t.merchant || '-'}</td>
                        <td style={{ padding: '8px', color: 'var(--cc-text-tertiary)' }}>{t.category || '-'}</td>
                        <td style={{ padding: '8px', color: t.transaction_type === 'credit' ? 'var(--state-verified)' : 'var(--sev-critical)' }}>{t.transaction_type}</td>
                        <td className="cc-numeric" style={{ padding: '8px', textAlign: 'right', color: 'var(--cc-text-primary)', fontWeight: 600 }}>₹{Number(t.amount).toLocaleString('en-IN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : previewDoc.chunks.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {previewDoc.chunks.map(c => (
                  <div key={c.chunk_id} style={{ paddingBottom: '10px', borderBottom: '1px solid var(--line-hair)', fontSize: '12px', color: 'var(--cc-text-tertiary)', whiteSpace: 'pre-wrap' }}>
                    {c.section && <div style={{ color: 'var(--cc-text-primary)', fontWeight: 700, marginBottom: '4px' }}>{c.section}{c.page_number ? ` (p.${c.page_number})` : ''}</div>}
                    {c.content}
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: '13px', color: 'var(--cc-text-tertiary)' }}>No indexed content available for this document.</p>
            )}
          </div>
        </div>
      )}

      {/* INVESTIGATION SURFACE — the centerpiece. Not chat bubbles: each turn
          shows the question as a small caption, then the answer as the real
          content (lede + labeled evidence sections), matching the brief's
          "question -> investigation result -> evidence -> action" hierarchy. */}
      <section>
        <p className="cc-section-eyebrow" style={{ marginBottom: '4px' }}>Investigate</p>
        <h2 className="text-card-title" style={{ margin: '0 0 16px' }}>Ask a question</h2>

        {conversation.length === 0 && (
          <div style={{ padding: '4px 0 24px' }}>
            <p style={{ margin: '0 0 14px', fontSize: '13px', color: 'var(--cc-text-tertiary)' }}>
              Ask something specific. The Copilot reasons over structured PostgreSQL analytics and your uploaded documents together.
            </p>
            <div className="cc-suggestion-list">
              {SUGGESTED_QUESTIONS.map(q => (
                <button
                  key={q}
                  onClick={() => handleAsk(q)}
                  disabled={asking}
                  data-cursor="hover"
                  className="cc-suggestion-item"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {conversation.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '28px', marginBottom: '28px' }}>
            {conversation.map(turn => (
              <div key={turn.id}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '10px' }}>
                  <p className="cc-section-eyebrow" style={{ margin: 0 }}>Question</p>
                  <span style={{ fontSize: '13px', color: 'var(--cc-text-secondary)' }}>{turn.question}</span>
                </div>
                <div style={{ borderTop: '1px solid var(--line-hair)', paddingTop: '16px' }}>
                  {turn.status === 'loading' && <AnswerLoading />}
                  {turn.status === 'error' && (
                    <p style={{ color: 'var(--sev-critical)', fontSize: '13px', margin: 0 }}><strong>Copilot notice:</strong> {turn.error}</p>
                  )}
                  {turn.status === 'done' && turn.report && (
                    <motion.div
                      initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <AnswerBody report={turn.report} incidents={incidents} onSelectIncident={onSelectIncident} onViewTransactions={handleViewTransactions} />
                    </motion.div>
                  )}
                </div>
              </div>
            ))}
            <div ref={conversationEndRef} />
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <input
            ref={queryInputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAsk(); }}
            placeholder="Ask about your financial data…"
            disabled={asking}
            style={{ flex: 1, minWidth: '260px', padding: '13px 16px', borderRadius: 'var(--r-md)', background: 'var(--ink-raised)', border: '1px solid var(--line-solid)', color: 'var(--cc-text-primary)', fontSize: '14px' }}
          />
          <Button tier="primary" onClick={() => handleAsk()} disabled={!query.trim()} state={asking ? 'loading' : 'idle'} loadingLabel="Investigating">
            Ask
          </Button>
        </div>
        {conversation.length > 0 && (
          <div className="cc-suggestion-list" style={{ marginTop: '12px' }}>
            {SUGGESTED_QUESTIONS.map(q => (
              <button
                key={q}
                onClick={() => handleAsk(q)}
                disabled={asking}
                data-cursor="hover"
                className="cc-suggestion-item"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* TRANSACTION TABLE (toggled via View Transactions) */}
      {showTransactions && (
        <section>
          <div className="cc-section-header">
            <h2 className="text-card-title">Transactions ({transactionList.length})</h2>
            <button onClick={() => setShowTransactions(false)} data-cursor="hover" style={{ background: 'none', border: 'none', color: 'var(--cc-text-tertiary)', cursor: 'pointer', fontSize: '12px' }}>Close</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line-hair)' }}>
                  <th className="cc-section-eyebrow" style={{ padding: '0 8px 8px' }}>Date</th>
                  <th className="cc-section-eyebrow" style={{ padding: '0 8px 8px' }}>Merchant</th>
                  <th className="cc-section-eyebrow" style={{ padding: '0 8px 8px' }}>Category</th>
                  <th className="cc-section-eyebrow" style={{ padding: '0 8px 8px' }}>Type</th>
                  <th className="cc-section-eyebrow" style={{ padding: '0 8px 8px', textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactionList.map(t => (
                  <tr key={t.transaction_id} style={{ borderBottom: '1px solid var(--line-hair)' }}>
                    <td className="text-data" style={{ padding: '8px' }}>{new Date(t.transaction_date).toLocaleDateString()}</td>
                    <td style={{ padding: '8px', color: 'var(--cc-text-primary)' }}>{t.merchant || '-'}</td>
                    <td style={{ padding: '8px', color: 'var(--cc-text-tertiary)' }}>{t.category || '-'}</td>
                    <td style={{ padding: '8px', color: t.transaction_type === 'credit' ? 'var(--state-verified)' : 'var(--sev-critical)' }}>{t.transaction_type}</td>
                    <td className="cc-numeric" style={{ padding: '8px', textAlign: 'right', color: 'var(--cc-text-primary)', fontWeight: 600 }}>₹{Number(t.amount).toLocaleString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* RUN HISTORY — expandable/collapsible preview only. Expanding a row
          NEVER touches the active conversation above and NEVER calls Gemini;
          it only reads the already-stored financial_analysis_runs record. */}
      {runs.length > 0 && (
        <section>
          <p className="cc-section-eyebrow" style={{ marginBottom: '4px' }}>History</p>
          <h2 className="text-card-title" style={{ margin: '0 0 12px' }}>Recent investigations</h2>
          <div className="cc-row-list">
            {runs.map(r => {
              const isExpanded = expandedHistoryIds.has(r.run_id);
              const detail = historyDetailCache[r.run_id];
              const isLoadingDetail = historyLoadingId === r.run_id;
              return (
                <div key={r.run_id}>
                  <button
                    onClick={() => toggleHistory(r)}
                    aria-expanded={isExpanded}
                    data-cursor="hover"
                    className="cc-row"
                    style={{ border: 'none', borderBottom: '1px solid var(--line-hair)', background: 'none', width: '100%', cursor: 'pointer' }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--cc-text-primary)', flex: 1, minWidth: 0, fontSize: '13px' }}>
                      {isExpanded ? <ChevronUp size={12} style={{ color: 'var(--cc-text-tertiary)', flexShrink: 0 }} /> : <ChevronDown size={12} style={{ color: 'var(--cc-text-tertiary)', flexShrink: 0 }} />}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.query}</span>
                    </span>
                    <span className="cc-row-meta">{new Date(r.created_at).toLocaleString()}</span>
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
                        <div style={{ padding: '16px 0 20px 20px' }}>
                          {isLoadingDetail && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--cc-text-tertiary)', fontSize: '12px' }}>
                              <span className="spinner"></span>
                              <span>Loading stored answer…</span>
                            </div>
                          )}
                          {!isLoadingDetail && detail && detail.isError && (
                            <p style={{ color: 'var(--sev-critical)', fontSize: '12px' }}><strong>Copilot notice:</strong> {detail.error}</p>
                          )}
                          {!isLoadingDetail && detail && !detail.isError && detail.report && (
                            <>
                              <AnswerBody report={detail.report} incidents={incidents} onSelectIncident={onSelectIncident} onViewTransactions={handleViewTransactions} />
                              <Button tier="ghost" onClick={() => handleContinueInvestigation(r.run_id)} className="cc-mt-14">
                                <RotateCcw size={12} strokeWidth={2} style={{ marginRight: 6 }} />
                                Continue this investigation
                              </Button>
                            </>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
