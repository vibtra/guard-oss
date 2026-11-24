#!/usr/bin/env bash
set -euo pipefail

TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
cache="${FORMAL_TOOLS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/vibtra-formal}"
jar="$cache/tla2tools-$TLA_VERSION.jar"
java_bin="${JAVA:-java}"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1; else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}

covered_paths() {
  while read -r first rest; do
    [ "$first" = commit ] || echo "${rest:-$first}"
  done <"$1"
}

if [ "${1:-}" = "--sync" ]; then
  commit="$(git -C "$root" rev-parse HEAD)"
  for record in "$here"/*/sync.txt; do
    [ -f "$record" ] || continue
    model="$(basename "$(dirname "$record")")"
    paths=()
    while read -r path; do paths+=("$path"); done < <(covered_paths "$record")
    if ! git -C "$root" diff --quiet HEAD -- "${paths[@]}"; then
      echo "$model: the covered files have uncommitted changes. Commit them first, so the sync commit holds the code you checked the model against." >&2
      exit 2
    fi
    { echo "commit $commit"; for path in "${paths[@]}"; do echo "$(git -C "$root" rev-parse "HEAD:$path") $path"; done; } >"$record"
    echo "moved    $model: sync commit is now $commit"
  done
  exit 0
fi

stale=0
for record in "$here"/*/sync.txt; do
  [ -f "$record" ] || continue
  model="$(basename "$(dirname "$record")")"
  commit="$(sed -n 's/^commit //p' "$record")"
  changed=()
  while read -r blob path; do
    [ "$blob" != commit ] || continue
    if [ -z "$path" ] || [ ! -f "$root/$path" ] || [ "$(git -C "$root" hash-object -- "$path")" != "$blob" ]; then changed+=("${path:-$blob}"); fi
  done <"$record"
  if [ "${#changed[@]}" -gt 0 ]; then
    echo "STALE    $model: ${changed[*]} changed since the sync commit $commit."
    echo "         Re-check formal/$model against that change (its verify skill in .claude/skills/ says how), then move the sync with: formal/check.sh --sync"
    stale=1
  else
    echo "ok       $model: the covered files match the sync commit ${commit:0:7}"
  fi
done

if [ ! -f "$jar" ] || [ "$(sha256_of "$jar")" != "$TLA_SHA256" ]; then
  mkdir -p "$cache"
  curl -fsSL -o "$jar.part" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
  got="$(sha256_of "$jar.part")"
  if [ "$got" != "$TLA_SHA256" ]; then
    rm -f "$jar.part"
    echo "tla2tools.jar v$TLA_VERSION has SHA-256 $got, expected $TLA_SHA256. Not running it." >&2
    exit 2
  fi
  mv "$jar.part" "$jar"
fi

work="$(mktemp -d "${FORMAL_WORK_DIR:-$cache}/run.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if [ "$#" -gt 0 ]; then
  configs=("$@")
else
  configs=()
  for cfg in "$here"/*/*.cfg; do configs+=("$cfg"); done
fi

failed=0
for cfg in "${configs[@]}"; do
  cfg="$(cd "$(dirname "$cfg")" && pwd)/$(basename "$cfg")"
  dir="$(dirname "$cfg")"
  name="$(basename "$(dirname "$cfg")")/$(basename "$cfg" .cfg)"
  expect="$(sed -n 's/^\\\* expect: //p' "$cfg")"
  specs=("$dir"/*.tla)
  if [ -z "$expect" ] || [ "${#specs[@]}" -ne 1 ]; then
    echo "BROKEN   $name: needs one '\\* expect:' line and one .tla file beside it"
    failed=1
    continue
  fi
  log="$work/$(basename "$cfg" .cfg).log"
  status=0
  started="$(date +%s)"
  (cd "$dir" && "$java_bin" -XX:+UseParallelGC -Xmx"${FORMAL_HEAP:-768m}" -Djava.io.tmpdir="$work" -cp "$jar" tlc2.TLC \
    -workers "${FORMAL_WORKERS:-1}" -metadir "$work/meta-$(basename "$cfg" .cfg)" -config "$cfg" "$(basename "${specs[0]}")") >"$log" 2>&1 || status=$?
  states="$(sed -n 's/.* \([0-9]*\) distinct states found.*/\1/p' "$log" | tail -n 1)"
  took="$(( $(date +%s) - started ))s"
  if [ "$expect" = "pass" ]; then
    if [ "$status" -eq 0 ] && grep -q "Model checking completed. No error has been found." "$log"; then
      echo "ok       $name: passes, ${states:-?} distinct states, $took"
      [ -z "${FORMAL_VERBOSE:-}" ] || cat "$log"
      continue
    fi
  elif [ "$status" -ne 0 ] && grep -Eq "(Invariant|property) $expect is violated" "$log"; then
    depth="$(grep -c '^State [0-9]*:' "$log" || true)"
    echo "ok       $name: $expect fails as expected, counterexample of $depth states, $took"
    [ -z "${FORMAL_VERBOSE:-}" ] || cat "$log"
    continue
  fi
  echo "UNEXPECTED $name: expected '$expect', TLC exited $status"
  cat "$log"
  failed=1
done

[ "$stale" -eq 0 ] || failed=1
exit "$failed"
