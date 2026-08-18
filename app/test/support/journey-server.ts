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
  let accountExists = true;
  let taskCounter = 0;

  function nextTask(): TaskView {
    taskCounter += 1;
    return openTask(now(), `44444444-4444-4444-8444-${String(taskCounter).padStart(12, "0")}`);
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

    getCurrentChallenge: () => ({ challenge }),

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
      if (challenge !== null) {
        throw new ApiError("active_challenge_exists", "This account already holds a challenge.");
      }
      const { configuration } = (
        input as { body: { configuration: ChallengeView["configuration"] } }
      ).body;
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
      return { challenge };
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
      // A succeeded challenge is terminal, and the account holds none again -
      // the same state a new account is in.
      challenge = succeeded
        ? null
        : {
            ...current,
            progress: { ...current.progress, completedTaskCount },
            // The next task appears on the next active day, so there is
            // nothing due until then.
            currentTask: null,
          };
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

    deleteAccount: () => {
      accountExists = false;
      challenge = null;
      return {};
    },
  };

  return {
    calls,
    names: () => calls.map((call) => call.name),
    challenge: () => challenge,
    completions: () => completions,

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
