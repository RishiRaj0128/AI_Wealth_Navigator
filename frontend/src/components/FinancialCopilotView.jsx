import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { MessageCircle, Sparkles, AlertTriangle, Send, RefreshCw, CheckCircle2 } from 'lucide-react';
import { Button, Chip, Metric, Skeleton } from '../primitives';
import { askCopilot, fetchAIStatus } from '../api';
import { usePrefersReducedMotion } from '../hooks/useMotionGuards';

const SUGGESTED_QUESTIONS = [
  "How am I doing financially?",
  "How can I reach my car goal faster?",
  "What if I save ₹5,000 more every month?",
  "Where can I cut back on spending?",
  "Am I on track for my goals?"
];

const fmtINR = (n) =>
  n == null || Number.isNaN(Number(n))
    ? '—'
    : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const LOADING_PHASES = [
  "Analyzing your accounts and transactions…",
  "Checking your goals and spending patterns…",
  "Running projections with financial tools…",
  "Synthesizing structured advice…"
];

function AnswerLoading() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPhase(p => (p + 1) % LOADING_PHASES.length), 1800);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ padding: '20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--cc-accent)', fontSize: '13px', marginBottom: '16px', fontWeight: 600 }}>
        <RefreshCw size={15} style={{ animation: 'cc-spin 900ms linear infinite' }} />
        <span>{LOADING_PHASES[phase]}</span>
      </div>
      <Skeleton variant="text" lines={3} />
      <div style={{ marginTop: '16px' }}>
        <Skeleton variant="block" height="64px" />
      </div>
    </div>
  );
}

function AnswerBody({ report }) {
  if (!report) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
      {/* 1. Primary Direct Answer */}
      <div>
        {report.insufficient_evidence && (
          <Chip tone="medium" className="cc-mb-8">Partial data available</Chip>
        )}
        <p style={{ fontSize: '15.5px', lineHeight: '1.65', color: 'var(--cc-text-primary)', margin: 0, fontWeight: 500 }}>
          {report.answer}
        </p>
      </div>

      {/* 2. Financial Position Facts */}
      {report.financial_position && (
        (report.financial_position.current_balance != null || report.financial_position.monthly_savings != null) && (
          <div style={{ padding: '16px 18px', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--line-hair)', borderRadius: 'var(--r-md)' }}>
            <p className="cc-section-eyebrow" style={{ marginBottom: '12px' }}>Your Financial Position</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '16px' }}>
              {report.financial_position.current_balance != null && (
                <Metric label="Current Balance" value={fmtINR(report.financial_position.current_balance)} />
              )}
              {report.financial_position.monthly_income != null && (
                <Metric label="Monthly Income" value={fmtINR(report.financial_position.monthly_income)} tone="verified" />
              )}
              {report.financial_position.monthly_expenses != null && (
                <Metric label="Monthly Expenses" value={fmtINR(report.financial_position.monthly_expenses)} tone="medium" />
              )}
              {report.financial_position.monthly_savings != null && (
                <Metric label="Monthly Savings" value={fmtINR(report.financial_position.monthly_savings)} tone="accent" />
              )}
              {report.financial_position.savings_rate_pct != null && (
                <Metric label="Savings Rate" value={`${Number(report.financial_position.savings_rate_pct).toFixed(1)}%`} tone="verified" />
              )}
            </div>
          </div>
        )
      )}

      {/* 3. Goal Progress */}
      {report.goal_progress && report.goal_progress.goal_name && (
        <div style={{ padding: '16px 18px', background: 'rgba(76, 111, 255, 0.04)', border: '1px solid rgba(76, 111, 255, 0.2)', borderRadius: 'var(--r-md)' }}>
          <p className="cc-section-eyebrow" style={{ marginBottom: '10px', color: 'var(--cc-accent)' }}>
            Goal Target: {report.goal_progress.goal_name}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '14px' }}>
            <Metric label="Target Amount" value={fmtINR(report.goal_progress.target_amount)} />
            <Metric label="Current Saved" value={fmtINR(report.goal_progress.current_amount)} tone="verified" />
            <Metric label="Remaining Needed" value={fmtINR(report.goal_progress.remaining_needed)} tone="accent" />
            {report.goal_progress.target_date && (
              <Metric label="Target Date" value={report.goal_progress.target_date} />
            )}
          </div>
        </div>
      )}

      {/* 4. Scenario Impact */}
      {report.scenario_projection && (report.scenario_projection.monthly_extra_savings != null || report.scenario_projection.projected_balance != null) && (
        <div style={{ padding: '16px 18px', background: 'rgba(16, 185, 129, 0.04)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: 'var(--r-md)' }}>
          <p className="cc-section-eyebrow" style={{ marginBottom: '10px', color: '#10b981' }}>
            Scenario Projection
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '14px' }}>
            {report.scenario_projection.monthly_extra_savings != null && (
              <Metric label="Extra Monthly Saving" value={`+${fmtINR(report.scenario_projection.monthly_extra_savings)}`} tone="verified" />
            )}
            {report.scenario_projection.projected_balance != null && (
              <Metric label="Projected Balance" value={fmtINR(report.scenario_projection.projected_balance)} />
            )}
            {report.scenario_projection.months_saved != null && (
              <Metric label="Time Saved" value={`${report.scenario_projection.months_saved} months`} tone="accent" />
            )}
            {report.scenario_projection.projected_completion_date && (
              <Metric label="New Completion Date" value={report.scenario_projection.projected_completion_date} />
            )}
          </div>
        </div>
      )}

      {/* 5. Next Best Actions */}
      {report.next_best_actions?.length > 0 && (
        <div>
          <p className="cc-section-eyebrow" style={{ marginBottom: '12px' }}>Recommended Actions to Reach Goals Sooner</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {report.next_best_actions.map((act, i) => (
              <div
                key={i}
                style={{
                  padding: '12px 16px',
                  borderRadius: 'var(--r-sm)',
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--line-hair)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '12px'
                }}
              >
                <div>
                  <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--cc-text-primary)' }}>
                    {act.action}
                  </div>
                  {act.goal_impact && (
                    <div style={{ fontSize: '12px', color: 'var(--cc-accent)', marginTop: '2px' }}>
                      {act.goal_impact}
                    </div>
                  )}
                </div>

                {act.monthly_saving != null && (
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--state-verified)' }}>
                      +{fmtINR(act.monthly_saving)}/mo
                    </span>
                    {act.current_spend != null && (
                      <div style={{ fontSize: '11px', color: 'var(--cc-text-tertiary)' }}>
                        from {fmtINR(act.current_spend)} spend
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 6. Assumptions */}
      {report.assumptions?.length > 0 && (
        <div style={{
          padding: '14px 16px',
          borderRadius: 'var(--r-sm)',
          background: 'rgba(59, 130, 246, 0.04)',
          border: '1px solid rgba(59, 130, 246, 0.15)'
        }}>
          <p className="cc-section-eyebrow" style={{ marginBottom: '8px', color: '#93c5fd' }}>
            Calculation Assumptions
          </p>
          <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {report.assumptions.map((a, i) => (
              <li key={i} style={{ fontSize: '12px', color: 'var(--cc-text-tertiary)', lineHeight: 1.55 }}>
                {a}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function FinancialCopilotView({ aiStatus, refreshToken = 0 }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [query, setQuery] = useState('');
  const [asking, setAsking] = useState(false);
  const [conversation, setConversation] = useState([]);
  const queryInputRef = useRef(null);
  const conversationEndRef = useRef(null);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation.length, conversation[conversation.length - 1]?.status]);

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
        : t
      ));
    } catch (e) {
      setConversation(prev => prev.map(t => t.id === turnId
        ? { ...t, status: 'error', error: e.message }
        : t
      ));
    } finally {
      setAsking(false);
    }
  };

  const isConfigured = aiStatus?.configured === true;

  return (
    <div className="cc-page" style={{ maxWidth: '1000px', margin: '0 auto' }}>
      {/* 1. Header */}
      <div className="wn-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{ display: 'inline-flex', padding: '4px', borderRadius: '6px', background: 'rgba(76, 111, 255, 0.12)', color: 'var(--cc-accent)' }}>
              <Sparkles size={18} strokeWidth={2} />
            </span>
            <h1 className="wn-head-title" style={{ margin: 0 }}>Wealth AI</h1>
            <Chip tone={isConfigured ? 'verified' : 'medium'}>
              {isConfigured ? 'AI Ready' : 'Key Needed'}
            </Chip>
          </div>
          <p className="wn-head-sub">
            Ask anything about your financial plan, goals, or what-if scenarios. Every response is grounded in your deterministic accounts and transactions.
          </p>
        </div>
      </div>

      {!isConfigured && (
        <div className="wn-note wn-note-warn" role="status">
          <AlertTriangle size={15} />
          <span>
            The AI assistant is currently unavailable — no valid API key is configured. Your deterministic position, goals, scenarios and recommendations on other pages remain fully functional.
          </span>
        </div>
      )}

      {/* 2. Suggested Questions (shown when conversation is empty) */}
      {conversation.length === 0 && (
        <div style={{ padding: '8px 0 24px' }}>
          <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--cc-text-tertiary)', fontWeight: 600 }}>
            Suggested Questions:
          </p>
          <div className="cc-suggestion-list">
            {SUGGESTED_QUESTIONS.map(q => (
              <button
                key={q}
                onClick={() => handleAsk(q)}
                disabled={asking}
                className="cc-suggestion-item"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 3. Conversation Stream */}
      {conversation.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '28px', marginBottom: '32px' }}>
          {conversation.map(turn => (
            <div key={turn.id} style={{ padding: '20px', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--line-hair)', borderRadius: 'var(--r-md)' }}>
              {/* Question Header */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '14px', borderBottom: '1px solid var(--line-hair)', paddingBottom: '10px' }}>
                <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--cc-accent)', fontWeight: 700 }}>
                  You asked:
                </span>
                <span style={{ fontSize: '14.5px', color: 'var(--cc-text-primary)', fontWeight: 600 }}>
                  {turn.question}
                </span>
              </div>

              {/* Answer Content */}
              <div>
                {turn.status === 'loading' && <AnswerLoading />}
                {turn.status === 'error' && (
                  <div className="wn-note wn-note-error" role="alert">
                    <AlertTriangle size={15} />
                    <span>{turn.error}</span>
                  </div>
                )}
                {turn.status === 'done' && turn.report && (
                  <motion.div
                    initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <AnswerBody report={turn.report} />
                  </motion.div>
                )}
              </div>
            </div>
          ))}
          <div ref={conversationEndRef} />
        </div>
      )}

      {/* 4. Query Input Box */}
      <div style={{ position: 'sticky', bottom: '20px', background: 'rgba(15, 23, 42, 0.95)', backdropFilter: 'blur(12px)', padding: '12px', borderRadius: 'var(--r-md)', border: '1px solid var(--line-solid)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', zIndex: 10 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAsk();
          }}
          style={{ display: 'flex', gap: '10px', alignItems: 'center' }}
        >
          <input
            ref={queryInputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Ask anything about your savings, goals, or budget…"
            disabled={asking}
            style={{
              flex: 1,
              padding: '12px 16px',
              borderRadius: 'var(--r-sm)',
              background: 'var(--ink-raised)',
              border: '1px solid var(--line-solid)',
              color: 'var(--cc-text-primary)',
              fontSize: '14px',
              outline: 'none',
            }}
          />
          <Button tier="primary" onClick={() => handleAsk()} disabled={!query.trim() || asking} state={asking ? 'loading' : 'idle'}>
            <Send size={14} style={{ marginRight: 6 }} />
            Ask AI
          </Button>
        </form>

        {conversation.length > 0 && (
          <div className="cc-suggestion-list" style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--line-hair)' }}>
            {SUGGESTED_QUESTIONS.slice(0, 3).map(q => (
              <button
                key={q}
                onClick={() => handleAsk(q)}
                disabled={asking}
                className="cc-suggestion-item"
                style={{ fontSize: '11.5px', padding: '4px 10px' }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
