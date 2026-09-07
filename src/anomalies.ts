#!/usr/bin/env node

import { formatError, formatUsd, loadConfigFromEnv, validateMonthFormat } from "./actual-helpers.ts"
import { findAnomalies, tagAnomalyFindings } from "./budget-tools.ts"
import type { AnomalyFinding, TagResult } from "./budget-tools.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

interface Options {
  categories: string[]
  tag: boolean
  dryRun: boolean
  startMonth: string
  endMonth: string
}

const HELP_PAGE: HelpPage = {
  usage: "./actual budget anomalies -c CATEGORY [-c CATEGORY]... [OPTIONS] START_MONTH [END_MONTH]",
  description:
    "Flags categories whose spending in a month deviates sharply from that category's own trailing " +
    "12-month history, using a robust (median-based) outlier test.",
  sections: [
    {
      label: "Options",
      entries: [
        {
          name: "-c, --category CATEGORY",
          description: "Category or parent category group to check (name or ID). Required, can be used multiple times.",
        },
        {
          name: "-t, --tag",
          description:
            "Prepend a #anomaly-high or #anomaly-low tag to the notes of the transaction(s) identified as " +
            "responsible for each flagged month.",
        },
        {
          name: "-n, --dry-run",
          description: "Report what would be tagged without writing anything. Also enabled by setting DRY_RUN=true.",
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
  const categories: string[] = []
  let tag = false
  let dryRun = process.env.DRY_RUN === "true"
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "-c" || arg === "--category") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) {
        usage("Missing argument for --category")
      }
      categories.push(value)
      i++
    } else if (arg === "-t" || arg === "--tag") {
      tag = true
    } else if (arg === "-n" || arg === "--dry-run") {
      dryRun = true
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${renderHelp(process.stdout, HELP_PAGE)}\n`)
      process.exit(0)
    } else if (arg === "--") {
      positional.push(...argv.slice(i + 1))
      break
    } else if (arg.startsWith("-")) {
      usage(`Unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }

  if (categories.length === 0) {
    usage("At least one -c/--category is required.")
  }
  if (positional.length < 1 || positional.length > 2) {
    usage("Expected one or two months.")
  }

  const startMonth = positional[0] as string
  const endMonth = positional[1] ?? startMonth
  try {
    validateMonthFormat(startMonth)
    validateMonthFormat(endMonth)
  } catch (error) {
    usage(formatError(error))
  }

  return { categories, tag, dryRun, startMonth, endMonth }
}

// Function to format one anomaly line, matching the status-first style of the other tools
function formatAnomalyLine(finding: AnomalyFinding): string {
  const status = (finding.direction === "high" ? "Anomaly (high)" : "Anomaly (low)").padEnd(18)
  const spentCol = formatUsd(finding.spentCents).padEnd(11)
  const typicalCol = formatUsd(finding.typicalCents).padEnd(11)
  return `${status}; month: ${finding.month}; spent = ${spentCol}; typical = ${typicalCol}; name: ${finding.category.name}`
}

// Function to print one tag result line, matching the pre-refactor inline loop's own format
function printTagResult(result: TagResult): void {
  if (result.status === "no-transactions") {
    console.log(`  No transactions found for ${result.categoryName} in ${result.month}; nothing to tag.`)
    return
  }
  const label = result.status === "already-tagged" ? "Already tagged" : result.status === "would-tag" ? "Would tag" : "Tagged"
  console.log(`  ${label.padEnd(17)}; ${result.date}; ${formatUsd(result.amount as number)}; ${result.payee}`)
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const config = loadConfigFromEnv()

  const findings = await findAnomalies(config, { categories: options.categories, startMonth: options.startMonth, endMonth: options.endMonth })
  for (const finding of findings) {
    console.log(formatAnomalyLine(finding))
  }

  if (findings.length === 0) {
    console.log("No anomalies found.")
    return
  }

  if (options.tag) {
    const tagResults = await tagAnomalyFindings(config, findings, options.startMonth, options.dryRun)
    for (const result of tagResults) {
      printTagResult(result)
    }
  }
}

// Piping into head/grep closes stdout early; that is not an error worth a stack trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0)
  }
  throw error
})

main().catch((error: unknown) => {
  process.stderr.write(`${formatError(error)}\n`)
  process.exit(1)
})
