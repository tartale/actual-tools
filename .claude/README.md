# .claude/

Checked-in Claude Code state for this repo, so work can resume on another
machine (e.g. the NAS sandbox) with full context.

- `sandbox/` — claude-sandbox build/plugin config for running this repo's
  Claude Code sessions in a sandboxed container.
- `plans/` — snapshots of implementation plans written during planning
  sessions. `set-budget-migration.md` is the active plan for replacing
  `balance-to-zero.sh` with a TypeScript `set-budget.ts`.
- `memory/` — snapshots of this project's Claude Code memory (normally
  kept under `~/.claude/projects/.../memory/` on the machine that wrote
  it). Read `memory/MEMORY.md` first — it indexes the rest.

These are point-in-time copies, not a live sync. When resuming work here,
read them for context, then update or delete them as the actual state
changes.
