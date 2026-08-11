// Test-only helper: redirect DATA_DIR to an isolated temp dir BEFORE any
// backend module (which opens the SQLite DB at import time) is evaluated. This
// file is imported first by registryCatalog.test.ts so the import order
// guarantees the env var is set before db/index.js reads it.
import os from "os";
import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";

const dir = path.join(os.tmpdir(), `mfv2-data-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;

/** Whether the system `tar` binary exists (installPlugin relies on it). */
export function hasTar(): boolean {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const TMP_DATA_DIR = dir;
