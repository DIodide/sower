/**
 * Builders for the Workday "calypso" application section payloads — the exact
 * JSON bodies each `POST .../jobapplication/{id}/{section}` expects, derived
 * from a real datasite application HAR (verified live 2026-07-12).
 *
 * These are US-centric: they use Workday's stable reference GUIDs for the
 * United States. Non-US applicants need the corresponding country / region /
 * phone-code GUIDs (a lookup against the cxs reference data — a follow-up).
 */

/** Workday reference GUIDs (stable across tenants; match the public cxs API). */
export const WORKDAY_REF = {
  /** Country: United States of America. */
  US_COUNTRY: 'bc33aa3152ec42d4995f4791a106ed09',
  /** Country phone code: United States of America (+1). */
  US_PHONE_CODE: 'db8d3ca6446c11de98360015c5e6daf6',
} as const;

/** `POST .../{jaid}/name` */
export function buildNameSection(
  firstName: string,
  lastName: string,
): Record<string, unknown> {
  return {
    legalName: {
      firstName,
      lastName,
      country: { id: WORKDAY_REF.US_COUNTRY },
    },
    preferredCheck: false,
  };
}

/** `POST .../{jaid}/emailaddress` */
export function buildEmailSection(email: string): Record<string, unknown> {
  return { emailAddress: email };
}

/** `POST .../{jaid}/phonenumber` (digits only; extension left blank). */
export function buildPhoneSection(
  phoneNumber: string,
): Record<string, unknown> {
  return {
    countryPhoneCode: {
      id: WORKDAY_REF.US_PHONE_CODE,
      descriptor: 'United States of America (+1)',
    },
    extension: '',
    phoneNumber: phoneNumber.replace(/[^0-9]/g, ''),
  };
}
