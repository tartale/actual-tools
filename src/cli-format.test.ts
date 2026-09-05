import { Writable } from "node:stream"

import { describe, expect, it } from "vitest"

import { renderHelp } from "./cli-format.ts"
import type { HelpPage } from "./cli-format.ts"

// Function to build a stream double with a given width and TTY-ness, since styleText's own
// colour decision keys off `stream.isTTY` (and colour depth for a real TTY.WriteStream).
function fakeStream(options: { columns?: number; isTTY?: boolean } = {}): NodeJS.WriteStream {
  const stream = new Writable({ write: (_chunk, _encoding, callback) => callback() })
  Object.assign(stream, { columns: options.columns, isTTY: options.isTTY })
  return stream as unknown as NodeJS.WriteStream
}

const page: HelpPage = {
  usage: "tool [OPTIONS] ACTION",
  description: "A short description.",
  sections: [
    {
      label: "Actions",
      entries: [
        { name: "balance", description: "Zero the balance." },
        { name: "previous-12", description: "Average the previous twelve months." },
      ],
    },
    {
      label: "Options",
      entries: [{ name: "-i, --interactive", description: "Ask before each update." }],
    },
  ],
}

describe("renderHelp", () => {
  it("renders plain text with no ANSI codes on a non-TTY stream", () => {
    const output = renderHelp(fakeStream({ columns: 80 }), page)
    expect(output).not.toContain("[")
    expect(output).toContain("Usage: tool [OPTIONS] ACTION")
    expect(output).toContain("A short description.")
  })

  it("emits ANSI codes on a TTY stream", () => {
    const output = renderHelp(fakeStream({ columns: 80, isTTY: true }), page)
    expect(output).toContain("[")
  })

  it("word-wraps a description too long for the terminal width", () => {
    const longPage: HelpPage = { ...page, description: "one two three four five six seven eight nine ten" }
    const output = renderHelp(fakeStream({ columns: 20 }), longPage)
    const lines = output.split("\n")
    expect(lines).toContain("one two three four")
    expect(lines).toContain("five six seven eight")
  })

  it("right-aligns the description column to the widest name in each section, independently per section", () => {
    const output = renderHelp(fakeStream({ columns: 80 }), page)
    const lines = output.split("\n")
    // "previous-12" (11 chars) is the widest name in Actions, so "balance" pads out to match it.
    expect(lines).toContain("balance       Zero the balance.")
    // Options has its own, unrelated width — a single entry, padded to only its own name's length.
    expect(lines).toContain("-i, --interactive   Ask before each update.")
  })

  it("word-wraps a description that doesn't fit, indenting continuation lines to the column start", () => {
    const output = renderHelp(fakeStream({ columns: 40 }), page)
    const lines = output.split("\n")
    expect(lines).toContain("previous-12   Average the previous")
    // Actions' column start is 14 (11-char widest name + 3-char gap).
    expect(lines).toContain(`${" ".repeat(14)}twelve months.`)
  })

  it("sizes each section's rule to the stream width, falling back to 80 columns when it isn't a TTY", () => {
    const withWidth = renderHelp(fakeStream({ columns: 30 }), page)
    const withoutWidth = renderHelp(fakeStream({}), page)
    const ruleLength = (output: string): number | undefined => output.split("\n").find((line) => line.startsWith("─"))?.length
    expect(ruleLength(withWidth)).toBe(30)
    expect(ruleLength(withoutWidth)).toBe(80)
  })
})
