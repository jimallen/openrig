import { expect } from "vitest";

/**
 * `expect(result.code).toBe(code)`, which also narrows `result` to the members of its union with that code (OF-134),
 * so the lines after it can read that member's own fields (`message`, `error`, `errors`) without a cast. The
 * assertion and its failure message are the ones the replaced line made.
 */
export function expectCode<R extends { code: string }, C extends R["code"]>(
  result: R,
  code: C,
): asserts result is Extract<R, { code: C }> {
  expect(result.code).toBe(code);
}
