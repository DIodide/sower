/** A request to find a tenant's OTP / verification email. */
export interface OtpQuery {
  /** Platform tenant slug (e.g. Workday 'cadence') — used to rank matches. */
  tenant: string;
  /** Only messages received after this instant qualify (the sign-in attempt). */
  since: Date;
  /** waitForOtp polling budget in ms (default 120_000). */
  timeoutMs?: number;
  /** waitForOtp polling interval in ms (default 5_000). */
  pollIntervalMs?: number;
}

export interface OtpResult {
  /** The one-time code, when the email carries one. */
  code: string | null;
  /** A verification/activation link, when the email carries one instead. */
  verificationUrl: string | null;
  source: 'gmail';
  messageId: string;
  receivedAt: Date | null;
}

/**
 * An inbox that can surface OTP / verification emails. GmailInboxReader is
 * the automated implementation; when it is not configured the Discord
 * fallback (apps/api OTP card + modal) covers the same need manually.
 */
export interface InboxReader {
  /** Single search pass — null when no matching mail exists yet. */
  findOtp(query: OtpQuery): Promise<OtpResult | null>;
  /** Poll until a result or the timeout budget runs out. */
  waitForOtp(query: OtpQuery): Promise<OtpResult | null>;
}
