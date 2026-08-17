/**
 * The three challenge endpoints issue 18 mounts, as handlers the route table
 * can pick up.
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
import { type CreateChallengeDependencies, createChallenge } from "./create-challenge.ts";
import { getCurrentChallenge } from "./current-challenge.ts";
import { createFundingIntent } from "./funding-intent.ts";
import { planChallenge } from "./plan.ts";

export interface ChallengeHandlerDependencies extends CreateChallengeDependencies {
  /**
   * The payment provider. Optional, because the three unfunded endpoints work
   * without one: a deployment with no provider configured still projects,
   * creates zero deposit challenges, and reads the current one, and simply does
   * not mount the funded door.
   */
  readonly provider?: PaymentProviderClient | undefined;
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
      if (idempotencyKey === undefined) {
        // The contract marks this endpoint idempotent and the validation
        // boundary refuses a request without a key, so reaching here means the
        // two disagree, which is ours to fix and not the caller's.
        throw new AppError("internal_error", "createChallenge reached its handler with no key");
      }

      const { response, replayed } = await createChallenge(deps, {
        accountId: session.accountId,
        idempotencyKey,
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

    ...(provider === undefined
      ? {}
      : {
          createFundingIntent: async ({ body, session, idempotencyKey, logger }) => {
            if (idempotencyKey === undefined) {
              throw new AppError(
                "internal_error",
                "createFundingIntent reached its handler with no key",
              );
            }

            const { response, replayed } = await createFundingIntent(
              { ...deps, provider },
              {
                accountId: session.accountId,
                idempotencyKey,
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
        }),
  };
}
