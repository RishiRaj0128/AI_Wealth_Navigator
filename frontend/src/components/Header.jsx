import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LayoutGrid, Database, Search, MessageCircle, ScrollText, Target, Settings2, Activity, RefreshCw } from 'lucide-react';

// The four tabs that ARE the product. A first-time visitor should be able to
// walk Overview -> Goals -> Wealth AI and have seen the whole value
// proposition without meeting a single operational screen.
const NAV_ITEMS = [
  { key: 'overview', Icon: LayoutGrid, label: 'Overview' },
  { key: 'goals', Icon: Target, label: 'Goals & What-If' },
  { key: 'copilot', Icon: MessageCircle, label: 'Wealth AI' },
  { key: 'mydata', Icon: Database, label: 'Data' },
];

// Inherited operational tooling from the platform this product was built on.
// Deliberately kept OUT of the primary navigation: it is still reachable for
// anyone who wants it, but it no longer competes with the wealth journey or
// frames the app as a payment-operations console.
const PLATFORM_NAV_ITEMS = [
  { key: 'incidents', Icon: Activity, label: 'Operations Monitor' },
  { key: 'investigation', Icon: Search, label: 'Investigation' },
  { key: 'data', Icon: Database, label: 'Operations Data' },
  { key: 'audit', Icon: ScrollText, label: 'Audit Log' },
];

// Rolls each digit vertically when the number changes (odometer-style),
// rather than just swapping the text — this is the "digit roll" the shell
// brief asks for on the pending-count badge. Framer Motion only, no re-flow
// of surrounding layout since each digit slot has a fixed width/height.
function RollingNumber({ value }) {
  const digits = String(value).split('');
  return (
    <span style={{ display: 'inline-flex', fontVariantNumeric: 'tabular-nums' }}>
      {digits.map((d, i) => (
        <span key={i} style={{ position: 'relative', display: 'inline-block', height: '1em', width: '0.62em', overflow: 'hidden' }}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={d}
              initial={{ y: 8, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -8, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              style={{ position: 'absolute', left: 0, right: 0 }}
            >
              {d}
            </motion.span>
          </AnimatePresence>
        </span>
      ))}
    </span>
  );
}

// A thin outward-fading ring around the badge — NOT a bounce, NOT a glow —
// fired only on an actual increase (never on decrease or on first mount).
function PendingBadge({ count }) {
  const prevRef = useRef(count);
  const [pulseKey, setPulseKey] = useState(0);

  useEffect(() => {
    if (count > prevRef.current) {
      setPulseKey(k => k + 1);
    }
    prevRef.current = count;
  }, [count]);

  if (count <= 0) return null;

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <AnimatePresence>
        {pulseKey > 0 && (
          <motion.span
            key={pulseKey}
            initial={{ opacity: 0.55, scale: 1 }}
            animate={{ opacity: 0, scale: 1.6 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            style={{
              position: 'absolute', inset: '-2px', borderRadius: '10px',
              border: '1px solid rgba(239, 68, 68, 0.9)', pointerEvents: 'none'
            }}
          />
        )}
      </AnimatePresence>
      <span style={{
        padding: '1px 6px', borderRadius: '10px', background: '#ef4444', color: '#fff',
        fontSize: '10px', fontWeight: '800', whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: '3px'
      }}>
        <RollingNumber value={count} /> pending
      </span>
    </span>
  );
}

function NavTab({ item, isActive, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        position: 'relative',
        padding: '7px 12px',
        borderRadius: '6px',
        border: 'none',
        background: 'transparent',
        color: isActive ? '#fff' : 'var(--text-muted)',
        fontSize: '13px',
        fontWeight: '700',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        overflow: 'visible'
      }}
    >
      {isActive && (
        <motion.span
          layoutId="nav-active-pill"
          transition={{ type: 'spring', stiffness: 500, damping: 36 }}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'var(--primary)',
            borderRadius: '6px',
            zIndex: 0
          }}
        />
      )}
      <span style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: '6px' }} title={item.label}>
        <item.Icon size={13} strokeWidth={2} />
        <span className="cc-nav-label">{item.label}</span>
      </span>
    </button>
  );
}

const CURSOR_PREF_KEY = 'moneyops-cc-cursor-enabled';

export default function Header({
  activeTab,
  onTabChange,
  health,
  aiStatus,
  pendingInvestigationCount = 0,
  onRefresh,
  isRefreshing = false,
  cursorEnabled = true,
  onToggleCursor
}) {
  const [scrolled, setScrolled] = useState(false);
  const [platformOpen, setPlatformOpen] = useState(false);
  const isPlatformActive = PLATFORM_NAV_ITEMS.some(i => i.key === activeTab);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // A dropdown that can only be closed by clicking its own trigger is a trap
  // for keyboard users; Escape and any outside click dismiss it too.
  useEffect(() => {
    if (!platformOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPlatformOpen(false); };
    const onClick = (e) => {
      if (!e.target.closest?.('[data-platform-menu]')) setPlatformOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [platformOpen]);

  const isDataOnline =
    health?.database_status === 'online' ||
    (health?.database_status === undefined && health?.status === 'healthy');
  const isBackendReachable = Boolean(health) && health?.status !== 'offline';
  const isGeminiConfigured = aiStatus?.configured === true;

  return (
    <header style={{
      borderBottom: '1px solid var(--border)',
      background: scrolled ? 'rgba(10, 14, 18, 0.92)' : 'rgba(15, 23, 42, 0.85)',
      backdropFilter: scrolled ? 'blur(16px)' : 'blur(10px)',
      position: 'sticky',
      top: 0,
      zIndex: 100,
      padding: '0 20px',
      transition: 'background 220ms var(--ease-inout), backdrop-filter 220ms var(--ease-inout), box-shadow 220ms var(--ease-inout)',
      boxShadow: scrolled ? '0 1px 0 rgba(0,0,0,0.4)' : 'none'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: scrolled ? '48px' : '56px',
        maxWidth: '1600px',
        margin: '0 auto',
        transition: 'height 220ms var(--ease-inout)'
      }}>

        {/* Left: Branding & Tagline */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0, whiteSpace: 'nowrap' }}>
          <div style={{
            width: '34px',
            height: '34px',
            borderRadius: '8px',
            background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 12px rgba(16, 185, 129, 0.4)',
            color: '#fff',
            fontWeight: '800',
            fontSize: '16px',
            flexShrink: 0
          }}>
            W
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '1.1rem', fontWeight: 800, letterSpacing: '-0.02em', color: '#fff' }}>
                Wealth Navigator AI
              </span>
              <span style={{
                fontSize: '10px',
                padding: '2px 8px',
                borderRadius: '12px',
                background: 'rgba(16, 185, 129, 0.15)',
                color: '#10b981',
                fontWeight: '700'
              }}>
                AI Wellness
              </span>
            </div>
            <AnimatePresence initial={false}>
              {!scrolled && (
                <motion.p
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }}
                  style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0, fontWeight: 500, overflow: 'hidden' }}
                >
                  Personal Financial Wellness &amp; Guidance
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Middle: the four primary Wealth Navigator tabs.
            minWidth:0 + overflowX:auto (rather than flexShrink:0) is what
            keeps this responsive: below ~1024px there isn't room for
            branding + all tabs + the status cluster at their natural
            widths, so the nav becomes an internally-scrollable strip
            instead of forcing the whole header (and page) wider than the
            viewport. */}
        <nav style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0, 0, 0, 0.25)', padding: '4px', borderRadius: '8px', border: '1px solid var(--border)', flexShrink: 1, minWidth: 0, overflowX: 'auto', whiteSpace: 'nowrap' }}>
          {NAV_ITEMS.map(item => (
            <NavTab
              key={item.key}
              item={item}
              isActive={activeTab === item.key}
              onClick={() => onTabChange(item.key)}
            />
          ))}

          {/* Divider, then the inherited operational tooling behind one
              muted control. Present for anyone who needs it, absent from
              the journey for everyone who doesn't. */}
          <span style={{ width: '1px', height: '18px', background: 'var(--border)', margin: '0 4px', flexShrink: 0 }} />
          <div style={{ position: 'relative', flexShrink: 0 }} data-platform-menu>
            <button
              onClick={(e) => { e.stopPropagation(); setPlatformOpen(v => !v); }}
              title="Inherited operations tooling"
              aria-expanded={platformOpen}
              style={{
                padding: '7px 10px',
                borderRadius: '6px',
                border: 'none',
                background: isPlatformActive ? 'rgba(255,255,255,0.06)' : 'transparent',
                color: isPlatformActive ? 'var(--cc-text-secondary)' : 'var(--text-muted)',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <Settings2 size={13} strokeWidth={2} />
              <span className="cc-nav-label">Platform</span>
            </button>

            <AnimatePresence>
              {platformOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.14 }}
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    right: 0,
                    minWidth: '210px',
                    background: 'rgba(15, 23, 42, 0.98)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '6px',
                    boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                    zIndex: 200
                  }}
                >
                  <p style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', margin: '4px 8px 6px', fontWeight: 700 }}>
                    Inherited operations tooling
                  </p>
                  {PLATFORM_NAV_ITEMS.map(item => (
                    <button
                      key={item.key}
                      onClick={() => { onTabChange(item.key); setPlatformOpen(false); }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        width: '100%',
                        padding: '8px 10px',
                        borderRadius: '6px',
                        border: 'none',
                        background: activeTab === item.key ? 'rgba(255,255,255,0.07)' : 'transparent',
                        color: activeTab === item.key ? '#fff' : 'var(--text-muted)',
                        fontSize: '12.5px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                    >
                      <item.Icon size={13} strokeWidth={2} />
                      {item.label}
                      {item.key === 'investigation' && pendingInvestigationCount > 0 && (
                        <span style={{ marginLeft: 'auto' }}>
                          <PendingBadge count={pendingInvestigationCount} />
                        </span>
                      )}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </nav>

        {/* Right: Live Connection Indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, whiteSpace: 'nowrap' }}>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <span
              style={{ width: '6px', height: '6px', borderRadius: '50%', background: isDataOnline ? 'var(--state-verified)' : 'var(--sev-critical)', flexShrink: 0 }}
              aria-hidden="true"
            ></span>
            <span className="cc-header-status-text">
              Data: <strong style={{ color: 'var(--text)' }}>
                {isDataOnline ? 'Connected' : (isBackendReachable ? 'Unavailable' : 'Offline')}
              </strong>
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <span
              style={{ width: '6px', height: '6px', borderRadius: '50%', background: isGeminiConfigured ? 'var(--state-verified)' : 'var(--sev-medium)', flexShrink: 0 }}
              aria-hidden="true"
            ></span>
            <span className="cc-header-status-text">
              AI: <strong style={{ color: 'var(--text)' }}>{isGeminiConfigured ? 'Ready' : 'Unavailable'}</strong>
            </span>
          </div>

          {/* Custom-cursor settings toggle — persisted locally; the native
              cursor remains fully functional whether this is on or off. */}
          <button
            onClick={onToggleCursor}
            title={cursorEnabled ? 'Disable custom cursor' : 'Enable custom cursor'}
            aria-pressed={cursorEnabled}
            style={{
              padding: '6px 8px',
              borderRadius: '6px',
              background: cursorEnabled ? 'rgba(76, 111, 255, 0.12)' : 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border)',
              color: cursorEnabled ? 'var(--cc-accent)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '12px',
              flexShrink: 0
            }}
          >
            ◎
          </button>

          {/* Refresh: re-fetches the shell's own state and signals every
              mounted page to reload. Disabled while in flight so repeated
              clicks cannot stack requests. */}
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            title={isRefreshing ? 'Refreshing…' : 'Refresh data'}
            aria-label={isRefreshing ? 'Refreshing data' : 'Refresh data'}
            aria-busy={isRefreshing}
            style={{
              padding: '6px 8px',
              borderRadius: '6px',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border)',
              color: isRefreshing ? 'var(--cc-accent)' : 'var(--text-muted)',
              cursor: isRefreshing ? 'default' : 'pointer',
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <RefreshCw
              size={13}
              strokeWidth={2}
              style={isRefreshing ? { animation: 'cc-spin 900ms linear infinite' } : undefined}
            />
          </button>

        </div>

      </div>
    </header>
  );
}

export { CURSOR_PREF_KEY };
