/**
 * Mount-intent boundary checks: shape validation, path canonicalization,
 * symlink policy, deduplication, and cross-key conflicts. These tests never
 * spawn bwrap.
 */

import { existsSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LinuxSandboxConfigError } from '../src/index.ts'
import { normalizeMountConfig, resolveMountConfig } from '../src/paths.ts'
import { cleanupDirs, makeDir } from './support.ts'

afterAll(cleanupDirs)

describe('normalizeMountConfig', () => {
  it('detaches and freezes every list', () => {
    const dir = makeDir()
    const input = { read_only: [dir], read_write: [] as string[] }
    const normalized = normalizeMountConfig(input, 'test')
    input.read_only.push('/tmp/later-mutation')
    expect(normalized.read_only).toEqual([dir])
    expect(normalized.read_write).toEqual([])
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.read_only)).toBe(true)
  })

  it.each([null, [], 42, 'read_only'])('rejects a non-object payload: %j', (value) => {
    expect(() => normalizeMountConfig(value, 'test')).toThrow(LinuxSandboxConfigError)
    expect(() => normalizeMountConfig(value, 'test')).toThrow(/expected an object/)
  })

  it('rejects an unknown key instead of silently dropping a typo', () => {
    expect(() => normalizeMountConfig({ read_only: [], readOnly: [] }, 'test'))
      .toThrow(/unknown mount key "readOnly"/)
  })

  it('rejects a non-array list', () => {
    expect(() => normalizeMountConfig({ read_only: '/tmp' }, 'test'))
      .toThrow(/read_only must be an array/)
  })

  it.each(['relative/path', '', '/tmp/with\0nul'])('rejects a malformed entry: %j', (entry) => {
    expect(() => normalizeMountConfig({ read_only: [entry] }, 'test'))
      .toThrow(/non-empty absolute path without NUL/)
  })

  it('rejects a non-string entry', () => {
    expect(() => normalizeMountConfig({ read_only: [42] }, 'test'))
      .toThrow(/read_only entries must be strings/)
  })
})

describe('resolveMountConfig', () => {
  it('canonicalizes a symlinked read-only alias to its physical target', () => {
    const target = realpathSync(makeDir())
    const link = join(makeDir(), 'link')
    symlinkSync(target, link)
    expect(resolveMountConfig({ read_only: [link] }, 'test').read_only).toEqual([target])
  })

  it('rejects a symlinked read_write grant so a retarget cannot move write authority', () => {
    const target = realpathSync(makeDir())
    const link = join(makeDir(), 'link')
    symlinkSync(target, link)
    expect(() => resolveMountConfig({ read_write: [link] }, 'test'))
      .toThrow(/must be the physical directory path/)
  })

  it('accepts a physical read_write directory', () => {
    const dir = realpathSync(makeDir())
    expect(resolveMountConfig({ read_write: [dir] }, 'test').read_write).toEqual([dir])
  })

  it('rejects a missing path', () => {
    const missing = join(makeDir(), 'missing')
    expect(() => resolveMountConfig({ read_only: [missing] }, 'test'))
      .toThrow(/cannot be resolved/)
  })

  it('rejects a regular file for the directory lists', () => {
    const file = join(makeDir(), 'file')
    writeFileSync(file, 'x')
    expect(() => resolveMountConfig({ forbidden: [file] }, 'test')).toThrow(/is not a directory/)
  })

  it('accepts a character device for dev', () => {
    expect(resolveMountConfig({ dev: ['/dev/null'] }, 'test').dev).toEqual(['/dev/null'])
  })

  it('rejects a regular file for dev because dev is a device exposure', () => {
    const file = join(makeDir(), 'device')
    writeFileSync(file, 'x')
    expect(() => resolveMountConfig({ dev: [file] }, 'test'))
      .toThrow(/must be a character\/block device or a path under \/dev/)
  })

  it('accepts a directory under /dev for dev and canonicalizes its alias', () => {
    if (!existsSync('/dev/shm')) return
    const link = join(makeDir(), 'dev-shm-link')
    symlinkSync('/dev/shm', link)
    expect(resolveMountConfig({ dev: [link] }, 'test').dev).toEqual([realpathSync('/dev/shm')])
  })

  it('rejects the base /dev and /proc mounts in every key', () => {
    for (const key of ['read_write', 'read_only', 'forbidden', 'dev'] as const) {
      expect(() => resolveMountConfig({ [key]: ['/dev'] }, 'test')).toThrow(/fresh \/dev/)
      expect(() => resolveMountConfig({ [key]: ['/proc'] }, 'test')).toThrow(/private \/proc/)
    }
  })

  it('rejects device paths outside the dev key and proc paths below the base mount', () => {
    if (existsSync('/dev/shm')) {
      expect(() => resolveMountConfig({ read_only: ['/dev/shm'] }, 'test')).toThrow(/use the dev key/)
    }
    expect(() => resolveMountConfig({ read_only: ['/proc/self'] }, 'test')).toThrow(/private \/proc/)
  })

  it('rejects a symlink alias that canonicalizes onto the base /dev mount', () => {
    const link = join(makeDir(), 'dev-alias')
    symlinkSync('/dev', link)
    expect(() => resolveMountConfig({ read_only: [link] }, 'test')).toThrow(/fresh \/dev/)
  })

  it('rejects one path declared with two different spellings', () => {
    const dir = realpathSync(makeDir())
    const link = join(makeDir(), 'link')
    symlinkSync(dir, link)
    expect(() => resolveMountConfig({ read_only: [dir], forbidden: [link] }, 'test'))
      .toThrow(/declared in both read_only and forbidden/)
  })

  it('deduplicates repeated entries after canonicalization', () => {
    const dir = realpathSync(makeDir())
    expect(resolveMountConfig({ read_only: [dir, dir] }, 'test').read_only).toEqual([dir])
  })

  it('rejects one physical path declared by two different keys', () => {
    const dir = realpathSync(makeDir())
    expect(() => resolveMountConfig({ read_write: [dir], forbidden: [dir] }, 'test'))
      .toThrow(/declared in both read_write and forbidden/)
  })

  it('rejects the root directory in every list', () => {
    expect(() => resolveMountConfig({ read_only: ['/'] }, 'test')).toThrow(/must not list the root/)
    expect(() => resolveMountConfig({ dev: ['/'] }, 'test')).toThrow(/must not list the root/)
  })

  it('returns frozen lists', () => {
    const resolved = resolveMountConfig({ read_only: [realpathSync(makeDir())] }, 'test')
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.read_only)).toBe(true)
  })
})
