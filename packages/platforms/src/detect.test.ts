import { describe, expect, it } from 'vitest';
import { detectPlatform } from './detect.js';

describe('detectPlatform', () => {
  describe('greenhouse hosted boards', () => {
    it('detects boards.greenhouse.io/{token}/jobs/{id}', () => {
      expect(
        detectPlatform('https://boards.greenhouse.io/stripe/jobs/7954688'),
      ).toEqual({
        platform: 'greenhouse',
        tenant: 'stripe',
        externalId: '7954688',
      });
    });

    it('detects job-boards.greenhouse.io/{token}/jobs/{id}', () => {
      expect(
        detectPlatform('https://job-boards.greenhouse.io/datadog/jobs/1234567'),
      ).toEqual({
        platform: 'greenhouse',
        tenant: 'datadog',
        externalId: '1234567',
      });
    });

    it('detects boards.eu.greenhouse.io/{token}/jobs/{id}', () => {
      expect(
        detectPlatform('https://boards.eu.greenhouse.io/acme/jobs/42'),
      ).toEqual({
        platform: 'greenhouse',
        tenant: 'acme',
        externalId: '42',
      });
    });

    it('detects job-boards.eu.greenhouse.io/{token}/jobs/{id}', () => {
      expect(
        detectPlatform('https://job-boards.eu.greenhouse.io/acme/jobs/42'),
      ).toEqual({
        platform: 'greenhouse',
        tenant: 'acme',
        externalId: '42',
      });
    });

    it('ignores trailing path segments and query params', () => {
      expect(
        detectPlatform(
          'https://boards.greenhouse.io/stripe/jobs/7954688/application?utm_source=x',
        ),
      ).toEqual({
        platform: 'greenhouse',
        tenant: 'stripe',
        externalId: '7954688',
      });
    });

    it('returns unknown for a greenhouse board host without the jobs pattern', () => {
      expect(detectPlatform('https://boards.greenhouse.io/stripe')).toEqual({
        platform: 'unknown',
        tenant: null,
        externalId: null,
      });
    });
  });

  describe('greenhouse embed job_app URLs', () => {
    it('detects boards.greenhouse.io/embed/job_app?for={tenant}&token={id}', () => {
      expect(
        detectPlatform(
          'https://boards.greenhouse.io/embed/job_app?for=stripe&token=7954688',
        ),
      ).toEqual({
        platform: 'greenhouse',
        tenant: 'stripe',
        externalId: '7954688',
      });
    });

    it('detects embed URLs with extra query params on eu hosts', () => {
      expect(
        detectPlatform(
          'https://boards.eu.greenhouse.io/embed/job_app?for=acme&token=42&b=https%3A%2F%2Facme.com%2Fcareers',
        ),
      ).toEqual({ platform: 'greenhouse', tenant: 'acme', externalId: '42' });
    });

    it('returns unknown for an embed URL missing the for param', () => {
      expect(
        detectPlatform('https://boards.greenhouse.io/embed/job_app?token=42'),
      ).toEqual({ platform: 'unknown', tenant: null, externalId: null });
    });

    it('returns unknown for an embed URL missing the token param', () => {
      expect(
        detectPlatform('https://boards.greenhouse.io/embed/job_app?for=acme'),
      ).toEqual({ platform: 'unknown', tenant: null, externalId: null });
    });

    it('does not treat embed/job_app on a non-greenhouse host as greenhouse', () => {
      expect(
        detectPlatform('https://example.com/embed/job_app?for=acme&token=42'),
      ).toEqual({ platform: 'unknown', tenant: null, externalId: null });
    });
  });

  describe('greenhouse gh_jid embeds', () => {
    it('keeps tenant null for gh_jid on a custom domain', () => {
      expect(
        detectPlatform('https://acme.com/careers/apply?gh_jid=123456'),
      ).toEqual({
        platform: 'greenhouse',
        tenant: null,
        externalId: '123456',
      });
    });

    it('detects a gh_jid query param on any host', () => {
      expect(
        detectPlatform('https://stripe.com/jobs/search?gh_jid=7954688'),
      ).toEqual({
        platform: 'greenhouse',
        tenant: null,
        externalId: '7954688',
      });
    });

    it('detects gh_jid among other query params', () => {
      expect(
        detectPlatform(
          'https://example.com/careers?utm_source=li&gh_jid=99&x=1',
        ),
      ).toEqual({
        platform: 'greenhouse',
        tenant: null,
        externalId: '99',
      });
    });
  });

  describe('lever', () => {
    it('detects jobs.lever.co/{tenant}/{id}', () => {
      expect(
        detectPlatform(
          'https://jobs.lever.co/acme/1a2b3c4d-5e6f-7890-abcd-ef0123456789',
        ),
      ).toEqual({
        platform: 'lever',
        tenant: 'acme',
        externalId: '1a2b3c4d-5e6f-7890-abcd-ef0123456789',
      });
    });

    it('detects lever apply URLs with a trailing segment', () => {
      expect(
        detectPlatform('https://jobs.lever.co/acme/1a2b3c4d/apply'),
      ).toEqual({
        platform: 'lever',
        tenant: 'acme',
        externalId: '1a2b3c4d',
      });
    });

    it('returns unknown for a lever tenant page without a job id', () => {
      expect(detectPlatform('https://jobs.lever.co/acme')).toEqual({
        platform: 'unknown',
        tenant: null,
        externalId: null,
      });
    });
  });

  describe('ashby', () => {
    it('detects jobs.ashbyhq.com/{tenant}/{id}', () => {
      expect(
        detectPlatform(
          'https://jobs.ashbyhq.com/acme/aaaabbbb-cccc-dddd-eeee-ffff00001111',
        ),
      ).toEqual({
        platform: 'ashby',
        tenant: 'acme',
        externalId: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
      });
    });

    it('returns unknown for an ashby tenant page without a job id', () => {
      expect(detectPlatform('https://jobs.ashbyhq.com/acme')).toEqual({
        platform: 'unknown',
        tenant: null,
        externalId: null,
      });
    });
  });

  describe('workday', () => {
    it('detects {tenant}.wd{N}.myworkdayjobs.com with tenant from the subdomain', () => {
      expect(
        detectPlatform(
          'https://acme.wd5.myworkdayjobs.com/en-US/External/job/NYC/Engineer_R123',
        ),
      ).toEqual({ platform: 'workday', tenant: 'acme', externalId: null });
    });

    it('detects other wd{N} numbers', () => {
      expect(
        detectPlatform('https://big-corp.wd12.myworkdayjobs.com/careers'),
      ).toEqual({
        platform: 'workday',
        tenant: 'big-corp',
        externalId: null,
      });
    });

    it('does not match lookalike hosts that merely end in myworkdayjobs.com', () => {
      expect(
        detectPlatform('https://evil.example.myworkdayjobs.com/careers'),
      ).toEqual({
        platform: 'unknown',
        tenant: null,
        externalId: null,
      });
    });
  });

  describe('junk input', () => {
    const unknown = { platform: 'unknown', tenant: null, externalId: null };

    it('returns unknown for a non-URL string', () => {
      expect(detectPlatform('not a url at all')).toEqual(unknown);
    });

    it('returns unknown for an empty string', () => {
      expect(detectPlatform('')).toEqual(unknown);
    });

    it('returns unknown for an unrelated site', () => {
      expect(detectPlatform('https://example.com/jobs/123')).toEqual(unknown);
    });

    it('returns unknown for a lookalike greenhouse host', () => {
      expect(
        detectPlatform('https://boards.greenhouse.io.evil.com/acme/jobs/1'),
      ).toEqual(unknown);
    });

    it('returns unknown for a relative path', () => {
      expect(detectPlatform('/stripe/jobs/123')).toEqual(unknown);
    });
  });
});
