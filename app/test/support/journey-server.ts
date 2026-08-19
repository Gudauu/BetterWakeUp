/**
 * A server that remembers what the app did to it.
 *
 * `fakeApi` answers each endpoint from a table, which is what a test about one
 * screen wants: the answer is the premise. A journey through several screens
 * cannot be written that way, because the whole point is that creating a
 * challenge changes what home reads afterward, and that completing today's task
 * changes it again.
 *
 * This holds one account's state and moves it the way the real server moves it,
 * with two guards that keep it from drifting into a fiction: every request is
 * parsed with the contract's own request schema before it is answered, so a
 * screen sending something the server would reject fails here too, and every
 * answer is parsed with the contract's response schema, so this cannot invent a
 * shape the app would never receive. What it is not is a second implementation
 * of the rules: the server's own semantics are proved against the real server
 * in `server/test/integration/journey.test.ts`.
 */

import {
  type ChallengeView,
  type CreateCompletionRequest,
  ENDPOINTS,
  type EndedChallengeSummary,
  type TaskView,
} from "@betterwakeup/contract";
import type { ApiClient, ApiRequest, ClientEndpointName } from "../../src/api/client.ts";
import { ApiError } from "../../src/api/errors.ts";
import { challengeView, taskView } from "./fake-api.ts";

export const JOURNEY_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
export const JOURNEY_CHALLENGE_ID = "33333333-3333-4333-8333-333333333333";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RecordedCall {
  readonly name: ClientEndpointName;
  readonly input: unknown;
}

export interface JourneyServer extends ApiClient {
  readonly calls: readonly RecordedCall[];
  names(): readonly ClientEndpointName[];
  /** What `GET /challenges/current` would answer right now. */
  challenge(): ChallengeView | null;
  /** Every completion the app sent, in order. */
  completions(): readonly CreateCompletionRequest[];
  /**
   * The provider's webhook, as a test can press it: the hold the app authorized
   * clears and the challenge the user paid for comes into existence. Nothing
   * the app does causes this, which is exactly why the app has to watch for it.
   */
  confirmFunding(): void;
  /**
   * The sweep, as a test can press it: the deadline passed with no walk, the
   * challenge fails, and the deposit is charged. Like the webhook, nothing the
   * app does causes this, which is why the app only ever learns about it from
   * the next read.
   */
  missDeadline(): void;
  /**
   * The renewal that failed, as a test can press it: the card behind the hold
   * expired or was declined, so the deposit stops being secured while the
   * challenge runs on. Nothing the app does causes this either.
   */
  lapsePaymentMethod(): void;
}

export interface JourneyServerOptions {
  /**
   * The clock the tasks it hands out are dated from. It defaults to the real
   * one because the screens under test read the real one too: a deadline
   * written down as a fixed instant would fall into the past and the journey
   * would stop passing on a particular day.
   */
  readonly now?: () => Date;
}

/** A task open for the next couple of hours, which is the state a walk starts in. */
function openTask(now: Date, id: string): TaskView {
  const deadline = new Date(now.getTime() + 2 * HOUR_MS);
  return taskView({
    id,
    date: deadline.toISOString().slice(0, 10),
    deadline: deadline.toISOString(),
    pauseCutoff: new Date(now.getTime() + HOUR_MS).toISOString(),
  });
}

export function journeyServer(options: JourneyServerOptions = {}): JourneyServer {
  const now = options.now ?? (() => new Date());
  const calls: RecordedCall[] = [];
  const completions: CreateCompletionRequest[] = [];
  let challenge: ChallengeView | null = null;
  /** The last terminal challenge, which is all the account keeps of it. */
  let lastEnded: EndedChallengeSummary | null = null;
  /** The configuration a hold was authorized for, until its webhook lands. */
  let authorized: ChallengeView["configuration"] | null = null;
  let accountExists = true;
  let taskCounter = 0;

  function nextTask(): TaskView {
    taskCounter += 1;
    return openTask(now(), `44444444-4444-4444-8444-${String(taskCounter).padStart(12, "0")}`);
  }

  /** Both doors end here: a challenge, active, with today's task open. */
  function activate(configuration: ChallengeView["configuration"]): ChallengeView {
    if (challenge !== null) {
      throw new ApiError("active_challenge_exists", "This account already holds a challenge.");
    }
    const created = now();
    challenge = challengeView({
      id: JOURNEY_CHALLENGE_ID,
      configuration,
      createdAt: created.toISOString(),
      activatedAt: created.toISOString(),
      projectedEndDate: new Date(created.getTime() + configuration.requiredTaskCount * DAY_MS)
        .toISOString()
        .slice(0, 10),
      progress: {
        requiredTaskCount: configuration.requiredTaskCount,
        completedTaskCount: 0,
        skippedTaskCount: 0,
        forgivenTaskCount: 0,
      },
      currentTask: nextTask(),
    });
    return challenge;
  }

  /** How a challenge ends, whichever way it ends: it stops being current and leaves a summary. */
  function endChallenge(
    current: ChallengeView,
    status: EndedChallengeSummary["status"],
    completedTaskCount: number,
  ): void {
    const deposit = current.configuration.deposit;
    lastEnded = {
      id: current.id,
      status,
      endedAt: now().toISOString(),
      requiredTaskCount: current.progress.requiredTaskCount,
      completedTaskCount,
      deposit,
      depositOutcome: deposit.amount === 0 ? "none" : status === "failed" ? "charged" : "kept",
    };
    challenge = null;
  }

  function live(): ChallengeView {
    if (challenge === null) {
      throw new ApiError("not_found", "This account holds no challenge.");
    }
    return challenge;
  }

  const handlers: Partial<Record<ClientEndpointName, (input: ApiRequest<never>) => unknown>> = {
    createSession: () => ({
      session: {
        accountId: JOURNEY_ACCOUNT_ID,
        token: "journey-session-token",
        expiresAt: new Date(now().getTime() + 30 * DAY_MS).toISOString(),
      },
      account: {
        id: JOURNEY_ACCOUNT_ID,
        displayName: "Ada Lovelace",
        email: null,
        createdAt: new Date(now().getTime() - DAY_MS).toISOString(),
        emergencyRecoveryAvailable: true,
      },
    }),

    deleteSession: () => ({}),

    // An open challenge is the whole answer; the outcome is reported only while
    // the account holds none, which is what the contract says.
    getCurrentChallenge: () => ({ challenge, lastEnded: challenge === null ? lastEnded : null }),

    createChallengeProjection: (input) => {
      const { configuration } = (
        input as { body: { configuration: { requiredTaskCount: number } } }
      ).body;
      const first = new Date(now().getTime() + 2 * HOUR_MS);
      const end = new Date(first.getTime() + configuration.requiredTaskCount * DAY_MS);
      return {
        firstTaskDate: first.toISOString().slice(0, 10),
        projectedEndDate: end.toISOString().slice(0, 10),
        firstTaskDeadline: first.toISOString(),
        withinMaximumDuration: true,
      };
    },

    createChallenge: (input) => {
      const { configuration } = (
        input as { body: { configuration: ChallengeView["configuration"] } }
      ).body;
      if (configuration.deposit.amount > 0) {
        throw new ApiError("zero_deposit_required", "That challenge has to be funded first.");
      }
      return { challenge: activate(configuration) };
    },

    // The funded door: the hold is authorized here and the challenge does not
    // exist yet, exactly as the contract's `pollAfterAuthorization` says.
    createFundingIntent: (input) => {
      const { configuration } = (
        input as { body: { configuration: ChallengeView["configuration"] } }
      ).body;
      if (configuration.deposit.amount === 0) {
        throw new ApiError("deposit_required_for_funding", "That challenge has no deposit.");
      }
      if (challenge !== null) {
        throw new ApiError("active_challenge_exists", "This account already holds a challenge.");
      }
      authorized = configuration;
      return {
        fundingIntentId: "22222222-2222-4222-8222-222222222222",
        providerClientSecret: "journey-client-secret",
        pollAfterAuthorization: true as const,
      };
    },

    createCompletion: (input) => {
      const current = live();
      const { params, body } = input as {
        params: { taskId: string };
        body: CreateCompletionRequest;
      };
      const task = current.currentTask;
      if (task === null || task.id !== params.taskId) {
        throw new ApiError("not_found", "No task with this identifier is open.");
      }
      completions.push(body);
      const acknowledged = {
        ...task,
        status: "completed" as const,
        acknowledgedAt: now().toISOString(),
      };
      const completedTaskCount = current.progress.completedTaskCount + 1;
      const succeeded = completedTaskCount >= current.progress.requiredTaskCount;
      // A succeeded challenge is terminal: the account holds none again, and
      // all that is left of it is the outcome the next read reports.
      if (succeeded) {
        endChallenge(current, "succeeded", completedTaskCount);
      } else {
        challenge = {
          ...current,
          progress: { ...current.progress, completedTaskCount },
          // The next task appears on the next active day, so there is
          // nothing due until then.
          currentTask: null,
        };
      }
      return {
        task: acknowledged,
        replayed: false,
        challengeStatus: succeeded ? ("succeeded" as const) : ("active" as const),
      };
    },

    pauseChallenge: (input) => {
      const current = live();
      const { params } = input as { params: { challengeId: string } };
      if (params.challengeId !== current.id) {
        throw new ApiError("not_found", "No challenge with this identifier.");
      }
      const pausedAt = now();
      const skipped = current.currentTask;
      challenge = {
        ...current,
        pause: {
          pausedAt: pausedAt.toISOString(),
          expiresAt: new Date(pausedAt.getTime() + 365 * DAY_MS).toISOString(),
        },
        // A pause consumes the task it covers, so nothing is due while it runs.
        currentTask: null,
        progress: {
          ...current.progress,
          skippedTaskCount: current.progress.skippedTaskCount + (skipped === null ? 0 : 1),
        },
      };
      return { challenge, nextSkippedTask: skipped };
    },

    resumeChallenge: (input) => {
      const current = live();
      const { params } = input as { params: { challengeId: string } };
      if (params.challengeId !== current.id) {
        throw new ApiError("not_found", "No challenge with this identifier.");
      }
      const liveTask = nextTask();
      challenge = {
        ...current,
        pause: { pausedAt: null, expiresAt: null },
        currentTask: liveTask,
      };
      return { challenge, nextLiveTask: liveTask };
    },

    // The replacement hold is taken off-session with the instrument the app
    // sends, so the deposit is secured again by the time the call returns.
    replacePaymentMethod: (input) => {
      const current = live();
      const { params } = input as { params: { challengeId: string } };
      if (params.challengeId !== current.id) {
        throw new ApiError("not_found", "No challenge with this identifier.");
      }
      if (current.configuration.deposit.amount === 0) {
        throw new ApiError("deposit_required_for_funding", "This challenge has no deposit.");
      }
      challenge = { ...current, depositSecured: true };
      return { challenge };
    },

    deleteAccount: () => {
      accountExists = false;
      challenge = null;
      lastEnded = null;
      return {};
    },
  };

  return {
    calls,
    names: () => calls.map((call) => call.name),
    challenge: () => challenge,
    completions: () => completions,

    confirmFunding() {
      if (authorized === null) {
        throw new Error("No hold has been authorized, so there is nothing to confirm.");
      }
      activate(authorized);
      authorized = null;
    },

    missDeadline() {
      const current = live();
      endChallenge(current, "failed", current.progress.completedTaskCount);
    },

    lapsePaymentMethod() {
      const current = live();
      if (current.configuration.deposit.amount === 0) {
        throw new Error("A challenge with no deposit has no payment method to lose.");
      }
      challenge = { ...current, depositSecured: false };
    },

    async request<Name extends ClientEndpointName>(name: Name, input: ApiRequest<Name>) {
      calls.push({ name, input });
      const definition = ENDPOINTS[name];

      if (!accountExists && definition.auth === "session") {
        // The session outlived the account it named, which is what the server
        // answers once the row is gone.
        throw new ApiError("unauthenticated", "This session is no longer valid.");
      }

      // The contract's own schemas, so a screen that sends something the real
      // server would refuse is refused here rather than quietly answered.
      if (definition.params !== null) {
        definition.params.parse((input as { params?: unknown }).params);
      }
      if (definition.request !== null) {
        definition.request.parse((input as { body?: unknown }).body);
      }

      const handler = handlers[name];
      if (handler === undefined) {
        throw new Error(`journeyServer has no handler for ${name}`);
      }
      return definition.response.parse(handler(input as ApiRequest<never>)) as never;
    },
  };
}
