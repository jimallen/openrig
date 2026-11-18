import fs from "node:fs";

/** workspaces-o9o.123 (verify-sec2): write a file without following a symbolic link at its final component. O_NOFOLLOW makes the open
 *  fail with ELOOP when the path is a link, so a link swapped in after a caller's lstat check is refused too. A new file is created
 *  0600; an existing regular file keeps its mode. */
export function writeFileNoFollow(path: string, content: string): void {
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, content, "utf-8"); } finally { fs.closeSync(fd); }
}
