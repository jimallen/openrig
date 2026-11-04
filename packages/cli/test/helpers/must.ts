// A runtime-checked replacement for a non-null assertion in a test. Under `noUncheckedIndexedAccess`
// `calls[0]` and `.find(...)` are `T | undefined`; `must()` narrows them to `T` and, unlike `!`, fails
// the test with a message naming what was missing instead of a TypeError further down.
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present, but it was ${value === null ? "null" : "undefined"}`);
  }
  return value;
}
