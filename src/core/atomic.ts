import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Atomic write helpers.
 *
 * The contract is: a reader observing the destination path either sees the
 * old content or the fully-written new content, never a partial mix. Achieved
 * via the standard write-tmp-then-rename pattern with an fsync on the body.
 *
 * Caveats:
 *   - The parent directory itself is not fsync'd here. fsync of directories
 *     is needed for crash durability of the rename, but is irrelevant for
 *     readers within the same uptime. Add an explicit `fsyncDir` when crash
 *     durability across power loss matters.
 *   - On Windows, rename across an existing file is atomic via the
 *     POSIX-ish semantics Node exposes, but rename-onto-open-file fails.
 *     We currently target macOS/Linux; Windows support is a v2.x item.
 */

export async function atomicWriteFile(
  filePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );

  const handle = await fsp.open(tmp, "wx", 0o644);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await safeUnlink(tmp);
    throw err;
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const json = JSON.stringify(value, null, 2) + "\n";
  await atomicWriteFile(filePath, json);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const buf = await fsp.readFile(filePath, "utf8");
  return JSON.parse(buf) as T;
}

export async function readJsonFileOrNull<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function safeUnlink(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function hostId(): string {
  return os.hostname();
}
