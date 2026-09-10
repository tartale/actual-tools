import { describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))

// The ./actual dispatcher, run as a real process. Nothing here reaches the network: every case
// either prints help or is rejected before a request is made, which is exactly why they can be
// tested at all -- and they are the cases most likely to break unnoticed, since the routing lives
// in bash where neither tsc nor eslint reaches it.
//
// Deliberately blanked env: a machine with real AB_* variables set must not let a test wander into
// a live budget just because a case failed to bail out when it should have.
async function actual(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("./actual", args, {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" }
  }
}

describe("./actual dispatcher", () => {
  it("lists its commands for --help and exits 0", async () => {
    // Asking for help is not getting it wrong. This exited 1 once.
    const result = await actual(["--help"])
    expect(result.code).toBe(0)
    for (const command of ["build", "lint", "test", "budget", "transactions", "app"]) {
      expect(result.stderr + result.stdout).toContain(command)
    }
  }, 30000)

  it("exits 1 with usage when given no command at all", async () => {
    const result = await actual([])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Usage:")
  }, 30000)

  it("exits 1 on an unknown command, naming it", async () => {
    const result = await actual(["nonsense"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Unknown command: nonsense")
  }, 30000)

  describe.each([
    { group: "budget", subcommands: ["set-values", "anomalies"] },
    { group: "transactions", subcommands: ["match-uncleared"] },
  ])("$group", ({ group, subcommands }) => {
    it("lists its subcommands for --help and exits 0", async () => {
      const result = await actual([group, "--help"])
      expect(result.code).toBe(0)
      for (const subcommand of subcommands) {
        expect(result.stderr + result.stdout).toContain(subcommand)
      }
    }, 30000)

    it("exits 1 with usage when given no subcommand", async () => {
      const result = await actual([group])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Usage:")
    }, 30000)

    it("exits 1 on an unknown subcommand, naming it", async () => {
      const result = await actual([group, "nonsense"])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`Unknown ${group} subcommand: nonsense`)
    }, 30000)

    it("routes each subcommand through to its own help", async () => {
      // Proves the dispatcher reaches the right script, not just that it exits cleanly: each one's
      // usage line names the full command path it was reached by.
      for (const subcommand of subcommands) {
        const result = await actual([group, subcommand, "--help"])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain(`./actual ${group} ${subcommand}`)
      }
    }, 30000)
  })

  it("rejects bad arguments before making any request, with no credentials in the environment", async () => {
    // If any of these reached the API layer they would fail on missing AB_* variables instead, so
    // the specific complaint is the point: the argument was rejected on its own terms.
    const badMonth = await actual(["budget", "set-values", "balance", "2026-13"])
    expect(badMonth.code).toBe(1)
    expect(badMonth.stderr).toContain("Invalid month format")

    const badAction = await actual(["budget", "set-values", "nonsense", "2026-09"])
    expect(badAction.code).toBe(1)
    expect(badAction.stderr).toContain("Unknown action")

    const noCategory = await actual(["budget", "anomalies", "2026-09"])
    expect(noCategory.code).toBe(1)
  }, 30000)
})
