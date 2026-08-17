/**
 * The Drizzle schema. Tables arrive with the schema issues: identity in issue 6,
 * challenges and tasks in issue 7, ledger and payment commands in issue 8.
 *
 * Every table belongs here (or in a module re-exported from here) so that
 * `drizzle-kit generate` sees one schema entry point and the migration folder
 * stays the single description of the database.
 */

export {};
