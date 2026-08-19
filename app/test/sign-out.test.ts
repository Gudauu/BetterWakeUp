/**
 * Signing out is the quietest press in the app and one of the most expensive:
 * the challenge is the server's, so it carries on counting deadlines the phone
 * can no longer meet, and the alarms come off the device with the session.
 * These tests are about what the user is told before that happens - and about
 * the case where nothing is at stake and they should be told nothing at all.
 */

import { signOutConsequence } from "../src/session/sign-out.ts";
import { challengeView, PAUSED_AT, taskView } from "./support/fake-api.ts";

describe("what signing out would cost", () => {
  it("says nothing where there is no challenge and nothing held on the phone", () => {
    // A confirmation over a press with no consequence teaches the user to
    // confirm without reading.
    expect(signOutConsequence({ challenge: null, heldWalks: 0 })).toBeNull();
  });

  it("names the deadlines that keep counting and the alarms that stop", () => {
    const text = signOutConsequence({
      challenge: challengeView({ currentTask: taskView() }),
      heldWalks: 0,
    });

    expect(text).toContain("keeps running without you");
    expect(text).toContain("only a walk taken in the app can meet one");
    expect(text).toContain("wake-up reminders on this phone will be turned off");
  });

  it("names the money still on the line", () => {
    const text = signOutConsequence({
      challenge: challengeView({
        configuration: {
          ...challengeView().configuration,
          deposit: { amount: 2000, currency: "USD" },
        },
      }),
      heldWalks: 0,
    });

    expect(text).toContain("$20.00 still on the line");
  });

  it("says nothing about a deposit where nothing is staked", () => {
    const text = signOutConsequence({ challenge: challengeView(), heldWalks: 0 });

    expect(text).toContain("keeps running without you.");
    expect(text).not.toContain("on the line");
  });

  it("tells a paused challenge that nothing restarts it but this app", () => {
    // A pause counts no deadlines, so the running warning would be a falsehood;
    // what is worth saying is that it never resumes on its own.
    const text = signOutConsequence({
      challenge: challengeView({ pause: { pausedAt: PAUSED_AT, expiresAt: null } }),
      heldWalks: 0,
    });

    expect(text).toContain("stays paused");
    expect(text).toContain("never resumes on its own");
    expect(text).not.toContain("deadlines still count");
  });

  it("names a walk this phone has not managed to send, and when it will go", () => {
    // `heldWalksText` promises they send themselves as soon as the app can
    // reach the server, which stops being true with no session to send with.
    const one = signOutConsequence({ challenge: null, heldWalks: 1 });
    const many = signOutConsequence({ challenge: null, heldWalks: 3 });

    expect(one).toContain("A walk you saved is still on this phone");
    expect(one).toContain("sign back in to this account");
    expect(many).toContain("3 walks you saved are still on this phone");
  });

  it("states a challenge it could not read as a condition rather than staying silent", () => {
    const text = signOutConsequence({ challenge: null, heldWalks: 0, challengeUnknown: true });

    expect(text).toContain("could not be read");
    expect(text).toContain("If one is running");
    expect(text).toContain("wake-up reminders on this phone will be turned off");
  });
});
