#!/usr/bin/env node

import { pathToFileURL } from "node:url"

import { formatError } from "./actual-helpers.ts"
import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

// The vendored files this app carries verbatim from third-party open source (see each file's own
// header for the full rationale/license). Drift is expected and fine -- this app never intends to
// stay byte-identical with upstream forever -- but silent, unnoticed drift is not: this is how a
// future session finds out upstream moved, so it can decide whether to re-vendor.
interface VendoredFile {
  localPath: string
  owner: string
  repo: string
  upstreamPath: string
  pinnedCommit: string
  pinnedBlobSha: string
}

const VENDORED_FILES: readonly VendoredFile[] = [
  {
    localPath: "src/vendor/monte-carlo/monte-carlo-engine.ts",
    owner: "actualbudget",
    repo: "actual",
    upstreamPath: "packages/desktop-client/src/components/reports/reports/monte-carlo/monteCarloSimulation.ts",
    pinnedCommit: "353e5dd26aa98503b2e88b9b25004c3ea5eeef7d",
    pinnedBlobSha: "3bbd8d45a64e74316f9b02bac9e2542f6a0fb632",
  },
  {
    localPath: "src/vendor/monte-carlo/monte-carlo-historical-returns.ts",
    owner: "actualbudget",
    repo: "actual",
    upstreamPath: "packages/desktop-client/src/components/reports/reports/monte-carlo/monteCarloHistoricalReturns.ts",
    pinnedCommit: "353e5dd26aa98503b2e88b9b25004c3ea5eeef7d",
    pinnedBlobSha: "05ae5cf7ba81a153ccf1b4cc1a5784a8ee792fba",
  },
]

const HELP_PAGE: HelpPage = {
  usage: "./actual vendor check",
  description:
    "Checks every vendored third-party file against its upstream source on GitHub, by comparing " +
    "git blob hashes -- no content is fetched or diffed, just whether upstream's file at that path " +
    "still matches the exact version this app copied in. Exits 1 if anything has drifted, as a " +
    "prompt to go look -- drift itself is expected and not a problem; see each vendored file's own " +
    "header comment for why it was vendored and what (if anything) was changed from upstream.",
  sections: [
    {
      label: "Options",
      entries: [{ name: "-h, --help", description: "Show this message and exit." }],
    },
  ],
}

interface GithubContentsResponse {
  sha: string
}

// Function to fetch a file's current blob SHA from GitHub's public contents API. Unauthenticated
// (no token needed, no gh CLI dependency -- this repo has zero runtime dependencies) -- fine for
// an occasional manual check of a couple of files, well under the 60/hour anonymous rate limit.
async function currentBlobSha(file: VendoredFile): Promise<string> {
  const url = `https://api.github.com/repos/${file.owner}/${file.repo}/contents/${file.upstreamPath}`
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "actual-tools-vendor-check" },
  })
  if (!res.ok) {
    throw new Error(`GitHub API request failed (${res.status} ${res.statusText}) for ${url}`)
  }
  const body = (await res.json()) as GithubContentsResponse
  return body.sha
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(`${renderHelp(process.stdout, HELP_PAGE)}\n`)
    process.exit(0)
  }
  if (args.length > 0) {
    process.stderr.write(`Unknown option: ${args[0]}\n\n${renderHelp(process.stderr, HELP_PAGE)}\n`)
    process.exit(1)
  }

  let anyNeedsAttention = false
  for (const file of VENDORED_FILES) {
    console.log(`${file.localPath}`)
    console.log(`  vendored from ${file.owner}/${file.repo}@${file.pinnedCommit.slice(0, 12)}`)
    try {
      const liveSha = await currentBlobSha(file)
      if (liveSha === file.pinnedBlobSha) {
        console.log(`  up to date (blob ${liveSha.slice(0, 12)})`)
      } else {
        anyNeedsAttention = true
        console.log(`  DRIFTED -- upstream's current blob is ${liveSha.slice(0, 12)}, pinned copy is ${file.pinnedBlobSha.slice(0, 12)}`)
        console.log(`  history: https://github.com/${file.owner}/${file.repo}/commits/master/${file.upstreamPath}`)
      }
    } catch (error) {
      anyNeedsAttention = true
      console.log(`  could not check: ${formatError(error)}`)
    }
  }

  process.exit(anyNeedsAttention ? 1 : 0)
}

// Only runs when this file is the program being executed, so a test can import currentBlobSha
// above without the CLI running itself on the way in.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${formatError(error)}\n`)
    process.exit(1)
  })
}
