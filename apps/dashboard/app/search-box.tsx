'use client';

// Live search for the Applications workspace: a debounced (300ms)
// router.replace keeps the URL shareable and the server-rendered list fresh
// WITHOUT a full-page reload, preserving every other filter param. Still a
// real GET form underneath, so without JavaScript the (server-rendered)
// Search button submits it the classic way.

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const SEARCH_DEBOUNCE_MS = 300;

export function SearchBox() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQ = searchParams?.get('q') ?? '';
  const [value, setValue] = useState(urlQ);
  // False in the server HTML — the no-JS fallback Search button renders —
  // then flipped after hydration, when live search takes over.
  const [hydrated, setHydrated] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setHydrated(true);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Adopt external URL changes (e.g. "Clear filters") — but never clobber
  // text the user is still typing (a pending debounce owns the input).
  const [prevUrlQ, setPrevUrlQ] = useState(urlQ);
  if (urlQ !== prevUrlQ) {
    setPrevUrlQ(urlQ);
    if (timerRef.current === null && urlQ !== value) setValue(urlQ);
  }

  const push = (next: string) => {
    // Read the LIVE query string so bucket/state/platform chips clicked
    // since this render are preserved, not resurrected from a stale render.
    const params = new URLSearchParams(window.location.search);
    const trimmed = next.trim();
    if (trimmed !== '') params.set('q', trimmed);
    else params.delete('q');
    const qs = params.toString();
    router.replace(qs ? `/?${qs}` : '/', { scroll: false });
  };

  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setValue(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      push(next);
    }, SEARCH_DEBOUNCE_MS);
  };

  const onSubmit = (event: React.FormEvent) => {
    if (!hydrated) return; // no JS mounted — let the browser GET it
    event.preventDefault();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    push(value);
  };

  // Server-rendered hidden fields keep the other filters on a no-JS submit.
  const carried = ['bucket', 'state', 'platform'] as const;

  return (
    <form method="GET" action="/" onSubmit={onSubmit}>
      <input
        type="search"
        name="q"
        value={value}
        className="field"
        placeholder="Search company, role, notes"
        aria-label="Search applications"
        onChange={onChange}
      />
      {carried.map((name) => {
        const v = searchParams?.get(name);
        return v ? (
          <input key={name} type="hidden" name={name} value={v} />
        ) : null;
      })}
      {!hydrated ? (
        <button type="submit" className="btn btn--sm">
          Search
        </button>
      ) : null}
    </form>
  );
}
