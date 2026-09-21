import React, { useEffect, useMemo, useState } from 'react';
import {
  Target, Plus, RefreshCw, AlertCircle, ChevronDown, ArrowRight,
  Sparkles, X, Check
} from 'lucide-react';
import { Button, Skeleton } from '../primitives';
import { useRefreshableData, formatINR, formatDate } from '../hooks/useRefreshableData';
import {
  fetchFinancialGoals,
  createFinancialGoal,
  updateFinancialGoal,
  simulateGoalScenario,
  fetchGoalRecommendations,
  fetchFinancialAccounts
} from '../api';

// Goals uses progressive disclosure: the list carries only what is needed to
// choose a goal (name, progress, date, status). Everything else — required
// monthly saving, projected completion, the what-if simulator and the
// recommended actions — appears once a goal is selected. Putting all of it in
// the list is what made this page unreadable in the first viewport.

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

const PRESETS = [0, 2000, 5000, 10000, 15000];

function CreateGoalDialog({ accounts, onClose, onCreated }) {
  const [form, setForm] = useState({
    goal_name: '', target_amount: '', target_date: '', risk_preference: 'moderate'
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.goal_name.trim() || !form.target_amount) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await createFinancialGoal({
        account_id: accounts[0]?.account_id || null,
        goal_name: form.goal_name.trim(),
        target_amount: parseFloat(form.target_amount),
        target_date: form.target_date || null,
        risk_preference: form.risk_preference,
      });
      onCreated(created?.goal?.goal_id);
    } catch (e2) {
      setErr(e2.message || 'Could not create this goal.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create a goal"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 300, display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 'var(--wn-s4)',
        background: 'rgba(6, 8, 9, 0.72)', backdropFilter: 'blur(3px)'
      }}
    >
      <form
        onSubmit={submit}
        onClick={e => e.stopPropagation()}
        className="wn-panel"
        style={{ width: '100%', maxWidth: '420px', display: 'flex', flexDirection: 'column', gap: 'var(--wn-s4)' }}
      >
        <div className="wn-section-head">
          <h2 className="wn-section-title">New goal</h2>
          <button type="button" className="wn-link" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--wn-s2)' }}>
          <span className="wn-stat-label">Goal name</span>
          <input
            className="wn-field" required autoFocus
            value={form.goal_name}
            onChange={e => setForm({ ...form, goal_name: e.target.value })}
            placeholder="Emergency fund"
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--wn-s2)' }}>
          <span className="wn-stat-label">Target amount (₹)</span>
          <input
            className="wn-field" type="number" min="1" required
            value={form.target_amount}
            onChange={e => setForm({ ...form, target_amount: e.target.value })}
            placeholder="200000"
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--wn-s2)' }}>
          <span className="wn-stat-label">Target date</span>
          <input
            className="wn-field" type="date"
            value={form.target_date}
            onChange={e => setForm({ ...form, target_date: e.target.value })}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--wn-s2)' }}>
          <span className="wn-stat-label">Approach</span>
          <select
            className="wn-field"
            value={form.risk_preference}
            onChange={e => setForm({ ...form, risk_preference: e.target.value })}
          >
            <option value="conservative">Conservative — protect a cash buffer first</option>
            <option value="moderate">Moderate — balanced saving</option>
            <option value="aggressive">Aggressive — reach goals sooner</option>
          </select>
        </label>

        {err && (
          <div className="wn-note wn-note-error" role="alert">
            <AlertCircle size={15} /><span>{err}</span>
          </div>
        )}

        <div className="wn-head-actions" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" tier="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" tier="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create goal'}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function GoalsView({ onNavigate, refreshToken }) {
  const [selectedId, setSelectedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');

  const [extra, setExtra] = useState(5000);
  const [months, setMonths] = useState(12);
  const [sim, setSim] = useState(null);
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState(null);

  const [actions, setActions] = useState(null);
  const [actionsLoading, setActionsLoading] = useState(false);

  const { data, loading, refreshing, error, refresh } = useRefreshableData(
    async () => {
      const [goals, accounts] = await Promise.all([
        fetchFinancialGoals(null, 'all'),
        fetchFinancialAccounts().catch(() => []),
      ]);
      return { goals, accounts: accounts || [] };
    },
    refreshToken,
    'Could not load your goals.'
  );

  // Stable identity between renders: the selection-guard effect below depends
  // on this list, and a fresh array each render would re-run it every time.
  // Cancelled goals are deliberately excluded: the user has abandoned them,
  // so they should not occupy the list or affect the affordability summary.
  const goals = useMemo(
    () => (data?.goals?.goals || []).filter(g => g.status !== 'cancelled'),
    [data]
  );
  const goalsMeta = data?.goals;
  const selected = goals.find(g => g.goal_id === selectedId) || goals[0] || null;

  // Keep a valid selection as the list changes (create, refresh, reseed).
  useEffect(() => {
    if (goals.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !goals.some(g => g.goal_id === selectedId)) {
      setSelectedId(goals[0].goal_id);
    }
  }, [goals, selectedId]);

  // Re-run the scenario whenever the goal or the inputs change. Debounced so
  // dragging the slider does not fire a request per pixel.
  useEffect(() => {
    if (!selected?.goal_id) { setSim(null); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      setSimulating(true);
      setSimError(null);
      try {
        const res = await simulateGoalScenario(selected.goal_id, extra, months);
        if (alive) setSim(res);
      } catch (err) {
        console.error('Scenario simulation failed:', err);
        if (alive) setSimError('Could not run this scenario.');
      } finally {
        if (alive) setSimulating(false);
      }
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [selected?.goal_id, extra, months, refreshToken]);

  // Actions follow the selected goal so its risk preference is applied.
  useEffect(() => {
    if (!selected?.goal_id) { setActions(null); return; }
    let alive = true;
    setActionsLoading(true);
    fetchGoalRecommendations(selected.goal_id)
      .then(r => { if (alive) setActions(r); })
      .catch(() => { if (alive) setActions(null); })
      .finally(() => { if (alive) setActionsLoading(false); });
    return () => { alive = false; };
  }, [selected?.goal_id, refreshToken]);

  const saveProgress = async (goalId) => {
    if (editValue === '' || Number.isNaN(Number(editValue))) return;
    try {
      await updateFinancialGoal(goalId, { current_amount: parseFloat(editValue) });
      setEditingId(null);
      setEditValue('');
      refresh();
    } catch (err) {
      setSimError(err.message || 'Could not update this goal.');
    }
  };

  if (loading) {
    return (
      <div className="wn-page">
        <Skeleton variant="text" lines={2} />
        <Skeleton variant="block" height="420px" />
      </div>
    );
  }

  const gp = sim?.goal_projection;
  const meta = selected ? statusOf(selected.derived_status) : null;

  return (
    <div className="wn-page">

      <header className="wn-head wn-enter">
        <div>
          <h1 className="wn-head-title">Goals</h1>
          <p className="wn-head-sub">
            Track what you are saving for, and see what changes if you save more.
          </p>
        </div>
        <div className="wn-head-actions">
          <Button tier="secondary" onClick={() => onNavigate?.('copilot')}><Sparkles size={13} strokeWidth={2} style={{ marginRight: 6, flexShrink: 0 }} aria-hidden="true" />
            Ask Wealth AI
          </Button>
          <Button tier="secondary" onClick={refresh} disabled={refreshing} aria-label="Refresh goals"><RefreshCw size={13} strokeWidth={2} style={{ marginRight: 6, flexShrink: 0 }} aria-hidden="true" />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button tier="primary" onClick={() => setShowCreate(true)}><Plus size={13} strokeWidth={2} style={{ marginRight: 6, flexShrink: 0 }} aria-hidden="true" />
            New goal
          </Button>
        </div>
      </header>

      {error && (
        <div className="wn-note wn-note-error" role="alert">
          <AlertCircle size={15} /><span>{error} Showing the last goals loaded.</span>
        </div>
      )}

      {goals.length === 0 && (
        <section className="wn-panel wn-enter wn-enter-1">
          <div className="wn-empty">
            <Target size={34} className="wn-empty-icon" aria-hidden="true" />
            <p className="wn-empty-title">No goals yet</p>
            <p className="wn-empty-body">
              Add what you are saving for — an emergency fund, a car, a trip — and we will show
              whether you are on track and what happens if you save more each month.
            </p>
            <Button tier="primary" onClick={() => setShowCreate(true)}><Plus size={13} strokeWidth={2} style={{ marginRight: 6, flexShrink: 0 }} aria-hidden="true" />
              Create your first goal
            </Button>
          </div>
        </section>
      )}

      {goals.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)',
            gap: 'var(--wn-s5)',
            alignItems: 'start'
          }}
          className="wn-goals-layout"
        >
          {/* ---- Goal list: only what you need to choose one ---- */}
          <section className="wn-section wn-enter wn-enter-1" aria-label="Your goals">
            <div className="wn-section-head">
              <h2 className="wn-section-title">Your goals</h2>
              <span className="wn-section-note">{goals.length}</span>
            </div>

            {goals.map(goal => {
              const m = statusOf(goal.derived_status);
              const pct = Math.min(100, Math.max(0, goal.progress_percent ?? 0));
              const isSel = goal.goal_id === selected?.goal_id;
              return (
                <button
                  key={goal.goal_id}
                  className="wn-goal-pick"
                  aria-current={isSel ? 'true' : 'false'}
                  onClick={() => setSelectedId(goal.goal_id)}
                >
                  <span className="wn-goal-top">
                    <span className="wn-goal-name">
                      {goal.goal_name}
                      <span className={`wn-badge ${m.cls}`}>{m.label}</span>
                    </span>
                  </span>
                  <span className="wn-progress">
                    <span className="wn-progress-track">
                      <span className={`wn-progress-fill ${m.fill}`} style={{ width: `${pct}%` }} />
                    </span>
                    <span className="wn-progress-pct">{pct.toFixed(0)}%</span>
                  </span>
                  <span className="wn-goal-meta">
                    <span>{formatINR(goal.current_amount)} of {formatINR(goal.target_amount)}</span>
                    {goal.target_date && <span>by {formatDate(goal.target_date)}</span>}
                  </span>
                </button>
              );
            })}

            {goalsMeta?.total_required_monthly_saving != null && (
              <p className="wn-section-note" style={{ lineHeight: 1.55 }}>
                All goals together need {formatINR(goalsMeta.total_required_monthly_saving)}/mo
                against {formatINR(goalsMeta.monthly_savings_basis)}/mo available
                {goalsMeta.all_goals_affordable ? '.' : ` — ${formatINR(goalsMeta.combined_monthly_shortfall)}/mo short.`}
              </p>
            )}
          </section>

          {/* ---- Goal detail ---- */}
          {selected && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--wn-s5)', minWidth: 0 }}>

              <section className="wn-panel wn-enter wn-enter-2" aria-label={`${selected.goal_name} detail`}>
                <div className="wn-section-head">
                  <h2 className="wn-section-title" style={{ fontSize: '17px' }}>
                    {selected.goal_name}
                  </h2>
                  <span className={`wn-badge ${meta.cls}`}>{meta.label}</span>
                </div>

                <p className="wn-action-why" style={{ margin: 'var(--wn-s2) 0 var(--wn-s4)' }}>
                  {selected.status_reason}
                </p>

                <div className="wn-progress" style={{ marginBottom: 'var(--wn-s4)' }}>
                  <div className="wn-progress-track" style={{ height: '8px' }}>
                    <div className={`wn-progress-fill ${meta.fill}`}
                         style={{ width: `${Math.min(100, Math.max(0, selected.progress_percent ?? 0))}%` }} />
                  </div>
                  <span className="wn-progress-pct">{(selected.progress_percent ?? 0).toFixed(0)}%</span>
                </div>

                <div className="wn-stats">
                  <div className="wn-stat">
                    <span className="wn-stat-label">Saved so far</span>
                    <span className="wn-stat-value">{formatINR(selected.current_amount)}</span>
                    <span className="wn-stat-sub">of {formatINR(selected.target_amount)}</span>
                  </div>
                  <div className="wn-stat">
                    <span className="wn-stat-label">Still to go</span>
                    <span className="wn-stat-value">{formatINR(selected.amount_remaining)}</span>
                    {selected.target_date && (
                      <span className="wn-stat-sub">by {formatDate(selected.target_date)}</span>
                    )}
                  </div>
                  <div className="wn-stat">
                    <span className="wn-stat-label">Needs per month</span>
                    <span className="wn-stat-value">
                      {selected.required_monthly_saving == null ? '—' : formatINR(selected.required_monthly_saving)}
                    </span>
                    <span className="wn-stat-sub">
                      you save {formatINR(selected.monthly_savings_basis)}/mo
                    </span>
                  </div>
                  <div className="wn-stat wn-stat-quiet">
                    <span className="wn-stat-label">Expected completion</span>
                    <span className="wn-stat-value">
                      {selected.projected_completion_date ? formatDate(selected.projected_completion_date) : '—'}
                    </span>
                    <span className="wn-stat-sub">at your current rate</span>
                  </div>
                </div>

                <div className="wn-head-actions" style={{ marginTop: 'var(--wn-s4)' }}>
                  {editingId === selected.goal_id ? (
                    <>
                      <label className="wn-stat-label" htmlFor="goal-progress-input">Amount saved</label>
                      <input
                        id="goal-progress-input"
                        className="wn-field" type="number" min="0" autoFocus
                        style={{ width: '140px' }}
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                      />
                      <Button tier="primary" onClick={() => saveProgress(selected.goal_id)}><Check size={13} strokeWidth={2} style={{ marginRight: 6, flexShrink: 0 }} aria-hidden="true" />
                        Save
                      </Button>
                      <Button tier="secondary" onClick={() => setEditingId(null)}>Cancel</Button>
                    </>
                  ) : (
                    <button
                      className="wn-link"
                      onClick={() => { setEditingId(selected.goal_id); setEditValue(String(selected.current_amount ?? 0)); }}
                    >
                      Update amount saved
                    </button>
                  )}
                </div>
              </section>

              {/* ---- What-if ---- */}
              <section className="wn-panel wn-enter wn-enter-3" aria-label="What-if scenario">
                <div className="wn-section-head">
                  <h2 className="wn-section-title">What if you saved more?</h2>
                  {simulating && <span className="wn-section-note">updating…</span>}
                </div>

                <div style={{ marginTop: 'var(--wn-s4)' }}>
                  <div className="wn-section-head" style={{ marginBottom: 'var(--wn-s3)' }}>
                    <span className="wn-stat-label">Extra saving each month</span>
                    <span className="wn-goal-amount" style={{ color: 'var(--state-verified)', fontWeight: 600 }}>
                      {extra === 0 ? 'No change' : `+${formatINR(extra)}`}
                    </span>
                  </div>

                  <div className="wn-presets" role="group" aria-label="Extra monthly saving">
                    {PRESETS.map(amt => (
                      <button
                        key={amt}
                        className="wn-preset"
                        aria-pressed={extra === amt}
                        onClick={() => setExtra(amt)}
                      >
                        {amt === 0 ? 'No change' : `+${formatINR(amt)}`}
                      </button>
                    ))}
                  </div>

                  <input
                    className="wn-range"
                    type="range" min="0" max="50000" step="500"
                    value={extra}
                    onChange={e => setExtra(Number(e.target.value))}
                    aria-label="Extra monthly saving amount"
                    style={{ marginTop: 'var(--wn-s4)' }}
                  />
                  <div className="wn-range-scale">
                    <span>₹0</span><span>₹25,000</span><span>₹50,000</span>
                  </div>
                </div>

                {simError && (
                  <div className="wn-note wn-note-error" role="alert" style={{ marginTop: 'var(--wn-s4)' }}>
                    <AlertCircle size={15} /><span>{simError}</span>
                  </div>
                )}

                {gp && (
                  <>
                    <div className="wn-compare" style={{ marginTop: 'var(--wn-s5)' }}>
                      <div className="wn-compare-side">
                        <span className="wn-compare-label">Current plan</span>
                        <span className="wn-compare-value">{formatINR(sim.current_monthly_savings)}/mo</span>
                        <span className="wn-compare-note">
                          Goal reached {formatDate(gp.baseline_projected_date)}
                        </span>
                      </div>
                      <div className="wn-compare-arrow" aria-hidden="true">
                        <ArrowRight size={18} />
                      </div>
                      <div className="wn-compare-side is-scenario">
                        <span className="wn-compare-label">Your scenario</span>
                        <span className="wn-compare-value">{formatINR(sim.new_monthly_savings)}/mo</span>
                        <span className="wn-compare-note">
                          Goal reached {formatDate(gp.new_projected_date)}
                        </span>
                      </div>
                    </div>

                    <div className="wn-result">
                      <span className="wn-result-label">Result</span>
                      <p className="wn-result-text">
                        {extra > 0
                          ? `You could reach ${selected.goal_name} ${gp.months_saved_label}.`
                          : 'This is your current plan, with no extra saving applied.'}
                      </p>
                      <p className="wn-compare-note" style={{ marginTop: 'var(--wn-s2)' }}>
                        {formatINR(gp.goal_gap)} still to save · projected balance in {months} months{' '}
                        {formatINR(sim.projected_balance)}
                      </p>
                    </div>

                    <details className="wn-disclose">
                      <summary>
                        How this is calculated
                        <ChevronDown size={13} className="wn-chev" aria-hidden="true" />
                      </summary>
                      <div className="wn-disclose-body">
                        <p className="wn-assume">
                          <span className="wn-prov wn-prov-calc">Calculation</span>
                          Projected balance is your current balance plus
                          ({formatINR(sim.current_monthly_savings)} baseline + {formatINR(extra)} extra)
                          × {months} months. No interest or investment growth is applied.
                        </p>
                        <p className="wn-assume">
                          <span className="wn-prov wn-prov-projection">Projection</span>
                          Goal dates assume the whole monthly saving goes to this goal.
                        </p>
                        {sim.assumptions?.map((a, i) => (
                          <p className="wn-assume" key={i}>{a}</p>
                        ))}
                      </div>
                    </details>

                    <div style={{ marginTop: 'var(--wn-s4)' }}>
                      <label className="wn-stat-label" htmlFor="horizon">
                        Projection period — {months} months
                      </label>
                      <input
                        id="horizon"
                        className="wn-range"
                        type="range" min="1" max="60" step="1"
                        value={months}
                        onChange={e => setMonths(Number(e.target.value))}
                        style={{ marginTop: 'var(--wn-s2)' }}
                      />
                      <div className="wn-range-scale">
                        <span>1 mo</span><span>30 mo</span><span>60 mo</span>
                      </div>
                    </div>
                  </>
                )}
              </section>

              {/* ---- Actions ---- */}
              <section className="wn-panel wn-enter wn-enter-3" aria-label="Ways to get there sooner">
                <div className="wn-section-head">
                  <h2 className="wn-section-title">Ways to get there sooner</h2>
                  {actions?.risk_label && (
                    <span className="wn-section-note">{actions.risk_label} approach</span>
                  )}
                </div>

                {actionsLoading && <p className="wn-section-note" style={{ padding: 'var(--wn-s4) 0' }}>Looking for opportunities…</p>}

                {!actionsLoading && actions?.recommendations?.length > 0 && (
                  <>
                    {actions.recommendations.map((a, i) => (
                      <div className="wn-action" key={i}>
                        <span className="wn-action-title">{a.action}</span>
                        <span className="wn-action-why">{a.why}</span>
                        <div className="wn-action-impact">
                          {a.monthly_saving > 0 && (
                            <span>Saves <strong className="wn-pos">{formatINR(a.monthly_saving)}</strong>/mo</span>
                          )}
                          {a.annual_saving > 0 && (
                            <span><strong className="wn-pos">{formatINR(a.annual_saving)}</strong>/yr</span>
                          )}
                          {a.goal_impact?.months_saved_label && (
                            <span>Goal {a.goal_impact.months_saved_label}</span>
                          )}
                        </div>
                        {a.monthly_saving > 0 && (
                          <button
                            className="wn-link"
                            onClick={() => setExtra(Math.min(50000, Math.round(a.monthly_saving / 500) * 500))}
                          >
                            Try this in the scenario above <ArrowRight size={12} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    ))}
                    <details className="wn-disclose">
                      <summary>
                        How these are chosen
                        <ChevronDown size={13} className="wn-chev" aria-hidden="true" />
                      </summary>
                      <div className="wn-disclose-body">
                        <p className="wn-assume">{actions.rule_applied}</p>
                        {actions.assumptions?.map((a, i) => <p className="wn-assume" key={i}>{a}</p>)}
                      </div>
                    </details>
                  </>
                )}

                {!actionsLoading && !actions?.recommendations?.length && (
                  <p className="wn-action-why" style={{ padding: 'var(--wn-s4) 0' }}>
                    No spending increases were detected last month, so there is nothing to trim right now.
                  </p>
                )}
              </section>
            </div>
          )}
        </div>
      )}

      {showCreate && (
        <CreateGoalDialog
          accounts={data?.accounts || []}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); if (id) setSelectedId(id); refresh(); }}
        />
      )}
    </div>
  );
}
