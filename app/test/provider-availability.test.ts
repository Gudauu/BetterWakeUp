import {
  CHECKING_MESSAGE,
  type ProviderChecks,
  signInOptions,
  UNAVAILABLE_MESSAGE,
  UNKNOWN_MESSAGE,
} from "../src/auth/provider-availability.ts";

function checked(checks: ProviderChecks) {
  return signInOptions({ status: "checked", checks });
}

describe("what the welcome screen may offer", () => {
  it("says it is still finding out while the modules are being asked", () => {
    expect(signInOptions({ status: "checking" })).toEqual({
      kind: "checking",
      message: CHECKING_MESSAGE,
    });
  });

  it("offers every provider that answered yes, in the order they are drawn", () => {
    const options = checked({ apple: "available", google: "available" });

    expect(options).toEqual({ kind: "offered", providers: ["apple", "google"] });
  });

  it("offers only the one that works", () => {
    expect(checked({ apple: "unavailable", google: "available" })).toEqual({
      kind: "offered",
      providers: ["google"],
    });
  });

  it("says sign-in is not available here when both answered no", () => {
    const options = checked({ apple: "unavailable", google: "unavailable" });

    expect(options.kind).toBe("unavailable");
    expect(options).toMatchObject({ message: UNAVAILABLE_MESSAGE });
  });

  it("says it could not tell when a check threw instead of answering", () => {
    // Not the same screen as "this phone has neither": one of these is worth
    // pressing again and the other never will be.
    const options = checked({ apple: "failed", google: "unavailable" });

    expect(options.kind).toBe("unknown");
    expect(options).toMatchObject({ message: UNKNOWN_MESSAGE });
  });

  it("says nothing about a failed check when the other provider works", () => {
    // A working button beside a sentence about a provider the user was never
    // going to press is noise.
    expect(checked({ apple: "failed", google: "available" })).toEqual({
      kind: "offered",
      providers: ["google"],
    });
  });

  it("tells a phone that has neither why, and one that could not tell that it may pass", () => {
    // A dead end is only bearable if it says what would have been needed.
    expect(UNAVAILABLE_MESSAGE).toMatch(/iOS 13/);
    expect(UNAVAILABLE_MESSAGE).toMatch(/Play services/);
    expect(UNKNOWN_MESSAGE).toMatch(/temporary/i);
  });
});
