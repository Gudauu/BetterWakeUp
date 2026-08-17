/**
 * The challenge endpoints, as handlers the route table can pick up: the
 * projection, creation, the current challenge, the time zone change, pause and
 * resume, Emergency Recovery, and the funding intent when a provider is
 * configured.
 *
 * Thin by design, like the account and sign-in handlers: the gate established
 * who is calling, validation established that the body matches the contract,
 * and the modules beside this one own the rules. What is left is the clock, the
 * log line each command owes, and the one place the projection's promise is
 * kept: it takes no database handle at all, so "nothing is written by a
 * projection call" is a property of the code rather than of a test.
 */

import { AppError } from "../errors/app-error.ts";
import type { EndpointHandlers } from "../http/routes.ts";
import type { PaymentProviderClient } from "../payments/provider.ts";
import { acceptRecovery } from "./accept-recovery.ts";
import { changeChallengeTimeZone } from "./change-time-zone.ts";
import { type CreateChallengeDependencies, createChallenge } from "./create-challenge.ts";
import { getCurrentChallenge } from "./current-challenge.ts";
import { createFundingIntent } from "./funding-intent.ts";
import { pauseChallenge, resumeChallenge } from "./pause.ts";
import { planChallenge } from "./plan.ts";
import { replacePaymentMethod } from "./replace-payment-method.ts";

export interface ChallengeHandlerDependencies extends CreateChallengeDependencies {
  /**
   * The payment provider. Optional, because the three unfunded endpoints work
   * without one: a deployment with no provider configured still projects,
   * creates zero deposit challenges, and reads the current one, and simply does
   * not mount the funded door.
   */
  readonly provider?: PaymentProviderClient | undefined;
}

/**
 * The idempotency key of a command the contract marks idempotent.
 *
 * The validation boundary refuses such a request without a key, so reaching a
 * handler with none means the registry and the boundary disagree, which is ours
 * to fix and not the caller's.
 */
function requireKey(command: string, key: string | undefined): string {
  if (key !== undefined) return key;
  throw new AppError("internal_error", `${command} reached its handler with no idempotency key`);
}

export function createChallengeHandlers(deps: ChallengeHandlerDependencies): EndpointHandlers {
  const now = deps.now ?? (() => new Date());
  const provider = deps.provider;

  return {
    createChallengeProjection: ({ body, logger }) => {
      const { projection } = planChallenge(body.configuration, now());
      logger.info("challenge projected", {
        command: "createChallengeProjection",
        result: projection.withinMaximumDuration
          ? "within_maximum_duration"
          : "exceeds_maximum_duration",
      });
      return projection;
    },

    createChallenge: async ({ body, session, idempotencyKey, logger }) => {
      const { response, replayed } = await createChallenge(deps, {
        accountId: session.accountId,
        idempotencyKey: requireKey("createChallenge", idempotencyKey),
        configuration: body.configuration,
        policyVersion: body.policyVersion,
      });
      logger.info("zero deposit challenge created", {
        command: "createChallenge",
        result: replayed ? "replayed" : "created",
        challengeId: response.challenge.id,
      });
      return response;
    },

    getCurrentChallenge: async ({ session }) => await getCurrentChallenge(deps, session.accountId),

    pauseChallenge: async ({ params, session, idempotencyKey, logger }) => {
      const { response, replayed } = await pauseChallenge(deps, {
        accountId: session.accountId,
        challengeId: params.challengeId,
        idempotencyKey: requireKey("pauseChallenge", idempotencyKey),
      });
      logger.info("challenge paused", {
        command: "pauseChallenge",
        result: replayed ? "replayed" : "paused",
        challengeId: response.challenge.id,
        // Which task the pause takes first is the one thing about a pause that
        // support is ever asked to explain, and it is the boundary the rule
        // turns on.
        ...(response.nextSkippedTask === null ? {} : { taskId: response.nextSkippedTask.id }),
      });
      return response;
    },

    changeChallengeTimeZone: async ({ params, body, session, idempotencyKey, logger }) => {
      const { response, replayed } = await changeChallengeTimeZone(deps, {
        accountId: session.accountId,
        challengeId: params.challengeId,
        idempotencyKey: requireKey("changeChallengeTimeZone", idempotencyKey),
        timeZone: body.timeZone,
      });
      // The zone itself is not logged: it is a place, it is on the challenge
      // row, and the closed field set has no home for it. How many tasks moved
      // is the part support is asked about, and it is what distinguishes a
      // change that landed inside a task's cutoff from one that did not.
      logger.info("challenge time zone changed", {
        command: "changeChallengeTimeZone",
        result: replayed
          ? "replayed"
          : `rematerialized_${response.rematerializedTasks.length}_tasks`,
        challengeId: response.challenge.id,
      });
      return response;
    },

    resumeChallenge: async ({ params, session, idempotencyKey, logger }) => {
      const { response, replayed } = await resumeChallenge(deps, {
        accountId: session.accountId,
        challengeId: params.challengeId,
        idempotencyKey: requireKey("resumeChallenge", idempotencyKey),
      });
      logger.info("challenge resumed", {
        command: "resumeChallenge",
        result: replayed ? "replayed" : "resumed",
        challengeId: response.challenge.id,
        ...(response.nextLiveTask === null ? {} : { taskId: response.nextLiveTask.id }),
      });
      return response;
    },

    acceptRecovery: async ({ params, body, session, idempotencyKey, logger }) => {
      const { response, replayed } = await acceptRecovery(deps, {
        accountId: session.accountId,
        challengeId: params.challengeId,
        idempotencyKey: requireKey("acceptRecovery", idempotencyKey),
        taskId: body.taskId,
      });
      // The forgiven task is the one support is asked about, because it is the
      // miss the user is disputing when they call. What was appended is on the
      // challenge and derivable from it.
      logger.info("emergency recovery consumed", {
        command: "acceptRecovery",
        result: replayed ? "replayed" : "recovered",
        challengeId: response.challenge.id,
        taskId: response.forgivenTask.id,
      });
      return response;
    },

    ...(provider === undefined
      ? {}
      : {
          createFundingIntent: async ({ body, session, idempotencyKey, logger }) => {
            const { response, replayed } = await createFundingIntent(
              { ...deps, provider },
              {
                accountId: session.accountId,
                idempotencyKey: requireKey("createFundingIntent", idempotencyKey),
                configuration: body.configuration,
                policyVersion: body.policyVersion,
              },
            );
            // The deposit amount is not logged: what was authorized is on the
            // funding intent row, and a log line is not the financial record.
            logger.info("deposit authorization requested", {
              command: "createFundingIntent",
              result: replayed ? "replayed" : "requested",
              paymentProvider: provider.name,
            });
            return response;
          },

          replacePaymentMethod: async ({ params, body, session, idempotencyKey, logger }) => {
            const { response, replayed } = await replacePaymentMethod(
              { ...deps, provider },
              {
                accountId: session.accountId,
                challengeId: params.challengeId,
                idempotencyKey: requireKey("replacePaymentMethod", idempotencyKey),
                providerPaymentMethodId: body.providerPaymentMethodId,
              },
            );
            // The instrument identifier is not logged: it is a payment
            // credential's handle, and the closed field set has no home for
            // one. That the challenge is secured again is the fact support is
            // asked about.
            logger.info("challenge payment method replaced", {
              command: "replacePaymentMethod",
              result: replayed ? "replayed" : "secured",
              challengeId: response.challenge.id,
              paymentProvider: provider.name,
            });
            return response;
          },
        }),
  };
}
