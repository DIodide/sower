'use client';

// Live view of one resume-editor run: a 2s poll loop over the getRunStatus
// server action, a status line ("Claude is working — started 0:42 ago"), and
// the transcript rendered live as the job appends steps. Polling stops on a
// terminal status and gives up after 15 minutes ("still running — check
// History later") so a wedged run never polls forever.

import type { ResumeRunKind, TranscriptStep } from '@sower/db';
import { useEffect, useRef, useState } from 'react';
import { Empty, ExpandableText } from '../../../lib/ui';
import { Badge, JsonDetails, safeStringify } from '../../tasks/[id]/ui';
import { getRunStatus } from './actions';
import {
  commitUrl,
  KIND_META,
  type RunSnapshot,
  shortSha,
  snapshotFromPoll,
} from './run-format';

const POLL_INTERVAL_MS = 2_000;
/** Stop polling after 15 minutes — the run may still finish; History has it. */
const POLL_BUDGET_MS = 15 * 60_000;

/**
 * Poll one run every 2s until it leaves 'running' (then `onSettled` fires
 * once) or the 15-minute budget runs out (`timedOut`). `initial` seeds the
 * view when the page loaded with the run already in flight, so the transcript
 * shows before the first poll returns. Poll failures are surfaced as
 * `pollError` but never stop the loop — the api may just be redeploying.
 */
export function useRunPoll(
  runId: string | null,
  initial: RunSnapshot | null,
  onSettled?: (run: RunSnapshot) => void,
): { run: RunSnapshot | null; timedOut: boolean; pollError: string | null } {
  const [run, setRun] = useState<RunSnapshot | null>(
    initial && initial.id === runId ? initial : null,
  );
  const [timedOut, setTimedOut] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const initialRef = useRef(initial);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });

  useEffect(() => {
    const seed = initialRef.current;
    const seeded = seed && seed.id === runId ? seed : null;
    setRun(seeded);
    setTimedOut(false);
    setPollError(null);
    if (!runId) return;
    // Page loaded with a run that is already terminal: nothing to poll.
    if (seeded && seeded.status !== 'running') return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + POLL_BUDGET_MS;

    const tick = async () => {
      let result: Awaited<ReturnType<typeof getRunStatus>>;
      try {
        result = await getRunStatus(runId);
      } catch {
        result = { ok: false, message: 'could not reach the dashboard' };
      }
      if (cancelled) return;
      let settled = false;
      if (result.ok && result.run) {
        const view = snapshotFromPoll(result.run);
        setRun(view);
        setPollError(null);
        if (view.status !== 'running') {
          settled = true;
          onSettledRef.current?.(view);
        }
      } else {
        setPollError(result.message);
      }
      if (settled) return;
      if (Date.now() >= deadline) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  return { run, timedOut, pollError };
}

/**
 * Live m:ss elapsed counter. Renders a placeholder until mounted so a
 * server-rendered running run never hydration-mismatches on Date.now().
 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (now === null) return <span className="num">…</span>;
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return (
    <span className="num">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
    </span>
  );
}

// ---------------------------------------------------------------- transcript
// DUPLICATION NOTE: the step renderer below (KIND_LABEL, formatDuration,
// inputHeadline, ToolUseBody, StepBody, StepItem) is copied minimally from
// app/tasks/[id]/investigation-panel.tsx, whose pieces are module-private and
// out of this feature's lanes to export. Keep the two in sync if the
// TranscriptStep shape or rendering conventions change.

const KIND_LABEL: Record<TranscriptStep['kind'], string> = {
  assistant_text: 'agent',
  tool_use: 'tool call',
  tool_result: 'tool result',
  system: 'system',
  result: 'result',
};

/** Compact duration: `4s`, `2m 14s`, `1h 3m`. */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The human-scannable part of a tool input: the file path, the prompt, or the
 * query — so the user reads what the agent did at a glance.
 */
function inputHeadline(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  for (const key of ['query', 'url', 'prompt', 'file_path', 'command']) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** tool_use body: headline (path/query) prominent, full input as JSON. */
function ToolUseBody({ input }: { input: unknown }) {
  const headline = inputHeadline(input);
  if (input === null || input === undefined) {
    return <span className="hint faint">(no input)</span>;
  }
  const json = safeStringify(input);
  return (
    <div style={{ minWidth: 0 }}>
      {headline ? (
        <div
          className="mono"
          style={{
            fontSize: '0.8125rem',
            color: 'var(--accent-deep)',
            overflowWrap: 'anywhere',
          }}
        >
          {headline}
        </div>
      ) : null}
      {headline ? (
        <JsonDetails label="full input" value={input} />
      ) : json.length <= 280 ? (
        <pre className="codeblock">{json}</pre>
      ) : (
        <JsonDetails label="input" value={input} />
      )}
    </div>
  );
}

function StepBody({ step }: { step: TranscriptStep }) {
  switch (step.kind) {
    case 'tool_use':
      return <ToolUseBody input={step.input} />;
    case 'tool_result':
      return step.output ? (
        <div className="mono" style={{ fontSize: '0.8125rem' }}>
          <ExpandableText text={step.output} max={240} />
        </div>
      ) : (
        <span className="hint faint">(no output)</span>
      );
    case 'assistant_text':
      return step.text ? (
        <div style={{ fontSize: '0.875rem' }}>
          <ExpandableText text={step.text} max={400} />
        </div>
      ) : null;
    default:
      // system + result rows: the header already shows the label/badge; the
      // body is any output the step carried.
      return step.output ? (
        <div className="mono" style={{ fontSize: '0.8125rem' }}>
          <ExpandableText text={step.output} max={240} />
        </div>
      ) : null;
  }
}

function StepItem({
  step,
  startMs,
}: {
  step: TranscriptStep;
  startMs: number;
}) {
  const denied = step.kind === 'system' && step.text === 'permission_denied';
  return (
    <li>
      <div
        className="row"
        style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}
      >
        <span
          className="mono faint"
          style={{
            fontSize: '0.6875rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {KIND_LABEL[step.kind] ?? step.kind}
        </span>
        {step.tool ? (
          <span
            className="mono"
            style={{ fontSize: '0.8125rem', fontWeight: 600 }}
          >
            {step.tool}
          </span>
        ) : null}
        {denied ? (
          <Badge
            tone="danger"
            title="The permission system blocked this tool call"
          >
            DENIED
          </Badge>
        ) : step.kind === 'system' && step.text ? (
          <span className="mono faint" style={{ fontSize: '0.8125rem' }}>
            {step.text}
          </span>
        ) : null}
        {step.kind === 'result' && step.text ? (
          <Badge tone={step.text === 'success' ? 'success' : 'danger'}>
            {step.text}
          </Badge>
        ) : null}
        <span
          className="hint faint spread num"
          style={{ whiteSpace: 'nowrap' }}
        >
          +{formatDuration(step.ts - startMs)}
        </span>
      </div>
      <div style={{ marginTop: '0.25rem' }}>
        <StepBody step={step} />
      </div>
    </li>
  );
}

/** The transcript timeline (steps come pre-sorted from asTranscript). */
export function TranscriptSteps({
  steps,
  startedAt,
}: {
  steps: TranscriptStep[];
  startedAt: string | null;
}) {
  if (steps.length === 0) return <Empty>No transcript recorded.</Empty>;
  const startMs = startedAt
    ? new Date(startedAt).getTime()
    : (steps[0]?.ts ?? 0);
  return (
    <ol className="timeline">
      {steps.map((step) => (
        <StepItem key={step.seq} step={step} startMs={startMs} />
      ))}
    </ol>
  );
}

// ------------------------------------------------------------- live run view

/**
 * The status line + live transcript of the run currently being polled.
 * `fallbackKind` labels the run before the first poll returns (the caller
 * knows what it just started).
 */
export function LiveRunView({
  run,
  timedOut,
  pollError,
  fallbackKind,
}: {
  run: RunSnapshot | null;
  timedOut: boolean;
  pollError: string | null;
  fallbackKind: ResumeRunKind;
}) {
  const kind = run?.kind ?? fallbackKind;
  const status = run?.status ?? 'running';
  const steps = run?.transcript ?? [];

  return (
    <div className="well" style={{ marginTop: '0.875rem' }}>
      {status === 'running' ? (
        timedOut ? (
          <p className="hint" style={{ margin: 0 }}>
            <Badge tone="progress">Running</Badge> Still running after 15
            minutes — polling stopped. Check the History tab later.
          </p>
        ) : (
          <p className="hint" style={{ margin: 0 }}>
            <Badge tone="progress">Running</Badge>{' '}
            <strong>{KIND_META[kind].runningLabel}</strong>
            {run?.startedAt ? (
              <>
                {' '}
                — started <Elapsed since={run.startedAt} /> ago
              </>
            ) : (
              ' — starting…'
            )}
          </p>
        )
      ) : status === 'succeeded' ? (
        <p className="status-ok" style={{ margin: 0 }}>
          {run?.commitSha ? (
            <>
              Committed{' '}
              <a
                className="mono"
                href={commitUrl(run.commitSha)}
                target="_blank"
                rel="noopener noreferrer"
                title={run.commitSha}
              >
                {shortSha(run.commitSha)}
              </a>{' '}
              — refreshing preview.
            </>
          ) : kind === 'sync' ? (
            'Synced — refreshing.'
          ) : (
            'Done — refreshing.'
          )}
        </p>
      ) : (
        <div className="status-err">
          Run failed
          {run?.error ? (
            <>
              : <ExpandableText text={run.error} max={300} />
            </>
          ) : (
            ' — see History for details.'
          )}
        </div>
      )}

      {pollError && status === 'running' && !timedOut ? (
        <p className="hint faint" style={{ margin: '0.375rem 0 0' }}>
          status check failed ({pollError}) — retrying…
        </p>
      ) : null}

      {kind === 'agent' || steps.length > 0 ? (
        <div style={{ marginTop: '0.75rem' }}>
          <div
            className="hint faint"
            style={{ fontSize: '0.6875rem', fontWeight: 600 }}
          >
            Transcript · {steps.length} step{steps.length === 1 ? '' : 's'}
          </div>
          {steps.length === 0 ? (
            <p className="hint faint" style={{ margin: '0.375rem 0 0' }}>
              Waiting for the agent's first steps…
            </p>
          ) : (
            <div className="scroll-cap" style={{ marginTop: '0.5rem' }}>
              <TranscriptSteps
                steps={steps}
                startedAt={run?.startedAt ?? null}
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
