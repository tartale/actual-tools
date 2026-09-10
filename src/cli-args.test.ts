import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { parseArguments as parseSetBudget } from "./set-budget.ts"
import { parseArguments as parseAnomalies } from "./anomalies.ts"
import { parseArguments as parseMatchUncleared } from "./match-uncleared.ts"

// Argument parsing for the three CLIs. Everything these files do downstream is already covered
// (budget-tools.test.ts, actual-helpers.test.ts); what was not covered at all is the layer between
// what someone types and those functions -- which flags are accepted, what a bad one does, and what
// the process exits with. That layer decides, among other things, whether a run writes or not.
//
// Importing these modules does not run them: each guards its own main() on being the program node
// was actually pointed at.

// parseArguments reports bad input by writing usage to stderr and exiting, so a test has to stand
// in for both. process.exit is typed as returning never, and the code after a usage() call really
// is unreachable, so the double stands in by throwing.
class ProcessExit extends Error {
  // A plain field, assigned in the body: a constructor parameter property emits runtime code, which
  // erasableSyntaxOnly (see tsconfig.json) rules out for a repo that runs its TypeScript directly.
  readonly code: number | undefined
  constructor(code: number | undefined) {
    super(`process.exit(${code})`)
    this.code = code
  }
}

let stderr: string[]
let stdout: string[]

beforeEach(() => {
  stderr = []
  stdout = []
  vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new ProcessExit(typeof code === "number" ? code : undefined)
  })
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DRY_RUN
})

// Runs a parser expected to bail out, returning what it exited with and said.
function bailout(parse: () => unknown): { code: number | undefined; message: string } {
  try {
    parse()
  } catch (error) {
    if (error instanceof ProcessExit) {
      return { code: error.code, message: stderr.join("") }
    }
    throw error
  }
  throw new Error("expected the parser to exit, but it returned normally")
}

describe("set-values arguments", () => {
  it("takes an action and a single month, defaulting the end month to it", () => {
    expect(parseSetBudget(["balance", "2026-09"])).toEqual({
      action: "balance",
      startMonth: "2026-09",
      endMonth: "2026-09",
      categories: [],
      interactive: false,
      dryRun: false,
    })
  })

  it("takes an inclusive month range", () => {
    expect(parseSetBudget(["spent-3", "2026-01", "2026-03"])).toMatchObject({ startMonth: "2026-01", endMonth: "2026-03" })
  })

  it("accepts every documented action name", () => {
    for (const action of ["balance", "spent", "spent-3", "spent-12", "previous"]) {
      expect(parseSetBudget([action, "2026-09"])).toMatchObject({ action })
    }
  })

  it("falls back to a literal dollar amount, in cents, when the action isn't a known name", () => {
    // The fallback that makes `set-values 249.99` work at all -- and the branch that would quietly
    // misread an action name as an amount if the order of the two checks were ever swapped.
    expect(parseSetBudget(["249.99", "2026-09"])).toMatchObject({ action: 24999 })
    expect(parseSetBudget(["500", "2026-09"])).toMatchObject({ action: 50000 })
  })

  it("collects -c/--category repeatedly", () => {
    expect(parseSetBudget(["-c", "Groceries", "--category", "Fuel", "balance", "2026-09"])).toMatchObject({
      categories: ["Groceries", "Fuel"],
    })
  })

  it("keeps an empty category list, which means every category", () => {
    // The CLI's own documented unfiltered sweep. The web refuses this (an empty checkbox set reads
    // as "not picked yet"), and that difference has to stay on the web side of the line.
    expect(parseSetBudget(["balance", "2026-09"]).categories).toEqual([])
  })

  it("reads DRY_RUN from the environment, and -n turns it on regardless", () => {
    process.env.DRY_RUN = "true"
    expect(parseSetBudget(["balance", "2026-09"]).dryRun).toBe(true)
    process.env.DRY_RUN = "false"
    expect(parseSetBudget(["balance", "2026-09"]).dryRun).toBe(false)
    expect(parseSetBudget(["-n", "balance", "2026-09"]).dryRun).toBe(true)
    expect(parseSetBudget(["--dry-run", "balance", "2026-09"]).dryRun).toBe(true)
  })

  it("takes -i/--interactive", () => {
    expect(parseSetBudget(["-i", "balance", "2026-09"]).interactive).toBe(true)
    expect(parseSetBudget(["--interactive", "balance", "2026-09"]).interactive).toBe(true)
  })

  it("stops treating arguments as options after --", () => {
    expect(parseSetBudget(["--", "-500", "2026-09"])).toMatchObject({ action: -50000 })
  })

  it("exits 1 on an unknown option", () => {
    expect(bailout(() => parseSetBudget(["--nope", "balance", "2026-09"]))).toMatchObject({ code: 1 })
    expect(bailout(() => parseSetBudget(["--nope", "balance", "2026-09"])).message).toContain("Unknown option")
  })

  it("exits 1 when -c has no value, including when the next argument is another flag", () => {
    expect(bailout(() => parseSetBudget(["balance", "2026-09", "-c"]))).toMatchObject({ code: 1 })
    // Deliberate: a bare -n after -c is far more likely to be a forgotten category than a category
    // actually named "-n", and silently consuming it would filter the run to nothing.
    expect(bailout(() => parseSetBudget(["-c", "-n", "balance", "2026-09"])).message).toContain("Missing argument")
  })

  it("exits 1 on too few or too many positionals", () => {
    expect(bailout(() => parseSetBudget(["balance"]))).toMatchObject({ code: 1 })
    expect(bailout(() => parseSetBudget([]))).toMatchObject({ code: 1 })
    expect(bailout(() => parseSetBudget(["balance", "2026-01", "2026-02", "2026-03"]))).toMatchObject({ code: 1 })
  })

  it("exits 1 on an action that is neither a name nor an amount", () => {
    expect(bailout(() => parseSetBudget(["nonsense", "2026-09"])).message).toContain("Unknown action")
  })

  it("exits 1 on a malformed month, at either end of the range", () => {
    expect(bailout(() => parseSetBudget(["balance", "2026-13"]))).toMatchObject({ code: 1 })
    expect(bailout(() => parseSetBudget(["balance", "September"]))).toMatchObject({ code: 1 })
    expect(bailout(() => parseSetBudget(["balance", "2026-09", "nope"]))).toMatchObject({ code: 1 })
  })

  it("exits 0 for --help, printing to stdout rather than stderr", () => {
    // This exited 1 once, i.e. asking for help was treated as getting it wrong.
    expect(bailout(() => parseSetBudget(["--help"]))).toMatchObject({ code: 0 })
    expect(stdout.join("")).toContain("Usage:")
    expect(stderr.join("")).toBe("")
    expect(bailout(() => parseSetBudget(["-h"]))).toMatchObject({ code: 0 })
  })
})

describe("anomalies arguments", () => {
  it("requires at least one category", () => {
    // Unlike set-values, where no category means every category: scanning a whole budget's history
    // is a different proposition from budgeting it, so this one insists on being told where to look.
    expect(bailout(() => parseAnomalies(["2026-09"]))).toMatchObject({ code: 1 })
  })

  it("takes categories, months, and the tag/dry-run flags", () => {
    expect(parseAnomalies(["-c", "Groceries", "-c", "Fuel", "2026-01", "2026-03", "-t", "-n"])).toEqual({
      categories: ["Groceries", "Fuel"],
      startMonth: "2026-01",
      endMonth: "2026-03",
      tag: true,
      dryRun: true,
    })
  })

  it("defaults the end month to the start and leaves the write flags off", () => {
    expect(parseAnomalies(["-c", "Groceries", "2026-09"])).toMatchObject({ endMonth: "2026-09", tag: false, dryRun: false })
  })

  it("reads DRY_RUN from the environment", () => {
    process.env.DRY_RUN = "true"
    expect(parseAnomalies(["-c", "Groceries", "2026-09"]).dryRun).toBe(true)
  })

  it("exits 1 on a bad month or an unknown option, and 0 for --help", () => {
    expect(bailout(() => parseAnomalies(["-c", "Groceries", "2026-99"]))).toMatchObject({ code: 1 })
    expect(bailout(() => parseAnomalies(["-c", "Groceries", "2026-09", "--nope"]))).toMatchObject({ code: 1 })
    expect(bailout(() => parseAnomalies(["--help"]))).toMatchObject({ code: 0 })
  })
})

describe("match-uncleared arguments", () => {
  it("defaults to the last 14 days", () => {
    const { sinceDate } = parseMatchUncleared([])
    const expected = new Date()
    expected.setDate(expected.getDate() - 14)
    expect(sinceDate).toBe(expected.toISOString().slice(0, 10))
  })

  it("takes -s/--since", () => {
    expect(parseMatchUncleared(["-s", "2026-01-01"])).toMatchObject({ sinceDate: "2026-01-01" })
    expect(parseMatchUncleared(["--since", "2026-01-01"])).toMatchObject({ sinceDate: "2026-01-01" })
  })

  it("takes -n/--dry-run and reads DRY_RUN", () => {
    expect(parseMatchUncleared(["-n"]).dryRun).toBe(true)
    process.env.DRY_RUN = "true"
    expect(parseMatchUncleared([]).dryRun).toBe(true)
  })

  it("exits 1 on a malformed date or an unknown option, and 0 for --help", () => {
    // A day-precision date here, not a month: the wrong shape would otherwise sail through to the
    // API and come back as an empty result rather than an error.
    expect(bailout(() => parseMatchUncleared(["-s", "2026-01"]))).toMatchObject({ code: 1 })
    expect(bailout(() => parseMatchUncleared(["-s", "01/01/2026"]))).toMatchObject({ code: 1 })
    expect(bailout(() => parseMatchUncleared(["--nope"]))).toMatchObject({ code: 1 })
    expect(bailout(() => parseMatchUncleared(["--help"]))).toMatchObject({ code: 0 })
  })

  it("takes no positional arguments", () => {
    expect(bailout(() => parseMatchUncleared(["2026-09"]))).toMatchObject({ code: 1 })
  })
})
