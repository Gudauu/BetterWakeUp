/**
 * The settlement commands the sweep creates and never executes.
 *
 * Steps 5 and 6 of the architecture's pass are separate for one reason: no
 * capture may happen in the transaction that fails a challenge, or a user who
 * opens the app later that day would have nothing left to recover against. So
 * everything here writes a row and calls no provider.
 *
 * The dedupe key is what makes a second pass write nothing. It is derived from
 * what the command settles, so it is created at most once per cause rather than
 * once per invocation that happens to see the same condition.
 *
 * A capture's cause is not its challenge. A funded challenge can forfeit more
 * than once in its life: a miss opens a recovery offer and a capture, accepting
 * the offer cancels that capture, and a later miss forfeits again. Keyed on the
 * challenge, the second capture collided with the cancelled first one and was
 * never written, so the challenge failed with its deposit uncollected. Keyed on
 * the missed task, each forfeit gets its own row, and the partial unique index
 * on pending commands still allows only one open capture per challenge.
 */

import { paymentCommands } from "../db/schema/payments.ts";
import type { Transaction } from "../idempotency/service.ts";

/**
 * What forfeited a funded challenge's deposit.
 *
 * A task can be missed once and a challenge can be ended once, so either one
 * names exactly one capture.
 */
export type CaptureCause =
  | { readonly kind: "miss"; readonly taskId: string }
  | { readonly kind: "abandonment" };

export type SettlementCommand =
  | {
      readonly challengeId: string;
      readonly kind: "capture";
      readonly cause: CaptureCause;
      /** The command is not eligible for execution before this instant. */
      readonly executeAfter: Date;
    }
  | {
      readonly challengeId: string;
      /** A hold is released at most once, so the challenge is the whole cause. */
      readonly kind: "release_authorization";
      readonly executeAfter: Date;
    };

/**
 * Creates the command unless its cause already has one.
 *
 * Returns whether a row was written, which is what lets a test tell "the sweep
 * created the capture" from "the sweep ran again and left it alone". The
 * conflict target is the dedupe key rather than the pending-per-challenge
 * index, so a command that was already cancelled or confirmed is not recreated
 * for the same cause by a later pass either.
 */
export async function createSettlementCommand(
  tx: Transaction,
  command: SettlementCommand,
): Promise<boolean> {
  const created = await tx
    .insert(paymentCommands)
    .values({
      challengeId: command.challengeId,
      kind: command.kind,
      dedupeKey: dedupeKeyFor(command),
      executeAfter: command.executeAfter,
    })
    .onConflictDoNothing({ target: paymentCommands.dedupeKey })
    .returning({ id: paymentCommands.id });
  return created.length > 0;
}

/**
 * One key per cause. Deterministic, so a replay collides.
 *
 * Captures written before causes were named carry `capture:<challengeId>`,
 * which neither capture form below can produce, so those rows keep working
 * untouched.
 */
export function dedupeKeyFor(command: SettlementCommand): string {
  if (command.kind === "release_authorization") {
    return `release_authorization:${command.challengeId}`;
  }
  return command.cause.kind === "miss"
    ? `capture:miss:${command.cause.taskId}`
    : `capture:abandon:${command.challengeId}`;
}
