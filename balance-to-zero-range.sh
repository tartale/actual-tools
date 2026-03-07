#!/usr/bin/env bash

for y in {2024..2015}
do

for m in {12..1} 
do
  month=$(printf "%04d-%02d" "${y}" "${m}")
  ./balance-to-zero.sh "${month}"
done

done

