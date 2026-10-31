import type { SeatDeliveryGuard } from "../domain/seat-delivery-guard.js";
import { HcAttach } from "./hc-attach.js";
import { HcCapture } from "./hc-capture.js";
import { HcClient } from "./hc-client.js";
import { HcHost } from "./hc-host.js";
import { HcIdentity } from "./hc-identity.js";
import { HcInput } from "./hc-input.js";
import { HcLifecycle } from "./hc-lifecycle.js";
import { HcViewer } from "./hc-viewer.js";
import { TmuxAdapter, type SessionWindowSnapshot, type TmuxResult } from "./tmux.js";

function refuseTmux(what: string): never {
  throw new Error(`hc seat host: a tmux path was reached (${what}); this method has no hc replacement`);
}

/** The seat host on herdr-core with the tmux adapter's surface, so its 58 referring files stay put at the switch. Each area
 *  lives in its own module; this class only joins them and answers what has no meaning on hc. It extends TmuxAdapter for
 *  the type alone: its exec refuses, so a method missed here fails loudly and can never run tmux. */
export class HcAdapter extends TmuxAdapter {
  override readonly hostKind = "hc" as const;
  private readonly identity: HcIdentity;
  private readonly capture: HcCapture;
  private readonly viewer: HcViewer;
  private wired?: { guard: SeatDeliveryGuard | undefined; host: HcHost; input: HcInput; lifecycle: HcLifecycle };

  constructor(readonly client: HcClient = new HcClient()) {
    super(async (cmd) => refuseTmux(cmd), undefined, async (argv) => refuseTmux(argv.join(" ")));
    this.identity = new HcIdentity(client);
    this.capture = new HcCapture(client);
    this.viewer = new HcViewer({ client });
  }

  /** startup sets deliveryGuard after construction, as it does on the tmux adapter, so the guarded parts follow it. */
  private parts(): NonNullable<HcAdapter["wired"]> {
    const guard = this.deliveryGuard;
    if (!this.wired || this.wired.guard !== guard) {
      const client = this.client;
      this.wired = {
        guard,
        host: new HcHost(client, guard ? { ownsLifecycle: (nodeId) => guard.ownsLifecycle(nodeId) } : {}),
        // The same core as every other call: a default attach would resolve the socket from the env on its own.
        input: new HcInput(client, new HcAttach(client.socketPath), guard ? { guard } : {}),
        lifecycle: new HcLifecycle(client, guard ? { isManagedSeat: (name) => !!guard.maybeTarget(name) } : {}),
      };
    }
    return this.wired;
  }

  // Viewers
  override getPaneCursorPosition(...a: Parameters<HcViewer["getPaneCursorPosition"]>) { return this.viewer.getPaneCursorPosition(...a); }
  override startPipePane(...a: Parameters<HcViewer["startPipePane"]>) { return this.viewer.startPipePane(...a); }
  override stopPipePane(...a: Parameters<HcViewer["stopPipePane"]>) { return this.viewer.stopPipePane(...a); }
  override resizeWindow(...a: Parameters<HcViewer["resizeWindow"]>) { return this.viewer.resizeWindow(...a); }
  override listClients() { return this.viewer.listClients(); }
  override switchClient(...a: Parameters<HcViewer["switchClient"]>) { return this.viewer.switchClient(...a); }

  // Launch and presence
  override probeSession(...a: Parameters<HcHost["probeSession"]>): ReturnType<HcHost["probeSession"]> { return this.parts().host.probeSession(...a) as ReturnType<HcHost["probeSession"]>; }
  override hasSession(...a: Parameters<HcHost["hasSession"]>): ReturnType<HcHost["hasSession"]> { return this.parts().host.hasSession(...a) as ReturnType<HcHost["hasSession"]>; }
  override createSession(...a: Parameters<HcHost["createSession"]>): ReturnType<HcHost["createSession"]> { return this.parts().host.createSession(...a) as ReturnType<HcHost["createSession"]>; }

  // Input
  override sendText(...a: Parameters<HcInput["sendText"]>): ReturnType<HcInput["sendText"]> { return this.parts().input.sendText(...a) as ReturnType<HcInput["sendText"]>; }
  override sendKeys(...a: Parameters<HcInput["sendKeys"]>): ReturnType<HcInput["sendKeys"]> { return this.parts().input.sendKeys(...a) as ReturnType<HcInput["sendKeys"]>; }
  override sendShellCommand(...a: Parameters<HcInput["sendShellCommand"]>): ReturnType<HcInput["sendShellCommand"]> { return this.parts().input.sendShellCommand(...a) as ReturnType<HcInput["sendShellCommand"]>; }
  submitText(...a: Parameters<HcInput["submitText"]>): ReturnType<HcInput["submitText"]> { return this.parts().input.submitText(...a) as ReturnType<HcInput["submitText"]>; }

  // Capture
  override capturePaneContent(...a: Parameters<HcCapture["capturePaneContent"]>): ReturnType<HcCapture["capturePaneContent"]> { return this.capture.capturePaneContent(...a) as ReturnType<HcCapture["capturePaneContent"]>; }
  override capturePaneScreen(...a: Parameters<HcCapture["capturePaneScreen"]>): ReturnType<HcCapture["capturePaneScreen"]> { return this.capture.capturePaneScreen(...a) as ReturnType<HcCapture["capturePaneScreen"]>; }
  override capturePaneHistory(...a: Parameters<HcCapture["capturePaneHistory"]>): ReturnType<HcCapture["capturePaneHistory"]> { return this.capture.capturePaneHistory(...a) as ReturnType<HcCapture["capturePaneHistory"]>; }
  override capturePanesContent(...a: Parameters<HcCapture["capturePanesContent"]>): ReturnType<HcCapture["capturePanesContent"]> { return this.capture.capturePanesContent(...a) as ReturnType<HcCapture["capturePanesContent"]>; }

  // Identity and listing
  override listSessions(...a: Parameters<HcIdentity["listSessions"]>): ReturnType<HcIdentity["listSessions"]> { return this.identity.listSessions(...a) as ReturnType<HcIdentity["listSessions"]>; }
  override listWindows(...a: Parameters<HcIdentity["listWindows"]>): ReturnType<HcIdentity["listWindows"]> { return this.identity.listWindows(...a) as ReturnType<HcIdentity["listWindows"]>; }
  override listPanes(...a: Parameters<HcIdentity["listPanes"]>): ReturnType<HcIdentity["listPanes"]> { return this.identity.listPanes(...a) as ReturnType<HcIdentity["listPanes"]>; }
  override getPanePid(...a: Parameters<HcIdentity["getPanePid"]>): ReturnType<HcIdentity["getPanePid"]> { return this.identity.getPanePid(...a) as ReturnType<HcIdentity["getPanePid"]>; }
  override getPaneCommand(...a: Parameters<HcIdentity["getPaneCommand"]>): ReturnType<HcIdentity["getPaneCommand"]> { return this.identity.getPaneCommand(...a) as ReturnType<HcIdentity["getPaneCommand"]>; }
  override readAllPaneProcesses(...a: Parameters<HcIdentity["readAllPaneProcesses"]>): ReturnType<HcIdentity["readAllPaneProcesses"]> { return this.identity.readAllPaneProcesses(...a) as ReturnType<HcIdentity["readAllPaneProcesses"]>; }
  override readSessionWindowSnapshot(...a: Parameters<HcIdentity["readSessionWindowSnapshot"]>): ReturnType<HcIdentity["readSessionWindowSnapshot"]> { return this.identity.readSessionWindowSnapshot(...a) as ReturnType<HcIdentity["readSessionWindowSnapshot"]>; }
  override readAllSessionWindowActivity(...a: Parameters<HcIdentity["readAllSessionWindowActivity"]>): ReturnType<HcIdentity["readAllSessionWindowActivity"]> { return this.identity.readAllSessionWindowActivity(...a) as ReturnType<HcIdentity["readAllSessionWindowActivity"]>; }
  override readPaneLastActivity(...a: Parameters<HcIdentity["readPaneLastActivity"]>): ReturnType<HcIdentity["readPaneLastActivity"]> { return this.identity.readPaneLastActivity(...a) as ReturnType<HcIdentity["readPaneLastActivity"]>; }
  override setSessionOption(...a: Parameters<HcIdentity["setSessionOption"]>): ReturnType<HcIdentity["setSessionOption"]> { return this.identity.setSessionOption(...a) as ReturnType<HcIdentity["setSessionOption"]>; }
  override readSessionOption(...a: Parameters<HcIdentity["readSessionOption"]>): ReturnType<HcIdentity["readSessionOption"]> { return this.identity.readSessionOption(...a) as ReturnType<HcIdentity["readSessionOption"]>; }
  override getSessionOption(...a: Parameters<HcIdentity["getSessionOption"]>): ReturnType<HcIdentity["getSessionOption"]> { return this.identity.getSessionOption(...a) as ReturnType<HcIdentity["getSessionOption"]>; }
  override getSessionEnv(...a: Parameters<HcIdentity["getSessionEnv"]>): ReturnType<HcIdentity["getSessionEnv"]> { return this.identity.getSessionEnv(...a) as ReturnType<HcIdentity["getSessionEnv"]>; }
  override hasSessionEnv(...a: Parameters<HcIdentity["hasSessionEnv"]>): ReturnType<HcIdentity["hasSessionEnv"]> { return this.identity.hasSessionEnv(...a) as ReturnType<HcIdentity["hasSessionEnv"]>; }

  // Lifecycle
  override killSession(...a: Parameters<HcLifecycle["killSession"]>): ReturnType<HcLifecycle["killSession"]> { return this.parts().lifecycle.killSession(...a) as ReturnType<HcLifecycle["killSession"]>; }
  override respawnPane(...a: Parameters<HcLifecycle["respawnPane"]>): ReturnType<HcLifecycle["respawnPane"]> { return this.parts().lifecycle.respawnPane(...a) as ReturnType<HcLifecycle["respawnPane"]>; }
  override signalPid(...a: Parameters<HcLifecycle["signalPid"]>): ReturnType<HcLifecycle["signalPid"]> { return this.parts().lifecycle.signalPid(...a) as ReturnType<HcLifecycle["signalPid"]>; }
  override signalPaneProcess(...a: Parameters<HcLifecycle["signalPaneProcess"]>): ReturnType<HcLifecycle["signalPaneProcess"]> { return this.parts().lifecycle.signalPaneProcess(...a) as ReturnType<HcLifecycle["signalPaneProcess"]>; }
  override setRemainOnExit(...a: Parameters<HcLifecycle["setRemainOnExit"]>): ReturnType<HcLifecycle["setRemainOnExit"]> { return this.parts().lifecycle.setRemainOnExit(...a) as ReturnType<HcLifecycle["setRemainOnExit"]>; }
  override isPaneDead(...a: Parameters<HcLifecycle["isPaneDead"]>): ReturnType<HcLifecycle["isPaneDead"]> { return this.parts().lifecycle.isPaneDead(...a) as ReturnType<HcLifecycle["isPaneDead"]>; }
  override createProbeSession(...a: Parameters<HcLifecycle["createProbeSession"]>): ReturnType<HcLifecycle["createProbeSession"]> { return this.parts().lifecycle.createProbeSession(...a) as ReturnType<HcLifecycle["createProbeSession"]>; }

  // No meaning on hc: there is no server to start, no server or window options, no pane-local options, and a launch
  // binding has no fresh-pane proof to clear.
  override async startServer(): Promise<TmuxResult> { return { ok: true }; }
  override async setServerOption(_option: string, _value: string): Promise<TmuxResult> { return { ok: true }; }
  override async showServerOption(_option: string): Promise<string | null> { return null; }
  override async setWindowOption(_target: string, _option: string, _value: string): Promise<TmuxResult> { return { ok: true }; }
  override async getPaneLocalOption(_pane: string, _option: string): Promise<string | null | undefined> { return null; }
  override async restorePaneOption(_pane: string, _option: string, _value: string | null): Promise<TmuxResult> { return { ok: true }; }
  override finishLaunchBinding(_session: string): void {}
  /** The tmux adapter's cached listing; no poll loop shares one here, so a caller reads it fresh. */
  override peekSessionWindowSnapshot(_maxAgeMs: number): SessionWindowSnapshot | null { return null; }
  override async getDefaultShell(): Promise<string | null> { return process.env.SHELL || null; }
}
