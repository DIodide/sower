export {
  decodeBase64Url,
  extractOtpCode,
  extractVerificationLink,
} from './extract.js';
export {
  ASSESSMENT_LINK_HOSTS,
  classifyFollowupMail,
  extractFollowupDueDate,
  type FollowupClassification,
  type FollowupMailInput,
  SCHEDULING_LINK_HOSTS,
} from './followup-classify.js';
export {
  buildSearchQuery,
  collectBodies,
  type GmailConfig,
  GmailInboxReader,
  type GmailMessageSummary,
  gmailConfigFromEnv,
} from './gmail.js';
export {
  buildMimeMessage,
  GmailSendScopeError,
  type OutgoingGmailMessage,
  sendGmailMessage,
} from './gmail-send.js';
export type { InboxReader, OtpQuery, OtpResult } from './types.js';
