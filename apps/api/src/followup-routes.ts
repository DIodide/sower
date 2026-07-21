import {
  canFollowupTransition,
  deadlineFromIsoDate,
  FOLLOWUP_ALLOWED,
  type FollowupEvent,
  type FollowupKind,
  followupTransition,
} from '@sower/core';
import {
  applicationTasks,
  events,
  type Followup,
  followups,
  jobs,
} from '@sower/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type CalendarSyncOutcome,
  syncFollowupCalendarEvent,
} from './calendar-sync.js';
import type { Deps } from './types.js';

/**
 * Post-application follow-up routes: CRUD + transitions for the things that
 * arrive AFTER an application was sent (OA invites, interview requests,
 * recruiter mail, offers, rejections). Every write annotates the PARENT
 * task's timeline (FOLLOWUP_CREATED/FOLLOWUP_UPDATED/FOLLOWUP_STATE events)
 * without ever touching the parent's state machine, and every due-date /
 * state change re-syncs the follow-up's own Google Calendar event (self-
 * gated, never throws). All routes require x-api-key via the server-wide
 * preHandler.
 */

const taskParamsSchema = z.object({
  taskId: z.string().uuid(),
});

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

/** Notes cap — mirrors the task notes cap in server.ts; above it → 400. */
const NOTES_MAX_CHARS = 20_000;

// @sower/core FollowupKind / FollowupEvent, spelled out for z.enum.
const FOLLOWUP_KINDS = [
  'assessment',
  'interview',
  'recruiter',
  'offer',
  'rejection',
  'other',
] as const satisfies readonly FollowupKind[];

const FOLLOWUP_EVENTS = [
  'TRIAGE',
  'SCHEDULE',
  'COMPLETE_STEP',
  'RESOLVE',
  'DISMISS',
  'REOPEN',
] as const satisfies readonly FollowupEvent[];

// Https-only: a follow-up url is something the user will click (an OA
// platform, a scheduler) — never plain http, never another scheme.
const urlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'url must be a valid https URL' },
  );

// The follow-up's due date: an ISO date ("2026-07-30", the native
// date-input form) or full ISO timestamp — the exact shape the task
// dueDate route accepts. Must parse; an unparseable string is a 400.
const dueDateSchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'dueDate must be a parseable ISO date',
  });

const createBodySchema = z.object({
  kind: z.enum(FOLLOWUP_KINDS),
  title: z.string().trim().min(1).max(300),
  url: urlSchema.optional(),
  notes: z.string().max(NOTES_MAX_CHARS).optional(),
  dueDate: dueDateSchema.optional(),
});

// PATCH-style: only provided fields are written. url/notes/dueDate: null
// clears; at least one field must be present (an empty body is a 400, not
// a no-op).
const patchBodySchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    url: urlSchema.nullable().optional(),
    notes: z.string().max(NOTES_MAX_CHARS).nullable().optional(),
    dueDate: dueDateSchema.nullable().optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.url !== undefined ||
      body.notes !== undefined ||
      body.dueDate !== undefined,
    { message: 'provide at least one of title, url, notes, dueDate' },
  );

const transitionBodySchema = z.object({
  event: z.enum(FOLLOWUP_EVENTS),
});

/**
 * Normalize a dueDate string to a Date: plain dates land at ET midnight
 * (deadlineFromIsoDate — the same form application_tasks.due_date uses) so
 * calendar sync and the midnight alerts treat both identically; a full ISO
 * timestamp is stored as sent.
 */
function dueDateFromBody(value: string): Date {
  return new Date(deadlineFromIsoDate(value) ?? value);
}

/**
 * Overlay a just-synced calendar outcome onto the row the client gets:
 * the sync's own column write happened after the row was read/returned, so
 * the response would otherwise report a stale calendar_event_id.
 */
function withSyncedEventId(
  followup: Followup,
  outcome: CalendarSyncOutcome,
): Followup {
  if (outcome.kind === 'deleted') {
    return { ...followup, calendarEventId: null };
  }
  if (
    outcome.kind === 'created' ||
    outcome.kind === 'updated' ||
    outcome.kind === 'recreated'
  ) {
    return { ...followup, calendarEventId: outcome.eventId };
  }
  return followup;
}

export function registerFollowupRoutes(app: FastifyInstance, deps: Deps): void {
  // Record a follow-up on a task by hand (the dashboard's "Add follow-up").
  // The parent task keeps its state; its timeline gains FOLLOWUP_CREATED.
  app.post('/tasks/:taskId/followups', async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: params.error.issues });
    }
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const taskId = params.data.taskId;
    const tasks = await deps.db
      .select({ id: applicationTasks.id })
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    if (!tasks[0]) {
      return reply.code(404).send({ error: 'task not found' });
    }
    const inserted = await deps.db
      .insert(followups)
      .values({
        taskId,
        kind: body.data.kind,
        title: body.data.title,
        state: 'RECEIVED',
        url: body.data.url ?? null,
        notes: body.data.notes ?? null,
        dueDate:
          body.data.dueDate !== undefined
            ? dueDateFromBody(body.data.dueDate)
            : null,
        source: 'manual',
      })
      .returning();
    let followup = inserted[0];
    if (!followup) {
      return reply.code(500).send({ error: 'failed to record follow-up' });
    }
    await deps.db.insert(events).values({
      taskId,
      type: 'FOLLOWUP_CREATED',
      data: {
        followupId: followup.id,
        kind: followup.kind,
        title: followup.title,
        source: followup.source,
      },
    });
    if (body.data.dueDate !== undefined) {
      // Best-effort calendar mirror (self-gated, never throws by contract).
      const outcome = await syncFollowupCalendarEvent(deps, followup.id);
      followup = withSyncedEventId(followup, outcome);
    }
    return reply.code(200).send({ followup });
  });

  // Follow-up detail with the parent application's identity joined in.
  app.get('/followups/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid followup id', issues: params.error.issues });
    }
    const rows = await deps.db
      .select({
        followup: followups,
        task: {
          id: applicationTasks.id,
          company: jobs.company,
          title: jobs.title,
          state: applicationTasks.state,
        },
      })
      .from(followups)
      .innerJoin(applicationTasks, eq(followups.taskId, applicationTasks.id))
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(eq(followups.id, params.data.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'followup not found' });
    }
    return reply.code(200).send({ followup: row.followup, task: row.task });
  });

  // Edit a follow-up's user-facing fields. A dueDate change (set OR clear)
  // re-syncs its calendar event; the parent timeline gains FOLLOWUP_UPDATED
  // naming the fields that changed.
  app.patch('/followups/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid followup id', issues: params.error.issues });
    }
    const body = patchBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const followupId = params.data.id;
    const rows = await deps.db
      .select()
      .from(followups)
      .where(eq(followups.id, followupId))
      .limit(1);
    const existing = rows[0];
    if (!existing) {
      return reply.code(404).send({ error: 'followup not found' });
    }
    const set: {
      title?: string;
      url?: string | null;
      notes?: string | null;
      dueDate?: Date | null;
    } = {};
    const fields: string[] = [];
    if (body.data.title !== undefined) {
      set.title = body.data.title;
      fields.push('title');
    }
    if (body.data.url !== undefined) {
      set.url = body.data.url;
      fields.push('url');
    }
    if (body.data.notes !== undefined) {
      set.notes = body.data.notes;
      fields.push('notes');
    }
    if (body.data.dueDate !== undefined) {
      set.dueDate =
        body.data.dueDate === null ? null : dueDateFromBody(body.data.dueDate);
      fields.push('dueDate');
    }
    const updated = await deps.db
      .update(followups)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(followups.id, followupId))
      .returning();
    let followup = updated[0];
    if (!followup) {
      return reply.code(500).send({ error: 'failed to update follow-up' });
    }
    await deps.db.insert(events).values({
      taskId: existing.taskId,
      type: 'FOLLOWUP_UPDATED',
      data: { followupId, fields },
    });
    if (
      body.data.dueDate !== undefined ||
      ((body.data.title !== undefined || body.data.url !== undefined) &&
        followup.calendarEventId !== null)
    ) {
      // dueDate set/clear both re-sync (the sync deletes the event when
      // the due date was cleared); title/url edits re-sync too when an
      // event exists — its summary/description are built from them, and
      // the nightly reconcile only checks event PRESENCE, so a stale
      // title would otherwise live on the calendar indefinitely.
      // Self-gated, never throws by contract.
      const outcome = await syncFollowupCalendarEvent(deps, followupId);
      followup = withSyncedEventId(followup, outcome);
    }
    return reply.code(200).send({ followup });
  });

  // Drive the follow-up's own state machine. An event the @sower/core table
  // forbids from the current state is a 409 listing the allowed events.
  // Entering DONE/DISMISSED deletes its calendar event; REOPEN re-creates
  // one when a due date exists (both via the same self-gated sync).
  app.post('/followups/:id/transition', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid followup id', issues: params.error.issues });
    }
    const body = transitionBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const followupId = params.data.id;
    const rows = await deps.db
      .select()
      .from(followups)
      .where(eq(followups.id, followupId))
      .limit(1);
    const existing = rows[0];
    if (!existing) {
      return reply.code(404).send({ error: 'followup not found' });
    }
    const event = body.data.event;
    if (!canFollowupTransition(existing.state, event)) {
      return reply.code(409).send({
        error: `event '${event}' is not allowed from state '${existing.state}'`,
        allowed: Object.keys(FOLLOWUP_ALLOWED[existing.state]),
      });
    }
    const toState = followupTransition(existing.state, event);
    // The from-state predicate makes read-validate-write safe under
    // concurrency: of two racing transitions that both read the same
    // state, exactly one matches and wins — the loser updates 0 rows and
    // 409s instead of writing a contradictory event row and calendar sync.
    const updated = await deps.db
      .update(followups)
      .set({ state: toState, updatedAt: new Date() })
      .where(
        and(eq(followups.id, followupId), eq(followups.state, existing.state)),
      )
      .returning();
    let followup = updated[0];
    if (!followup) {
      return reply.code(409).send({
        error: `follow-up state changed concurrently — event '${event}' no longer applies`,
        allowed: [],
      });
    }
    await deps.db.insert(events).values({
      taskId: existing.taskId,
      type: 'FOLLOWUP_STATE',
      data: { followupId, event, from: existing.state, to: toState },
    });
    // Unconditional: the sync derives keep/delete from the NEW state + due
    // date (terminal → delete, reopened with a due date → recreate, no due
    // date → noop). Self-gated, never throws.
    const outcome = await syncFollowupCalendarEvent(deps, followupId);
    followup = withSyncedEventId(followup, outcome);
    return reply.code(200).send({ followup });
  });
}
