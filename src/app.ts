#!/usr/bin/env node

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { formatError, loadConfigFromEnv } from "./actual-helpers.ts"
import { DEFAULT_CONFIG_PATH } from "./fire-accounts.ts"
import { DEFAULT_IRS_LIMITS_PATH } from "./irs-limits.ts"
import { DEFAULT_FEDERAL_TAX_BRACKETS_PATH } from "./federal-tax-brackets.ts"
import { DEFAULT_IRS_LIFE_EXPECTANCY_PATH } from "./irs-life-expectancy.ts"
import { DEFAULT_FEDERAL_POVERTY_GUIDELINES_PATH } from "./federal-poverty-guidelines.ts"
import { startAppServer } from "./app-server.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

// Thin CLI bootstrap for the companion app: parses a handful of flags, starts the local server,
// and (best-effort) opens it in a browser. Everything the app actually does lives in
// app-server.ts's routes and fire-generate.ts/fire-accounts.ts's pure logic -- this file has no
// business logic of its own, matching the "thin CLI, tested logic elsewhere" split every other
// executable in this repo already uses.

// A fixed default, not an OS-assigned ephemeral one -- the page's own hot-reload (see
// app-server.ts's buildId) has a browser tab poll this same server across a restart, which only
// works if the restart lands on the same port. `./actual`'s dispatcher runs this under `node
// --watch` precisely so a source edit restarts the server automatically; an ephemeral port would
// silently break that combination (the tab would keep polling a now-dead port forever). Pass
// `-p 0` to opt back into the old OS-assigned behavior if you'd rather have that.
const DEFAULT_PORT = 4247
const uiDir = join(dirname(fileURLToPath(import.meta.url)), "app-ui")

interface Options {
  configPath: string
  irsLimitsPath: string
  federalTaxBracketsPath: string
  irsLifeExpectancyPath: string
  federalPovertyGuidelinesPath: string
  port: number
  open: boolean
}

const HELP_PAGE: HelpPage = {
  usage: "./actual app [OPTIONS]",
  description:
    "Launches the local companion app: a web page for configuring retirement/FIRE accounts and " +
    "assumptions, and checking them against a Bridge/Monte Carlo analysis. More sections (bulk " +
    "budget edits, spending analysis) are planned; this is the first.",
  sections: [
    {
      label: "Options",
      entries: [
        { name: "-f, --config PATH", description: `Path to the config file to read from and write (default: ${DEFAULT_CONFIG_PATH}).` },
        {
          name: "-i, --irs-limits PATH",
          description: `Path to the IRS contribution limits reference file (default: ${DEFAULT_IRS_LIMITS_PATH}). Missing is fine, just skips that context.`,
        },
        {
          name: "-b, --tax-brackets PATH",
          description: `Path to the federal tax bracket reference file (default: ${DEFAULT_FEDERAL_TAX_BRACKETS_PATH}). Missing is fine, just skips the MAGI/effective-rate estimate.`,
        },
        {
          name: "-l, --life-expectancy PATH",
          description: `Path to the IRS Single Life Expectancy reference file (default: ${DEFAULT_IRS_LIFE_EXPECTANCY_PATH}). Missing is fine, just skips the 72(t) SEPP amount calculators.`,
        },
        {
          name: "-g, --poverty-guidelines PATH",
          description: `Path to the federal poverty guidelines reference file (default: ${DEFAULT_FEDERAL_POVERTY_GUIDELINES_PATH}). Missing is fine, just skips the MAGI finding's %FPL/ACA-subsidy line.`,
        },
        { name: "-p, --port N", description: `Run on this port (default: ${DEFAULT_PORT}). Pass 0 for an OS-assigned ephemeral port instead -- note this breaks the page's hot-reload across a restart, since it won't land back on the same port.` },
        { name: "--no-open", description: "Don't try to open the page in a browser automatically -- just print the URL." },
        { name: "-h, --help", description: "Show this message and exit." },
      ],
    },
  ],
}

function usage(message: string): never {
  process.stderr.write(`${message}\n\n${renderHelp(process.stderr, HELP_PAGE)}\n`)
  process.exit(1)
}

function parseArguments(argv: readonly string[]): Options {
  let configPath = DEFAULT_CONFIG_PATH
  let irsLimitsPath = DEFAULT_IRS_LIMITS_PATH
  let federalTaxBracketsPath = DEFAULT_FEDERAL_TAX_BRACKETS_PATH
  let irsLifeExpectancyPath = DEFAULT_IRS_LIFE_EXPECTANCY_PATH
  let federalPovertyGuidelinesPath = DEFAULT_FEDERAL_POVERTY_GUIDELINES_PATH
  let port = DEFAULT_PORT
  let open = true

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "-f" || arg === "--config") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) usage("Missing argument for --config")
      configPath = value
      i++
    } else if (arg === "-i" || arg === "--irs-limits") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) usage("Missing argument for --irs-limits")
      irsLimitsPath = value
      i++
    } else if (arg === "-b" || arg === "--tax-brackets") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) usage("Missing argument for --tax-brackets")
      federalTaxBracketsPath = value
      i++
    } else if (arg === "-l" || arg === "--life-expectancy") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) usage("Missing argument for --life-expectancy")
      irsLifeExpectancyPath = value
      i++
    } else if (arg === "-g" || arg === "--poverty-guidelines") {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("-")) usage("Missing argument for --poverty-guidelines")
      federalPovertyGuidelinesPath = value
      i++
    } else if (arg === "-p" || arg === "--port") {
      const value = argv[i + 1]
      const parsed = value === undefined ? NaN : Number(value)
      if (!Number.isInteger(parsed) || parsed < 0) usage("Missing or invalid argument for --port")
      port = parsed
      i++
    } else if (arg === "--no-open") {
      open = false
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${renderHelp(process.stdout, HELP_PAGE)}\n`)
      process.exit(0)
    } else {
      usage(`Unknown option: ${arg}`)
    }
  }

  return { configPath, irsLimitsPath, federalTaxBracketsPath, irsLifeExpectancyPath, federalPovertyGuidelinesPath, port, open }
}

// Function to best-effort open a URL in the default browser. Swallowed non-fatally: this is a
// convenience for a local machine, not something to fail the whole command over -- a headless or
// remote environment (this repo is regularly run inside one) simply has nothing to open, and the
// printed URL is the real, required fallback.
function tryOpenBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" })
    child.on("error", () => {})
    child.unref()
  } catch {
    // No browser to open here -- fine, the URL is already printed.
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const actualConfig = loadConfigFromEnv()

  const server = await startAppServer({
    actualConfig,
    configPath: options.configPath,
    irsLimitsPath: options.irsLimitsPath,
    federalTaxBracketsPath: options.federalTaxBracketsPath,
    irsLifeExpectancyPath: options.irsLifeExpectancyPath,
    federalPovertyGuidelinesPath: options.federalPovertyGuidelinesPath,
    uiDir,
    port: options.port,
  })

  console.log(`Runway is running at ${server.url}`)
  if (server.networkUrls.length > 0) {
    console.log("Also reachable from another device on your network at:")
    for (const networkUrl of server.networkUrls) {
      console.log(`  ${networkUrl}`)
    }
    console.log("(no login is required -- only share these on a network you trust)")
  }
  console.log("Press Ctrl+C to stop.")
  if (options.open) {
    tryOpenBrowser(server.url)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${formatError(error)}\n`)
  process.exit(1)
})
