import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const inProcessCacheLocks = new Map<string, Promise<unknown>>();
const CACHE_LOCK_STALE_MS = 10_000;
const CACHE_LOCK_TIMEOUT_MS = 2_000;
const CACHE_LOCK_RETRY_MS = 15;

export interface CacheEnvelope<T> {
  fetchedAt: number;
  data: T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CacheLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseLockOwnerPid(raw: string): number | undefined {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed?.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

async function acquireFileLock(lockPath: string, payload: string, options: CacheLockOptions = {}): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const timeoutMs = options.timeoutMs ?? CACHE_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? CACHE_LOCK_STALE_MS;
  const retryMs = options.retryMs ?? CACHE_LOCK_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for cache lock: ${lockPath}`);
      }
      try {
        const [info, raw] = await Promise.all([stat(lockPath), readFile(lockPath, "utf8")]);
        const ownerPid = parseLockOwnerPid(raw);
        // Never steal a lock owned by a live process; only reclaim dead-PID
        // locks (or unreadable/legacy lockfiles older than staleMs).
        const deadOwner = ownerPid !== undefined && !isProcessAlive(ownerPid);
        const staleCorrupt = ownerPid === undefined && Date.now() - info.mtimeMs >= staleMs;
        if (deadOwner || staleCorrupt) {
          await rm(lockPath, { force: true });
        }
      } catch {
        // Lock disappeared or could not be inspected; fall through to bounded retry.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for cache lock: ${lockPath}`);
      }
      await delay(retryMs);
    }
  }
}

async function verifyFileLockOwnership(lockPath: string, payload: string): Promise<void> {
  let current: string;
  try {
    current = await readFile(lockPath, "utf8");
  } catch {
    throw new Error(`Lost cache lock ownership: ${lockPath}`);
  }
  if (current !== payload) {
    throw new Error(`Lost cache lock ownership: ${lockPath}`);
  }
}

async function releaseFileLock(lockPath: string, payload: string): Promise<void> {
  try {
    if (await readFile(lockPath, "utf8") === payload) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // Lock already gone or unreadable.
  }
}

/**
 * Serialize read-modify-write cache updates per cache path across both
 * concurrent callers in this process and separate Pi sessions sharing the file.
 * Passes an `assertLockHeld` fence that throws if ownership was lost externally.
 */
export async function withCacheLock<T>(
  path: string,
  fn: (assertLockHeld: () => Promise<void>) => Promise<T>,
  options?: CacheLockOptions,
): Promise<T> {
  const previous = inProcessCacheLocks.get(path) ?? Promise.resolve();
  let releaseInProcess!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseInProcess = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  inProcessCacheLocks.set(path, tail);
  await previous.catch(() => undefined);

  const lockPath = `${path}.lock`;
  const payload = JSON.stringify({
    pid: process.pid,
    token: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  let acquired = false;
  try {
    await acquireFileLock(lockPath, payload, options);
    acquired = true;
    return await fn(() => verifyFileLockOwnership(lockPath, payload));
  } finally {
    if (acquired) await releaseFileLock(lockPath, payload);
    releaseInProcess();
    if (inProcessCacheLocks.get(path) === tail) {
      inProcessCacheLocks.delete(path);
    }
  }
}

export async function readCache<T>(path: string, parseData: (value: unknown) => T): Promise<CacheEnvelope<T> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.fetchedAt !== "number" || !("data" in parsed)) {
      return undefined;
    }
    return { fetchedAt: parsed.fetchedAt, data: parseData(parsed.data) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function writeCache<T>(path: string, data: T, fetchedAt = Date.now()): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ fetchedAt, data }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
