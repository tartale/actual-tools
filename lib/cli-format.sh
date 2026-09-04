#!/usr/bin/env bash

# Shared help-formatting helpers for this repo's bash tools (actual, match-uncleared.sh),
# matching the look of src/cli-format.ts: a bold "Usage:" line, then labelled "─ Label ────"
# rules with a name/description column aligned to that section's own widest name.
#
# Everything here writes to stderr, matching how usage/help text is already printed in this
# repo's bash scripts. Colour is applied only when stderr is a TTY and NO_COLOR is unset,
# mirroring how node:util's styleText decides per-stream in the TypeScript CLI.

# Function to decide whether stderr should be colorized
function cliColorEnabled() {
  [[ -z "${NO_COLOR:-}" && -t 2 ]]
}

# Function to wrap text in an ANSI style code, only when colour is enabled
function cliStyle() {
  local code="$1"
  local text="$2"
  if cliColorEnabled; then
    printf '\033[%sm%s\033[0m' "${code}" "${text}"
  else
    printf '%s' "${text}"
  fi
}

# Function to get the usable terminal width, falling back when stderr isn't a TTY
function cliWidth() {
  local width
  width=$(tput cols 2>/dev/null) || width=80
  echo "${width:-80}"
}

# Function to print a "Usage: ..." line with the leading word bold and yellow
function cliUsage() {
  printf '%s %s\n' "$(cliStyle '1;33' 'Usage:')" "$1" >&2
}

# Function to print a "─ Label ────" rule sized to the terminal width
function cliRule() {
  local label="$1"
  local prefix="─ ${label} "
  local fillLength=$(( $(cliWidth) - ${#prefix} ))
  (( fillLength < 4 )) && fillLength=4
  local fill
  fill=$(printf '─%.0s' $(seq 1 "${fillLength}"))
  printf '%s\n' "$(cliStyle 2 "${prefix}${fill}")" >&2
}

# Function to print the longest string's length among the given arguments
function cliMaxLength() {
  local max=0 arg
  for arg in "$@"; do
    (( ${#arg} > max )) && max=${#arg}
  done
  echo "${max}"
}

# Function to print one name/description entry, its name bold cyan and padded to nameWidth
function cliEntry() {
  local name="$1" description="$2" nameWidth="$3"
  local paddedName
  paddedName=$(printf '%-*s' "${nameWidth}" "${name}")
  printf '%s   %s\n' "$(cliStyle '1;36' "${paddedName}")" "${description}" >&2
}

# Function to print a full section: its rule, then every name/description pair aligned to the
# section's own widest name. Takes the label, then alternating name/description argument pairs.
function cliSection() {
  local label="$1"
  shift
  local names=() descriptions=()
  while [[ $# -gt 0 ]]; do
    names+=("$1")
    descriptions+=("$2")
    shift 2
  done

  cliRule "${label}"
  local nameWidth
  nameWidth=$(cliMaxLength "${names[@]}")
  local i
  for i in "${!names[@]}"; do
    cliEntry "${names[i]}" "${descriptions[i]}" "${nameWidth}"
  done
}
