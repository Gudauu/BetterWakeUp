/**
 * The verification rule this build applies before it records a completion.
 *
 * It travels with every completion so a rule change is auditable: the server
 * stores it beside the observation, and a completion accepted under one policy
 * stays identifiable after the policy moves on. It is a name and not a
 * number because the interesting question about a stored completion is which
 * rule was applied, not how many rules came before it.
 */
export const VERIFICATION_POLICY_VERSION = "live-foreground-steps.1";
