/**
 * The AWS CDK application. Issue 35 defines the Lambda, its Function URL, and
 * the log groups; issue 36 adds the scheduler rules.
 */

/** Node.js major version the Lambda runs on, per the architecture's toolchain. */
export const LAMBDA_NODE_MAJOR = 22;

/**
 * The Lambda's reserved concurrency, which is the cost ceiling of issue 15.
 *
 * The database counters are the per-caller limit. This is the limit that holds
 * when they do not: a bug that fails a counter open, an unlimited endpoint
 * under load, or a caller distributed widely enough that no single subject ever
 * meets its allowance. Reserved concurrency is also a floor, so it is the one
 * setting that both caps the bill and stops another function in the account
 * starving this one.
 *
 * Ten containers is far above pilot traffic and far below anything expensive.
 * Issue 35 applies it to the function; it is stated here so the number is
 * reviewable and testable before the stack that consumes it exists.
 */
export const LAMBDA_RESERVED_CONCURRENCY = 10;
