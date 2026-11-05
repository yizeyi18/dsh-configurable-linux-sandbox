/**
 * Per-session mount configuration: the session log is the store. Because this
 * package lives outside the harness repository, the override is written as an
 * `ignorable` plugin record under the `plugin:` namespace rather than a
 * `SessionEventMap` member: the persistence read path accepts an unknown
 * record it can retain and skip, while a required unknown event would make the
 * whole log unreadable. The `sandboxLinuxMounts` projection folds the LAST
 * such record, so an override survives restart by replay, two sessions cannot
 * see each other's mounts, and no external configuration store exists.
 *
 * An override record replaces the session override wholesale. Omitted keys
 * inherit the plugin's global list; an explicit empty array clears one key for
 * this session; appending `{}` returns the session to the global configuration.
 *
 * A record whose payload fails validation becomes an invalid projection state
 * rather than being skipped: a security policy must fail closed instead of
 * silently falling back to a possibly wider global configuration.
 *
 * @module dsh-configurable-linux-sandbox/session
 */

import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import { normalizeMountConfig } from './paths.ts'
import type { MountConfig } from './types.ts'

/** Plugin record type carrying one complete session mount override. */
export const SANDBOX_MOUNTS_RECORD = 'plugin:dsh-configurable-linux-sandbox/mounts' as const

/**
 * Record type written by the phase-one prototype under its former package name.
 * Reads fold it as a fallback so existing sessions keep their override; new
 * writes use {@link SANDBOX_MOUNTS_RECORD}.
 */
export const LEGACY_SANDBOX_MOUNTS_RECORD = 'plugin:new-linux-sandbox/mounts' as const

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /**
     * The session's complete Linux mount override. Log-only, never part of the
     * model transcript; the last such record wins.
     */
    'plugin:dsh-configurable-linux-sandbox/mounts': MountConfig
    /** Phase-one record type read for compatibility; never written. */
    'plugin:new-linux-sandbox/mounts': MountConfig
  }
}

/** Projection key that owns the folded session mount override. */
export const SANDBOX_MOUNTS_PROJECTION_KEY = 'sandboxLinuxMounts' as const

/** Persisted state of the session override projection. */
export interface SandboxMountOverrideState {
  /** The last valid session override, or null when no record applies. */
  readonly config: MountConfig | null
  /** Why a stored record could not be used; non-null fails confined calls closed. */
  readonly invalid: string | null
}

/** Persisted state schema; strict so a replay with unknown keys fails loudly. */
const mountConfigSchema = zod.object({
  read_write: zod.array(zod.string()).optional(),
  read_only: zod.array(zod.string()).optional(),
  forbidden: zod.array(zod.string()).optional(),
  dev: zod.array(zod.string()).optional(),
}).strict()

const stateSchema: zod.ZodType<SandboxMountOverrideState> = zod.object({
  config: mountConfigSchema.nullable(),
  invalid: zod.string().nullable(),
}).strict()

/** Fold one committed event into the override state. */
function applyRecord(state: SandboxMountOverrideState, event: SessionEvent): SandboxMountOverrideState {
  const record = pluginRecordOf(event)
  if (record?.type !== SANDBOX_MOUNTS_RECORD && record?.type !== LEGACY_SANDBOX_MOUNTS_RECORD) return state
  const parsed = mountConfigSchema.safeParse(record.data)
  if (!parsed.success) {
    return Object.freeze({ config: null, invalid: parsed.error.message })
  }
  return Object.freeze({ config: Object.freeze(parsed.data), invalid: null })
}

/**
 * Host-only projection unit for the session mount override. The last valid
 * record becomes the state; a malformed record produces an invalid state that
 * the provider reports instead of silently reverting to the global config.
 * No wire view is contributed: clients do not need the mount lists, and the
 * log record remains the only authority.
 */
export const sandboxMountsProjection: ProjectionDefinition<typeof SANDBOX_MOUNTS_PROJECTION_KEY, SandboxMountOverrideState> = {
  key: SANDBOX_MOUNTS_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => Object.freeze({ config: null, invalid: null }),
  apply: applyRecord,
}

/**
 * THE write path for a session's mount override: append exactly one
 * `plugin:dsh-configurable-linux-sandbox/mounts` record. The change applies to that
 * session's next confined call. The input is validated and detached before it
 * reaches the log, so later caller mutation cannot rewrite the recorded
 * override.
 * @param session - the session the override belongs to.
 * @param config - the complete session mount intent; omitted keys inherit the
 *   deployment configuration.
 */
export function setSessionMountConfig(session: Session, config: MountConfig): void {
  appendPluginRecord(session, SANDBOX_MOUNTS_RECORD, normalizeMountConfig(config, 'session mount config'))
}
