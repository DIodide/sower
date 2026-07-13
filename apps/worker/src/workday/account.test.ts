import { describe, expect, it } from 'vitest';
import { bootstrapAccount, submitVerificationCode } from './account.js';
import { FakeWorkdayPage } from './fake-page.js';

const cred = { email: 'ibraheem.amin2@gmail.com', password: 'S3cret-pw!' };

describe('bootstrapAccount — sign-in', () => {
  it('fills email/password, submits, and returns signed-in once the auth form is gone', async () => {
    const page = new FakeWorkdayPage([
      {
        present: ['email', 'password', 'signInSubmitButton'],
        advancesOn: ['signInSubmitButton'],
      },
      // Advanced past auth (no email/password) -> success.
      { heading: 'My Information', present: ['pageFooterNextButton'] },
    ]);
    const outcome = await bootstrapAccount(page, cred, 'sign-in');
    expect(outcome).toBe('signed-in');
    expect(page.log.filled).toEqual([
      { id: 'email', value: cred.email },
      { id: 'password', value: cred.password },
    ]);
    expect(page.log.clicked).toContain('signInSubmitButton');
  });

  it('clicks the sign-in link first when the create view is shown', async () => {
    const page = new FakeWorkdayPage([
      {
        present: ['signInLink', 'email', 'password', 'signInSubmitButton'],
        advancesOn: ['signInSubmitButton'],
      },
      { heading: 'My Information' },
    ]);
    await bootstrapAccount(page, cred, 'sign-in');
    expect(page.log.clicked[0]).toBe('signInLink');
  });

  it('returns failed when the auth inputs are absent', async () => {
    const page = new FakeWorkdayPage([{ present: [] }]);
    expect(await bootstrapAccount(page, cred, 'sign-in')).toBe('failed');
  });

  it('returns failed when the auth form persists after submit (captcha/rejected)', async () => {
    // The submit does NOT advance: email/password are still present, no OTP.
    const page = new FakeWorkdayPage([
      {
        present: ['email', 'password', 'signInSubmitButton'],
        advancesOn: [],
      },
    ]);
    expect(await bootstrapAccount(page, cred, 'sign-in')).toBe('failed');
  });

  it('returns needs-otp when a verification input appears after submit', async () => {
    const page = new FakeWorkdayPage([
      {
        present: ['email', 'password', 'signInSubmitButton'],
        advancesOn: ['signInSubmitButton'],
      },
      { present: ['verificationCode'] },
    ]);
    expect(await bootstrapAccount(page, cred, 'sign-in')).toBe('needs-otp');
  });
});

describe('bootstrapAccount — create', () => {
  it('fills email/password/verify, checks consent, submits -> created', async () => {
    const page = new FakeWorkdayPage([
      {
        present: [
          'createAccountLink',
          'email',
          'password',
          'verifyPassword',
          'createAccountCheckbox',
          'createAccountSubmitButton',
        ],
        advancesOn: ['createAccountSubmitButton'],
      },
      { heading: 'My Information' },
    ]);
    const outcome = await bootstrapAccount(page, cred, 'create');
    expect(outcome).toBe('created');
    expect(page.log.clicked[0]).toBe('createAccountLink');
    expect(page.log.filled).toEqual([
      { id: 'email', value: cred.email },
      { id: 'password', value: cred.password },
      { id: 'verifyPassword', value: cred.password },
    ]);
    expect(page.log.checked).toContain('createAccountCheckbox');
    expect(page.log.clicked).toContain('createAccountSubmitButton');
  });

  it('tolerates a tenant with no verify-password field / no checkbox', async () => {
    const page = new FakeWorkdayPage([
      {
        present: ['email', 'password', 'createAccountSubmitButton'],
        advancesOn: ['createAccountSubmitButton'],
      },
      { heading: 'My Information' },
    ]);
    expect(await bootstrapAccount(page, cred, 'create')).toBe('created');
  });

  it('returns needs-otp when verification is required after create', async () => {
    const page = new FakeWorkdayPage([
      {
        present: ['email', 'password', 'createAccountSubmitButton'],
        advancesOn: ['createAccountSubmitButton'],
      },
      { present: ['otpCode'] },
    ]);
    expect(await bootstrapAccount(page, cred, 'create')).toBe('needs-otp');
  });

  it('returns failed when create submit is rejected (form persists)', async () => {
    const page = new FakeWorkdayPage([
      {
        present: ['email', 'password', 'createAccountSubmitButton'],
        advancesOn: [],
      },
    ]);
    expect(await bootstrapAccount(page, cred, 'create')).toBe('failed');
  });
});

describe('submitVerificationCode', () => {
  it('fills the code and clicks verify', async () => {
    const page = new FakeWorkdayPage([
      { present: ['verificationCode', 'verifyEmailSubmitButton'] },
    ]);
    expect(await submitVerificationCode(page, '482913')).toBe(true);
    expect(page.log.filled).toEqual([
      { id: 'verificationCode', value: '482913' },
    ]);
    expect(page.log.clicked).toContain('verifyEmailSubmitButton');
  });

  it('returns false when no OTP input is present', async () => {
    const page = new FakeWorkdayPage([{ present: [] }]);
    expect(await submitVerificationCode(page, '482913')).toBe(false);
  });
});
