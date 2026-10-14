import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// `rig send --file -` reads the message from stdin. send.test.ts pins everything downstream of that read
// through the `readStdin` seam, which by construction bypasses two pieces of production code:
//   - the real-terminal guard (`--file -` while stdin is a TTY must refuse, not block on the keyboard), and
//   - the real stdin read loop (chunk collection + strict UTF-8 decode).
// These tests run the real command in a CHILD PROCESS with no seam (helpers/send-file-driver.ts), against a
// stub daemon on an ephemeral port. A pipe gives a real non-TTY fd 0; a pseudo-terminal (python3's pty
// module, present on macOS and on ordinary Linux CI) gives a real TTY fd 0.

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = path.join(cliRoot, "test", "helpers", "send-file-driver.ts");
const hasPython = spawnSync("python3", ["-I", "-c", "import pty"], { stdio: "ignore" }).status === 0;

// Run `argv` with a pseudo-terminal as its stdin. stdout/stderr stay ordinary pipes so they can be read.
const PTY_WRAPPER = [
  "import pty, subprocess, sys",
  "master, slave = pty.openpty()",
  "sys.exit(subprocess.run(sys.argv[1:], stdin=slave, timeout=25).returncode)",
].join("\n");

interface Outcome { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function run(command: string, args: string[], env: NodeJS.ProcessEnv, feed?: (stdin: NodeJS.WritableStream) => Promise<void>): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: cliRoot, env, stdio: [feed ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false; let started = false;
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (!started && stdout.includes("DRIVER-READY")) {
        started = true;
        if (feed) void feed(child.stdin!).catch(() => {});
      }
    });
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    // A command that blocks reading the terminal never exits on its own: that hang is the failure to detect.
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

describe("rig send --file - in a real child process (no readStdin seam)", () => {
  let server: http.Server;
  let port: number;
  let requests: Array<{ url: string; body: string }> = [];
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    requests = [];
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
      req.on("end", () => {
        requests.push({ url: decodeURIComponent(req.url ?? ""), body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionName: "dev-impl@my-rig" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    env = { ...process.env, SEND_DRIVER_PORT: String(port), OPENRIG_SESSION_NAME: "sender@my-rig", FORCE_COLOR: "0" };
    for (const k of ["OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT"]) delete env[k];
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  const sends = () => requests.filter((r) => r.url === "/api/transport/send").map((r) => JSON.parse(r.body) as { text: string });
  const node = (...a: string[]) => ["--import", "tsx", ...a];

  it("reads every chunk of a piped stdin: text delivered byte for byte, shell syntax and trailing newline intact", async () => {
    const text = "line one\n$(echo PWNED)\n`echo PWNED`\n---\nlast line\n";
    const out = await run(process.execPath, node(driver), env, async (stdin) => {
      // Several writes with pauses force several 'data' chunks; a loop that kept only the first or last
      // chunk, or stopped at the first pause, would deliver a different text.
      for (const part of [text.slice(0, 10), text.slice(10, 30), text.slice(30)]) {
        stdin.write(part);
        await new Promise((r) => setTimeout(r, 60));
      }
      stdin.end();
    });
    expect(out.timedOut, out.stderr).toBe(false);
    expect(out.code, out.stderr).toBe(0);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.text).toBe(text);
  });

  it("decodes the WHOLE input as UTF-8: a multi-byte character split across two chunks survives", async () => {
    const text = "naïve — 日本語 ✓\n";
    const bytes = Buffer.from(text, "utf8");
    const cut = bytes.indexOf(Buffer.from("日", "utf8")) + 1; // one byte into a 3-byte character
    const out = await run(process.execPath, node(driver), env, async (stdin) => {
      stdin.write(bytes.subarray(0, cut));
      await new Promise((r) => setTimeout(r, 100));
      stdin.write(bytes.subarray(cut));
      stdin.end();
    });
    expect(out.code, out.stderr).toBe(0);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.text).toBe(text);
  });

  it("invalid UTF-8 on stdin is an error and nothing is sent", async () => {
    const out = await run(process.execPath, node(driver), env, async (stdin) => {
      stdin.end(Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]));
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("Cannot read message from stdin");
    expect(requests).toHaveLength(0);
  });

  it("an empty stdin is an error and nothing is sent", async () => {
    const out = await run(process.execPath, node(driver), env, async (stdin) => { stdin.end(); });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("empty or whitespace-only; nothing was sent");
    expect(requests).toHaveLength(0);
  });

  describe.skipIf(!hasPython)("with a real pseudo-terminal as stdin", () => {
    const viaPty = (...a: string[]) => ["-I", "-c", PTY_WRAPPER, process.execPath, ...a];

    it("CONTROL: the harness really presents a TTY (process.stdin.isTTY is true in the child)", async () => {
      const out = await run("python3", viaPty("-e", "process.stdout.write(String(process.stdin.isTTY))"), env);
      expect(out.stdout).toBe("true");
    });

    it("--file - on a terminal refuses with the heredoc hint instead of waiting on the keyboard; nothing is sent", async () => {
      const out = await run("python3", viaPty(...node(driver)), env);
      expect(out.timedOut, "the command blocked reading the terminal instead of refusing").toBe(false);
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("Cannot read message from stdin: stdin is a terminal");
      expect(out.stderr).toContain("<<'EOF'");
      expect(requests).toHaveLength(0);
    });
  });
});
