import { describe, expect, it } from 'vitest';
import {
  followupEventDetails,
  followupIdOf,
  followupKindTone,
  followupStateTone,
  urlHost,
} from './followups';

describe('followupStateTone', () => {
  it('states needing the user read attention', () => {
    expect(followupStateTone('RECEIVED')).toBe('attention');
    expect(followupStateTone('ACTION_NEEDED')).toBe('attention');
  });

  it('scheduled is in motion; waiting-on-them is quiet', () => {
    expect(followupStateTone('SCHEDULED')).toBe('progress');
    expect(followupStateTone('WAITING')).toBe('neutral');
  });

  it('terminal states: done green, dismissed quiet', () => {
    expect(followupStateTone('DONE')).toBe('success');
    expect(followupStateTone('DISMISSED')).toBe('neutral');
  });

  it('unknown states degrade to neutral, never throw', () => {
    expect(followupStateTone('SOMETHING_NEW')).toBe('neutral');
  });
});

describe('followupKindTone', () => {
  it('outcomes carry their verdict', () => {
    expect(followupKindTone('offer')).toBe('success');
    expect(followupKindTone('rejection')).toBe('danger');
  });

  it('process kinds stay quiet or accented', () => {
    expect(followupKindTone('assessment')).toBe('accent');
    expect(followupKindTone('interview')).toBe('progress');
    expect(followupKindTone('recruiter')).toBe('neutral');
    expect(followupKindTone('other')).toBe('neutral');
  });

  it('unknown kinds degrade to neutral', () => {
    expect(followupKindTone('mystery')).toBe('neutral');
  });
});

describe('urlHost', () => {
  it('extracts the hostname for the "Open <host>" label', () => {
    expect(urlHost('https://app.hackerrank.com/tests/abc?x=1')).toBe(
      'app.hackerrank.com',
    );
  });

  it('strips a www. prefix (the brand, not the plumbing)', () => {
    expect(urlHost('https://www.hackerrank.com/x')).toBe('hackerrank.com');
  });

  it('falls back to "link" for unparseable urls', () => {
    expect(urlHost('not a url')).toBe('link');
    expect(urlHost('')).toBe('link');
  });
});

describe('followupIdOf', () => {
  it('reads followupId out of event data', () => {
    expect(followupIdOf({ followupId: 'abc-123', kind: 'interview' })).toBe(
      'abc-123',
    );
  });

  it('null for absent, empty, or non-object data', () => {
    expect(followupIdOf({})).toBeNull();
    expect(followupIdOf({ followupId: '' })).toBeNull();
    expect(followupIdOf({ followupId: 42 })).toBeNull();
    expect(followupIdOf(null)).toBeNull();
    expect(followupIdOf(undefined)).toBeNull();
    expect(followupIdOf('followupId')).toBeNull();
    expect(followupIdOf(['followupId'])).toBeNull();
  });
});

describe('followupEventDetails', () => {
  it('reads the transition triple when recorded', () => {
    expect(
      followupEventDetails({
        followupId: 'x',
        event: 'SCHEDULE',
        from: 'RECEIVED',
        to: 'SCHEDULED',
      }),
    ).toEqual({ event: 'SCHEDULE', from: 'RECEIVED', to: 'SCHEDULED' });
  });

  it('missing or malformed fields are simply null', () => {
    expect(followupEventDetails({ event: 'RESOLVE' })).toEqual({
      event: 'RESOLVE',
      from: null,
      to: null,
    });
    expect(followupEventDetails({ from: 7, to: '' })).toEqual({
      event: null,
      from: null,
      to: null,
    });
    expect(followupEventDetails(null)).toEqual({
      event: null,
      from: null,
      to: null,
    });
    expect(followupEventDetails([1, 2])).toEqual({
      event: null,
      from: null,
      to: null,
    });
  });
});
