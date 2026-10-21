export class RigNotFoundError extends Error {
  constructor(rigId: string) {
    super(`Rig ${rigId} not found`);
    this.name = "RigNotFoundError";
  }
}

/** OF-45: a node row's saved package_refs / session_source_json is damaged, so a product built from it would silently
 *  drop that field. Callers refuse (409) instead. */
export class UnreadableNodeRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableNodeRowError";
  }
}
