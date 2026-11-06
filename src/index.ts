/**
 * The configurable Linux sandbox bundle entry: one Cordis plugin that mounts
 * the shared mount-configuration service, the bwrap process provider, and the
 * mount-aware filesystem provider. The package row also carries the browser
 * half (`exports["./client"]`), whose `dsh.client` declaration the Web shell
 * discovers from this same active row.
 *
 * The four mount keys (`read_write`, `read_only`, `forbidden`, `dev`) are the
 * deployment-wide defaults; each session can override them through the durable
 * per-session record and the Web form.
 *
 * @module dsh-configurable-linux-sandbox
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ConfigurableSandboxCore } from './core.ts'
import { MountAwareFileSystem } from './fs.ts'
import { LinuxBwrapSandboxProvider } from './provider.ts'
import { isFiberAlive, waitForReplacedServicesReleased } from './release.ts'
import type { SandboxPluginConfig } from './types.ts'

/** Plugin name shown by the Loader. */
export const name = 'dsh-configurable-linux-sandbox'

/** Deployment-wide mount intent and the bwrap probe bound. */
export type Config = SandboxPluginConfig

// Inline schema call: the config catalog walks the plugin's static Config.
export const Config: z<Config> = z.object({
  read_write: z.array(z.string()).default([]),
  read_only: z.array(z.string()).default([]),
  forbidden: z.array(z.string()).default([]),
  dev: z.array(z.string()).default([]),
  probeTimeoutMs: z.natural().default(5_000),
})

export {
  LINUX_SANDBOX_INVALID_CONFIG,
  LINUX_SANDBOX_PROVIDER_CONFLICT,
  LINUX_SANDBOX_SESSION_UNAVAILABLE,
  LinuxSandboxConfigError,
  LinuxSandboxProviderConflictError,
  LinuxSandboxSessionUnavailableError,
} from './errors.ts'
export { MOUNT_KEYS, WEB_API_PATH, WEB_API_ROUTE } from './contract.ts'
export type { MountKey, MountsErrorBody, MountsView, ResolvedMountLists } from './contract.ts'
export { BWRAP_BASE_ARGS } from './mounts.ts'
export { LEGACY_SANDBOX_MOUNTS_RECORD, SANDBOX_MOUNTS_RECORD, setSessionMountConfig } from './session.ts'
export type { MountConfig, MountEntry, MountEntryKind, ResolvedMountConfig, SandboxPluginConfig } from './types.ts'

/**
 * Mount the bundle's three Host plugins. Each child is awaited so a bad mount
 * configuration fails this bundle row at activation instead of surfacing later
 * as a detached child failure.
 *
 * Activation first waits out the shipped providers it replaces: a live profile
 * update disables their rows and inserts this row in one Loader generation, so
 * their asynchronous unload is still holding the `sandbox`/`fs` names when the
 * insertion starts. A fresh composition has no such provider and skips the
 * wait immediately.
 * @param ctx - Cordis context of the bundle row.
 * @param config - deployment mount intent and the bwrap probe bound.
 * @returns when all three services are active.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error(`dsh-configurable-linux-sandbox: this bundle is Linux-only; the current platform is ${process.platform}`)
  }
  await waitForReplacedServicesReleased(ctx)
  // A disposal during the wait is a clean stop; do not mount into a dying fiber.
  if (!isFiberAlive(ctx)) return
  await ctx.plugin(ConfigurableSandboxCore, config)
  await ctx.plugin(LinuxBwrapSandboxProvider)
  await ctx.plugin(MountAwareFileSystem)
}
