import type { Account, Database } from '@sower/db';
import { accounts } from '@sower/db';
import type { Storage } from '@sower/storage';
import { and, eq } from 'drizzle-orm';
import { generatePassword } from './password.js';

/**
 * The credential JSON stored in the vault (GCS in production, local dir in
 * dev) — the SAME IAM-locked bucket that holds resumes. The password NEVER
 * touches the database; the accounts row carries only the storage key
 * (secret_ref). Secret Manager was considered and rejected: at ~1000 Workday
 * tenants its per-secret pricing dwarfs the bucket's, for the same IAM story.
 */
export interface AccountCredential {
  platform: string;
  tenant: string;
  site: string | null;
  email: string;
  password: string;
  /** ISO timestamp of credential generation. */
  createdAt: string;
}

/** Reject anything that could break out of the vault prefix. */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function assertSafeSegment(name: string, value: string): void {
  if (!SAFE_SEGMENT_RE.test(value)) {
    throw new Error(
      `invalid ${name} for credential path: ${JSON.stringify(value)}`,
    );
  }
}

/** Vault key for a tenant's credential JSON. */
export function credentialStoragePath(
  platform: string,
  tenant: string,
): string {
  assertSafeSegment('platform', platform);
  assertSafeSegment('tenant', tenant);
  return `accounts/${platform}/${tenant}/credential.json`;
}

export interface EnsureAccountInput {
  platform: string;
  tenant: string;
  /** Career-site path segment (e.g. 'External_Careers'), when known. */
  site?: string | null;
  /** The candidate email — must match the application email (Workday rule). */
  email: string;
}

export interface EnsureAccountResult {
  account: Account;
  credential: AccountCredential;
  /** True when this call provisioned the account (vs found an existing one). */
  created: boolean;
}

/**
 * Provisions and reads per-tenant candidate-account credentials.
 *
 * ensureAccount is idempotent: one account per (platform, tenant), enforced
 * by the accounts_platform_tenant_uq index — a concurrent double-provision
 * resolves to the single winning row. The vault write happens BEFORE the DB
 * insert so a row never references a credential that failed to persist.
 */
export class AccountManager {
  constructor(
    private readonly db: Database,
    private readonly storage: Storage,
  ) {}

  /** Get an existing account + credential, or provision a new one. */
  async ensureAccount(input: EnsureAccountInput): Promise<EnsureAccountResult> {
    const existing = await this.findAccount(input.platform, input.tenant);
    if (existing) {
      const credential = await this.readCredential(existing);
      return { account: existing, credential, created: false };
    }

    // Reuse a credential already in the vault (e.g. a previous run whose DB
    // insert failed) instead of generating a second password for the same
    // tenant — once a password may have been typed into a real sign-up form,
    // regenerating it would orphan that account.
    const storagePath = credentialStoragePath(input.platform, input.tenant);
    if (!(await this.storage.exists(storagePath))) {
      const fresh: AccountCredential = {
        platform: input.platform,
        tenant: input.tenant,
        site: input.site ?? null,
        email: input.email,
        password: generatePassword(),
        createdAt: new Date().toISOString(),
      };
      await this.storage.put(
        storagePath,
        Buffer.from(JSON.stringify(fresh, null, 2)),
        'application/json',
      );
    }

    const inserted = await this.db
      .insert(accounts)
      .values({
        platform: input.platform,
        tenant: input.tenant,
        site: input.site ?? null,
        emailAlias: input.email,
        secretRef: storagePath,
        status: 'provisioned',
      })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];

    // Whether we won or lost a concurrent-provision race, the row and the
    // vault object now both exist exactly once — re-read the vault so every
    // caller returns the credential that is actually stored (never a
    // just-generated value a racing writer may have preceded).
    const account =
      row ?? (await this.findAccount(input.platform, input.tenant));
    if (!account) {
      throw new Error(
        `account insert conflicted but no row exists for ${input.platform}/${input.tenant}`,
      );
    }
    return {
      account,
      credential: await this.readCredential(account),
      created: row !== undefined,
    };
  }

  /** Read the credential for an existing account (null when none exists). */
  async getCredential(
    platform: string,
    tenant: string,
  ): Promise<AccountCredential | null> {
    const account = await this.findAccount(platform, tenant);
    if (!account) {
      return null;
    }
    return this.readCredential(account);
  }

  /** Advance the account lifecycle (provisioned -> registered -> verified). */
  async setStatus(
    platform: string,
    tenant: string,
    status: Account['status'],
  ): Promise<void> {
    await this.db
      .update(accounts)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(accounts.platform, platform), eq(accounts.tenant, tenant)));
  }

  private async findAccount(
    platform: string,
    tenant: string,
  ): Promise<Account | null> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.platform, platform), eq(accounts.tenant, tenant)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async readCredential(account: Account): Promise<AccountCredential> {
    if (!account.secretRef) {
      throw new Error(
        `account ${account.platform}/${account.tenant} has no credential reference`,
      );
    }
    const raw = await this.storage.get(account.secretRef);
    return JSON.parse(raw.toString('utf8')) as AccountCredential;
  }
}
