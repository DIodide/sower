'use client';

// Interactive profile editor: one dense flat form over every ProfileSchema
// field (identity/contact, location, links, education, work, authorization,
// graduation/academics, preferences, custom answers). Saves the FULL document
// via saveProfileAction (PUT /profile); validation errors come back as dot
// paths and are shown inline next to their fields plus summarized on top.

import type { Profile } from '@sower/answers';
import { useState, useTransition } from 'react';
import { formatLocal, relativeTime } from '../../../lib/format';
import type { SaveProfileResult } from './actions';
import { saveProfileAction } from './actions';
import type { CustomDraft, ProfileDraft, TriState } from './form-model';
import {
  draftToProfileInput,
  emptyEducationRow,
  emptyWorkRow,
  profileToDraft,
} from './form-model';

type Errors = Record<string, string>;

const fieldGrid = {
  display: 'grid',
  gap: '0.75rem',
  gridTemplateColumns: 'repeat(auto-fill, minmax(13rem, 1fr))',
} as const;

const rowGrid = {
  display: 'grid',
  gap: '0.5rem',
  gridTemplateColumns: 'repeat(auto-fill, minmax(10rem, 1fr))',
  alignItems: 'start',
} as const;

function FieldErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      className="status-err"
      style={{ margin: '0.125rem 0 0', fontSize: '0.75rem' }}
    >
      {message}
    </p>
  );
}

function TextField({
  label,
  path,
  value,
  onChange,
  errors,
  placeholder,
  inputMode,
}: {
  label: string;
  path: string;
  value: string;
  onChange: (value: string) => void;
  errors: Errors;
  placeholder?: string;
  inputMode?: 'numeric' | 'decimal';
}) {
  return (
    <div>
      <label htmlFor={`pf-${path}`} className="field-label">
        {label}
      </label>
      <input
        id={`pf-${path}`}
        type="text"
        className="field"
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldErrorText message={errors[path]} />
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}) {
  return (
    <div>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.375rem',
          fontSize: '0.875rem',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      {hint ? (
        <p className="hint faint" style={{ margin: '0.125rem 0 0 1.375rem' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function TriStateField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: TriState;
  onChange: (value: TriState) => void;
  hint?: string;
}) {
  return (
    <div>
      <span className="field-label">{label}</span>
      <select
        className="field"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as TriState)}
      >
        <option value="">Not set — asks a human</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
      {hint ? (
        <p className="hint faint" style={{ margin: '0.125rem 0 0' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card" style={{ marginTop: '0.75rem' }}>
      <h3 className="section-title" style={{ margin: '0 0 0.25rem' }}>
        {title}
      </h3>
      {hint ? (
        <p className="hint faint" style={{ margin: '0 0 0.75rem' }}>
          {hint}
        </p>
      ) : null}
      {children}
    </section>
  );
}

function RemoveRowButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="btn btn--sm"
      style={{ color: 'var(--danger-fg)', alignSelf: 'end' }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function ProfileEditor({
  initial,
  updatedAt,
  configured,
}: {
  initial: Profile;
  /** ISO timestamp of the last save; null when nothing is stored yet. */
  updatedAt: string | null;
  configured: boolean;
}) {
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    profileToDraft(initial),
  );
  const [errors, setErrors] = useState<Errors>({});
  const [errorList, setErrorList] = useState<
    { path: string; message: string }[]
  >([]);
  const [result, setResult] = useState<SaveProfileResult | null>(null);
  const [pending, startTransition] = useTransition();

  const set = (patch: Partial<ProfileDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }));

  const setEducation = (
    index: number,
    patch: Partial<ProfileDraft['education'][number]>,
  ) =>
    setDraft((prev) => ({
      ...prev,
      education: prev.education.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }));

  const setWork = (
    index: number,
    patch: Partial<ProfileDraft['work'][number]>,
  ) =>
    setDraft((prev) => ({
      ...prev,
      work: prev.work.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }));

  const setCustom = (index: number, patch: Partial<CustomDraft>) =>
    setDraft((prev) => ({
      ...prev,
      custom: prev.custom.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }));

  const setLocationAt = (index: number, value: string) =>
    setDraft((prev) => ({
      ...prev,
      preferredLocations: prev.preferredLocations.map((loc, i) =>
        i === index ? value : loc,
      ),
    }));

  const applyErrors = (list: { path: string; message: string }[]) => {
    const map: Errors = {};
    for (const err of list) {
      if (!(err.path in map)) map[err.path] = err.message;
    }
    setErrors(map);
    setErrorList(list);
  };

  const save = () => {
    const { profile, errors: clientErrors } = draftToProfileInput(draft);
    if (clientErrors.length > 0) {
      applyErrors(clientErrors);
      setResult({
        ok: false,
        message: 'the profile has invalid fields — fix the highlighted ones.',
      });
      return;
    }
    startTransition(async () => {
      const saved = await saveProfileAction(profile);
      applyErrors(saved.ok ? [] : (saved.fieldErrors ?? []));
      setResult(saved);
    });
  };

  return (
    <div>
      <Section
        title="Identity & contact"
        hint="Auto-fills name/email/phone standard fields on every platform."
      >
        <div style={fieldGrid}>
          <TextField
            label="First name"
            path="name.first"
            value={draft.firstName}
            onChange={(v) => set({ firstName: v })}
            errors={errors}
          />
          <TextField
            label="Last name"
            path="name.last"
            value={draft.lastName}
            onChange={(v) => set({ lastName: v })}
            errors={errors}
          />
          <TextField
            label="Email"
            path="email"
            value={draft.email}
            onChange={(v) => set({ email: v })}
            errors={errors}
            placeholder="you@example.com"
          />
          <TextField
            label="Phone"
            path="phone"
            value={draft.phone}
            onChange={(v) => set({ phone: v })}
            errors={errors}
            placeholder="+1 555 0100"
          />
        </div>
      </Section>

      <Section
        title="Location"
        hint="Answers “current location” questions as “City, State”."
      >
        <div style={fieldGrid}>
          <TextField
            label="City"
            path="location.city"
            value={draft.city}
            onChange={(v) => set({ city: v })}
            errors={errors}
          />
          <TextField
            label="State"
            path="location.state"
            value={draft.state}
            onChange={(v) => set({ state: v })}
            errors={errors}
            placeholder="NJ"
          />
          <TextField
            label="Country"
            path="location.country"
            value={draft.country}
            onChange={(v) => set({ country: v })}
            errors={errors}
            placeholder="USA"
          />
        </div>
      </Section>

      <Section
        title="Links"
        hint="Each answers its matching question (LinkedIn URL, GitHub, portfolio/website, Twitter). Leave blank to skip."
      >
        <div style={fieldGrid}>
          <TextField
            label="Website / portfolio"
            path="links.website"
            value={draft.website}
            onChange={(v) => set({ website: v })}
            errors={errors}
            placeholder="https://…"
          />
          <TextField
            label="GitHub"
            path="links.github"
            value={draft.github}
            onChange={(v) => set({ github: v })}
            errors={errors}
            placeholder="https://github.com/…"
          />
          <TextField
            label="LinkedIn"
            path="links.linkedin"
            value={draft.linkedin}
            onChange={(v) => set({ linkedin: v })}
            errors={errors}
            placeholder="https://www.linkedin.com/in/…"
          />
          <TextField
            label="Twitter"
            path="links.twitter"
            value={draft.twitter}
            onChange={(v) => set({ twitter: v })}
            errors={errors}
            placeholder="https://x.com/…"
          />
        </div>
      </Section>

      <Section
        title="Education"
        hint="The first entry answers plain “school”/“university” questions; “most recent school” uses end dates. Dates are YYYY-MM."
      >
        {draft.education.map((row, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional (no stable id)
            key={index}
            style={{
              ...rowGrid,
              padding: '0.5rem 0',
              borderTop: index === 0 ? undefined : '1px solid var(--line)',
            }}
          >
            <TextField
              label="School"
              path={`education.${index}.school`}
              value={row.school}
              onChange={(v) => setEducation(index, { school: v })}
              errors={errors}
            />
            <TextField
              label="Degree"
              path={`education.${index}.degree`}
              value={row.degree}
              onChange={(v) => setEducation(index, { degree: v })}
              errors={errors}
              placeholder="BSE"
            />
            <TextField
              label="Major"
              path={`education.${index}.major`}
              value={row.major}
              onChange={(v) => setEducation(index, { major: v })}
              errors={errors}
            />
            <TextField
              label="GPA (optional)"
              path={`education.${index}.gpa`}
              value={row.gpa}
              onChange={(v) => setEducation(index, { gpa: v })}
              errors={errors}
              inputMode="decimal"
              placeholder="3.9"
            />
            <TextField
              label="Start"
              path={`education.${index}.startDate`}
              value={row.startDate}
              onChange={(v) => setEducation(index, { startDate: v })}
              errors={errors}
              placeholder="2024-09"
            />
            <TextField
              label="End"
              path={`education.${index}.endDate`}
              value={row.endDate}
              onChange={(v) => setEducation(index, { endDate: v })}
              errors={errors}
              placeholder="2028-05"
            />
            <RemoveRowButton
              label="Remove school"
              onClick={() =>
                set({
                  education: draft.education.filter((_, i) => i !== index),
                })
              }
            />
          </div>
        ))}
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            set({ education: [...draft.education, emptyEducationRow()] })
          }
        >
          + Add school
        </button>
      </Section>

      <Section
        title="Work history"
        hint="Leave the end date blank for a CURRENT job — “current company/employer” questions only answer from an entry with no end date."
      >
        {draft.work.map((row, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional (no stable id)
            key={index}
            style={{
              padding: '0.5rem 0',
              borderTop: index === 0 ? undefined : '1px solid var(--line)',
            }}
          >
            <div style={rowGrid}>
              <TextField
                label="Company"
                path={`work.${index}.company`}
                value={row.company}
                onChange={(v) => setWork(index, { company: v })}
                errors={errors}
              />
              <TextField
                label="Title"
                path={`work.${index}.title`}
                value={row.title}
                onChange={(v) => setWork(index, { title: v })}
                errors={errors}
              />
              <TextField
                label="Start"
                path={`work.${index}.startDate`}
                value={row.startDate}
                onChange={(v) => setWork(index, { startDate: v })}
                errors={errors}
                placeholder="2025-06"
              />
              <TextField
                label="End (blank = current)"
                path={`work.${index}.endDate`}
                value={row.endDate}
                onChange={(v) => setWork(index, { endDate: v })}
                errors={errors}
                placeholder="2025-08"
              />
              <RemoveRowButton
                label="Remove job"
                onClick={() =>
                  set({ work: draft.work.filter((_, i) => i !== index) })
                }
              />
            </div>
            <div style={{ marginTop: '0.5rem' }}>
              <label
                htmlFor={`pf-work.${index}.description`}
                className="field-label"
              >
                Description (optional)
              </label>
              <textarea
                id={`pf-work.${index}.description`}
                className="field"
                rows={2}
                value={row.description}
                onChange={(e) =>
                  setWork(index, { description: e.target.value })
                }
              />
              <FieldErrorText message={errors[`work.${index}.description`]} />
            </div>
          </div>
        ))}
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => set({ work: [...draft.work, emptyWorkRow()] })}
        >
          + Add job
        </button>
      </Section>

      <Section
        title="Work authorization"
        hint="Answered strictly as Yes/No with guards (negated, non-US, or detail questions always go to a human). The opt-ins below stay unanswered until you set them."
      >
        <div style={{ display: 'grid', gap: '0.625rem' }}>
          <CheckboxField
            label="Authorized to work in the United States"
            checked={draft.usWorkAuthorized}
            onChange={(v) => set({ usWorkAuthorized: v })}
          />
          <CheckboxField
            label="Requires visa sponsorship"
            checked={draft.requiresSponsorship}
            onChange={(v) => set({ requiresSponsorship: v })}
          />
        </div>
        <div style={{ ...fieldGrid, marginTop: '0.75rem' }}>
          <TriStateField
            label="US citizen"
            value={draft.usCitizen}
            onChange={(v) => set({ usCitizen: v })}
            hint="Distinct from work authorization — only explicit citizenship questions use it (defense/government postings)."
          />
          <TriStateField
            label="US person (ITAR/EAR)"
            value={draft.usPerson}
            onChange={(v) => set({ usPerson: v })}
            hint="Citizen OR green-card holder — a separate opt-in from citizenship."
          />
          <TriStateField
            label="Active security clearance"
            value={draft.hasActiveSecurityClearance}
            onChange={(v) => set({ hasActiveSecurityClearance: v })}
            hint="“No” answers clearance surveys with the “I do not possess” option; “Yes” still sends the level/agency to a human."
          />
          <TriStateField
            label="Ever employed by the US Government"
            value={draft.everEmployedByUSGovernment}
            onChange={(v) => set({ everEmployedByUSGovernment: v })}
            hint="“No” answers government-employment conflict surveys."
          />
        </div>
      </Section>

      <Section
        title="Graduation & academics"
        hint="Feeds graduation-date questions and range/bucket selects (GPA bands, test-score ranges). Blank fields simply never answer."
      >
        <div style={fieldGrid}>
          <TextField
            label="Graduation month"
            path="graduation.date"
            value={draft.graduationDate}
            onChange={(v) => set({ graduationDate: v })}
            errors={errors}
            placeholder="2028-05"
          />
          <TextField
            label="Graduation year"
            path="graduation.year"
            value={draft.graduationYear}
            onChange={(v) => set({ graduationYear: v })}
            errors={errors}
            inputMode="numeric"
            placeholder="2028"
          />
          <TextField
            label="SAT total"
            path="academics.satTotal"
            value={draft.satTotal}
            onChange={(v) => set({ satTotal: v })}
            errors={errors}
            inputMode="numeric"
          />
          <TextField
            label="ACT composite"
            path="academics.actComposite"
            value={draft.actComposite}
            onChange={(v) => set({ actComposite: v })}
            errors={errors}
            inputMode="numeric"
          />
          <TextField
            label="GPA band lower bound"
            path="academics.gpaBandLow"
            value={draft.gpaBandLow}
            onChange={(v) => set({ gpaBandLow: v })}
            errors={errors}
            inputMode="decimal"
            placeholder="3.7"
          />
        </div>
      </Section>

      <Section
        title="Preferences"
        hint="Small facts some forms ask for. All optional."
      >
        <div style={fieldGrid}>
          <TriStateField
            label="Open to relocation"
            value={draft.openToRelocation}
            onChange={(v) => set({ openToRelocation: v })}
          />
          <TextField
            label="How did you hear about us"
            path="preferences.howDidYouHear"
            value={draft.howDidYouHear}
            onChange={(v) => set({ howDidYouHear: v })}
            errors={errors}
            placeholder="Job board"
          />
          <TextField
            label="Pronouns"
            path="preferences.pronouns"
            value={draft.pronouns}
            onChange={(v) => set({ pronouns: v })}
            errors={errors}
          />
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <span className="field-label">Preferred locations</span>
          {draft.preferredLocations.map((loc, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional (no stable id)
              key={index}
              className="row"
              style={{ marginBottom: '0.375rem' }}
            >
              <input
                type="text"
                className="field"
                aria-label={`preferred location ${index + 1}`}
                style={{ maxWidth: '20rem' }}
                value={loc}
                onChange={(e) => setLocationAt(index, e.target.value)}
              />
              <RemoveRowButton
                label="Remove"
                onClick={() =>
                  set({
                    preferredLocations: draft.preferredLocations.filter(
                      (_, i) => i !== index,
                    ),
                  })
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              set({ preferredLocations: [...draft.preferredLocations, ''] })
            }
          >
            + Add location
          </button>
        </div>
      </Section>

      <Section
        title="Custom answers"
        hint="Exact question label → answer, matched fuzzily on punctuation/case but otherwise exactly (like the answer library, but stored with the profile)."
      >
        {draft.custom.map((row, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional (no stable id)
            key={index}
            className="row"
            style={{ marginBottom: '0.375rem', alignItems: 'start' }}
          >
            <div style={{ flex: '1 1 16rem' }}>
              <input
                type="text"
                className="field"
                aria-label={`custom question ${index + 1}`}
                placeholder="question label, e.g. Expected salary"
                value={row.key}
                onChange={(e) => setCustom(index, { key: e.target.value })}
              />
              <FieldErrorText message={errors[`custom.${index}.key`]} />
            </div>
            <input
              type="text"
              className="field"
              aria-label={`custom answer ${index + 1}`}
              placeholder="answer"
              style={{ flex: '2 1 20rem', width: 'auto' }}
              value={row.value}
              onChange={(e) => setCustom(index, { value: e.target.value })}
            />
            <RemoveRowButton
              label="Remove"
              onClick={() =>
                set({ custom: draft.custom.filter((_, i) => i !== index) })
              }
            />
          </div>
        ))}
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            set({ custom: [...draft.custom, { key: '', value: '' }] })
          }
        >
          + Add custom answer
        </button>
      </Section>

      <div
        className="row"
        style={{ marginTop: '1rem', alignItems: 'baseline' }}
      >
        <button
          type="button"
          className="btn btn--primary"
          disabled={pending}
          onClick={save}
        >
          {pending ? 'Saving…' : configured ? 'Save profile' : 'Create profile'}
        </button>
        {updatedAt ? (
          <span className="hint faint" title={formatLocal(updatedAt)}>
            last saved {relativeTime(updatedAt)}
          </span>
        ) : (
          <span className="hint faint">never saved</span>
        )}
      </div>
      {result ? (
        <p
          role="status"
          className={result.ok ? 'status-ok' : 'status-err'}
          style={{ margin: '0.5rem 0 0', wordBreak: 'break-word' }}
        >
          {result.message}
        </p>
      ) : null}
      {errorList.length > 0 ? (
        <ul style={{ margin: '0.375rem 0 0', paddingLeft: '1.125rem' }}>
          {errorList.map((err) => (
            <li
              key={`${err.path}:${err.message}`}
              className="status-err"
              style={{ fontSize: '0.75rem' }}
            >
              <span className="mono">{err.path || '(profile)'}</span> —{' '}
              {err.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
