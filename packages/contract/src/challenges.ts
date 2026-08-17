/**
 * Challenge configuration, creation, funding, and the queries and commands
 * that act on the one challenge an account may hold at a time.
 *
 * The split between `POST /challenges` and `POST /challenges/funding-intents`
 * is the payment boundary and nothing else. A zero deposit challenge never
 * reaches the provider, so it is created and materialized in one transaction,
 * while a funded one becomes active on the provider's webhook.
 */

import { z } from "zod";
import {
  depositAmount,
  ianaTimeZone,
  instant,
  localDate,
  localTime,
  resourceId,
  weekday,
} from "./primitives.ts";
import { taskView } from "./tasks.ts";

export const scheduledWeekday = z.object({
  weekday,
  /** Wall-clock deadline in the challenge's time zone. Each active day may differ. */
  deadline: localTime,
});

export const weeklySchedule = z
  .array(scheduledWeekday)
  .min(1)
  .max(7)
  .refine((days) => new Set(days.map((day) => day.weekday)).size === days.length, {
    error: "a weekday may appear in the schedule at most once",
  });

export const challengeConfiguration = z.object({
  requiredTaskCount: z.int().min(1),
  schedule: weeklySchedule,
  stepTarget: z.int().min(1),
  /** Minimum advance notice required to skip a task, in minutes. */
  noRegretMinutes: z.int().nonnegative(),
  timeZone: ianaTimeZone,
  deposit: depositAmount,
});

export const challengeStatus = z.enum([
  "active",
  "succeeded",
  "failed",
  "expired",
  "recovery_pending",
]);

export const pauseState = z.object({
  /** When the pause mode was set. Null while the challenge is running. */
  pausedAt: instant.nullable(),
  /** When a pause reaching its bound will expire the challenge. Null while running. */
  expiresAt: instant.nullable(),
});

export const recoveryOffer = z.object({
  taskId: resourceId,
  offeredAt: instant,
  /** After this instant the settlement executes and the recovery stays unspent. */
  expiresAt: instant,
});

export const challengeProgress = z.object({
  requiredTaskCount: z.int().min(1),
  completedTaskCount: z.int().nonnegative(),
  skippedTaskCount: z.int().nonnegative(),
  forgivenTaskCount: z.int().nonnegative(),
});

export const challengeView = z.object({
  id: resourceId,
  status: challengeStatus,
  configuration: challengeConfiguration,
  /** The terms version the user accepted at funding. */
  policyVersion: z.string().min(1),
  createdAt: instant,
  /** When the challenge became `active`. Null while a funded one awaits its webhook. */
  activatedAt: instant.nullable(),
  /** The date the challenge ends if nothing is paused from here on. */
  projectedEndDate: localDate,
  pause: pauseState,
  progress: challengeProgress,
  /**
   * False when an authorization renewal failed. The challenge continues; the
   * app tells the user their deposit is unsecured and asks for a new card.
   * Always true for a zero deposit challenge, which has nothing to secure.
   */
  depositSecured: z.boolean(),
  /** The next task still open, or null when none is. */
  currentTask: taskView.nullable(),
  /** Present only while the challenge is in `recovery_pending`. */
  recoveryOffer: recoveryOffer.nullable(),
});

/** `POST /challenges/projections` persists nothing and needs no idempotency key. */
export const createProjectionRequest = z.object({
  configuration: challengeConfiguration,
});

export const createProjectionResponse = z.object({
  firstTaskDate: localDate,
  projectedEndDate: localDate,
  /** The instant of the first task's deadline, so the app can show a real time. */
  firstTaskDeadline: instant,
  /**
   * False when a funded challenge's projected end date falls further than the
   * maximum duration past funding. A zero deposit challenge is always true.
   */
  withinMaximumDuration: z.boolean(),
});

/** `POST /challenges` creates a zero deposit challenge and rejects any other. */
export const createChallengeRequest = z.object({
  configuration: challengeConfiguration,
  policyVersion: z.string().min(1),
});

export const createChallengeResponse = z.object({
  challenge: challengeView,
});

/**
 * `POST /challenges/funding-intents` carries the whole configuration, because
 * the webhook has to know what was authorized and the amount at stake must be
 * tied to the exact terms the user accepted.
 */
export const createFundingIntentRequest = z.object({
  configuration: challengeConfiguration,
  policyVersion: z.string().min(1),
});

export const createFundingIntentResponse = z.object({
  fundingIntentId: resourceId,
  /** Provider-side material the app's payment sheet needs. Opaque here. */
  providerClientSecret: z.string().min(1),
  /**
   * The challenge does not exist until the provider's webhook confirms the
   * authorization, so the app polls `GET /challenges/current` afterward.
   */
  pollAfterAuthorization: z.literal(true),
});

export const getCurrentChallengeResponse = z.object({
  /** Null when the account holds no challenge, which is the state after any terminal one. */
  challenge: challengeView.nullable(),
});

export const replacePaymentMethodRequest = z.object({
  /** Provider-side identifier for the new instrument. */
  providerPaymentMethodId: z.string().min(1),
});

export const replacePaymentMethodResponse = z.object({
  challenge: challengeView,
});

export const changeTimeZoneRequest = z.object({
  timeZone: ianaTimeZone,
});

export const changeTimeZoneResponse = z.object({
  challenge: challengeView,
  /** Tasks whose pause cutoff was still ahead and were therefore re-materialized. */
  rematerializedTasks: z.array(taskView),
});

/**
 * Pause takes no body beyond the idempotency key in the header, and resume
 * takes no body at all: it is a `DELETE`, and a body on a `DELETE` is dropped
 * by enough intermediaries that requiring one would make the command's success
 * depend on the network rather than on the request.
 */
export const pauseChallengeRequest = z.object({});

export const pauseChallengeResponse = z.object({
  challenge: challengeView,
  /**
   * The first task the pause consumes, so the app can name it before the user
   * confirms. Null when every remaining cutoff has already passed.
   */
  nextSkippedTask: taskView.nullable(),
});

export const resumeChallengeResponse = z.object({
  challenge: challengeView,
  /** The first task the user faces again. Null when none is scheduled yet. */
  nextLiveTask: taskView.nullable(),
});

/**
 * Accepting the Emergency Recovery offer. It is never applied automatically,
 * and accepting consumes the account's one lifetime allowance whatever
 * happens to the challenge afterward.
 */
export const acceptRecoveryRequest = z.object({
  /** The missed task the offer was opened for, so a stale offer cannot be accepted. */
  taskId: resourceId,
});

export const acceptRecoveryResponse = z.object({
  challenge: challengeView,
  /** The missed task, now `forgiven`. */
  forgivenTask: taskView,
  /** The task appended so the challenge can still reach its required count. */
  appendedTask: taskView,
});

export type ScheduledWeekday = z.infer<typeof scheduledWeekday>;
export type WeeklySchedule = z.infer<typeof weeklySchedule>;
export type ChallengeConfiguration = z.infer<typeof challengeConfiguration>;
export type ChallengeStatus = z.infer<typeof challengeStatus>;
export type PauseState = z.infer<typeof pauseState>;
export type RecoveryOffer = z.infer<typeof recoveryOffer>;
export type ChallengeProgress = z.infer<typeof challengeProgress>;
export type ChallengeView = z.infer<typeof challengeView>;
export type CreateProjectionRequest = z.infer<typeof createProjectionRequest>;
export type CreateProjectionResponse = z.infer<typeof createProjectionResponse>;
export type CreateChallengeRequest = z.infer<typeof createChallengeRequest>;
export type CreateChallengeResponse = z.infer<typeof createChallengeResponse>;
export type CreateFundingIntentRequest = z.infer<typeof createFundingIntentRequest>;
export type CreateFundingIntentResponse = z.infer<typeof createFundingIntentResponse>;
export type GetCurrentChallengeResponse = z.infer<typeof getCurrentChallengeResponse>;
export type ReplacePaymentMethodRequest = z.infer<typeof replacePaymentMethodRequest>;
export type ReplacePaymentMethodResponse = z.infer<typeof replacePaymentMethodResponse>;
export type ChangeTimeZoneRequest = z.infer<typeof changeTimeZoneRequest>;
export type ChangeTimeZoneResponse = z.infer<typeof changeTimeZoneResponse>;
export type PauseChallengeRequest = z.infer<typeof pauseChallengeRequest>;
export type PauseChallengeResponse = z.infer<typeof pauseChallengeResponse>;
export type ResumeChallengeResponse = z.infer<typeof resumeChallengeResponse>;
export type AcceptRecoveryRequest = z.infer<typeof acceptRecoveryRequest>;
export type AcceptRecoveryResponse = z.infer<typeof acceptRecoveryResponse>;
