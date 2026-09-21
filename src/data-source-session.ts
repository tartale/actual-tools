import { readFileSync, unlinkSync, writeFileSync } from "node:fs"

// This app's own persisted "which file am I importing accounts from" state -- the file-mode
// counterpart to actual-session.ts's ActualConfig, same "small git-ignored JSON file, missing is
// fine" convention (missing = not in file mode, i.e. the default, Actual-backed path). A SEPARATE
// file from session.json rather than folding a mode flag into it: Actual credentials and a file
// import path are independent facts that can both be on file at once (switching from file mode
// back to Actual mode shouldn't force re-entering credentials that are still sitting there valid)
// -- see app-server.ts's currentAccountDataSource, which checks this file FIRST and only falls
// back to the Actual-backed path when it's absent.

export interface FileDataSourceSession {
  filePath: string
  // Set on every successful fetchAccounts() against this file (see app-server.ts's
  // currentAccountDataSource), not just once at connect time -- "the last successful load's own
  // timestamp" per issue #35, which keeps advancing across ordinary use (Refresh, a normal page
  // load), not a one-time "when did I first connect this file" fact. null only for the brief
  // window between a successful POST /api/data-source (which validates the file parses before
  // persisting anything, so this is set immediately in practice) and this type's own bare
  // construction -- kept nullable rather than always-a-string so a malformed/partial write can't
  // silently look like a real timestamp.
  lastLoadedAt: string | null
}

export const DEFAULT_DATA_SOURCE_SESSION_PATH = "data-source.json"

// Function to load the persisted file-import session. Missing or malformed is never fatal -- same
// reasoning as loadActualSession -- callers just treat it as "not in file mode".
export function loadFileDataSourceSession(path: string = DEFAULT_DATA_SOURCE_SESSION_PATH): FileDataSourceSession | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { filePath?: unknown }).filePath !== "string") {
      return null
    }
    const lastLoadedAt = (parsed as { lastLoadedAt?: unknown }).lastLoadedAt
    if (lastLoadedAt !== null && typeof lastLoadedAt !== "string") {
      return null
    }
    return parsed as FileDataSourceSession
  } catch {
    return null
  }
}

export function writeFileDataSourceSession(path: string, session: FileDataSourceSession): void {
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`)
}

// Function to switch back to the Actual-backed path: deletes the persisted file-import session.
// Not-found is fine, same reasoning as clearActualSession.
export function clearFileDataSourceSession(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }
}
