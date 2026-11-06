/**
 * Live bundle activation through the real Loader: one profile patch update
 * disables the shipped sandbox and filesystem rows and inserts this bundle's
 * row, exactly what the Web Plugins page asks Plugin Manager to apply when the
 * bundle is enabled. `EntryGroup.update` starts both changes concurrently, so
 * activation must wait out the old providers' asynchronous disposal instead of
 * failing on a duplicate service registration and requiring a session restart.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import {
  LINUX_SANDBOX_PROVIDER_CONFLICT,
  LinuxSandboxProviderConflictError,
} from '../src/index.ts'
import * as bundle from '../src/index.ts'
import { waitForReplacedServicesReleased } from '../src/release.ts'
import { ConfigurableSandboxCore } from '../src/core.ts'
import { MountAwareFileSystem } from '../src/fs.ts'
import { LinuxBwrapSandboxProvider } from '../src/provider.ts'
import { cleanupDirs, makeDir } from './support.ts'

const BIN = 'dsh-live-activation-test'

/** The shipped provider's asynchronous unload is what the replacement must wait out. */
const SLOW_UNLOAD_MS = 40

afterAll(() => {
  cleanupDirs()
})

/** A plain service provider, as the built-in rows provide `sandbox` and `fs`. */
function providerPlugin(service: 'sandbox' | 'fs', value: { origin: string }) {
  return {
    name: `old-${service}`,
    apply(ctx: Context): void {
      const provide = ctx.provide as (name: string, value: unknown) => void
      provide(service, value)
    },
  }
}

/** A plugin that depends on both replaced services and unloads asynchronously. */
const slowConsumer = {
  name: 'slow-consumer',
  inject: ['sandbox', 'fs'],
  apply(ctx: Context): void {
    ctx.effect(() => async () => {
      await new Promise(resolve => setTimeout(resolve, SLOW_UNLOAD_MS))
    }, 'slow-consumer: asynchronous shutdown')
  },
}

/** A plugin that depends on `sandbox` only, for the bound test that has no `fs` provider. */
const slowSandboxConsumer = {
  name: 'slow-sandbox-consumer',
  inject: ['sandbox'],
  apply(ctx: Context): void {
    ctx.effect(() => async () => {
      await new Promise(resolve => setTimeout(resolve, SLOW_UNLOAD_MS))
    }, 'slow-sandbox-consumer: asynchronous shutdown')
  },
}

/** The bundle row the test activates in the second generation. */
const BUNDLE_ROW = { id: 'configurable-sandbox', name: 'cordis:configurable-sandbox', config: {} }

/** Patches of the initial profile generation: the shipped providers and one dependent. */
const basePatches: PatchOptions[] = [{
  insert: [
    { id: 'sandbox', name: 'cordis:old-sandbox' },
    { id: 'fs-sandbox', name: 'cordis:old-fs' },
    { id: 'consumer', name: 'cordis:slow-consumer' },
  ],
}]

/** Patches of the live update: disable both shipped rows and insert the bundle row. */
const activationPatches: PatchOptions[] = [
  ...basePatches,
  { id: 'sandbox', disabled: true },
  { id: 'fs-sandbox', disabled: true },
  { insert: [BUNDLE_ROW] },
]

/** Register the pseudo modules the test composition imports through `cordis:`. */
function registerPseudoModules(ctx: Context): void {
  ctx.loader.builtins['old-sandbox'] = providerPlugin('sandbox', { origin: 'shipped' })
  ctx.loader.builtins['old-fs'] = providerPlugin('fs', { origin: 'shipped' })
  ctx.loader.builtins['slow-consumer'] = slowConsumer
  ctx.loader.builtins['configurable-sandbox'] = bundle
}

/** Boot the initial generation over the real session, projection, and policy services. */
async function bootInitialGeneration(): Promise<Context> {
  const configDir = makeDir('dsh-live-activation-')
  const configPath = join(configDir, 'cordis.yml')
  writeFileSync(configPath, '[]\n')
  return boot(BIN, configPath, basePatches, async (prepared) => {
    await prepared.plugin(SessionStore)
    await prepared.plugin(SessionProjectionRegistry)
    await prepared.plugin(SandboxPolicyService, {
      mode: 'workspace-write',
      workspaceRoot: makeDir('dsh-live-activation-policy-'),
    })
    registerPseudoModules(prepared)
  })
}

describe('live bundle activation', () => {
  it('replaces the shipped providers in one loader generation without a restart', { timeout: 20_000 }, async () => {
    const ctx = await bootInitialGeneration()
    try {
      expect(ctx.get('sandbox', false)).toMatchObject({ origin: 'shipped' })
      expect(ctx.get('fs', false)).toMatchObject({ origin: 'shipped' })

      // The activation the Web plugin page performs: saved patches applied to a
      // live profile, with the enabled row required to start.
      await reconcileProfilePatches(ctx, activationPatches, BIN, [BUNDLE_ROW.id])

      expect(ctx.sandbox).toBeInstanceOf(LinuxBwrapSandboxProvider)
      expect(ctx.fs).toBeInstanceOf(MountAwareFileSystem)
      expect(ctx.configurableSandbox).toBeInstanceOf(ConfigurableSandboxCore)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a replaced provider that misses the activation bound', { timeout: 20_000 }, async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Loader)
      ctx.loader.builtins['old-sandbox'] = providerPlugin('sandbox', { origin: 'shipped' })
      ctx.loader.builtins['slow-sandbox-consumer'] = slowSandboxConsumer
      const root = ctx.loader.root
      await root.update([
        { id: 'sandbox', name: 'cordis:old-sandbox' },
        { id: 'consumer', name: 'cordis:slow-sandbox-consumer' },
      ])

      // Start the disposal, then race it with a replacement that gives the
      // previous provider only a fraction of its dependent's unload time.
      const disposal = root.update([
        { id: 'sandbox', name: 'cordis:old-sandbox', disabled: true },
        { id: 'consumer', name: 'cordis:slow-sandbox-consumer' },
      ])
      const replacement = {
        name: 'impatient-replacement',
        async apply(scope: Context) {
          await waitForReplacedServicesReleased(scope, 5)
          const provide = scope.provide as (name: string, value: unknown) => void
          provide('sandbox', { origin: 'replacement' })
        },
      }
      await expect(ctx.plugin(replacement)).rejects.toMatchObject({
        code: LINUX_SANDBOX_PROVIDER_CONFLICT,
        message: expect.stringMatching(/did not finish unloading/),
      })
      await disposal
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('waitForReplacedServicesReleased', () => {
  it('fails closed when another active plugin keeps a replaced service', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(providerPlugin('sandbox', { origin: 'foreign' }))
      await expect(waitForReplacedServicesReleased(ctx)).rejects.toMatchObject({
        code: LINUX_SANDBOX_PROVIDER_CONFLICT,
        message: expect.stringMatching(/another active plugin still provides "sandbox"/),
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops waiting cleanly when its entry is disposed', { timeout: 20_000 }, async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Loader)
      ctx.loader.builtins['old-sandbox'] = providerPlugin('sandbox', { origin: 'shipped' })
      ctx.loader.builtins['slow-sandbox-consumer'] = slowSandboxConsumer
      const root = ctx.loader.root
      await root.update([
        { id: 'sandbox', name: 'cordis:old-sandbox' },
        { id: 'consumer', name: 'cordis:slow-sandbox-consumer' },
      ])
      const disposal = root.update([
        { id: 'sandbox', name: 'cordis:old-sandbox', disabled: true },
        { id: 'consumer', name: 'cordis:slow-sandbox-consumer' },
      ])
      let mounted = false
      const waiter = ctx.plugin({
        name: 'disposed-while-waiting',
        async apply(scope: Context) {
          await waitForReplacedServicesReleased(scope)
          mounted = true
        },
      })
      // Disposing the waiting entry must settle the wait instead of holding
      // the fiber's unload for the full activation bound.
      await waiter.dispose()
      await waiter
      expect(mounted).toBe(false)
      await disposal
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not wait when no replaced provider is registered', async () => {
    const ctx = new Context()
    try {
      await waitForReplacedServicesReleased(ctx)
      expect(ctx.get('sandbox', false)).toBeUndefined()
      expect(ctx.get('fs', false)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('LinuxSandboxProviderConflictError', () => {
  it('carries the stable code and names the services', () => {
    const error = new LinuxSandboxProviderConflictError(['sandbox', 'fs'], 'active')
    expect(error.code).toBe(LINUX_SANDBOX_PROVIDER_CONFLICT)
    expect(error.message).toContain('"sandbox", "fs"')
  })
})
