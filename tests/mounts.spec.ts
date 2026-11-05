/**
 * Pure mount-plan tests: mode gating, workspace/default insertion, mount order,
 * and the argv spelling of each kind. These tests never spawn bwrap.
 */

import { describe, expect, it } from 'vitest'
import { LinuxSandboxConfigError } from '../src/index.ts'
import { BWRAP_BASE_ARGS, bwrapArgs, bwrapProfileArgs, mountEntries } from '../src/mounts.ts'
import type { ResolvedMountConfig } from '../src/types.ts'

/** Build one resolved config with empty lists unless overridden. */
function resolved(overrides: Partial<ResolvedMountConfig> = {}): ResolvedMountConfig {
  return {
    read_write: overrides.read_write ?? [],
    read_only: overrides.read_only ?? [],
    forbidden: overrides.forbidden ?? [],
    dev: overrides.dev ?? [],
  }
}

describe('mountEntries', () => {
  it('mounts only the workspace read-only under read-only', () => {
    expect(mountEntries({ mode: 'read-only', workspaceRoot: '/ws', config: resolved() }))
      .toEqual([{ kind: 'read-only', path: '/ws' }])
  })

  it('adds an ephemeral /tmp and a writable workspace under workspace-write', () => {
    const entries = mountEntries({ mode: 'workspace-write', workspaceRoot: '/ws', config: resolved() })
    expect(entries).toContainEqual({ kind: 'read-write', path: '/ws' })
    expect(entries).toContainEqual({ kind: 'tmpfs', path: '/tmp' })
  })

  it('downgrades configured read_write entries to read-only under read-only', () => {
    const entries = mountEntries({ mode: 'read-only', workspaceRoot: '/ws', config: resolved({ read_write: ['/grants'] }) })
    expect(entries).toContainEqual({ kind: 'read-only', path: '/grants' })
    expect(entries).not.toContainEqual({ kind: 'read-write', path: '/grants' })
  })

  it('keeps configured read_write entries writable under workspace-write', () => {
    const entries = mountEntries({ mode: 'workspace-write', workspaceRoot: '/ws', config: resolved({ read_write: ['/grants'] }) })
    expect(entries).toContainEqual({ kind: 'read-write', path: '/grants' })
  })

  it('renders each kind with its own bwrap operation', () => {
    const entries = mountEntries({
      mode: 'workspace-write',
      workspaceRoot: '/ws',
      config: resolved({ read_write: ['/grants'], read_only: ['/readable'], forbidden: ['/hidden'], dev: ['/dev/dri'] }),
    })
    expect(bwrapProfileArgs(entries)).toEqual(expect.arrayContaining([
      '--bind', '/grants', '/grants',
      '--ro-bind', '/readable', '/readable',
      '--tmpfs', '/hidden',
      '--dev-bind', '/dev/dri', '/dev/dri',
    ]))
  })

  it('orders an ancestor before its descendant so the deeper mount wins', () => {
    const entries = mountEntries({
      mode: 'workspace-write',
      workspaceRoot: '/ws',
      config: resolved({ forbidden: ['/home/user'], read_only: ['/home/user/project'] }),
    })
    const hidden = entries.findIndex(entry => entry.path === '/home/user')
    const reExposed = entries.findIndex(entry => entry.path === '/home/user/project')
    expect(hidden).toBeGreaterThanOrEqual(0)
    expect(reExposed).toBeGreaterThan(hidden)
  })

  it('lets an explicit /tmp entry replace the default ephemeral /tmp', () => {
    const entries = mountEntries({
      mode: 'workspace-write',
      workspaceRoot: '/ws',
      config: resolved({ read_only: ['/tmp'] }),
    })
    expect(entries).toContainEqual({ kind: 'read-only', path: '/tmp' })
    expect(entries).not.toContainEqual({ kind: 'tmpfs', path: '/tmp' })
  })

  it('does not duplicate a workspace that is also configured read-write', () => {
    const entries = mountEntries({
      mode: 'workspace-write',
      workspaceRoot: '/ws',
      config: resolved({ read_write: ['/ws'] }),
    })
    expect(entries.filter(entry => entry.path === '/ws')).toEqual([{ kind: 'read-write', path: '/ws' }])
  })

  it('rejects a workspace that is also configured with a contradictory kind', () => {
    expect(() => mountEntries({
      mode: 'workspace-write',
      workspaceRoot: '/ws',
      config: resolved({ forbidden: ['/ws'] }),
    })).toThrow(LinuxSandboxConfigError)
    expect(() => mountEntries({
      mode: 'workspace-write',
      workspaceRoot: '/ws',
      config: resolved({ forbidden: ['/ws'] }),
    })).toThrow(/would receive both/)
  })

  it('keeps the workspace visible under a forbidden ancestor', () => {
    const entries = mountEntries({
      mode: 'workspace-write',
      workspaceRoot: '/home/user/project',
      config: resolved({ forbidden: ['/home/user'] }),
    })
    const hidden = entries.findIndex(entry => entry.path === '/home/user')
    const workspace = entries.findIndex(entry => entry.path === '/home/user/project')
    expect(workspace).toBeGreaterThan(hidden)
  })
})

describe('bwrapArgs', () => {
  it('prefixes the isolation base and separates the command later', () => {
    expect(bwrapArgs({ mode: 'read-only', workspaceRoot: '/ws', config: resolved() }))
      .toEqual([...BWRAP_BASE_ARGS, '--ro-bind', '/ws', '/ws'])
  })

  it('starts with the same read-only root, fresh /dev, and private PID /proc as the built-in profile', () => {
    expect(BWRAP_BASE_ARGS).toEqual([
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--die-with-parent',
    ])
  })
})
