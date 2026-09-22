import type { AccountDataSource } from "./account-data-source.ts"

// Manual mode's own AccountDataSource (issue #38, phase 1) -- there's no external system to fetch
// from at all here, unlike Actual (a live API) or file mode (an uploaded file's own content). Every
// account is entered directly by hand, in the request itself, so this just wraps that list as-is;
// no id-derivation scheme needed (accountIdFromName's own job in file-account-data-source.ts)
// since the client already assigns each row its own id when adding it.
//
// No trailing spend history exists for a made-up account either -- fetchAccountHistory always
// returns empty, the same "nothing to report" shape fileAccountDataSource's own version returns.
export interface ManualAccount {
  id: string
  name: string
  balance: number
}

export function manualAccountDataSource(accounts: readonly ManualAccount[]): AccountDataSource {
  return {
    fetchAccounts() {
      return Promise.resolve(accounts.map((account) => ({ id: account.id, name: account.name, offbudget: true, closed: false })))
    },

    fetchAccountBalance(accountId) {
      const account = accounts.find((candidate) => candidate.id === accountId)
      if (!account) {
        return Promise.reject(new Error(`No account with id "${accountId}" in this manual entry session.`))
      }
      return Promise.resolve(account.balance)
    },

    fetchAccountHistory() {
      return Promise.resolve({ historicalAges: [], balancesByAgeAndAccount: new Map() })
    },
  }
}
