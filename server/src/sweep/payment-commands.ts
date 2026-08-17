/**
 * The settlement commands the sweep creates and never executes.
 *
 * Steps 5 and 6 of the architecture's pass are separate for one reason: no
 * capture may happen in the transaction that fails a challenge, or a user who
 * opens the app later that day would have nothing left to recover against. So
 * everything here writes a row and calls no provider.
 *
 * The dedupe key is what makes a second pass write nothing. It is derived from
 * the kind and the challenge, both of which the sweep already knows, so the
 * command is created at most once per challenge for its whole lifetime rather
 * than once per invocation that happens to see the same condition.
 */

import { paymentCommands } from "../db/schema/payments.ts";
import type { Transaction } from "../idempotency/service.ts";

type CommandKind = (typeof paymentCommands.$inferInsert)["kind"];

export interface SettlementCommand {
  readonly challengeId: string;
  readonly kind: CommandKind;
  /** The command is not eligible for execution before this instant. */
  readonly executeAfter: Date;
}

/**
 * Creates the command unless the challenge already has it.
 *
 * Returns whether a row was written, which is what lets a test tell "the sweep
 * created the capture" from "the sweep ran again and left it alone". The
 * conflict target is the dedupe key rather than the pending-per-challenge
 * index, so a command that was already cancelled or confirmed is not recreated
 * by a later pass either.
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

/** One key per kind per challenge. Deterministic, so a replay collides. */
export function dedupeKeyFor(command: Pick<SettlementCommand, "challengeId" | "kind">): string {
  return `${command.kind}:${command.challengeId}`;
}
