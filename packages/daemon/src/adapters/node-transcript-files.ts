import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { TranscriptFiles } from "../domain/transcript-files.js";

/** The node filesystem behind the transcript files port (workspaces-o9o.69). Each operation is the node:fs call the
 * transcript store and rotation made before the port existed, with the same options. */
export function nodeTranscriptFiles(): TranscriptFiles {
  return {
    exists: (path) => existsSync(path),
    stat(path) {
      const stat = statSync(path);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    },
    makeFolder: (dir, mode) => { mkdirSync(dir, { recursive: true, mode }); },
    append: (path, text, mode) => appendFileSync(path, text, { encoding: "utf-8", mode }),
    readText: (path) => readFileSync(path, "utf-8"),
    write: (path, text, mode) => writeFileSync(path, text, { mode }),
    rename: (from, to) => renameSync(from, to),
    openRead(path) {
      const fd = openSync(path, "r");
      return {
        size: () => fstatSync(fd).size,
        read: (buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
        close: () => closeSync(fd),
      };
    },
  };
}
