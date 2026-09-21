import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LayoutGrid, Database, Search, MessageCircle, ScrollText, Target, RefreshCw } from '../icons';

const NAV_ITEMS = [
  { key: 'overview', Icon: LayoutGrid, label: 'Financial Overview' },
  { key: 'copilot', Icon: MessageCircle, label: 'AI Advisor' },
  { key: 'goals', Icon: Target, label: 'Goals & Scenarios' },
  { key: 'data', Icon: Database, label: 'Data & Documents' },
  { key: 'investigation', Icon: Search, label: 'Investigation' },
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
              position: 'absolute', inset: '-2px', borderRadius: '4px',
              border: '1px solid rgba(239, 68, 68, 0.9)', pointerEvents: 'none'
            }}
          />
        )}
      </AnimatePresence>
      <span style={{
        padding: '1px 6px', borderRadius: '4px', background: '#ef4444', color: '#fff',
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

export default function Header({
  activeTab,
  onTabChange,
  health,
  stats,
  aiStatus,
  pendingInvestigationCount = 0,
  investigatedCount = 0,
  onRefresh
}) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const isPostgresHealthy = health?.status === 'ok';
  const isRazorpayConfigured = health?.razorpay_configured === true;
  const isGeminiConfigured = aiStatus?.configured === true;
  const geminiModel = aiStatus?.model || 'gemini-3.5-flash-lite';

  return (
    <header style={{
      borderBottom: '1px solid var(--border)',
      background: 'var(--ink-page)',
      position: 'sticky',
      top: 0,
      zIndex: 100,
      padding: '0 20px',
      transition: 'height 220ms var(--ease-inout)'
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
            borderRadius: '6px',
            background: 'var(--state-verified)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#080B0E',
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
                borderRadius: '4px',
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

        {/* Middle: 5 Primary Navigation Tabs.
            minWidth:0 + overflowX:auto (rather than flexShrink:0) is what
            keeps this responsive: below ~1024px there isn't room for
            branding + all five tabs + the status cluster at their natural
            widths, so the nav becomes an internally-scrollable strip
            instead of forcing the whole header (and page) wider than the
            viewport. */}
        <nav style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0, 0, 0, 0.25)', padding: '4px', borderRadius: '8px', border: '1px solid var(--border)', flexShrink: 1, minWidth: 0, overflowX: 'auto', whiteSpace: 'nowrap' }}>
          {NAV_ITEMS.map(item => {
            if (item.key !== 'investigation') {
              return (
                <NavTab
                  key={item.key}
                  item={item}
                  isActive={activeTab === item.key}
                  onClick={() => onTabChange(item.key)}
                />
              );
            }
            const isActive = activeTab === 'investigation';
            return (
              <button
                key="investigation"
                onClick={() => onTabChange('investigation')}
                title={`${pendingInvestigationCount} active/pending, ${investigatedCount} resolved or rejected (final counts, matching Overview and the Investigation workspace exactly)`}
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
                  flexShrink: 0
                }}
              >
                {isActive && (
                  <motion.span
                    layoutId="nav-active-pill"
                    transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                    style={{ position: 'absolute', inset: 0, background: 'var(--primary)', borderRadius: '6px', zIndex: 0 }}
                  />
                )}
                <span style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Search size={13} strokeWidth={2} />
                  <span className="cc-nav-label">Investigation</span>
                  <PendingBadge count={pendingInvestigationCount} />
                  {investigatedCount > 0 && (
                    <span style={{
                      padding: '1px 6px',
                      borderRadius: '4px',
                      background: 'rgba(52, 211, 153, 0.2)',
                      color: '#34d399',
                      fontSize: '10px',
                      fontWeight: '800',
                      whiteSpace: 'nowrap'
                    }}>
                      {investigatedCount} done
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Right: Live Connection Indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, whiteSpace: 'nowrap' }}>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: isRazorpayConfigured ? '#3b82f6' : '#f59e0b', flexShrink: 0 }}></span>
            <span className="cc-header-status-text">Razorpay: <strong style={{ color: isRazorpayConfigured ? 'var(--text)' : '#fbbf24' }}>{isRazorpayConfigured ? 'Test Mode' : 'Keys Needed'}</strong></span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: isPostgresHealthy ? '#10b981' : '#ef4444', flexShrink: 0 }}></span>
            <span className="cc-header-status-text">PostgreSQL: <strong style={{ color: 'var(--text)' }}>{stats?.payments ? `${stats.payments} txs` : (isPostgresHealthy ? 'Connected' : 'Offline')}</strong></span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: isGeminiConfigured ? '#10b981' : '#f87171', flexShrink: 0 }}></span>
            <span className="cc-header-status-text">Gemini: <strong style={{ color: 'var(--text)' }}>{isGeminiConfigured ? geminiModel : 'Offline'}</strong></span>
          </div>

          {/* Refresh Button */}
          <button
            onClick={onRefresh}
            title="Refresh All Data"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '6px 8px',
              borderRadius: '4px',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              flexShrink: 0
            }}
          >
            <RefreshCw size={13} />
          </button>

        </div>

      </div>
    </header>
  );
}
