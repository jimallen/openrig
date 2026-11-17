// workspaces-o9o.11: the host section of `rig doctor`, checked before a host's first launch. Reads and reports only;
// every row that finds a problem names the command that fixes it, and none of them runs it.
//
// The daemon answers the rows that need its view (a probe shell shaped like a seat's, runtime paths, spec folders):
// POST /api/doctor/host. The rows here need only this machine: the Pi operator login, inotify headroom, the git
// template, and the registered remote hosts. Each reads through `LocalHostFacts`, so tests drive them with fakes.
import path from "node:path";

export interface HostCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skipped";
  message: string;
  reason?: string;
  fix?: string;
}

/** What the local rows read. Every read returns null when it cannot be made; a row then says what it could not see. */
export interface LocalHostFacts {
  platform: NodeJS.Platform;
  uid: number | null;
  readFile(file: string): string | null;
  readdir(dir: string): string[] | null;
  /** readlink only: an fd under /proc is never opened (opening one can take bytes from a pipe another process reads). */
  readlink(file: string): string | null;
  stat(file: string): { isFile: boolean; isDirectory: boolean; uid: number } | null;
  /** Make a throwaway repository with this user's git settings and say whether git gave it .git/info/exclude. */
  gitTemplateHasExclude(): boolean | null;
  /** Ids from the host registry; null when there is no registry file; an error when it cannot be read. */
  registeredHosts(): { ids: string[] } | { error: string } | null;
}

export const SEAT_SHELL_NOTE =
  "The seat-shell check started one login shell the way a seat launch does, so your login profile ran once. Pass --no-seat-shell to skip it.";

/** `pi.operator_login_dir`: Pi seats link the operator's auth.json from it; without it a seat whose provider needs a
 *  stored sign-in is refused at launch. Only presence and type are read, never the file's contents. */
export function piOperatorLoginCheck(operatorLoginDir: string | undefined, piUsed: boolean | null, facts: LocalHostFacts): HostCheck {
  const name = "pi_operator_login";
  // With a spec, only a spec with Pi seats needs the setting, however it is set.
  if (piUsed === false) return { name, status: "skipped", message: "The spec has no Pi seats." };
  const dir = operatorLoginDir?.trim() ?? "";
  if (dir === "") {
    return {
      name,
      status: piUsed ? "warn" : "skipped",
      message: piUsed
        ? "pi.operator_login_dir is not set, so Pi seats get no operator login. A Pi seat whose provider needs a stored sign-in is refused at launch."
        : "pi.operator_login_dir is not set. Only Pi seats use it; with --spec this row says whether yours need it.",
      fix: "rig config set pi.operator_login_dir <the operator's Pi agent folder, e.g. ~/.pi/agent as an absolute path>",
    };
  }
  const folder = facts.stat(dir);
  if (!folder?.isDirectory) {
    return { name, status: "fail", message: `pi.operator_login_dir is ${dir}, which is not a folder here.`, fix: "rig config set pi.operator_login_dir <an existing absolute folder>" };
  }
  const auth = facts.stat(path.join(dir, "auth.json"));
  if (!auth?.isFile) {
    return {
      name,
      status: "fail",
      message: `pi.operator_login_dir is ${dir}, but it has no auth.json, so a Pi seat's launch refuses to link it.`,
      fix: `Log in to Pi as the operator once (run pi with PI_CODING_AGENT_DIR=${dir}, then /login), or point the setting at the folder that has auth.json.`,
    };
  }
  return { name, status: "pass", message: `pi.operator_login_dir is ${dir}, and its auth.json is present (contents not read).` };
}

/** Linux: this user's inotify watches and instances against the kernel limits. Counted from /proc with readlink and the
 *  fdinfo files (a separate file per fd), never by opening an fd. */
export function inotifyHeadroomCheck(facts: LocalHostFacts): HostCheck {
  const name = "inotify_headroom";
  if (facts.platform !== "linux") return { name, status: "skipped", message: `inotify is Linux only; this is ${facts.platform}.` };
  const limit = (key: string) => {
    const raw = facts.readFile(`/proc/sys/fs/inotify/${key}`);
    const value = raw === null ? NaN : Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) ? value : null;
  };
  const maxWatches = limit("max_user_watches");
  const maxInstances = limit("max_user_instances");
  if (maxWatches === null || maxInstances === null) {
    return { name, status: "skipped", message: "The inotify limits under /proc/sys/fs/inotify could not be read." };
  }
  let watches = 0;
  let instances = 0;
  // A read that fails for a process that still exists makes the count unknown (it could hide any number of watches);
  // a process that ended between the listing and the read holds nothing now, so it is simply not counted.
  const unreadable: string[] = [];
  const stillThere = (pid: string) => facts.stat(`/proc/${pid}`) !== null;
  const processes = facts.readdir("/proc");
  if (processes === null) return { name, status: "skipped", message: "/proc could not be listed, so inotify use is unknown." };
  for (const pid of processes) {
    if (!/^\d+$/.test(pid)) continue;
    const owner = facts.stat(`/proc/${pid}`);
    if (!owner || (facts.uid !== null && owner.uid !== facts.uid)) continue;
    const fds = facts.readdir(`/proc/${pid}/fd`);
    if (fds === null) {
      if (stillThere(pid)) unreadable.push(`/proc/${pid}/fd`);
      continue;
    }
    for (const fd of fds) {
      if (facts.readlink(`/proc/${pid}/fd/${fd}`) !== "anon_inode:inotify") continue;
      const info = facts.readFile(`/proc/${pid}/fdinfo/${fd}`);
      if (info === null) {
        if (stillThere(pid)) unreadable.push(`/proc/${pid}/fdinfo/${fd}`);
        continue;
      }
      instances += 1;
      watches += info.split("\n").filter((line) => line.startsWith("inotify wd:")).length;
    }
  }
  if (unreadable.length > 0) {
    return {
      name,
      status: "skipped",
      message: `inotify use is unknown: ${unreadable.length} of this user's process entries could not be read.`,
      reason: unreadable.slice(0, 10).join(", ") + (unreadable.length > 10 ? `, and ${unreadable.length - 10} more` : ""),
    };
  }
  const used = `${watches} of ${maxWatches} watches and ${instances} of ${maxInstances} instances in use by this user`;
  if (watches >= 0.8 * maxWatches || instances >= 0.8 * maxInstances) {
    return {
      name,
      status: "warn",
      message: `inotify is close to its limit: ${used}. When it runs out, file watching stops (proof source watch, plugin refresh).`,
      fix: "Raise the limits, for example: sudo sysctl fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=1024 (and persist them in /etc/sysctl.d).",
    };
  }
  return { name, status: "pass", message: `inotify headroom: ${used}.` };
}

/** A repository made with this user's git template. Release 4 creates a missing .git/info/exclude itself; a host still
 *  on release 3 fails in project setup and its tests without it. */
export function gitTemplateCheck(facts: LocalHostFacts): HostCheck {
  const name = "git_info_exclude";
  const has = facts.gitTemplateHasExclude();
  if (has === null) return { name, status: "skipped", message: "git could not make a throwaway repository here, so the template was not checked." };
  if (has) return { name, status: "pass", message: "A new repository gets .git/info/exclude from this user's git template." };
  return {
    name,
    status: "warn",
    message: "A new repository gets no .git/info/exclude from this user's git template (init.templateDir or GIT_TEMPLATE_DIR). OpenRig from release 4 creates it when needed; a host still on release 3 fails where it writes that file.",
    fix: "Add info/exclude to your git template folder (copy it from git's default templates), or upgrade OpenRig.",
  };
}

/** The remote hosts: their reach is `rig host doctor <id>`'s job, so this row only points at it. */
export function remoteHostsCheck(facts: LocalHostFacts): HostCheck {
  const name = "remote_hosts";
  const registry = facts.registeredHosts();
  if (registry === null) return { name, status: "skipped", message: "No host registry; no remote hosts are registered." };
  if ("error" in registry) return { name, status: "fail", message: "The host registry could not be read.", reason: registry.error };
  const ids = registry.ids;
  if (ids.length === 0) return { name, status: "pass", message: "The host registry lists no remote hosts." };
  return {
    name,
    status: "pass",
    message: `${ids.length} registered remote host${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}. Their reach is not checked here.`,
    fix: ids.map((id) => `rig host doctor ${id}`).join("; "),
  };
}

/** The runtimes a rig spec's seats use, or null when there is no spec or it cannot be read. */
export function runtimesInSpec(spec: unknown): string[] | null {
  const pods = (spec as { pods?: unknown })?.pods;
  if (!Array.isArray(pods)) return null;
  const runtimes = new Set<string>();
  for (const pod of pods) {
    const members = (pod as { members?: unknown })?.members;
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const runtime = (member as { runtime?: unknown })?.runtime;
      if (typeof runtime === "string") runtimes.add(runtime);
    }
  }
  return [...runtimes].sort();
}

/** Ask the daemon for its host rows. It sends the terminal token (`headers`, from terminalAuthHeaders), since the
 *  route runs a login shell and sits behind the terminal guard. Null when the daemon cannot be reached. */
export async function fetchDaemonHostRows(
  fetchFn: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
  base: string,
  headers: Record<string, string>,
  input: { seatShell: boolean; runtimes: string[] | null },
): Promise<{ status: number; rows: HostCheck[] | null } | null> {
  try {
    const res = await fetchFn(`${base}/api/doctor/host`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ seatShell: input.seatShell, ...(input.runtimes ? { runtimes: input.runtimes } : {}) }),
    });
    const body = res.ok ? (await res.json()) as { rows?: unknown } : null;
    return { status: res.status, rows: Array.isArray(body?.rows) ? (body!.rows as HostCheck[]) : null };
  } catch {
    return null;
  }
}

/** The daemon's rows. Null input means the daemon could not be asked; the rows then say so instead of passing. */
export function daemonHostRows(response: { status: number; rows: HostCheck[] | null } | null, seatShell: boolean): HostCheck[] {
  const needs = seatShell ? "a seat's login shell, runtime paths and spec folders" : "spec folders";
  if (response === null) {
    return [{ name: "host_daemon_checks", status: "skipped", message: `The daemon could not be reached, so ${needs} were not checked.`, fix: "rig daemon start, then rig doctor again" }];
  }
  if (response.status === 404) {
    return [{ name: "host_daemon_checks", status: "skipped", message: `This daemon has no host check (an older version), so ${needs} were not checked.`, fix: "Upgrade OpenRig, then have the operator restart the daemon." }];
  }
  if (response.status === 401) {
    return [{ name: "host_daemon_checks", status: "fail", message: `The daemon refused the host check without its terminal token, so ${needs} were not checked.`, fix: "Run rig doctor where the CLI can read the daemon's terminal token (OPENRIG_TERMINAL_BEARER_TOKEN, or <OPENRIG_HOME>/terminal-token)." }];
  }
  if (response.status >= 400 || response.rows === null) {
    return [{ name: "host_daemon_checks", status: "fail", message: `The daemon's host check failed (HTTP ${response.status}), so ${needs} were not checked.` }];
  }
  return response.rows;
}
