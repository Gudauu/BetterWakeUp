/**
 * The account deletion endpoint, as a handler the route table can mount.
 *
 * Thin, like the sign-in handler: the gate established who is calling and
 * `deleteAccount` owns the rule and the retention. What is left is the one log
 * line the architecture asks for per command, which names the account being
 * deleted because the request that follows it can no longer be traced to one.
 */

import type { EndpointHandlers } from "../http/routes.ts";
import { type DeleteAccountDependencies, deleteAccount } from "./delete-account.ts";

export function createAccountHandlers(deps: DeleteAccountDependencies): EndpointHandlers {
  return {
    deleteAccount: async ({ session, logger }) => {
      const response = await deleteAccount(deps, session.accountId);
      logger.info("account deleted", {
        command: "deleteAccount",
        result: "deleted",
        accountId: session.accountId,
      });
      return response;
    },
  };
}
