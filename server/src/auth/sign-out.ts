/**
 * Sign-out: the session that made the request stops working.
 *
 * The token is not the authority on its own validity, the row is, which is what
 * makes signing out mean something: a copy of the token taken off the device is
 * useless the moment `revoked_at` is set, without waiting for the signed expiry
 * the app cannot shorten.
 *
 * Only the caller's own session is revoked. Signing out on one device leaving
 * the others signed in is the behaviour a user expects, and the gate has proved
 * exactly one session identifier, so there is nothing to widen it to.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { sessions } from "../db/schema/identity.ts";
import type { AuthenticatedSession } from "./session-gate.ts";

export interface SignOutDependencies {
  readonly db: Pick<Database, "update">;
  /** Injected so a test asserts the recorded instant rather than tolerating it. */
  readonly now?: () => Date;
}

export async function signOut(
  deps: SignOutDependencies,
  session: AuthenticatedSession,
): Promise<void> {
  // `is null` keeps the first revocation's instant: a repeat of the command
  // must not rewrite when the session actually ended. There is no need to
  // report whether a row was updated, because a revoked session cannot reach
  // this handler a second time anyway, and sign-out has nothing to refuse.
  await deps.db
    .update(sessions)
    .set({ revokedAt: deps.now?.() ?? new Date() })
    .where(and(eq(sessions.id, session.sessionId), isNull(sessions.revokedAt)));
}
