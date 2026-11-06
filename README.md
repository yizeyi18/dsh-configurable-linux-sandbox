# dsh-configurable-linux-sandbox

English | [中文](README.zh.md)

A Linux-only DeepSeek Harness bundle that replaces the built-in process and filesystem sandboxes with one mount-aware pair. Configure it once per deployment and override it per session from the Web UI.

| Key | Meaning |
|---|---|
| `read_write` | Host directories outside the workspace, writable under `workspace-write` and read-only under `read-only`. |
| `read_only` | Host directories exposed read-only in every mode. |
| `forbidden` | Host directories hidden by an empty tmpfs and denied by the filesystem provider. |
| `dev` | Character/block devices or paths under `/dev`, exposed with `--dev-bind`; for example `/dev/dri` for GPU access. |

## Requirements

- Linux. The bundle declares `dsh.bundle.platforms: ["linux"]`; other hosts keep the built-in providers.
- A base-backed Harness profile (`web`, `headless`, `sdk`, or `acp`). Do not install it where another plugin already provides `ctx.sandbox` or `ctx.fs`.
- `bwrap` on `PATH` with permission to create namespaces. An unusable `bwrap` fails closed with `SANDBOX_UNAVAILABLE`.
- DeepSeek Harness `^0.2.2-rc.1`.

## Install

```sh
dsh plugin --profile web add dsh-configurable-linux-sandbox
```

The bundle patch disables the shipped `sandbox` and `fs-sandbox` rows and inserts `configurable-sandbox`. Enabling the bundle from the Web **Plugins** page applies the change live; otherwise it takes effect at the next start.

For a local checkout:

```sh
npm install
npm run build
dsh plugin --profile web add link:/absolute/path/to/dsh-configurable-linux-sandbox
```

Use the package name (as the bundle patch does) so the client half is found; a file or subpath row loads the Host side only.

## Deployment configuration

The bundle row config is the deployment-wide mount intent:

```yaml
- id: configurable-sandbox
  config:
    read_write:
      - /home/me/.cache/uv
      - /home/me/projects/shared
    read_only:
      - /home/me/datasets
      - /var/log
    forbidden:
      - /home/me
    dev:
      - /dev/dri
    probeTimeoutMs: 5000
```

A profile patch replaces the whole row config, so restate every field you keep. See [`examples/cordis.patch.yml`](examples/cordis.patch.yml) for a complete example.

`read_write`, `read_only`, `forbidden`, and `dev` default to `[]`; `probeTimeoutMs` defaults to `5000` and is the timeout for the one-time functional `bwrap` probe.

Path rules:

- Entries must be absolute, NUL-free, and existing. `read_write`, `read_only`, and `forbidden` require directories; `dev` accepts character/block devices and existing paths under `/dev`.
- `read_write` must use the physical path (`realpath`); the other keys canonicalize aliases.
- `/` is rejected. `/dev`, `/proc`, and everything under `/proc` are reserved; `/dev` descendants are allowed only in `dev`. A workspace under `/dev` or `/proc` is rejected.
- The same physical path cannot appear in two keys. Ancestor/descendant overlaps are allowed and resolved by depth.
- A path that disappears after configuration fails the next operation with `LINUX_SANDBOX_INVALID_CONFIG` instead of silently changing the policy.

## Per-session overrides

Open a session and click the gear button in the Session header. The modal shows the mode, workspace, and one section per key:

- **Override** includes a key in the session override; unchecked keys use the deployment list, shown read-only.
- Paths are added and removed as individual rows, so commas and spaces need no encoding.
- **Save** writes the checked keys; a checked but empty list clears that key for the session.
- **Reset to global** returns the session to the deployment configuration.

Changes apply to the next confined command and the next filesystem operation. They are durable: each save appends a `plugin:dsh-configurable-linux-sandbox/mounts` record, which the Host folds on replay.

Host code can use the same write path via `setSessionMountConfig(session, config)` from the package root. Each call appends a complete override: the last record wins, an omitted key inherits the deployment list, an empty array clears that key, and `{}` resets all keys. A stored record that fails validation makes the session fail closed for both confined commands and filesystem operations.

## What is enforced

**Processes (`ctx.sandbox`).** `workspace-write` binds the workspace and `read_write` paths writable and adds an ephemeral `/tmp`; `read-only` binds the workspace and `read_write` paths read-only. `forbidden` paths become empty tmpfs mounts, and `dev` paths use `--dev-bind`. Extra writable roots from `ctx.sandboxPolicy` are added only under `workspace-write`.

**Filesystem tools (`ctx.fs`).** The bundle replaces `dsh-fs-sandbox` with the same sandboxed backend plus mount fencing: writes under `forbidden` or `read_only` are denied, `read_write` is added to the per-call writable roots, and reads, `stat`, `lstat`, `listDir`, `resolve`, and `watch` deny or filter `forbidden` paths.

`ctx.fs.sandboxMode` still advertises `sandbox_permissions`; an approved `danger-full-access` escalation skips mount fencing, as the process sandbox is not invoked in that mode.

## Mount precedence

Mounts are sorted by path depth, then path; deeper entries override shallower ones. The workspace is always mounted, so a `forbidden` ancestor cannot hide the session's own working directory. Contradictory same-path declarations fail before the runner starts.

```yaml
# Hide home but keep two subtrees.
forbidden: [/home/me]
read_only: [/home/me/datasets]
read_write: [/home/me/projects]

# Make one subdirectory read-only inside a writable tree.
read_write: [/home/me/projects]
read_only: [/home/me/projects/vendor]
```

## Security notes

The process profile mirrors the built-in Linux sandbox: a read-only host root, a fresh `/dev`, a private PID namespace, and a `/proc` mounted from that namespace. Network, UTS, IPC, and cgroup namespaces remain shared with the host; the sandbox confines file effects, not network or process visibility.

`dev` uses `--dev-bind` and grants device access that the two file modes do not gate. An exposed device (or a writable `/dev` path such as `/dev/shm`) can write outside the mounted file policy. Treat `dev` as an explicit operator grant and keep it minimal.

This is path-based confinement, not a kernel boundary: devices, inherited file descriptors, hard links, and kernel interfaces outside the mounted filesystem can bypass path-level intent. The filesystem provider is a trusted-code fence over model-controlled paths; untrusted-code confinement remains the process sandbox's job.

## Development

```sh
npm install        # or npm ci
npm run typecheck
npm test
npm run build
```

`test` runs unit, composition, live-activation, filesystem, Web-route, client-render, and bundle suites plus a real-`bwrap` e2e suite that self-skips when namespaces are unavailable. Run `build` before the client-artifact test if `lib/client.js` does not exist.

The build emits declarations, bundles the Host entry into `lib/index.js`, and emits the Client closure factory into `lib/client.js`. To test against an unpublished DSH checkout, run `DSH_CHECKOUT=/path/to/deepseek-harness npm run link`; `npm install` restores the published packages.

Publish with:

```sh
npm run build
npm pack --dry-run
npm publish
```

## Known limitations

- **`grep` and `glob` are not mount-aware.** They run through `ctx.subprocess`, not `ctx.fs`, so a `forbidden` directory inside a searched tree can still be traversed.
- **Base-backed profiles only.** A composition that already provides `ctx.sandbox` or `ctx.fs` from another bundle conflicts at registration; an active third-party provider fails live activation with `LINUX_SANDBOX_PROVIDER_CONFLICT` instead of being replaced.
- **Linux and `bwrap` only.** Custom runner argv, Landlock, Seatbelt, and Windows are not covered. The probe is cached for the provider lifetime; installing or repairing `bwrap` requires a plugin reload or restart.
- **`forbidden` is a visibility fence, not an inode boundary.** A hard link or an already-open descriptor outside the fence can still reach the data.
- **Session overrides are plugin records.** A build without this plugin skips them, and session migrations keep them only best-effort; a dropped record reverts the session to the deployment configuration.
