/**
 * The session endpoints, as handlers the route table can mount.
 *
 * Both are thin on purpose: the boundary already parsed the body against the
 * contract, the gate already established who is calling, and `signIn` and
 * `signOut` own the rest. What is left is the one log line the architecture
 * asks for per command, which names the account but never the token, the
 * provider token, or the email.
 */

import type { EndpointHandlers } from "../http/routes.ts";
import { type SignInDependencies, signIn } from "./sign-in.ts";
import { type SignOutDependencies, signOut } from "./sign-out.ts";

export function createAuthHandlers(
  deps: SignInDependencies & SignOutDependencies,
): EndpointHandlers {
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

    deleteSession: async ({ session, logger }) => {
      await signOut(deps, session);
      logger.info("session revoked", {
        command: "deleteSession",
        result: "revoked",
        accountId: session.accountId,
      });
      return {};
    },
  };
}
