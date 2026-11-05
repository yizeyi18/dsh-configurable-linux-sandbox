/**
 * A configurable Linux bwrap sandbox provider.
 *
 * It implements the same `ctx.sandbox` seam as the built-in local provider and
 * reuses the same isolation prefix (read-only host root, fresh `/dev`, private
 * PID namespace and `/proc`), then applies four mount-intent keys on top:
 * `read_write`, `read_only`, `forbidden` (empty tmpfs), and `dev`
 * (`--dev-bind`). The intent is configured globally on the plugin row and can
 * be overridden per session through the durable `plugin:new-linux-sandbox/mounts` plugin record.
 *
 * Unlike the built-in provider this plugin is Linux-only and owns a fixed
 * bwrap runner; an unusable bwrap fails closed with `SANDBOX_UNAVAILABLE`
 * before any command starts.
 *
 * @module new-linux-sandbox
 */

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SandboxProvider,
  SandboxUnavailableError,
  canonicalPath,
  workspaceWritableRoots,
} from '@deepseek-ai/dsh-sandbox'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { LinuxSandboxConfigError, LinuxSandboxSessionUnavailableError } from './errors.ts'
import { bwrapArgs, bwrapProbeArgs } from './mounts.ts'
import { normalizeMountConfig, resolveMountConfig } from './paths.ts'
import { sandboxMountsProjection } from './session.ts'
import type { SandboxMountOverrideState } from './session.ts'
import type { Config, MountConfig, ResolvedMountConfig } from './types.ts'

export {
  LINUX_SANDBOX_INVALID_CONFIG,
  LINUX_SANDBOX_SESSION_UNAVAILABLE,
  LinuxSandboxConfigError,
  LinuxSandboxSessionUnavailableError,
} from './errors.ts'
export { BWRAP_BASE_ARGS } from './mounts.ts'
export { SANDBOX_MOUNTS_RECORD, setSessionMountConfig } from './session.ts'
export type { Config, MountConfig, MountEntry, MountEntryKind, ResolvedMountConfig } from './types.ts'

/** The mount-intent keys accepted by the plugin config and a session override. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'read_write',
  'read_only',
  'forbidden',
  'dev',
])

/** The plugin-only fields beyond the shared mount intent. */
const PLUGIN_ONLY_KEYS: ReadonlySet<string> = new Set(['probeTimeoutMs'])

/** The fixed Linux runner this provider probes and spawns. */
const BWRAP_PROGRAM = 'bwrap'

/** The bwrap denial dialect: a write into a read-only mount reports EROFS. */
const DENIAL_SIGNATURES: readonly string[] = ['read-only file system']

/** bwrap's fatal diagnostics never share the denied-write text. */
const RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = [{ fatalSignatures: ['bwrap: '] }]

/** Test hooks for probes; mirrors the built-in local provider's `internals`. */
export interface SandboxInternals {
  /** Replace the functional bwrap probe (used by composition tests that do not execute bwrap). */
  probeBwrap?: () => boolean
}

/** Reject a non-positive or non-finite probe bound; `spawnSync({ timeout: 0 })` means unbounded. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`new-linux-sandbox: ${name} must be a positive finite number`)
  }
}

/** Fail loudly on a config key no field owns instead of silently dropping a typo. */
function assertKnownConfigKeys(config: Config): void {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key) && !PLUGIN_ONLY_KEYS.has(key)) {
      throw new Error(`new-linux-sandbox: unknown plugin config key ${JSON.stringify(key)}`)
    }
  }
}

/** Reject a workspace that would be mounted inside the fresh /dev or the private /proc trees. */
function assertWorkspaceOutsideBaseMounts(path: string): void {
  if (path === '/dev' || path.startsWith('/dev/') || path === '/proc' || path.startsWith('/proc/')) {
    throw new LinuxSandboxConfigError(`workspace root ${JSON.stringify(path)} is inside a reserved base mount (/dev or /proc)`)
  }
}

/** Confirm the resolved workspace is a directory bwrap can bind. */
function assertWorkspaceDirectory(path: string): void {
  assertWorkspaceOutsideBaseMounts(path)
  let directory: boolean
  try {
    directory = statSync(path).isDirectory()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new LinuxSandboxConfigError(`workspace root ${JSON.stringify(path)} cannot be inspected: ${detail}`)
  }
  if (!directory) {
    throw new LinuxSandboxConfigError(`workspace root ${JSON.stringify(path)} is not a directory`)
  }
}

/**
 * Linux bwrap sandbox provider (`ctx.sandbox`). It validates the deployment
 * mount intent at load, folds a per-session override from the session log, and
 * wraps each confined argv in an ordered bwrap mount profile.
 */
export class LinuxBwrapSandboxProvider extends SandboxProvider {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    read_write: z.array(z.string()).default([]),
    read_only: z.array(z.string()).default([]),
    forbidden: z.array(z.string()).default([]),
    dev: z.array(z.string()).default([]),
    probeTimeoutMs: z.natural().default(5_000),
  })

  static inject = ['sessions', 'sessionProjections']

  /** Deployment mount intent resolved once; session keys override it at call time. */
  private readonly globalConfig: ResolvedMountConfig
  private readonly probeTimeoutMs: number
  private mountsProjection: ProjectionHandle<SandboxMountOverrideState> | undefined
  /** Cached functional probe verdict; undefined until the first confined call. */
  private bwrapUsable: boolean | undefined

  /** Test hook (mirrors the built-in local provider's `internals`). */
  internals: SandboxInternals = {}

  /**
   * @param ctx - Cordis context that owns the provider and its projection unit.
   * @param config - deployment mount intent and the probe bound.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (process.platform !== 'linux') {
      throw new Error(`new-linux-sandbox: this provider is Linux-only; the current platform is ${process.platform}`)
    }
    assertKnownConfigKeys(config)
    this.probeTimeoutMs = config.probeTimeoutMs as number
    assertPositiveFinite('probeTimeoutMs', this.probeTimeoutMs)
    this.globalConfig = resolveMountConfig({
      read_write: config.read_write ?? [],
      read_only: config.read_only ?? [],
      forbidden: config.forbidden ?? [],
      dev: config.dev ?? [],
    }, 'plugin config')
  }

  protected async [Service.init](): Promise<void> {
    this.mountsProjection = await this.ctx.sessionProjections.register(sandboxMountsProjection)
  }

  /**
   * Wrap `argv` in the ordered bwrap profile for `policy`. The policy's session
   * id selects the durable session override; without one, the deployment
   * configuration applies. Every configured path and the workspace are
   * validated before the runner probe, so a bad mount plan fails as a config
   * error rather than as a runner failure.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @param signal - cancellation before any filesystem or probe work.
   * @returns the wrapped argv plus bwrap's enforcement and denial facts.
   * @throws {LinuxSandboxConfigError} when a mount entry or the workspace is
   *   unusable, or when two keys contradict each other.
   * @throws {LinuxSandboxSessionUnavailableError} when the policy names a session
   *   the live store does not contain.
   * @throws {SandboxUnavailableError} when bwrap cannot create its profile.
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    const { workspaceRoot, extraWritableRoots } = this.resolveWorkspace(policy)
    const config = resolveMountConfig(
      this.effectiveMountConfig(policy, extraWritableRoots),
      'effective mount config',
    )
    const args = [...bwrapArgs({ mode: policy.mode, workspaceRoot, config }), '--', ...argv]
    // Plan first: a workspace/config contradiction is a configuration error,
    // not a runner failure, and must not depend on probe state.
    this.assertBwrap(policy.mode)
    return {
      argv: [BWRAP_PROGRAM, ...args],
      enforcement: 'full',
      denialSignatures: DENIAL_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE_RULES,
    }
  }

  /**
   * Resolve the workspace and the policy's extra writable roots. Under
   * `workspace-write` the shared helper canonicalizes the workspace and rejects
   * missing, non-directory, or symlinked extra roots, exactly like the built-in
   * bwrap profile; extra roots grant nothing under `read-only`.
   */
  private resolveWorkspace(policy: SandboxPolicy): { workspaceRoot: string; extraWritableRoots: readonly string[] } {
    if (policy.mode === 'workspace-write') {
      const roots = workspaceWritableRoots(policy)
      const workspaceRoot = roots[0]
      /* v8 ignore next 2 -- workspaceWritableRoots always returns the workspace under workspace-write. */
      if (workspaceRoot === undefined) {
        throw new LinuxSandboxConfigError('workspace-write policy resolved without a workspace root')
      }
      assertWorkspaceDirectory(workspaceRoot)
      return { workspaceRoot, extraWritableRoots: roots.slice(1) }
    }
    const workspaceRoot = canonicalPath(policy.workspaceRoot)
    assertWorkspaceDirectory(workspaceRoot)
    return { workspaceRoot, extraWritableRoots: [] }
  }

  /**
   * Merge the session override with the deployment configuration per key, then
   * append the policy's extra writable roots to `read_write`. A session key
   * wins even when it is an explicit empty list; policy extras always apply
   * under `workspace-write` because the seam promises them.
   */
  private effectiveMountConfig(policy: SandboxPolicy, extraWritableRoots: readonly string[]): MountConfig {
    const session = this.sessionMountConfig(policy.sessionId)
    return {
      read_write: [...(session.read_write ?? this.globalConfig.read_write), ...extraWritableRoots],
      read_only: [...(session.read_only ?? this.globalConfig.read_only)],
      forbidden: [...(session.forbidden ?? this.globalConfig.forbidden)],
      dev: [...(session.dev ?? this.globalConfig.dev)],
    }
  }

  /**
   * Read the calling session's override. The projection state is the complete
   * last event; a missing state means no override. Replayed payloads are
   * revalidated here because they crossed the durable log boundary.
   */
  private sessionMountConfig(sessionId: SessionId | undefined): MountConfig {
    if (sessionId === undefined) return {}
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) throw new LinuxSandboxSessionUnavailableError(String(sessionId))
    const projection = this.mountsProjection
    /* v8 ignore next 3 -- Service.init awaits the projection before consumers can call confine. */
    if (projection === undefined) {
      throw new Error('new-linux-sandbox: the session mount projection is not registered')
    }
    const state = projection.stateOf(session)
    if (state.invalid !== null) {
      throw new LinuxSandboxConfigError(
        `session ${JSON.stringify(String(sessionId))} mount record is invalid: ${state.invalid}`,
      )
    }
    return state.config === null
      ? {}
      : normalizeMountConfig(state.config, `session ${JSON.stringify(String(sessionId))} mount config`)
  }

  /** Probe bwrap once per provider lifetime and fail closed when it is unusable. */
  private assertBwrap(mode: ConfinedSandboxMode): void {
    this.bwrapUsable ??= this.internals.probeBwrap?.() ?? this.probeBwrap()
    if (!this.bwrapUsable) {
      throw new SandboxUnavailableError(
        mode,
        'new-linux-sandbox requires bubblewrap (bwrap) on PATH and permission to create its namespaces',
      )
    }
  }

  /** Functional probe: the real isolation prefix around `true`. */
  private probeBwrap(): boolean {
    const probe = spawnSync(BWRAP_PROGRAM, [...bwrapProbeArgs(), '--', 'true'], {
      timeout: this.probeTimeoutMs,
      stdio: 'ignore',
    })
    return probe.status === 0
  }
}

export default LinuxBwrapSandboxProvider
