#!/usr/bin/env bash

BASE_URL="http://tartalenas.local:5007/v1"
BUDGET_ID="2e12e2dc-497c-4d29-b7eb-7471c7dbdbec"
API_KEY="f9eda16d-6085-4239-960d-e764cc62ac56"

if [[ -z "${1}" ]]; then
  echo "usage: ${0} yyyy-mm" >&2
  exit 1
fi

month="${1}"
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

  budget=$(( spent * -1 ))
  echo "Updating category; month: ${month}; name: ${name}; setting budgeted = ${budget}"

  curl -s -X PATCH \
    "${BASE_URL}/budgets/${BUDGET_ID}/months/${month}/categories/${id}" \
    -H "accept: application/json" \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --argjson spent "${spent}" --argjson budget "${budget}" \
          '{category: {budgeted: $budget}}')" \
    >/dev/null

done

echo "All categories updated."
