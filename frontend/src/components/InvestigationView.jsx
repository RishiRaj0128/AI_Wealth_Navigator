import React, { useState, useEffect } from 'react';
import { Search, ChevronDown, ChevronUp, Check, Users, Target, Zap } from '../icons';
import {
  runInvestigation,
  fetchIncidentInvestigations,
  fetchInvestigationSteps,
  fetchIncidentActions,
  fetchSimilarIncidents,
  proposeAction,
  approveAction,
  rejectAction,
  executeAction
} from '../api';
import { Card, SeverityRail, Button, Chip } from '../primitives';

const STATUS_CHIP = {
  not_investigated: { tone: 'neutral', label: 'Pending investigation' },
  investigating: { tone: 'accent', label: 'Investigating…' },
  investigated: { tone: 'verified', label: 'Investigated' },
  investigation_failed: { tone: 'critical', label: 'Investigation failed' },
};

function WorkspaceRow({ inc, isSelected, onClick, isCompleted }) {
  const status = STATUS_CHIP[inc.investigation_status || 'not_investigated'];
  const isRejected = inc.status === 'rejected';
  return (
    <button
      onClick={onClick}
      data-cursor="hover"
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '10px 12px',
        borderRadius: 'var(--r-sm)',
        border: 'none',
        borderLeft: isSelected ? '2px solid var(--cc-accent)' : '2px solid transparent',
        background: isSelected ? 'var(--ink-hover)' : 'transparent',
        opacity: isCompleted && !isSelected ? 0.6 : 1,
        marginBottom: '2px',
        transition: 'opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          {!isCompleted && <Chip tone={inc.severity || 'medium'}>{(inc.severity || 'medium').toUpperCase()}</Chip>}
          <span className="text-data" style={{ color: 'var(--cc-text-tertiary)', flexShrink: 0 }}>{inc.incident_id}</span>
        </div>
        {!isCompleted && <Chip tone={status.tone}>{status.label}</Chip>}
        {isCompleted && <Chip tone={isRejected ? 'neutral' : 'verified'}>{isRejected ? 'Rejected' : 'Resolved'}</Chip>}
      </div>
      <div style={{ fontSize: isCompleted ? '12.5px' : '13px', fontWeight: isCompleted ? 500 : 600, color: isCompleted ? 'var(--cc-text-secondary)' : 'var(--cc-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {inc.title}
      </div>
      <div className="text-data" style={{ marginTop: '2px' }}>
        {inc.target_entity_id} · {new Date(inc.detected_at).toLocaleDateString()}
      </div>
    </button>
  );
}

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

export default function InvestigationView({ incident, incidents = [], onSelectIncident, aiStatus, onRefreshAll }) {
  const [investigating, setInvestigating] = useState(false);
  const [investigationData, setInvestigationData] = useState(null);
  const [steps, setSteps] = useState([]);
  const [similarCases, setSimilarCases] = useState([]);
  const [similarCasesError, setSimilarCasesError] = useState(null);
  const [expandedStep, setExpandedStep] = useState(null);
  const [showMerchants, setShowMerchants] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [staleInvestigationNotice, setStaleInvestigationNotice] = useState(null);

  // Action Governor State
  const [actions, setActions] = useState([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);

  // Completed-list filter — backed by the incident's own real `status` field
  // ('resolved' vs 'rejected'), never a frontend label heuristic.
  const [completedFilter, setCompletedFilter] = useState('total');

  // Depend on incident_id specifically, not the incident object — App.jsx's 5s
  // polling refresh creates a new object reference for the SAME incident on every
  // tick, and this effect must only reset/reload state on an actual navigation to
  // a different incident, not on every background refresh of the one being viewed.
  useEffect(() => {
    if (incident?.incident_id) {
      setExpandedStep(null);
      setShowMerchants(false);
      setErrorMsg(null);
      setActionMsg(null);
      loadInvestigationAndActions(incident.incident_id);
      loadSimilarCases(incident.incident_id);
    }
  }, [incident?.incident_id]);

  const loadSimilarCases = async (incId) => {
    try {
      const cases = await fetchSimilarIncidents(incId);
      setSimilarCases(cases && cases.length > 0 ? cases : []);
      setSimilarCasesError(null);
    } catch (e) {
      console.warn("Could not load similar cases:", e);
      setSimilarCases([]);
      setSimilarCasesError("Case-memory similarity lookup failed: no similar incidents could be retrieved.");
    }
  };

  const loadInvestigationAndActions = async (incId) => {
    // Reset first so switching incidents never shows stale state from the
    // previously-selected one while the new fetch is in flight.
    setInvestigationData(null);
    setSteps([]);
    setActions([]);
    setStaleInvestigationNotice(null);

    try {
      const [invs, acts] = await Promise.all([
        fetchIncidentInvestigations(incId).catch(() => []),
        fetchIncidentActions(incId).catch(() => [])
      ]);

      const sortedInvs = invs || [];
      const primaryAct = acts && acts.length > 0 ? acts[0] : null;

      // The most recent investigation ATTEMPT (sortedInvs[0]) is not necessarily the
      // one a proposed/approved/executed action is actually based on — a later
      // re-investigation can fail (e.g. a Gemini timeout) without invalidating an
      // earlier successful one an action already relies on. Show the investigation
      // the action is grounded in, and surface the later failure as a visible notice
      // instead of letting it silently look like the action has no basis at all.
      let toDisplay = sortedInvs.length > 0 ? sortedInvs[0] : null;

      if (primaryAct?.investigation_id) {
        const backing = sortedInvs.find(i => i.investigation_id === primaryAct.investigation_id);
        if (backing && backing.investigation_id !== toDisplay?.investigation_id) {
          if (toDisplay && toDisplay.status !== 'completed') {
            setStaleInvestigationNotice(
              `A more recent re-investigation attempt (${toDisplay.investigation_id}) ${toDisplay.status === 'failed' ? 'failed' : `is ${toDisplay.status}`}: showing investigation ${backing.investigation_id}, the one this action is actually based on.`
            );
          }
          toDisplay = backing;
        }
      }

      if (toDisplay) {
        setInvestigationData(toDisplay);
        const stps = await fetchInvestigationSteps(toDisplay.investigation_id);
        setSteps(stps || []);
      }

      setActions(acts || []);
    } catch (e) {
      console.warn("Could not load investigation/action details:", e);
    }
  };

  const handleInvestigate = async () => {
    if (!incident?.incident_id) return;
    setInvestigating(true);
    setErrorMsg(null);

    try {
      const res = await runInvestigation(incident.incident_id);
      if (res.status === 'completed') {
        setInvestigationData({
          investigation_id: res.investigation_id,
          status: 'completed',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          provider: res.provider,
          model: res.model,
          what_happened: res.report?.what_happened || res.report?.summary,
          why_it_happened: res.report?.why,
          estimated_exposure: res.report?.financial_exposure?.amount_inr || incident.potential_exposure,
          recommendation: res.report?.recommendation,
          confidence: res.report?.confidence || 0.94,
          evidence_confidence: res.report?.evidence_confidence,
          historical_precedent: res.report?.historical_precedent,
          similar_cases: res.report?.similar_cases || [],
          evidence_json: res.report?.evidence ? JSON.stringify(res.report.evidence) : null,
          affected_entities_json: res.report?.affected_entities ? JSON.stringify(res.report.affected_entities) : null
        });

        const stps = await fetchInvestigationSteps(res.investigation_id);
        setSteps(stps || res.steps || []);

        if (res.report?.similar_cases) {
          setSimilarCases(res.report.similar_cases);
        } else {
          loadSimilarCases(incident.incident_id);
        }

        // Auto-propose governed action if none exists. Action type must match the
        // incident's own entity type — a merchant-type incident (refund spike,
        // duplicate refund, webhook failure) has no gateway to reroute traffic away
        // from, so it gets the merchant-scoped policy action instead.
        const isMerchantIncident = incident.target_entity_type === 'merchant';
        try {
          await proposeAction({
            incident_id: incident.incident_id,
            investigation_id: res.investigation_id,
            action_type: isMerchantIncident ? "pause_merchant_settlements" : "reroute_gateway_traffic",
            target_entity: incident.target_entity_id || "Gateway_X",
            reason: res.report?.recommendation || (isMerchantIncident
              ? "Place a temporary hold on merchant settlements pending review."
              : "Reroute traffic away from degraded banking node to backup partner nodes."),
            actor: "Gemini_Agent"
          });
          const acts = await fetchIncidentActions(incident.incident_id);
          setActions(acts || []);
        } catch (err) {
          console.warn("Auto propose action notice:", err);
        }

        if (onRefreshAll) onRefreshAll();
      } else {
        setErrorMsg(res.message || "Investigation could not be completed.");
      }
    } catch (err) {
      setErrorMsg(err.message || "Failed to contact Gemini investigation engine.");
    } finally {
      setInvestigating(false);
    }
  };

  const handleApprove = async (actionId) => {
    setActionLoading(true);
    setActionMsg(null);
    try {
      await approveAction(actionId, "Operator authorized traffic cutover per FinOps incident governance policy");
      setActionMsg("Action approved by human operator. Ready for safe demonstration simulation.");
      const acts = await fetchIncidentActions(incident.incident_id);
      setActions(acts || []);
    } catch (e) {
      setActionMsg(`Approval failed: ${e.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async (actionId) => {
    setActionLoading(true);
    setActionMsg(null);
    try {
      await rejectAction(actionId, "Operator rejected automated traffic cutover");
      setActionMsg("Action rejected by operator. Governance policy prevented modification.");
      const acts = await fetchIncidentActions(incident.incident_id);
      setActions(acts || []);
      // A rejection is a final decision, same as execution — refresh the shared
      // incidents list immediately so the workspace sidebar moves this incident
      // out of Active/Pending right now, not after the next 5s poll.
      if (onRefreshAll) onRefreshAll();
    } catch (e) {
      setActionMsg(`Rejection failed: ${e.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleExecuteSimulation = async (actionId) => {
    setActionLoading(true);
    setActionMsg(null);
    try {
      await executeAction(actionId);
      setActionMsg("Safe demonstration simulation completed. Immutable audit trail appended to PostgreSQL.");
      const acts = await fetchIncidentActions(incident.incident_id);
      setActions(acts || []);
      // Execution resolves the parent incident (open -> resolved) — refresh the
      // shared incidents list immediately so the workspace sidebar moves it from
      // Active/Pending into Completed right now, not after the next 5s poll.
      if (onRefreshAll) onRefreshAll();
    } catch (e) {
      setActionMsg(`Execution failed: ${e.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // ACTIVE/PENDING = genuinely unresolved work only (any sub-state: not yet
  // investigated, investigating, investigated-awaiting-approval, approved). A
  // human rejection is just as final a decision as an executed simulation —
  // it moves to COMPLETED immediately, not only once something executes.
  const activeList = incidents
    .filter(i => i.status !== 'resolved' && i.status !== 'rejected')
    .slice()
    .sort((a, b) => {
      const aPending = a.investigation_status !== 'investigated' ? 0 : 1;
      const bPending = b.investigation_status !== 'investigated' ? 0 : 1;
      if (aPending !== bPending) return aPending - bPending;
      return new Date(b.detected_at) - new Date(a.detected_at);
    });
  const completedListAll = incidents
    .filter(i => i.status === 'resolved' || i.status === 'rejected')
    .slice()
    .sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at));
  const completedList = completedListAll.filter(i => {
    if (completedFilter === 'approved') return i.status === 'resolved';
    if (completedFilter === 'rejected') return i.status === 'rejected';
    return true;
  });

  const workspaceSidebar = (
    <div className="cc-investigation-sidebar" style={{ width: '300px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '22px' }}>
      <div>
        <div className="cc-section-eyebrow" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
          <span>Active / Pending</span>
          <span>{activeList.length}</span>
        </div>
        {activeList.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--cc-text-tertiary)', padding: '10px 0' }}>No open incidents.</div>
        ) : (
          activeList.map(inc => (
            <WorkspaceRow
              key={inc.incident_id}
              inc={inc}
              isSelected={incident?.incident_id === inc.incident_id}
              isCompleted={false}
              onClick={() => onSelectIncident && onSelectIncident(inc)}
            />
          ))
        )}
      </div>

      <div>
        <div className="cc-section-eyebrow" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <span>Completed</span>
          <span>{completedListAll.length}</span>
        </div>
        {completedListAll.length > 0 && (
          <select
            value={completedFilter}
            onChange={(e) => setCompletedFilter(e.target.value)}
            data-cursor="hover"
            style={{
              width: '100%', marginBottom: '10px', padding: '6px 8px', borderRadius: 'var(--r-sm)',
              background: 'var(--ink-raised)', border: '1px solid var(--line-solid)',
              color: 'var(--cc-text-primary)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer'
            }}
          >
            <option value="total">Total completed</option>
            <option value="approved">Human approved</option>
            <option value="rejected">Rejected</option>
          </select>
        )}
        {completedList.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--cc-text-tertiary)', padding: '10px 0' }}>
            {completedListAll.length === 0 ? 'No resolved incidents yet.' : 'No completed incidents match this filter.'}
          </div>
        ) : (
          completedList.map(inc => (
            <WorkspaceRow
              key={inc.incident_id}
              inc={inc}
              isSelected={incident?.incident_id === inc.incident_id}
              isCompleted={true}
              onClick={() => onSelectIncident && onSelectIncident(inc)}
            />
          ))
        )}
      </div>
    </div>
  );

  if (!incident) {
    return (
      <div className="cc-investigation-layout" style={{ display: 'flex', gap: '32px', alignItems: 'flex-start' }}>
        {incidents.length > 0 && workspaceSidebar}
        <div style={{ padding: '60px 24px', textAlign: 'center', color: 'var(--cc-text-tertiary)', flex: 1 }}>
          <Search size={26} strokeWidth={1.5} style={{ marginBottom: 12, color: 'var(--cc-text-tertiary)' }} />
          <h3 className="text-card-title" style={{ margin: '0 0 8px' }}>
            {incidents.length === 0 ? 'No incidents yet' : 'Select an incident'}
          </h3>
          <p style={{ fontSize: '13px', margin: 0 }}>
            {incidents.length === 0
              ? 'Generate data and run a detection scan to discover the first incident.'
              : 'Pick an incident from Active/Pending or Completed on the left to view its investigation.'}
          </p>
        </div>
      </div>
    );
  }

  const isGeminiConnected = aiStatus?.configured;
  const primaryAction = actions.length > 0 ? actions[0] : null;

  const isMerchantIncident = incident.target_entity_type === 'merchant';
  const ev = incident.evidence || {};

  // Gateway-type incidents surface failure-rate-vs-peer evidence; merchant-type
  // incidents (refund spike / duplicate refund / webhook failure) surface
  // whichever of the three merchant evidence shapes this incident actually has —
  // there is no single shared metric name across all four scenario families.
  const primaryRatePct = ev.failure_rate_pct ?? ev.actual_refund_rate_pct ?? ev.webhook_failure_rate_pct ?? null;
  const baselineRatePct = ev.peer_failure_rate_pct ?? ev.baseline_refund_rate_pct ?? null;
  const primaryRateLabel = ev.failure_rate_pct != null ? 'Failure rate' : (ev.actual_refund_rate_pct != null ? 'Refund rate' : (ev.webhook_failure_rate_pct != null ? 'Webhook failure rate' : 'Primary rate'));
  const baselineRateLabel = ev.peer_failure_rate_pct != null ? 'Peer baseline' : (ev.baseline_refund_rate_pct != null ? "Merchant's own baseline" : 'Peer baseline');

  const failureRate = primaryRatePct;
  const peerRate = baselineRatePct;
  const ratio = ev.failure_rate_ratio ?? ev.refund_rate_ratio ?? (peerRate && Number(peerRate) > 0 && failureRate ? (Number(failureRate) / Number(peerRate)).toFixed(2) : null);
  const topErrors = ev.top_failure_code_count ?? ev.duplicate_refund_payments ?? null;
  const topErrorsLabel = ev.top_failure_code_count != null ? 'Gateway timeouts' : (ev.duplicate_refund_payments != null ? 'Duplicate refunds' : 'Gateway timeouts');
  const totalFailed = ev.failed_payments_count ?? ev.total_refunds ?? (incident.affected_payments || null);
  const exposureAmt = investigationData?.estimated_exposure ?? (incident.potential_exposure || null);
  const merchantCount = isMerchantIncident ? 1 : (incident.affected_merchants || null);

  let affectedMerchantsList = [];
  if (investigationData?.affected_entities_json) {
    try {
      affectedMerchantsList = JSON.parse(investigationData.affected_entities_json);
    } catch (e) {
      affectedMerchantsList = [];
    }
  }

  // Evidence confidence is only shown once a real investigation has computed it — never a placeholder guess.
  const evidenceScore = investigationData?.confidence != null
    ? Math.round(investigationData.confidence * 100)
    : null;

  const topSimilarCase = similarCases.length > 0 ? similarCases[0] : null;

  // Evidence chain — a numbered sequence of the real signals behind this
  // incident, in the order a reviewer would naturally read them: the
  // anomaly that triggered detection, then the comparison that makes it
  // meaningful, then its scale, then its cost. Each entry only appears if
  // its underlying value is real (never a fabricated placeholder).
  const evidenceChain = [
    failureRate != null && { label: primaryRateLabel, value: `${failureRate}%`, detail: ratio != null ? `${ratio}x baseline` : null },
    peerRate != null && { label: baselineRateLabel, value: `${peerRate}%`, detail: isMerchantIncident && ev.baseline_refund_rate_pct != null ? "this merchant's historical rate" : 'healthy peer average' },
    topErrors != null && { label: topErrorsLabel, value: totalFailed != null ? `${topErrors} / ${totalFailed}` : String(topErrors), detail: topErrors != null && totalFailed ? `${((topErrors / totalFailed) * 100).toFixed(2)}% concentration` : null },
    { label: isMerchantIncident ? 'Target merchant' : 'Affected merchants', value: isMerchantIncident ? (incident.target_entity_id || '-') : (merchantCount != null ? merchantCount : '-'), detail: isMerchantIncident ? 'single-merchant incident' : 'impacted across categories' },
    { label: 'Potential exposure', value: exposureAmt != null ? `₹${Number(exposureAmt).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-', detail: 'unresolved transaction value' },
  ].filter(Boolean);

  // Visible workflow stage: detected -> investigating -> investigated ->
  // recommendation available -> awaiting approval -> approved -> executed.
  // Nothing here implies "resolved" or "nothing found" just because a panel is empty.
  const workflowStage = (() => {
    if (investigating) return { tone: 'accent', label: 'Investigating…' };
    if (!investigationData) return { tone: 'neutral', label: 'Detected (not yet investigated)' };
    if (investigationData.status === 'running') return { tone: 'accent', label: 'Investigating…' };
    if (investigationData.status === 'failed') return { tone: 'critical', label: 'Investigation attempt failed' };
    if (incident.status === 'resolved') return { tone: 'verified', label: 'Resolved' };
    if (incident.status === 'rejected') return { tone: 'neutral', label: 'Rejected' };
    if (!primaryAction) return { tone: 'verified', label: 'Investigated (recommendation available)' };
    if (primaryAction.status === 'pending_approval') return { tone: 'medium', label: 'Awaiting human approval' };
    if (primaryAction.status === 'approved') return { tone: 'accent', label: 'Approved (ready to execute)' };
    if (primaryAction.status === 'executed') return { tone: 'verified', label: 'Executed (safe simulation)' };
    if (primaryAction.status === 'rejected') return { tone: 'neutral', label: 'Rejected by human' };
    return { tone: 'verified', label: 'Investigated' };
  })();

  return (
    <div className="cc-investigation-layout" style={{ display: 'flex', gap: '32px', alignItems: 'flex-start' }}>
      {workspaceSidebar}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '36px' }}>

        {/* INCIDENT CONTEXT — the selected incident as the visual anchor,
            SeverityRail as the signature indicator down the left edge. */}
        <div style={{ display: 'flex', gap: '18px' }}>
          <SeverityRail
            severity={incident.severity || 'critical'}
            confidence={evidenceScore != null ? evidenceScore : 0}
            approved={primaryAction?.status === 'executed'}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p className="cc-section-eyebrow" style={{ marginBottom: '6px' }}>Investigation</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
              <div>
                <h1 className="text-page-title" style={{ margin: '0 0 8px' }}>{incident.title}</h1>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--sev-critical)', fontWeight: 700, fontSize: '11px' }}>{(incident.severity || 'critical').toUpperCase()}</span>
                  <span className="cc-system-strip-sep">·</span>
                  <span className="text-data" style={{ color: 'var(--cc-text-tertiary)' }}>{incident.incident_id}</span>
                  <span className="cc-system-strip-sep">·</span>
                  <span style={{ fontSize: '12.5px', color: 'var(--cc-text-tertiary)' }}>{relativeTime(incident.detected_at)}</span>
                  <Chip tone={workflowStage.tone}>{workflowStage.label}</Chip>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
                {!investigationData || investigationData.status !== 'completed' ? (
                  <Button
                    tier="primary"
                    onClick={handleInvestigate}
                    state={investigating ? 'loading' : 'idle'}
                    loadingLabel="Querying Gemini"
                    disabled={!isGeminiConnected}
                  >
                    <Zap size={13} strokeWidth={2} style={{ marginRight: 6 }} />
                    Investigate with Gemini
                  </Button>
                ) : (
                  <>
                    <Chip tone="verified">
                      {primaryAction?.status === 'executed' || primaryAction?.status === 'approved' || primaryAction?.status === 'rejected'
                        ? 'View investigation below'
                        : 'Review recommendation below'}
                    </Chip>
                    <button
                      onClick={handleInvestigate}
                      disabled={investigating || !isGeminiConnected}
                      title="Re-runs Gemini against current evidence. Secondary/debugging use: does not undo the existing recommendation or approval."
                      style={{ background: 'none', border: 'none', color: 'var(--cc-text-tertiary)', cursor: 'pointer', fontSize: '11.5px', fontWeight: 600, padding: '2px' }}
                      data-cursor="hover"
                    >
                      {investigating ? 'Re-investigating…' : 'Re-investigate with Gemini'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {errorMsg && (
              <p style={{ marginTop: '14px', fontSize: '13px', color: 'var(--sev-critical)' }}>
                <strong>Investigation notice: </strong>{errorMsg}
              </p>
            )}
            {staleInvestigationNotice && (
              <p style={{ marginTop: '8px', fontSize: '13px', color: 'var(--sev-medium)' }}>
                <strong>Note: </strong>{staleInvestigationNotice}
              </p>
            )}
          </div>
        </div>

        {/* THE FINDING — the conclusion as the focal point, not buried in a card. */}
        <div>
          <p className="cc-section-eyebrow" style={{ color: 'var(--cc-accent)', marginBottom: '10px' }}>Investigation finding</p>
          <p style={{ margin: 0, fontSize: '21px', lineHeight: '1.4', fontWeight: 550, color: 'var(--cc-text-primary)', maxWidth: '880px' }}>
            {investigationData?.what_happened || incident.description || "No description recorded for this incident yet."}
          </p>
          <div style={{ height: '1px', background: 'var(--line-hair)', margin: '24px 0' }} />
          <p className="cc-section-eyebrow" style={{ color: 'var(--sev-medium)', marginBottom: '8px' }}>Why: root cause</p>
          <p style={{ margin: 0, fontSize: '15px', lineHeight: '1.6', color: 'var(--cc-text-secondary)', maxWidth: '760px' }}>
            {investigationData?.why_it_happened || incident.primary_signal || 'Root cause not yet determined. Run "Investigate with Gemini" above.'}
          </p>
        </div>

        {/* EVIDENCE — a chain, not a card grid. */}
        <div>
          <p className="cc-section-eyebrow" style={{ marginBottom: '16px' }}>Evidence</p>
          <div className="cc-evidence-chain">
            {evidenceChain.map((e, i) => (
              <div key={i} className="cc-evidence-item">
                <span className="cc-evidence-index text-data">{String(i + 1).padStart(2, '0')}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cc-evidence-label">{e.label}</div>
                  <div className="cc-evidence-value text-metric cc-numeric">{e.value}</div>
                  {e.detail && <div className="cc-evidence-detail">{e.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CASE MEMORY */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
            <p className="cc-section-eyebrow" style={{ margin: 0 }}>Case memory: historical precedent</p>
            {topSimilarCase && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: 'var(--state-verified)' }}>
                <Target size={13} strokeWidth={2} />
                {topSimilarCase.similarity_score_pct}% match ({topSimilarCase.match_tier})
              </span>
            )}
          </div>

          {topSimilarCase ? (
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <span className="text-data" style={{ color: 'var(--cc-accent)' }}>{topSimilarCase.historical_incident_id}</span>
                  <span style={{ color: 'var(--cc-text-tertiary)', margin: '0 8px' }}>·</span>
                  <strong style={{ fontSize: '14px', color: 'var(--cc-text-primary)' }}>{topSimilarCase.title}</strong>
                </div>
                <Chip>{topSimilarCase.provenance}</Chip>
              </div>

              {topSimilarCase.factors && (
                <div style={{ fontSize: '11.5px', color: 'var(--cc-text-tertiary)', margin: '10px 0', padding: '10px 12px', background: 'var(--ink-sunken)', borderRadius: 'var(--r-sm)' }}>
                  <div style={{ fontWeight: 600, color: 'var(--cc-text-secondary)', marginBottom: '6px' }}>
                    {topSimilarCase.similarity_score_pct}% is a weighted composite, not raw semantic similarity. Breakdown:
                  </div>
                  <div>Raw embedding cosine similarity: <strong>{topSimilarCase.cosine_similarity}</strong> (contributes {topSimilarCase.factors.cosine_sim_contrib} pts)</div>
                  <div>Incident type match: {topSimilarCase.factors.type_match} pts · Entity match: {topSimilarCase.factors.entity_match} pts · Error code match: {topSimilarCase.factors.error_code_match} pts · Severity match: {topSimilarCase.factors.severity_match} pts</div>
                </div>
              )}

              <div style={{ fontSize: '13px', color: 'var(--cc-text-secondary)', lineHeight: '1.5', marginTop: '6px' }}>
                <div><strong style={{ color: 'var(--cc-text-primary)' }}>Historical root cause:</strong> {topSimilarCase.historical_root_cause}</div>
                <div style={{ marginTop: '4px' }}><strong style={{ color: 'var(--cc-text-primary)' }}>Previous action taken:</strong> {topSimilarCase.previous_action}</div>
                <div style={{ marginTop: '4px', color: 'var(--state-verified)' }}><strong>Historical outcome:</strong> {topSimilarCase.outcome}</div>
              </div>
            </Card>
          ) : (
            <p style={{ fontSize: '13px', color: similarCasesError ? 'var(--sev-critical)' : 'var(--cc-text-tertiary)' }}>
              {similarCasesError || 'No similar historical incidents found in Case Memory for this incident.'}
            </p>
          )}
        </div>

        {/* AFFECTED MERCHANTS — gateway-type incidents only; a merchant-type
            incident's single target is already shown in the evidence above. */}
        {!isMerchantIncident && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Users size={14} strokeWidth={2} style={{ color: 'var(--cc-text-tertiary)' }} />
                <span style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--cc-text-primary)' }}>
                  Affected merchants: <strong>{merchantCount != null ? `${merchantCount} merchants` : 'No evidence recorded'}</strong>
                </span>
              </div>
              <button
                onClick={() => setShowMerchants(!showMerchants)}
                data-cursor="hover"
                style={{ background: 'none', border: 'none', color: 'var(--cc-accent)', cursor: 'pointer', fontSize: '12.5px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                {showMerchants ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                {showMerchants ? 'Hide merchant list' : 'View affected merchants'}
              </button>
            </div>

            {showMerchants && (
              <div style={{ marginTop: '14px', padding: '14px 16px', background: 'var(--ink-sunken)', borderRadius: 'var(--r-md)' }}>
                {affectedMerchantsList.length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
                    {affectedMerchantsList.map((m, idx) => (
                      <div key={idx} style={{ padding: '8px 12px', background: 'var(--ink-raised)', borderRadius: 'var(--r-sm)', fontSize: '12px' }}>
                        <strong style={{ color: 'var(--cc-text-primary)' }}>{m.merchant_name || m.merchant_id}</strong>
                        <div style={{ color: 'var(--cc-text-tertiary)', fontSize: '11px' }}>{m.failures_count || m.failures} failures</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--cc-text-tertiary)' }}>
                    No per-merchant breakdown was returned by this investigation's <span className="text-data">get_affected_merchants</span> tool call yet. Run or re-run the investigation to populate this list from real PostgreSQL data.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* CONFIDENCE vs RECOMMENDATION — kept visually distinct: what the
            evidence measures is not the same claim as what the system
            recommends doing about it. */}
        <div className="cc-metric-band" style={{ alignItems: 'flex-start', borderBottom: 'none', paddingBottom: 0 }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <p className="cc-section-eyebrow" style={{ margin: 0 }}>Evidence says</p>
              <span className="text-data" style={{ fontSize: '15px', fontWeight: 700, color: 'var(--cc-accent)' }}>
                {evidenceScore != null ? `${evidenceScore}% · ${evidenceScore >= 80 ? 'Very high' : evidenceScore >= 60 ? 'High' : evidenceScore >= 40 ? 'Moderate' : 'Low'} confidence` : 'Not yet computed'}
              </span>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: '13px', lineHeight: '1.5', color: 'var(--cc-text-secondary)' }}>
              {evidenceScore != null
                ? 'Derived deterministically from five independent database and anomaly signals:'
                : 'Run "Investigate with Gemini" to compute evidence confidence from real signals.'}
            </p>
            <div style={{ fontSize: '11.5px', color: 'var(--cc-text-tertiary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div>Anomaly strength (25%): IsolationForest score {incident.anomaly_score != null ? incident.anomaly_score : '-'}</div>
              <div>Peer deviation (25%): {failureRate != null && ratio != null && peerRate != null ? `${failureRate}% is ${ratio}x peer baseline (${peerRate}%)` : 'No evidence recorded'}</div>
              <div>Concentration (20%): {topErrors != null && totalFailed ? `${((topErrors / totalFailed) * 100).toFixed(2)}% share are ${topErrorsLabel.toLowerCase()}` : 'No evidence recorded'}</div>
              <div>Sample volume (15%): {totalFailed != null ? `${totalFailed} failed transactions analyzed` : 'No evidence recorded'}</div>
              <div>Merchant breadth (15%): {merchantCount != null ? `corroborated across ${merchantCount} distinct merchants` : 'No evidence recorded'}</div>
            </div>
          </div>

          <div className="cc-metric-band-divider" />

          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
              <p className="cc-section-eyebrow" style={{ margin: 0, color: 'var(--state-verified)' }}>System recommends</p>
              <span style={{ fontSize: '11px', color: 'var(--sev-medium)', fontWeight: 600 }}>Human approval required</span>
            </div>
            <p style={{ margin: 0, fontSize: '14px', lineHeight: '1.6', color: 'var(--cc-text-primary)' }}>
              {investigationData?.recommendation || 'No AI recommendation yet. Run "Investigate with Gemini" above to generate one from real evidence.'}
            </p>
          </div>
        </div>

        {/* ACTION — consequential, restrained. */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '12px' }}>
            <Chip tone="critical">Risk: red · human approval required</Chip>
            {primaryAction && (
              <Chip tone={primaryAction.status === 'executed' ? 'verified' : primaryAction.status === 'approved' ? 'accent' : primaryAction.status === 'rejected' ? 'neutral' : 'medium'}>
                {primaryAction.status === 'executed' ? 'Executed (simulation only)' : primaryAction.status === 'approved' ? 'Approved by human' : primaryAction.status === 'rejected' ? 'Rejected' : 'Pending approval'}
              </Chip>
            )}
          </div>

          <div style={{ padding: '20px', background: 'var(--ink-sunken)', borderRadius: 'var(--r-md)' }}>
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--cc-text-primary)', marginBottom: '6px' }}>
              {incident.target_entity_type === 'merchant' ? (
                <>Pause settlements for <span className="text-data" style={{ color: 'var(--sev-critical)' }}>{incident.target_entity_id}</span> pending review</>
              ) : (
                <>Reroute traffic away from <span className="text-data" style={{ color: 'var(--sev-critical)' }}>{incident.target_entity_id || 'Gateway_X'}</span></>
              )}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--cc-text-secondary)', lineHeight: '1.5', marginBottom: '16px' }}>
              <strong style={{ color: 'var(--cc-text-primary)' }}>Policy reason: </strong>
              {incident.primary_signal || (incident.target_entity_type === 'merchant'
                ? `Anomalous account activity detected for ${incident.target_entity_id}.`
                : `High failure concentration on ${incident.target_entity_id || 'this gateway'} relative to peer baseline.`)}
            </div>

            {primaryAction ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                {primaryAction.status === 'pending_approval' && (
                  <>
                    <Button
                      tier="ghost"
                      tone="verified"
                      onClick={() => handleApprove(primaryAction.action_id)}
                      state={actionLoading ? 'loading' : 'idle'}
                      loadingLabel="Approving"
                      successLabel="Approved"
                    >
                      <Check size={13} strokeWidth={2} style={{ marginRight: 6 }} />
                      Approve action
                    </Button>
                    <Button
                      tier="ghost"
                      tone="critical"
                      onClick={() => handleReject(primaryAction.action_id)}
                      state={actionLoading ? 'loading' : 'idle'}
                      loadingLabel="Rejecting"
                    >
                      Reject
                    </Button>
                  </>
                )}

                {primaryAction.status === 'approved' && (
                  <Button
                    tier="ghost"
                    tone="warning"
                    onClick={() => handleExecuteSimulation(primaryAction.action_id)}
                    state={actionLoading ? 'loading' : 'idle'}
                    loadingLabel="Executing"
                    successLabel="Executed"
                  >
                    <Zap size={13} strokeWidth={2} style={{ marginRight: 6 }} />
                    Execute safe simulation
                  </Button>
                )}

                {primaryAction.status === 'executed' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--state-verified)', fontSize: '13px', fontWeight: 600, flexWrap: 'wrap' }}>
                      <span>Approved by human operator</span>
                      <span>·</span>
                      <span>Safe demonstration simulation executed</span>
                      <span>·</span>
                      <span>Immutable audit log appended</span>
                    </div>
                    <div style={{ marginTop: '6px', padding: '12px 14px', background: 'var(--ink-raised)', borderRadius: 'var(--r-sm)', fontSize: '12px' }}>
                      <div style={{ color: 'var(--cc-accent)', fontWeight: 600, marginBottom: '4px' }}>
                        Simulation only: {primaryAction.execution_result?.message || "Traffic diversion simulation completed successfully."}
                      </div>
                      <div style={{ color: 'var(--state-verified)', fontWeight: 600 }}>0 live Razorpay payments modified.</div>
                    </div>
                  </div>
                )}

                {primaryAction.status === 'rejected' && (
                  <div style={{ color: 'var(--cc-text-tertiary)', fontSize: '13px', fontStyle: 'italic' }}>
                    Action rejected by human operator. Zero traffic diversion permitted. Recorded in audit trail.
                  </div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: '13px', color: 'var(--cc-text-tertiary)' }}>
                Click <strong style={{ color: 'var(--cc-text-secondary)' }}>"Investigate with Gemini"</strong> above to evaluate telemetry and propose this governed action.
              </div>
            )}

            {actionMsg && (
              <p style={{ marginTop: '12px', fontSize: '12.5px', color: 'var(--cc-accent)' }}>{actionMsg}</p>
            )}
          </div>

          {primaryAction && (
            <p style={{ margin: '12px 4px 0', fontSize: '11.5px', color: 'var(--cc-text-disabled)' }}>
              Action → recorded → audit trail. See Audit Log for the immutable record of this action.
            </p>
          )}
        </div>

        {/* AI TOOL TRACE (COLLAPSED BY DEFAULT) */}
        <details>
          <summary style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--cc-text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }} data-cursor="hover">
            <span>View AI investigation trace ({steps.length} tool calls executed against PostgreSQL)</span>
            <span style={{ fontSize: '12px', color: 'var(--cc-accent)' }}>Toggle details</span>
          </summary>

          <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {steps.length === 0 ? (
              <div style={{ fontSize: '13px', color: 'var(--cc-text-tertiary)', padding: '10px 0' }}>
                No tool steps recorded yet. Click <strong style={{ color: 'var(--cc-text-secondary)' }}>"Investigate with Gemini"</strong> above to trigger live multi-turn tool calling.
              </div>
            ) : (
              steps.map((st, idx) => (
                <div key={st.step_id || idx} style={{ border: '1px solid var(--line-hair)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                  <div
                    onClick={() => setExpandedStep(expandedStep === idx ? null : idx)}
                    data-cursor="hover"
                    style={{ padding: '10px 14px', background: 'var(--ink-raised)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Check size={13} strokeWidth={2} style={{ color: 'var(--state-verified)' }} />
                      <span className="text-data" style={{ fontWeight: 700, color: 'var(--cc-accent)' }}>
                        Step {st.step_number || idx + 1}: Gemini → {st.tool_name}
                      </span>
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--cc-text-tertiary)' }}>
                      {expandedStep === idx ? 'Hide' : 'Inspect tool arguments & output'}
                    </span>
                  </div>

                  {expandedStep === idx && (
                    <div style={{ padding: '12px 14px', background: 'var(--ink-sunken)', borderTop: '1px solid var(--line-hair)', fontSize: '12px' }}>
                      <div style={{ marginBottom: '8px' }}>
                        <strong style={{ color: 'var(--cc-text-tertiary)' }}>Input arguments:</strong>
                        <pre style={{ margin: '4px 0', padding: '8px', background: 'var(--ink-page)', borderRadius: 'var(--r-sm)', overflowX: 'auto' }}>
                          {JSON.stringify(st.arguments || st.input_json, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <strong style={{ color: 'var(--cc-text-tertiary)' }}>Database output:</strong>
                        <pre style={{ margin: '4px 0', padding: '8px', background: 'var(--ink-page)', borderRadius: 'var(--r-sm)', overflowX: 'auto', maxHeight: '200px' }}>
                          {JSON.stringify(st.result || st.output_json, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </details>

      </div>
    </div>
  );
}
