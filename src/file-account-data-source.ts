import { readFile } from "node:fs/promises"

import { parseDollarAmount } from "./actual-helpers.ts"
import type { AccountDataSource } from "./account-data-source.ts"

// Function to derive a stable account id from its own name -- there's no id column in the file
// (see this module's own doc comment on the finalized schema), so this is what every other part
// of the app (config.json's own per-account overrides, withdrawal order, etc.) actually keys on
// for a file-imported account. Lowercased, non-alphanumerics collapsed to single hyphens --
// deterministic and readable, not cryptographically unique. Known v1 tradeoff (see issue #22's own
// resolved design): renaming an account in the file changes its id, which is indistinguishable
// from deleting the old one and creating a new one -- any settings configured for the old name are
// orphaned. Exported so #35 (or a debugging session) can predict/display an id from a name without
// re-deriving the same logic elsewhere.
export function accountIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "account"
}

export interface FileAccountRow {
  name: string
  balance: number
}

// Thrown for anything wrong with the file's own content (not a missing/unreadable file, which
// surfaces as a plain node fs error) -- lets a caller (the future login/file-picker UI, #35)
// show the user a specific reason rather than a generic failure.
export class FileParseError extends Error {}

// Function to split one line on a delimiter, honoring double-quote-quoted fields (a quoted field
// can itself contain the delimiter or an escaped "" for a literal quote) -- the common convention
// real spreadsheet exports (Excel, Google Sheets) already use for a name like `Smith, John's IRA`.
// Not a full RFC4180 implementation (no multi-line quoted fields) -- this app's own strict v1
// schema is two short columns, not arbitrary spreadsheet data.
function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let current = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else if (char === '"' && current === "") {
      inQuotes = true
    } else if (char === delimiter) {
      cells.push(current)
      current = ""
    } else {
      current += char
    }
  }
  cells.push(current)
  return cells
}

// Function to parse a CSV/TSV file's content into account rows, per the strict schema finalized on
// issue #22: exactly two columns, `name` and `balance` (a header row of exactly those two words,
// case-insensitive, is required -- both as a sanity check that this really is the expected format,
// and so a real spreadsheet export naturally round-trips without the user having to strip its own
// header by hand), one data row per account. Balance is parsed the same strict, plain-decimal way
// this app's own CLI input already is (see parseDollarAmount) -- no "$" prefix or thousands
// commas, matching "strict schema" being the explicit v1 design goal on the parent issue.
export function parseAccountRows(content: string, delimiter: "," | "\t"): FileAccountRow[] {
  const lines = content
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) {
    throw new FileParseError("The file is empty.")
  }
  const header = splitDelimited(lines[0] as string, delimiter).map((cell) => cell.trim().toLowerCase())
  if (header.length !== 2 || header[0] !== "name" || header[1] !== "balance") {
    throw new FileParseError(`Expected a header row of "name${delimiter}balance", got "${lines[0]}".`)
  }
  const seenNames = new Set<string>()
  return lines.slice(1).map((line, index) => {
    const rowNumber = index + 2 // 1-indexed, plus the header row
    const cells = splitDelimited(line, delimiter)
    if (cells.length !== 2) {
      throw new FileParseError(`Row ${rowNumber}: expected 2 columns (name, balance), got ${cells.length}: "${line}"`)
    }
    const name = (cells[0] as string).trim()
    const balanceText = (cells[1] as string).trim()
    if (name === "") {
      throw new FileParseError(`Row ${rowNumber}: name is empty.`)
    }
    const balance = parseDollarAmount(balanceText)
    if (balance === null) {
      throw new FileParseError(`Row ${rowNumber}: "${balanceText}" isn't a valid dollar amount for "${name}" (expected a plain decimal like 50000 or 50000.00, no "$" or commas).`)
    }
    const key = name.toLowerCase()
    if (seenNames.has(key)) {
      throw new FileParseError(`Row ${rowNumber}: duplicate account name "${name}" -- names must be unique, since an account's id is derived from its name.`)
    }
    seenNames.add(key)
    return { name, balance }
  })
}

async function readAndParseFile(filePath: string): Promise<FileAccountRow[]> {
  const content = await readFile(filePath, "utf8")
  const delimiter = filePath.toLowerCase().endsWith(".tsv") ? "\t" : ","
  return parseAccountRows(content, delimiter)
}

// The second AccountDataSource implementation (see account-data-source.ts's own doc comment) --
// issue #34. Reads and parses the file once per instance (a fresh instance is constructed per
// request, matching actualAccountDataSource's own per-request lifecycle -- see app-server.ts),
// caching the parsed rows so N accounts' own fetchAccountBalance calls (fired concurrently by
// checkDashboard's Promise.all) don't each re-read and re-parse the same file. No transaction
// ledger exists for a file source, so fetchAccountHistory always returns empty -- a normal, valid
// result per that method's own doc comment, not a limitation this implementation needs to work
// around.
export function fileAccountDataSource(filePath: string): AccountDataSource {
  let rowsPromise: Promise<FileAccountRow[]> | null = null
  const rows = (): Promise<FileAccountRow[]> => {
    rowsPromise ??= readAndParseFile(filePath)
    return rowsPromise
  }

  return {
    async fetchAccounts() {
      return (await rows()).map((row) => ({ id: accountIdFromName(row.name), name: row.name, offbudget: true, closed: false }))
    },

    async fetchAccountBalance(accountId) {
      const row = (await rows()).find((candidate) => accountIdFromName(candidate.name) === accountId)
      if (!row) {
        throw new Error(`No account with id "${accountId}" found in ${filePath}.`)
      }
      return row.balance
    },

    fetchAccountHistory() {
      return Promise.resolve({ historicalAges: [], balancesByAgeAndAccount: new Map() })
    },
  }
}
