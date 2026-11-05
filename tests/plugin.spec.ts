/**
 * Real Cordis composition: a session store, the projection registry, and the
 * provider. The functional bwrap probe is stubbed, so this suite asserts the
 * resolved argv and the session-override lifecycle without requiring user
 * namespaces on the test host.
 */

import { realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SANDBOX_UNAVAILABLE } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SessionStore, { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import {
  LINUX_SANDBOX_SESSION_UNAVAILABLE,
  LinuxSandboxConfigError,
  SANDBOX_MOUNTS_RECORD,
  setSessionMountConfig,
} from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { ConfigurableSandboxCore } from '../src/core.ts'
import { MountAwareFileSystem } from '../src/fs.ts'
import { LinuxBwrapSandboxProvider } from '../src/provider.ts'
import { cleanupDirs, makeDir, mountProvider } from './support.ts'
import type { ProviderBench } from './support.ts'

const benches: ProviderBench[] = []

afterEach(async () => {
  for (const bench of benches.splice(0)) await bench.ctx.fiber.dispose()
  cleanupDirs()
})

async function mount(config: Config = {}): Promise<ProviderBench> {
  const bench = await mountProvider(config)
  benches.push(bench)
  return bench
}

function policy(
  workspaceRoot: string,
  mode: 'read-only' | 'workspace-write' = 'workspace-write',
  sessionId?: SessionId,
  additionalWritableRoots?: readonly string[],
): SandboxPolicy {
  return {
    mode,
    workspaceRoot,
    ...sessionId === undefined ? {} : { sessionId },
    ...additionalWritableRoots === undefined ? {} : { additionalWritableRoots },
  }
}

/** The bwrap profile prefix before the `--` command separator. */
function profile(argv: readonly string[]): string[] {
  const separator = argv.indexOf('--')
  return argv.slice(0, separator === -1 ? argv.length : separator)
}

/** Whether the profile carries one exact `flag source destination` mount. */
function hasMount(args: readonly string[], flag: string, path: string): boolean {
  for (let index = 0; index + 2 < args.length; index++) {
    if (args[index] === flag && args[index + 1] === path && args[index + 2] === path) return true
  }
  return false
}

/** Whether the profile carries one `--tmpfs path` mount. */
function hasTmpfs(args: readonly string[], path: string): boolean {
  for (let index = 0; index + 1 < args.length; index++) {
    if (args[index] === '--tmpfs' && args[index + 1] === path) return true
  }
  return false
}

describe('global mount configuration', () => {
  it('wraps the isolation prefix and every configured mount for workspace-write', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const readWrite = realpathSync(makeDir())
    const readOnly = realpathSync(makeDir())
    const forbidden = realpathSync(makeDir())
    const { provider } = await mount({ read_write: [readWrite], read_only: [readOnly], forbidden: [forbidden], dev: ['/dev/null'] })

    const confined = await provider.confine(['true'], policy(workspace))
    const args = profile(confined.argv)

    expect(confined.argv[0]).toBe('bwrap')
    expect(confined.argv.slice(0, 3)).toEqual(['bwrap', '--ro-bind', '/'])
    expect(confined.argv).toContain('--')
    expect(hasMount(args, '--bind', workspace)).toBe(true)
    expect(hasMount(args, '--bind', readWrite)).toBe(true)
    expect(hasMount(args, '--ro-bind', readOnly)).toBe(true)
    expect(hasTmpfs(args, forbidden)).toBe(true)
    expect(hasMount(args, '--dev-bind', '/dev/null')).toBe(true)
    expect(hasTmpfs(args, '/tmp')).toBe(true)
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toEqual(['read-only file system'])
    expect(confined.runnerFailureRules).toEqual([{ fatalSignatures: ['bwrap: '] }])

    const readOnlyArgs = profile((await provider.confine(['true'], policy(workspace, 'read-only'))).argv)
    expect(hasMount(readOnlyArgs, '--dev-bind', '/dev/null')).toBe(true)
  })

  it('downgrades read_write grants under read-only and drops the ephemeral /tmp', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const readWrite = realpathSync(makeDir())
    const { provider } = await mount({ read_write: [readWrite] })

    const args = profile((await provider.confine(['true'], policy(workspace, 'read-only'))).argv)

    expect(hasMount(args, '--bind', readWrite)).toBe(false)
    expect(hasMount(args, '--ro-bind', readWrite)).toBe(true)
    expect(hasMount(args, '--ro-bind', workspace)).toBe(true)
    expect(hasTmpfs(args, '/tmp')).toBe(false)
  })

  it('fails closed when the functional probe rejects bwrap', async () => {
    const { provider } = await mount()
    provider.internals.probeBwrap = () => false
    await expect(provider.confine(['true'], policy(realpathSync(makeDir()))))
      .rejects.toMatchObject({ code: SANDBOX_UNAVAILABLE })
    await expect(provider.confine(['true'], policy(realpathSync(makeDir()))))
      .rejects.toThrow(/bubblewrap/)
  })

  it('re-validates a configured path when a confined call runs after it disappeared', async () => {
    const removed = realpathSync(makeDir())
    const { provider } = await mount({ read_only: [removed] })
    rmSync(removed, { recursive: true, force: true })
    await expect(provider.confine(['true'], policy(realpathSync(makeDir()))))
      .rejects.toThrow(/cannot be resolved/)
  })

  it('rejects a workspace root inside the private base mounts', async () => {
    const { provider } = await mount()
    await expect(provider.confine(['true'], policy('/proc'))).rejects.toThrow(/reserved base mount/)
    await expect(provider.confine(['true'], policy('/dev/shm'))).rejects.toThrow(/reserved base mount/)
  })

  it('reports a mount-plan conflict as a config error before probing the runner', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const { provider } = await mount({ forbidden: [workspace] })
    provider.internals.probeBwrap = () => false
    await expect(provider.confine(['true'], policy(workspace))).rejects.toBeInstanceOf(LinuxSandboxConfigError)
  })

  it('rejects a workspace root that is not a directory', async () => {
    const workspace = join(realpathSync(makeDir()), 'missing')
    const { provider } = await mount()
    await expect(provider.confine(['true'], policy(workspace))).rejects.toThrow(/workspace root/)
  })
})

describe('session mount configuration', () => {
  it('overrides a global key for its own session only', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const globalReadOnly = realpathSync(makeDir())
    const sessionReadOnly = realpathSync(makeDir())
    const { ctx, provider } = await mount({ read_only: [globalReadOnly] })
    const session = ctx.sessions.create()
    setSessionMountConfig(session, { read_only: [sessionReadOnly] })

    const sessionArgs = profile((await provider.confine(['true'], policy(workspace, 'workspace-write', session.id))).argv)
    const agentlessArgs = profile((await provider.confine(['true'], policy(workspace))).argv)

    expect(hasMount(sessionArgs, '--ro-bind', sessionReadOnly)).toBe(true)
    expect(hasMount(sessionArgs, '--ro-bind', globalReadOnly)).toBe(false)
    expect(hasMount(agentlessArgs, '--ro-bind', globalReadOnly)).toBe(true)
  })

  it('inherits global keys the session override omits', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const globalReadOnly = realpathSync(makeDir())
    const sessionReadWrite = realpathSync(makeDir())
    const { ctx, provider } = await mount({ read_only: [globalReadOnly] })
    const session = ctx.sessions.create()
    setSessionMountConfig(session, { read_write: [sessionReadWrite] })

    const args = profile((await provider.confine(['true'], policy(workspace, 'workspace-write', session.id))).argv)

    expect(hasMount(args, '--bind', sessionReadWrite)).toBe(true)
    expect(hasMount(args, '--ro-bind', globalReadOnly)).toBe(true)
  })

  it('treats an explicit empty list as clearing that global key', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const globalReadWrite = realpathSync(makeDir())
    const { ctx, provider } = await mount({ read_write: [globalReadWrite] })
    const session = ctx.sessions.create()
    setSessionMountConfig(session, { read_write: [] })

    const args = profile((await provider.confine(['true'], policy(workspace, 'workspace-write', session.id))).argv)

    expect(hasMount(args, '--bind', globalReadWrite)).toBe(false)
  })

  it('restores the global configuration after an empty override', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const globalReadOnly = realpathSync(makeDir())
    const { ctx, provider } = await mount({ read_only: [globalReadOnly] })
    const session = ctx.sessions.create()
    setSessionMountConfig(session, { read_only: [realpathSync(makeDir())] })
    setSessionMountConfig(session, {})

    const args = profile((await provider.confine(['true'], policy(workspace, 'workspace-write', session.id))).argv)

    expect(hasMount(args, '--ro-bind', globalReadOnly)).toBe(true)
  })

  it('folds an override recorded before the provider was mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: makeDir() })
    const session = ctx.sessions.create()
    const recorded = realpathSync(makeDir())
    setSessionMountConfig(session, { read_only: [recorded] })
    await ctx.plugin(ConfigurableSandboxCore, {})
    await ctx.plugin(LinuxBwrapSandboxProvider)
    await ctx.plugin(MountAwareFileSystem)
    const provider = ctx.sandbox as LinuxBwrapSandboxProvider
    provider.internals.probeBwrap = () => true
    benches.push({ ctx, provider })

    const args = profile((await provider.confine(
      ['true'],
      policy(realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-')), 'workspace-write', session.id),
    )).argv)

    expect(hasMount(args, '--ro-bind', recorded)).toBe(true)
  })

  it('keeps concurrent sessions on their own overrides', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const first = realpathSync(makeDir())
    const second = realpathSync(makeDir())
    const { ctx, provider } = await mount()
    const firstSession = ctx.sessions.create()
    const secondSession = ctx.sessions.create()
    setSessionMountConfig(firstSession, { read_only: [first] })
    setSessionMountConfig(secondSession, { read_only: [second] })

    const firstArgs = profile((await provider.confine(['true'], policy(workspace, 'workspace-write', firstSession.id))).argv)
    const secondArgs = profile((await provider.confine(['true'], policy(workspace, 'workspace-write', secondSession.id))).argv)

    expect(hasMount(firstArgs, '--ro-bind', first)).toBe(true)
    expect(hasMount(firstArgs, '--ro-bind', second)).toBe(false)
    expect(hasMount(secondArgs, '--ro-bind', second)).toBe(true)
  })

  it('rejects a session override that names a session the store no longer holds', async () => {
    const { provider } = await mount()
    await expect(provider.confine(
      ['true'],
      policy(realpathSync(makeDir()), 'workspace-write', SessionId('missing-session')),
    )).rejects.toMatchObject({ code: LINUX_SANDBOX_SESSION_UNAVAILABLE })
  })

  it('fails closed when the session log carries a malformed mount record', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const { ctx, provider } = await mount()
    const session = ctx.sessions.create()
    // Durable-boundary injection; the typed write path cannot produce this.
    appendPluginRecord(session, SANDBOX_MOUNTS_RECORD, { read_only: 42 } as never)

    await expect(provider.confine(['true'], policy(workspace, 'workspace-write', session.id)))
      .rejects.toThrow(/mount record is invalid/)
  })

  it('rejects a session read_write grant behind a symlink at call time', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const target = realpathSync(makeDir())
    const link = join(makeDir(), 'link')
    symlinkSync(target, link)
    const { ctx, provider } = await mount()
    const session = ctx.sessions.create()
    setSessionMountConfig(session, { read_write: [link] })

    await expect(provider.confine(['true'], policy(workspace, 'workspace-write', session.id)))
      .rejects.toThrow(/physical directory path/)
  })
})

describe('policy extra writable roots', () => {
  it('grants them under workspace-write and ignores them under read-only', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const extra = realpathSync(makeDir())
    const { provider } = await mount()

    const writable = profile((await provider.confine(['true'], policy(workspace, 'workspace-write', undefined, [extra]))).argv)
    const readOnly = profile((await provider.confine(['true'], policy(workspace, 'read-only', undefined, [extra]))).argv)

    expect(hasMount(writable, '--bind', extra)).toBe(true)
    expect(hasMount(readOnly, '--bind', extra)).toBe(false)
    expect(hasMount(readOnly, '--ro-bind', extra)).toBe(false)
  })

  it('rejects an extra root that contradicts a forbidden entry', async () => {
    const workspace = realpathSync(makeDir('dsh-configurable-linux-sandbox-ws-'))
    const extra = realpathSync(makeDir())
    const { provider } = await mount({ forbidden: [extra] })

    await expect(provider.confine(['true'], policy(workspace, 'workspace-write', undefined, [extra])))
      .rejects.toThrow(/declared in both/)
  })
})

describe('plugin lifecycle', () => {
  it('rejects an unusable configured directory before mounting', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: makeDir() })
      await expect(ctx.plugin(ConfigurableSandboxCore, { read_only: [join(makeDir(), 'missing')] }))
        .rejects.toBeInstanceOf(LinuxSandboxConfigError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a non-positive probe timeout', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: makeDir() })
      await expect(ctx.plugin(ConfigurableSandboxCore, { probeTimeoutMs: 0 }))
        .rejects.toThrow(/positive finite/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('unregisters its service on disposal', async () => {
    const { ctx } = await mount()
    await ctx.fiber.dispose()
    expect(ctx.get('sandbox')).toBeUndefined()
  })
})
