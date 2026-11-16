# Register a local runner

The operator can enroll a runner for the installation and repository configured on the control service. This registers a revocable identity. Review execution still uses the control host while the job lease transport is being integrated.

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

## Revoke an identity

On the control host, use the runner ID reported by enrollment.

```sh
pnpm dev:control --revoke-runner RUNNER_UUID
```

Revocation applies only within the configured installation and repository. Subsequent status checks reject the identity. The operator can then remove the private identity file from the runner.
