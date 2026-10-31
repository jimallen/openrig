import type { SeatDeliveryGuard } from "../domain/seat-delivery-guard.js";
import { HcAttach } from "./hc-attach.js";
import { HcCapture } from "./hc-capture.js";
import { HcClient } from "./hc-client.js";
import { HcHost } from "./hc-host.js";
import { HcIdentity } from "./hc-identity.js";
import { HcInput } from "./hc-input.js";
import { HcLifecycle } from "./hc-lifecycle.js";
import type { SessionWindowSnapshot, TmuxResult } from "./tmux.js";

/** The seat host on herdr-core with the tmux adapter's surface, so its call sites stay put at the switch. Each area
 *  lives in its own module; this class only joins them and answers what has no meaning on hc. */
export class HcAdapter {
  private guard?: SeatDeliveryGuard;
  private host!: HcHost;
  private input!: HcInput;
  private lifecycle!: HcLifecycle;
  private readonly identity: HcIdentity;
  private readonly capture: HcCapture;

  constructor(private readonly client: HcClient = new HcClient()) {
    this.identity = new HcIdentity(client);
    this.capture = new HcCapture(client);
    this.wire();
  }

  /** Set after construction, as on the tmux adapter: startup builds the guard from a database the adapter predates. */
  get deliveryGuard(): SeatDeliveryGuard | undefined { return this.guard; }
  set deliveryGuard(guard: SeatDeliveryGuard | undefined) {
    this.guard = guard;
    this.wire();
  }

  private wire(): void {
    const guard = this.guard;
    this.host = new HcHost(this.client, guard ? { ownsLifecycle: (nodeId) => guard.ownsLifecycle(nodeId) } : {});
    // The same core as every other call: a default attach would resolve the socket from the env on its own.
    this.input = new HcInput(this.client, new HcAttach(this.client.socketPath), guard ? { guard } : {});
    this.lifecycle = new HcLifecycle(this.client, guard ? { isManagedSeat: (name) => !!guard.maybeTarget(name) } : {});
  }

  humanInput<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.guard ? this.guard.humanInput(target, fn) : fn();
  }
  operation<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.guard ? this.guard.operation(target, fn) : fn();
  }

  // Launch and presence
  probeSession: HcHost["probeSession"] = (...a) => this.host.probeSession(...a);
  hasSession: HcHost["hasSession"] = (...a) => this.host.hasSession(...a);
  createSession: HcHost["createSession"] = (...a) => this.host.createSession(...a);

  // Input
  sendText: HcInput["sendText"] = (...a) => this.input.sendText(...a);
  sendKeys: HcInput["sendKeys"] = (...a) => this.input.sendKeys(...a);
  sendShellCommand: HcInput["sendShellCommand"] = (...a) => this.input.sendShellCommand(...a);
  submitText: HcInput["submitText"] = (...a) => this.input.submitText(...a);

  // Capture
  capturePaneContent: HcCapture["capturePaneContent"] = (...a) => this.capture.capturePaneContent(...a);
  capturePaneScreen: HcCapture["capturePaneScreen"] = (...a) => this.capture.capturePaneScreen(...a);
  capturePaneHistory: HcCapture["capturePaneHistory"] = (...a) => this.capture.capturePaneHistory(...a);
  capturePanesContent: HcCapture["capturePanesContent"] = (...a) => this.capture.capturePanesContent(...a);

  // Identity and listing
  listSessions: HcIdentity["listSessions"] = (...a) => this.identity.listSessions(...a);
  listWindows: HcIdentity["listWindows"] = (...a) => this.identity.listWindows(...a);
  listPanes: HcIdentity["listPanes"] = (...a) => this.identity.listPanes(...a);
  getPanePid: HcIdentity["getPanePid"] = (...a) => this.identity.getPanePid(...a);
  getPaneCommand: HcIdentity["getPaneCommand"] = (...a) => this.identity.getPaneCommand(...a);
  readAllPaneProcesses: HcIdentity["readAllPaneProcesses"] = (...a) => this.identity.readAllPaneProcesses(...a);
  readSessionWindowSnapshot: HcIdentity["readSessionWindowSnapshot"] = (...a) => this.identity.readSessionWindowSnapshot(...a);
  readAllSessionWindowActivity: HcIdentity["readAllSessionWindowActivity"] = (...a) => this.identity.readAllSessionWindowActivity(...a);
  readPaneLastActivity: HcIdentity["readPaneLastActivity"] = (...a) => this.identity.readPaneLastActivity(...a);
  setSessionOption: HcIdentity["setSessionOption"] = (...a) => this.identity.setSessionOption(...a);
  readSessionOption: HcIdentity["readSessionOption"] = (...a) => this.identity.readSessionOption(...a);
  getSessionOption: HcIdentity["getSessionOption"] = (...a) => this.identity.getSessionOption(...a);
  getSessionEnv: HcIdentity["getSessionEnv"] = (...a) => this.identity.getSessionEnv(...a);
  hasSessionEnv: HcIdentity["hasSessionEnv"] = (...a) => this.identity.hasSessionEnv(...a);

  // Lifecycle
  killSession: HcLifecycle["killSession"] = (...a) => this.lifecycle.killSession(...a);
  respawnPane: HcLifecycle["respawnPane"] = (...a) => this.lifecycle.respawnPane(...a);
  signalPid: HcLifecycle["signalPid"] = (...a) => this.lifecycle.signalPid(...a);
  signalPaneProcess: HcLifecycle["signalPaneProcess"] = (...a) => this.lifecycle.signalPaneProcess(...a);
  setRemainOnExit: HcLifecycle["setRemainOnExit"] = (...a) => this.lifecycle.setRemainOnExit(...a);
  isPaneDead: HcLifecycle["isPaneDead"] = (...a) => this.lifecycle.isPaneDead(...a);
  createProbeSession: HcLifecycle["createProbeSession"] = (...a) => this.lifecycle.createProbeSession(...a);

  // No meaning on hc: there is no server to start, no server or window options, no pane-local options, and a launch
  // binding has no fresh-pane proof to clear.
  async startServer(): Promise<TmuxResult> { return { ok: true }; }
  async setServerOption(_option: string, _value: string): Promise<TmuxResult> { return { ok: true }; }
  async showServerOption(_option: string): Promise<string | null> { return null; }
  async setWindowOption(_target: string, _option: string, _value: string): Promise<TmuxResult> { return { ok: true }; }
  async getPaneLocalOption(_pane: string, _option: string): Promise<string | null | undefined> { return null; }
  async restorePaneOption(_pane: string, _option: string, _value: string | null): Promise<TmuxResult> { return { ok: true }; }
  finishLaunchBinding(_session: string): void {}
  /** The tmux adapter's cached listing; no poll loop shares one here, so a caller reads it fresh. */
  peekSessionWindowSnapshot(_maxAgeMs: number): SessionWindowSnapshot | null { return null; }
  async getDefaultShell(): Promise<string | null> { return process.env.SHELL || null; }
}
