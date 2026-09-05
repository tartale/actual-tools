#!/usr/bin/env node

import {
  addDays,
  addTagToNotes,
  fetchAccountTransactions,
  fetchOnBudgetAccounts,
  findMatchingTransaction,
  formatUsd,
  loadConfigFromEnv,
  patchTransactionNotes,
  validateDateFormat,
} from "./actual-helpers.ts"
import type { ActualConfig, Transaction } from "./actual-helpers.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

const TAG = "#cleared"
const MATCH_WINDOW_DAYS = 5

interface Options {
  sinceDate: string
  dryRun: boolean
}

const HELP_PAGE: HelpPage = {
  usage: "./actual transactions match-uncleared [OPTIONS]",
  description:
    "An imported bank transaction sometimes appears twice: once as a pending, uncleared row, then " +
    "again as a separate cleared row once it posts, instead of the same row being updated in place. " +
    "This finds those pairs -- same account, a similar payee and amount, within 5 days -- and tags " +
    "the uncleared row with #cleared so it reads as already accounted for.",
  sections: [
    {
      label: "Options",
      entries: [
        { name: "-s, --since YYYY-MM-DD", description: "Fetch transactions on or after this date (default: 14 days ago)." },
        { name: "-n, --dry-run", description: "Report what would be tagged without writing anything. Also enabled by setting DRY_RUN=true." },
        { name: "-h, --help", description: "Show this message and exit." },
      ],
    },
    {
      label: "Environment variables required",
      entries: [
        { name: "AB_BASE_URL", description: "e.g. https://actualbudget.example.com/v1" },
        { name: "AB_BUDGET_ID", description: "UUID of the budget" },
        { name: "AB_API_KEY", description: "API key for authentication" },
      ],
    },
  ],
}

// Function to report a usage error and exit
function usage(message: string): never {
  process.stderr.write(`${message}\n\n${renderHelp(process.stderr, HELP_PAGE)}\n`)
  process.exit(1)
}

// Function to compute the default --since date: 14 days before today
function defaultSinceDate(): string {
  const today = new Date().toISOString().slice(0, 10)
  return addDays(today, -14)
}

// Function to parse and validate command-line arguments
function parseArguments(argv: readonly string[]): Options {
  let sinceDate: string | null = null
  let dryRun = process.env.DRY_RUN === "true"

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "-s" || arg === "--since") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --since")
      }
      try {
        validateDateFormat(value)
      } catch (error) {
        usage(error instanceof Error ? error.message : String(error))
      }
      sinceDate = value
      i++
    } else if (arg === "-n" || arg === "--dry-run") {
      dryRun = true
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${renderHelp(process.stdout, HELP_PAGE)}\n`)
      process.exit(0)
    } else if (arg.startsWith("-")) {
      usage(`Unknown option: ${arg}`)
    } else {
      usage(`Unexpected argument: ${arg}`)
    }
  }

  return { sinceDate: sinceDate ?? defaultSinceDate(), dryRun }
}

// Function to format a matched pair for the console, mirroring the original bash script's layout
function formatMatchLine(unclearedTx: Transaction, clearedTx: Transaction): string {
  const unclearedPayee = (unclearedTx.imported_payee ?? "").padEnd(40)
  const clearedPayee = (clearedTx.imported_payee ?? "").padEnd(40)
  return [
    `Matched ${TAG}:`,
    `  uncleared: ${unclearedTx.date} | ${unclearedPayee} | amount: ${formatUsd(unclearedTx.amount)}`,
    `  cleared:   ${clearedTx.date} | ${clearedPayee} | amount: ${formatUsd(clearedTx.amount)}`,
  ].join("\n")
}

// Function to fetch every non-tombstoned transaction, across every on-budget account, since a date
async function fetchAllTransactions(config: ActualConfig, sinceDate: string): Promise<Transaction[]> {
  const accounts = await fetchOnBudgetAccounts(config)
  console.log(`Found ${accounts.length} on-budget account(s). Fetching transactions since ${sinceDate}...`)

  const transactionsByAccount: Transaction[][] = []
  for (const account of accounts) {
    console.error(`Fetching transactions for account: ${account.name}`)
    transactionsByAccount.push(await fetchAccountTransactions(config, account.id, sinceDate))
  }
  return transactionsByAccount.flat().filter((transaction) => !transaction.tombstone)
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const config = loadConfigFromEnv()

  console.log("Fetching on-budget accounts...")
  const allTransactions = await fetchAllTransactions(config, options.sinceDate)
  console.log(`Collected ${allTransactions.length} transaction(s) total.`)

  const isUntagged = (transaction: Transaction) => !(transaction.notes ?? "").startsWith(TAG)
  const uncleared = allTransactions.filter((transaction) => !transaction.cleared && isUntagged(transaction))
  let clearedCandidates = allTransactions.filter((transaction) => transaction.cleared && isUntagged(transaction))
  console.log(`Found ${uncleared.length} uncleared transaction(s) to check.`)

  let matchedCount = 0
  for (const transaction of uncleared) {
    const maxDate = addDays(transaction.date, MATCH_WINDOW_DAYS)
    const match = findMatchingTransaction(transaction, clearedCandidates, maxDate)
    if (!match) {
      continue
    }

    console.log(formatMatchLine(transaction, match))

    if (options.dryRun) {
      console.log("  Would tag the uncleared transaction with #cleared.")
    } else {
      try {
        await patchTransactionNotes(config, transaction.id, addTagToNotes(transaction.notes, TAG))
      } catch (error) {
        console.error(`Warning: failed to tag uncleared transaction ${transaction.id}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
    }

    // Only the uncleared side is tagged -- the cleared transaction is just consulted to confirm a
    // match, not itself modified. Still drop it from further consideration so a later uncleared
    // transaction in this same run doesn't also claim it.
    clearedCandidates = clearedCandidates.filter((candidate) => candidate.id !== match.id)
    matchedCount++
  }

  console.log(`Tagged ${matchedCount} matched pair(s).`)
}

// Piping into head/grep closes stdout early; that is not an error worth a stack trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0)
  }
  throw error
})

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
