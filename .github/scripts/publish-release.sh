#!/usr/bin/env bash
set -euo pipefail

tag=$GITHUB_REF_NAME
pin="$IMAGE@$DIGEST"
repo_url="$GITHUB_SERVER_URL/$GH_REPO"
repo_name="${GH_REPO#*/}"
notes="$RUNNER_TEMP/release-notes.md"
cd "$RUNNER_TEMP/release-assets"
files=(blotato-comment-automations-linux-{amd64,arm64}.tar.gz SHA256SUMS)

cat > "$notes" <<EOF
Container image \`$pin\` (Linux amd64 and arm64).

The tagged source passed the verification suite. Both architectures passed a deployed PostgreSQL, HTTP API, worker, and recording provider smoke test. [Source commit]($repo_url/commit/$GITHUB_SHA) · [Release workflow run]($repo_url/actions/runs/$GITHUB_RUN_ID).

$REGISTRY_ACCESS

### Run the release locally

Use Node.js 22 and Docker with Compose v2. The commands below load the verified Linux amd64 archive. Set \`arch=arm64\` on an Arm host.

\`\`\`sh
arch=amd64
base="$repo_url/releases/download/$tag"
archive="blotato-comment-automations-linux-\$arch.tar.gz"
curl -fsSLO "\$base/\$archive"
curl -fsSLO "\$base/SHA256SUMS"
grep -F "  \$archive" SHA256SUMS | shasum -a 256 -c -
docker image load --input "\$archive"
git clone --branch "$tag" --depth 1 "$repo_url.git"
cd "$repo_name"
node scripts/staging-smoke.mjs --local "$IMAGE:$tag" "$GITHUB_SHA"
\`\`\`

The smoke test sends synthetic events to an isolated recording provider and removes its containers and test database. [Deployment and rollback guide]($repo_url/blob/$GITHUB_SHA/docs/release.md).
EOF

read_release() {
  gh release view "$tag" --json apiUrl,body,isDraft,isPrerelease
}

check_release_identity() {
  jq -e --arg pin "$pin" --arg revision "$GITHUB_SHA" \
    '.isPrerelease == false and (.body | contains($pin) and contains($revision))' \
    <<< "$release" >/dev/null
}

if release="$(read_release 2>"$RUNNER_TEMP/release-lookup.err")"; then
  check_release_identity
  if [[ $(jq -r '.isDraft' <<< "$release") == true ]]; then
    gh release upload "$tag" "${files[@]}" --clobber
  fi
else
  if ! grep -Fxq 'release not found' "$RUNNER_TEMP/release-lookup.err"; then
    cat "$RUNNER_TEMP/release-lookup.err" >&2
    exit 1
  fi
  gh release create "$tag" "${files[@]}" --draft --verify-tag --title "$tag" --notes-file "$notes"
  release="$(read_release)"
  check_release_identity
fi

api_url="$(jq -er '.apiUrl' <<< "$release")"
release_assets() {
  gh api "$api_url" --jq '.assets'
}

if [[ $(jq -r '.isDraft' <<< "$release") == true ]]; then
  assets="$(release_assets)"
  for file in "${files[@]}"; do
    checksum="$(sha256sum "$file" | cut -d' ' -f1)"
    jq -e --arg name "$file" --arg digest "sha256:$checksum" \
      'any(.[]; .name == $name and .state == "uploaded" and .digest == $digest)' \
      <<< "$assets" >/dev/null
  done
  gh release edit "$tag" --draft=false --verify-tag
fi

release="$(read_release)"
check_release_identity
test "$(jq -r '.isDraft' <<< "$release")" = false
assets="$(release_assets)"
for file in "${files[@]}"; do
  url="$(jq -er --arg name "$file" \
    '.[] | select(.name == $name and .state == "uploaded" and .size > 0) | .browser_download_url' \
    <<< "$assets")"
  curl --fail --silent --show-error --location --head --retry 3 --retry-all-errors "$url" >/dev/null
done

printf '[Public release](%s/releases/tag/%s)\n\nVerified image %s\n' "$repo_url" "$tag" "$pin" >> "$GITHUB_STEP_SUMMARY"
