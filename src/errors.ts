/**
 * Structured failures of the configurable Linux bwrap sandbox. Both classes
 * extend `HarnessError`, so a consumer routes on `code` rather than on message
 * text. Neither error wraps a spawn: they name a configuration that cannot be
 * enforced, before bwrap starts.
 *
 * @module new-linux-sandbox/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable code for a mount configuration that cannot be resolved or enforced. */
export const LINUX_SANDBOX_INVALID_CONFIG = 'LINUX_SANDBOX_INVALID_CONFIG'

/** Stable code for a calling session that is no longer live in the store. */
export const LINUX_SANDBOX_SESSION_UNAVAILABLE = 'LINUX_SANDBOX_SESSION_UNAVAILABLE'

/**
 * A mount configuration is malformed, names a path that cannot be used as a
 * mount source, or declares the same path for contradictory mount kinds.
 */
export class LinuxSandboxConfigError extends HarnessError {
  /** @param detail - actionable description without the plugin prefix. */
  constructor(detail: string) {
    super(`new-linux-sandbox: ${detail}`, LINUX_SANDBOX_INVALID_CONFIG)
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
      `new-linux-sandbox: the calling session ${JSON.stringify(sessionId)} is not live, so its mount override cannot be read`,
      LINUX_SANDBOX_SESSION_UNAVAILABLE,
    )
  }
}
