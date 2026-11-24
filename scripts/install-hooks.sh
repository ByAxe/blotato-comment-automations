#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"
for name in pre-commit pre-push; do
  if [ ! -x ".githooks/$name" ]; then
    printf 'The repository %s hook is missing or is not executable.\n' "$name" >&2
    exit 1
  fi
done

if hooks_path=$(git config --get core.hooksPath); then
  if [ "$hooks_path" = .githooks ]; then
    printf '%s\n' 'This checkout already uses .githooks.'
    exit 0
  fi
  printf 'A configured hooks path is already in use (%s). No change made.\n' "$hooks_path" >&2
  exit 1
else
  config_status=$?
  if [ "$config_status" -ne 1 ]; then
    exit "$config_status"
  fi
fi

hooks_dir=$(git rev-parse --git-path hooks)
for hook in "$hooks_dir"/*; do
  case "$hook" in
    *.sample) continue ;;
  esac
  if [ -f "$hook" ] && [ -x "$hook" ]; then
    printf 'An existing Git hook is active (%s). No change made.\n' "$hook" >&2
    exit 1
  fi
done

git config --local core.hooksPath .githooks
printf '%s\n' 'Enabled .githooks for this repository.'
