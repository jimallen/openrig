import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { DaemonClient } from "./client.js";
import { shellQuote } from "./cross-host-executor.js";
import { prepareHerdrLaunchConfig } from "./herdr-launch-config.js";
import type { OpenViewResult } from "./commands/terminal.js";

interface Pane { seat: string; label: string; paneCommand: string }
interface Preview {
  planId: string;
  status: { launch?: { socketPath: string; session?: string } };
  composed: { id: string; opened: Pane[]; pages: Pane[][]; columns?: number; kernelLayout?: string; spaceLabel?: string; absent: OpenViewResult["absent"]; degraded: OpenViewResult["degraded"] };
}

export interface WindowDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists(file: string): boolean;
  exec(file: string, args: string[], timeoutMs?: number): Promise<string>;
  launch(file: string, args: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  id(): string;
  herdrConfig(socketPath: string, columns?: number): string;
  /** Hosting terminal measurement also works for an agent shell tool with piped stdio. */
  columns?(): Promise<number | undefined>;
  notice?(message: string): void;
}

export function defaultWindowDeps(): WindowDeps {
  const env = { ...process.env };
  delete env["TMUX"];
  const run = promisify(execFile);
  return {
    platform: process.platform, env, exists: existsSync,
    exec: async (file, args, timeoutMs = 10_000) => (await run(file, args, { env, encoding: "utf8", timeout: timeoutMs })).stdout,
    launch: (file, args) => new Promise((resolve, reject) => {
      const child = spawn(file, args, { env, detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    id: () => randomUUID().slice(0, 12),
    notice: message => process.stderr.write(`${message}\n`),
    herdrConfig: (socketPath, columns) => prepareHerdrLaunchConfig(env, socketPath, columns),
    columns: async () => {
      if (process.stdout.isTTY && process.stdout.columns > 0) return process.stdout.columns;
      try {
        const size = await run("/bin/sh", ["-c", "stty size < /dev/tty"], { encoding: "utf8", timeout: 1000 });
        const width = Number(size.stdout.trim().split(/\s+/)[1]);
        if (Number.isSafeInteger(width) && width > 0) return width;
      } catch { /* A detached shell tool may still have an ancestor that owns the person's terminal. */ }
      // An agent's shell tool has no terminal, but the agent process above it runs in the person's
      // terminal (a Ghostty or Terminal tab, or a Herdr pane). Read the nearest ancestor's terminal size.
      try {
        let pid = process.ppid;
        for (let depth = 0; depth < 8 && pid > 1; depth++) {
          const [parent, tty] = (await run("ps", ["-o", "ppid=,tty=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 })).stdout.trim().split(/\s+/);
          if (tty && /^[A-Za-z0-9/]+$/.test(tty) && tty !== "??" && tty !== "?") {
            const size = await run("/bin/sh", ["-c", `stty size < /dev/${tty}`], { encoding: "utf8", timeout: 1000 });
            const width = Number(size.stdout.trim().split(/\s+/)[1]);
            return Number.isSafeInteger(width) && width > 0 ? width : undefined;
          }
          pid = Number(parent);
        }
      } catch { /* Unknown is a narrow layout, never an invented wide measurement. */ }
      return undefined;
    },
  };
}

function localDaemon(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return ["localhost", "::1", "::", "0.0.0.0", hostname()].includes(host)
    || /^127\./.test(host)
    || Object.values(networkInterfaces()).flat().some(iface => iface?.address === host);
}

async function herdrBinary(deps: WindowDeps): Promise<string | null> {
  const dir = deps.env["HERDR_INSTALL_DIR"] ?? path.join(deps.env["HOME"] ?? homedir(), ".local", "bin");
  for (const candidate of ["herdr", path.join(dir, "herdr")]) {
    try {
      await deps.exec(candidate, ["--version"]);
      const binary = candidate === "herdr" ? (await deps.exec("/bin/sh", ["-c", "command -v herdr"])).trim() : candidate;
      if (path.isAbsolute(binary)) return binary;
    } catch { /* The installer path also works when it is absent from PATH. */ }
  }
  return null;
}

/** New surfaces only. No System Events keystrokes or existing-terminal input. */
async function windowLauncher(deps: WindowDeps, notes: string[]): Promise<((command: string) => Promise<{ app: string; surface: string; columns?: number }>) | { currentHerdr: true } | string> {
  // Shell tools can pipe stdio while still running inside the person's terminal.
  const program = deps.env["TERM_PROGRAM"];
  const linuxHost = deps.platform !== "linux" ? undefined
    : deps.env["GNOME_TERMINAL_SERVICE"] ? "gnome-terminal"
    : deps.env["KONSOLE_VERSION"] ? "konsole" : deps.env["XTERM_VERSION"] ? "xterm" : undefined;
  const host = !program || program === "tmux" ? deps.env["__CFBundleIdentifier"] ?? linuxHost : program;
  if (deps.env["CI"] && !["0", "false"].includes(deps.env["CI"])) return "This is a CI run.";
  if (deps.env["SSH_CONNECTION"] || deps.env["SSH_CLIENT"] || deps.env["SSH_TTY"]) return "This is an SSH session; no desktop window is opened over SSH.";
  // A tmux started inside a Herdr pane sets TERM_PROGRAM=tmux but inherits Herdr's pane markers, so read those too.
  const inHerdrPane = deps.env["HERDR_ENV"] === "1" && !!deps.env["HERDR_PANE_ID"] && !!deps.env["HERDR_SOCKET_PATH"];
  if (host === "herdr" || inHerdrPane) return { currentHerdr: true };
  if (deps.platform === "darwin") {
    const inGhostty = host === "ghostty" || host === "com.mitchellh.ghostty";
    const inTerminal = host === "Apple_Terminal" || host === "com.apple.Terminal";
    const newApp = !inGhostty && !inTerminal;
    // Desktop shell tools need no stdin TTY, but a background job must not summon an app.
    if (newApp && (await deps.exec("/bin/launchctl", ["managername"]).catch(() => "")).trim() !== "Aqua") {
      return "No local macOS desktop session could be confirmed.";
    }
    const app = !inTerminal ? ["/Applications/Ghostty.app", path.join(deps.env["HOME"] ?? homedir(), "Applications/Ghostty.app")].find(deps.exists) : undefined;
    let ghostty = false;
    if (app) {
      try {
        const version = await deps.exec("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(app, "Contents/Info.plist")]);
        const [major, minor] = version.trim().split(".").map(Number);
        ghostty = major! > 1 || (major === 1 && minor! >= 3);
      } catch { /* No other app is a substitute for the hosting terminal. */ }
    }
    if (inGhostty && !ghostty) return "The installed Ghostty does not provide a supported scripting interface (1.3 or newer required).";
    if (app && !ghostty) notes.push("The installed Ghostty could not be confirmed to support scripting (1.3 or newer required); using Terminal for this desktop caller.");
    const permissionNotice = `It is fine to click Allow if macOS asks to control ${ghostty ? "Ghostty" : "Terminal"}; this lets OpenRig open the view they asked for.`;
    if (newApp) notes.push(`Tell the person: ${permissionNotice} The app uses its own new-window size because this caller has no scriptable terminal window to copy.`);
    // A tab group shares bounds: copying its current bounds also leaves the original unchanged.
    const script = ghostty ? `on run argv
tell application "Ghostty"
  set cfg to new surface configuration
  set command of cfg to item 1 of argv
  if ${newApp ? "false" : "(count of windows) > 0"} then
    set newTab to new tab in front window with configuration cfg
    select tab newTab
    focus (focused terminal of newTab)
    activate window front window
    return "tab"
  else
    set newWindow to new window with configuration cfg
    activate window newWindow
    return "window"
  end if
end tell
end run` : `on run argv
tell application "Terminal"
  set personBounds to missing value
  ${newApp ? "-- No hosting Terminal window: keep the new-window profile defaults." : "if (count of windows) > 0 then set personBounds to bounds of front window"}
  set viewTab to do script ""
  set viewWindow to front window
  if personBounds is not missing value then set bounds of viewWindow to personBounds
  do script (item 1 of argv) in viewTab
  activate
  return "window:" & (number of columns of viewTab)
end tell
end run`;
    // A denied/uncertain Automation request is returned once, never replayed in another app.
    return async command => {
      if (newApp) deps.notice?.(permissionNotice);
      const reported = (await deps.exec("/usr/bin/osascript", ["-e", script, command], 120_000)).trim();
      const columns = Number(reported.split(":")[1]);
      notes.push(newApp
        ? `${ghostty ? "Ghostty" : "Terminal"} opened a new window using its own profile settings; no existing window was resized.`
        : ghostty
        ? "Ghostty keeps the person's window size; layout uses the hosting terminal's measured width when available."
        : "The new Terminal view copies the person's front-window bounds when available; existing window settings were kept.");
      return { app: ghostty ? "Ghostty" : "Terminal", surface: ghostty ? reported : "window", ...(Number.isSafeInteger(columns) && columns > 0 ? { columns } : newApp ? { columns: undefined } : {}) };
    };
  }
  if (deps.platform !== "linux") return `No supported desktop launcher on ${deps.platform}.`;
  if (!deps.env["DISPLAY"] && !deps.env["WAYLAND_DISPLAY"]) return "No desktop display is available.";
  for (const app of ["ghostty", "gnome-terminal", "konsole", "xterm"].filter(app => app === host)) {
    try { await deps.exec("/bin/sh", ["-c", `command -v ${app}`]); } catch { continue; }
    return async command => {
      const prefix = app === "ghostty" ? ["--window-width=140", "--window-height=40", "-e"]
        : app === "gnome-terminal" ? ["--window", "--geometry=140x40", "--"]
        : app === "konsole" ? ["-p", "TerminalColumns=140", "-p", "TerminalRows=40", "-e"]
        : app === "xterm" ? ["-geometry", "140x40", "-e"]
        : ["-e"];
      const args = [...prefix, "/bin/sh", "-c", command];
      await deps.launch(app, args);
      notes.push("Requested 140 columns by 40 rows for the new window. The desktop may adjust that size; enlarge it manually if needed.");
      return { app, surface: "window-requested" };
    };
  }
  return `Unrecognised or unavailable hosting terminal: ${JSON.stringify(host ?? "unknown")}.`;
}

function failure(provider: string, error: string): OpenViewResult {
  return { provider, ok: false, opened: [], absent: [], degraded: [], pages: 0, error, code: "terminal_window_failed" };
}

/** Render the daemon's existing composition; never rediscover/relaunch kernel seats here. */
/** What a person needs to know about what opened: a detached viewer leaves its seat live (spike 1.4). */
const VIEWER_NOTE = "These panes are viewers of the seats: closing one leaves the seat running.";

export async function openTerminalWindow(client: DaemonClient, view: string, requestedProvider?: string, deps = defaultWindowDeps(), expectedPlan?: string): Promise<OpenViewResult> {
  let provider = requestedProvider ?? "herdr";
  let window: { app: string; surface: string; columns?: number } | undefined;
  let windowAttempted = false;
  let manualCommand: string | undefined;
  let currentHerdr = false;
  const recovery = `rig terminal open ${shellQuote(view)} --window${requestedProvider === "herdr" ? ` --provider ${shellQuote(requestedProvider)}` : ""}`;
  const failed = (reason: string): OpenViewResult => ({ ...failure(provider,
    currentHerdr ? `The current Herdr view outcome could not be confirmed. ${reason} Inspect the selected space before retrying: ${recovery}`
      : window ? `A terminal window was requested, but the view outcome could not be confirmed. ${reason} Inspect the terminal before retrying: ${recovery}`
      : windowAttempted ? `Terminal window status is unknown. ${reason} Inspect the desktop before retrying: ${recovery}`
        : `No terminal window was opened. ${reason} On the daemon's desktop, run: ${recovery}`), windowAttempted });
  const windowNotes: string[] = [];
  try {
    if (!localDaemon(client.baseUrl)) throw new Error("The window launcher must run on the daemon's own desktop; the configured daemon is remote.");
    if (requestedProvider === "tmux") throw new Error("The tmux viewer is gone: seats show in the Herdr app by label, not in a tmux session. Use --provider herdr.");
    if (requestedProvider && requestedProvider !== "herdr") throw new Error("--window supports herdr.");
    const launchWindow = await windowLauncher(deps, windowNotes);
    const measured = typeof launchWindow !== "string" ? await deps.columns?.().catch(() => undefined) : undefined;
    let viewportColumns = Number.isSafeInteger(measured) && measured! > 0 ? measured : undefined;
    const herdr = await herdrBinary(deps);
    if (!herdr) throw new Error("Herdr is not installed. Run rig setup.");
    provider = "herdr";
    // Preview is provider-neutral composition, including saved-view membership, absences and quoting.
    const previewUrl = () => `/api/terminal/preview?view=${encodeURIComponent(view)}&provider=herdr${viewportColumns === undefined ? "" : `&viewportColumns=${viewportColumns}`}`;
    const preview = await client.get<Preview | OpenViewResult>(previewUrl());
    if (preview.status >= 400 || !("composed" in preview.data)) {
      return failed((preview.data as OpenViewResult).error ?? "Could not compose the requested view.");
    }
    let { composed, planId } = preview.data;
    if (expectedPlan !== undefined && expectedPlan !== planId) {
      return failure(provider, "The terminal view changed since preview. Refresh the preview before opening.");
    }
    if (!composed.opened.length) return { ...failed("No conversations are attachable."), absent: composed.absent, degraded: composed.degraded };
    const measureWindow = async () => {
      if (window && "columns" in window && window.columns !== viewportColumns && composed.kernelLayout) {
        viewportColumns = window.columns;
        const next = await client.get<Preview | OpenViewResult>(previewUrl());
        if (next.status >= 400 || !("composed" in next.data)) throw new Error("Could not compose the measured terminal view.");
        if (expectedPlan !== undefined && expectedPlan !== next.data.planId) throw new Error("The measured terminal layout differs from the expected preview; refresh the preview before opening.");
        ({ composed, planId } = next.data);
        if (!composed.opened.length) throw new Error("No conversations are attachable after opening the terminal.");
      }
      if (composed.kernelLayout) windowNotes.push(viewportColumns === undefined
        ? "Terminal width could not be measured; the OpenRig view uses the operator-only first page."
        : `OpenRig view layout measured at ${viewportColumns} columns: ${viewportColumns >= 120 ? "dashboard and operator side by side; advisor on a separate page" : "operator first; dashboard and advisor on separate pages"}.`);
    };
    const socket = preview.data.status.launch?.socketPath;
    if (typeof launchWindow === "object") {
      provider = "herdr";
      const base = path.join(deps.env["HOME"] ?? homedir(), ".config", "herdr");
      const callerSocket = deps.env["HERDR_SOCKET_PATH"] ?? (deps.env["HERDR_SESSION"]
        ? path.join(base, "sessions", deps.env["HERDR_SESSION"], "herdr.sock") : path.join(base, "herdr.sock"));
      if (!socket || path.resolve(socket) !== path.resolve(callerSocket)) return failed("The current Herdr endpoint differs from the daemon's endpoint; no space was opened in another session.");
      if (!herdr) return failed("The Herdr executable is unavailable; no space was opened.");
      // Set only once a space may open, so the refusals above read as "nothing was opened".
      currentHerdr = true;
      windowNotes.push("Using the current Herdr session; no terminal window or personal config was changed.");
    }
    let configEnv = "";
    let configPrefix = "";
    if (herdr && socket && !currentHerdr) {
      try {
        const narrow = deps.herdrConfig(socket);
        const wide = typeof launchWindow === "function" ? deps.herdrConfig(socket, 160) : narrow;
        if (narrow === wide) configEnv = ` HERDR_CONFIG_PATH=${shellQuote(narrow)}`;
        else configPrefix = `set -- $(stty size 2>/dev/null); if [ "${'${2:-0}'}" -ge 160 ]; then export HERDR_CONFIG_PATH=${shellQuote(wide)}; else export HERDR_CONFIG_PATH=${shellQuote(narrow)}; fi; exec `;
        windowNotes.push("Your Herdr config is kept when present; otherwise the sidebar starts open at 160 columns and collapsed below.");
      } catch (error) {
        windowNotes.push(`Could not prepare OpenRig's private Herdr settings (${error instanceof Error ? error.message : String(error)}); Herdr starts with its usual sidebar.`);
      }
    }
    const directCommand = herdr && socket
      ? `${configPrefix}env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH=${shellQuote(socket)}${configEnv} ${shellQuote(herdr)}`
      : `env -u TMUX ${composed.opened[0]!.paneCommand.replace(/^ssh /, "ssh -t ")}`;
    manualCommand = directCommand;
    if (typeof launchWindow === "string") {
      const headless = deps.env["SSH_CONNECTION"] || deps.env["SSH_CLIENT"] || deps.env["SSH_TTY"]
        || (deps.platform === "linux" && !deps.env["DISPLAY"] && !deps.env["WAYLAND_DISPLAY"]);
      const where = headless ? "Open a new SSH session to the daemon's host" : "Open a new terminal window on the daemon's host";
      const notes = herdr && socket
        ? [`After the person starts Herdr, have the agent place this view by running: rig terminal open ${shellQuote(view)} --provider herdr`] : [];
      return { ...failure(provider, `No terminal window was opened. ${launchWindow} ${where} and run: ${manualCommand}`), windowAttempted: false, absent: composed.absent, degraded: composed.degraded, notes: [...notes, ...windowNotes] };
    }

    if (herdr) {
      const endpoint = preview.data.status.launch;
      if (!endpoint?.socketPath) throw new Error("The daemon does not report its herdr endpoint. Update the daemon.");
      // A CLI session would override the daemon's resolved socket in Herdr.
      if (typeof launchWindow === "function") {
        windowAttempted = true;
        window = await launchWindow(configPrefix ? `/bin/sh -c ${shellQuote(manualCommand)}` : manualCommand);
      }
      await measureWindow();
      let alive = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const status = await client.get<{ providers: Array<{ liveness: { alive: boolean } }> }>("/api/terminal/status?provider=herdr");
        if (status.data.providers?.[0]?.liveness.alive) { alive = true; break; }
        await deps.sleep(250);
      }
      if (!alive) throw new Error("The terminal was requested, but herdr's control socket did not become ready. Inspect the new terminal before retrying.");
      // The CLI keeps no inventory of the app's tabs, and each open makes its own space of `hc attach` viewers. rig-here is what
      // places the seats themselves.
      const herdrArgs = ["-u", "TMUX", "-u", "HERDR_SESSION", "-u", "HERDR_SOCKET_PATH", `HERDR_SOCKET_PATH=${endpoint.socketPath}`, herdr];
      // In the person's own Herdr, its focused space is what they are looking at.
      const shownNote = async (workspaceId?: string) => {
        if (currentHerdr) try {
          const listed = JSON.parse(await deps.exec("/usr/bin/env", [...herdrArgs, "workspace", "list"]));
          const focused = (listed?.result?.workspaces as Array<{ workspace_id?: string; label?: string; focused?: boolean }> | undefined)?.find(ws => ws?.focused);
          if (focused && (workspaceId ? focused.workspace_id === workspaceId : !!composed.spaceLabel && focused.label === composed.spaceLabel)) {
            return `Herdr shows the ${focused.label ?? "view's"} space in the person's current session.`;
          }
        } catch { /* Unconfirmed: say so below. */ }
        return currentHerdr ? "Herdr did not confirm the view's space is focused; ask the person whether they see it." : "Check the new terminal shows the intended view; window creation alone is not visual confirmation.";
      };
      const result = await client.post<OpenViewResult>("/api/terminal/open", { view, provider: "herdr", expectedPlan: planId, ...(viewportColumns !== undefined ? { viewportColumns } : {}) }, { timeoutMs: 45_000 });
      if (result.status >= 400) return { ...failed(result.data.error ?? `The daemon refused the view (HTTP ${result.status}).`), window, notes: windowNotes, absent: composed.absent, degraded: composed.degraded };
      if (!Array.isArray(result.data?.opened)) throw new Error("The terminal opened, but the daemon returned no view result. Inspect it before retrying.");
      return { ...result.data, window, notes: [...(result.data.notes ?? []), ...windowNotes, VIEWER_NOTE, await shownNote()] };
    }

    // Herdr is required above; reaching here means the herdr branch returned.
    throw new Error("No terminal view was opened.");
  } catch (err) {
    if (windowAttempted && /-1743\b/.test(`${(err as Error).message} ${(err as { stderr?: string }).stderr ?? ""}`)) {
      windowNotes.push("macOS denied Automation access. In System Settings > Privacy & Security > Automation, allow the calling app to control the terminal app before trying again.");
      if (manualCommand) windowNotes.push(`To continue without Automation, open a terminal yourself and run: ${manualCommand}`);
      if (provider === "herdr") windowNotes.push(`After Herdr starts, have the agent place the view: rig terminal open ${shellQuote(view)} --provider herdr`);
    }
    return { ...failed((err as Error).message), ...(window ? { window } : {}), ...(windowNotes.length ? { notes: windowNotes } : {}) };
  }
}
