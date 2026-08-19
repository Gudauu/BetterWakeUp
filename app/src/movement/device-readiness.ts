/**
 * Whether this phone can do the thing the challenge is about to be staked on.
 *
 * Every morning of a challenge is settled by one fact: the step counter in the
 * user's pocket. A phone without one cannot complete a single day, and a phone
 * whose motion access is off counts nothing until it is turned back on. Both
 * were discoverable only at the first press of "Start the walk" - which is to
 * say, on the first morning, after the deposit was already held.
 *
 * So the question is asked before the money: the setup screen reads the device
 * as the form is filled in, and a phone that cannot count steps is told so
 * while the challenge is still a draft.
 *
 * The check is a narrow port over the pedometer rather than a whole capture,
 * because nothing here watches anything: it wants availability and the standing
 * permission, and a capture would open a window over a walk nobody is taking.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadAppConfig } from "../config.ts";
import type { MovementPermission, Pedometer } from "./pedometer.ts";

/**
 * What answering the question needs. A subset of `Pedometer` so the same fake
 * that drives a capture in a test drives this too, and so no caller of this
 * module can start watching steps through it.
 */
export type MovementDevice = Pick<Pedometer, "isAvailable" | "getPermission" | "requestPermission">;

/**
 * What this phone can be asked to do about a walk.
 *
 * `askable` and `refused` are apart for the same reason the permission itself
 * has three states: one of them is a button the app can press and the other is
 * a page only the user can open.
 */
export type MovementReadiness =
  /** The device has not answered yet. */
  | "checking"
  /** A step counter, and permission to read it. Nothing to say. */
  | "ready"
  /** A step counter, and the app has never asked. It can ask now. */
  | "askable"
  /** A step counter, and motion access refused. Only Settings fixes this. */
  | "refused"
  /** No step counter at all. Nothing on this phone can complete a day. */
  | "unsupported"
  /** The device would not answer. Better said than assumed either way. */
  | "unknown";

/** The standing permission read as what the screen has to do about it. */
export function readinessForPermission(permission: MovementPermission): MovementReadiness {
  switch (permission) {
    case "granted":
      return "ready";
    case "denied":
      return "refused";
    default:
      return "askable";
  }
}

/**
 * Whether a challenge should be startable on this phone.
 *
 * Only `unsupported` stops it. A refused permission is a warning rather than a
 * bar because it can be turned on any time before the first morning, and a
 * device that would not answer is not evidence of anything - refusing to let
 * someone start over a failed read would be the app's fault charged to them.
 */
export function canStartChallengeOn(readiness: MovementReadiness): boolean {
  return readiness !== "unsupported";
}

/** What each answer is worth saying, and how loudly. */
export interface MovementReadinessNotice {
  readonly tone: "info" | "warning" | "danger";
  readonly text: string;
}

export const MOVEMENT_READINESS_NOTICE: Readonly<
  Record<Exclude<MovementReadiness, "checking">, MovementReadinessNotice>
> = {
  // Said out loud rather than left silent: the one thing the user is trusting
  // is that the phone in their hand will settle each morning, and a challenge
  // is about to have money behind it.
  ready: {
    tone: "info",
    text: "This phone can count your walk, and motion access is on.",
  },
  askable: {
    tone: "info",
    text: "Your walk is counted with this phone's motion sensor. Turn it on now so the first morning is not the first time you are asked.",
  },
  refused: {
    tone: "warning",
    text: "Motion access is off, so this phone cannot count a walk. Turn it on before your first morning or no day can be completed.",
  },
  unsupported: {
    tone: "danger",
    text: "This phone has no step counter, so a walk taken here cannot be verified and no day could ever be completed. Sign in on a phone that counts steps to start a challenge.",
  },
  unknown: {
    tone: "warning",
    text: "This phone would not say whether it can count steps. Check again before you put money behind it.",
  },
} as const;

/**
 * The same question asked of a challenge that is already running.
 *
 * The setup screen's wording is written for someone deciding whether to stake
 * money. That decision is behind the user here: the deposit is held, the days
 * are counting, and motion access can be taken away long after the form was
 * filled in - by a settings page, by an operating system update, or by the
 * challenge being opened on a second phone. Until now the app said nothing
 * about any of that until the morning it mattered, at the press of "Start the
 * walk", with a deadline already running.
 *
 * Silence on `ready` and `checking` is the point of the block: a phone that can
 * count steps has nothing to report, and there is no reason to draw a state
 * that resolves in a moment.
 *
 * `unknown` is silent too, which is where this rule parts from the setup
 * screen's. There it is a reason to look again before paying; here the paying
 * has happened, nothing about a failed read is actionable, and it is also the
 * answer a build with no sensor module gives - so saying it on every open of
 * the app would be a warning nobody could ever clear.
 */
export const RUNNING_MOVEMENT_NOTICE: Readonly<
  Partial<Record<MovementReadiness, MovementReadinessNotice>>
> = {
  askable: {
    tone: "warning",
    text: "This phone has not been given motion access, so a walk taken now would count nothing. Turn it on before your next morning.",
  },
  refused: {
    tone: "danger",
    text: "Motion access is off, so this phone cannot count a walk and no morning can be completed while it stays off. Turn it on in your device settings before your next deadline.",
  },
  unsupported: {
    tone: "danger",
    text: "This phone has no step counter, so a walk taken here cannot be verified. Open BetterWakeUp on the phone you set the challenge up with before your next deadline.",
  },
} as const;

/** What a running challenge's owner should hear about this phone, if anything. */
export function runningMovementNotice(
  readiness: MovementReadiness,
): MovementReadinessNotice | null {
  return RUNNING_MOVEMENT_NOTICE[readiness] ?? null;
}

/** The label on the press that asks the operating system for motion access. */
export const ALLOW_MOVEMENT_LABEL = "Allow motion access";

/** The label on the press that asks the device the question a second time. */
export const RECHECK_MOVEMENT_LABEL = "Check again";

export interface MovementReadinessState {
  readonly readiness: MovementReadiness;
  /** A permission prompt is up. */
  readonly asking: boolean;
  /** Prompt for motion access. Only meaningful while `askable`. */
  readonly ask: () => void;
  /** Ask the device the whole question again. */
  readonly recheck: () => void;
}

/**
 * The device's answer, kept current for as long as the screen asking is up.
 *
 * The read is repeated on request rather than polled: motion access changes in
 * a settings page the app is not in front of, so the honest moment to ask again
 * is when the user says they have changed it.
 */
export function useMovementReadiness(device: MovementDevice): MovementReadinessState {
  const [readiness, setReadiness] = useState<MovementReadiness>("checking");
  const [asking, setAsking] = useState(false);
  // A device that answers after the form has been left must not write into a
  // component that is gone.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async (): Promise<MovementReadiness> => {
    try {
      if (!(await device.isAvailable())) {
        return "unsupported";
      }
      return readinessForPermission(await device.getPermission());
    } catch {
      return "unknown";
    }
  }, [device]);

  const recheck = useCallback(() => {
    setReadiness("checking");
    void read().then((next) => {
      if (mounted.current) {
        setReadiness(next);
      }
    });
  }, [read]);

  useEffect(() => {
    recheck();
  }, [recheck]);

  const ask = useCallback(() => {
    setAsking(true);
    void (async () => {
      try {
        const permission = await device.requestPermission();
        if (mounted.current) {
          setReadiness(readinessForPermission(permission));
        }
      } catch {
        if (mounted.current) {
          setReadiness("unknown");
        }
      } finally {
        if (mounted.current) {
          setAsking(false);
        }
      }
    })();
  }, [device]);

  return { readiness, asking, ask, recheck };
}

/**
 * The device this build asks. Native by default, and the simulated pedometer in
 * a build that simulates movement - which reports itself available and granted,
 * so a simulator build is not stopped from starting a challenge by a sensor it
 * was never going to use.
 *
 * The native modules are imported inside the calls for the same reason the
 * completion runtime imports them inside its factory: nothing above the ports
 * may pull `expo-sensors` into its import graph.
 */
export function createConfiguredMovementDevice(): MovementDevice {
  async function pedometer(): Promise<MovementDevice> {
    if (loadAppConfig().simulateMovement) {
      const { createSimulatedMovement } = await import("./simulated-pedometer.ts");
      return createSimulatedMovement().pedometer;
    }
    const { createNativePedometer } = await import("./native-pedometer.ts");
    return createNativePedometer();
  }

  return {
    isAvailable: async () => (await pedometer()).isAvailable(),
    getPermission: async () => (await pedometer()).getPermission(),
    requestPermission: async () => (await pedometer()).requestPermission(),
  };
}
