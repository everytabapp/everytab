/**
 * Hosted CI facts shared by suites with timing budgets. The workflow sets
 * EVERYTAB_HOSTED_RUNNER=1; local runs leave it unset and keep every budget.
 * See TESTING.md "Hosted runners".
 */
export const HOSTED_RUNNER = process.env.EVERYTAB_HOSTED_RUNNER === "1";

/**
 * Multiple applied to a Mac-calibrated Node-compute budget on a hosted runner.
 * The 2-vCPU private-repository Linux runner measured 2.2x to 3.1x the
 * reference Mac (Archive render T2 47.5 ms vs about 21 ms; Inbox filter T2/T3
 * 135/513 ms vs 61/167 ms; runs 37775244783 and 37777221196). Hardware-
 * independent assertions, such as ratios and read counts, are never scaled.
 */
export const HOSTED_BUDGET_SCALE = HOSTED_RUNNER ? 3 : 1;
