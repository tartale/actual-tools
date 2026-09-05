#!/usr/bin/env node

import { fetchAccountBalance, fetchAllOpenAccounts, formatUsd, loadConfigFromEnv, openTtyInterface, promptChoice } from "./actual-helpers.ts"
import type { Account, ActualConfig, TtyInterface } from "./actual-helpers.ts"
import {
  DEFAULT_ACCOUNTS_CONFIG_PATH,
  FIRE_ACCOUNT_CATEGORIES,
  classifyByHeuristic,
  findOverride,
  loadFireAccountsConfig,
  traitsForCategory,
  writeFireAccountsConfig,
} from "./fire-accounts.ts"
import type { FireAccountOverride, FireAccountsConfig } from "./fire-accounts.ts"
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
    "Interactively classifies every open account (on- and off-budget) for FIRE reporting -- " +
    "retirement, taxable investment, HSA, debt, cash, or other -- and writes the result to the " +
    "accounts config file. An existing entry, or an inferred guess from the account's name, is " +
    "offered as the default for each account; accounts with no inferred guess must be classified " +
    "explicitly. Feeds ./actual reports fire.",
  sections: [
    {
      label: "Options",
      entries: [
        {
          name: "-f, --config PATH",
          description: `Path to the account classification file to read defaults from and write (default: ${DEFAULT_ACCOUNTS_CONFIG_PATH}).`,
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
  let configPath = DEFAULT_ACCOUNTS_CONFIG_PATH

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

// Function to interactively classify one account: shows its name and balance, offers an existing
// override or an inferred heuristic guess as the default (in that order of preference), and
// forces an explicit choice when neither is available.
async function classifyOneAccount(
  tty: TtyInterface,
  account: Account,
  balanceCents: number,
  existingConfig: FireAccountsConfig,
): Promise<FireAccountOverride> {
  const override = findOverride(account, existingConfig)
  const heuristic = classifyByHeuristic(account.name)
  const defaultCategory = override?.category ?? heuristic?.category ?? null
  const defaultIndex = defaultCategory === null ? null : FIRE_ACCOUNT_CATEGORIES.indexOf(defaultCategory)

  process.stderr.write(`\n${account.name} -- current balance ${formatUsd(balanceCents)}\n`)
  const chosenIndex = await promptChoice(tty, "What kind of account is this?", FIRE_ACCOUNT_CATEGORIES, defaultIndex)
  const category = FIRE_ACCOUNT_CATEGORIES[chosenIndex] as (typeof FIRE_ACCOUNT_CATEGORIES)[number]
  const traits = traitsForCategory(category)

  return { match: account.id, category: traits.category, taxTreatment: traits.taxTreatment, accessAge: traits.accessAge }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const config: ActualConfig = loadConfigFromEnv()

  const accounts = await fetchAllOpenAccounts(config)
  const { config: existingConfig } = loadFireAccountsConfig(options.configPath)
  const balances = await Promise.all(accounts.map((account) => fetchAccountBalance(config, account.id, BALANCE_SINCE_DATE)))

  const tty = openTtyInterface()
  const overrides: FireAccountOverride[] = []
  try {
    for (const [index, account] of accounts.entries()) {
      overrides.push(await classifyOneAccount(tty, account, balances[index] as number, existingConfig))
    }
  } finally {
    tty.close()
  }

  writeFireAccountsConfig(options.configPath, { version: 1, accounts: overrides })
  console.log(`\nWrote ${overrides.length} account(s) to ${options.configPath}.`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
