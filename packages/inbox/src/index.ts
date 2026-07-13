export {
  decodeBase64Url,
  extractOtpCode,
  extractVerificationLink,
} from './extract.js';
export {
  buildSearchQuery,
  collectBodies,
  type GmailConfig,
  GmailInboxReader,
  gmailConfigFromEnv,
} from './gmail.js';
export type { InboxReader, OtpQuery, OtpResult } from './types.js';
