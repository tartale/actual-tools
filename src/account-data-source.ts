import { addMonthsToDate, ageFromBirthDate, fetchAccountTransactions, fetchAllOpenAccounts, sumTransactionAmounts } from "./actual-helpers.ts"
import type { Account, ActualConfig, Transaction } from "./actual-helpers.ts"

// The API has no running-balance field; summing an account's full transaction history since this
// date is the accounting identity a real balance is derived from -- must predate any real
// account's first transaction. Lives here (not fire-generate.ts, where it used to) since it's now
// this file's own Actual-backed implementation detail, not something a caller needs to know.
const BALANCE_SINCE_DATE = "1970-01-01"

// Real (not simulated) point-in-time balances for up to a few years before currentAge, one entry
// per configured age (oldest first) plus each account's own balance at that age -- what the
// Bridge/Monte Carlo charts' lookback window draws before their own forward-looking projection
// starts. Empty is a normal, valid result (a brand-new account, or a data source with no way to
// know past balances at all -- see FileAccountDataSource below), not an error case callers need
// to special-case beyond "nothing to draw."
export interface AccountBalanceHistory {
  historicalAges: number[]
  balancesByAgeAndAccount: Map<number, Map<string, number>>
}

// Function to reduce the Actual-specific fetch functions this app's Retirement flow depends on
// (account list + current balance + historical lookback) to the one shape checkDashboard/
// app-server.ts actually need, so a non-Actual source (a CSV/TSV file -- see issue #22/#34) can
// stand in for it later without either of those callers knowing which one they're talking to.
// Deliberately narrower than everything actual-helpers.ts exposes: Budget's own category/
// transaction needs are far richer than Retirement's (account + balance only) and stay wired
// directly to Actual, out of scope for this abstraction (see issue #33's own resolved scope).
export interface AccountDataSource {
  fetchAccounts(): Promise<Account[]>
  fetchAccountBalance(accountId: string): Promise<number>
  fetchAccountHistory(accountIds: readonly string[], currentAge: number): Promise<AccountBalanceHistory>
}

// The current (and, before this abstraction existed, the ONLY) implementation -- every method
// here reproduces exactly what fire-generate.ts/app-server.ts already did inline, moved rather
// than rewritten, so this refactor changes no behavior for the Actual-backed path (see issue #33's
// own acceptance criterion). A second, file-backed implementation is issue #34, not part of this
// one.
export function actualAccountDataSource(config: ActualConfig): AccountDataSource {
  return {
    fetchAccounts: () => fetchAllOpenAccounts(config),

    async fetchAccountBalance(accountId) {
      const transactions = await fetchAccountTransactions(config, accountId, BALANCE_SINCE_DATE)
      return sumTransactionAmounts(transactions)
    },

    // Moved verbatim from fire-generate.ts's own checkDashboard (see that function's git history
    // for the original doc comments this reproduces): fetches every account's full transaction
    // history once, then derives both "how far back is there real history to show" (bounded by
    // the earliest transaction across ALL given accounts, capped at HISTORY_LOOKBACK_YEARS_MAX so
    // a decades-old account doesn't turn the chart into a full net-worth history) and each
    // account's own balance at each of those past ages (summing transactions up to that age's
    // cutoff date -- the same accounting identity fetchAccountBalance above uses, just filtered).
    async fetchAccountHistory(accountIds, currentAge) {
      const HISTORY_LOOKBACK_YEARS_MAX = 5
      const transactionEntries = await Promise.all(
        accountIds.map(async (accountId): Promise<[string, Transaction[]]> => [accountId, await fetchAccountTransactions(config, accountId, BALANCE_SINCE_DATE)]),
      )
      const transactionsByAccount = new Map(transactionEntries)
      const today = new Date().toISOString().slice(0, 10)
      const allTransactionDates = [...transactionsByAccount.values()].flat().map((transaction) => transaction.date).filter((date) => date <= today)
      const earliestTransactionDate = allTransactionDates.length > 0 ? allTransactionDates.reduce((min, date) => (date < min ? date : min)) : today
      const historyYearsBack = Math.min(HISTORY_LOOKBACK_YEARS_MAX, ageFromBirthDate(earliestTransactionDate))
      const historicalAges = Array.from({ length: historyYearsBack }, (_, index) => currentAge - historyYearsBack + index)
      const balancesByAgeAndAccount = new Map(
        historicalAges.map((age) => {
          const cutoff = addMonthsToDate(today, -12 * (currentAge - age))
          return [
            age,
            new Map(accountIds.map((accountId) => [accountId, sumTransactionAmounts((transactionsByAccount.get(accountId) ?? []).filter((transaction) => transaction.date <= cutoff))])),
          ] as const
        }),
      )
      return { historicalAges, balancesByAgeAndAccount }
    },
  }
}
