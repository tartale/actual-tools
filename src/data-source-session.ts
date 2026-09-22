import { readFileSync, unlinkSync, writeFileSync } from "node:fs"

// This app's own persisted "which file am I importing accounts from" state -- the file-mode
// counterpart to actual-session.ts's ActualConfig, same "small git-ignored JSON file, missing is
// fine" convention (missing = not in file mode, i.e. the default, Actual-backed path). A SEPARATE
// file from session.json rather than folding a mode flag into it: Actual credentials and a file
// import are independent facts that can both be on file at once (switching from file mode back to
// Actual mode shouldn't force re-entering credentials that are still sitting there valid) -- see
// app-server.ts's currentAccountDataSource, which checks this file FIRST and only falls back to
// the Actual-backed path when it's absent.
//
// Holds the file's own CONTENT, not a path -- issue #34/#35's change-requested redesign
// (2026-09-21): a browser can't hand a picked file's real filesystem path to a page (sandboxed by
// design), so the ORIGINAL design instead had the user type in a server-side path for the app's
// own process to read directly, live, on every request. That meant editing the file on disk (or it
// going missing) silently changed what the app reported, with no explicit action on the user's
// part -- surprising, and hard to reason about. This version uploads the file's actual bytes
// through the browser ONCE, at import time; nothing on disk is read or watched afterward, so
// there's no "changed/missing underneath us" case left to guard against. Importing again (the
// Refresh button re-opens the file picker in file mode, rather than silently re-reading anything --
// see refreshAll in app.js) is what's needed to pick up a real change.

export interface FileDataSourceSession {
  fileName: string
  content: string
  // When this file was imported (POST /api/data-source, which validates it parses before
  // persisting anything) -- a fixed fact from then on, not something later requests can advance,
  // since there's no live re-read left to advance it on. Always a real timestamp once a session
  // exists at all (unlike the old path-based design, there's no partial-write window to guard
  // against: content and lastLoadedAt are written together, in one call, or not at all).
  lastLoadedAt: string
  // An OPTIONAL, separate transactions export (issue #34/#35's follow-up, 2026-09-21) -- a plain
  // name,balance accounts file carries no spend history at all, so checkDashboard's own file-mode
  // path (see its doc comment) falls back to a flat manual number (fire-accounts.ts's
  // fileModeAnnualExpense) unless this is also set, in which case it computes a real trailing-spend
  // figure from these rows instead (see fire-generate.ts's annualSpendFromTransactions). null until
  // imported via POST /api/data-source/transactions (or bundled into the same POST
  // /api/data-source call that sets the accounts file, from the login screen's own combined
  // picker); a logically SEPARATE file from the accounts file above -- Actual's own account-balance
  // export and transaction export are two different files in practice, and this mirrors that. Its
  // own lastLoadedAt (independent of the accounts file's) is what the topbar chip shows -- see
  // refreshDataSourceChip in app.js.
  transactions: { fileName: string; content: string; lastLoadedAt: string } | null
}

export const DEFAULT_DATA_SOURCE_SESSION_PATH = "data-source.json"

// Function to load the persisted file-import session. Missing or malformed is never fatal -- same
// reasoning as loadActualSession -- callers just treat it as "not in file mode".
export function loadFileDataSourceSession(path: string = DEFAULT_DATA_SOURCE_SESSION_PATH): FileDataSourceSession | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { fileName?: unknown }).fileName !== "string" ||
      typeof (parsed as { content?: unknown }).content !== "string" ||
      typeof (parsed as { lastLoadedAt?: unknown }).lastLoadedAt !== "string"
    ) {
      return null
    }
    const rawTransactions = (parsed as { transactions?: unknown }).transactions
    let transactions: { fileName: string; content: string; lastLoadedAt: string } | null = null
    if (rawTransactions !== null && rawTransactions !== undefined) {
      if (
        typeof rawTransactions !== "object" ||
        typeof (rawTransactions as { fileName?: unknown }).fileName !== "string" ||
        typeof (rawTransactions as { content?: unknown }).content !== "string"
      ) {
        return null
      }
      const rawLastLoadedAt = (rawTransactions as { lastLoadedAt?: unknown }).lastLoadedAt
      // Tolerant of a session written before this field existed (2026-09-22) -- falls back to the
      // accounts file's own lastLoadedAt rather than invalidating the whole session over one
      // missing timestamp on a file that's otherwise perfectly valid.
      const lastLoadedAt = typeof rawLastLoadedAt === "string" ? rawLastLoadedAt : (parsed as { lastLoadedAt: string }).lastLoadedAt
      transactions = { fileName: (rawTransactions as { fileName: string }).fileName, content: (rawTransactions as { content: string }).content, lastLoadedAt }
    }
    return { ...(parsed as Omit<FileDataSourceSession, "transactions">), transactions }
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
