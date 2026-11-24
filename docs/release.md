# Container releases

Push a new `vMAJOR.MINOR.PATCH` tag on the commit to release. The tag must match the version in `package.json`. The [Release workflow](../.github/workflows/release.yml) runs the same verification job as branch CI against the tagged source.

1. Build the minimal runtime as one Linux amd64 and arm64 OCI image index. Push it to GHCR under a staging tag and record its digest.
2. Pull that digest on fresh native runners for both architectures. Apply migrations and start the API, worker and HTTP recording provider with a disposable PostgreSQL 17 instance. The smoke test checks image identity, authorization, duplicate events, restart recovery and three recorded actions. It also checks that an authorized control caller can read a redacted participant history and erase it.
3. Export both verified platform images and load them back to confirm their image IDs. Promote the tested index to the version and full commit SHA tags. Upload both archives and `SHA256SUMS`, confirm their checksums on GitHub, and publish the release.

The release notes record the source commit, workflow run and immutable image digest. The GHCR version and SHA tags are lookup names. Use the digest for deployment. The release job records whether an anonymous GHCR pull succeeded. [GitHub Releases](https://github.com/ByAxe/blotato-comment-automations/releases) provides public image archives even when the GHCR package requires authentication.

## Replay a release locally

Use Node.js 22 and Docker with Compose v2. Open the release and run the versioned commands in its notes. They download the archive for your architecture, verify it against `SHA256SUMS`, load it into Docker and run the smoke test with the matching source checkout.

If you have pull access to GHCR, you can replay the smoke test directly against the digest from the release notes. In the matching source checkout, use the smoke command from that release's notes and omit `--local`. The command in the current layout is

```sh
node ops/staging-smoke.mjs "$IMAGE_AT_DIGEST" "$RELEASE_COMMIT"
```

The checker binds the API and recorder to random loopback ports, uses disposable credentials and tears down the Compose project and test database. The staged workflow uses normalized synthetic events and a recording provider. A persistent installation needs PostgreSQL, account authorization and an adapter that implements the documented provider contract. [API configuration](api.md) · [Provider integration](integration.md).

## Retry and rollback

For a transient workflow failure, use **Re-run failed jobs** on the original workflow run. GitHub retains a successful build job’s digest output, so a partial promotion can resume with the same image. A full re-run rebuilds the image and fails promotion if an existing GHCR tag points to a different digest. An unfinished draft can resume uploading missing assets. The workflow checks published asset checksums against the staged archives and checksum file. For source changes, release a new version and keep the original tag on its original revision. [GitHub re-run behavior](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

For an installation rollback, use the digest and revision from the last compatible release. Confirm compatibility with the applied PostgreSQL migrations, take a database backup, and replace the API and worker together. Use the API health endpoint and a scoped application check after restart. If the older runtime cannot use the current schema safely, roll forward or restore from an authorized backup. Preserve outbox and reconciliation records so a restart cannot turn an uncertain delivery into a second send. [Delivery recovery](delivery-recovery.md).
