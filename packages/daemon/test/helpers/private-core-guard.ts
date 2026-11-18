/**
 * workspaces-o9o.163: the owner-death guard of a test's private hc core (test/hc-private-core.ts and
 * test/helpers/hc-private-core.ts). Those helpers stopped their core only through stop(), in an afterAll; a worker that died
 * first (SIGKILL, a stopped run, a timeout) left the core and its terminal programs running with nothing to reap them. The
 * guard is the one hc-scratch uses (o9o.90): `reapWhenOwnerDies`, armed before the core starts and disarmed only after the
 * core is seen stopped.
 *
 * Selection: the core's own runtime dir, `XDG_RUNTIME_DIR=<root>/r`, as an exact environment entry. The root is a fresh
 * mkdtemp, so no other process carries it, while the core, its holders and every terminal program inherit it. HC_SESSION is
 * not used: both helpers name the session after the worker's pid, so two cores of one worker share it.
 *
 * It sends no hc command of its own, so a stand-in hc that logs its calls (hc-private-core-start-budget.test.ts) sees only
 * the helper's own calls. Where the environment cannot be swept (neither /proc nor `ps -E`), it arms nothing.
 */
import { isAbsolute, relative } from "node:path";
import { canSweepEnviron, pidsWithEnv, reapWhenOwnerDies } from "./orphan-reaper.js";

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export class PrivateCoreGuard {
  private readonly entry: string;
  private reaper: { disarm: () => void } | null = null;

  /** `root` is the core's own fresh temp root: the runtime dir must be inside it, or the entry could name processes that are not this core's. */
  constructor(env: NodeJS.ProcessEnv, root: string, private readonly label: string) {
    const runtime = env.XDG_RUNTIME_DIR;
    if (!runtime) throw new Error("private core guard: the core's env has no XDG_RUNTIME_DIR to select it by");
    const rel = relative(root, runtime);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`private core guard: XDG_RUNTIME_DIR ${runtime} is not inside the core's own root ${root}, so it cannot select only this core's processes`);
    }
    this.entry = `XDG_RUNTIME_DIR=${runtime}`;
  }

  /** Arms the watchdog once, before the core starts; later calls keep the one already armed. */
  arm(): void {
    if (this.reaper || !canSweepEnviron()) return;
    this.reaper = reapWhenOwnerDies({ environ: [this.entry], label: this.label });
  }

  /** After `hc server stop`: disarms once no process carries the core's entry (within `withinMs`). Otherwise it stays armed. */
  releaseWhenStopped(withinMs = 8_000): boolean {
    if (!this.reaper) return true;
    const until = Date.now() + withinMs;
    while (pidsWithEnv(this.entry).length > 0) {
      if (Date.now() > until) return false;
      sleepSync(50);
    }
    this.reaper.disarm();
    this.reaper = null;
    return true;
  }
}
