import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import path from "node:path";

type LockPayload = {
  pid: number;
  startedAt: string;
  label: string;
};

function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readExistingLock(lockPath: string): LockPayload | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid === "number") {
      return {
        pid: parsed.pid,
        startedAt: String(parsed.startedAt ?? ""),
        label: String(parsed.label ?? "")
      };
    }
  } catch {
    // ignore parse/read errors
  }
  return null;
}

function writeLock(lockPath: string, payload: LockPayload): void {
  const fd = openSync(lockPath, "wx");
  try {
    writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
  } finally {
    closeSync(fd);
  }
}

export function acquireProcessLock(lockPath: string, label: string): () => void {
  const dir = path.dirname(lockPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const payload: LockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    label
  };

  const tryCreate = (): void => {
    try {
      writeLock(lockPath, payload);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        throw err;
      }

      const existing = readExistingLock(lockPath);
      if (existing && !isPidRunning(existing.pid)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore and fail below
        }

        writeLock(lockPath, payload);
        return;
      }

      const pidText = existing?.pid ? ` (pid=${existing.pid})` : "";
      throw new Error(`${label} already running${pidText}. lock=${lockPath}`);
    }
  };

  tryCreate();

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;

    try {
      const existing = readExistingLock(lockPath);
      if (existing?.pid && existing.pid !== process.pid) {
        return;
      }
      unlinkSync(lockPath);
    } catch {
      // ignore cleanup failures
    }
  };
}
