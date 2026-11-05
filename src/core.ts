/**
 * The deployment's mount-configuration home (`ctx.configurableSandbox`): it
 * resolves the global mount intent, folds the durable per-session override,
 * plans the effective mount lists for both the process sandbox and the
 * filesystem provider, and serves the authenticated Web route the Client form
 * edits.
 *
 * One service owns the configuration so the process and filesystem enforcement
 * cannot drift; both providers call {@link ConfigurableSandboxCore.plan} or
 * {@link ConfigurableSandboxCore.resolvedFor} with the policy they received.
 *
 * @module dsh-configurable-linux-sandbox/core
 */

import { statSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import { canonicalPath, workspaceWritableRoots } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedSandboxMode, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
// Type-only: supplies the sandboxPolicy Context merge.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
// Type-only: supplies the connection Context merge used by the optional Web route.
import type {} from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { MOUNT_KEYS, WEB_API_PATH } from './contract.ts'
import type { MountsErrorBody, MountsView, ResolvedMountLists } from './contract.ts'
import { LinuxSandboxConfigError, LinuxSandboxSessionUnavailableError } from './errors.ts'
import { mountEntries } from './mounts.ts'
import { normalizeMountConfig, resolveMountConfig } from './paths.ts'
import { sandboxMountsProjection, setSessionMountConfig } from './session.ts'
import type { SandboxMountOverrideState } from './session.ts'
import type { MountConfig, MountEntry, ResolvedMountConfig, SandboxPluginConfig } from './types.ts'

/** Config keys owned by this plugin. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([...MOUNT_KEYS, 'probeTimeoutMs'])

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Resolved global and per-session mount configuration. */
    configurableSandbox: ConfigurableSandboxCore
  }
}

/** Reject a non-positive or non-finite probe bound; `spawnSync({ timeout: 0 })` means unbounded. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`dsh-configurable-linux-sandbox: ${name} must be a positive finite number`)
  }
}

/** Fail loudly on a config key no field owns instead of silently dropping a typo. */
function assertKnownConfigKeys(config: SandboxPluginConfig): void {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`dsh-configurable-linux-sandbox: unknown plugin config key ${JSON.stringify(key)}`)
    }
  }
}

/** Reject a workspace that would be mounted inside the fresh /dev or private /proc trees. */
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

/** Whether a value is a plain data object rather than null, an array, or a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Serialize one route answer. */
function json(value: MountsView | MountsErrorBody, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** One confined call's resolved workspace, physical lists, and ordered mounts. */
export interface MountPlan {
  /** Canonical workspace root. */
  workspaceRoot: string
  /** Effective physical mount intent. */
  config: ResolvedMountConfig
  /** Ordered effective mounts for bwrap or the filesystem fence. */
  entries: readonly MountEntry[]
}

/**
 * The mount-configuration service. It validates the deployment intent at load
 * and exposes the resolved plans and the Web route; it never spawns bwrap and
 * never performs filesystem mutations.
 */
export class ConfigurableSandboxCore extends Service {
  static inject = ['sessions', 'sessionProjections', 'sandboxPolicy']

  /** Positive timeout for the provider's one functional bwrap probe. */
  readonly probeTimeoutMs: number
  /** Deployment-wide intent, normalized and frozen. */
  readonly globalConfig: MountConfig
  private readonly globalResolved: ResolvedMountConfig
  private projection: ProjectionHandle<SandboxMountOverrideState> | undefined

  /**
   * @param ctx - Cordis context that owns the service and its projection.
   * @param config - deployment mount intent and the probe bound.
   */
  constructor(ctx: Context, config: SandboxPluginConfig) {
    super(ctx, 'configurableSandbox')
    assertKnownConfigKeys(config)
    this.probeTimeoutMs = config.probeTimeoutMs ?? 5_000
    assertPositiveFinite('probeTimeoutMs', this.probeTimeoutMs)
    this.globalConfig = normalizeMountConfig({
      read_write: config.read_write ?? [],
      read_only: config.read_only ?? [],
      forbidden: config.forbidden ?? [],
      dev: config.dev ?? [],
    }, 'plugin config')
    this.globalResolved = resolveMountConfig(this.globalConfig, 'plugin config')
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(sandboxMountsProjection)
    // The Web route exists only where an authenticated browser channel exists;
    // headless and SDK profiles never inject `connection` and stay unaffected.
    this.ctx.inject(['connection'], (scope) => {
      scope.effect(() => scope.connection.fetch.register({
        path: WEB_API_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: request => this.handleWebRequest(request),
      }), 'configurable-sandbox: mount-config route')
    })
  }

  /**
   * Resolve the workspace and physical lists for one policy, without ordering
   * mounts. Both providers and the Web view use this so mode, workspace, and
   * extra-root handling stay identical.
   * @param policy - per-call policy from `ctx.sandboxPolicy`.
   * @param session - calling session when the policy has no `sessionId`.
   * @returns the canonical workspace and effective physical lists.
   */
  resolvedFor(policy: SandboxExecutionPolicy, session?: Session): { workspaceRoot: string; config: ResolvedMountConfig } {
    const effectiveSession = this.sessionForPolicy(policy, session)
    const { workspaceRoot, extraWritableRoots } = this.resolveWorkspace(policy)
    const effective = this.effectiveConfigOf(effectiveSession)
    const config = resolveMountConfig({
      read_write: [...(effective.read_write ?? []), ...extraWritableRoots],
      read_only: [...(effective.read_only ?? [])],
      forbidden: [...(effective.forbidden ?? [])],
      dev: [...(effective.dev ?? [])],
    }, 'effective mount config')
    return { workspaceRoot, config }
  }

  /**
   * Build the ordered mounts for one confined call.
   * @param policy - confined per-call policy.
   * @param session - calling session when the policy has no `sessionId`.
   * @param options - `includeDefaultTmpfs: false` for the Host-side fs view.
   * @returns workspace, physical lists, and ordered mounts.
   */
  plan(
    policy: SandboxExecutionPolicy,
    session?: Session,
    options?: { includeDefaultTmpfs?: boolean },
  ): MountPlan {
    if (policy.mode === 'danger-full-access') {
      throw new LinuxSandboxConfigError('a danger-full-access policy has no confined mount plan')
    }
    const mode: ConfinedSandboxMode = policy.mode
    const { workspaceRoot, config } = this.resolvedFor(policy, session)
    const entries = mountEntries({ mode, workspaceRoot, config, ...options })
    return { workspaceRoot, config, entries }
  }

  /**
   * Describe one live session for the Web form.
   * @param session - live session whose policy and override are read.
   * @returns the global intent, session override, mode, and effective lists.
   * @throws {LinuxSandboxConfigError} when the stored override or a configured path is invalid.
   */
  describe(session: Session): MountsView {
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    const sessionConfig = this.sessionConfigOf(session)
    const overridden = MOUNT_KEYS.some(key => sessionConfig[key] !== undefined)
    const { config } = this.resolvedFor(policy, session)
    const effective: ResolvedMountLists = {
      read_write: [...config.read_write],
      read_only: [...config.read_only],
      forbidden: [...config.forbidden],
      dev: [...config.dev],
    }
    return {
      sessionId: String(session.id),
      cwd: policy.workspaceRoot,
      mode: policy.mode,
      global: this.globalConfig,
      session: overridden ? sessionConfig : null,
      effective,
    }
  }

  /**
   * The deployment-wide resolved lists, for diagnostics and tests.
   * @returns frozen physical lists.
   */
  global(): ResolvedMountConfig {
    return this.globalResolved
  }

  /**
   * Resolve one session's stored override. A malformed record fails closed.
   * @param session - session whose projection state is read.
   * @returns the normalized override, or `{}` without one.
   * @throws {LinuxSandboxConfigError} when the stored state is invalid.
   */
  sessionConfigOf(session: Session | undefined): MountConfig {
    if (session === undefined) return {}
    const projection = this.projection
    /* v8 ignore next 3 -- Service.init awaits the projection before consumers can call any method. */
    if (projection === undefined) {
      throw new Error('dsh-configurable-linux-sandbox: the session projection is not registered')
    }
    const state = projection.stateOf(session)
    if (state.invalid !== null) {
      throw new LinuxSandboxConfigError(
        `session ${JSON.stringify(String(session.id))} mount record is invalid: ${state.invalid}`,
      )
    }
    return state.config === null
      ? {}
      : normalizeMountConfig(state.config, `session ${JSON.stringify(String(session.id))} mount config`)
  }

  /**
   * Merge the deployment intent with one session's override per key.
   * @param session - session whose override applies.
   * @returns a detached effective intent.
   */
  effectiveConfigOf(session: Session | undefined): MountConfig {
    const sessionConfig = this.sessionConfigOf(session)
    return {
      read_write: [...(sessionConfig.read_write ?? this.globalConfig.read_write ?? [])],
      read_only: [...(sessionConfig.read_only ?? this.globalConfig.read_only ?? [])],
      forbidden: [...(sessionConfig.forbidden ?? this.globalConfig.forbidden ?? [])],
      dev: [...(sessionConfig.dev ?? this.globalConfig.dev ?? [])],
    }
  }

  /**
   * Append a complete session override.
   * @param session - session that owns the override.
   * @param config - mount intent; omitted keys inherit the deployment values.
   */
  setSessionConfig(session: Session, config: MountConfig): void {
    setSessionMountConfig(session, config)
  }

  /**
   * Restore one session to the deployment intent by appending `{}`.
   * @param session - session whose override is cleared.
   */
  clearSessionConfig(session: Session): void {
    setSessionMountConfig(session, {})
  }

  /** Resolve the session a call belongs to: the policy id outranks the ambient session. */
  private sessionForPolicy(policy: SandboxExecutionPolicy, session: Session | undefined): Session | undefined {
    if (policy.sessionId === undefined) return session
    const live = this.ctx.sessions.get(policy.sessionId)
    if (live === undefined) throw new LinuxSandboxSessionUnavailableError(String(policy.sessionId))
    return live
  }

  /** Resolve the canonical workspace and the policy's extra writable roots. */
  private resolveWorkspace(policy: SandboxExecutionPolicy): { workspaceRoot: string; extraWritableRoots: readonly string[] } {
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

  /** One live session by untrusted wire id. */
  private liveSession(id: string): Session | undefined {
    return this.ctx.sessions.get(SessionId(id))
  }

  /** Serve the authenticated mount-config route. */
  private async handleWebRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (request.method === 'GET') {
        const id = url.searchParams.get('sessionId')
        if (id === null || id === '') return json({ error: 'session-required' }, 400)
        const session = this.liveSession(id)
        if (session === undefined) return json({ error: 'session-unavailable' }, 409)
        return json(this.describe(session))
      }
      if (request.method === 'POST') {
        if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
          return json({ error: 'json-required' }, 415)
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ error: 'invalid-json' }, 400)
        }
        if (!isPlainObject(body)) return json({ error: 'invalid-body' }, 400)
        const id = body.sessionId
        if (typeof id !== 'string' || id === '') return json({ error: 'session-required' }, 400)
        const session = this.liveSession(id)
        if (session === undefined) return json({ error: 'session-unavailable' }, 409)
        if (body.reset === true) {
          this.clearSessionConfig(session)
          return json(this.describe(session))
        }
        if (!isPlainObject(body.config)) return json({ error: 'config-required' }, 400)
        this.setSessionConfig(session, normalizeMountConfig(body.config, 'web mount config'))
        return json(this.describe(session))
      }
      return json({ error: 'method-not-allowed' }, 405)
    } catch (error) {
      if (error instanceof LinuxSandboxConfigError) {
        return json({ error: 'invalid-config', detail: error.message }, 400)
      }
      if (error instanceof LinuxSandboxSessionUnavailableError) {
        return json({ error: 'session-unavailable' }, 409)
      }
      this.ctx.logger.warn(error)
      return json({ error: 'internal' }, 500)
    }
  }
}

export default ConfigurableSandboxCore
