/**
 * The sign-in endpoint, as a handler the route table can mount.
 *
 * The handler is thin on purpose: the boundary already parsed the body against
 * the contract, and `signIn` owns the mapping and the session. What is left is
 * the one log line the architecture asks for per command, which names the
 * account but never the token, the provider token, or the email.
 */

import type { EndpointHandlers } from "../http/routes.ts";
import { type SignInDependencies, signIn } from "./sign-in.ts";

export function createAuthHandlers(deps: SignInDependencies): EndpointHandlers {
  return {
    createSession: async ({ body, logger }) => {
      const response = await signIn(deps, body);
      logger.info("session issued", {
        command: "createSession",
        result: "issued",
        accountId: response.session.accountId,
      });
      return response;
    },
  };
}
