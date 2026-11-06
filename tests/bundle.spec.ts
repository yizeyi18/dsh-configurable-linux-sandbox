/**
 * Bundle manifest and patch composition: the shipped base layer plus this
 * bundle's patch must leave exactly one active sandbox and filesystem provider,
 * with the built-ins disabled and no duplicate row ids.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { satisfies } from 'semver'

const root = join(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

/** The shipped base layer this bundle composes over, resolved from the installed package. */
const basePatch = require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')

/** The DSH version the development dependencies pin, the same package line `engines.dsh` names. */
const runtimeVersion = (require('@deepseek-ai/dsh-app-boot/package.json') as { version: string }).version

function readYaml(path: string): unknown {
  return load(readFileSync(path, 'utf8'), { schema: entryListSchema })
}

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, any>
}

describe('bundle manifest', () => {
  it('declares a Linux bundle and a Web client face', () => {
    const pkg = manifest()
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.bundle.platforms).toEqual(['linux'])
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.exports['./client'].default).toBe('./lib/client.js')
    expect(pkg.files).toContain('lib/client.js')
    expect(pkg.files).toContain('cordis.patch.yml')
  })

  it('targets the running DSH version through engines.dsh and its dsh peers', () => {
    const pkg = manifest()
    expect(satisfies(runtimeVersion, pkg.engines.dsh, { includePrerelease: true })).toBe(true)
    for (const [name, range] of Object.entries(pkg.peerDependencies as Record<string, string>)) {
      if (!name.startsWith('@deepseek-ai/dsh')) continue
      expect(satisfies(runtimeVersion, range, { includePrerelease: true }), name).toBe(true)
    }
  })
})

describe('bundle patch composition', () => {
  it('disables the built-in providers and inserts exactly one replacement row', () => {
    const warnings: string[] = []
    const base = applyEntryPatches(
      [],
      readYaml(basePatch) as never[],
      (format: string, ...args: unknown[]) => { warnings.push(`${format} ${args.join(' ')}`) },
    )
    const rows = applyEntryPatches(
      base,
      readYaml(join(root, 'cordis.patch.yml')) as never[],
      (format: string, ...args: unknown[]) => { warnings.push(`${format} ${args.join(' ')}`) },
    )
    expect(warnings).toEqual([])
    expect(rows.find(row => row.id === 'sandbox')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'fs-sandbox')?.disabled).toBe(true)
    const ours = rows.filter(row => row.id === 'configurable-sandbox')
    expect(ours).toHaveLength(1)
    expect(ours[0]?.name).toBe('dsh-configurable-linux-sandbox')
  })

  it('has no duplicate top-level row ids after composition', () => {
    const warnings: string[] = []
    const base = applyEntryPatches([], readYaml(basePatch) as never[], () => {})
    const rows = applyEntryPatches(base, readYaml(join(root, 'cordis.patch.yml')) as never[], (format: string, ...args: unknown[]) => {
      warnings.push(`${format} ${args.join(' ')}`)
    })
    const ids = rows.map(row => row.id).filter((id): id is string => typeof id === 'string')
    expect(ids.length).toBe(new Set(ids).size)
    expect(warnings).toEqual([])
  })
})
