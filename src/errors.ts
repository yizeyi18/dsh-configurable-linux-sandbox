/**
 * Structured failures of the configurable Linux bwrap sandbox. Every class
 * extends `HarnessError`, so a consumer routes on `code` rather than on message
 * text. None wraps a spawn: the configuration and session errors name a policy
 * that cannot be enforced, before bwrap starts, and the provider-conflict
 * error reports an activation that could not replace a provider.
 *
 * @module dsh-configurable-linux-sandbox/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable code for a mount configuration that cannot be resolved or enforced. */
export const LINUX_SANDBOX_INVALID_CONFIG = 'LINUX_SANDBOX_INVALID_CONFIG'

/** Stable code for a calling session that is no longer live in the store. */
export const LINUX_SANDBOX_SESSION_UNAVAILABLE = 'LINUX_SANDBOX_SESSION_UNAVAILABLE'

/**
 * Stable code for a replaced `sandbox` or `fs` service that this bundle cannot
 * take over.
 */
export const LINUX_SANDBOX_PROVIDER_CONFLICT = 'LINUX_SANDBOX_PROVIDER_CONFLICT'

/**
 * A mount configuration is malformed, names a path that cannot be used as a
 * mount source, or declares the same path for contradictory mount kinds.
 */
export class LinuxSandboxConfigError extends HarnessError {
  /** @param detail - actionable description without the plugin prefix. */
  constructor(detail: string) {
    super(`dsh-configurable-linux-sandbox: ${detail}`, LINUX_SANDBOX_INVALID_CONFIG)
  }
}

/**
 * A confined call carried a session id that the live SessionStore does not
 * contain. Falling back to the deployment configuration could silently widen
 * or narrow the policy, so the call fails closed instead.
 */
export class LinuxSandboxSessionUnavailableError extends HarnessError {
  /** @param sessionId - the id carried by the sandbox policy. */
  constructor(sessionId: string) {
    super(
      `dsh-configurable-linux-sandbox: the calling session ${JSON.stringify(sessionId)} is not live, so its mount override cannot be read`,
      LINUX_SANDBOX_SESSION_UNAVAILABLE,
    )
  }
}

/**
 * The bundle cannot register `sandbox`/`fs` because another plugin still owns
 * one of those names. `active` means an active foreign provider (the
 * composition cannot be replaced live); `unloading` means the provider being
 * replaced did not finish its asynchronous disposal within the activation
 * bound. Either way, continuing would run two providers for one contract, so
 * activation fails closed.
 */
export class LinuxSandboxProviderConflictError extends HarnessError {
  /**
   * @param services - replaced service names that are still registered.
   * @param reason - another active provider, or a release that exceeded the bound.
   * @param timeoutMs - the activation bound, used by the `unloading` message.
   */
  constructor(services: readonly string[], reason: 'active' | 'unloading', timeoutMs = 0) {
    const names = services.map(service => JSON.stringify(service)).join(', ')
    const detail = reason === 'active'
      ? `another active plugin still provides ${names}; this bundle replaces the shipped sandbox and filesystem providers and cannot coexist with it`
      : `${names} ${services.length === 1 ? 'is' : 'are'} still registered ${String(timeoutMs)} ms after this bundle started replacing it; the previous provider did not finish unloading`
    super(`dsh-configurable-linux-sandbox: ${detail}`, LINUX_SANDBOX_PROVIDER_CONFLICT)
  }
}
