#!/usr/bin/env bash

set -euo pipefail

function checkDependencies() {
  if [[ -z "${BASE_URL:-}" || -z "${BUDGET_ID:-}" || -z "${API_KEY:-}" ]]; then
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
  local osName
  osName=$(uname)
  if [[ "${osName}" == "Darwin" ]]; then
    if ! command -v gdate &> /dev/null; then
      echo "gdate is required but not installed. Please install gdate." >&2
      exit 1
    fi
    dateCommand="gdate"
  fi
  echo "${dateCommand}"
}

function usage() {
  cat >&2 <<EOF
usage: ${0} [-s YYYY-MM-DD]

Finds uncleared transactions that match a cleared transaction within 5 days
and tags both with #cleared in their notes.

Options:
  -s, --since YYYY-MM-DD   Fetch transactions on or after this date (default: 14 days ago)

Environment variables required:
  BASE_URL    e.g. https://actualbudget.example.com/v1
  BUDGET_ID   UUID of the budget
  API_KEY     API key for authentication
EOF
  exit 1
}

function validateDateFormat() {
  local date="$1"
  local label="$2"
  if ! [[ "${date}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "Invalid format for ${label}: ${date}" >&2
    exit 1
  fi
}

function parseArguments() {
  PARSE_SINCE_DATE=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -s|--since)
        shift
        if [[ -z "${1:-}" || "${1:0:1}" == "-" ]]; then
          echo "Missing argument for --since" >&2
          usage
        fi
        PARSE_SINCE_DATE="$1"
        validateDateFormat "${PARSE_SINCE_DATE}" "--since"
        ;;
      -*)
        echo "Unknown option: $1" >&2
        usage
        ;;
      *)
        echo "Unexpected argument: $1" >&2
        usage
        ;;
    esac
    shift
  done
}

function fetchAccounts() {
  local response
  response=$(curl -sk -X GET \
    "${BASE_URL}/budgets/${BUDGET_ID}/accounts" \
    -H "accept: application/json" \
    -H "x-api-key: ${API_KEY}")

  if ! echo "${response}" | jq -e '.data' > /dev/null 2>&1; then
    echo "Error: unexpected response from GET accounts: ${response}" >&2
    exit 1
  fi

  echo "${response}" | jq -c '[.data[] | select(.closed == false and .offbudget == false)]'
}

function fetchTransactions() {
  local accountId="$1"
  local sinceDate="$2"

  local response
  response=$(curl -sk -X GET \
    "${BASE_URL}/budgets/${BUDGET_ID}/accounts/${accountId}/transactions?since_date=${sinceDate}" \
    -H "accept: application/json" \
    -H "x-api-key: ${API_KEY}")

  if ! echo "${response}" | jq -e '.data' > /dev/null 2>&1; then
    echo "Error: unexpected response from GET transactions for account ${accountId}: ${response}" >&2
    exit 1
  fi

  echo "${response}" | jq -c '[.data[] | select(.tombstone == false)]'
}

function collectAllTransactions() {
  local accounts="$1"
  local sinceDate="$2"
  local all="[]"

  while IFS= read -r account; do
    local accountId
    local accountName
    accountId=$(echo "${account}" | jq -r '.id')
    accountName=$(echo "${account}" | jq -r '.name')
    echo "Fetching transactions for account: ${accountName}" >&2

    local txns
    txns=$(fetchTransactions "${accountId}" "${sinceDate}")
    all=$(jq -nc --argjson a "${all}" --argjson b "${txns}" '$a + $b')
  done < <(echo "${accounts}" | jq -c '.[]')

  echo "${all}"
}

function formatAmount() {
  local amount="$1"
  awk -v amt="${amount}" 'BEGIN {
    if (amt < 0) printf "-$%.2f", -amt/100
    else printf "$%.2f", amt/100
  }'
}

function addDays() {
  local date="$1"
  local n="$2"
  local dateCommand="$3"
  ${dateCommand} -d "${date} +${n} days" +%Y-%m-%d
}

function findMatch() {
  local tx="$1"
  local clearedJson="$2"
  local maxDate="$3"

  local payee
  local accountId
  local txDate
  payee=$(echo "${tx}" | jq -r '.imported_payee // "" | ascii_downcase | gsub("\\s+"; " ") | ltrimstr(" ") | rtrimstr(" ")')
  accountId=$(echo "${tx}" | jq -r '.account')
  txDate=$(echo "${tx}" | jq -r '.date')

  echo "${clearedJson}" | jq -rc \
    --arg payee "${payee}" \
    --arg account "${accountId}" \
    --arg from "${txDate}" \
    --arg to "${maxDate}" \
    'first(.[] | select(
       .account == $account
       and (.imported_payee // "" | ascii_downcase | gsub("\\s+"; " ") | ltrimstr(" ") | rtrimstr(" ")) == $payee
       and .date >= $from
       and .date <= $to
     )) // empty'
}

function patchTransactionNote() {
  local id="$1"
  local newNotes="$2"

  local patchBody
  patchBody=$(jq -n --arg notes "${newNotes}" '{"transaction": {"notes": $notes}}')

  local response
  local responseBody
  local responseStatusCode
  response=$(curlWithStatus -sk -X PATCH \
    "${BASE_URL}/budgets/${BUDGET_ID}/transactions/${id}" \
    -H "accept: application/json" \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "${patchBody}")
  if [[ "${DRY_RUN:-}" == "true" ]]; then
    return 0
  fi
  responseBody=$(echo "${response}" | jq -r '.[0]')
  responseStatusCode=$(echo "${response}" | jq -r '.[1].statusCode')
  if [[ "${responseStatusCode}" != "200" ]]; then
    echo "Warning: PATCH failed for transaction ${id}: ${responseBody}" >&2
    return 1
  fi
}

function tagPair() {
  local unclearedTx="$1"
  local clearedTx="$2"
  local tag="$3"

  local unclearedId unclearedDate unclearedPayee unclearedNotes unclearedAmount
  local clearedId clearedDate clearedPayee clearedNotes clearedAmount

  unclearedId=$(echo "${unclearedTx}"    | jq -r '.id')
  unclearedDate=$(echo "${unclearedTx}"  | jq -r '.date')
  unclearedPayee=$(echo "${unclearedTx}" | jq -r '.imported_payee // ""')
  unclearedNotes=$(echo "${unclearedTx}" | jq -r '.notes // ""')
  unclearedAmount=$(echo "${unclearedTx}" | jq -r '.amount')

  clearedId=$(echo "${clearedTx}"     | jq -r '.id')
  clearedDate=$(echo "${clearedTx}"   | jq -r '.date')
  clearedPayee=$(echo "${clearedTx}"  | jq -r '.imported_payee // ""')
  clearedNotes=$(echo "${clearedTx}"  | jq -r '.notes // ""')
  clearedAmount=$(echo "${clearedTx}" | jq -r '.amount')

  local newUnclearedNotes="${tag}${unclearedNotes:+ ${unclearedNotes}}"

  printf "Matched %s:\n  uncleared: %s | %-40s | amount: %s\n  cleared:   %s | %-40s | amount: %s\n" \
    "${tag}" \
    "${unclearedDate}" "${unclearedPayee}" "$(formatAmount "${unclearedAmount}")" \
    "${clearedDate}"   "${clearedPayee}"   "$(formatAmount "${clearedAmount}")"

  if ! patchTransactionNote "${unclearedId}" "${newUnclearedNotes}"; then
    echo "Warning: failed to patch uncleared transaction ${unclearedId}; skipping pair." >&2
    return 1
  fi
}

function main() {
  local dateCommand
  dateCommand=$(checkDependencies)
  parseArguments "$@"

  local sinceDate="${PARSE_SINCE_DATE}"
  if [[ -z "${sinceDate}" ]]; then
    sinceDate=$(${dateCommand} -d "14 days ago" +%Y-%m-%d)
  fi

  echo "Fetching on-budget accounts..."
  local accounts
  accounts=$(fetchAccounts)
  local accountCount
  accountCount=$(echo "${accounts}" | jq 'length')
  echo "Found ${accountCount} on-budget account(s). Fetching transactions since ${sinceDate}..."

  local allTxns
  allTxns=$(collectAllTransactions "${accounts}" "${sinceDate}")
  local totalCount
  totalCount=$(echo "${allTxns}" | jq 'length')
  echo "Collected ${totalCount} transaction(s) total."

  local unclearedJson clearedJson
  unclearedJson=$(echo "${allTxns}" | jq '[.[] | select(.cleared == false and (.notes // "" | startswith("#cleared") | not))]')
  clearedJson=$(echo "${allTxns}"   | jq '[.[] | select(.cleared == true  and (.notes // "" | startswith("#cleared") | not))]')

  local unclearedCount
  unclearedCount=$(echo "${unclearedJson}" | jq 'length')
  echo "Found ${unclearedCount} uncleared transaction(s) to check."

  local matched=0

  while IFS= read -r tx; do
    local txDate maxDate
    txDate=$(echo "${tx}" | jq -r '.date')
    maxDate=$(addDays "${txDate}" 5 "${dateCommand}")

    local match
    match=$(findMatch "${tx}" "${clearedJson}" "${maxDate}")

    if [[ -n "${match}" ]]; then
      if tagPair "${tx}" "${match}" "#cleared"; then
        local matchedId
        matchedId=$(echo "${match}" | jq -r '.id')
        clearedJson=$(echo "${clearedJson}" | jq --arg id "${matchedId}" '[.[] | select(.id != $id)]')
        (( matched++ )) || true
      fi
    fi
  done < <(echo "${unclearedJson}" | jq -c '.[]')

  echo "Tagged ${matched} cleared transaction(s)."
}

main "$@"
