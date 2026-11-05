#!/usr/bin/env bash
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tax="$here/../taxonomy.json"
[ $# -gt 0 ] || { echo "usage: lint.sh FILE.jsonl ..." >&2; exit 2; }
rc=0
for f in "$@"; do
  jq -e . "$f" > /dev/null 2>&1 || { echo "$f: not valid JSONL"; rc=1; continue; }
  out=$(jq -r --slurpfile tax "$tax" --arg file "$(basename "$f")" '
    def ids: ["au-tfn","au-medicare","au-abn","au-acn","au-ihi","au-driver-licence","au-passport","au-bsb","au-account","au-crn","au-phone","us-ssn","us-itin","us-ein","us-driver-licence","us-passport","us-routing","us-account","us-card","us-mbi","us-npi","us-phone"];
    def checksum: ["au-tfn","au-medicare","au-abn","au-acn","au-ihi","us-ssn","us-itin","us-ein","us-routing","us-card","us-mbi","us-npi"];
    def pii_text: ["au-name","us-name","au-address","us-address","au-dob","us-dob","email"];
    def plain: ["staff-name","company","date","amount"];
    def slots: [scan("\\{\\{([^}]*)\\}\\}") | .[0]];
    def parts: capture("^(?<t>[a-z0-9-]+)(#(?<i>[0-9]+))?(:(?<v>[A-Za-z0-9_-]+))?$");
    . as $t
    | ($tax[0]) as $x
    | ($x.pii + $x.policy | keys) as $viol_cats
    | ($x.negatives | keys) as $neg_cats
    | [
        (["family_id","industry","role","label","categories","policy_basis","difficulty","shape","jurisdiction","description","text"] | map(select(. as $k | $t | has($k) | not)) | map("missing " + .) | .[]),
        (if ($t | has("text")) then
          ( ($t.text | slots) as $ss
          | ($ss[] | parts? // "BADSLOT") as $p
          | if $p == "BADSLOT" then "unparsable slot in text"
            else
              ($p.t) as $ty | ($p.v // "") as $v
              | if ($ty | IN(ids[])) then
                  if $v == "invalid" then
                    (if ($ty | IN(checksum[]) | not) then "\($ty):invalid has no checksum" elif $t.label != "clean" then "\($ty):invalid in a violation" else empty end)
                  elif $v == "masked" then (if $t.label != "clean" then "\($ty):masked in a violation" else empty end)
                  elif $v != "" then "bad variant \($ty):\($v)"
                  elif $t.label == "clean" then "valid \($ty) in a clean template (use :invalid or :masked)"
                  else empty end
                elif ($ty | IN(pii_text[])) then (if $t.label == "clean" then "\($ty) in a clean template (use staff-name)" else empty end)
                elif $ty == "secret" then
                  (if ($v | IN("aws","github","stripe","slack","jwt","password","conn") | not) then "secret needs a kind: aws github stripe slack jwt password conn"
                   elif $t.label == "clean" then "secret in a clean template" else empty end)
                elif ($ty | IN(plain[])) then (if ($v != "" and $v != "us") then "bad variant \($ty):\($v)" else empty end)
                elif $ty == "ref" then (if $v == "" then "ref needs a prefix, e.g. ref:CLM" else empty end)
                elif $ty == "num" then (if ($v | test("^[0-9]+$") | not) then "num needs a digit count, e.g. num:9" else empty end)
                else "unknown slot type \($ty)" end
            end)
        else empty end),
        (if $t.label == "violation" then
           (if ($t.categories | length) == 0 then "violation needs categories" else empty end),
           ($t.categories[] | select(IN($viol_cats[]) | not) | "unknown or non-violation category \(.)"),
           ($t.categories[] | select(IN(ids[]) or IN(pii_text[])) as $c | select(($t.text | slots | map(parts? // {t:"?"}) | map(.t)) | index($c) | not) | "category \($c) has no {{\($c)}} slot")
         elif $t.label == "clean" then
           (if ($t.categories | length) == 0 then "clean needs a neg-* category" else empty end),
           ($t.categories[] | select(IN($neg_cats[]) | not) | "clean category must be neg-*: \(.)")
         else "label must be violation or clean" end),
        (if ($t.difficulty | IN("easy","medium","hard") | not) then "bad difficulty" else empty end),
        (if ($t.shape | IN("oneliner","short","paragraph","document") | not) then "bad shape" else empty end),
        (if ($t.jurisdiction | IN("AU","US","none","mixed") | not) then "bad jurisdiction" else empty end),
        (if ($t.industry | IN($x.industries[]) | not) then "unknown industry" else empty end),
        (if ($file | startswith($t.industry)) | not then "industry does not match file name" else empty end),
        (if ($t.family_id | test("^" + $t.industry + "-(v|c)-[0-9]{3}$") | not) then "family_id must be <industry>-v-NNN or -c-NNN" else empty end),
        (if (($t.family_id | test("-v-")) and $t.label != "violation") or (($t.family_id | test("-c-")) and $t.label != "clean") then "family_id letter does not match label" else empty end),
        (if ($t.shape == "oneliner" and ($t.text | length) > 90) then "oneliner longer than 90 chars" else empty end),
        (if ($t.description | length) < 20 or ($t.description | length) > 300 then "description should be 20-300 chars" else empty end)
      ] | map("\($t.family_id // "?"): \(.)") | .[]
  ' "$f" 2>&1)
  dup=$(jq -r '.family_id' "$f" | sort | uniq -d)
  [ -n "$dup" ] && out="$out"$'\n'"duplicate family_id in $f: $dup"
  if [ -n "$out" ]; then echo "$f:"; echo "$out" | head -40; rc=1; else echo "$f: ok ($(wc -l < "$f" | tr -d ' ') templates)"; fi
done
exit $rc
