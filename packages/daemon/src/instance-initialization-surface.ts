export {
  ensureOpenRigInstance,
  formatInstanceInitializationConflicts,
  prepareInstanceHome,
  type OpenRigInstanceInitializationOptions,
  type OpenRigInstanceInitializationResult,
} from "./domain/instance-initialization.js";
export {
  ensureDefaultWorkspace,
  nodeInitializationFs,
  workspaceScaffoldDirs,
  workspaceScaffoldFiles,
  type InitializationConflict,
  type InitializationFsOps,
  type InitWorkspaceResult,
  type ManagedPathKind,
} from "./domain/workspace/default-workspace-scaffold.js";
export { nodeInstancePrivacy } from "./adapters/instance-privacy-fs.js";
