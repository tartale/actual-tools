import { parseDollarAmount } from "./actual-helpers.ts"
import type { AccountDataSource } from "./account-data-source.ts"
import type { Category, CategoryGroup } from "./actual-helpers.ts"

// Function to derive a stable, deterministic, readable (not cryptographically unique) id from a
// real-world name -- lowercased, non-alphanumerics collapsed to single hyphens. Shared by every
// file-mode id this app derives from a name it doesn't control an id for: an account's own name
// (accountIdFromName below), and a transactions file's own Category_Group/Category names (see
// categoryGroupsFromTransactions).
function slugify(name: string, fallback: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : fallback
}

// Function to derive a stable account id from its own name -- there's no id column in the file
// (see this module's own doc comment on the finalized schema), so this is what every other part
// of the app (config.json's own per-account overrides, withdrawal order, etc.) actually keys on
// for a file-imported account. Known v1 tradeoff (see issue #22's own resolved design): renaming an
// account in the file changes its id, which is indistinguishable from deleting the old one and
// creating a new one -- any settings configured for the old name are orphaned. Exported so #35 (or
// a debugging session) can predict/display an id from a name without re-deriving the same logic
// elsewhere.
export function accountIdFromName(name: string): string {
  return slugify(name, "account")
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
// Not a full RFC4180 implementation (no multi-line quoted fields) -- every schema this app actually
// parses (the accounts file's own strict two columns, a transactions export's several) is short,
// single-line rows, not arbitrary spreadsheet data.
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

// Function to quote one CSV/TSV cell the same way parseAccountRows/parseTransactionRows' own
// splitDelimited already reads a quoted cell back -- wraps in double quotes (doubling any internal
// quote) whenever the value contains the delimiter, a quote, or a newline, otherwise left plain.
function escapeDelimitedCell(value: string, delimiter: string): string {
  return value.includes(delimiter) || value.includes('"') || value.includes("\n") || value.includes("\r") ? `"${value.replace(/"/g, '""')}"` : value
}

// Function to append one new account row onto an existing accounts file's raw content -- adding an
// account through the UI (issue #34/#35's follow-up, 2026-09-22) modifies the SAME underlying
// content the file itself holds, so the new account behaves identically to an imported one
// afterward: configurable in Accounts, included in a later CSV export, survives a reload. Plain
// string append (not a re-parse-and-reformat round trip) so the rest of the file -- whatever
// header casing/quoting it already used -- is left exactly as it was. Callers should still re-parse
// the RESULT to confirm it round-trips correctly (the same "prove it works" discipline every other
// file-mode write already follows) -- this function itself doesn't validate anything.
export function appendAccountRow(content: string, delimiter: "," | "\t", name: string, balance: number): string {
  const trimmed = content.replace(/\s+$/, "")
  return `${trimmed}\n${escapeDelimitedCell(name, delimiter)}${delimiter}${(balance / 100).toFixed(2)}\n`
}

export interface FileTransactionRow {
  date: string
  categoryGroup: string
  category: string
  // Cents, signed the same way Actual's own export is -- negative for an outflow/expense,
  // positive for an inflow/refund.
  amount: number
}

const TRANSACTION_REQUIRED_COLUMNS = ["date", "category_group", "category", "amount"] as const

// Function to parse a CSV/TSV transactions file into rows this app can compute spend from --
// issue #34/#35's follow-up (2026-09-21): file mode has no live Actual connection to compute spend
// history from the way checkDashboard's own Actual-backed path does (see
// fire-generate.ts's spendFromLocalSelection), so importing Actual's OWN transaction export lets a
// file-mode plan compute a real trailing-spend figure instead of a flat manual guess (see
// fire-accounts.ts's fileModeAnnualExpense). Matches the real header row Actual's export
// produces -- confirmed against a real export (2026-09-21):
// Account,Date,Payee,Notes,Category_Group,Category,Amount,Split_Amount,Cleared -- but unlike
// parseAccountRows above, this is lenient about which of those columns are actually present, and in
// what order: only Date, Category_Group, Category, and Amount are ever read (looked up BY NAME in
// the header row, case-insensitive), and every other real column (Account, Payee, Notes,
// Split_Amount, Cleared) is simply ignored rather than rejected outright -- the file is still
// expected to be that same real export, just not re-validated column-for-column against fields
// this app has no use for.
export function parseTransactionRows(content: string, delimiter: "," | "\t"): FileTransactionRow[] {
  const lines = content
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) {
    throw new FileParseError("The file is empty.")
  }
  const header = splitDelimited(lines[0] as string, delimiter).map((cell) => cell.trim().toLowerCase())
  const columnIndex = (name: string): number => header.indexOf(name)
  const indexByColumn = Object.fromEntries(TRANSACTION_REQUIRED_COLUMNS.map((name) => [name, columnIndex(name)])) as Record<(typeof TRANSACTION_REQUIRED_COLUMNS)[number], number>
  const missing = TRANSACTION_REQUIRED_COLUMNS.filter((name) => indexByColumn[name] === -1)
  if (missing.length > 0) {
    throw new FileParseError(`Missing required column(s): ${missing.join(", ")}. Expected at least Date, Category_Group, Category, and Amount (Actual's own transaction export) -- got "${lines[0]}".`)
  }
  return lines.slice(1).map((line, index) => {
    const rowNumber = index + 2 // 1-indexed, plus the header row
    const cells = splitDelimited(line, delimiter)
    const date = (cells[indexByColumn.date] ?? "").trim()
    const categoryGroup = (cells[indexByColumn.category_group] ?? "").trim()
    // An empty category is normal in a real export -- an uncategorized transaction, or a transfer
    // between the person's own accounts (Actual leaves those uncategorized rather than treating
    // them as spend) -- confirmed live (2026-09-21) against a real export that hit exactly this.
    // Not an error: kept as "" rather than rejected, same as any other real category name.
    const category = (cells[indexByColumn.category] ?? "").trim()
    const amountText = (cells[indexByColumn.amount] ?? "").trim()
    if (date === "" || Number.isNaN(new Date(date).getTime())) {
      throw new FileParseError(`Row ${rowNumber}: "${date}" isn't a recognizable date.`)
    }
    const amount = parseDollarAmount(amountText)
    if (amount === null) {
      throw new FileParseError(`Row ${rowNumber}: "${amountText}" isn't a valid dollar amount (expected a plain decimal like -50.00, no "$" or commas).`)
    }
    return { date, categoryGroup, category, amount }
  })
}

// Function to derive a stable, per-group-namespaced id for one (Category_Group, Category) pair --
// the file-mode counterpart to accountIdFromName above, and to Actual's own real category ids
// (which this app has no access to without a live connection). Namespaced by group (not just the
// category name alone) so two different groups can each have their own same-named category (e.g.
// "Other" under two different groups) without colliding.
export function categoryIdFromName(categoryGroup: string, category: string): string {
  return slugify(`${categoryGroup} ${category}`, "category")
}

// Function to compute the same trailing cutoff date annualSpendFromTransactions itself uses
// (fire-generate.ts) -- shared here so categoryGroupsFromTransactions below can filter rows the
// identical way, rather than the two drifting apart. "As of" the real current calendar month,
// same "as of right now" meaning every other trailing-window computation in this app already uses.
export function transactionCutoff(historyMonths: number): Date {
  const asOfMonth = new Date().toISOString().slice(0, 7)
  const cutoff = new Date(`${asOfMonth}-01T00:00:00Z`)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - historyMonths)
  return cutoff
}

// Function to build the SAME CategoryGroup[] shape /api/budget/context normally returns from a
// live Actual connection, but derived from a transactions file's own unique (Category_Group,
// Category) pairs instead -- issue #34/#35's follow-up (2026-09-21), so the existing Expense
// Categories picker (app.js's renderExpenseCategoryPicker, and the crossoverExpenseCategoryIds
// selection it drives) works unchanged in file mode too, just fed a different source. Only rows
// within the SAME trailing spend-history window annualSpendFromTransactions itself uses are
// considered (2026-09-21 refinement, requested live: a category with no activity in that window --
// an old one-off trip, a category no longer used -- has nothing to contribute to the projection
// either way, so it shouldn't clutter the picker as a selectable option that looks live but isn't).
// Rows with an empty Category_Group or Category are skipped entirely regardless of the window --
// see parseTransactionRows's own doc comment on why those are normal (transfers, split-transaction
// parent rows), not something someone would ever want listed as a pickable "category." is_income is
// set purely by name match (case-insensitive "income" group) -- there's no live is_income flag the
// way a real Actual category carries one, but this is the same heuristic annualSpendFromTransactions
// itself already uses to exclude income from spend. hidden is always false -- nothing in a flat
// transaction export corresponds to Actual's own hidden-category concept.
export function categoryGroupsFromTransactions(rows: readonly FileTransactionRow[], historyMonths: number): CategoryGroup[] {
  const cutoff = transactionCutoff(historyMonths)
  const groupsByName = new Map<string, Map<string, Category>>()
  for (const row of rows) {
    const groupName = row.categoryGroup
    const categoryName = row.category
    if (groupName === "" || categoryName === "") continue
    const date = new Date(row.date)
    if (Number.isNaN(date.getTime()) || date < cutoff) continue
    const categories = groupsByName.get(groupName) ?? new Map<string, Category>()
    groupsByName.set(groupName, categories)
    if (!categories.has(categoryName)) {
      const groupId = accountIdFromName(groupName) // reused generically -- see slugify above
      categories.set(categoryName, { id: categoryIdFromName(groupName, categoryName), name: categoryName, is_income: groupName.toLowerCase() === "income", hidden: false, group_id: groupId })
    }
  }
  return [...groupsByName.entries()].map(([groupName, categories]) => ({
    id: accountIdFromName(groupName),
    name: groupName,
    is_income: groupName.toLowerCase() === "income",
    hidden: false,
    categories: [...categories.values()],
  }))
}

// The second AccountDataSource implementation (see account-data-source.ts's own doc comment) --
// issue #34. Takes the file's own CONTENT directly (uploaded through the browser, see
// data-source-session.ts), not a path -- issue #34/#35's change-requested redesign (2026-09-21):
// nothing on the server's filesystem is read or watched, so there's no "the remembered file went
// missing/changed underneath us" failure mode to guard against any more. fileName is only used to
// pick the delimiter (".tsv" -- tab; anything else -- comma), same convention the original
// path-based version used. Parsing happens once, eagerly, since content is already in memory (no
// disk I/O to defer/cache the way the old per-request-instance design needed to). No transaction
// ledger exists for a file source, so fetchAccountHistory always returns empty -- a normal, valid
// result per that method's own doc comment, not a limitation this implementation needs to work
// around.
export function fileAccountDataSource(fileName: string, content: string): AccountDataSource {
  const delimiter = fileName.toLowerCase().endsWith(".tsv") ? "\t" : ","
  const rows = parseAccountRows(content, delimiter)

  return {
    fetchAccounts() {
      return Promise.resolve(rows.map((row) => ({ id: accountIdFromName(row.name), name: row.name, offbudget: true, closed: false })))
    },

    fetchAccountBalance(accountId) {
      const row = rows.find((candidate) => accountIdFromName(candidate.name) === accountId)
      if (!row) {
        return Promise.reject(new Error(`No account with id "${accountId}" found in ${fileName}.`))
      }
      return Promise.resolve(row.balance)
    },

    fetchAccountHistory() {
      return Promise.resolve({ historicalAges: [], balancesByAgeAndAccount: new Map() })
    },
  }
}
