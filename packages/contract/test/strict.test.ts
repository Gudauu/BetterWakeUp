/**
 * Requests reject what they do not recognize, and responses do not.
 *
 * The first half of this suite is about `deepStrict` itself: that it reaches
 * every level, that it keeps the refinements attached to the schemas it
 * rebuilds, and that it refuses to walk a construct it has not been taught,
 * rather than leaving a silent hole. The second half checks the property that
 * actually matters, over the registry: no request schema anywhere in the
 * contract accepts an unknown key.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  challengeConfiguration,
  createChallengeRequest,
  createCompletionRequest,
  DISCLOSURE_POLICY_VERSION,
  deepStrict,
  ENDPOINTS,
  getCurrentChallengeResponse,
  paymentWebhookRequest,
} from "../src/index.ts";

const CONFIGURATION = {
  requiredTaskCount: 5,
  schedule: [{ weekday: "monday", deadline: "07:30" }],
  stepTarget: 500,
  noRegretMinutes: 60,
  timeZone: "America/Los_Angeles",
  deposit: { amount: 2000, currency: "USD" },
};

describe("deepStrict", () => {
  it("rejects an unknown key at the top level", () => {
    const result = deepStrict(challengeConfiguration).safeParse({
      ...CONFIGURATION,
      stepTargets: 500,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("rejects an unknown key nested inside an object", () => {
    const result = deepStrict(challengeConfiguration).safeParse({
      ...CONFIGURATION,
      deposit: { amount: 2000, currency: "USD", refundable: true },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["deposit"]);
  });

  it("rejects an unknown key nested inside an array element", () => {
    const result = deepStrict(challengeConfiguration).safeParse({
      ...CONFIGURATION,
      schedule: [{ weekday: "monday", deadline: "07:30", timeZone: "UTC" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["schedule", 0]);
  });

  it("keeps a refinement attached to an object it rebuilt", () => {
    // A deposit is either zero or at least the funded minimum.
    const result = deepStrict(challengeConfiguration).safeParse({
      ...CONFIGURATION,
      deposit: { amount: 50, currency: "USD" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("zero or at least");
  });

  it("keeps a refinement attached to an array it rebuilt", () => {
    // A weekday may appear in the schedule at most once.
    const result = deepStrict(challengeConfiguration).safeParse({
      ...CONFIGURATION,
      schedule: [
        { weekday: "monday", deadline: "07:30" },
        { weekday: "monday", deadline: "08:30" },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("at most once");
  });

  it("leaves a schema that already decided about unknown keys alone", () => {
    // The payment webhook is a `looseObject`: the provider owns the payload.
    const result = deepStrict(paymentWebhookRequest).safeParse({
      id: "evt_1",
      type: "authorization.succeeded",
      livemode: false,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ livemode: false });
  });

  it("accepts a valid request unchanged", () => {
    const request = { configuration: CONFIGURATION, policyVersion: DISCLOSURE_POLICY_VERSION };
    expect(deepStrict(createChallengeRequest).parse(request)).toEqual(request);
  });

  it("throws rather than silently passing a construct it cannot walk", () => {
    expect(() => deepStrict(z.record(z.string(), z.object({ a: z.string() })))).toThrow(
      /does not know how to walk a schema of type "record"/,
    );
  });
});

describe("the registry's request schemas", () => {
  for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
    const request = endpoint.request;
    if (request === null) continue;
    it(`rejects an unknown field on ${name}`, () => {
      // Every one of these bodies is invalid for other reasons too; what is
      // asserted is that the unknown key is among the reported problems. The
      // webhook is the one exception, and it is an explicit one.
      const result = request.safeParse({ thisFieldDoesNotExist: true });
      const codes = (result.error?.issues ?? []).map((issue) => issue.code);
      const loose = request === ENDPOINTS.receivePaymentWebhook.request;
      expect(codes.includes("unrecognized_keys")).toBe(!loose);
    });
  }

  it("carries a strict path parameter schema wherever the path has parameters", () => {
    for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
      const declared = [...endpoint.path.matchAll(/:(\w+)/g)].map((match) => match[1]);
      expect({ name, params: endpoint.params !== null }).toEqual({
        name,
        params: declared.length > 0,
      });
      if (endpoint.params === null) continue;
      expect(
        endpoint.params.safeParse(Object.fromEntries(declared.map((p) => [p, "x"]))).success,
      ).toBe(false);
    }
  });
});

describe("response schemas", () => {
  it("tolerate a field an older app has never heard of", () => {
    const response = {
      challenge: null,
      // A field a later version of the server added.
      serverTime: "2026-08-17T06:31:00Z",
    };
    const parsed = getCurrentChallengeResponse.safeParse(response);
    expect(parsed.success).toBe(true);
    // Tolerated on the way in, and not carried into the app's own value.
    expect(parsed.data).toEqual({ challenge: null });
  });

  it("are built without mutating the schemas the strict requests were built from", () => {
    const completion = {
      clientRecordId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      completedAt: "2026-08-17T06:31:00Z",
      observation: {
        startedAt: "2026-08-17T06:25:00Z",
        endedAt: "2026-08-17T06:31:00Z",
        steps: 640,
        provenance: "live-foreground",
        source: "expo-pedometer-ios",
      },
      appVersion: "1.0.0",
      verificationPolicyVersion: "2026-08-01",
    };
    // The registry's copy rejects the extra field; the schema it was derived
    // from is untouched and still strips it, because `deepStrict` rebuilds.
    expect(ENDPOINTS.createCompletion.request.safeParse({ ...completion, extra: 1 }).success).toBe(
      false,
    );
    expect(createCompletionRequest.parse({ ...completion, extra: 1 })).toEqual(completion);
  });
});
