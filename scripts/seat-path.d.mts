// Types for scripts/seat-path.mjs (workspaces-o9o.77), so the TypeScript test setup and helpers import it checked.
/** Whether `dir` is one of a seat's two PATH-head folders: a `rig-bin` folder, or a folder directly inside a `seat-bin` folder. */
export function isSeatPathEntry(dir: string): boolean;
/** `value` (a PATH) without a seat's PATH-head folders; every other entry is kept, in order. Undefined stays undefined. */
export function withoutSeatPath(value: string): string;
export function withoutSeatPath(value: string | undefined): string | undefined;
