#!/usr/bin/env bash

set -euo pipefail

# Function to check required environment variables and tools
function checkDependencies() {
  if [[ -z "${BASE_URL}" || -z "${BUDGET_ID}" || -z "${API_KEY}" ]]; then
    echo "Environment variables BASE_URL, BUDGET_ID, and API_KEY must be set." >&2
    exit 1
  fi

  if ! command -v jq &> /dev/null; then
    echo "jq is required but not installed. Please install jq." >&2
    exit 1
  fi

  if ! command -v curl &> /dev/null; then
    echo "curl is required but not installed. Please install curl." >&2
    exit 1
  fi

  local dateCommand="date"
  local osName=$(uname)
  if [[ ${osName} == "Darwin" ]]; then
    if ! command -v gdate &> /dev/null; then
      echo "gdate is required but not installed. Please install gdate." >&2
      exit 1
    fi
    dateCommand="gdate"
  fi
  echo "$dateCommand"
}

# Function to display usage and exit
function usage() {
  cat >&2 <<EOF
usage: ${0} [-c CATEGORY]... [-i] yyyy-mm [yyyy-mm]

Options:
  -c, --category CATEGORY   Only update the specified category name or ID. Can be used multiple times.
  -i, --interactive         Ask for confirmation before each update.
EOF
  exit 1
}

# Function to parse and validate command-line arguments
function parseArguments() {
  PARSE_CATEGORIES=()
  PARSE_INTERACTIVE=false
  local args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -c|--category)
        shift
        if [[ -z "${1:-}" || "${1:0:1}" == "-" ]]; then
          echo "Missing argument for --category" >&2
          usage
        fi
        PARSE_CATEGORIES+=("$1")
        ;;
      -i|--interactive)
        PARSE_INTERACTIVE=true
        ;;
      --)
        shift
        break
        ;;
      -* )
        echo "Unknown option: $1" >&2
        usage
        ;;
      *)
        args+=("$1")
        ;;
    esac
    shift
  done

  if [[ ${#args[@]} -lt 1 || ${#args[@]} -gt 2 ]]; then
    usage
  fi

  PARSE_START_MONTH="${args[0]}"
  PARSE_END_MONTH="${args[1]:-${args[0]}}"

  validateMonthFormat "$PARSE_START_MONTH" "start month"
  validateMonthFormat "$PARSE_END_MONTH" "end month"
}

# Function to validate month format
function validateMonthFormat() {
  local month="$1"
  local label="$2"
  if ! [[ $month =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
    echo "Invalid format for $label: $month" >&2
    exit 1
  fi
}

# Function to determine whether a category should be updated
function shouldUpdateCategory() {
  local id="$1"
  local name="$2"
  if [[ ${#PARSE_CATEGORIES[@]} -eq 0 ]]; then
    return 0
  fi

  for filter in "${PARSE_CATEGORIES[@]}"; do
    if [[ "$filter" == "$id" || "$filter" == "$name" ]]; then
      return 0
    fi
  done

  return 1
}

# Function to confirm a pending update
function confirmUpdate() {
  local month="$1"
  local name="$2"
  local new_budgeted="$3"
  if [[ "$PARSE_INTERACTIVE" != "true" ]]; then
    return 0
  fi

  while true; do
    echo -n "Confirm update for month ${month}, category ${name}, new value ${new_budgeted}? [y/N] "
    read -r answer < /dev/tty
    case "$(echo "$answer" | tr '[:upper:]' '[:lower:]')" in
      y|yes)
        return 0
        ;;
      n|no|"")
        echo "Skipping category; month: ${month}; name: ${name}"
        return 1
        ;;
      *)
        echo "Please answer y or n."
        ;;
    esac
  done
}

# Function to update a single category
function updateCategory() {
  local month="$1"
  local id="$2"
  local name="$3"
  local budgeted="$4"
  local spent="$5"
  local balance="$6"

  if [[ -z "${spent}" || "${spent}" == "null" ]]; then
    return
  fi
  if [[ "${spent}" == "0" && "${balance}" == "0" ]]; then
    return
  fi

  if ! shouldUpdateCategory "$id" "$name"; then
    return
  fi

  local new_budgeted=$(( spent * -1 ))
  if [[ "${new_budgeted}" == "${budgeted}" ]]; then
    echo "No update needed for category; month: ${month}; name: ${name}; budgeted = ${budgeted}"
    return
  fi

  if ! confirmUpdate "$month" "$name" "$new_budgeted"; then
    return
  fi

  echo "Updating category; month: ${month}; name: ${name}; setting budgeted = ${new_budgeted}"

  curl -s -X PATCH \
    "${BASE_URL}/budgets/${BUDGET_ID}/months/${month}/categories/${id}" \
    -H "accept: application/json" \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --argjson spent "${spent}" --argjson budget "${new_budgeted}" \
          '{category: {budgeted: $budget}}')" \
  >/dev/null
}

# Function to process categories for a given month
function processMonth() {
  local month="$1"
  local response=$(curl -s -X GET \
    "${BASE_URL}/budgets/${BUDGET_ID}/months/${month}/categories" \
    -H "accept: application/json" \
    -H "x-api-key: ${API_KEY}")

  echo "${response}" | jq -c '.data | .[]' | while read -r category; do
    local id=$(echo "${category}" | jq -r '.id')
    local name=$(echo "${category}" | jq -r '.name')
    local budgeted=$(echo "${category}" | jq -r '.budgeted')
    local spent=$(echo "${category}" | jq -r '.spent')
    local balance=$(echo "$category" | jq -r '.balance')

    updateCategory "$month" "$id" "$name" "$budgeted" "$spent" "$balance"
  done

  echo "All categories updated for month ${month}."
}

# Main function
function main() {
  local dateCommand=$(checkDependencies)
  parseArguments "$@"
  local startMonth="${PARSE_START_MONTH}"
  local endMonth="${PARSE_END_MONTH}"

  local current="$startMonth"
  local increment="-1 month"
  if [[ "${startMonth}" < "${endMonth}" ]]; then
    increment="+1 month"
  fi

  while true; do
    processMonth "$current"

    if [[ "${current}" == "${endMonth}" ]]; then
      break
    fi
    current=$(${dateCommand} -d "$current-01 ${increment}" +%Y-%m)
  done

  echo "All months processed."
}

# Run main function with all arguments
main "$@"
