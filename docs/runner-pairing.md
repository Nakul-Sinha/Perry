# Register a local runner

The operator can enroll a runner for the installation and repository configured on the control service. The runner claims work over outbound HTTPS and reviews pinned Git commits using its own local cache and selected model connection.

Use Linux or a Linux filesystem inside WSL for the identity files. The client verifies owner-only file permissions. Native Windows enrollment needs a later ACL implementation.

## Issue an enrollment code

On the configured control host, create a private directory and issue a code to a new file.

```sh
mkdir -m 700 /path/to/private-perry
pnpm dev:control --issue-pairing /path/to/private-perry/code
```

The operator command requires the configured database, installation ID and repository ID. It writes a single-use code valid for ten minutes. Transfer that file privately to the runner machine with mode 600. The control database stores the code digest. An expired or consumed code requires a new issuance.

## Enroll and check status

On the runner machine, create a private directory, place the code file there, and select a new identity file.

```sh
pnpm runner:pair --server https://your-perry-host.example --code-file /path/to/private-perry/code --identity /path/to/private-perry/identity
pnpm runner:status --identity /path/to/private-perry/identity
```

The server must be the HTTPS origin of the control service. Loopback HTTP is supported for local development. Forward the `/runners/` routes through the existing HTTPS proxy. Enrollment writes the private bearer identity directly to disk and prints its runner and repository identifiers. Remove the consumed code file after successful enrollment.

The client preserves an existing identity. Status checks verify its original server and scope. If an enrollment response is lost before the identity is saved, issue a new code and enroll again.

## Run reviews on the paired device

Set `PERRY_EXECUTION_MODE=remote` on the control host before starting it. Configure API models and selected runtime checks on the runner. The control service needs its database and GitHub App configuration.

After pairing, create a private cache directory on the runner device and start polling.

```sh
mkdir -m 700 /path/to/private-perry/cache
pnpm runner:serve --identity /path/to/private-perry/identity --cache /path/to/private-perry/cache
```

Choose one model flag, such as `--openai-model MODEL_ID`, and supply that provider's key privately to the runner process. Omitting model flags uses static review and source excerpts. Add `--test tests/total.test.mjs --module src/total.mjs` to use the supported rootless Node check for a verified same-repository PR.

Keep both workspace applications together when building or distributing Perry. The runner reuses the cache and assessment implementations from the matching control package. It has no database connection or GitHub comment-writing identity. The service releases a repository-scoped read grant after checking the request and lease.

Two control workers can process different PRs. Each PR retains its publication lock. Jobs have a 20-minute deadline, and leased work must renew every 15 seconds. A 90-second missed renewal makes the attempt stale. On a transient result-upload failure, the runner retries the same stored result within the attempt. Source or lease changes fence its result before publication.

A stopped runner leaves work available until its deadline. Restart it with the same identity to continue polling. The service marks an expired assessment incomplete. Request a fresh review to try again. Shutdown aborts the active child and leaves the durable job available for recovery.

## Revoke an identity

On the control host, use the runner ID reported by enrollment.

```sh
pnpm dev:control --revoke-runner RUNNER_UUID
```

Revocation applies only within the configured installation and repository. Subsequent status checks reject the identity. The operator can then remove the private identity file from the runner.
