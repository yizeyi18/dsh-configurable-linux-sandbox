/**
 * Waiting out the providers this bundle replaces in one live profile update.
 *
 * A live patch change applies one composition generation to the Loader as a
 * single `EntryGroup.update`, which starts every changed, removed, and
 * inserted row concurrently. A live update that enables this bundle therefore
 * disables the shipped `sandbox` and `fs-sandbox` rows in the same generation
 * that inserts this bundle's row, while a provider fiber's unload is
 * asynchronous: its dependents release first, and until they do the Loader
 * still exposes the old `ctx.sandbox`/`ctx.fs` implementation. Mounting the
 * replacement immediately then fails with
 * `service "sandbox" has been registered at <LocalSandboxProvider>` and the
 * profile is left without a provider until a process restart.
 *
 * Waiting for those names to leave the service store makes the same
 * generation converge without a restart. A composition that legitimately keeps
 * another provider of either name cannot be replaced live and fails with a
 * named conflict instead of an opaque duplicate-service error.
 *
 * @module dsh-configurable-linux-sandbox/release
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: supply the `sandbox` and `fs` Context merges this module reads.
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox'
import { LinuxSandboxProviderConflictError } from './errors.ts'

/** Service names this bundle provides by replacing their shipped provider. */
export const REPLACED_SERVICES = ['sandbox', 'fs'] as const

/** Upper bound on one live replacement; a healthy unload settles in a few event-loop turns. */
export const REPLACED_SERVICE_RELEASE_TIMEOUT_MS = 10_000

/**
 * Whether the owning fiber is still alive to mount plugins. A plugin callback
 * runs while its fiber is LOADING, not ACTIVE, so the disposal marker — the
 * `uid` cleared before unload starts — is the only safe condition here.
 * @param ctx - context whose owning fiber is checked.
 * @returns whether new plugins may still be mounted.
 */
export function isFiberAlive(ctx: Context): boolean {
  return ctx.fiber.uid !== null
}

/** One replaced service name. */
type ReplacedService = typeof REPLACED_SERVICES[number]

/**
 * Whether a replaced service is registered at all, including a provider whose
 * fiber is already unloading but whose service disposer has not run yet.
 * @param ctx - bundle context that reads the same isolation scope as the providers.
 * @param name - replaced service name.
 * @returns whether this name currently resolves to an implementation.
 */
function isRegistered(ctx: Context, name: ReplacedService): boolean {
  return ctx.get(name, false) !== undefined
}

/**
 * Wait until no provider of `sandbox` or `fs` holds the name any more, so this
 * bundle can register its own. Called at bundle activation: a fresh
 * composition with the built-ins already disabled returns immediately, and a
 * live generation waits out the old providers' disposal.
 * @param ctx - Cordis context of the bundle row.
 * @param timeoutMs - bound on the wait; exceeding it fails the activation.
 * @returns when neither replaced service has a registered provider, or when
 *   the owning entry is disposed while waiting (its caller then returns).
 * @throws {LinuxSandboxProviderConflictError} when another active plugin still
 *   provides either service, or the old provider does not release it in time.
 */
export async function waitForReplacedServicesReleased(
  ctx: Context,
  timeoutMs: number = REPLACED_SERVICE_RELEASE_TIMEOUT_MS,
): Promise<void> {
  const registered = (): string[] => REPLACED_SERVICES.filter(name => isRegistered(ctx, name))
  const active = (): string[] => REPLACED_SERVICES.filter(name => ctx.get(name) !== undefined)

  const stillActive = active()
  if (stillActive.length > 0) throw new LinuxSandboxProviderConflictError(stillActive, 'active')
  if (registered().length === 0) return

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let off: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      const unsubscribe = off
      off = undefined
      unsubscribe?.()
      if (error === undefined) resolve()
      else reject(error)
    }

    const check = (): void => {
      if (settled) return
      const nowActive = active()
      if (nowActive.length > 0) {
        settle(new LinuxSandboxProviderConflictError(nowActive, 'active'))
        return
      }
      if (registered().length === 0) settle()
    }

    off = ctx.on('internal/service', check)
    // Disposing this entry while it waits must settle the promise too: the
    // fiber's own unload awaits the plugin callback, which would otherwise
    // hold it until the timeout.
    ctx.effect(() => () => { settle() }, 'dsh-configurable-linux-sandbox: stop waiting for a replaced provider')
    timer = setTimeout(() => {
      settle(new LinuxSandboxProviderConflictError(registered(), 'unloading', timeoutMs))
    }, timeoutMs)
    // A release between the first check and the listener registration must not
    // be missed.
    check()
  })

  // A disposal during the wait is a clean stop, not a reason to mount providers.
  if (!isFiberAlive(ctx)) return
  const remaining = registered()
  if (remaining.length > 0) throw new LinuxSandboxProviderConflictError(remaining, 'unloading', timeoutMs)
}
