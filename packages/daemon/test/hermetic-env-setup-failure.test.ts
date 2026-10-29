// OF-175: prepareHermeticEnv removes its scaffold root when a setup step fails half-way. The step is made to fail by
// failing the one write that installs the scaffold's tmux wrapper (node:fs is wrapped for this file only); every other
// file-system call is the real one, so the root it made is real and its absence afterwards is measured.
import * as fsModule from "node:fs";
import { describe, expect, it, vi } from "vitest";

const made: string[] = [];
let failWrapperWrite = false;

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof fsModule>();
  const mkdtempSync = (prefix: string): string => {
    const dir = real.mkdtempSync(prefix);
    made.push(dir);
    return dir;
  };
  const writeFileSync = (...args: Parameters<typeof real.writeFileSync>): void => {
    if (failWrapperWrite && String(args[0]).endsWith("/bin/tmux")) throw new Error("the fixture refuses to write the tmux wrapper");
    real.writeFileSync(...args);
  };
  return { ...real, mkdtempSync, writeFileSync };
});

const { prepareHermeticEnv } = await import("./helpers/hermetic-env.js");

describe("prepareHermeticEnv: setup that fails half-way", () => {
  it("removes the root it made and rethrows the step's failure", () => {
    made.length = 0;
    failWrapperWrite = true;
    try {
      expect(() => prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME } })).toThrow(/refuses to write the tmux wrapper/);
    } finally {
      failWrapperWrite = false;
    }
    const roots = made.filter((dir) => /openrig-scenario-/.test(dir));
    expect(roots.length, "positive control: the scaffold root was made").toBe(1);
    expect(fsModule.existsSync(roots[0]!), "and removed again").toBe(false);
  });

  it("control: the same setup without the failure keeps its root until cleanup", () => {
    made.length = 0;
    const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME } });
    try {
      expect(fsModule.existsSync(scaffold.root)).toBe(true);
    } finally {
      scaffold.cleanup();
    }
    expect(fsModule.existsSync(scaffold.root)).toBe(false);
  });
});
