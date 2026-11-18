import fs from "node:fs";

/** workspaces-o9o.123 (verify-sec2): write a file without following a symbolic OR a hard link at its final component.
 *  - O_NOFOLLOW makes the open fail with ELOOP when the path is a symbolic link, so a link swapped in after a caller's lstat check is
 *    refused too.
 *  - The open does NOT truncate (round 2, F2): O_TRUNC would destroy the target before it could be checked. After opening, the fd is
 *    fstat'd and refused unless it is a REGULAR file with exactly one hard link (nlink === 1) — so a hard link to another file, a FIFO,
 *    or a device is refused, not written through. Only then is it truncated and written.
 *  A new file is created 0600; an existing regular file keeps its mode. */
export function writeFileNoFollow(path: string, content: string): void {
  // O_NONBLOCK so opening a FIFO with no reader returns at once (ENXIO) instead of blocking the daemon; a no-op for a regular file.
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file, so it was not written; OpenRig never writes through a link or a special file`);
    if (st.nlink > 1) throw new Error(`${path} has more than one hard link (nlink=${st.nlink}), so it was not written; OpenRig never writes through a hard link`);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, "utf-8");
  } finally { fs.closeSync(fd); }
}
