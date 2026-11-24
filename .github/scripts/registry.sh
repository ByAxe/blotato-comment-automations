#!/usr/bin/env bash

registry_digest() {
  local reference=$1 output
  if output="$(docker buildx imagetools inspect "$reference" --format '{{.Manifest.Digest}}' 2>&1)"; then
    if [[ $output =~ ^sha256:[0-9a-f]{64}$ ]]; then
      printf '%s\n' "$output"
      return 0
    fi
  elif [[ $output == *"$reference: not found" || $output == *"manifest unknown" ]]; then
    return 0
  fi
  printf 'Unable to resolve %s: %s\n' "$reference" "$output" >&2
  return 1
}

registry_promote() {
  local image=$1 digest=$2 reference existing
  shift 2
  local -a missing=()

  for reference in "$@"; do
    existing="$(registry_digest "$reference")" || return 1
    if [[ -z "$existing" ]]; then
      missing+=("$reference")
    elif [[ "$existing" != "$digest" ]]; then
      printf '::error::%s points to %s, but the staged digest is %s.\n' "$reference" "$existing" "$digest" >&2
      return 1
    fi
  done

  for reference in "${missing[@]}"; do
    docker buildx imagetools create --prefer-index=false --tag "$reference" "$image@$digest" || return 1
  done
  for reference in "$@"; do
    existing="$(registry_digest "$reference")" || return 1
    if [[ "$existing" != "$digest" ]]; then
      printf '::error::Could not confirm the staged digest %s at %s.\n' "$digest" "$reference" >&2
      return 1
    fi
  done
}
