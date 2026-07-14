// The "Agent investigation" observability panel for screenshot tasks: the
// latest investigation_runs row — status, result summary, and the FULL agent
// transcript (every tool call + input, every tool result, the agent's
// reasoning, and permission denials). Pure presentation, server-component
// friendly: native <details> handles expand/collapse, no client JS.

import type {
  InvestigationRun,
  InvestigationRunStatus,
  TranscriptStep,
} from '@sower/db';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Tone } from '../../../lib/format';
import { Empty, ExpandableText, Timestamp } from '../../../lib/ui';
import { Badge, JsonDetails, safeStringify } from './ui';

const RUN_STATUS_META: Record<
  InvestigationRunStatus,
  { label: string; tone: Tone }
> = {
  running: { label: 'Investigating', tone: 'progress' },
  found: { label: 'Found', tone: 'success' },
  not_found: { label: 'Not found', tone: 'neutral' },
  error: { label: 'Error', tone: 'danger' },
};

const KIND_LABEL: Record<TranscriptStep['kind'], string> = {
  assistant_text: 'agent',
  tool_use: 'tool call',
  tool_result: 'tool result',
  system: 'system',
  result: 'result',
};

const CONFIDENCE_TONE: Record<string, Tone> = {
  high: 'success',
  medium: 'attention',
  low: 'neutral',
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
 * The human-scannable part of a tool input: the search query, the fetched
 * URL, or the prompt — so a triager reads what the agent did at a glance.
 */
function inputHeadline(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  for (const key of ['query', 'url', 'prompt']) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="hint faint"
      style={{ fontSize: '0.72rem', fontWeight: 800 }}
    >
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <FieldLabel>{label}</FieldLabel>
      <div style={{ fontSize: '0.875rem', overflowWrap: 'anywhere' }}>
        {children}
      </div>
    </div>
  );
}

/** tool_use body: headline (query/URL) prominent, full input as pretty JSON. */
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
    case 'system':
      // permission_denied carries the denial message in `output`; the header
      // row already shows the DENIED badge + denied tool name.
      return step.output ? (
        <div className="mono" style={{ fontSize: '0.8125rem' }}>
          <ExpandableText text={step.output} max={240} />
        </div>
      ) : null;
    case 'result':
      return step.output ? (
        <div className="mono" style={{ fontSize: '0.8125rem' }}>
          <ExpandableText text={step.output} max={240} />
        </div>
      ) : null;
    default:
      return null;
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
            fontSize: '0.72rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {KIND_LABEL[step.kind] ?? step.kind}
        </span>
        {step.tool ? (
          <span
            className="mono"
            style={{ fontSize: '0.8125rem', fontWeight: 700 }}
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

/**
 * Renders one investigation run. `foundTaskId` is the application task created
 * for the real job ingested from the found apply URL (resolved by the page),
 * so "found" runs link straight to the queued task.
 */
export function InvestigationPanel({
  run,
  foundTaskId,
}: {
  run: InvestigationRun;
  foundTaskId: string | null;
}) {
  const meta = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.error;
  const startMs = run.startedAt.getTime();
  const duration = run.finishedAt
    ? formatDuration(run.finishedAt.getTime() - startMs)
    : null;
  const result = run.result;
  const steps = run.transcript
    ? [...run.transcript].sort((a, b) => a.seq - b.seq)
    : [];

  return (
    <div className="card">
      {/* ---- header: status + timing ---- */}
      <div className="row" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Badge tone={meta.tone} title={run.status}>
          {meta.label}
        </Badge>
        <span className="hint">
          <Timestamp value={run.startedAt} inline />
          {run.finishedAt ? (
            <>
              {' '}
              <span className="faint">→</span>{' '}
              <Timestamp value={run.finishedAt} inline />
            </>
          ) : null}
        </span>
        {duration ? <span className="hint num">took {duration}</span> : null}
      </div>

      {run.status === 'running' ? (
        <p className="hint" style={{ margin: '0.75rem 0 0' }}>
          <strong>Investigating…</strong> The agent is searching the web for
          this posting's real application page. The result and full transcript
          appear here when the run finishes.
        </p>
      ) : null}

      {run.error ? (
        <div style={{ marginTop: '0.75rem' }}>
          <FieldLabel>Error</FieldLabel>
          <div className="status-err" style={{ fontWeight: 600 }}>
            <ExpandableText text={run.error} max={240} />
          </div>
        </div>
      ) : null}

      {/* ---- result summary ---- */}
      {result ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(11rem, 1fr))',
            gap: '0.75rem 1.5rem',
            marginTop: '0.875rem',
          }}
        >
          <Field label="Apply URL found">
            <Badge tone={result.found ? 'success' : 'neutral'}>
              {result.found ? 'yes' : 'no'}
            </Badge>
          </Field>
          {result.applyUrl ? (
            <Field label="Apply URL">
              <a
                href={result.applyUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={result.applyUrl}
              >
                {result.applyUrl.replace(/^https?:\/\//, '')} ↗
              </a>
            </Field>
          ) : null}
          {result.company ? (
            <Field label="Company">{result.company}</Field>
          ) : null}
          {result.title ? <Field label="Title">{result.title}</Field> : null}
          {result.platform ? (
            <Field label="Platform">
              <span className="mono">{result.platform}</span>
            </Field>
          ) : null}
          <Field label="Confidence">
            <Badge tone={CONFIDENCE_TONE[result.confidence] ?? 'neutral'}>
              {result.confidence}
            </Badge>
          </Field>
          {run.foundJobId ? (
            <Field label="Ingested job">
              {foundTaskId ? (
                <Link href={`/tasks/${foundTaskId}`}>
                  → queued as task{' '}
                  <span className="mono">{foundTaskId.slice(0, 8)}</span>
                </Link>
              ) : (
                <span className="hint">
                  job <span className="mono">{run.foundJobId.slice(0, 8)}</span>{' '}
                  (no task yet)
                </span>
              )}
            </Field>
          ) : null}
          {result.notes ? (
            <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
              <FieldLabel>Notes</FieldLabel>
              <div style={{ fontSize: '0.875rem' }}>
                <ExpandableText text={result.notes} max={400} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---- transcript: the observability record ---- */}
      {run.status !== 'running' ? (
        <>
          <hr className="divider-soft" />
          <FieldLabel>
            Transcript · {steps.length} step{steps.length === 1 ? '' : 's'}
          </FieldLabel>
          {steps.length === 0 ? (
            <Empty>No transcript recorded for this run.</Empty>
          ) : (
            <ol className="timeline" style={{ marginTop: '0.75rem' }}>
              {steps.map((step) => (
                <StepItem key={step.seq} step={step} startMs={startMs} />
              ))}
            </ol>
          )}
        </>
      ) : null}
    </div>
  );
}
