/**
 * Pure extraction of one-time codes and verification links from email text.
 * No I/O here — GmailInboxReader feeds decoded message bodies in; tests
 * exercise these directly against real-world-shaped Workday emails.
 */

/**
 * Keywords that mark a nearby number as a one-time code (Workday wording
 * varies by tenant: "verification code", "security code", "one-time
 * passcode", "Your code is", …).
 */
const CODE_KEYWORD_RE =
  /\b(?:verification|security|one[\s-]?time|access|confirmation)\s+(?:code|passcode|pin)\b|\bOTP\b|\byour\s+code\b|\bcode\s+is\b/i;

/** A standalone 4-8 digit run (optionally split like "123 456" / "123-456"). */
const CODE_TOKEN_RE = /(?<![\d-])(\d{3}[\s-]\d{3}|\d{4,8})(?![\d-])/g;

/**
 * Extract the most likely one-time code: the digit run closest AFTER a code
 * keyword (falling back to the closest before). Returns null when the text
 * has no code keyword at all — a bare number in an unrelated email (a salary
 * figure, a requisition id) must never be mistaken for an OTP.
 */
export function extractOtpCode(text: string): string | null {
  const keywordMatch = CODE_KEYWORD_RE.exec(text);
  if (!keywordMatch) {
    return null;
  }
  const keywordEnd = keywordMatch.index + keywordMatch[0].length;

  let bestAfter: { code: string; distance: number } | null = null;
  let bestBefore: { code: string; distance: number } | null = null;
  for (const match of text.matchAll(CODE_TOKEN_RE)) {
    const raw = match[1];
    if (raw === undefined || match.index === undefined) continue;
    const code = raw.replace(/[\s-]/g, '');
    // Years (2024-2032) adjacent to keywords are far likelier to be dates.
    if (/^20[2-3]\d$/.test(code)) continue;
    if (match.index >= keywordEnd) {
      const distance = match.index - keywordEnd;
      if (!bestAfter || distance < bestAfter.distance) {
        bestAfter = { code, distance };
      }
    } else {
      const distance = keywordMatch.index - match.index;
      if (!bestBefore || distance < bestBefore.distance) {
        bestBefore = { code, distance };
      }
    }
  }
  return bestAfter?.code ?? bestBefore?.code ?? null;
}

/** Hosts a Workday verification/activation link can live on. */
const WORKDAY_LINK_HOST_RE =
  /^[a-z0-9-]+\.wd\d+\.(?:myworkdayjobs|myworkdaysite)\.com$/i;

/** Path/query words that mark a link as a verify/activate action. */
const VERIFY_WORD_RE = /verif|activat|confirm/i;

/**
 * Extract a Workday verification link from an email body (plain text or
 * HTML). Only links on *.myworkdayjobs.com / *.myworkdaysite.com whose
 * path or query mentions verify/activate/confirm qualify.
 */
export function extractVerificationLink(body: string): string | null {
  // Grab candidate URLs from hrefs and bare text alike.
  const urlRe = /https?:\/\/[^\s"'<>)\]]+/gi;
  for (const match of body.matchAll(urlRe)) {
    // HTML entity-encoded ampersands appear inside href attributes.
    const candidate = match[0].replace(/&amp;/gi, '&');
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (!WORKDAY_LINK_HOST_RE.test(url.hostname)) {
      continue;
    }
    if (VERIFY_WORD_RE.test(url.pathname) || VERIFY_WORD_RE.test(url.search)) {
      return url.toString();
    }
  }
  return null;
}

/** Decode Gmail's base64url body data to utf8 text. */
export function decodeBase64Url(data: string): string {
  return Buffer.from(
    data.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString('utf8');
}
