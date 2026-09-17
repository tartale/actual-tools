import { readFileSync, unlinkSync, writeFileSync } from "node:fs"

import type { ActualConfig } from "./actual-helpers.ts"

// The companion app's own persisted Actual REST credentials -- entered once through its login
// form (see /api/session in app-server.ts) instead of the AB_BASE_URL/AB_BUDGET_ID/AB_API_KEY
// environment variables the other CLI tools in this repo still require via loadConfigFromEnv.
// Same "small git-ignored JSON file, missing is fine" convention as config.json (fire-accounts.ts)
// -- not encrypted, matching this app's existing "no authentication at all" security posture (see
// RunningServer's own doc comment in app-server.ts): anyone who can reach the app can already read
// every account and edit config.json, so a plaintext credentials file adds no new exposure.

export const DEFAULT_SESSION_PATH = "session.json"

// Function to load persisted Actual REST credentials. Missing or malformed is never fatal -- same
// reasoning as loadFederalPovertyGuidelines -- callers just treat it as "not logged in yet".
export function loadActualSession(path: string = DEFAULT_SESSION_PATH): ActualConfig | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { baseUrl?: unknown }).baseUrl !== "string" ||
      typeof (parsed as { budgetId?: unknown }).budgetId !== "string" ||
      typeof (parsed as { apiKey?: unknown }).apiKey !== "string"
    ) {
      return null
    }
    return parsed as ActualConfig
  } catch {
    return null
  }
}

export function writeActualSession(path: string, config: ActualConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
}

// Function to log out: deletes the persisted credentials file. Not-found is fine -- logging out
// twice (or before ever logging in) isn't an error.
export function clearActualSession(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }
}
