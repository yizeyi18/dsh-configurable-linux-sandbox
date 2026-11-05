/**
 * The bwrap mount plan. {@link mountEntries} folds one resolved mount intent
 * plus the call's mode, workspace, and policy extras into the effective ordered
 * mounts; {@link bwrapArgs} renders that plan as the argv prefix a caller
 * spawns before its own command.
 *
 * Order is semantic: bwrap applies mounts in argv order, so an entry sorts by
 * path depth and a deeper path overrides a shallower one. That is what lets a
 * `forbidden` directory hide a parent while a deeper `read_only`,
 * `read_write`, or `dev` entry re-exposes one subtree, and it keeps the
 * workspace bind above a `forbidden` ancestor.
 *
 * @module dsh-configurable-linux-sandbox/mounts
 */

import type { ConfinedSandboxMode } from '@deepseek-ai/dsh-sandbox'
import { LinuxSandboxConfigError } from './errors.ts'
import type { MountEntry, MountEntryKind, ResolvedMountConfig } from './types.ts'

/**
 * The isolation prefix shared with the repository's built-in Linux profile: a
 * read-only host root, a fresh `/dev`, and a private PID namespace with its own
 * `/proc`. Network, UTS, IPC, and cgroup namespaces stay shared. The caller's
 * command follows a `--` separator.
 */
export const BWRAP_BASE_ARGS: readonly string[] = [
  '--ro-bind', '/', '/',
  '--dev', '/dev',
  '--unshare-pid',
  '--proc', '/proc',
  '--die-with-parent',
]

/** Inputs of one effective mount plan. */
export interface MountPlanInput {
  /** File-effect mode; gates whether configured write grants stay writable. */
  mode: ConfinedSandboxMode
  /** Canonical workspace root the policy resolved for this call. */
  workspaceRoot: string
  /** Physical mount intent already validated by {@link resolveMountConfig}. */
  config: ResolvedMountConfig
  /**
   * Whether `workspace-write` adds the ephemeral `/tmp` tmpfs. Process
   * confinement wants it; the Host-side filesystem view operates on the real
   * filesystem and leaves `/tmp` alone unless a key names it.
   * @default true
   */
  includeDefaultTmpfs?: boolean
}

/** Number of path segments in one absolute path. */
function depth(path: string): number {
  return path.split('/').filter(segment => segment.length > 0).length
}

/**
 * Build the ordered effective mount list for one confined call.
 *
 * The workspace is always mounted: writable in `workspace-write`, read-only in
 * `read-only`, so a `forbidden` ancestor cannot hide the session's own cwd.
 * Configured `read_write` entries keep their write capability only in
 * `workspace-write`; `read_only` never writes; `forbidden` becomes an empty
 * tmpfs; `dev` stays a device bind in both modes because device access is
 * outside the file-effect vocabulary. `workspace-write` additionally mounts an
 * ephemeral `/tmp` unless an explicit entry (in any key) already names it.
 * @param input - mode, canonical workspace, and resolved mount intent.
 * @returns the effective mounts sorted by path depth then path.
 * @throws {LinuxSandboxConfigError} when an explicit entry contradicts the
 *   workspace mount (for example the workspace is also `forbidden`).
 */
export function mountEntries(input: MountPlanInput): readonly MountEntry[] {
  const byPath = new Map<string, MountEntryKind>()
  const entries: MountEntry[] = []
  const add = (kind: MountEntryKind, path: string): void => {
    const existing = byPath.get(path)
    if (existing === undefined) {
      byPath.set(path, kind)
      entries.push({ kind, path })
      return
    }
    if (existing !== kind) {
      throw new LinuxSandboxConfigError(
        `path ${JSON.stringify(path)} would receive both ${existing} and ${kind}`,
      )
    }
  }

  const writeKind: MountEntryKind = input.mode === 'workspace-write' ? 'read-write' : 'read-only'
  for (const path of input.config.read_write) add(writeKind, path)
  for (const path of input.config.read_only) add('read-only', path)
  for (const path of input.config.forbidden) add('tmpfs', path)
  for (const path of input.config.dev) add('dev', path)
  add(writeKind, input.workspaceRoot)
  if ((input.includeDefaultTmpfs ?? true) && input.mode === 'workspace-write' && !byPath.has('/tmp')) add('tmpfs', '/tmp')

  entries.sort((left, right) => {
    const difference = depth(left.path) - depth(right.path)
    if (difference !== 0) return difference
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
  return Object.freeze(entries)
}

/**
 * Render one effective mount list as bwrap profile arguments, excluding the
 * base prefix, the `--` separator, and the caller's command.
 * @param entries - ordered mounts from {@link mountEntries}.
 * @returns the mount arguments in list order.
 */
export function bwrapProfileArgs(entries: readonly MountEntry[]): string[] {
  const args: string[] = []
  for (const entry of entries) {
    switch (entry.kind) {
      case 'read-write':
        args.push('--bind', entry.path, entry.path)
        break
      case 'read-only':
        args.push('--ro-bind', entry.path, entry.path)
        break
      case 'tmpfs':
        args.push('--tmpfs', entry.path)
        break
      case 'dev':
        args.push('--dev-bind', entry.path, entry.path)
        break
      default: {
        const unknown: never = entry.kind
        throw new Error(`dsh-configurable-linux-sandbox: unknown mount kind ${String(unknown)}`)
      }
    }
  }
  return args
}

/**
 * Build the complete bwrap profile arguments (without the command) for one
 * plan: the isolation prefix followed by the effective mounts.
 * @param input - mode, canonical workspace, and resolved mount intent.
 * @returns argv intended to precede `-- <command>`.
 */
export function bwrapArgs(input: MountPlanInput): string[] {
  return [...BWRAP_BASE_ARGS, ...bwrapProfileArgs(mountEntries(input))]
}

/**
 * The functional probe profile: the isolation prefix alone. A passing probe
 * proves the host lets bwrap create its namespaces and fresh `/dev`; mount
 * intent is validated separately before every wrap.
 * @returns argv intended to precede `-- true`.
 */
export function bwrapProbeArgs(): string[] {
  return [...BWRAP_BASE_ARGS]
}
