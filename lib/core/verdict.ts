import type { OperatorOutcome, VerdictResult, WilsonInterval } from "./walletList.types";

export const MIN_CANDIDATE_OPERATORS = 10;
export const MIN_CONTROL_OPERATORS = 20;

export function wilson(successes: number, n: number, z = 1.96): WilsonInterval {
  if (n <= 0) return { n: 0, successes: 0, rate: null, lo: null, hi: null };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { n, successes, rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

const interval = (o: OperatorOutcome[]) => wilson(o.filter((x) => x.success).length, o.length);

// Counts operators, never wallets. Checked in the contract's order.
export function walletListVerdict(candidate: OperatorOutcome[], control: OperatorOutcome[]): VerdictResult {
  const c = interval(candidate);
  const k = interval(control);
  let verdict: VerdictResult["verdict"];
  if (candidate.length < MIN_CANDIDATE_OPERATORS) verdict = "fewer than 10 independent operators";
  else if (control.length < MIN_CONTROL_OPERATORS) verdict = "control missing or too small";
  else if (c.lo == null || k.rate == null || !(c.lo > k.rate)) verdict = "no better than control";
  else verdict = "passes";
  return { verdict, candidate: c, control: k };
}
