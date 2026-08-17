/**
 * The one module that talks to SSM.
 *
 * Kept alone behind `SecretSource` for the same reason the mobile app keeps
 * Sentry and the native sign-in SDKs alone: everything worth testing about
 * secret resolution lives in `secrets.ts`, and nothing here has a decision in
 * it beyond how the SDK is called.
 */

import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { SecretSource } from "./secrets.ts";

/**
 * How many parameters one `GetParameters` call accepts.
 *
 * The secret set is four, so this never actually chunks today. It is here
 * because a fifth secret added years from now would otherwise fail at runtime
 * with an SDK validation error rather than being read.
 */
export const GET_PARAMETERS_BATCH_SIZE = 10;

/** The single SDK call this module makes, narrowed so a test can stand in. */
export interface SsmSendPort {
  send(command: GetParametersCommand): Promise<{
    Parameters?: { Name?: string; Value?: string }[];
  }>;
}

export interface ParameterStoreOptions {
  readonly region?: string;
  /** Injected only by a test that needs to observe the SDK call. */
  readonly client?: SsmSendPort;
}

/** A `SecretSource` backed by SSM Parameter Store, decrypting SecureStrings. */
export function parameterStoreSource(options: ParameterStoreOptions = {}): SecretSource {
  const client: SsmSendPort =
    options.client ??
    (new SSMClient(options.region ? { region: options.region } : {}) as SsmSendPort);

  return {
    async read(parameterNames) {
      const resolved: Record<string, string> = {};
      for (let index = 0; index < parameterNames.length; index += GET_PARAMETERS_BATCH_SIZE) {
        const batch = parameterNames.slice(index, index + GET_PARAMETERS_BATCH_SIZE);
        const response = await client.send(
          // WithDecryption is what makes a SecureString readable, and is the
          // reason the role's grant is a read on these names rather than on a
          // path wildcard.
          new GetParametersCommand({ Names: [...batch], WithDecryption: true }),
        );
        for (const parameter of response.Parameters ?? []) {
          if (parameter.Name !== undefined && typeof parameter.Value === "string") {
            resolved[parameter.Name] = parameter.Value;
          }
        }
        // InvalidParameters is deliberately ignored here: a missing parameter is
        // an absent key, and `loadSecrets` reports every absence at once with
        // the names it was asked for, which is a better message than the SDK's.
      }
      return resolved;
    },
  };
}
