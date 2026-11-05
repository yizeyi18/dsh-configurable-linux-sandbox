/**
 * Shared test scaffolding: temp directories under the platform temp root and a
 * live Cordis composition of the session store, projection registry, and the
 * bwrap provider. The provider's probe is stubbed so unit tests never require
 * user namespaces; the e2e suite mounts the provider without this helper.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LinuxBwrapSandboxProvider from '../src/index.ts'
import type { Config } from '../src/index.ts'

const tempDirs: string[] = []

/** Create one directory under the platform temp root and register it for cleanup. */
export function makeDir(prefix = 'new-linux-sandbox-'): string {
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

/**
 * Mount the provider over a real session store and projection registry, then
 * stub the functional probe to success.
 * @param config - deployment mount intent, after the test created its paths.
 * @returns the live context and provider.
 */
export async function mountProvider(config: Config = {}): Promise<ProviderBench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LinuxBwrapSandboxProvider, config)
  const provider = ctx.sandbox as LinuxBwrapSandboxProvider
  provider.internals.probeBwrap = () => true
  return { ctx, provider }
}
