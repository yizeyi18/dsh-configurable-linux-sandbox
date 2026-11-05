/**
 * Shared test scaffolding: temp directories under the platform temp root and a
 * live Cordis composition of the session store, projection registry, policy
 * service, and the bundle's three Host plugins. The provider's probe is stubbed
 * by default so unit tests never require user namespaces; the e2e suite mounts
 * the same stack with the real probe.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ConfigurableSandboxCore } from '../src/core.ts'
import { MountAwareFileSystem } from '../src/fs.ts'
import { LinuxBwrapSandboxProvider } from '../src/provider.ts'
import type { Config } from '../src/index.ts'

const tempDirs: string[] = []

/** Create one directory under the platform temp root and register it for cleanup. */
export function makeDir(prefix = 'dsh-configurable-linux-sandbox-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Remove every directory {@link makeDir} created. */
export function cleanupDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** One live provider composition. */
export interface ProviderBench {
  /** Root Cordis context; dispose it in the test's `afterEach`/`afterAll`. */
  ctx: Context
  /** The mounted provider, used for `confine` and the probe hook. */
  provider: LinuxBwrapSandboxProvider
}

/** Options for {@link mountProvider}. */
export interface MountOptions {
  /** Keep the real bwrap probe instead of stubbing it to success. */
  realProbe?: boolean
  /** Deployment default mode for the policy service. */
  mode?: SandboxMode
}

/**
 * Mount the core, provider, and filesystem plugins over a real session store,
 * projection registry, and sandbox-policy service.
 * @param config - deployment mount intent, after the test created its paths.
 * @param options - probe and policy-mode overrides.
 * @returns the live context and provider.
 */
export async function mountProvider(config: Config = {}, options: MountOptions = {}): Promise<ProviderBench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, {
    mode: options.mode ?? 'workspace-write',
    workspaceRoot: makeDir('dsh-configurable-linux-sandbox-policy-'),
  })
  await ctx.plugin(ConfigurableSandboxCore, config)
  await ctx.plugin(LinuxBwrapSandboxProvider)
  await ctx.plugin(MountAwareFileSystem)
  const provider = ctx.sandbox as LinuxBwrapSandboxProvider
  if (options.realProbe !== true) provider.internals.probeBwrap = () => true
  return { ctx, provider }
}
