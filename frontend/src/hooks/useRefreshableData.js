import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One loading contract for every Wealth Navigator page.
 *
 * Why this exists: each page previously loaded its own state in a mount-only
 * `useEffect(..., [])`, while the header's Refresh button called a function in
 * App.jsx that only re-fetched legacy operations data. Pressing Refresh
 * therefore did nothing visible on any wealth page. This hook fixes that
 * properly rather than by reloading the browser:
 *
 *   - `refreshToken` is a counter App increments when the header Refresh is
 *     pressed. It is a dependency here, so every mounted page re-fetches.
 *   - An in-flight ref makes rapid clicks a no-op instead of firing duplicate
 *     requests and racing their responses.
 *   - A request-sequence number means a slow earlier response can never
 *     overwrite a newer one.
 *   - On failure the last good data is KEPT and an error is surfaced, so a
 *     transient backend blip does not blank a working screen — and the UI
 *     never silently pretends the refresh succeeded.
 *
 * @param {() => Promise<any>} loader        Fetches and returns this page's data.
 * @param {number}             refreshToken  Bump to force a re-fetch.
 * @param {string}             errorMessage  Human-readable failure message.
 */
export function useRefreshableData(loader, refreshToken = 0, errorMessage = 'Could not load data.') {
  const [data, setData] = useState(null);
  // `loading` is the first load (show skeletons); `refreshing` is a
  // subsequent one (keep the content, show a spinner). Conflating them makes
  // every refresh flash the whole page back to skeletons.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const inFlight = useRef(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const hasLoaded = useRef(false);
  const loaderRef = useRef(loader);

  // Kept current in an effect rather than assigned during render: writing to a
  // ref while rendering is a side effect, and under StrictMode's double render
  // it can latch a loader from a discarded pass.
  useEffect(() => { loaderRef.current = loader; });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;

    const seq = ++sequence.current;
    if (hasLoaded.current) setRefreshing(true); else setLoading(true);
    setError(null);

    try {
      const result = await loaderRef.current();
      if (!mounted.current || seq !== sequence.current) return;
      setData(result);
      setLastUpdated(new Date());
      hasLoaded.current = true;
    } catch (err) {
      if (!mounted.current || seq !== sequence.current) return;
      console.error(errorMessage, err);
      // Deliberately does NOT clear `data`: a failed refresh should leave the
      // last known-good numbers on screen, clearly marked as stale, rather
      // than replacing a useful screen with an empty one.
      setError(errorMessage);
    } finally {
      if (mounted.current && seq === sequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
      inFlight.current = false;
    }
  }, [errorMessage]);

  useEffect(() => {
    run();
  }, [run, refreshToken]);

  return { data, loading, refreshing, error, lastUpdated, refresh: run };
}

/** Indian-rupee formatting, used everywhere so no two screens format money
 *  differently. Returns an em dash for a missing value — never "₹0", which a
 *  user would read as a real balance of zero. */
export function formatINR(value, { decimals = 0 } = {}) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `₹${Number(value).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Short, unambiguous date. Avoids locale-dependent DD/MM vs MM/DD confusion. */
export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(String(value).slice(0, 10));
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
