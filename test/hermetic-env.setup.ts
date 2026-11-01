// D12 base-health + WRITE-leak containment (broadcast-leak atom).
//
// The Node test suites MUST NOT inherit the seat's live-daemon connection. Two holes:
//
// 1. Connection-redirect env (OPENRIG_URL / OPENRIG_PORT / OPENRIG_HOST + RIGGED_*
//    aliases) — honored as a real operator override in production, but ambient inside
//    a seat it bypasses each test's injected mock daemon (up.test.ts: 29 fails ambient
//    vs 1 hermetic). Scrubbed below. Production behavior is untouched.
//
// 2. The DEFAULT STATE_FILE discovery — `OPENRIG_HOME/daemon.json` (daemon-lifecycle
//    `OPENRIG_DIR = OPENRIG_HOME`). Scrubbing the env is NOT enough: with URL/PORT
//    unset, the CLI falls back to the live daemon's state file. This is exactly how
//    `broadcast.test.ts` emitted REAL 'System maintenance' broadcasts to 14 seats.
//    The READ direction (results pollution) was known; the WRITE direction (emitting
//    into the live topology) is strictly worse.
//
// FORCE + ASSERT (unwritable-by-omission — the guarantee lives where it cannot be
// skipped, so a new test file inherits safety from the setup that runs first, not
// from a runner or a per-file convention that 145/164 files already omit):
//   FORCE  — establish a fixture-scoped OPENRIG_HOME (a fresh temp dir carrying the
//            `.openrig-fixture` marker) BEFORE any daemon-resolving module loads and
//            captures the eager `OPENRIG_HOME` const, so default discovery finds no
//            live daemon.
//   ASSERT — `assertFixtureScopedHome` throws LOUD if the home is NOT fixture-scoped
//            (mkdtemp failure, or OPENRIG_HOME captured before this ran via an
//            import-order regression). Forcing alone silently fixes and proves
//            nothing; the assert makes it evidence. Its known-negative lives in
//            live-daemon-guard.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Scrub inherited instance selectors before product modules capture their defaults.
// Tests can still set explicit overrides after setup; test/provider opt-in flags
// are not instance selectors and remain untouched.
for (const key of [
  "URL", "PORT", "HOST", "BIND_HOST", "HOST_SELECTED", "DB",
  "TRANSCRIPTS_PATH", "WORKSPACE_ROOT", "WORKSPACE_SLICES_ROOT",
  "WORKSPACE_STEERING_PATH", "WORKSPACE_SPECS_ROOT", "WORKSPACE_PROJECTS_ROOT",
  "WORKSPACE_CATALOG_PATH", "TOPOLOGY_ROOT", "CONTEXT_ROOT", "CONTEXT_PACKS_ROOT",
  "SKILLS_ROOT", "SHARED_DOCS_ROOT", "FILES_ALLOWLIST", "PROGRESS_SCAN_ROOTS",
  "SESSION_NAME", "NODE_ID", "RIG_ID", "AUTH_BEARER_TOKEN", "TERMINAL_BEARER_TOKEN",
  // Slice 15: a seat with compact output on must not change what the suite prints.
  "OUTPUT_COMPACT",
  // Slice 01: a seat with usage windows on must not change what the suite reads.
  "PROVIDER_USAGE_WINDOWS",
]) {
  delete process.env[`OPENRIG_${key}`];
  delete process.env[`RIGGED_${key}`];
}

// (1b) hc cutover W8: scrub the herdr-core (`hc`) selectors. After the cutover the suites run inside seats whose env
// carries the seat's own core (HC_SOCKET, HC_SESSION, HC_SCOPE, HC_TERMINAL_ID, HC_TERMINAL_SOCKET), and
// `new HcClient()` defaults to `resolveHcSocket(process.env)`: a test that builds a default client inside a seat would
// reach THAT SEAT'S core and could send keys to, read or stop its terminals. Every `HC_`-prefixed name goes (a positional
// predicate, not a list: a selector added by a later hc release is covered too). A test that needs a core gets a private
// one from packages/daemon/test/helpers/hc-scratch.ts, whose env is built, not copied. The core socket also follows
// XDG_RUNTIME_DIR before any state dir (hc-client.ts resolveHcSocket), so that is dropped below with the other XDG paths.
// An in-process daemon must never start a core under a test's scratch HOME and leave it behind.
process.env["OPENRIG_HC_NO_START_CORE"] = "1";
for (const key of Object.keys(process.env)) {
  if (key.startsWith("HC_")) delete process.env[key];
}

// (2) FORCE a fixture-scoped home — BEFORE importing openrig-compat (whose
// OPENRIG_HOME const is eager). Node builtins above do not load it; the dynamic
// imports below run only AFTER this assignment, so the const captures the fixture.
// ONE stable fixture home per worker. setupFiles runs per test FILE, but
// openrig-compat's OPENRIG_HOME const is captured ONCE per worker — a fresh per-file
// home would diverge from that captured const (env says home N, the const holds home
// 1), which flakes any test reading one vs the other under suite ordering. So reuse a
// fixture home already established in this worker. Named as a realistic `.openrig`-style
// home (still fixture-scoped via the marker) so path-shape assertions hold against it.
const existingHome = process.env["OPENRIG_HOME"];
const fixtureHome =
  existingHome && fs.existsSync(path.join(existingHome, ".openrig-fixture"))
    ? existingHome
    : (() => {
        const h = fs.mkdtempSync(path.join(os.tmpdir(), ".openrig-test-fixture-home-"));
        fs.writeFileSync(path.join(h, ".openrig-fixture"), "");
        // OF-80: this process created the fixture home (and, below, its `-user-home`
        // sibling), so it removes both. afterAll runs after failed tests too. vitest's
        // forks pool (isolate on, no config override) gives each test file its own
        // process, so one file's afterAll is the end of that home's life. The process
        // 'exit' hook was measured not to fire in a vitest fork (workers are torn down
        // without running it), so it is not relied on. Only the creator registers.
        // OF-82: a file whose tests are all skipped never runs the afterAll below, so also record this
        // home with the run's globalSetup (test/hermetic-env.global.ts), whose teardown removes it.
        const registry = process.env["OPENRIG_TEST_FIXTURE_REGISTRY"];
        if (registry) {
          try { fs.writeFileSync(path.join(registry, path.basename(h)), h); } catch { /* best effort */ }
        }
        afterAll(() => {
          for (const dir of [h, `${h}-user-home`]) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
          }
        });
        return h;
      })();
process.env["OPENRIG_HOME"] = fixtureHome;
delete process.env["RIGGED_HOME"];
// Legacy ~/.rigged discovery and ordinary home-based config must also stay local
// to this fixture. Merely changing HOME would not override OPENRIG_HOME or DB.
// Keep ordinary user files outside the state root, as in a real installation.
// Otherwise file-transfer correctly rejects every ~/ path as OpenRig state.
// The hc core's socket is resolved from env (HC_SOCKET, XDG_RUNTIME_DIR, then XDG_STATE_HOME or HOME), and a host's default core
// is the one the app shows. That scrub is NOT optional, even for a real-Codex run (security review F8): the opt-in needs a real HOME
// and CODEX_HOME for its auth, not a way to the host's core, and the two real-Codex e2e tests build their own private core's env
// (helpers/hc-scratch.ts: PATH and nothing else from the caller). With HOME real, dropping XDG_RUNTIME_DIR alone would fall to
// the host's `~/.local/state/herdr-core/default`, so the state dir is pointed into the fixture too.
const userHome = `${fixtureHome}-user-home`;
// resolveHcSocket prefers XDG_RUNTIME_DIR (a seat on Linux has /run/user/<uid>) over the state dir set below, which
// would name the host's default core even with HC_* gone. Dropped, the socket path falls to the fixture state dir.
delete process.env["XDG_RUNTIME_DIR"];
process.env["XDG_STATE_HOME"] = path.join(userHome, ".local/state");
// A unix socket path has a hard limit: 103 bytes on macOS (sun_path is 104 with its NUL; hc 0.1.15 refuses a longer one itself, with 107
// allowed on Linux). The fixture home is `<os.tmpdir()>/.openrig-test-fixture-home-XXXXXX-user-home`, and macOS's own os.tmpdir()
// (/var/folders/xx/<32 chars>/T) makes the core's would-be socket under it 139 bytes, so a probe of it fails with `connect EINVAL`
// (unhealthy) instead of finding no core. Where that is so, the state dir moves to a short sibling; it only ever holds the path of
// a core that is never started. Linux's /tmp keeps the layout above.
const HC_SOCKET_PATH_LIMIT = 103;
const fixtureHcSocket = path.join(process.env["XDG_STATE_HOME"], "herdr-core", "default", "default.sock");
if (Buffer.byteLength(fixtureHcSocket) > HC_SOCKET_PATH_LIMIT) {
  const shortState = fs.mkdtempSync(path.join(os.tmpdir(), ".oh-"));
  const registry = process.env["OPENRIG_TEST_FIXTURE_REGISTRY"];
  if (registry) {
    try { fs.writeFileSync(path.join(registry, path.basename(shortState)), shortState); } catch { /* best effort */ }
  }
  afterAll(() => { try { fs.rmSync(shortState, { recursive: true, force: true }); } catch { /* best effort */ } });
  process.env["XDG_STATE_HOME"] = shortState;
}
if (process.env["OPENRIG_E2E_REAL_CODEX"] !== "1") {
  fs.mkdirSync(userHome, { recursive: true });
  process.env["HOME"] = userHome;
  delete process.env["CODEX_HOME"];
  for (const [key, suffix] of Object.entries({
    XDG_CONFIG_HOME: ".config", XDG_DATA_HOME: ".local/share", XDG_CACHE_HOME: ".cache",
  })) process.env[key] = path.join(userHome, suffix);
}

// (2b) Host-independent process basics. A developer Mac and a Linux box differ in exactly
// these, and each difference has failed daemon tests for environmental reasons only:
//   SHELL  — tmux starts its panes in $SHELL. An account whose login shell is zsh with no
//            startup files in the (fixture) HOME gets the zsh-newuser-install wizard, which
//            swallows the first keystroke of a stub runner. Pin a shell with no wizard.
//   umask  — 002 (user-private-group accounts) turns a created 0o755 into 0o775. Pin 022.
//   .hushlogin — Ubuntu's /etc/bash.bashrc prints a sudo hint on STDOUT of every
//            interactive `bash -ic` for a sudo-group user whose HOME lacks .hushlogin.
//   TMPDIR — macOS's os.tmpdir() is /var/folders/..., a symlink to /private/var/folders/...; tests
//            that compare a path they created with one a child process reports (cwd, realpath,
//            git toplevel) see two spellings of one directory. Hand out the real path. A no-op on Linux.
if (process.env["OPENRIG_E2E_REAL_CODEX"] !== "1") {
  try { process.env["TMPDIR"] = fs.realpathSync(os.tmpdir()); } catch { /* keep the inherited value */ }
  if (fs.existsSync("/bin/bash")) process.env["SHELL"] = "/bin/bash";
  try { process.umask(0o022); } catch { /* worker_threads cannot set umask; the forks pool (vitest default) can */ }
  fs.writeFileSync(path.join(`${fixtureHome}-user-home`, ".hushlogin"), "");
}

// (3) ASSERT — capture the resolved home + fail loud if it is not fixture-scoped.
const { OPENRIG_HOME } = await import("../packages/cli/src/openrig-compat.js");
const { assertFixtureScopedHome } = await import("../packages/cli/test/live-daemon-guard.js");
assertFixtureScopedHome(OPENRIG_HOME);

// (4) P37 REQUEST-LAYER GUARD — the universal outbound-request chokepoint. The two
// guards above close the DISCOVERY paths (connection env, state-file home); this closes
// the REQUEST layer, where a hardcoded :7433 literal, a mocked URL getter with an
// un-mocked client, or a production default constant still issues a real request that
// no env-scrub or fixture-home can catch. Fail-closed on any unregistered target; an
// in-process fixture registers its origin (allowFetchTarget) when it binds.
const { installFetchGuard } = await import("../packages/cli/test/fetch-guard.js");
installFetchGuard();
