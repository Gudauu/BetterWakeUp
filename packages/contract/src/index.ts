/**
 * Shared request and response schemas, the `MovementObservation` type, error
 * codes, and the idempotency header.
 *
 * The contract itself lands in issue 4. This module exists now so the app and
 * the server have a package to import instead of reaching for a server
 * database model.
 */

/** Header carrying the idempotency key on every state-changing client command. */
export const IDEMPOTENCY_HEADER = "idempotency-key";
