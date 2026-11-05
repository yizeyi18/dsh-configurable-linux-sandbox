# new-linux-sandbox

English | [中文](README.zh.md)

A configurable, Linux-only bwrap sandbox provider for DeepSeek Harness, packaged as a Cordis plugin.

This is the phase-one prototype requested for finer-grained file sandboxing. It mounts the same system resources as the built-in local sandbox — a read-only host root, a fresh `/dev`, and a private PID namespace with its own `/proc` — and adds four mount-intent keys that the built-in three-mode policy cannot express:

| Key | Meaning |
|---|---|
| `read_write` | Host directories outside the workspace exposed read-write under `workspace-write` (read-only under `read-only`). |
| `read_only` | Host directories outside the workspace exposed read-only in every mode. |
| `forbidden` | Host directories hidden by an empty tmpfs, so their contents are invisible inside the sandbox. |
| `dev` | Host device nodes or device directories under `/dev`, exposed with bwrap `--dev-bind`, for example `/dev/dri` for GPU access. |

The intent is configurable at two scopes: the plugin row's global configuration and a durable per-session override. Mounts follow prefix semantics regardless of scope: a deeper path wins over a shallower one, so a `forbidden` parent can hide a directory while a `read_only` child re-exposes one subtree.

## Table of Contents

- [Status and requirements](#status-and-requirements)
- [Configure the deployment](#configure-the-deployment)
- [Configure one session](#configure-one-session)
- [Mount order and precedence](#mount-order-and-precedence)
- [Isolation and security notes](#isolation-and-security-notes)
- [Build and test](#build-and-test)
- [Known limitations and next phase](#known-limitations-and-next-phase)

## Status and requirements

Phase one is a standalone package, not part of the repository workspace. It requires:

- Linux `process.platform === 'linux'`; the plugin constructor refuses to load on any other host.
- `bwrap` on `PATH`, able to create its namespaces. A functional probe runs once per provider lifetime; an unusable bwrap fails closed with `SANDBOX_UNAVAILABLE` and the command never starts.
- The DeepSeek Harness packages listed as peer dependencies, resolvable from the profile that mounts the plugin.
- The prototype is nested in a checkout: its `tsconfig.json` and `vitest.config.ts` reference the checkout root for source resolution, so building and testing require that layout.
- Node.js 24.9 or later to build and test in this checkout.

The provider reports `enforcement: 'full'` for every wrap: the bwrap mounts govern every promised file effect. Device access is not a file effect and is governed separately by the `dev` key (see [Isolation and security notes](#isolation-and-security-notes)).

## Configure the deployment

Mount the plugin in place of the built-in local provider. A profile patch disables the shipped `sandbox` row and inserts the new provider under a new id:

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: sandbox
  disabled: true
- insert:
    - id: sandbox-linux
      name: new-linux-sandbox
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

The example deliberately combines `forbidden: ['/home/me']` with grants under that directory: the tmpfs hides `/home/me`, then the deeper `read_write` and `read_only` entries re-expose their own subtrees. `read_write` entries must be physical paths (no symlinked grant); `read_only`, `forbidden`, and `dev` entries are canonicalized.

A full example lives in [`examples/cordis.patch.yml`](examples/cordis.patch.yml). The inserted `name` must resolve from the profile's package tree, so install or link the built package there before starting the profile.

### Field reference

| Field | Default | Meaning |
|---|---|---|
| `read_write` | `[]` | Absolute physical directories. Dropped to read-only under `read-only`; bind-mounted read-write under `workspace-write`. |
| `read_only` | `[]` | Absolute directories. Always bind-mounted read-only. |
| `forbidden` | `[]` | Absolute directories. Mounted as an empty tmpfs; a deeper entry can re-expose a subtree. |
| `dev` | `[]` | Absolute character/block device nodes or paths under `/dev`. Always `--dev-bind`, in both file modes. |
| `probeTimeoutMs` | `5000` | Positive timeout for the one functional bwrap probe. |

Path rules are enforced before bwrap starts:

- Every entry is absolute, NUL-free, and must exist when the command is confined.
- `read_write`, `read_only`, and `forbidden` require directories. `dev` accepts character/block device nodes and existing paths under `/dev` (device nodes or device directories); regular files, sockets, and arbitrary directories elsewhere are rejected.
- `read_write` must be spelled as its physical path (`realpath`), so validation and the bind name the same physical directory; an alias that exists at validation time is rejected, and a path swapped after validation remains a residual path-based race. The other keys resolve aliases.
- Listing `/` is rejected in every key; the base profile owns the root mount. `/dev`, `/proc`, and every path under `/proc` are reserved base mounts and are rejected in every key. Paths under `/dev` are accepted only by `dev`, so device exposure has one door.
- The same physical path may not appear in two keys. One path may appear in one key and as an ancestor/descendant of another; depth order decides the effective mount.
- A path that is listed but has disappeared fails the confined call with `LINUX_SANDBOX_INVALID_CONFIG`.

## Configure one session

Session scope is durable: the override is a `plugin:new-linux-sandbox/mounts` plugin record folded by the host-only `sandboxLinuxMounts` projection. The record is `ignorable` for readers that do not know this package, so current-format readers retain and skip it instead of refusing the log; this plugin folds it on replay, while format migrations retain plugin records only best-effort. It belongs to exactly one session and is never part of the model transcript. A stored record that fails validation makes confined calls fail closed instead of silently falling back to the global configuration.

```ts
import type { Session } from '@deepseek-ai/dsh-session'
import { setSessionMountConfig } from 'new-linux-sandbox'

function grantGpuAndDocs(session: Session): void {
  setSessionMountConfig(session, {
    read_write: ['/home/me/.cache/huggingface'],
    read_only: ['/home/me/datasets'],
    forbidden: ['/home/me/.ssh'],
    dev: ['/dev/dri'],
  })
}
```

Semantics:

- Each call appends one record carrying the complete session override. The last record wins; two sessions never share state.
- A key present in the event replaces the global list for that key. An omitted key inherits the global list.
- An explicit empty array clears one global key for that session.
- `setSessionMountConfig(session, {})` returns the session to the deployment configuration.
- The write path validates paths are absolute and well-formed before appending; filesystem existence and availability are rechecked at each confined call, so a deleted directory fails closed rather than silently widening or narrowing the policy.
- Keys are replaced independently, so narrowing an inherited grant to read-only requires clearing the other key: global `read_write: [X]` plus session `{ read_write: [], read_only: [X] }` works, while `{ read_only: [X] }` alone collides with the inherited `read_write: [X]` and fails closed.
- A session override cannot remove the policy's `additionalWritableRoots`; those are seam-level grants appended under `workspace-write` after the session and global lists.
- A confined call whose policy names a session the live store no longer holds fails with `LINUX_SANDBOX_SESSION_UNAVAILABLE`; it never falls back to the global configuration. This provider needs the live `Session` object to read the projection, so a policy carrying `sessionId` cannot be served for a detached session.

There is no Web UI or tool for this write path in phase one. A host UI, a tool plugin, or a session bootstrap can call it with a `Session` it already owns.

## Mount order and precedence

The returned argv starts with `bwrap`, then the built-in isolation prefix, then mounts sorted by path depth and then by path:

```text
bwrap
--ro-bind / /
--dev /dev
--unshare-pid
--proc /proc
--die-with-parent
<effective mounts: shallower paths first, deeper paths override>
```

`workspace` is always mounted once — read-write under `workspace-write`, read-only under `read-only` — so a `forbidden` ancestor cannot hide the session's own cwd. Under `workspace-write` an ephemeral `--tmpfs /tmp` is added after the base prefix unless an explicit entry (in any key) already names `/tmp`. Extras from the policy's `additionalWritableRoots` are appended to the writable set under `workspace-write` and grant nothing under `read-only`, matching the seam contract.

Depth ordering is the whole precedence rule. Examples:

```yaml
# Hide the home tree but keep two subtrees.
forbidden: [/home/me]
read_only: [/home/me/datasets]
read_write: [/home/me/projects]

# Make one subdirectory read-only inside a writable tree.
read_write: [/home/me/projects]
read_only: [/home/me/projects/vendor]
```

Contradictory same-path declarations (`read_write` and `forbidden` for the same physical path, two keys naming the workspace, or a policy extra root that contradicts a configured `forbidden` entry) fail before the runner starts.

## Isolation and security notes

The isolation prefix mirrors the built-in Linux profile: a read-only host root, a fresh `/dev`, a private PID namespace, and a `/proc` mounted from that namespace. Network, UTS, IPC, and cgroup namespaces stay shared with the host; the sandbox shares the host kernel, user, and filesystem. It confines file effects, not network or process visibility.
The fresh `/dev` contains only bwrap's minimal device set, so host paths such as `/dev/dri` or `/dev/shm` are absent until listed under `dev`.

`dev` uses `--dev-bind`, which allows device access. Device access is not a file effect: the two file modes do not gate it, and an exposed device (or a writable `/dev`-tree path such as `/dev/shm`) can write memory or storage outside the mounted file policy. The provider restricts the key to character/block devices and paths under `/dev`, but that is a kind check, not a capability check: treat `dev` as an explicit operator grant and keep its list minimal. GPU passthrough usually needs only `/dev/dri`.

Like every same-world mount sandbox, this is path-based confinement. A device, an inherited file descriptor, a hard link created while an ancestor was writable, or a kernel interface outside the mounted filesystem can bypass path-level intent. The provider does not claim otherwise.

Phase one wraps processes only. The repository's filesystem tools are governed by their own fs enforcement; `read_write` grants here apply to confined processes (bash and other `ctx.sandbox` consumers), not to separate fs-tool policy. Wiring the same intent into the fs seam is phase-two work.

## Build and test

From the repository checkout root:

```sh
npm --prefix new-linux-sandbox run typecheck
npm --prefix new-linux-sandbox run test
npm --prefix new-linux-sandbox run build
```

`test` runs the unit and Cordis-composition suites plus a real-bwrap e2e suite. The e2e suite self-skips when the host cannot create the namespaces, matching the repository's own bwrap tests; restricted hosts (for example containers with AppArmor-restricted unprivileged user namespaces) skip the e2e cases while the argv, lifecycle, and session suites still run.

The build emits `lib/types/` (declarations and JavaScript from `tsc -b`) and bundles the plugin entry into `lib/index.js` with tsdown. Harness packages, `zod`, and `@deepseek-ai/schemastery` stay external.

To load the built plugin by absolute path from this checkout without installing it into a profile, link the checkout's peer packages into the package's own `node_modules`:

```sh
npm --prefix new-linux-sandbox run link
```

The inserted row may then name the built entry directly:

```yaml
- insert:
    - id: sandbox-linux
      name: /absolute/path/to/deepseek-harness/new-linux-sandbox/lib/index.js
      config:
        read_only: [/home/me/datasets]
```

[`scripts/link-local-deps.sh`](scripts/link-local-deps.sh) only links packages from this checkout; a packaged installation resolves its declared dependencies normally. Re-run it after moving the checkout.

Source map:

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry and `ctx.sandbox` provider: config, workspace/mode resolution, bwrap probe, wrap. |
| [`src/paths.ts`](src/paths.ts) | Shape validation and physical-path resolution, including symlink policy and cross-key conflicts. |
| [`src/mounts.ts`](src/mounts.ts) | Mount planning, depth ordering, and bwrap argv rendering. |
| [`src/session.ts`](src/session.ts) | Plugin-record declaration, projection unit, and the `setSessionMountConfig` write path. |
| [`src/types.ts`](src/types.ts) | Public configuration and mount-plan types. |
| [`tests/`](tests) | Unit, composition, and real-bwrap suites. |

## Known limitations and next phase

- Linux only; one fixed bwrap runner. Custom runner argv, Landlock, Seatbelt, and Windows backends are not covered.
- The functional bwrap probe is cached for the provider lifetime; installing or repairing bwrap requires reloading the plugin (or restarting the profile).
- The workspace is re-mounted read-only under `read-only` (so a `forbidden` ancestor cannot hide the session cwd), which requires it to exist even in that mode. A deleted workspace fails the call.
- Session overrides are plugin records: a build without this plugin skips them, and Session format migrations retain plugin records only best-effort, so a dropped record reverts that session to the deployment configuration. A declared in-repo session event would be required for a stronger durability promise.
- Network, UTS, IPC, and cgroup namespaces remain shared, exactly like the built-in Linux profile.
- The filesystem tool seam is not wired to the four keys; `read_write` widens process confinement only.
- There is no client, host UI, or model-facing tool for session configuration in phase one; the exported write path targets host plugins.
- The package is `private` and standalone. Installing it into a profile requires making its peer packages resolvable from that profile.
- Moving this package into the harness workspace requires registering `plugin:new-linux-sandbox/mounts` in the production plugin-record catalog (or replacing it with a declared session event after a format review).
- Real-namespace coverage depends on the host allowing unprivileged user namespaces; restricted hosts skip the e2e suite.
