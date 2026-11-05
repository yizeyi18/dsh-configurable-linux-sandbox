/**
 * The configurable bwrap process sandbox provider (`ctx.sandbox`). It reuses
 * the built-in Linux isolation prefix and asks `ctx.configurableSandbox` for
 * the effective, depth-ordered mount plan, so process confinement and the
 * filesystem provider enforce the same four keys.
 *
 * An unusable bwrap fails closed with `SANDBOX_UNAVAILABLE`; a bad mount plan
 * fails as a configuration error before the runner is probed or spawned.
 *
 * @module dsh-configurable-linux-sandbox/provider
 */

import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import {
  SandboxProvider,
  SandboxUnavailableError,
} from '@deepseek-ai/dsh-sandbox'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
// Type-only: supplies the configurableSandbox Context merge.
import type {} from './core.ts'
import { BWRAP_BASE_ARGS, bwrapProbeArgs, bwrapProfileArgs } from './mounts.ts'

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

/**
 * Configurable Linux bwrap sandbox provider. It validates nothing itself: the
 * deployment intent and session override belong to `ctx.configurableSandbox`,
 * and each call plans the effective mounts through that service.
 */
export class LinuxBwrapSandboxProvider extends SandboxProvider {
  static inject = ['configurableSandbox']

  /** Cached functional probe verdict; undefined until the first confined call. */
  private bwrapUsable: boolean | undefined

  /** Test hook (mirrors the built-in local provider's `internals`). */
  internals: SandboxInternals = {}

  /** @param ctx - Cordis context that owns the provider. */
  constructor(ctx: Context) {
    super(ctx)
    if (process.platform !== 'linux') {
      throw new Error(`dsh-configurable-linux-sandbox: this provider is Linux-only; the current platform is ${process.platform}`)
    }
  }

  /**
   * Wrap `argv` in the ordered bwrap profile for `policy`. The policy's session
   * id selects the durable session override; without one, the deployment
   * configuration applies. The plan is built before the runner probe, so a bad
   * plan fails as a configuration error rather than as a runner failure.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @param signal - cancellation before any filesystem or probe work.
   * @returns the wrapped argv plus bwrap's enforcement and denial facts.
   * @throws {import('./errors.ts').LinuxSandboxConfigError} when a mount entry
   *   or the workspace is unusable, or two keys contradict each other.
   * @throws {import('./errors.ts').LinuxSandboxSessionUnavailableError} when the
   *   policy names a session the live store does not contain.
   * @throws {SandboxUnavailableError} when bwrap cannot create its profile.
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    const plan = this.ctx.configurableSandbox.plan(policy, undefined, { includeDefaultTmpfs: true })
    const args = [
      ...BWRAP_BASE_ARGS,
      ...bwrapProfileArgs(plan.entries),
      '--',
      ...argv,
    ]
    this.assertBwrap(policy.mode)
    return {
      argv: [BWRAP_PROGRAM, ...args],
      enforcement: 'full',
      denialSignatures: DENIAL_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE_RULES,
    }
  }

  /** Probe bwrap once per provider lifetime and fail closed when it is unusable. */
  private assertBwrap(mode: ConfinedSandboxMode): void {
    this.bwrapUsable ??= this.internals.probeBwrap?.() ?? this.probeBwrap()
    if (!this.bwrapUsable) {
      throw new SandboxUnavailableError(
        mode,
        'dsh-configurable-linux-sandbox requires bubblewrap (bwrap) on PATH and permission to create its namespaces',
      )
    }
  }

  /** Functional probe: the real isolation prefix around `true`. */
  private probeBwrap(): boolean {
    const timeout = this.ctx.configurableSandbox.probeTimeoutMs
    const probe = spawnSync(BWRAP_PROGRAM, [...bwrapProbeArgs(), '--', 'true'], {
      timeout,
      stdio: 'ignore',
    })
    return probe.status === 0
  }
}

export default LinuxBwrapSandboxProvider
