/**
 * The handler set the deployed function serves.
 *
 * Separate from `runtime.ts` because which endpoints a deployment mounts is a
 * product fact worth a test, while the rest of the composition root is Neon
 * pools and Parameter Store reads that a test cannot hold. Composing the set
 * here lets `handler-set.test.ts` check it against the contract's list of
 * endpoints a client can call, so an endpoint the app calls and the deployment
 * forgot to mount is a red test rather than a 404 on a device.
 *
 * Every feature module's handlers take the same two dependencies, a database
 * handle and a clock, so this file is the mapping and nothing more.
 */

import { createAccountHandlers } from "../accounts/handlers.ts";
import { createAuthHandlers } from "../auth/handlers.ts";
import type { ProviderTokenVerifier } from "../auth/provider-tokens.ts";
import { createChallengeHandlers } from "../challenges/handlers.ts";
import type { Database } from "../db/index.ts";
import type { EndpointHandlers } from "../http/routes.ts";
import type { PaymentProviderClient } from "../payments/provider.ts";
import { createTaskHandlers } from "../tasks/handlers.ts";

export interface HandlerSetDependencies {
  readonly db: Database;
  readonly verifier: ProviderTokenVerifier;
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  /**
   * The payment provider. Optional: a deployment without one still serves the
   * unfunded surface, and the two funded endpoints are absent rather than
   * mounted over a provider that is not there. See `createChallengeHandlers`.
   */
  readonly provider?: PaymentProviderClient | undefined;
  /** The clock every command reads. A test states the moment. */
  readonly now?: (() => Date) | undefined;
}

export function createHandlerSet(deps: HandlerSetDependencies): EndpointHandlers {
  const database = { db: deps.db, ...(deps.now === undefined ? {} : { now: deps.now }) };

  return {
    ...createAuthHandlers({
      db: deps.db,
      verifier: deps.verifier,
      sessionSecret: deps.sessionSecret,
      sessionTtlSeconds: deps.sessionTtlSeconds,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
    ...createAccountHandlers({ db: deps.db }),
    ...createChallengeHandlers({
      ...database,
      ...(deps.provider === undefined ? {} : { provider: deps.provider }),
    }),
    ...createTaskHandlers(database),
  };
}
