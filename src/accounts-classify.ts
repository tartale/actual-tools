#!/usr/bin/env node

import { fetchAccountBalance, formatUsd, loadConfigFromEnv } from "./actual-helpers.ts"
import type { ActualConfig } from "./actual-helpers.ts"
import { DEFAULT_FIRE_ACCOUNTS_CONFIG_PATH, loadClassifiedAccounts } from "./fire-accounts.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

// The API has no running-balance field; summing an account's full transaction history is the
// accounting identity used instead (see fetchAccountBalance), so this must reach back further
// than any real account could have existed.
const BALANCE_SINCE_DATE = "1970-01-01"

interface Options {
  configPath: string
}

const HELP_PAGE: HelpPage = {
  usage: "./actual accounts classify [OPTIONS]",
  description:
    "Lists every open account (on- and off-budget) with its computed FIRE classification and " +
    "current balance, so the classification can be checked against reality before it feeds " +
    "anything else (./actual report fire in particular).",
  sections: [
    {
      label: "Options",
      entries: [
        {
          name: "-f, --config PATH",
          description: `Path to the account classification overrides file (default: ${DEFAULT_FIRE_ACCOUNTS_CONFIG_PATH}).`,
        },
        { name: "-h, --help", description: "Show this message and exit." },
      ],
    },
  ],
}

// Function to report a usage error and exit
function usage(message: string): never {
  process.stderr.write(`${message}\n\n${renderHelp(process.stderr, HELP_PAGE)}\n`)
  process.exit(1)
}

// Function to parse and validate command-line arguments
function parseArguments(argv: readonly string[]): Options {
  let configPath = DEFAULT_FIRE_ACCOUNTS_CONFIG_PATH

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "-f" || arg === "--config") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --config")
      }
      configPath = value
      i++
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${renderHelp(process.stdout, HELP_PAGE)}\n`)
      process.exit(0)
    } else {
      usage(`Unknown option: ${arg}`)
    }
  }

  return { configPath }
}

// Function to format one account's status-first classification line, matching this repo's
// existing formatCategoryLine/formatAnomalyLine convention
function formatAccountLine(account: ClassifiedAccount, balanceCents: number): string {
  const status = (account.source === "default" ? "NEEDS REVIEW" : "OK").padEnd(16)
  const categoryLabel = (account.source === "default" ? `${account.category} (default)` : account.category).padEnd(24)
  const taxTreatmentCol = account.taxTreatment.padEnd(12)
  const balanceCol = formatUsd(balanceCents).padStart(14)
  return `${status} ; ${categoryLabel} ; ${taxTreatmentCol}; balance = ${balanceCol}; name: ${account.name}`
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const config: ActualConfig = loadConfigFromEnv()

  const { accounts, configFound } = await loadClassifiedAccounts(config, options.configPath)
  if (!configFound) {
    process.stderr.write(`No ${options.configPath} found; every account is classified by heuristic or default only.\n`)
  }

  const balances = await Promise.all(accounts.map((account) => fetchAccountBalance(config, account.id, BALANCE_SINCE_DATE)))

  let overrideCount = 0
  let heuristicCount = 0
  let defaultCount = 0
  accounts.forEach((account, index) => {
    console.log(formatAccountLine(account, balances[index] as number))
    if (account.source === "override") overrideCount++
    else if (account.source === "heuristic") heuristicCount++
    else defaultCount++
  })

  console.log(
    `${accounts.length} account(s): ${overrideCount} by override, ${heuristicCount} by heuristic, ` +
      `${defaultCount} needing review (defaulted to cash-other) -- edit ${options.configPath} to fix.`,
  )
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
