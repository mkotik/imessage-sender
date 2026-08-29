import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";

/**
 * Write `data` to `path` atomically: temp file in the same directory → fsync → rename.
 * Readers always observe either the previous complete file or the new complete file.
 */
export function atomicWriteFileSync(path: string, data: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
