#!/usr/bin/env bash

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
dateCommand="date"
osName=$(uname)
if [[ ${osName} == "Darwin" ]]; then
  if ! command -v gdate &> /dev/null; then
    echo "gdate is required but not installed. Please install gdate." >&2
    exit 1
  fi
  dateCommand="gdate"
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: ${0} yyyy-mm [yyyy-mm]" >&2
  exit 1
fi

startMonth="${1}"
endMonth="${1}"
if [[ $# -eq 2 ]]; then
  endMonth="${2}"
fi

# Validate format
if ! [[ $startMonth =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
  echo "Invalid format for start month: $startMonth" >&2
  exit 1
fi
if ! [[ $endMonth =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
  echo "Invalid format for end month: $endMonth" >&2
  exit 1
fi

current="$startMonth"
increment="-1 month"
if [[ "${startMonth}" < "${endMonth}" ]]; then
  increment="+1 month"
fi

while true; do
  month="$current"
  response=$(curl -s -X GET \
    "${BASE_URL}/budgets/${BUDGET_ID}/months/${month}/categories" \
    -H "accept: application/json" \
    -H "x-api-key: ${API_KEY}")

  echo "${response}" | jq -c '.data | .[]' | while read -r category; do
    id=$(echo "${category}" | jq -r '.id')
    name=$(echo "${category}" | jq -r '.name')
    budgeted=$(echo "${category}" | jq -r '.budgeted')
    spent=$(echo "${category}" | jq -r '.spent')
    balance=$(echo "$category" | jq -r '.balance')

    if [[ -z "${spent}" || "${spent}" == "null" ]]; then
      continue
    fi
    if [[ "${spent}" == "0" && "${balance}" == "0" ]]; then
      continue
    fi

    new_budgeted=$(( spent * -1 ))
    if [[ "${new_budgeted}" == "${budgeted}" ]]; then
      echo "No update needed for category; month: ${month}; name: ${name}; budgeted = ${budgeted}"
      continue
    fi

    echo "Updating category; month: ${month}; name: ${name}; setting budgeted = ${new_budgeted}"

    curl -s -X PATCH \
      "${BASE_URL}/budgets/${BUDGET_ID}/months/${month}/categories/${id}" \
      -H "accept: application/json" \
      -H "x-api-key: ${API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --argjson spent "${spent}" --argjson budget "${budget}" \
            '{category: {budgeted: $budget}}')" \
    >/dev/null
  done

  echo "All categories updated for month ${month}."
  if [[ "${current}" == "${endMonth}" ]]; then
    break
  fi
  current=$(${dateCommand} -d "$current-01 ${increment}" +%Y-%m)
done

echo "All months processed."
