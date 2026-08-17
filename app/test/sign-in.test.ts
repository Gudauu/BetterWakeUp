/**
 * The sign-in flow's three outcomes.
 *
 * The distinction the tests are here for is cancellation: a user who dismissed
 * the provider's sheet must be told nothing, and a build that reported that as
 * a failure would accuse the app of being broken on every stray tap.
 */

import type { CreateSessionResponse } from "@betterwakeup/contract";
import type { ApiClient, ApiRequest, ClientEndpointName } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";
import { signInWithProvider } from "../src/auth/sign-in.ts";
import { appleCredential, fakeProvider } from "./support/fake-providers.ts";

const SESSION_RESPONSE: CreateSessionResponse = {
  session: {
    accountId: "11111111-1111-4111-8111-111111111111",
    token: "session-token",
    expiresAt: "2027-01-01T00:00:00.000Z",
  },
  account: {
    id: "11111111-1111-4111-8111-111111111111",
    email: null,
    displayName: "Ada Lovelace",
    emergencyRecoveryAvailable: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
};

interface Recorded {
  readonly name: ClientEndpointName;
  readonly input: ApiRequest<ClientEndpointName>;
}

function apiThat(answer: () => unknown): { api: ApiClient; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const api: ApiClient = {
    request: async (name, input) => {
      requests.push({ name, input } as Recorded);
      return answer() as never;
    },
  };
  return { api, requests };
}

describe("signInWithProvider", () => {
  it("exchanges the provider credential for a session", async () => {
    const { api, requests } = apiThat(() => SESSION_RESPONSE);

    const outcome = await signInWithProvider({
      api,
      provider: fakeProvider({ result: appleCredential() }),
    });

    expect(outcome).toEqual({ status: "signedIn", session: SESSION_RESPONSE.session });
    // The credential is posted as the contract's body and nothing is added to
    // it: the display name is Apple's, and the email is deliberately absent.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.name).toBe("createSession");
    expect(requests[0]?.input.body).toEqual(appleCredential());
  });

  it("reports a dismissed sheet as cancelled and never calls the server", async () => {
    const { api, requests } = apiThat(() => SESSION_RESPONSE);

    const outcome = await signInWithProvider({ api, provider: fakeProvider({ result: null }) });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(requests).toHaveLength(0);
  });

  it("reports a failing native flow as a failure with one plain sentence", async () => {
    const { api } = apiThat(() => SESSION_RESPONSE);

    const outcome = await signInWithProvider({
      api,
      provider: fakeProvider({ result: new Error("RNGoogleSignin: native module is null") }),
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      // The SDK's own message names a native module, which tells the user
      // nothing they can act on, so it is not the message they see.
      expect(outcome.message).not.toContain("RNGoogleSignin");
      expect(outcome.message).toBe("Sign-in failed. Try again in a moment.");
    }
  });

  it("tells a rejected credential apart from an unreachable server", async () => {
    const rejected = await signInWithProvider({
      api: apiThat(() => {
        throw new ApiError("unauthenticated", "The provider token is not valid.", { status: 401 });
      }).api,
      provider: fakeProvider({ result: appleCredential() }),
    });
    const offline = await signInWithProvider({
      api: apiThat(() => {
        throw new ApiError("internal_error", "The request did not reach the server.", {
          status: null,
        });
      }).api,
      provider: fakeProvider({ result: appleCredential() }),
    });

    expect(rejected.status).toBe("failed");
    expect(offline.status).toBe("failed");
    if (rejected.status === "failed" && offline.status === "failed") {
      expect(rejected.message).toContain("could not be verified");
      expect(offline.message).toContain("No connection");
      expect(offline.message).not.toBe(rejected.message);
    }
  });

  it("does not repeat an operator-facing code to the user", async () => {
    const outcome = await signInWithProvider({
      api: apiThat(() => {
        throw new ApiError("internal_error", "connection pool exhausted", { status: 500 });
      }).api,
      provider: fakeProvider({ result: appleCredential() }),
    });

    expect(outcome).toEqual({
      status: "failed",
      message: "Sign-in failed. Try again in a moment.",
    });
  });
});
