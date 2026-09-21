import React, { useEffect, useState } from 'react';

// Button — Phase 3.1 reconciliation.
//
// tier: 'primary' | 'secondary' | 'ghost' — the same three tiers as before.
// tone: 'neutral' | 'critical' | 'warning' | 'verified' — semantic color for
//   actions like Approve/Reject/Execute. A non-neutral tone NEVER produces a
//   filled colored rectangle: it only tints the border, label, and icon —
//   even on tier="primary" — because a destructive action being visually as
//   loud as a normal filled primary action is exactly the "giant filled
//   red/critical rectangle" this system is deliberately avoiding. The
//   recommended pairing is tier="ghost" tone="critical" (per the brief's own
//   example), but tone works on any tier without ever adding a fill.
//
// state: 'idle' | 'loading' | 'success' — controlled by the consumer for
//   entering loading/success, but the success -> idle return is owned by
//   the component itself (see the internal timer below): the brief is
//   explicit that a Button must never be left permanently stuck in success,
//   so that guarantee can't depend on every consumer remembering to reset
//   its own state after some duration.
//
// Loading is a compact 12px inline spinner + a present-participle label
// (e.g. "Approve" -> "Approving") — both passed explicitly by the consumer
// (loadingLabel), since deriving a correct participle from arbitrary
// children programmatically is not reliable. This replaces the earlier
// Phase 3 sweeping-rail treatment.
export default function Button({
  tier = 'primary', // 'primary' | 'secondary' | 'ghost'
  tone = 'neutral', // 'neutral' | 'critical' | 'warning' | 'verified'
  state = 'idle', // 'idle' | 'loading' | 'success' (consumer-driven entry)
  icon: Icon,
  children,
  loadingLabel,
  successLabel,
  onClick,
  disabled = false,
  type = 'button',
  className = '',
  ...rest
}) {
  // Mirrors `state`, except success auto-reverts to idle after 900ms
  // regardless of whether the consumer's own `state` prop changes — this is
  // what makes "the same button can be triggered again after returning to
  // idle" true even for a consumer that doesn't manage its own timeout.
  const [internalState, setInternalState] = useState(state);

  useEffect(() => {
    setInternalState(state);
    if (state === 'success') {
      const t = setTimeout(() => setInternalState('idle'), 900);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [state]);

  const isLoading = internalState === 'loading';
  const isSuccess = internalState === 'success';
  const cursorAffordance = tier === 'primary' && tone === 'neutral' ? 'primary' : 'hover';

  let label = children;
  if (isLoading && loadingLabel) label = loadingLabel;
  if (isSuccess && successLabel) label = successLabel;

  return (
    <button
      type={type}
      className={`cc-btn cc-btn-${tier} ${tone !== 'neutral' ? `cc-btn-tone-${tone}` : ''} ${isSuccess ? 'cc-btn-success' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      data-cursor={disabled ? undefined : cursorAffordance}
      {...rest}
    >
      {isLoading && (
        <svg className="cc-btn-spinner" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
          <path d="M10.5 6a4.5 4.5 0 0 0-4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
      {isSuccess && (
        <svg className="cc-btn-check" width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M2.5 7.2L5.6 10.3L11.5 3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {Icon && !isLoading && !isSuccess && (
        <Icon size={14} style={{ marginRight: '6px', display: 'inline-block', verticalAlign: 'middle' }} />
      )}
      <span className="cc-btn-label">{label}</span>
    </button>
  );
}
