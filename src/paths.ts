/**
 * Mount-intent validation and physical-path resolution. Two stages share one
 * vocabulary: {@link normalizeMountConfig} is the durable/config boundary
 * check (shape, absolute paths, NUL bytes) and {@link resolveMountConfig}
 * additionally touches the filesystem (existence, directory kind, symlink
 * policy, cross-key conflicts). Confinement always runs the second stage
 * before bwrap starts, so a broken or contradictory grant never reaches a
 * runner.
 *
 * @module dsh-configurable-linux-sandbox/paths
 */

import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { LinuxSandboxConfigError } from './errors.ts'
import type { MountConfig, ResolvedMountConfig } from './types.ts'

const MOUNT_KEYS = ['read_write', 'read_only', 'forbidden', 'dev'] as const

/** One mount-intent key. */
type MountKey = typeof MOUNT_KEYS[number]

const MOUNT_KEY_SET: ReadonlySet<string> = new Set(MOUNT_KEYS)

/** Base mounts the plugin owns: config may not replace the fresh /dev or the private /proc. */
const BASE_DEV = '/dev'
const BASE_PROC = '/proc'

/** Whether a path equals one base directory or lives below it. */
function isAtOrUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`)
}

/**
 * Whether one physical entry would replace or pierce a base isolation mount.
 * `/proc` is a new procfs in a private PID namespace, so any host proc path
 * re-introduces host process visibility. `/dev` is a fresh devtmpfs, so only
 * the `dev` key may expose paths below it (individual device nodes or device
 * directories), and the fresh root itself is never replaced.
 */
function assertNotBaseMount(physical: string, key: MountKey, origin: string): void {
  if (isAtOrUnder(physical, BASE_PROC)) {
    throw new LinuxSandboxConfigError(
      `${origin}: ${key} entry ${JSON.stringify(physical)} targets the private /proc mount and cannot be overridden`,
    )
  }
  if (isAtOrUnder(physical, BASE_DEV)) {
    if (key !== 'dev') {
      throw new LinuxSandboxConfigError(
        `${origin}: ${key} entry ${JSON.stringify(physical)} targets the fresh /dev mount; use the dev key for device paths`,
      )
    }
    if (physical === BASE_DEV) {
      throw new LinuxSandboxConfigError(`${origin}: dev must not list the root of the fresh /dev; list individual devices or device directories`)
    }
  }
}

/** Whether a value is a plain data object rather than null, an array, or a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Render an error's message without assuming it is an `Error`. */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reject one path string that is unsuitable as a mount entry independent of the filesystem. */
function assertAbsolutePath(entry: string, key: MountKey, origin: string): void {
  if (entry.length === 0 || entry.includes('\0') || !isAbsolute(entry)) {
    throw new LinuxSandboxConfigError(
      `${origin}: ${key} entry ${JSON.stringify(entry)} must be a non-empty absolute path without NUL bytes`,
    )
  }
}

/**
 * Validate and detach one mount config at a parser or durable boundary. This
 * stage does not touch the filesystem: entries may name paths created later,
 * and replaying a session record must stay independent of the current disk.
 * @param value - untrusted value (plugin config without the runner fields, or
 *   a replayed session record payload).
 * @param origin - caller-facing description used in error messages.
 * @returns a detached copy with frozen arrays and only the keys that were
 *   present on the input.
 * @throws {LinuxSandboxConfigError} when the value is not an object, contains
 *   an unknown key, or carries an entry that is not a non-empty absolute path.
 */
export function normalizeMountConfig(value: unknown, origin: string): MountConfig {
  if (!isPlainObject(value)) {
    throw new LinuxSandboxConfigError(
      `${origin}: expected an object with read_write/read_only/forbidden/dev, got ${value === null ? 'null' : typeof value}`,
    )
  }
  for (const key of Object.keys(value)) {
    if (!MOUNT_KEY_SET.has(key)) {
      throw new LinuxSandboxConfigError(
        `${origin}: unknown mount key ${JSON.stringify(key)} (expected read_write, read_only, forbidden, dev)`,
      )
    }
  }
  const result: MountConfig = {}
  for (const key of MOUNT_KEYS) {
    const entries: unknown = value[key]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) {
      throw new LinuxSandboxConfigError(`${origin}: ${key} must be an array of absolute path strings`)
    }
    const copy: string[] = []
    for (const entry of entries) {
      if (typeof entry !== 'string') {
        throw new LinuxSandboxConfigError(`${origin}: ${key} entries must be strings, got ${typeof entry}`)
      }
      assertAbsolutePath(entry, key, origin)
      copy.push(entry)
    }
    Object.freeze(copy)
    result[key] = copy
  }
  return Object.freeze(result)
}

/**
 * Resolve one normalized mount intent to the physical paths bwrap will mount.
 * Every entry must exist. `read_write` additionally rejects a spelling that
 * differs from the physical path, so an alias present at validation time
 * cannot stand in for the write grant. The read-only and forbidden lists canonicalize aliases; `dev` also
 * canonicalizes, but accepts only character/block device nodes or paths under
 * `/dev`. Distinct keys may not name the same physical path, and the base
 * profile's `/`, `/dev`, and `/proc` mount points are reserved.
 * @param config - mount intent, usually normalized already; this function
 *   normalizes again so direct callers get the same boundary checks.
 * @param origin - caller-facing description used in error messages.
 * @returns frozen, deduplicated physical paths per key.
 * @throws {LinuxSandboxConfigError} when an entry is malformed, missing, has
 *   the wrong file kind, uses a symlinked `read_write` spelling, or contradicts
 *   another key.
 */
export function resolveMountConfig(config: MountConfig, origin: string): ResolvedMountConfig {
  const normalized = normalizeMountConfig(config, origin)
  const owners = new Map<string, MountKey>()
  const resolved: Record<MountKey, string[]> = {
    read_write: [],
    read_only: [],
    forbidden: [],
    dev: [],
  }
  for (const key of MOUNT_KEYS) {
    const seen = new Set<string>()
    for (const entry of normalized[key] ?? []) {
      const physical = resolveEntry(entry, key, origin)
      if (key === 'read_write' && physical !== resolve(entry)) {
        throw new LinuxSandboxConfigError(
          `${origin}: read_write entry ${JSON.stringify(entry)} must be the physical directory path ${JSON.stringify(physical)}; symlinked grants are not supported`,
        )
      }
      if (seen.has(physical)) continue
      const owner = owners.get(physical)
      if (owner !== undefined && owner !== key) {
        throw new LinuxSandboxConfigError(
          `${origin}: ${JSON.stringify(physical)} is declared in both ${owner} and ${key}`,
        )
      }
      owners.set(physical, key)
      seen.add(physical)
      resolved[key].push(physical)
    }
  }
  return Object.freeze({
    read_write: Object.freeze(resolved.read_write),
    read_only: Object.freeze(resolved.read_only),
    forbidden: Object.freeze(resolved.forbidden),
    dev: Object.freeze(resolved.dev),
  })
}

/** Resolve and validate one mount entry against the filesystem. */
function resolveEntry(entry: string, key: MountKey, origin: string): string {
  if (entry === '/') {
    throw new LinuxSandboxConfigError(`${origin}: ${key} must not list the root directory; the sandbox mounts it read-only itself`)
  }
  assertAbsolutePath(entry, key, origin)
  let physical: string
  try {
    physical = realpathSync.native(entry)
  } catch (error) {
    throw new LinuxSandboxConfigError(`${origin}: ${key} entry ${JSON.stringify(entry)} cannot be resolved: ${detailOf(error)}`)
  }
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(physical)
  } catch (error) {
    throw new LinuxSandboxConfigError(`${origin}: ${key} entry ${JSON.stringify(entry)} cannot be inspected: ${detailOf(error)}`)
  }
  assertNotBaseMount(physical, key, origin)
  if (key === 'dev') {
    const device = stats.isCharacterDevice() || stats.isBlockDevice()
    if (!device && !physical.startsWith(`${BASE_DEV}/`)) {
      throw new LinuxSandboxConfigError(
        `${origin}: dev entry ${JSON.stringify(entry)} must be a character/block device or a path under /dev`,
      )
    }
  } else if (!stats.isDirectory()) {
    throw new LinuxSandboxConfigError(`${origin}: ${key} entry ${JSON.stringify(entry)} is not a directory`)
  }
  return physical
}
