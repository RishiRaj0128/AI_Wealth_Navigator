import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Target, TrendingUp, Sparkles, Plus, AlertCircle, CheckCircle2,
  Calendar, ArrowRight, ShieldCheck, RefreshCw, Sliders, ChevronRight, Edit3
} from 'lucide-react';
import { Card, Metric, Button, Chip } from '../primitives';
import {
  fetchFinancialGoals,
  createFinancialGoal,
  updateFinancialGoal,
  simulateGoalScenario,
  fetchGoalRecommendations,
  fetchFinancialAccounts
} from '../api';

export default function GoalsView() {
  const [goals, setGoals] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [selectedGoalId, setSelectedGoalId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // New goal modal / form state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newGoal, setNewGoal] = useState({
    goal_name: '',
    target_amount: '',
    target_date: '',
    risk_preference: 'moderate',
    account_id: ''
  });
  const [creating, setCreating] = useState(false);

  // Update progress state
  const [updatingGoalId, setUpdatingGoalId] = useState(null);
  const [updateAmount, setUpdateAmount] = useState('');

  // What-if simulator state
  const [monthlyExtra, setMonthlyExtra] = useState(5000);
  const [projectionMonths, setProjectionMonths] = useState(12);
  const [simulating, setSimulating] = useState(false);
  const [simulationResult, setSimulationResult] = useState(null);

  // Next-best actions state
  const [recommendations, setRecommendations] = useState(null);
  const [loadingRecs, setLoadingRecs] = useState(false);

  // Load initial data
  const loadGoalsData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [goalsData, accsData] = await Promise.all([
        fetchFinancialGoals(null, 'all').catch(() => ({ goals: [] })),
        fetchFinancialAccounts().catch(() => [])
      ]);
      const gList = goalsData.goals || [];
      setGoals(gList);
      setAccounts(accsData || []);

      if (gList.length > 0 && !selectedGoalId) {
        setSelectedGoalId(gList[0].goal_id);
      }
    } catch (err) {
      console.error("Failed to load goals data:", err);
      setError("Could not load financial goals. Please verify backend connection.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGoalsData();
  }, []);

  // Run simulation whenever selected goal, monthly extra, or months change
  useEffect(() => {
    if (!selectedGoalId) return;

    let isMounted = true;
    const runSimulation = async () => {
      try {
        setSimulating(true);
        const res = await simulateGoalScenario(selectedGoalId, monthlyExtra, projectionMonths);
        if (isMounted) {
          setSimulationResult(res);
        }
      } catch (err) {
        console.error("Simulation error:", err);
      } finally {
        if (isMounted) setSimulating(false);
      }
    };

    const timer = setTimeout(runSimulation, 250);
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [selectedGoalId, monthlyExtra, projectionMonths]);

  // Handle goal creation
  const handleCreateGoal = async (e) => {
    e.preventDefault();
    if (!newGoal.goal_name || !newGoal.target_amount) return;
    try {
      setCreating(true);
      const created = await createFinancialGoal({
        account_id: newGoal.account_id || (accounts[0]?.account_id || null),
        goal_name: newGoal.goal_name,
        target_amount: parseFloat(newGoal.target_amount),
        target_date: newGoal.target_date || null,
        risk_preference: newGoal.risk_preference
      });
      setShowCreateModal(false);
      setNewGoal({ goal_name: '', target_amount: '', target_date: '', risk_preference: 'moderate', account_id: '' });
      await loadGoalsData();
      if (created?.goal?.goal_id) {
        setSelectedGoalId(created.goal.goal_id);
      }
    } catch (err) {
      alert(err.message || "Failed to create goal");
    } finally {
      setCreating(false);
    }
  };

  // Handle updating goal progress
  const handleUpdateProgress = async (goalId) => {
    if (updateAmount === '' || isNaN(updateAmount)) return;
    try {
      await updateFinancialGoal(goalId, { current_amount: parseFloat(updateAmount) });
      setUpdatingGoalId(null);
      setUpdateAmount('');
      await loadGoalsData();
    } catch (err) {
      alert(err.message || "Failed to update goal progress");
    }
  };

  // Load proactive recommendations
  const handleLoadRecommendations = async () => {
    if (!selectedGoalId) return;
    try {
      setLoadingRecs(true);
      const res = await fetchGoalRecommendations(selectedGoalId);
      setRecommendations(res);
    } catch (err) {
      console.error("Failed to load recommendations:", err);
    } finally {
      setLoadingRecs(false);
    }
  };

  const selectedGoal = goals.find(g => g.goal_id === selectedGoalId) || goals[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
      
      {/* 1. Header Section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, letterSpacing: '-0.02em', color: 'var(--text)' }}>
              Goals &amp; What-If Scenarios
            </h1>
            <span style={{
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '12px',
              background: 'rgba(16, 185, 129, 0.15)',
              color: '#10b981',
              fontWeight: 700
            }}>
              Deterministic Modeling
            </span>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '13.5px', margin: '6px 0 0' }}>
            Set wealth targets, simulate monthly savings impacts with verified historical cash-flow data, and review transparent assumptions.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <Button
            variant="secondary"
            onClick={loadGoalsData}
            icon={RefreshCw}
            disabled={loading}
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            onClick={() => setShowCreateModal(true)}
            icon={Plus}
          >
            Create New Goal
          </Button>
        </div>
      </div>

      {error && (
        <div style={{
          padding: '14px 18px',
          borderRadius: '8px',
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.25)',
          color: '#ef4444',
          fontSize: '13px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* 2. Top Summary KPI Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: '16px'
      }}>
        <Card variant="glass">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Active Goals
              </p>
              <h3 style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 0', color: 'var(--text)' }}>
                {goals.length}
              </h3>
            </div>
            <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(99, 102, 241, 0.12)', color: 'var(--primary)' }}>
              <Target size={20} />
            </div>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '12px 0 0' }}>
            {goals.filter(g => g.status === 'active').length} in progress · {goals.filter(g => g.status === 'completed').length} completed
          </p>
        </Card>

        <Card variant="glass">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Total Target Volume
              </p>
              <h3 style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 0', color: 'var(--text)' }}>
                ₹{goals.reduce((sum, g) => sum + (g.target_amount || 0), 0).toLocaleString('en-IN')}
              </h3>
            </div>
            <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(16, 185, 129, 0.12)', color: '#10b981' }}>
              <TrendingUp size={20} />
            </div>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '12px 0 0' }}>
            ₹{goals.reduce((sum, g) => sum + (g.current_amount || 0), 0).toLocaleString('en-IN')} saved so far
          </p>
        </Card>

        <Card variant="glass">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Active Scenario Focus
              </p>
              <h3 style={{ fontSize: '20px', fontWeight: 800, margin: '8px 0 0', color: selectedGoal ? 'var(--text)' : 'var(--text-muted)' }}>
                {selectedGoal ? selectedGoal.goal_name : 'No Goal Selected'}
              </h3>
            </div>
            <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.12)', color: '#f59e0b' }}>
              <Sliders size={20} />
            </div>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '12px 0 0' }}>
            {selectedGoal?.target_date ? `Target date: ${selectedGoal.target_date}` : 'Ongoing goal'}
          </p>
        </Card>
      </div>

      {/* 3. Main Workspace: Goals List (Left) + What-If Simulation & Actions (Right) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(320px, 1.2fr) minmax(400px, 1.8fr)',
        gap: '24px',
        alignItems: 'start'
      }}>
        
        {/* Left: Goals Cards List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: 'var(--text)' }}>
              Your Financial Goals
            </h2>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Click to run scenario
            </span>
          </div>

          {goals.length === 0 ? (
            <Card variant="glass" style={{ textAlign: 'center', padding: '40px 20px' }}>
              <Target size={36} style={{ color: 'var(--text-muted)', margin: '0 auto 12px', opacity: 0.6 }} />
              <p style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text)', margin: '0 0 6px' }}>
                No goals created yet
              </p>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '0 0 16px', maxWidth: '280px', marginInline: 'auto' }}>
                Set up your first financial milestone to simulate savings timelines and discover savings opportunities.
              </p>
              <Button variant="primary" onClick={() => setShowCreateModal(true)} icon={Plus}>
                Create Your First Goal
              </Button>
            </Card>
          ) : (
            goals.map(goal => {
              const isSelected = goal.goal_id === selectedGoalId;
              const target = goal.target_amount || 1;
              const current = goal.current_amount || 0;
              // Safe percentage guard to prevent bar overflow
              const pct = Math.min(100, Math.max(0, Math.round((current / target) * 100)));

              return (
                <div
                  key={goal.goal_id}
                  onClick={() => setSelectedGoalId(goal.goal_id)}
                  style={{
                    padding: '16px 20px',
                    borderRadius: '10px',
                    background: isSelected ? 'rgba(99, 102, 241, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                    border: isSelected ? '1px solid var(--primary)' : '1px solid var(--border)',
                    cursor: 'pointer',
                    transition: 'all 180ms ease-in-out',
                    boxShadow: isSelected ? '0 0 16px rgba(99, 102, 241, 0.15)' : 'none'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text)' }}>
                          {goal.goal_name}
                        </span>
                        <Chip tone={goal.risk_preference === 'aggressive' ? 'critical' : goal.risk_preference === 'conservative' ? 'verified' : 'neutral'}>
                          {goal.risk_preference}
                        </Chip>
                      </div>
                      {goal.target_date && (
                        <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                          <Calendar size={12} /> Target: {goal.target_date}
                        </span>
                      )}
                    </div>

                    <span style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: '10px',
                      background: pct >= 100 ? 'rgba(16, 185, 129, 0.2)' : 'rgba(99, 102, 241, 0.15)',
                      color: pct >= 100 ? '#10b981' : 'var(--primary)'
                    }}>
                      {pct}% Complete
                    </span>
                  </div>

                  {/* Progress Bar with Safe Cap */}
                  <div style={{
                    width: '100%',
                    height: '8px',
                    borderRadius: '4px',
                    background: 'rgba(255, 255, 255, 0.08)',
                    overflow: 'hidden',
                    margin: '12px 0 8px'
                  }}>
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                      style={{
                        height: '100%',
                        borderRadius: '4px',
                        background: pct >= 100 ? 'linear-gradient(90deg, #10b981, #059669)' : 'linear-gradient(90deg, #6366f1, #3b82f6)'
                      }}
                    />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12.5px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>
                      ₹{current.toLocaleString('en-IN')} of <strong style={{ color: 'var(--text)' }}>₹{target.toLocaleString('en-IN')}</strong>
                    </span>

                    {/* Quick Update Progress Inline Control */}
                    {updatingGoalId === goal.goal_id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} onClick={e => e.stopPropagation()}>
                        <input
                          type="number"
                          placeholder="New ₹"
                          value={updateAmount}
                          onChange={e => setUpdateAmount(e.target.value)}
                          style={{
                            width: '80px',
                            padding: '4px 6px',
                            borderRadius: '4px',
                            background: 'rgba(0,0,0,0.4)',
                            border: '1px solid var(--border)',
                            color: '#fff',
                            fontSize: '11px'
                          }}
                        />
                        <button
                          onClick={() => handleUpdateProgress(goal.goal_id)}
                          style={{
                            background: 'var(--primary)',
                            border: 'none',
                            color: '#fff',
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '4px 8px',
                            borderRadius: '4px',
                            cursor: 'pointer'
                          }}
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setUpdatingGoalId(null)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-muted)',
                            fontSize: '11px',
                            cursor: 'pointer'
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setUpdatingGoalId(goal.goal_id);
                          setUpdateAmount(String(current));
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--primary)',
                          fontSize: '11.5px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: 0
                        }}
                      >
                        <Edit3 size={11} /> Update Progress
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right: What-If Scenario Simulator & Transparent Assumptions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* Simulator Controls Card */}
          <Card variant="glass" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <h3 style={{ fontSize: '18px', fontWeight: 800, margin: 0, color: 'var(--text)' }}>
                  Interactive "What-If" Scenario Simulator
                </h3>
                <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  Simulating for: <strong style={{ color: '#fff' }}>{selectedGoal?.goal_name || 'Select a goal on the left'}</strong>
                </p>
              </div>

              <span style={{
                padding: '4px 10px',
                borderRadius: '6px',
                background: 'rgba(16, 185, 129, 0.1)',
                color: '#10b981',
                fontSize: '11px',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}>
                <Sparkles size={13} /> Real PostgreSQL Cashflow
              </span>
            </div>

            {/* Controls */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              {/* Extra Savings Slider */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>
                    Additional Monthly Savings
                  </label>
                  <span style={{ fontSize: '14px', fontWeight: 800, color: '#10b981' }}>
                    +₹{monthlyExtra.toLocaleString('en-IN')}/mo
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50000"
                  step="500"
                  value={monthlyExtra}
                  onChange={e => setMonthlyExtra(Number(e.target.value))}
                  style={{ width: '100%', accentColor: '#10b981', cursor: 'pointer' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  <span>₹0</span>
                  <span>₹25,000</span>
                  <span>₹50,000</span>
                </div>
              </div>

              {/* Time Horizon Slider */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>
                    Projection Horizon
                  </label>
                  <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--primary)' }}>
                    {projectionMonths} Months ({roundToYear(projectionMonths)})
                  </span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="60"
                  step="1"
                  value={projectionMonths}
                  onChange={e => setProjectionMonths(Number(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  <span>1 mo</span>
                  <span>12 mo (1 yr)</span>
                  <span>36 mo (3 yr)</span>
                  <span>60 mo (5 yr)</span>
                </div>
              </div>
            </div>

            {/* Projection Output Highlight Cards */}
            {simulationResult && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '12px',
                marginTop: '22px',
                paddingTop: '20px',
                borderTop: '1px solid var(--border)'
              }}>
                <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Projected Balance</span>
                  <div style={{ fontSize: '20px', fontWeight: 800, color: '#10b981', marginTop: '4px' }}>
                    ₹{simulationResult.projected_balance?.toLocaleString('en-IN') || 0}
                  </div>
                  <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                    in {projectionMonths} months
                  </span>
                </div>

                <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Extra Capital Accumulated</span>
                  <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--primary)', marginTop: '4px' }}>
                    ₹{simulationResult.total_extra_saved?.toLocaleString('en-IN') || 0}
                  </div>
                  <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                    pure extra savings
                  </span>
                </div>

                {simulationResult.goal_projection && (
                  <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
                    <span style={{ fontSize: '11px', color: '#f59e0b', textTransform: 'uppercase', fontWeight: 700 }}>Goal Timeline Impact</span>
                    <div style={{ fontSize: '15px', fontWeight: 800, color: '#fff', marginTop: '4px' }}>
                      {typeof simulationResult.goal_projection.months_saved === 'number'
                        ? `${simulationResult.goal_projection.months_saved} Months Faster!`
                        : simulationResult.goal_projection.months_saved}
                    </div>
                    <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                      New target date: {simulationResult.goal_projection.new_projected_date || 'N/A'}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* EXPLAINABILITY REQUIREMENT: Transparent Assumptions Box */}
            {simulationResult?.assumptions?.length > 0 && (
              <div style={{
                marginTop: '20px',
                padding: '16px',
                borderRadius: '8px',
                background: 'rgba(15, 23, 42, 0.75)',
                border: '1px solid rgba(59, 130, 246, 0.25)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <ShieldCheck size={16} style={{ color: '#3b82f6' }} />
                  <span style={{ fontSize: '12.5px', fontWeight: 700, color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                    Model Assumptions (Explainability Guarantee)
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {simulationResult.assumptions.map((assump, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      <span style={{ color: '#3b82f6', marginTop: '2px' }}>•</span>
                      <span>{assump}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* Proactive Next-Best Actions Card */}
          <Card variant="glass" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: 'var(--text)' }}>
                  Proactive Next-Best Actions
                </h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  Rule-based detection surfaces category spend increases (&gt;15% MoM) and maps them to goal acceleration.
                </p>
              </div>

              <Button
                variant="secondary"
                onClick={handleLoadRecommendations}
                icon={Sparkles}
                disabled={loadingRecs || !selectedGoalId}
              >
                {loadingRecs ? 'Analyzing…' : 'Find Opportunities'}
              </Button>
            </div>

            {recommendations?.recommendations?.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {recommendations.recommendations.map((action, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '14px 16px',
                      borderRadius: '8px',
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid var(--border)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text)' }}>
                          {action.category}
                        </span>
                        <Chip tone={action.pct_increase > 15 ? 'critical' : 'accent'}>
                          {action.pct_increase > 0 ? `+${action.pct_increase}% MoM` : 'Top Spend'}
                        </Chip>
                      </div>

                      <span style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                        Current monthly spend: <strong style={{ color: '#ef4444' }}>₹{action.current_monthly_spend?.toLocaleString('en-IN')}</strong>
                      </span>
                    </div>

                    {/* Savings Options */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '10px',
                      background: 'rgba(0,0,0,0.25)',
                      padding: '10px',
                      borderRadius: '6px',
                      marginTop: '4px'
                    }}>
                      <div>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Option A: Trim 25%</span>
                        <div style={{ fontSize: '13px', fontWeight: 800, color: '#10b981', marginTop: '2px' }}>
                          +₹{action.reduction_options?.trim_25_pct?.monthly_saving?.toLocaleString('en-IN')}/mo
                        </div>
                        {action.reduction_options?.trim_25_pct?.goal_impact?.months_saved && (
                          <span style={{ fontSize: '10.5px', color: '#93c5fd' }}>
                            Saves {action.reduction_options.trim_25_pct.goal_impact.months_saved} mo on goal
                          </span>
                        )}
                      </div>

                      <div>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Option B: Trim 50%</span>
                        <div style={{ fontSize: '13px', fontWeight: 800, color: '#10b981', marginTop: '2px' }}>
                          +₹{action.reduction_options?.trim_50_pct?.monthly_saving?.toLocaleString('en-IN')}/mo
                        </div>
                        {action.reduction_options?.trim_50_pct?.goal_impact?.months_saved && (
                          <span style={{ fontSize: '10.5px', color: '#93c5fd' }}>
                            Saves {action.reduction_options.trim_50_pct.goal_impact.months_saved} mo on goal
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                Click <strong>"Find Opportunities"</strong> to evaluate month-over-month category surges and see concrete next-best actions.
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* 4. Goal Creation Modal */}
      <AnimatePresence>
        {showCreateModal && (
          <div style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(6px)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
          }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              style={{
                width: '100%',
                maxWidth: '480px',
                background: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid var(--border)',
                borderRadius: '12px',
                padding: '28px',
                boxShadow: '0 20px 40px rgba(0,0,0,0.6)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ fontSize: '18px', fontWeight: 800, margin: 0, color: 'var(--text)' }}>
                  Create Financial Goal
                </h3>
                <button
                  onClick={() => setShowCreateModal(false)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}
                >
                  ✕
                </button>
              </div>

              <form onSubmit={handleCreateGoal} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '6px', color: 'var(--text)' }}>
                    Goal Name *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., Emergency Fund, Home Down Payment"
                    value={newGoal.goal_name}
                    onChange={e => setNewGoal({ ...newGoal, goal_name: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: '6px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                      fontSize: '13px'
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '6px', color: 'var(--text)' }}>
                    Target Amount (₹) *
                  </label>
                  <input
                    type="number"
                    required
                    min="100"
                    placeholder="e.g., 200000"
                    value={newGoal.target_amount}
                    onChange={e => setNewGoal({ ...newGoal, target_amount: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: '6px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                      fontSize: '13px'
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '6px', color: 'var(--text)' }}>
                    Target Date (Optional)
                  </label>
                  <input
                    type="date"
                    value={newGoal.target_date}
                    onChange={e => setNewGoal({ ...newGoal, target_date: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: '6px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                      fontSize: '13px'
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12.5px', fontWeight: 600, marginBottom: '6px', color: 'var(--text)' }}>
                    Risk Preference
                  </label>
                  <select
                    value={newGoal.risk_preference}
                    onChange={e => setNewGoal({ ...newGoal, risk_preference: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: '6px',
                      background: 'rgba(15, 23, 42, 1)',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                      fontSize: '13px'
                    }}
                  >
                    <option value="conservative">Conservative (Low volatility focus)</option>
                    <option value="moderate">Moderate (Balanced savings growth)</option>
                    <option value="aggressive">Aggressive (Maximum accumulation)</option>
                  </select>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
                  <Button variant="secondary" onClick={() => setShowCreateModal(false)} type="button">
                    Cancel
                  </Button>
                  <Button variant="primary" type="submit" disabled={creating}>
                    {creating ? 'Creating…' : 'Create Goal'}
                  </Button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}

function roundToYear(months) {
  if (months === 12) return "1 yr";
  if (months % 12 === 0) return `${months / 12} yrs`;
  return `${(months / 12).toFixed(1)} yrs`;
}
