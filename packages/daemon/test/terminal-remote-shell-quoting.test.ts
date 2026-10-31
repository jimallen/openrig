import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { composeView } from "../src/domain/terminal/view-composer.js";

/** The hc terminal name of a seat, restated here (`s-` + the first 24 hex digits of sha-256 of the canonical name) so the pin does not import the recipe it pins. */
const hcName = (seat: string): string => `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;


// The composed pane command is a shell string. Run it through a real /bin/sh with a stand-in `hc` that records its argv,
// so quoting is proved by the shell and not by a string compare. No hc core, machine link or terminal provider is claimed.
it("keeps terminal names intact through the shell, locally and through an hc machine", () => {
  const root = mkdtempSync(join(tmpdir(), "openrig-attach-shell-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "hc"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$OPR_ARGS"\n', { mode: 0o700 });
  const argsFile = join(root, "args");
  try {
    for (const session of ["seat-normal", "seat space", "seat'quote", "-dash", "a;b"]) {
      for (const host of [null, "edge"]) {
        for (const readOnly of [false, true]) {
          const view = composeView("fixture", [{
            seat: session, label: session, tmuxSession: session, host, readOnly, alive: true,
          }], { resolveHost: () => ({ id: "edge", transport: "ssh", target: "fixture" }) });
          execFileSync("/bin/sh", ["-c", view.opened[0]!.paneCommand], {
            env: { PATH: `${bin}:/usr/bin:/bin`, OPR_ARGS: argsFile },
          });
          expect(readFileSync(argsFile, "utf8").trimEnd().split("\n")).toEqual([
            "attach", ...(readOnly ? ["--observe"] : []), "--", host ? `${host}/${hcName(session)}` : hcName(session),
          ]);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
