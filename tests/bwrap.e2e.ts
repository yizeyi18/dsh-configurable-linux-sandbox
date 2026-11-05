/**
 * Real bwrap confinement. Skips when the host cannot create the namespaces
 * (for example a container with AppArmor-restricted unprivileged user
 * namespaces), matching the repository's own bwrap e2e policy.
 *
 * Workspaces and grant directories live under the platform temp root. The
 * provider's `workspace-write` profile mounts an ephemeral `/tmp`, and the
 * workspace bind is deeper than that tmpfs, so the workspace remains reachable
 * inside the sandbox.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LinuxBwrapSandboxProvider, { setSessionMountConfig } from '../src/index.ts'
import { bwrapProbeArgs } from '../src/mounts.ts'
import type { Config } from '../src/index.ts'
import { cleanupDirs, makeDir } from './support.ts'

const probe = spawnSync('bwrap', [...bwrapProbeArgs(), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const bwrapUsable = probe.status === 0

const contexts: Context[] = []

afterAll(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  cleanupDirs()
})

async function realProvider(config: Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LinuxBwrapSandboxProvider, config)
  return { ctx, provider: ctx.sandbox as LinuxBwrapSandboxProvider }
}

/** Confine and execute one shell command; never stub the probe in this suite. */
async function run(provider: LinuxBwrapSandboxProvider, command: string, policy: SandboxPolicy) {
  const confined = await provider.confine(['bash', '-c', command], policy)
  const program = confined.argv[0]
  if (program === undefined) throw new Error('confined argv is empty')
  const result = spawnSync(program, confined.argv.slice(1), {
    timeout: 30_000,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  })
  return { result, confined }
}

/** Quote one path for the bash command string. */
function quote(value: string): string {
  return JSON.stringify(value)
}

function workspacePolicy(workspaceRoot: string): SandboxPolicy {
  return { mode: 'workspace-write', workspaceRoot }
}

describe.skipIf(!bwrapUsable)('new-linux-sandbox: real bwrap confinement', () => {
  it('grants read_write, enforces read_only, hides forbidden content, and binds devices', async () => {
    const workspace = makeDir('new-linux-sandbox-e2e-ws-')
    const readWrite = makeDir('new-linux-sandbox-e2e-rw-')
    const readOnly = makeDir('new-linux-sandbox-e2e-ro-')
    const forbidden = makeDir('new-linux-sandbox-e2e-hidden-')
    const devPath = existsSync('/dev/dri') ? '/dev/dri' : existsSync('/dev/shm') ? '/dev/shm' : undefined
    writeFileSync(join(readOnly, 'readable'), 'readable')
    writeFileSync(join(forbidden, 'secret'), 'secret')
    const { provider } = await realProvider({
      read_write: [readWrite],
      read_only: [readOnly],
      forbidden: [forbidden],
      ...devPath === undefined ? {} : { dev: [devPath] },
    })
    const policy = workspacePolicy(workspace)

    const workspaceWrite = await run(provider, `printf ok > ${quote(join(workspace, 'ws.txt'))}`, policy)
    expect(workspaceWrite.result.status).toBe(0)
    expect(existsSync(join(workspace, 'ws.txt'))).toBe(true)

    const readWriteGrant = await run(provider, `printf ok > ${quote(join(readWrite, 'rw.txt'))}`, policy)
    expect(readWriteGrant.result.status).toBe(0)
    expect(existsSync(join(readWrite, 'rw.txt'))).toBe(true)

    const readOnlyRead = await run(provider, `cat ${quote(join(readOnly, 'readable'))}`, policy)
    expect(readOnlyRead.result.status).toBe(0)
    expect(readOnlyRead.result.stdout).toBe('readable')

    const readOnlyWrite = await run(provider, `printf no > ${quote(join(readOnly, 'denied.txt'))}`, policy)
    expect(readOnlyWrite.result.status).not.toBe(0)
    expect(readOnlyWrite.result.stderr.toLowerCase()).toContain('read-only file system')
    expect(existsSync(join(readOnly, 'denied.txt'))).toBe(false)

    const hiddenRead = await run(provider, `cat ${quote(join(forbidden, 'secret'))}`, policy)
    expect(hiddenRead.result.status).not.toBe(0)
    const hiddenList = await run(provider, `ls -A ${quote(forbidden)}`, policy)
    expect(hiddenList.result.status).toBe(0)
    expect(hiddenList.result.stdout.trim()).toBe('')
    expect(readFileSync(join(forbidden, 'secret'), 'utf8')).toBe('secret')

    if (devPath !== undefined) {
      const deviceRead = await run(provider, `test -e ${quote(devPath)}`, policy)
      expect(deviceRead.result.status).toBe(0)
    }

    const ephemeral = join('/tmp', `new-linux-sandbox-e2e-${process.pid}-${Date.now()}`)
    const tmpWrite = await run(provider, `printf ok > ${quote(ephemeral)}`, policy)
    expect(tmpWrite.result.status).toBe(0)
    expect(existsSync(ephemeral)).toBe(false)
  })

  it('denies writes to the workspace under read-only while keeping it readable', async () => {
    const workspace = makeDir('new-linux-sandbox-e2e-ws-')
    const file = join(workspace, 'existing.txt')
    writeFileSync(file, 'existing')
    const { provider } = await realProvider()

    const read = await run(provider, `cat ${quote(file)}`, { mode: 'read-only', workspaceRoot: workspace })
    expect(read.result.status).toBe(0)
    expect(read.result.stdout).toBe('existing')

    const write = await run(provider, `printf changed > ${quote(file)}`, { mode: 'read-only', workspaceRoot: workspace })
    expect(write.result.status).not.toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('existing')
  })

  it('re-exposes a read-only subtree under a forbidden ancestor', async () => {
    const parent = makeDir('new-linux-sandbox-e2e-parent-')
    const open = join(parent, 'open')
    mkdirSync(open)
    writeFileSync(join(open, 'visible'), 'visible')
    writeFileSync(join(parent, 'secret'), 'secret')
    const { provider } = await realProvider({ forbidden: [parent], read_only: [open] })
    const workspace = makeDir('new-linux-sandbox-e2e-ws-')
    const policy = workspacePolicy(workspace)

    const visible = await run(provider, `cat ${quote(join(open, 'visible'))}`, policy)
    expect(visible.result.status).toBe(0)
    expect(visible.result.stdout).toBe('visible')

    const listing = await run(provider, `ls -A ${quote(parent)}`, policy)
    expect(listing.result.status).toBe(0)
    expect(listing.result.stdout.trim()).toBe('open')
  })

  it('runs in a private PID namespace', async () => {
    const workspace = makeDir('new-linux-sandbox-e2e-ws-')
    const { provider } = await realProvider()
    const hostNamespace = readlinkSync('/proc/self/ns/pid')
    const result = await run(provider, 'readlink /proc/self/ns/pid', workspacePolicy(workspace))
    expect(result.result.status).toBe(0)
    expect(result.result.stdout.trim()).not.toBe('')
    expect(result.result.stdout.trim()).not.toBe(hostNamespace)
  })

  it('applies a session-scoped read_write grant to that session only', async () => {
    const workspace = makeDir('new-linux-sandbox-e2e-ws-')
    const grant = makeDir('new-linux-sandbox-e2e-session-')
    const { ctx, provider } = await realProvider()
    const session = ctx.sessions.create()
    const other = ctx.sessions.create()
    setSessionMountConfig(session, { read_write: [grant] })

    const granted = await run(provider, `printf ok > ${quote(join(grant, 'session.txt'))}`, {
      mode: 'workspace-write',
      workspaceRoot: workspace,
      sessionId: session.id,
    })
    expect(granted.result.status).toBe(0)
    expect(existsSync(join(grant, 'session.txt'))).toBe(true)

    const denied = await run(provider, `printf no > ${quote(join(grant, 'other.txt'))}`, {
      mode: 'workspace-write',
      workspaceRoot: workspace,
      sessionId: other.id,
    })
    expect(denied.result.status).not.toBe(0)
    expect(existsSync(join(grant, 'other.txt'))).toBe(false)
  })
})
