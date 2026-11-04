// Bounds-checked indexed access for tests under noUncheckedIndexedAccess.
// Narrows `T | undefined` to `T` by throwing (a loud test failure naming the
// index) instead of a non-null assertion that would hide a missing element.
export function at<T>(items: ArrayLike<T>, index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}, but the collection has ${items.length}`);
  }
  return item;
}
