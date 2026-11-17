/**
 * The port: the file effects transcript storage needs, in the transcript's own words (workspaces-o9o.69). The domain
 * (TranscriptStore, transcript rotation) decides what to read and write, which modes a transcript gets, and that a
 * rotation replaces a transcript through a temp file and a rename; the adapter (src/adapters/node-transcript-files.ts,
 * wired in startup.ts) does the effects. Modes are the domain's: a transcript is the seat's conversation, so a folder is
 * created 0700 and a file 0600 whatever the umask (workspaces-o9o.36). Text is UTF-8.
 */
export interface TranscriptFiles {
  /** Whether anything exists at this path. */
  exists(path: string): boolean;
  /** Size in bytes and modification time of the file at this path; throws when it cannot be read. */
  stat(path: string): { size: number; mtimeMs: number };
  /** Create this folder and any missing parents; a folder the call creates gets `mode`. */
  makeFolder(dir: string, mode: number): void;
  /** Append text to the file, creating it with `mode` when it does not exist. */
  append(path: string, text: string, mode: number): void;
  /** The whole file as text. */
  readText(path: string): string;
  /** Write text to the file, creating it with `mode` when it does not exist, replacing what it held. */
  write(path: string, text: string, mode: number): void;
  /** Rename `from` over `to`, replacing the name `to` itself. */
  rename(from: string, to: string): void;
  /** Open the file for positioned reads. The reader keeps the file it opened even if the name is replaced. */
  openRead(path: string): TranscriptReader;
}

/** An open transcript: positioned reads of the file it was opened on. Close it when done. */
export interface TranscriptReader {
  /** Size in bytes of the opened file, as of this call. */
  size(): number;
  /** Read up to `length` bytes at file `position` into `buffer` at `offset`; the count read, 0 at end of file. */
  read(buffer: Buffer, offset: number, length: number, position: number): number;
  close(): void;
}
