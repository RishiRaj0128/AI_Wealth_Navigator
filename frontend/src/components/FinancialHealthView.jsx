import React from 'react';
import {
  Wallet, ArrowRight, RefreshCw, AlertCircle, ChevronDown, Sparkles, Target
} from 'lucide-react';
import { Button, Skeleton } from '../primitives';
import { useRefreshableData, formatINR, formatDate } from '../hooks/useRefreshableData';
import {
  fetchFinancialPosition,
  fetchFinancialGoals,
  fetchGoalRecommendations
} from '../api';

// Overview answers exactly three questions, in this order:
//   1. Where do I stand?      -> the summary figures + cashflow bar
//   2. Are my goals on track? -> goals at a glance
//   3. What should I do next? -> the top actions
// Anything that does not serve one of those three lives on another page.
//
// Every figure here is rendered exactly as the backend returned it. There is
// no arithmetic in this file, so the dashboard cannot drift from the scenario
// engine or from what the AI is told.

const STATUS_META = {
  ahead:       { cls: 'wn-badge-good',    label: 'Ahead',       fill: '' },
  on_track:    { cls: 'wn-badge-good',    label: 'On track',    fill: '' },
  behind:      { cls: 'wn-badge-warn',    label: 'Behind',      fill: 'is-behind' },
  overdue:     { cls: 'wn-badge-bad',     label: 'Overdue',     fill: 'is-late' },
  at_risk:     { cls: 'wn-badge-warn',    label: 'At risk',     fill: 'is-behind' },
  completed:   { cls: 'wn-badge-good',    label: 'Completed',   fill: '' },
  no_deadline: { cls: 'wn-badge-neutral', label: 'No deadline', fill: '' },
  paused:      { cls: 'wn-badge-neutral', label: 'Paused',      fill: '' },
  cancelled:   { cls: 'wn-badge-neutral', label: 'Cancelled',   fill: '' },
};

const statusOf = (s) => STATUS_META[s] || STATUS_META.no_deadline;

function GoalGlance({ goal }) {
  const meta = statusOf(goal.derived_status);
  const pct = Math.min(100, Math.max(0, goal.progress_percent ?? 0));

  return (
    <div className="wn-goal">
      <div className="wn-goal-top">
        <span className="wn-goal-name">
          {goal.goal_name}
          <span className={`wn-badge ${meta.cls}`}>{meta.label}</span>
        </span>
        <span className="wn-goal-amount">
          {formatINR(goal.current_amount)} of {formatINR(goal.target_amount)}
        </span>
      </div>

      <div className="wn-progress">
        <div className="wn-progress-track">
          <div className={`wn-progress-fill ${meta.fill}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="wn-progress-pct">{pct.toFixed(0)}%</span>
      </div>

      <div className="wn-goal-meta">
        {goal.target_date && <span>Target <strong>{formatDate(goal.target_date)}</strong></span>}
        {goal.required_monthly_saving != null && (
          <span>Needs <strong>{formatINR(goal.required_monthly_saving)}/mo</strong></span>
        )}
      </div>
    </div>
  );
}

export default function FinancialHealthView({ onNavigate, refreshToken }) {
  const { data, loading, refreshing, error, refresh } = useRefreshableData(
    async () => {
      const [position, goals] = await Promise.all([
        fetchFinancialPosition(),
        fetchFinancialGoals(null, 'all').catch(() => ({ goals: [] })),
      ]);

      // Actions are shown for the goal that most needs attention — one that is
      // behind or overdue, else the first active goal.
      const list = (goals.goals || []).filter(g => g.status !== 'cancelled');
      const focus =
        list.find(g => g.derived_status === 'behind' || g.derived_status === 'overdue') ||
        list.find(g => g.derived_status !== 'completed') ||
        list[0];

      let actions = null;
      if (focus) {
        const recs = await fetchGoalRecommendations(focus.goal_id).catch(() => null);
        if (recs) actions = { ...recs, focusGoal: focus };
      }
      return { position, goals, actions };
    },
    refreshToken,
    'Could not load your financial position.'
  );

  if (loading) {
    return (
      <div className="wn-page">
        <Skeleton variant="text" lines={2} />
        <Skeleton variant="block" height="150px" />
        <Skeleton variant="block" height="260px" />
      </div>
    );
  }

  const position = data?.position;
  const goals = (data?.goals?.goals || []).filter(g => g.status !== 'cancelled');
  const goalsMeta = data?.goals;
  const actions = data?.actions;
  const hasData = position?.has_data;

  // The cashflow bar is drawn as a proportion of income, so spending and
  // saving are visibly two parts of one whole rather than two unrelated KPIs.
  const income = position?.monthly_income || 0;
  const spendPct = income > 0 ? Math.min(100, (position.monthly_expenses / income) * 100) : 0;
  const savePct = income > 0 ? Math.max(0, 100 - spendPct) : 0;

  const topGoals = goals.filter(g => g.derived_status !== 'completed').slice(0, 3);

  return (
    <div className="wn-page">

      <header className="wn-head wn-enter">
        <div>
          <h1 className="wn-head-title">Financial Health</h1>
          <p className="wn-head-sub">
            Your current position and progress toward your goals.
          </p>
        </div>
        <div className="wn-head-actions">
          <Button
            tier="secondary"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh financial data"
          ><RefreshCw size={13} strokeWidth={2} style={{ marginRight: 6, flexShrink: 0 }} aria-hidden="true" />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {error && (
        <div className="wn-note wn-note-error" role="alert">
          <AlertCircle size={15} />
          <span>{error} Showing the last figures loaded.</span>
        </div>
      )}

      {!hasData && !error && (
        <section className="wn-panel wn-enter wn-enter-1">
          <div className="wn-empty">
            <Wallet size={34} className="wn-empty-icon" aria-hidden="true" />
            <p className="wn-empty-title">No transactions yet</p>
            <p className="wn-empty-body">
              Upload a bank statement to get started, or load the sample profile by running{' '}
              <code className="wn-code">python scripts/seed_wealth_demo.py</code> from the project root.
            </p>
            <Button tier="primary" onClick={() => onNavigate?.('copilot')}>
              Upload a statement
            </Button>
          </div>
        </section>
      )}

      {hasData && (
        <>
          {/* 1. WHERE DO I STAND -------------------------------------- */}
          <section className="wn-panel wn-enter wn-enter-1" aria-label="Your position">
            <div className="wn-stats">
              <div className="wn-stat wn-stat-lead">
                <span className="wn-stat-label">Current balance</span>
                <span className="wn-stat-value">{formatINR(position.current_balance)}</span>
                <span className="wn-stat-sub">
                  {position.balance_as_of ? `as of ${formatDate(position.balance_as_of)}` : 'estimated from history'}
                </span>
              </div>
              <div className="wn-stat">
                <span className="wn-stat-label">Monthly income</span>
                <span className="wn-stat-value wn-pos">{formatINR(position.monthly_income)}</span>
                <span className="wn-stat-sub">average</span>
              </div>
              <div className="wn-stat">
                <span className="wn-stat-label">Monthly spending</span>
                <span className="wn-stat-value wn-neg">{formatINR(position.monthly_expenses)}</span>
                <span className="wn-stat-sub">average</span>
              </div>
              <div className="wn-stat">
                <span className="wn-stat-label">Monthly savings</span>
                <span className={`wn-stat-value ${position.monthly_savings >= 0 ? 'wn-pos' : 'wn-neg'}`}>
                  {formatINR(position.monthly_savings)}
                </span>
                <span className="wn-stat-sub">income less spending</span>
              </div>
              {/* Savings rate is context, not a fifth headline — hence quiet. */}
              <div className="wn-stat wn-stat-quiet">
                <span className="wn-stat-label">Savings rate</span>
                <span className="wn-stat-value">
                  {position.savings_rate_pct == null ? '—' : `${position.savings_rate_pct}%`}
                </span>
                <span className="wn-stat-sub">of income</span>
              </div>
            </div>

            {/* A single bar makes the relationship obvious: what comes in is
                split between what goes out and what stays. */}
            {income > 0 && (
              <div className="wn-flow" style={{ marginTop: 'var(--wn-s5)' }}>
                <div
                  className="wn-flow-track"
                  role="img"
                  aria-label={`Of ${formatINR(income)} monthly income, ${formatINR(position.monthly_expenses)} is spent and ${formatINR(position.monthly_savings)} is saved.`}
                >
                  <div className="wn-flow-seg wn-flow-seg-spend" style={{ width: `${spendPct}%` }} />
                  <div className="wn-flow-seg wn-flow-seg-save" style={{ width: `${savePct}%` }} />
                </div>
                <div className="wn-flow-legend">
                  <span className="wn-flow-key">
                    <span className="wn-flow-dot" style={{ background: 'var(--sev-critical)', opacity: 0.72 }} />
                    Spent {formatINR(position.monthly_expenses)}
                  </span>
                  <span className="wn-flow-key">
                    <span className="wn-flow-dot" style={{ background: 'var(--state-verified)' }} />
                    Saved {formatINR(position.monthly_savings)}
                  </span>
                  <span className="wn-flow-key">of {formatINR(income)} income</span>
                </div>
              </div>
            )}

            <details className="wn-disclose">
              <summary>
                How this is calculated
                <ChevronDown size={13} className="wn-chev" aria-hidden="true" />
              </summary>
              <div className="wn-disclose-body">
                <p className="wn-assume">
                  <span className="wn-prov wn-prov-fact">Fact</span>
                  {position.assumptions?.[0]}
                </p>
                <p className="wn-assume">
                  <span className="wn-prov wn-prov-calc">Calculation</span>
                  {position.basis} Monthly savings is average income minus average spending.
                </p>
                {position.assumptions?.slice(2).map((a, i) => (
                  <p className="wn-assume" key={i}>{a}</p>
                ))}
              </div>
            </details>
          </section>

          <div className="wn-grid-2">
            {/* 2. ARE MY GOALS ON TRACK ------------------------------- */}
            <section className="wn-panel wn-enter wn-enter-2" aria-label="Goals">
              <div className="wn-section-head" style={{ marginBottom: 'var(--wn-s2)' }}>
                <h2 className="wn-section-title">Goals at a glance</h2>
                {goals.length > 0 && (
                  <button className="wn-link" onClick={() => onNavigate?.('goals')}>
                    View all goals <ArrowRight size={12} aria-hidden="true" />
                  </button>
                )}
              </div>

              {topGoals.length === 0 ? (
                <div className="wn-empty" style={{ padding: 'var(--wn-s5) 0' }}>
                  <p className="wn-empty-body" style={{ marginBottom: 'var(--wn-s4)' }}>
                    No goals yet. Set one to see whether you are on track and how to get there sooner.
                  </p>
                  <Button tier="primary" onClick={() => onNavigate?.('goals')}>
                    Create a goal
                  </Button>
                </div>
              ) : (
                <>
                  {topGoals.map(g => <GoalGlance key={g.goal_id} goal={g} />)}
                  {goalsMeta?.total_required_monthly_saving != null && (
                    <p className="wn-section-note" style={{ marginTop: 'var(--wn-s3)', lineHeight: 1.55 }}>
                      Funding every goal at once needs{' '}
                      <strong style={{ color: 'var(--cc-text-secondary)' }}>
                        {formatINR(goalsMeta.total_required_monthly_saving)}/mo
                      </strong>{' '}
                      against your {formatINR(goalsMeta.monthly_savings_basis)}/mo capacity
                      {goalsMeta.all_goals_affordable
                        ? ' — all affordable together.'
                        : ` — ${formatINR(goalsMeta.combined_monthly_shortfall)}/mo short.`}
                    </p>
                  )}
                </>
              )}
            </section>

            {/* 3. WHAT SHOULD I DO NEXT ------------------------------- */}
            <section className="wn-panel wn-enter wn-enter-3" aria-label="Recommended actions">
              <div className="wn-section-head" style={{ marginBottom: 'var(--wn-s2)' }}>
                <h2 className="wn-section-title">What to do next</h2>
                {actions?.focusGoal && (
                  <span className="wn-section-note">for {actions.focusGoal.goal_name}</span>
                )}
              </div>

              {actions?.recommendations?.length > 0 ? (
                <>
                  {actions.recommendations.slice(0, 3).map((a, i) => (
                    <div className="wn-action" key={i}>
                      <span className="wn-action-title">{a.action}</span>
                      <span className="wn-action-why">{a.why}</span>
                      <div className="wn-action-impact">
                        {a.monthly_saving > 0 && (
                          <span>Saves <strong className="wn-pos">{formatINR(a.monthly_saving)}</strong>/mo</span>
                        )}
                        {a.goal_impact?.months_saved_label && (
                          <span>Goal {a.goal_impact.months_saved_label}</span>
                        )}
                      </div>
                      <button className="wn-link" onClick={() => onNavigate?.('goals')}>
                        Explore this scenario <ArrowRight size={12} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                  <p className="wn-section-note" style={{ marginTop: 'var(--wn-s3)' }}>
                    A planning model based on your own data — not regulated financial advice.
                  </p>
                </>
              ) : (
                <p className="wn-action-why" style={{ padding: 'var(--wn-s5) 0' }}>
                  {goals.length === 0
                    ? 'Create a goal to get personalised suggestions.'
                    : 'No spending increases were detected last month, so there is nothing to trim right now.'}
                </p>
              )}
            </section>
          </div>

          {/* Hand the user into the next step of the journey. */}
          <section className="wn-panel wn-panel-tight wn-enter wn-enter-3">
            <div className="wn-head-actions">
              <span className="wn-section-note" style={{ marginRight: 'var(--wn-s2)' }}>Next</span>
              <Button tier="secondary" onClick={() => onNavigate?.('goals')}><Target size={13} strokeWidth={2} style={{ marginRight: 6, flexShrink: 0 }} aria-hidden="true" />
                Explore scenarios
              </Button>
              <Button tier="secondary" onClick={() => onNavigate?.('copilot')}><Sparkles size={13} strokeWidth={2} style={{ marginRight: 6, flexShrink: 0 }} aria-hidden="true" />
                Ask Wealth AI
              </Button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
