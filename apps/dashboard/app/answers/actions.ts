'use server';

// Server actions for the answer-library management page. Every mutation goes
// through the sower api's /answer-library routes (x-api-key auth) — the same
// pattern as requeue/approve — and every input is zod-validated here before
// it leaves the dashboard.
//
// TRUTHFULNESS: this page only stores what the user typed. Scope is explicit:
// '' (global) or a company key; the api normalizes company to lowercase, so a
// company-scoped answer can never leak to a different company at resolution.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { apiRequest } from './library';

export interface ActionResult {
  ok: boolean;
  message: string;
}

const idSchema = z.string().uuid();

// '' = global scope. The api lowercases; we trim here so a stray-whitespace
// company never creates a phantom scope.
const companySchema = z
  .string()
  .trim()
  .max(200, 'company must be at most 200 characters');
const questionLabelSchema = z
  .string()
  .trim()
  .min(1, 'question label is required')
  .max(1_000, 'question label must be at most 1,000 characters');
const valueSchema = z
  .string()
  .trim()
  .min(1, 'answer text is required')
  .max(20_000, 'answer must be at most 20,000 characters');

const createInputSchema = z.object({
  company: companySchema,
  questionLabel: questionLabelSchema,
  value: valueSchema,
});

const updateInputSchema = z.object({
  company: companySchema,
  questionLabel: questionLabelSchema,
  value: valueSchema,
});

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'invalid input';
}

function scopeLabel(company: string): string {
  const key = company.toLowerCase().trim();
  return key === '' ? 'global' : `“${key}”`;
}

/** Create (upsert by company + normalized label) a library answer. */
export async function createLibraryAnswer(input: {
  company: string;
  questionLabel: string;
  value: string;
}): Promise<ActionResult> {
  const parsed = createInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };

  const result = await apiRequest('/answer-library', {
    method: 'POST',
    body: parsed.data,
  });
  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath('/answers');
  return {
    ok: true,
    message: `saved ${scopeLabel(parsed.data.company)} answer for “${parsed.data.questionLabel}”.`,
  };
}

/** Update an existing library answer's text, label, or scope. */
export async function updateLibraryAnswer(
  id: string,
  input: { company: string; questionLabel: string; value: string },
): Promise<ActionResult> {
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, message: 'invalid answer id.' };
  const parsed = updateInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };

  const result = await apiRequest(
    `/answer-library/${encodeURIComponent(idParsed.data)}`,
    { method: 'PUT', body: parsed.data },
  );
  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath('/answers');
  return {
    ok: true,
    message: `updated ${scopeLabel(parsed.data.company)} answer for “${parsed.data.questionLabel}”.`,
  };
}

/** Delete a library answer. */
export async function deleteLibraryAnswer(id: string): Promise<ActionResult> {
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, message: 'invalid answer id.' };

  const result = await apiRequest(
    `/answer-library/${encodeURIComponent(idParsed.data)}`,
    { method: 'DELETE' },
  );
  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath('/answers');
  return { ok: true, message: 'answer deleted.' };
}
