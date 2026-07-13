import { describe, expect, it } from 'vitest';
import {
  decodeBase64Url,
  extractOtpCode,
  extractVerificationLink,
} from './extract.js';

describe('extractOtpCode', () => {
  it('finds the code after the keyword (typical Workday wording)', () => {
    expect(
      extractOtpCode(
        'Your one-time passcode is 482913. It expires in 10 minutes.',
      ),
    ).toBe('482913');
    expect(
      extractOtpCode(
        'Use verification code 55031 to continue your application.',
      ),
    ).toBe('55031');
    expect(extractOtpCode('Your code is: 9074')).toBe('9074');
  });

  it('finds a code stated before the keyword', () => {
    expect(
      extractOtpCode('482913 is your security code for Candidate Home.'),
    ).toBe('482913');
  });

  it('handles split codes like "123 456" and "123-456"', () => {
    expect(extractOtpCode('Your verification code is 123 456.')).toBe('123456');
    expect(extractOtpCode('Your verification code is 123-456.')).toBe('123456');
  });

  it('prefers the code nearest the keyword over other numbers', () => {
    expect(
      extractOtpCode(
        'Requisition R246731. Your verification code is 88220. Posted 2026.',
      ),
    ).toBe('88220');
  });

  it('never treats a year as a code', () => {
    expect(
      extractOtpCode('Your verification code expires in 2026. Code: 771034'),
    ).toBe('771034');
  });

  it('returns null when there is no code keyword (bare numbers are not OTPs)', () => {
    expect(
      extractOtpCode('Thanks for applying to job 482913 at Cadence!'),
    ).toBeNull();
    expect(extractOtpCode('')).toBeNull();
  });

  it('returns null when a keyword exists but no digit run does', () => {
    expect(
      extractOtpCode('Enter the verification code we sent to your phone.'),
    ).toBeNull();
  });
});

describe('extractVerificationLink', () => {
  it('finds a Workday verify link in HTML', () => {
    const html =
      '<a href="https://cadence.wd1.myworkdayjobs.com/wday/verifyEmail?token=abc&amp;locale=en_US">Verify</a>';
    expect(extractVerificationLink(html)).toBe(
      'https://cadence.wd1.myworkdayjobs.com/wday/verifyEmail?token=abc&locale=en_US',
    );
  });

  it('finds an activation link in plain text on myworkdaysite.com', () => {
    expect(
      extractVerificationLink(
        'Click https://acme.wd5.myworkdaysite.com/recruiting/activate?key=xyz to activate.',
      ),
    ).toBe('https://acme.wd5.myworkdaysite.com/recruiting/activate?key=xyz');
  });

  it('ignores non-workday hosts and non-verify workday links', () => {
    expect(
      extractVerificationLink('https://evil.example.com/verify?token=abc'),
    ).toBeNull();
    expect(
      extractVerificationLink(
        'https://cadence.wd1.myworkdayjobs.com/en-US/external_careers/job/SAN-JOSE/Intern_R1',
      ),
    ).toBeNull();
  });

  it('returns null for empty/linkless text', () => {
    expect(extractVerificationLink('no links here')).toBeNull();
  });
});

describe('decodeBase64Url', () => {
  it('decodes gmail base64url payloads (with -/_ alphabet)', () => {
    const encoded = Buffer.from('code is 123456 ~?~', 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(decodeBase64Url(encoded)).toBe('code is 123456 ~?~');
  });
});
