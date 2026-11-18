// Types for check-abi.mjs, which the CLI runtime imports as well as running it as the postinstall (workspaces-o9o.180).
/** scripts/node-support.json's supportedMajors (the one source). */
export const SUPPORTED_MAJORS: readonly [number, ...number[]];
export function supportedMajorsText(joiner: "or" | "and"): string;

export type CheckAbiResult = { ok: true; warning?: string } | { ok: false; message: string };
export type NativeOpenResult = { ok: true } | { ok: false; detail: string };

export function checkAbi(deps: {
  nodeVersion: string;
  loadNativeAddon: () => void;
  openNativeDatabase?: () => NativeOpenResult;
}): CheckAbiResult;

/** The part of child_process.spawnSync that openInChildProcess uses (tests pass a stand-in). */
export type SpawnSyncLike = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number },
) => { error?: Error; signal?: string | null; status: number | null; stderr?: string | null };

export function openInChildProcess(addonPath: string, spawnSync: SpawnSyncLike): NativeOpenResult;
