import React, { useState } from 'react';
import {
  Button, Card, SeverityRail, Chip, Metric, SegmentedControl, Skeleton, ToastProvider, useToast, Drawer,
} from './primitives';

// Phase 3 — isolated primitive showcase. Mounted only behind #showcase (see
// main.jsx) so this never touches, wraps, or interferes with the real App
// and its five production pages. Every primitive here is exercised with
// real state (not just a static render) so hover/focus/active/loading/
// success/keyboard behavior can actually be driven and verified.
function ButtonSection() {
  const [approveState, setApproveState] = useState('idle');
  const [triggerCount, setTriggerCount] = useState(0);

  // idle -> loading -> success (900ms, owned internally by Button) -> idle.
  // Re-clickable afterward — triggerCount proves each click is a fresh,
  // independent run, not a button stuck replaying its first click.
  const runApprove = () => {
    setTriggerCount(c => c + 1);
    setApproveState('loading');
    setTimeout(() => setApproveState('success'), 900);
    // Button auto-reverts success -> idle itself after 900ms; this just
    // stops holding 'success' in our own prop so a later click starts clean.
    setTimeout(() => setApproveState('idle'), 900 + 900 + 50);
  };

  return (
    <section className="showcase-section">
      <h2>Button: 3 tiers x 3 async states (Phase 3.1)</h2>
      <div className="showcase-row">
        <Button tier="primary">Primary action</Button>
        <Button tier="secondary">Secondary action</Button>
        <Button tier="ghost">Ghost action</Button>
        <Button tier="primary" disabled>Disabled primary</Button>
      </div>
      <div className="showcase-row">
        <Button
          tier="primary"
          state={approveState}
          loadingLabel="Approving"
          successLabel="Approved"
          onClick={runApprove}
        >
          Approve
        </Button>
        <span className="showcase-note" style={{ margin: 0 }}>
          triggered {triggerCount}x (click again after it settles back to "Approve")
        </span>
      </div>
      <div className="showcase-row">
        <Button tier="secondary" state="loading" loadingLabel="Asking">Ask</Button>
        <Button tier="primary" state="success" successLabel="Executed">Execute</Button>
      </div>
      <p className="showcase-note">
        Click "Approve" to drive idle → loading (12px spinner, "Approving") → success
        (checkmark, "Approved", held 900ms) → back to idle automatically, live.
      </p>

      <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--cc-text-tertiary)', margin: '24px 0 10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Semantic destructive/irreversible tone: never a filled rectangle
      </h3>
      <div className="showcase-row">
        <Button tier="ghost" tone="critical">Reject</Button>
        <Button tier="ghost" tone="critical" disabled>Reject (disabled)</Button>
        <Button tier="ghost" tone="warning">Execute</Button>
        <Button tier="secondary" tone="verified">Mark Verified</Button>
        <Button tier="primary" tone="critical">Primary + critical tone (fill still stripped)</Button>
      </div>
    </section>
  );
}

function CardSection() {
  const [approved, setApproved] = useState(false);
  return (
    <section className="showcase-section">
      <h2>Card + SeverityRail: the signature primitive</h2>
      <div className="showcase-grid">
        <Card severity="critical" confidence={88}>
          <div className="showcase-card-title">Gateway_ICICI Timeout Concentration</div>
          <div className="showcase-card-sub">critical · 88% confidence (hover the rail edge)</div>
        </Card>
        <Card severity="medium" confidence={42}>
          <div className="showcase-card-title">Duplicate Refund Activity</div>
          <div className="showcase-card-sub">medium · 42% confidence</div>
        </Card>
        <Card severity="critical" confidence={95} approved={approved} onClick={() => setApproved(a => !a)}>
          <div className="showcase-card-title">Click to toggle approval</div>
          <div className="showcase-card-sub">{approved ? 'approved (rail drained to verified)' : 'not yet approved'}</div>
        </Card>
      </div>
      <p className="showcase-note">Standalone rail at varying confidence:</p>
      <div className="showcase-row" style={{ height: 60, alignItems: 'stretch' }}>
        <SeverityRail severity="critical" confidence={20} />
        <SeverityRail severity="high" confidence={50} />
        <SeverityRail severity="medium" confidence={75} />
        <SeverityRail severity="low" confidence={95} />
      </div>
    </section>
  );
}

function ChipSection() {
  return (
    <section className="showcase-section">
      <h2>Chip: compact, restrained</h2>
      <div className="showcase-row">
        <Chip>NEUTRAL</Chip>
        <Chip tone="accent">ACCENT</Chip>
        <Chip tone="critical">CRITICAL</Chip>
        <Chip tone="verified">VERIFIED</Chip>
        <Chip tone="critical" interactive onClick={() => {}}>INTERACTIVE: TAB TO ME</Chip>
      </div>
    </section>
  );
}

function MetricSection() {
  return (
    <section className="showcase-section">
      <h2>Metric: forensic numbers</h2>
      <div className="showcase-row">
        <Metric label="Potential Exposure" value="₹2,69,810.22" delta="12.4%" deltaDirection="down" sub="vs. last 7 days" />
        <Metric label="Active Incidents" value="3" delta="1" deltaDirection="up" sub="vs. yesterday" />
        <Metric label="Failure Rate" value="13.11%" sub="1.96x peer baseline" />
      </div>
    </section>
  );
}

function SegmentedSection() {
  const [value, setValue] = useState('payments');
  return (
    <section className="showcase-section">
      <h2>SegmentedControl: keyboard accessible</h2>
      <SegmentedControl
        label="Data source"
        value={value}
        onChange={setValue}
        options={[
          { value: 'payments', label: 'Payments' },
          { value: 'orders', label: 'Orders' },
          { value: 'refunds', label: 'Refunds' },
          { value: 'webhooks', label: 'Webhooks' },
        ]}
      />
      <p className="showcase-note">Focus it, then use arrow keys / Home / End. Current: <strong>{value}</strong></p>
    </section>
  );
}

function SkeletonSection() {
  return (
    <section className="showcase-section">
      <h2>Skeleton: matches real geometry</h2>
      <div className="showcase-row" style={{ alignItems: 'flex-start' }}>
        <div style={{ width: 260 }}>
          <Skeleton variant="text" lines={3} />
        </div>
        <Skeleton variant="block" width={140} height={80} />
        <Skeleton variant="block" width={44} height={44} borderRadius="50%" />
      </div>
    </section>
  );
}

function ToastSection() {
  const { push } = useToast();
  return (
    <section className="showcase-section">
      <h2>Toast: minimal, non-intrusive</h2>
      <div className="showcase-row">
        <Button tier="secondary" onClick={() => push('Detection scan complete.', 'success')}>Trigger success</Button>
        <Button tier="secondary" onClick={() => push('Investigation failed to reach Gemini.', 'error')}>Trigger error</Button>
        <Button tier="secondary" onClick={() => push('3 new incidents detected.', 'info')}>Trigger info</Button>
      </div>
    </section>
  );
}

function DrawerSection() {
  const [open, setOpen] = useState(false);
  return (
    <section className="showcase-section">
      <h2>Drawer: focus trap, Escape, backdrop</h2>
      <Button tier="secondary" onClick={() => setOpen(true)}>Open drawer</Button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Incident Detail">
        <p style={{ color: 'var(--cc-text-secondary)', marginBottom: 16 }}>
          Tab cycles only within this drawer. Escape closes it. Focus returns to the
          "Open drawer" button on close.
        </p>
        <Button tier="primary" onClick={() => setOpen(false)}>A focusable action</Button>
      </Drawer>
    </section>
  );
}

export default function PrimitivesShowcase() {
  return (
    <ToastProvider>
      <div className="showcase-root">
        <header className="showcase-header">
          <div>
            <h1>Phase 3: Primitive Showcase</h1>
            <p>Isolated dev surface. Not part of the production app; mounted only behind #showcase.</p>
          </div>
        </header>
        <ButtonSection />
        <CardSection />
        <ChipSection />
        <MetricSection />
        <SegmentedSection />
        <SkeletonSection />
        <ToastSection />
        <DrawerSection />
      </div>
    </ToastProvider>
  );
}
