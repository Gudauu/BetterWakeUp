/**
 * The wait between authorizing a hold and having a challenge.
 *
 * The money is already committed by the time this runs, so what matters is
 * that the app keeps looking, that it can tell "not yet" from "cannot ask",
 * and that giving up says so instead of pretending the challenge never
 * existed.
 */

import { awaitFundedChallenge } from "../src/challenges/funded-challenge.ts";
import { challengeView, fakeApi } from "./support/fake-api.ts";

/** Waits nothing at all, so a ten attempt loop costs no time here. */
const immediately = async () => {};

describe("waiting for a funded challenge", () => {
  it("returns the challenge the moment the provider's confirmation lands", async () => {
    const challenge = challengeView();
    let reads = 0;
    const api = fakeApi({
      getCurrentChallenge: () => {
        reads += 1;
        return { challenge: reads < 3 ? null : challenge, lastEnded: null };
      },
    });

    const outcome = await awaitFundedChallenge(api, { sleep: immediately });

    expect(outcome).toEqual({ status: "created", challenge });
    // It stopped asking once it had an answer.
    expect(reads).toBe(3);
  });

  it("gives up as pending rather than as failed when the hold is still clearing", async () => {
    const api = fakeApi({ getCurrentChallenge: { challenge: null, lastEnded: null } });

    const outcome = await awaitFundedChallenge(api, { attempts: 4, sleep: immediately });

    expect(outcome).toEqual({ status: "pending" });
    expect(api.names().filter((name) => name === "getCurrentChallenge")).toHaveLength(4);
  });

  it("keeps asking through a read that did not come back", async () => {
    const challenge = challengeView();
    let reads = 0;
    const api = fakeApi({
      getCurrentChallenge: () => {
        reads += 1;
        return reads === 1 ? new Error("network down") : { challenge, lastEnded: null };
      },
    });

    const outcome = await awaitFundedChallenge(api, { sleep: immediately });

    expect(outcome).toEqual({ status: "created", challenge });
  });

  it("reports the last read's failure when every attempt is spent", async () => {
    const api = fakeApi({ getCurrentChallenge: () => new Error("network down") });

    const outcome = await awaitFundedChallenge(api, { attempts: 2, sleep: immediately });

    expect(outcome.status).toBe("failed");
  });

  it("stops asking once the screen that wanted it is gone", async () => {
    const controller = new AbortController();
    const api = fakeApi({ getCurrentChallenge: { challenge: null, lastEnded: null } });

    const outcome = await awaitFundedChallenge(api, {
      attempts: 5,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });

    expect(outcome).toEqual({ status: "pending" });
    expect(api.names()).toHaveLength(1);
  });
});
