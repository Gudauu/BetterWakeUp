/**
 * The Drizzle schema.
 *
 * Every table belongs here (or in a module re-exported from here) so that
 * `drizzle-kit generate` sees one schema entry point and the migration folder
 * stays the single description of the database.
 */

export * from "./schema/challenges.ts";
export * from "./schema/funding.ts";
export * from "./schema/identity.ts";
export * from "./schema/payments.ts";
export * from "./schema/rate-limit.ts";
