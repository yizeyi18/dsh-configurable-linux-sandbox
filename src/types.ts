/**
 * Public types of the configurable Linux bwrap sandbox: the plugin and session
 * mount intent, plus the resolved mount plan the argv builder consumes.
 *
 * @module new-linux-sandbox/types
 */

/**
 * Mount intent shared by the plugin's global configuration and a session-level
 * override. Every entry is an absolute host path. The plugin resolves entries
 * to physical paths and validates them when a command is confined; session
 * scope treats an omitted key as "inherit the global list", while an explicit
 * empty array clears that list for the session.
 */
export interface MountConfig {
  /**
   * Host directories exposed read-write in `workspace-write` and read-only in
   * `read-only`. Entries must be physical directory paths: an alias present at
   * validation time is rejected so the bind names the checked directory; a swap
   * after validation remains a residual path-based race.
   */
  read_write?: string[] | undefined
  /** Host directories exposed read-only in every mode. */
  read_only?: string[] | undefined
  /**
   * Host directories hidden by an empty tmpfs. A deeper `read_only`,
   * `read_write`, or `dev` entry re-exposes its own subtree.
   */
  forbidden?: string[] | undefined
  /**
   * Host character/block device nodes or paths under `/dev`, exposed with bwrap
   * `--dev-bind`. Device access is outside the file-effect modes: an exposed
   * device stays available under `read-only` as well, and can act as a write
   * channel the mount policy does not govern.
   */
  dev?: string[] | undefined
}

/**
 * Plugin configuration: the deployment-wide mount intent plus runner
 * diagnostics. Every field has a schema default, so the loader may omit it.
 */
export interface Config {
  /** Host directories exposed read-write in `workspace-write` and read-only in `read-only`. */
  read_write?: string[]
  /** Host directories exposed read-only in every mode. */
  read_only?: string[]
  /** Host directories hidden by an empty tmpfs. */
  forbidden?: string[]
  /** Character/block device nodes or paths under `/dev`, exposed with `--dev-bind`. */
  dev?: string[]
  /** Positive timeout for the one functional bwrap probe (default 5,000 ms). */
  probeTimeoutMs?: number
}

/**
 * A validated mount intent: entries are physical absolute paths, deduplicated,
 * and free of cross-key conflicts. The arrays are frozen.
 */
export interface ResolvedMountConfig {
  /** Physical directories whose write capability depends on the mode. */
  readonly read_write: readonly string[]
  /** Physical directories exposed read-only. */
  readonly read_only: readonly string[]
  /** Physical directories hidden by an empty tmpfs. */
  readonly forbidden: readonly string[]
  /** Physical device nodes or `/dev`-tree paths exposed with `--dev-bind`. */
  readonly dev: readonly string[]
}

/** The bwrap mount operation one effective path uses. */
export type MountEntryKind = 'read-write' | 'read-only' | 'tmpfs' | 'dev'

/** One effective mount, after mode gating and workspace/default insertion. */
export interface MountEntry {
  /** The bwrap operation this path receives. */
  readonly kind: MountEntryKind
  /** Canonical absolute path used as both the bind source and destination. */
  readonly path: string
}
