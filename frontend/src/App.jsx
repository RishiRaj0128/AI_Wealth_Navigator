import React, { useState, useEffect, useRef } from 'react';
import Header from './components/Header';
import RouteProgress from './components/RouteProgress';
import PageTransition from './components/PageTransition';
import CustomCursor from './components/CustomCursor';
import OverviewView from './components/OverviewView';
import FinancialHealthView from './components/FinancialHealthView';
import MyDataView from './components/MyDataView';
import DataView from './components/DataView';
import InvestigationView from './components/InvestigationView';
import FinancialCopilotView from './components/FinancialCopilotView';
import GoalsView from './components/GoalsView';
import AuditView from './components/AuditView';
import IncidentLabView from './components/IncidentLabView';
import {
  fetchHealth,
  fetchStats,
  fetchSourceStats,
  fetchIncidents,
  fetchIncidentDetail,
  fetchAIStatus,
  triggerAnomalyDetection
} from './api';

// The four tabs that are the product. Everything else is inherited
// operations tooling reached through the header's Platform menu.
const WEALTH_TABS = ['overview', 'goals', 'copilot', 'mydata'];

export default function App() {
  // Primary journey: 'overview' (Financial Health) -> 'goals' -> 'copilot' -> 'mydata'.
  // Inherited operations tooling ('incidents' | 'data' | 'investigation' | 'audit')
  // is reachable only via the header's Platform menu.
  const [activeTab, setActiveTab] = useState('overview');

  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [sourceStats, setSourceStats] = useState(null);
  const [aiStatus, setAiStatus] = useState({ provider: 'gemini', configured: false, model: 'gemini-3.5-flash-lite' });
  const [incidents, setIncidents] = useState([]);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [isDetecting, setIsDetecting] = useState(false);
  // Incremented by the header Refresh. Every wealth page takes this as a
  // dependency, so one control refreshes whatever the user is looking at.
  const [refreshToken, setRefreshToken] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notification, setNotification] = useState(null);

  // Custom-cursor preference (shell, Phase 2): defaults on, persisted
  // locally, toggled from the header. Guards inside CustomCursor itself
  // (pointer:fine, prefers-reduced-motion) decide whether it actually
  // mounts regardless of this preference.
  const [cursorEnabled, setCursorEnabled] = useState(() => {
    try {
      const stored = localStorage.getItem('moneyops-cc-cursor-enabled');
      return stored === null ? true : stored === 'true';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('moneyops-cc-cursor-enabled', String(cursorEnabled));
    } catch {
      // localStorage unavailable (private mode, etc.) — preference just
      // won't persist across reloads; the toggle still works this session.
    }
  }, [cursorEnabled]);

  // Picks which incident to show when nothing has been explicitly selected yet.
  // `ORDER BY detected_at DESC` alone is wrong here: detected_at gets refreshed
  // every time anomaly detection re-confirms an ALREADY-investigated incident,
  // so a fully-investigated incident can look "newest" and silently outrank a
  // genuinely pending one — making the app look like investigation happened
  // automatically. Pending incidents (not yet investigated) always win; only
  // fall back to "newest overall" when there is no pending incident to show.
  const pickDefaultIncident = (incList) => {
    // 'rejected' is a final human decision, same as 'resolved' — must be
    // excluded here too, or a rejected-without-investigating incident could
    // be auto-selected as the default incident shown on the Investigation tab.
    const active = incList.filter(i => i.status !== 'resolved' && i.status !== 'rejected');
    const pending = active.filter(i => i.investigation_status !== 'investigated');
    const pool = pending.length > 0 ? pending : (active.length > 0 ? active : incList);
    return pool.slice().sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at))[0];
  };

  const loadData = async () => {
    try {
      const [hData, sData, srcData, incList, aiInfo] = await Promise.all([
        fetchHealth().catch(() => ({ status: "offline", database: "PostgreSQL", razorpay_configured: false, gemini_configured: false })),
        fetchStats().catch(() => null),
        fetchSourceStats().catch(() => null),
        fetchIncidents().catch(() => []),
        fetchAIStatus().catch(() => ({ provider: 'gemini', configured: false, model: 'gemini-3.5-flash-lite' }))
      ]);

      setHealth(hData);
      setStats(sData);
      setSourceStats(srcData);
      setIncidents(incList || []);
      setAiStatus(aiInfo || { provider: 'gemini', configured: false, model: 'gemini-3.5-flash-lite' });

      // Functional updater — this callback (and the setInterval that calls loadData)
      // is created once on mount with an empty-dependency effect below, so a plain
      // read of `selectedIncident` here would always see its value from that first
      // render (null) and unconditionally reset the selection back to incList[0]
      // on every single 5s poll, clobbering any incident the user had navigated to.
      // The functional form always receives the true current state instead.
      if (incList && incList.length > 0) {
        setSelectedIncident(prev => {
          // A real prior selection (the user's own click, or an earlier default
          // pick) stays sticky across polls as long as it still exists — this is
          // what "explicit selection" means with no URL-based routing in this app.
          if (!prev || !incList.some(i => i.incident_id === prev.incident_id)) {
            return pickDefaultIncident(incList);
          }
          return incList.find(i => i.incident_id === prev.incident_id) || prev;
        });
      } else {
        setSelectedIncident(null);
      }
    } catch (err) {
      console.error("Error loading dashboard data:", err);
    }
  };

  // One handler behind the header Refresh: re-fetch the shell's own state
  // (health, AI availability) AND signal every mounted page to reload. The
  // in-flight guard stops rapid clicks from stacking requests.
  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await loadData();
      setRefreshToken(t => t + 1);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Incident polling exists for the operations screens. It is scoped to those
  // screens rather than running forever: a personal-finance user sitting on
  // Overview has no reason to poll an incident feed every five seconds.
  useEffect(() => {
    if (WEALTH_TABS.includes(activeTab)) return undefined;
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [activeTab]);

  // Background state glow (design brief §4.3): hue follows the highest
  // severity among currently active incidents — the same `incidents` state
  // and the same active predicate ('resolved'/'rejected' excluded) already
  // used everywhere else in the app (Overview, Header, InvestigationView).
  // No second source of incident truth is created for this.
  //
  // Rendered as two stacked glow layers, faded SEQUENTIALLY (see the long
  // comment above .bg-glow-layer in index.css): the outgoing hue fades
  // fully to 0 over 600ms, then the incoming hue is swapped in and faded up
  // over the next 600ms — the two hues are never on-screen together, which
  // is what actually avoids the muddy magenta midpoint (a simultaneous
  // two-layer crossfade does not; it alpha-blends the same as RGB
  // interpolation would). Total budget stays the brief's 1200ms.
  // Route-aware atmosphere (final polish pass): #bg-layers lives outside the
  // React tree (static markup in index.html), so its per-route intensity is
  // set via a plain DOM attribute rather than a prop — the CSS rule this
  // drives is in index.css next to the rest of the glow-layer system.
  useEffect(() => {
    document.getElementById('bg-layers')?.setAttribute('data-route', activeTab);
  }, [activeTab]);

  const activeGlowLayer = useRef('a');
  useEffect(() => {
    // Severity-driven atmosphere is an operations idea: it made the whole
    // product glow red because an unrelated payment incident was open. On the
    // wealth pages the ambient hue is always the neutral brand accent; the
    // severity tint survives only where it means something.
    const isWealthRoute = WEALTH_TABS.includes(activeTab);
    const active = incidents.filter(i => i.status !== 'resolved' && i.status !== 'rejected');
    const bySeverity = ['critical', 'high', 'medium', 'low'];
    const highest = isWealthRoute ? null : bySeverity.find(sev => active.some(i => i.severity === sev));
    const hue = highest ? `var(--sev-${highest})` : 'var(--cc-accent)';

    const current = activeGlowLayer.current;
    const next = current === 'a' ? 'b' : 'a';
    const currentEl = document.querySelector(`.bg-glow-layer[data-layer="${current}"]`);
    const nextEl = document.querySelector(`.bg-glow-layer[data-layer="${next}"]`);
    if (!currentEl || !nextEl) return;

    const currentHue = currentEl.style.getPropertyValue(`--glow-hue-${current}`);
    if (currentHue === hue) return; // already showing this hue, nothing to do

    const fadeIn = () => {
      nextEl.style.setProperty(`--glow-hue-${next}`, hue);
      requestAnimationFrame(() => {
        nextEl.style.opacity = '0.16';
      });
    };

    let fadeInTimer;
    if (currentHue === '') {
      // First paint — nothing is showing yet, so there's no outgoing hue to
      // fade out first. Fade the initial hue straight in.
      fadeIn();
    } else {
      currentEl.style.opacity = '0';
      fadeInTimer = setTimeout(fadeIn, 600);
    }
    activeGlowLayer.current = next;

    return () => { if (fadeInTimer) clearTimeout(fadeInTimer); };
  }, [incidents, activeTab]);

  const handleSelectAndInvestigate = async (inc) => {
    setSelectedIncident(inc);
    try {
      const detailed = await fetchIncidentDetail(inc.incident_id);
      setSelectedIncident(detailed);
    } catch (e) {
      console.warn("Detail fetch failed, using list object:", e);
    }
    setActiveTab('investigation');
  };

  const handleTriggerDetection = async () => {
    setIsDetecting(true);
    setNotification(null);
    try {
      const res = await triggerAnomalyDetection();
      setNotification({
        type: "success",
        text: `✓ Detection scan complete. ${res.anomalies_detected} anomalies evaluated across ${res.records_analyzed} PostgreSQL records.`
      });
      await loadData();
    } catch (e) {
      setNotification({
        type: "error",
        text: `Detection failed: ${e.message}`
      });
    } finally {
      setIsDetecting(false);
    }
  };

  return (
    <div className="app-container" style={{ minHeight: "100vh", background: "transparent", color: "var(--text)" }}>
      
      {/* 1. TOP HEADER & 4-VIEW NAVIGATION */}
      {/* Single source of truth: an incident's own `status` field ('open' vs
          'resolved'/'rejected') is exactly what Overview's Active/Resolved
          split and the Investigation workspace's Active-Pending/Completed
          split both use. The nav badge previously ALSO required
          investigation_status !== 'investigated' to count as "pending" —
          which meant an active incident that had already been investigated
          (and was sitting at awaiting-approval/approved) silently vanished
          from BOTH the pending and done counts shown here, producing a nav
          total that didn't match the actual number of active incidents
          anywhere else in the app. Deriving both counts from status alone,
          with no independent condition, is what guarantees they can never
          drift apart again. */}
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        health={health}
        aiStatus={aiStatus}
        pendingInvestigationCount={incidents.filter(i => i.status !== 'resolved' && i.status !== 'rejected').length}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
        cursorEnabled={cursorEnabled}
        onToggleCursor={() => setCursorEnabled(v => !v)}
      />

      <RouteProgress routeKey={activeTab} />
      <CustomCursor enabled={cursorEnabled} />

      {/* 2. GLOBAL NOTIFICATION BANNER */}
      {notification && (
        <div style={{
          maxWidth: "1600px",
          margin: "16px auto 0",
          padding: "10px 24px"
        }}>
          <div style={{
            padding: "10px 16px",
            borderRadius: "6px",
            fontSize: "13px",
            background: notification.type === "success" ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
            border: `1px solid ${notification.type === "success" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
            color: notification.type === "success" ? "#10b981" : "#f87171",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }}>
            <span>{notification.text}</span>
            <button onClick={() => setNotification(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>✕</button>
          </div>
        </div>
      )}

      {/* 3. PRIMARY WORKSPACE CONTAINER */}
      <main style={{ maxWidth: "1600px", margin: "0 auto", padding: "24px" }}>
        <PageTransition routeKey={activeTab}>
          {/* The landing experience: the user's own financial position, goals
              and next actions. Nothing operational appears here. */}
          {activeTab === 'overview' && (
            <FinancialHealthView onNavigate={setActiveTab} refreshToken={refreshToken} />
          )}

          {activeTab === 'goals' && (
            <GoalsView onNavigate={setActiveTab} refreshToken={refreshToken} />
          )}

          {activeTab === 'mydata' && (
            <MyDataView refreshToken={refreshToken} />
          )}

          {/* Inherited operations tooling, reached only through the header's
              Platform menu — kept working, kept out of the way. */}
          {activeTab === 'incident_lab' && (
            <IncidentLabView
              onSelectIncident={handleSelectAndInvestigate}
              onNavigate={setActiveTab}
            />
          )}

          {activeTab === 'incidents' && (
            <OverviewView
              stats={stats}
              sourceStats={sourceStats}
              incidents={incidents}
              onSelectIncident={handleSelectAndInvestigate}
              onTriggerDetection={handleTriggerDetection}
              isDetecting={isDetecting}
            />
          )}

          {activeTab === 'data' && (
            <DataView
              onRefreshAll={loadData}
              incidents={incidents}
              onOpenIncident={handleSelectAndInvestigate}
              onOpenCopilot={() => setActiveTab('copilot')}
            />
          )}

          {activeTab === 'investigation' && (
            <InvestigationView
              incident={selectedIncident}
              incidents={incidents}
              onSelectIncident={handleSelectAndInvestigate}
              aiStatus={aiStatus}
              onRefreshAll={loadData}
            />
          )}

          {activeTab === 'copilot' && (
            <FinancialCopilotView aiStatus={aiStatus} refreshToken={refreshToken} />
          )}

          {activeTab === 'audit' && (
            <AuditView />
          )}
        </PageTransition>
      </main>


    </div>
  );
}

