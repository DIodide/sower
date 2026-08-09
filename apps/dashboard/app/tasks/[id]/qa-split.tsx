'use client';

// The questions/notes split with a user-controlled rail: a col-resize
// divider between the columns (drag to widen/narrow, double-click to
// reset) and a collapse chevron that minimizes the rail to a slim strip.
// Width and collapsed state persist in localStorage (single-user app).
// The width rides a CSS custom property — never an inline
// grid-template-columns — so the <1000px stacked-layout media query still
// wins unmodified.

import { type ReactNode, useEffect, useRef, useState } from 'react';

const WIDTH_KEY = 'qa-rail-width';
const COLLAPSED_KEY = 'qa-rail-collapsed';
const DEFAULT_WIDTH = 352; // 22rem
const MIN_WIDTH = 240;
const MAX_WIDTH = 760;

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

export function QaSplit({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  // Live drag state in refs — pointermove must not depend on re-renders.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Hydrate persisted layout after mount (SSR renders the default).
  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(stored) && stored > 0) setWidth(clampWidth(stored));
      if (window.localStorage.getItem(COLLAPSED_KEY) === '1') {
        setCollapsed(true);
      }
    } catch {
      // Storage unavailable — defaults stand.
    }
  }, []);

  const persistWidth = (value: number) => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(value));
    } catch {
      // Losing persistence, not the resize.
    }
  };

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '');
      } catch {
        // Losing persistence, not the toggle.
      }
      return next;
    });
  };

  const onDividerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDividerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Dragging LEFT widens the rail (the divider sits on its left edge).
    setWidth(clampWidth(drag.startWidth + (drag.startX - event.clientX)));
  };

  const onDividerPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setWidth((current) => {
      persistWidth(current);
      return current;
    });
  };

  return (
    <div
      className="qa-split"
      data-collapsed={collapsed ? '1' : undefined}
      style={{ '--qa-rail-w': `${width}px` } as React.CSSProperties}
    >
      <div className="qa-left">{left}</div>
      <div className="qa-rail">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the divider is a pointer-only affordance; the chevron button inside is the keyboard path */}
        <div
          className="qa-divider"
          title={
            collapsed ? undefined : 'Drag to resize — double-click to reset'
          }
          onPointerDown={onDividerPointerDown}
          onPointerMove={onDividerPointerMove}
          onPointerUp={onDividerPointerUp}
          onDoubleClick={() => {
            setWidth(DEFAULT_WIDTH);
            persistWidth(DEFAULT_WIDTH);
          }}
        >
          <button
            type="button"
            className="qa-collapse"
            title={collapsed ? 'Expand notes' : 'Minimize notes'}
            aria-label={collapsed ? 'Expand notes' : 'Minimize notes'}
            aria-expanded={!collapsed}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={toggleCollapsed}
          >
            {collapsed ? '‹' : '›'}
          </button>
        </div>
        <div className="qa-rail-body" hidden={collapsed}>
          {right}
        </div>
      </div>
    </div>
  );
}
