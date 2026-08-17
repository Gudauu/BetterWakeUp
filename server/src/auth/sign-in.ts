/**
 * Sign-in: a verified provider identity becomes an internal account and a
 * session.
 *
 * The mapping is the whole point of this file. Every domain table references
 * the internal account identifier and nothing else, so `sub`, `iss`, and the
 * provider name stop here. Two rules govern the mapping:
 *
 * - The key is `(issuer, subject)`, which is the unique index the identity
 *   schema already carries. An email address is never a key: Apple's private
 *   relay would split one person across two accounts the first time they
 *   revoked an alias, and a shared address would merge two people into one.
 * - A person who signs in with both providers gets two accounts. Version 1 has
 *   no account-linking flow, and silently merging on any weaker signal than a
 *   provider identity would be a way to take over somebody else's challenges.
 */

import type { CreateSessionRequest, CreateSessionResponse } from "@betterwakeup/contract";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { accounts, providerIdentities, sessions } from "../db/schema/identity.ts";
import { AppError } from "../errors/app-error.ts";
import type { Transaction } from "../idempotency/service.ts";
import type { ProviderTokenVerifier, VerifiedIdentity } from "./provider-tokens.ts";
import { hashSessionToken, mintSessionToken } from "./session-token.ts";

export interface SignInDependencies {
  readonly db: Pick<Database, "transaction">;
  readonly verifier: ProviderTokenVerifier;
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  /** Injected so a test asserts the issued expiry rather than tolerating it. */
  readonly now?: () => Date;
}

/**
 * Two concurrent first sign-ins by the same person race on the identity's
 * unique index. The loser rolls its account insert back and reads the winner's
 * row, which is one retry; a second collision would mean the winner's row is
 * not there to read, which is not a race but a bug.
 */
const MAX_ATTEMPTS = 2;

export async function signIn(
  deps: SignInDependencies,
  request: CreateSessionRequest,
): Promise<CreateSessionResponse> {
  // Outside the transaction: verification may fetch a JWKS over the network,
  // and nothing about a rejected token should ever have held a database
  // transaction open.
  const identity = await deps.verifier.verify(request.provider, request.idToken);
  const now = deps.now?.() ?? new Date();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const outcome = await deps.db
      .transaction(async (tx) => {
        const account = await resolveAccount(tx, identity, request.displayName, now);
        if (account === undefined) {
          // Lost the race. Throwing is what rolls the orphaned account insert
          // back; returning would commit an account nobody can sign in to.
          throw new IdentityRace();
        }
        return await issueSession(tx, deps, account, identity.email, now);
      })
      .catch((thrown: unknown) => {
        if (thrown instanceof IdentityRace) return undefined;
        throw thrown;
      });

    if (outcome !== undefined) return outcome;
  }

  throw new AppError("internal_error", "Sign-in could not resolve an account for the identity.");
}

/** The account row this identity maps to, or undefined when a race lost. */
async function resolveAccount(
  tx: Transaction,
  identity: VerifiedIdentity,
  displayName: string | undefined,
  now: Date,
): Promise<AccountRow | undefined> {
  const existing = await tx
    .select({ identityId: providerIdentities.id, account: accountColumns })
    .from(providerIdentities)
    .innerJoin(accounts, eq(accounts.id, providerIdentities.accountId))
    .where(
      and(
        eq(providerIdentities.issuer, identity.issuer),
        eq(providerIdentities.subject, identity.subject),
      ),
    )
    .limit(1);

  const found = existing[0];
  if (found !== undefined) {
    await tx
      .update(providerIdentities)
      // The email is refreshed because it is display text and the provider's
      // copy is the current one; it is never compared, and never a key.
      .set({ lastAuthenticatedAt: now, email: identity.email })
      .where(eq(providerIdentities.id, found.identityId));
    return await applyDisplayName(tx, found.account, displayName, now);
  }

  const inserted = await tx
    .insert(accounts)
    .values({ displayName: displayName ?? null, createdAt: now, updatedAt: now })
    .returning(accountColumns);
  const account = inserted[0];
  if (account === undefined) {
    throw new AppError("internal_error", "The account insert returned no row.");
  }

  const identityRows = await tx
    .insert(providerIdentities)
    .values({
      accountId: account.id,
      provider: identity.provider,
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      createdAt: now,
      lastAuthenticatedAt: now,
    })
    // The unique index on (issuer, subject) is the concurrency control: the
    // loser of a simultaneous first sign-in gets no row rather than an error
    // it would have to inspect a SQLSTATE to understand.
    .onConflictDoNothing()
    .returning({ id: providerIdentities.id });

  return identityRows[0] === undefined ? undefined : account;
}

/**
 * Apple returns the display name on the first authorization and never again,
 * so the app forwards whatever it has. It fills a blank and never overwrites a
 * name the account already carries.
 */
async function applyDisplayName(
  tx: Transaction,
  account: AccountRow,
  displayName: string | undefined,
  now: Date,
): Promise<AccountRow> {
  if (displayName === undefined || account.displayName !== null) return account;
  await tx.update(accounts).set({ displayName, updatedAt: now }).where(eq(accounts.id, account.id));
  return { ...account, displayName };
}

async function issueSession(
  tx: Transaction,
  deps: SignInDependencies,
  account: AccountRow,
  email: string | null,
  now: Date,
): Promise<CreateSessionResponse> {
  const minted = await mintSessionToken({
    secret: deps.sessionSecret,
    accountId: account.id,
    ttlSeconds: deps.sessionTtlSeconds,
    now,
  });

  await tx.insert(sessions).values({
    id: minted.sessionId,
    accountId: account.id,
    // The token itself is never written down. What is stored recognizes a
    // presented token and cannot be presented as one.
    tokenHash: hashSessionToken(minted.token),
    createdAt: minted.issuedAt,
    expiresAt: minted.expiresAt,
  });

  return {
    session: {
      accountId: account.id,
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
    },
    account: {
      id: account.id,
      displayName: account.displayName,
      // Display text from the identity that just signed in, which is null
      // whenever the provider withheld it or gave a private relay alias.
      email,
      createdAt: account.createdAt.toISOString(),
      emergencyRecoveryAvailable: account.emergencyRecoveryConsumedAt === null,
    },
  };
}

const accountColumns = {
  id: accounts.id,
  displayName: accounts.displayName,
  createdAt: accounts.createdAt,
  emergencyRecoveryConsumedAt: accounts.emergencyRecoveryConsumedAt,
};

interface AccountRow {
  readonly id: string;
  readonly displayName: string | null;
  readonly createdAt: Date;
  readonly emergencyRecoveryConsumedAt: Date | null;
}

/** Internal control flow, never seen outside this module. */
class IdentityRace extends Error {}
