/**
 * `POST /challenges/funding-intents`: authorizing a deposit.
 *
 * This is the funded door, and everything it does is preparation. It asks the
 * provider for a hold and records what that hold is for. It creates no
 * challenge, materializes no tasks, and captures nothing. The challenge appears
 * only when the provider says the authorization succeeded, which arrives as a
 * webhook and never as the client's own report.
 *
 * Three refusals happen before a key is spent, because each one is the caller's
 * to fix by sending a different request:
 *
 * - A zero deposit belongs to `POST /challenges`, so it is
 *   `deposit_required_for_funding` rather than a hold for nothing.
 * - A configuration whose last task falls past the maximum duration is refused
 *   outright here, where the projection only reported it. The rule exists
 *   because an authorization cannot be renewed forever, so it binds exactly at
 *   the moment an authorization is taken.
 * - An account that already holds a challenge cannot fund a second, which is
 *   checked under the account lock rather than before it.
 *
 * The provider call happens inside the transaction that records the intent, so
 * a hold and the terms it stands for either both exist or neither does. That is
 * safe for this one call in a way it would not be for a capture: authorizing is
 * reversible and free, and an intent that is created and then rolled back is a
 * hold nobody confirms, which expires on the provider's side having charged
 * nothing.
 */

import type { ChallengeConfiguration, CreateFundingIntentResponse } from "@betterwakeup/contract";

import type { Database } from "../db/client.ts";
import { fundingIntents } from "../db/schema/funding.ts";
import { AppError } from "../errors/app-error.ts";
import { runIdempotent, type Transaction } from "../idempotency/service.ts";
import type { PaymentProviderClient } from "../payments/provider.ts";
import { lockAccountAndAssertNoOpenChallenge } from "./materialize.ts";
import { assertDepositAmount, planChallenge } from "./plan.ts";

export interface FundingIntentDependencies {
  readonly db: Database;
  readonly provider: PaymentProviderClient;
  /** The clock the schedule is projected from. A test states the moment. */
  readonly now?: (() => Date) | undefined;
}

export interface CreateFundingIntentCommand {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly configuration: ChallengeConfiguration;
  readonly policyVersion: string;
}

export async function createFundingIntent(
  deps: FundingIntentDependencies,
  command: CreateFundingIntentCommand,
): Promise<{ response: CreateFundingIntentResponse; replayed: boolean }> {
  assertDepositAmount(command.configuration);
  if (command.configuration.deposit.amount === 0) {
    throw new AppError(
      "deposit_required_for_funding",
      "A funding intent authorizes a deposit. A challenge with no deposit is created directly.",
    );
  }

  const startingAt = (deps.now ?? (() => new Date()))();
  const plan = planChallenge(command.configuration, startingAt);
  if (!plan.projection.withinMaximumDuration) {
    throw new AppError(
      "maximum_duration_exceeded",
      "This schedule ends further ahead than an authorization can be kept alive.",
    );
  }

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "createFundingIntent",
      request: { configuration: command.configuration, policyVersion: command.policyVersion },
    },
    async (tx) => await authorize(tx, deps, command),
  );

  return { response: outcome.result, replayed: outcome.replayed };
}

async function authorize(
  tx: Transaction,
  deps: FundingIntentDependencies,
  command: CreateFundingIntentCommand,
): Promise<CreateFundingIntentResponse> {
  await lockAccountAndAssertNoOpenChallenge(tx, command.accountId);

  // The identifier is minted here rather than by the database, because it is
  // what the provider carries as metadata and therefore has to exist before
  // the row does: the delivery names the intent it answers.
  const fundingIntentId = crypto.randomUUID();
  const authorization = await deps.provider.authorizeDeposit({
    reference: fundingIntentId,
    customerReference: command.accountId,
    amount: {
      amountMinorUnits: command.configuration.deposit.amount,
      currency: command.configuration.deposit.currency,
    },
  });

  await tx.insert(fundingIntents).values({
    id: fundingIntentId,
    accountId: command.accountId,
    provider: deps.provider.name,
    providerAuthorizationId: authorization.authorizationId,
    status: "pending",
    configuration: command.configuration,
    policyVersion: command.policyVersion,
    depositMinorUnits: command.configuration.deposit.amount,
    depositCurrency: command.configuration.deposit.currency,
  });

  return {
    fundingIntentId,
    providerClientSecret: authorization.clientSecret,
    // The literal is the contract telling the app what to do next, and it is
    // the whole answer: there is no challenge to return, because none exists.
    pollAfterAuthorization: true,
  };
}
