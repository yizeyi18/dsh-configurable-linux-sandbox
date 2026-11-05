/**
 * Mount-aware filesystem enforcement: the four keys fence reads, listings, and
 * mutations in the same depth order as the process sandbox, while preserving
 * the inherited mode/workspace policy.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MountAwareFileSystem } from '../src/fs.ts'
import { setSessionMountConfig } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { cleanupDirs, makeDir, mountProvider } from './support.ts'
import type { ProviderBench } from './support.ts'

const benches: ProviderBench[] = []

afterEach(async () => {
  for (const bench of benches.splice(0)) await bench.ctx.fiber.dispose()
  cleanupDirs()
})

async function mount(config: Config = {}): Promise<ProviderBench & { fs: MountAwareFileSystem }> {
  const bench = await mountProvider(config)
  benches.push(bench)
  return { ...bench, fs: bench.ctx.fs as MountAwareFileSystem }
}

function policy(
  workspaceRoot: string,
  mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'workspace-write',
  sessionId?: SessionId,
): SandboxExecutionPolicy {
  return {
    mode,
    workspaceRoot,
    ...sessionId === undefined ? {} : { sessionId },
  }
}


describe('mount-aware filesystem', () => {
  it('reports the deployment default mode so tool schemas advertise the sandbox', async () => {
    const { fs } = await mount()
    expect(fs.sandboxMode).toBe('workspace-write')
  })

  it('keeps workspace writes under workspace-write and denies them under read-only', async () => {
    const workspace = makeDir('dsh-configurable-linux-sandbox-fs-ws-')
    const { fs } = await mount()
    const writable = join(workspace, 'written.txt')
    const readOnly = join(workspace, 'denied.txt')

    await fs.writeText(await fs.resolve(writable), 'ok', undefined, undefined, policy(workspace))
    await expect(fs.readText(await fs.resolve(writable))).resolves.toBe('ok')
    await expect(fs.writeText(await fs.resolve(readOnly), 'no', undefined, undefined, policy(workspace, 'read-only')))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('makes a read_write grant writable under workspace-write and read-only under read-only', async () => {
    const workspace = makeDir('dsh-configurable-linux-sandbox-fs-ws-')
    const grant = makeDir('dsh-configurable-linux-sandbox-fs-rw-')
    const { fs } = await mount({ read_write: [grant] })
    const target = join(grant, 'file.txt')

    await fs.writeText(await fs.resolve(target), 'ok', undefined, undefined, policy(workspace))
    await expect(fs.readText(await fs.resolve(target))).resolves.toBe('ok')

    const second = join(grant, 'second.txt')
    await expect(fs.writeText(await fs.resolve(second), 'no', undefined, undefined, policy(workspace, 'read-only')))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('allows reads from a read_only grant and denies writes', async () => {
    const workspace = makeDir('dsh-configurable-linux-sandbox-fs-ws-')
    const readOnly = makeDir('dsh-configurable-linux-sandbox-fs-ro-')
    writeFileSync(join(readOnly, 'existing.txt'), 'existing')
    const { fs } = await mount({ read_only: [readOnly] })

    await expect(fs.readText(await fs.resolve(join(readOnly, 'existing.txt')))).resolves.toBe('existing')
    await expect(fs.writeText(await fs.resolve(join(readOnly, 'new.txt')), 'no', undefined, undefined, policy(workspace)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('hides a forbidden directory from reads, listings, and writes', async () => {
    const hidden = makeDir('dsh-configurable-linux-sandbox-fs-hidden-')
    writeFileSync(join(hidden, 'secret.txt'), 'secret')
    const parent = makeDir('dsh-configurable-linux-sandbox-fs-parent-')
    const nested = join(parent, 'hidden')
    mkdirSync(nested)
    writeFileSync(join(nested, 'secret.txt'), 'secret')
    writeFileSync(join(parent, 'visible.txt'), 'visible')
    const { fs } = await mount({ forbidden: [hidden, nested] })

    await expect(fs.resolve(join(hidden, 'secret.txt'))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    const listing = await fs.listDir(await fs.resolve(parent))
    expect(listing.map(entry => entry.name)).toEqual(['visible.txt'])
  })

  it('re-exposes a read_only subtree under a forbidden ancestor', async () => {
    const parent = makeDir('dsh-configurable-linux-sandbox-fs-parent-')
    const open = join(parent, 'open')
    mkdirSync(open)
    writeFileSync(join(parent, 'secret.txt'), 'secret')
    writeFileSync(join(open, 'visible.txt'), 'visible')
    const { fs } = await mount({ forbidden: [parent], read_only: [open] })

    await expect(fs.readText(await fs.resolve(join(open, 'visible.txt')))).resolves.toBe('visible')
    await expect(fs.resolve(join(parent, 'secret.txt'))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('uses a session override for reads and leaves another session on the global configuration', async () => {
    const hidden = makeDir('dsh-configurable-linux-sandbox-fs-hidden-')
    writeFileSync(join(hidden, 'secret.txt'), 'secret')
    const bench = await mount({ read_only: [hidden] })
    const { ctx, fs } = bench

    const allowed = ctx.sessions.create()
    const restricted = ctx.sessions.create()
    setSessionMountConfig(restricted, { read_only: [], forbidden: [hidden] })
    let current = allowed
    ctx.provide('agents', { currentInitiator: () => ({ session: current }) } as never)

    await expect(fs.readText(await fs.resolve(join(hidden, 'secret.txt')))).resolves.toBe('secret')
    current = restricted
    await expect(fs.resolve(join(hidden, 'secret.txt'))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })

    const plain = ctx.sessions.create()
    current = plain
    await expect(fs.readText(await fs.resolve(join(hidden, 'secret.txt')))).resolves.toBe('secret')
  })

  it('skips mount fencing under danger-full-access', async () => {
    const workspace = makeDir('dsh-configurable-linux-sandbox-fs-ws-')
    const outside = makeDir('dsh-configurable-linux-sandbox-fs-outside-')
    const { fs } = await mount({ read_only: [outside] })
    const target = join(outside, 'full-access.txt')

    await fs.writeText(await fs.resolve(target), 'ok', undefined, undefined, policy(workspace, 'danger-full-access'))
    await expect(fs.readText(await fs.resolve(target))).resolves.toBe('ok')
  })

  it('denies a move whose destination is read-only', async () => {
    const workspace = makeDir('dsh-configurable-linux-sandbox-fs-ws-')
    const readOnly = makeDir('dsh-configurable-linux-sandbox-fs-ro-')
    const source = join(workspace, 'source.txt')
    writeFileSync(source, 'source')
    const { fs } = await mount({ read_only: [readOnly] })

    await expect(fs.moveFile(
      await fs.resolve(source),
      await fs.resolve(join(readOnly, 'moved.txt')),
      {},
      undefined,
      policy(workspace),
    )).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })
})
