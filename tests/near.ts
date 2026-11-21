/** Matches a timestamp within `slack` ms of `expected`.
 *  convex-test 0.0.63+ pins Date.now() per query/mutation to the transaction snapshot /
 *  document `_creationTime`, typically 1ms off the test clock. */
export function near(expected: number, slack = 10) {
  return {
    asymmetricMatch: (actual: unknown) => typeof actual === "number" && Math.abs(actual - expected) <= slack,
    toString: () => `${expected}±${slack}ms`,
    toAsymmetricMatcher: () => `${expected}±${slack}ms`,
  };
}
