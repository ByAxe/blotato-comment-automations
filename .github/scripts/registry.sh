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
