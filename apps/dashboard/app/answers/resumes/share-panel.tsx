'use client';

// The Share tab: named public links (resume.ibraheemamin.dev/r/<token>) that
// always serve the resume's CURRENT PDF. Links load lazily the first time
// the tab opens (via the listShareLinks action — the api owns tokens and
// renders the full URLs), creation prepends the new link with its URL
// pre-selected for copying, and the enable/disable toggle is optimistic
// (disable IS the revoke — the row stays, visibly dead, its stats intact).

import { useEffect, useRef, useState, useTransition } from 'react';
import { Timestamp } from '../../../lib/ui';
import { Badge } from '../../tasks/[id]/ui';
import {
  createShareLink,
  listShareLinks,
  type ShareLink,
  setShareLinkEnabled,
} from './actions';

function LinkRow({
  link,
  copied,
  justCreated,
  busy,
  onCopy,
  onToggle,
}: {
  link: ShareLink;
  /** Show the 'copied ✓' flash on this row. */
  copied: boolean;
  /** Freshly minted — pre-select the URL so ⌘C works immediately. */
  justCreated: boolean;
  /** A toggle request is in flight for this row. */
  busy: boolean;
  onCopy: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const codeRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!justCreated) return;
    const el = codeRef.current;
    const selection = window.getSelection();
    if (!el || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [justCreated]);

  const revoked = !link.enabled;
  return (
    <li className="q-row" style={{ listStyle: 'none' }}>
      <div className="row" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong
          className={revoked ? 'link-revoked' : undefined}
          style={{ fontSize: '0.875rem', overflowWrap: 'anywhere' }}
        >
          {link.name}
        </strong>
        {revoked ? (
          <Badge tone="neutral" title="Revoked — the URL now returns 404">
            revoked
          </Badge>
        ) : (
          <Badge tone="success" title="Live — serves the current PDF">
            active
          </Badge>
        )}
        <span className="spread">
          <button
            type="button"
            className={revoked ? 'btn btn--sm' : 'btn btn--danger btn--sm'}
            disabled={busy}
            title={
              revoked
                ? 'Turn the URL back on'
                : 'Revoke — the URL stops working instantly'
            }
            onClick={() => onToggle(revoked)}
          >
            {revoked ? 'Re-enable' : 'Disable'}
          </button>
        </span>
      </div>
      <div
        className="row"
        style={{ marginTop: '0.3125rem', gap: '0.375rem', flexWrap: 'wrap' }}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-copy is a pointer nicety (user-select:all also selects on plain click) — the keyboard path is the Copy button beside it */}
        <code
          ref={codeRef}
          className={revoked ? 'copy-line link-revoked' : 'copy-line'}
          title="Click to copy"
          onClick={onCopy}
        >
          {link.url}
        </code>
        <button type="button" className="btn btn--sm" onClick={onCopy}>
          Copy
        </button>
        {copied ? <span className="status-ok">copied ✓</span> : null}
      </div>
      <p className="hint faint" style={{ margin: '0.3125rem 0 0' }}>
        <span className="num">{link.viewCount}</span> view
        {link.viewCount === 1 ? '' : 's'} · last viewed{' '}
        {link.lastViewedAt ? <Timestamp value={link.lastViewedAt} /> : 'never'}{' '}
        · created <Timestamp value={link.createdAt ?? null} />
      </p>
    </li>
  );
}

export function SharePanel({
  resumeId,
  active,
}: {
  resumeId: string;
  /** True while the Share tab is the selected one — triggers the lazy load. */
  active: boolean;
}) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [loadState, setLoadState] = useState<
    'idle' | 'loading' | 'loaded' | 'error'
  >('idle');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Lazy load on first activation (loadState returns to 'idle' on retry).
  useEffect(() => {
    if (!active || loadState !== 'idle') return;
    setLoadState('loading');
    let cancelled = false;
    (async () => {
      let result: Awaited<ReturnType<typeof listShareLinks>>;
      try {
        result = await listShareLinks(resumeId);
      } catch {
        result = { ok: false, message: 'could not reach the dashboard' };
      }
      if (cancelled) return;
      if (result.ok && result.links) {
        // Keep any link created while the list was loading (create can win
        // the race because the panel mounts before the tab is opened).
        setLinks((prev) => {
          const loaded = result.links ?? [];
          const extra = (prev ?? []).filter(
            (link) => !loaded.some((l) => l.id === link.id),
          );
          return [...extra, ...loaded];
        });
        setLoadState('loaded');
      } else {
        setLoadError(result.message);
        setLoadState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, loadState, resumeId]);

  // ---- failure toast (reuses the global bottom-dock/toast classes) --------
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // ---- create -------------------------------------------------------------
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, startCreate] = useTransition();
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);

  const create = () => {
    const trimmed = newName.trim();
    if (trimmed === '') {
      setCreateError('Give the link a name — who are you sending it to?');
      return;
    }
    setCreateError(null);
    startCreate(async () => {
      const result = await createShareLink(resumeId, trimmed);
      if (result.ok && result.link) {
        const link = result.link;
        setLinks((prev) => [link, ...(prev ?? [])]);
        setJustCreatedId(link.id);
        setNewName('');
      } else {
        setCreateError(result.message);
      }
    });
  };

  // ---- copy ---------------------------------------------------------------
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copy = async (link: ShareLink) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopiedId(link.id);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedId(null), 1600);
    } catch {
      showToast('Copy failed — select the URL and copy it manually.');
    }
  };

  // ---- enable/disable (optimistic) ----------------------------------------
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const toggle = (link: ShareLink, enabled: boolean) => {
    setBusyIds((prev) => new Set(prev).add(link.id));
    // Optimistic flip; reverted below if the api says no.
    setLinks(
      (prev) =>
        prev?.map((l) => (l.id === link.id ? { ...l, enabled } : l)) ?? prev,
    );
    (async () => {
      let result: Awaited<ReturnType<typeof setShareLinkEnabled>>;
      try {
        result = await setShareLinkEnabled(link.id, enabled);
      } catch {
        result = { ok: false, message: 'could not reach the dashboard' };
      }
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(link.id);
        return next;
      });
      if (result.ok && result.link) {
        const fresh = result.link;
        setLinks(
          (prev) => prev?.map((l) => (l.id === fresh.id ? fresh : l)) ?? prev,
        );
      } else {
        setLinks(
          (prev) =>
            prev?.map((l) =>
              l.id === link.id ? { ...l, enabled: link.enabled } : l,
            ) ?? prev,
        );
        showToast(
          `${enabled ? 'Re-enable' : 'Disable'} failed — ${result.message}`,
        );
      }
    })();
  };

  return (
    <div>
      <form
        className="row"
        style={{ gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <input
          type="text"
          className="field"
          style={{ width: 'auto', flex: '1 1 14rem', fontSize: '0.8125rem' }}
          placeholder="e.g. Stripe application — who you're sending it to"
          aria-label="New share link name"
          value={newName}
          maxLength={200}
          disabled={creating}
          onChange={(event) => {
            setNewName(event.target.value);
            if (createError) setCreateError(null);
          }}
        />
        <button
          type="submit"
          className="btn btn--primary btn--sm"
          disabled={creating || newName.trim() === ''}
        >
          {creating ? 'Creating…' : 'Create link'}
        </button>
      </form>
      {createError ? (
        <p className="status-err" style={{ margin: '0.375rem 0 0' }}>
          {createError}
        </p>
      ) : null}

      {loadState === 'loaded' && links !== null ? (
        links.length === 0 ? (
          <p className="hint" style={{ margin: '0.75rem 0 0' }}>
            No share links yet. Publishable links always serve the CURRENT
            version of this resume and survive edits. Revoking a link kills it
            instantly — mint one per company so you can revoke selectively.
          </p>
        ) : (
          <ul style={{ margin: '0.5rem 0 0', padding: 0 }}>
            {links.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                copied={copiedId === link.id}
                justCreated={justCreatedId === link.id}
                busy={busyIds.has(link.id)}
                onCopy={() => copy(link)}
                onToggle={(enabled) => toggle(link, enabled)}
              />
            ))}
          </ul>
        )
      ) : loadState === 'error' ? (
        <p className="status-err" style={{ margin: '0.75rem 0 0' }}>
          Could not load links — {loadError}{' '}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setLoadState('idle')}
          >
            Retry
          </button>
        </p>
      ) : (
        <p className="hint faint" style={{ margin: '0.75rem 0 0' }}>
          Loading links…
        </p>
      )}

      {toast ? (
        <div className="bottom-dock">
          <div className="toast" role="alert">
            <span>{toast}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
