/**
 * The normalized movement reading. Every platform reading is mapped into this
 * shape before it reaches the rest of the app, and this is the only movement
 * shape the API accepts.
 */

import { z } from "zod";
import { instant } from "./primitives.ts";

/**
 * Where the reading came from.
 *
 * `live-foreground` is movement observed while the app was open.
 * `historical-query` is movement read back out of the operating system, which
 * only iOS offers. The distinction is load-bearing: without it the server
 * cannot audit a completion or enforce the foreground-only rule.
 */
export const movementProvenance = z.enum(["live-foreground", "historical-query"]);

export const movementSource = z.enum(["expo-pedometer-ios", "expo-pedometer-android"]);

export const movementObservation = z
  .object({
    startedAt: instant,
    endedAt: instant,
    steps: z.int().nonnegative(),
    provenance: movementProvenance,
    source: movementSource,
  })
  .refine((observation) => Date.parse(observation.startedAt) <= Date.parse(observation.endedAt), {
    error: "an observation cannot end before it started",
    path: ["endedAt"],
  });

/**
 * The provenance a completion must carry.
 *
 * Android has no historical step query at all, so foreground observation is
 * the only guarantee both platforms can make, and the server rejects anything
 * else while that rule stands.
 */
export const ACCEPTED_COMPLETION_PROVENANCE = "live-foreground" as const;

export type MovementProvenance = z.infer<typeof movementProvenance>;
export type MovementSource = z.infer<typeof movementSource>;
export type MovementObservation = z.infer<typeof movementObservation>;
