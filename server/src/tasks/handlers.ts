/**
 * The completion endpoint, as a handler the route table can pick up.
 *
 * Thin, like every other handler here: the gate established who is calling and
 * that they own the task, validation established that the body matches the
 * contract, and `create-completion.ts` owns the rules. What is left is the log
 * line the command owes, which names the task and the outcome and carries no
 * part of the observation: a step count is evidence and belongs on the
 * completion row, not in a log.
 */

import { AppError } from "../errors/app-error.ts";
import type { EndpointHandlers } from "../http/routes.ts";
import { type CreateCompletionDependencies, createCompletion } from "./create-completion.ts";

export function createTaskHandlers(deps: CreateCompletionDependencies): EndpointHandlers {
  return {
    createCompletion: async ({ body, params, session, idempotencyKey, logger }) => {
      if (idempotencyKey === undefined) {
        // The contract marks this endpoint idempotent and the validation
        // boundary refuses a request without a key, so reaching here means the
        // two disagree, which is ours to fix and not the caller's.
        throw new AppError("internal_error", "createCompletion reached its handler with no key");
      }

      const { response, replayed } = await createCompletion(deps, {
        accountId: session.accountId,
        taskId: params.taskId,
        idempotencyKey,
        body,
      });
      // The challenge's outcome rides in `result` rather than in a field of its
      // own: the closed field set has no place for a challenge status, and the
      // completion that ends a challenge is the one an operator wants to find.
      logger.info("completion acknowledged", {
        command: "createCompletion",
        result: replayed
          ? "replayed"
          : response.challengeStatus === "succeeded"
            ? "acknowledged_and_succeeded"
            : "acknowledged",
        taskId: params.taskId,
      });
      return response;
    },
  };
}
