import React, { useMemo, useState } from 'react';
import { Search, AlertCircle, RefreshCw, FileText, Database } from 'lucide-react';
import { Button, Skeleton } from '../primitives';
import { useRefreshableData, formatINR, formatDate } from '../hooks/useRefreshableData';
import {
  fetchFinancialTransactions,
  fetchFinancialAccounts,
  fetchFinancialDocuments,
  fetchFinancialSummary
} from '../api';

// "My Financial Data" — the evidence behind every figure the product shows,
// presented as a readable statement rather than a database dump. The rows are
// scoped server-side to the user's own account, so this page can no longer
// disagree with the dashboard the way it did when it listed every row in the
// table regardless of which account it belonged to.

const PAGE_SIZE = 25;

export default function MyDataView({ refreshToken }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(0);

  const { data, loading, refreshing, error, refresh } = useRefreshableData(
    async () => {
      const [transactions, accounts, documents, summary] = await Promise.all([
        fetchFinancialTransactions(500).catch(() => []),
        fetchFinancialAccounts().catch(() => []),
        fetchFinancialDocuments().catch(() => []),
        fetchFinancialSummary().catch(() => null),
      ]);
      return {
        transactions: Array.isArray(transactions) ? transactions : [],
        accounts: Array.isArray(accounts) ? accounts : [],
        documents: Array.isArray(documents) ? documents : [],
        summary,
      };
    },
    refreshToken,
    'Could not load your financial data.'
  );

  // Memoized on `data` so these identities are stable between renders —
  // otherwise every render produced fresh arrays and the useMemos below them
  // recomputed the filter and category list on each keystroke for nothing.
  const transactions = useMemo(() => data?.transactions || [], [data]);
  const accounts = useMemo(() => data?.accounts || [], [data]);
  const documents = useMemo(() => data?.documents || [], [data]);
  const summary = data?.summary;

  const categories = useMemo(() => {
    const set = new Set(transactions.map(t => t.category).filter(Boolean));
    return ['all', ...Array.from(set).sort()];
  }, [transactions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return transactions.filter(t => {
      if (category !== 'all' && t.category !== category) return false;
      if (!q) return true;
      return (
        (t.merchant || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.category || '').toLowerCase().includes(q)
      );
    });
  }, [transactions, query, category]);

  // Paginated rather than rendering every row: a long statement would
  // otherwise put hundreds of nodes on one page and make scrolling janky.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const resetPage = (fn) => (value) => { fn(value); setPage(0); };

  if (loading) {
    return (
      <div className="wn-page">
        <Skeleton variant="text" lines={2} />
        <Skeleton variant="block" height="110px" />
        <Skeleton variant="block" height="340px" />
      </div>
    );
  }

  return (
    <div className="wn-page">

      <header className="wn-head wn-enter">
        <div>
          <h1 className="wn-head-title">My Financial Data</h1>
          <p className="wn-head-sub">
            The accounts, transactions and statements behind every number in this app.
          </p>
        </div>
        <div className="wn-head-actions">
          <Button tier="secondary" onClick={refresh} disabled={refreshing} aria-label="Refresh financial data"><RefreshCw size={13} strokeWidth={2} style={{ marginRight: 6, flexShrink: 0 }} aria-hidden="true" />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {error && (
        <div className="wn-note wn-note-error" role="alert">
          <AlertCircle size={15} /><span>{error} Showing the last data loaded.</span>
        </div>
      )}

      <section className="wn-panel wn-enter wn-enter-1" aria-label="Data summary">
        <div className="wn-stats">
          <div className="wn-stat">
            <span className="wn-stat-label">Money in</span>
            <span className="wn-stat-value wn-pos">{formatINR(summary?.total_credits_inr)}</span>
            <span className="wn-stat-sub">all recorded credits</span>
          </div>
          <div className="wn-stat">
            <span className="wn-stat-label">Money out</span>
            <span className="wn-stat-value wn-neg">{formatINR(summary?.total_debits_inr)}</span>
            <span className="wn-stat-sub">all recorded debits</span>
          </div>
          <div className="wn-stat wn-stat-quiet">
            <span className="wn-stat-label">Transactions</span>
            <span className="wn-stat-value">{summary?.transactions ?? transactions.length}</span>
            <span className="wn-stat-sub">on record</span>
          </div>
          <div className="wn-stat wn-stat-quiet">
            <span className="wn-stat-label">Accounts</span>
            <span className="wn-stat-value">{accounts.length}</span>
            <span className="wn-stat-sub">linked</span>
          </div>
          <div className="wn-stat wn-stat-quiet">
            <span className="wn-stat-label">Statements</span>
            <span className="wn-stat-value">{documents.length}</span>
            <span className="wn-stat-sub">uploaded</span>
          </div>
        </div>
      </section>

      {accounts.length > 0 && (
        <section className="wn-panel wn-enter wn-enter-2" aria-label="Accounts">
          <h2 className="wn-section-title" style={{ marginBottom: 'var(--wn-s3)' }}>Accounts</h2>
          {accounts.map(a => (
            <div className="wn-action" key={a.account_id} style={{ gap: 'var(--wn-s1)' }}>
              <span className="wn-action-title">{a.name}</span>
              <span className="wn-action-why">
                {a.institution || 'Unknown institution'} · {a.account_type || 'bank'} · {a.currency || 'INR'}
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="wn-panel wn-panel-flush wn-enter wn-enter-3" aria-label="Transactions">
        <div style={{ padding: 'var(--wn-s5) var(--wn-s5) var(--wn-s4)' }}>
          <div className="wn-section-head">
            <h2 className="wn-section-title">Transactions</h2>
            <span className="wn-section-note">
              {filtered.length === transactions.length
                ? `${transactions.length} total`
                : `${filtered.length} of ${transactions.length}`}
            </span>
          </div>

          <div className="wn-head-actions" style={{ marginTop: 'var(--wn-s4)' }}>
            <div className="wn-search-wrap">
              <Search size={13} aria-hidden="true" />
              <label htmlFor="txn-search" className="sr-only">Search transactions</label>
              <input
                id="txn-search"
                className="wn-field wn-field-search"
                style={{ minWidth: '240px' }}
                value={query}
                onChange={e => resetPage(setQuery)(e.target.value)}
                placeholder="Search merchant or description"
              />
            </div>
            <label htmlFor="txn-category" className="sr-only">Filter by category</label>
            <select
              id="txn-category"
              className="wn-field"
              value={category}
              onChange={e => resetPage(setCategory)(e.target.value)}
            >
              {categories.map(c => (
                <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>
              ))}
            </select>
          </div>
        </div>

        {transactions.length === 0 ? (
          <div className="wn-empty">
            <Database size={30} className="wn-empty-icon" aria-hidden="true" />
            <p className="wn-empty-title">No transactions yet</p>
            <p className="wn-empty-body">
              Upload a statement from the Wealth AI tab, or load the sample profile with{' '}
              <code className="wn-code">python scripts/seed_wealth_demo.py</code>.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="wn-empty">
            <p className="wn-empty-title">Nothing matches that filter</p>
            <p className="wn-empty-body">Try a different search term or category.</p>
          </div>
        ) : (
          <>
            <div className="wn-table-wrap">
              <table className="wn-table">
                <caption className="sr-only">Your transactions, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Description</th>
                    <th scope="col">Category</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Amount</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(t => {
                    const credit = t.transaction_type === 'credit';
                    return (
                      <tr key={t.transaction_id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(t.transaction_date)}</td>
                        <td>
                          <span className="wn-table-desc">
                            <span className="wn-strong" style={{ color: 'var(--cc-text-primary)', fontWeight: 500 }}>
                              {t.merchant || t.description || '—'}
                            </span>
                            {t.merchant && t.description && (
                              <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--cc-text-tertiary)', marginTop: '2px' }}>
                                {t.description}
                              </span>
                            )}
                          </span>
                        </td>
                        <td>{t.category ? <span className="wn-tag">{t.category}</span> : '—'}</td>
                        <td className={`wn-num ${credit ? 'wn-pos' : 'wn-neg'}`} style={{ fontWeight: 600 }}>
                          {credit ? '+' : '−'}{formatINR(t.amount, { decimals: 2 })}
                        </td>
                        <td className="wn-num">
                          {t.balance_after == null ? '—' : formatINR(t.balance_after, { decimals: 2 })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {pageCount > 1 && (
              <div className="wn-pager">
                <span>
                  Showing {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
                </span>
                <div className="wn-head-actions">
                  <Button tier="secondary" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>
                    Previous
                  </Button>
                  <span style={{ alignSelf: 'center' }}>Page {safePage + 1} of {pageCount}</span>
                  <Button tier="secondary" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                          disabled={safePage >= pageCount - 1}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {documents.length > 0 && (
        <section className="wn-panel wn-enter wn-enter-3" aria-label="Statements">
          <h2 className="wn-section-title" style={{ marginBottom: 'var(--wn-s3)' }}>Statements</h2>
          {documents.map(d => (
            <div className="wn-action" key={d.document_id} style={{ gap: 'var(--wn-s1)' }}>
              <span className="wn-action-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--wn-s2)' }}>
                <FileText size={13} aria-hidden="true" />
                {d.filename}
              </span>
              <span className="wn-action-why">
                {formatDate(d.uploaded_at)} · {d.document_type?.replace(/_/g, ' ')} · {d.processing_status}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
