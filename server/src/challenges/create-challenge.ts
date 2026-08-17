/**
 * Creating a zero deposit challenge.
 *
 * This is the seam the phased plan calls out. A zero deposit challenge never
 * reaches the payment provider, so it is created and materialized in one
 * transaction and is active the moment the command returns. Everything the
 * completion path, the pause path, and the sweep act on exists from here, and
 * none of it has to wait for money.
 *
 * The command refuses any non-zero deposit with `zero_deposit_required`, which
 * is not a stopgap: `POST /challenges` is the unfunded door for good. A funded
 * configuration has to go through `POST /challenges/funding-intents`, because
 * the challenge must not exist until the provider says the authorization
 * succeeded, and a path that could create a funded challenge without that
 * confirmation is a path that lets a user start a challenge nobody can be
 * charged for.
 *
 * Writing the rows is `materializeChallenge`, which the payment webhook calls
 * too: the two doors differ in what has to be true before a challenge exists
 * and not in what a challenge is.
 */

import type { ChallengeConfiguration, CreateChallengeResponse } from "@betterwakeup/contract";

import type { Database } from "../db/client.ts";
import { AppError } from "../errors/app-error.ts";
import { runIdempotent, type Transaction } from "../idempotency/service.ts";
import { loadChallengeView } from "./challenge-view.ts";
import { lockAccountAndAssertNoOpenChallenge, materializeChallenge } from "./materialize.ts";
import { assertDepositAmount, planChallenge } from "./plan.ts";

export interface CreateChallengeDependencies {
  readonly db: Database;
  /** The clock the schedule is placed from. A test states the moment. */
  readonly now?: (() => Date) | undefined;
}

export interface CreateChallengeCommand {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly configuration: ChallengeConfiguration;
  readonly policyVersion: string;
}

export async function createChallenge(
  deps: CreateChallengeDependencies,
  command: CreateChallengeCommand,
): Promise<{ response: CreateChallengeResponse; replayed: boolean }> {
  // Both refusals are decided before a key is spent. A doomed request should
  // not consume the caller's idempotency key, because the caller's fix is to
  // send a different request under a new one anyway.
  assertDepositAmount(command.configuration);
  if (command.configuration.deposit.amount !== 0) {
    throw new AppError(
      "zero_deposit_required",
      "This endpoint creates zero deposit challenges only. Fund a challenge through a funding intent.",
    );
  }

  const startingAt = (deps.now ?? (() => new Date()))();
  const plan = planChallenge(command.configuration, startingAt);

  const outcome = await runIdempotent(
    deps.db,
    {
      accountId: command.accountId,
      key: command.idempotencyKey,
      commandType: "createChallenge",
      request: { configuration: command.configuration, policyVersion: command.policyVersion },
    },
    async (tx) => await insertChallenge(tx, command, plan, startingAt),
  );

  return { response: outcome.result, replayed: outcome.replayed };
}

async function insertChallenge(
  tx: Transaction,
  command: CreateChallengeCommand,
  plan: ReturnType<typeof planChallenge>,
  startingAt: Date,
): Promise<CreateChallengeResponse> {
  await lockAccountAndAssertNoOpenChallenge(tx, command.accountId);

  const challengeId = await materializeChallenge(tx, {
    accountId: command.accountId,
    configuration: command.configuration,
    policyVersion: command.policyVersion,
    plan,
    // A zero deposit challenge is active on creation: there is no
    // authorization to wait for, so the creating instant is the activating
    // instant.
    activatedAt: startingAt,
  });

  return { challenge: await loadChallengeView(tx, challengeId) };
}
