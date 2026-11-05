# dsh-configurable-linux-sandbox

English | [中文](README.zh.md)

A Linux-only DeepSeek Harness bundle that replaces the built-in process sandbox **and** filesystem sandbox with one mount-aware pair, configured by four keys and editable per session from the Web UI.

| Key | Meaning |
|---|---|
| `read_write` | Host directories outside the workspace exposed read-write under `workspace-write` (read-only under `read-only`). |
| `read_only` | Host directories outside the workspace exposed read-only in every mode. |
| `forbidden` | Host directories hidden behind an empty tmpfs in the process sandbox and denied/filtered by the filesystem provider. |
| `dev` | Character/block device nodes or paths under `/dev` exposed with bwrap `--dev-bind`, for example `/dev/dri` for GPU access. |

The deployment config lives on the bundle's one plugin row. Every session can override any key from a Session-header button; the override is a durable session plugin record and applies to the next confined command and the next filesystem operation.

## Table of Contents

- [Requirements](#requirements)
- [Install](#install)
- [Configure the deployment](#configure-the-deployment)
- [Configure one session in the Web UI](#configure-one-session-in-the-web-ui)
- [What is enforced](#what-is-enforced)
- [Mount order and precedence](#mount-order-and-precedence)
- [Isolation and security notes](#isolation-and-security-notes)
- [Build, test, and publish](#build-test-and-publish)
- [Known limitations](#known-limitations)

## Requirements

- Linux (`process.platform === 'linux'`); the bundle declares `dsh.bundle.platforms: ["linux"]`, so other hosts skip it and keep the built-in providers.
- A base-backed Harness profile (`web`, `headless`, `sdk`, or `acp`). The bundle's patch disables the shipped `sandbox` and `fs-sandbox` rows and inserts its own row; do not install it into a composition that already mounts another `ctx.sandbox` or `ctx.fs` provider.
- `bwrap` on `PATH` with permission to create its namespaces. A functional probe runs once per provider lifetime; an unusable bwrap fails closed with `SANDBOX_UNAVAILABLE`.
- DeepSeek Harness `^0.2.2-rc.1` (enforced by `engines.dsh` and the DSH peer ranges).

## Install

From npm, after the package is published:

```sh
dsh plugin --profile web add dsh-configurable-linux-sandbox
```

Restart the profile. The bundle layer is appended after the base and Web layers, so its patch disables `sandbox` and `fs-sandbox` and inserts the `configurable-sandbox` row. Turn the whole bundle off to restore the built-ins; disabling only the inserted row leaves the profile without a process or filesystem provider.

For development from this checkout, build and install the package into a profile as a local link:

```sh
npm --prefix dsh-configurable-linux-sandbox run build
dsh plugin --profile web add link:/absolute/path/to/dsh-configurable-linux-sandbox
```

The profile row must name the package (the bundle patch does this) so the client-module scan can find its `dsh.client` half. An absolute `lib/index.js` row is useful for Host-only debugging but does not load the Web UI, because subpath/file rows are not client rows. [`scripts/link-local-deps.sh`](scripts/link-local-deps.sh) additionally links this checkout's runtime peers into the package for direct Host loading; a packaged installation resolves its declared peers normally.

## Configure the deployment

The bundle row's config is the deployment-wide mount intent:

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

A profile patch replaces the whole row config, so restate every field you keep. [`examples/cordis.patch.yml`](examples/cordis.patch.yml) is a complete example.

| Field | Default | Meaning |
|---|---|---|
| `read_write` | `[]` | Absolute physical directories. Read-write under `workspace-write`; read-only under `read-only`. |
| `read_only` | `[]` | Absolute directories exposed read-only in every mode. |
| `forbidden` | `[]` | Absolute directories hidden by an empty tmpfs; the filesystem provider denies reads under them. A deeper entry can re-expose a subtree. |
| `dev` | `[]` | Absolute character/block device nodes or paths under `/dev`. Always `--dev-bind`, in both file modes. |
| `probeTimeoutMs` | `5000` | Positive timeout for the one functional bwrap probe. |

Path rules are enforced before any command or filesystem operation:

- Every entry is absolute, NUL-free, and must exist.
- `read_write`, `read_only`, and `forbidden` require directories; `dev` accepts character/block devices and existing paths under `/dev` (device nodes or device directories).
- `read_write` must be spelled as its physical path (`realpath`); an alias present at validation time is rejected so the bind or containment check names the checked directory. The other keys canonicalize aliases.
- `/` is rejected in every key. `/dev`, `/proc`, and every path under `/proc` are reserved base mounts; `/dev` descendants are accepted only by `dev`. A workspace root under `/dev` or `/proc` is rejected too.
- The same physical path may not appear in two keys. Ancestor/descendant overlaps are allowed and resolved by depth order.
- A configured path that disappears fails the next operation with `LINUX_SANDBOX_INVALID_CONFIG` rather than silently widening or narrowing the policy.

## Configure one session in the Web UI

Open a session and click the gear button in the Session header. The modal shows the session mode, workspace, and one section per key:

- The **Override** checkbox includes that key in the session override; when unchecked, the deployment list applies and is shown read-only.
- Paths are individual rows with add/remove controls, so a path containing commas or spaces needs no encoding.
- **Save** writes the checked keys; an empty checked list clears that key for the session.
- **Reset to global** appends an empty override, returning the session to the deployment configuration.

The change applies to the next confined command and the next filesystem operation. It is durable: Save appends a `plugin:dsh-configurable-linux-sandbox/mounts` plugin record, which the Host folds on replay. The form uses an authenticated, owner-only route on the existing `/api` channel (`GET`/`POST /api/dsh-configurable-linux-sandbox/mounts`); it is not a new public API.

Host code can use the same write path:

```ts
import type { Session } from '@deepseek-ai/dsh-session'
import { setSessionMountConfig } from 'dsh-configurable-linux-sandbox'

function configureResearchSession(session: Session): void {
  setSessionMountConfig(session, {
    read_write: ['/home/me/.cache/huggingface'],
    read_only: ['/home/me/datasets'],
    forbidden: ['/home/me'],
    dev: ['/dev/dri'],
  })
}
```

Semantics:

- Each call appends one complete session override; the last record wins and two sessions never share state.
- A key present in the override replaces the deployment list for that key; an omitted key inherits the deployment list.
- An explicit empty array clears one deployment key for that session; `setSessionMountConfig(session, {})` resets all keys.
- Keys are independent, so narrowing an inherited grant requires clearing the other key: deployment `read_write: [X]` plus session `{ read_write: [], read_only: [X] }` works, while `{ read_only: [X] }` alone collides with the inherited `read_write: [X]` and fails closed.
- The phase-one record name `plugin:new-linux-sandbox/mounts` is still folded for existing sessions; new writes use the new name.
- A stored record whose payload fails validation makes the session's confined calls and filesystem operations fail closed instead of falling back to the deployment configuration.

## What is enforced

**Processes (`ctx.sandbox`).** The provider returns `bwrap` plus the built-in isolation prefix, then the ordered mounts. `workspace-write` binds the workspace and configured `read_write` paths writable and adds an ephemeral `/tmp`; `read-only` binds the workspace and `read_write` paths read-only. `forbidden` paths become empty tmpfs mounts, and `dev` paths use `--dev-bind`. Extra writable roots from `ctx.sandboxPolicy` are appended under `workspace-write` and grant nothing under `read-only`.

**Filesystem tools (`ctx.fs`).** The bundle replaces `dsh-fs-sandbox` with a provider that extends the same sandboxed backend. Mutations keep the deployment mode, workspace, `additionalWritableRoots`, and temp-area fence, and additionally deny writes under `forbidden` or `read_only` paths; `read_write` paths are added to the per-call writable roots. Reads, `stat`, `lstat`, `listDir`, `resolve`, and `watch` deny or filter `forbidden` paths, so the `read`, `write`, `edit`, `patch`, `delete`, `move`, and list tools share one boundary. Reads resolve the calling session from the Agent initiator scope; mutations trust the policy's `sessionId`.

`ctx.fs.sandboxMode` reports the deployment default mode, so `tool-fs` still advertises `sandbox_permissions` and escalation. An approved escalation is honored: `danger-full-access` skips mount fencing, as the process sandbox is not invoked in that mode.

## Mount order and precedence

The returned process argv starts with `bwrap`, then the built-in isolation prefix, then mounts sorted by path depth and path:

```text
bwrap
--ro-bind / /
--dev /dev
--unshare-pid
--proc /proc
--die-with-parent
<effective mounts: shallower paths first, deeper paths override>
```

The workspace is always mounted — writable under `workspace-write`, read-only under `read-only` — so a `forbidden` ancestor cannot hide the session's own cwd. The filesystem provider uses the same effective mount list without the ephemeral `/tmp`, so both enforcement paths resolve a path to the same deepest entry.

Depth ordering is the whole precedence rule:

```yaml
# Hide the home tree but keep two subtrees.
forbidden: [/home/me]
read_only: [/home/me/datasets]
read_write: [/home/me/projects]

# Make one subdirectory read-only inside a writable tree.
read_write: [/home/me/projects]
read_only: [/home/me/projects/vendor]
```

Contradictory same-path declarations fail before the runner starts. A policy `additionalWritableRoots` entry that contradicts a configured `forbidden` path is rejected rather than silently resolved.

## Isolation and security notes

The process profile mirrors the built-in Linux sandbox: a read-only host root, a fresh `/dev`, a private PID namespace, and a `/proc` mounted from that namespace. Network, UTS, IPC, and cgroup namespaces stay shared with the host; the sandbox shares the host kernel, user, and filesystem. It confines file effects, not network or process visibility. The fresh `/dev` contains only bwrap's minimal device set, so host paths such as `/dev/dri` or `/dev/shm` are absent until listed under `dev`.

`dev` uses `--dev-bind`, which allows device access. Device access is not a file effect: the two file modes do not gate it, and an exposed device (or a writable `/dev`-tree path such as `/dev/shm`) can write memory or storage outside the mounted file policy. The provider restricts the key to character/block devices and paths under `/dev`, but that is a kind check, not a capability check. Treat `dev` as an explicit operator grant and keep its list minimal.

Like every same-world sandbox, this is path-based confinement. A device, an inherited file descriptor, a hard link created while an ancestor was writable, or a kernel interface outside the mounted filesystem can bypass path-level intent. The provider does not claim otherwise.

The filesystem provider is a trusted-code fence over model-controlled paths, not a kernel boundary: reads are denied by the Host process, while untrusted code confinement remains the process sandbox's job.

## Build, test, and publish

From the checkout root:

```sh
npm --prefix dsh-configurable-linux-sandbox run typecheck
npm --prefix dsh-configurable-linux-sandbox run test
npm --prefix dsh-configurable-linux-sandbox run build
```

`test` runs unit, Cordis-composition, filesystem-enforcement, Web-route, client-render, and bundle-composition suites plus a real-bwrap e2e suite. The e2e suite self-skips when the host cannot create the namespaces, matching the repository's own bwrap tests. Run `build` before the client-artifact test if `lib/client.js` does not exist yet.

The build emits declarations and JavaScript with `tsc -b`, bundles the Host entry into `lib/index.js`, and emits the Client closure factory into `lib/client.js`. Harness packages and `zod` stay external for the Host face; the Client face externalizes only the shell's platform modules.

Publishing:

```sh
npm --prefix dsh-configurable-linux-sandbox run build
cd dsh-configurable-linux-sandbox
npm pack --dry-run
npm publish
```

`npm publish` needs an authenticated npm account. The package name is unscoped, so no `--access` flag is required. The published payload contains `lib/index.js`, `lib/client.js`, the declaration files, `cordis.patch.yml`, `locale/*.json`, the READMEs, and the license; it never contains sources, tests, or source maps.

Source map:

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Bundle entry: config schema and the three Host plugins. |
| [`src/core.ts`](src/core.ts) | Mount-configuration service, projection fold, and authenticated Web route. |
| [`src/provider.ts`](src/provider.ts) | bwrap process provider. |
| [`src/fs.ts`](src/fs.ts) | Mount-aware filesystem provider. |
| [`src/mounts.ts`](src/mounts.ts) | Mount planning, depth ordering, and bwrap argv rendering. |
| [`src/paths.ts`](src/paths.ts) | Shape validation and physical-path resolution. |
| [`src/session.ts`](src/session.ts) | Durable session record and projection definition. |
| [`src/contract.ts`](src/contract.ts) | Shared route path and Web-view vocabulary. |
| [`src/client/`](src/client) | Session-header action, modal form, locale dictionaries, and route client. |
| [`cordis.patch.yml`](cordis.patch.yml) | Bundle layer: disable built-ins and insert the bundle row. |
| [`tests/`](tests) | Unit, composition, fs, Web-route, client, and bundle suites. |

## Known limitations

- **`grep` and `glob` are not mount-aware.** They run ripgrep through `ctx.subprocess`, not `ctx.fs`, so a `forbidden` directory inside a searched tree can still be traversed by those two tools. The read/write/edit/list filesystem tools and all confined processes do honor the configuration.
- **Base-backed profiles only.** The bundle disables the shipped `sandbox`/`fs-sandbox` rows; a composition that already provides `ctx.sandbox` or `ctx.fs` from another bundle conflicts at service registration.
- **Linux and bwrap only.** Custom runner argv, Landlock, Seatbelt, and Windows are not covered. The functional probe is cached for the provider lifetime; installing or repairing bwrap requires a plugin reload or restart.
- **Network namespaces stay shared**, exactly like the built-in Linux profile.
- **Device access bypasses the file modes**, as described above.
- **`forbidden` is a visibility fence, not an inode capability boundary.** A hard link or an already-open descriptor outside the fence can still reach the same data.
- **Session overrides are plugin records.** A build without this plugin skips them, and Session format migrations retain plugin records only best-effort; a dropped record reverts that session to the deployment configuration. A declared in-repo session event would be required for a stronger durability promise.
- **The workspace must exist in both modes.** It is re-mounted read-only under `read-only` so a `forbidden` ancestor cannot hide the session cwd; a deleted workspace fails the call.
