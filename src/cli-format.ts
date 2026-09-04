import { styleText } from "node:util"

export interface HelpEntry {
  name: string
  description: string
}

export interface HelpSection {
  label: string
  entries: readonly HelpEntry[]
}

export interface HelpPage {
  usage: string
  description?: string
  sections: readonly HelpSection[]
}

const DEFAULT_WIDTH = 80
const MIN_RULE_FILL = 4
const COLUMN_GAP = 3

// Function to apply a style, deferring entirely to styleText's own per-stream TTY/color-depth check
function style(stream: NodeJS.WriteStream, format: Parameters<typeof styleText>[0], text: string): string {
  return styleText(format, text, { stream })
}

// Function to get the usable terminal width for a stream, falling back when it isn't a TTY
function widthOf(stream: NodeJS.WriteStream): number {
  return stream.columns || DEFAULT_WIDTH
}

// Function to build a "─ Label ────" rule sized to the terminal width
function renderRule(stream: NodeJS.WriteStream, label: string): string {
  const prefix = `─ ${label} `
  const fillLength = Math.max(widthOf(stream) - prefix.length, MIN_RULE_FILL)
  return style(stream, "dim", prefix + "─".repeat(fillLength))
}

// Function to word-wrap text to a width, indenting every continuation line
function wrap(text: string, width: number, indent: number): string[] {
  const words = text.split(" ")
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length > width && current) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) {
    lines.push(current)
  }
  return lines.map((line, index) => (index === 0 ? line : " ".repeat(indent) + line))
}

// Function to render one section: its rule, then a name/description column aligned to its own widest name
function renderSection(stream: NodeJS.WriteStream, section: HelpSection): string {
  const nameWidth = Math.max(...section.entries.map((entry) => entry.name.length))
  const columnStart = nameWidth + COLUMN_GAP
  const descWidth = Math.max(widthOf(stream) - columnStart, 20)

  const lines = section.entries.flatMap((entry) => {
    const [firstLine = "", ...restLines] = wrap(entry.description, descWidth, columnStart)
    const nameCol = style(stream, ["bold", "cyan"], entry.name.padEnd(nameWidth))
    return [`${nameCol}${" ".repeat(COLUMN_GAP)}${firstLine}`, ...restLines]
  })

  return [renderRule(stream, section.label), ...lines].join("\n")
}

// Function to render a full help page (usage, optional description, then labelled sections) for a
// given output stream. Colour is applied only when that stream is a TTY that supports it (styleText's
// own check), so the exact same content prints as plain text when piped or redirected.
export function renderHelp(stream: NodeJS.WriteStream, page: HelpPage): string {
  const parts = [`${style(stream, ["bold", "yellow"], "Usage:")} ${page.usage}`]
  if (page.description) {
    parts.push("", page.description)
  }
  for (const section of page.sections) {
    parts.push("", renderSection(stream, section))
  }
  return parts.join("\n")
}
