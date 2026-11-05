/**
 * Browser side of the authenticated mount-config route. Every response is
 * validated before it reaches the form; failures carry the Host's actionable
 * detail when one was supplied.
 *
 * @module dsh-configurable-linux-sandbox/client/mounts-api
 */

import { MOUNT_KEYS, WEB_API_ROUTE } from '../contract.ts'
import type { MountsErrorBody, MountsView, ResolvedMountLists } from '../contract.ts'
import type { MountConfig } from '../types.ts'

/** A failed mount-config request. */
export class MountsApiError extends Error {
  /** Host-supplied actionable detail, when present. */
  readonly detail: string | undefined

  /**
   * @param message - stable local summary.
   * @param detail - Host detail appended when available.
   */
  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'MountsApiError'
    this.detail = detail
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isMountConfig(value: unknown): value is MountConfig {
  if (!isRecord(value)) return false
  for (const key of Object.keys(value)) {
    if (!(MOUNT_KEYS as readonly string[]).includes(key)) return false
    if (value[key] !== undefined && !isStringList(value[key])) return false
  }
  return true
}

function isResolvedLists(value: unknown): value is ResolvedMountLists {
  if (!isRecord(value)) return false
  return MOUNT_KEYS.every(key => isStringList(value[key]))
}

function isMountsView(value: unknown): value is MountsView {
  if (!isRecord(value)) return false
  return typeof value.sessionId === 'string'
    && typeof value.cwd === 'string'
    && typeof value.mode === 'string'
    && isMountConfig(value.global)
    && (value.session === null || isMountConfig(value.session))
    && isResolvedLists(value.effective)
}

function errorBody(value: unknown): MountsErrorBody | undefined {
  if (!isRecord(value) || typeof value.error !== 'string') return undefined
  return typeof value.detail === 'string' ? { error: value.error, detail: value.detail } : { error: value.error }
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

async function readView(response: Response, fallback: string): Promise<MountsView> {
  const body = await responseBody(response)
  if (!response.ok) {
    const failure = errorBody(body)
    throw new MountsApiError(fallback, failure?.detail ?? failure?.error)
  }
  if (!isMountsView(body)) throw new MountsApiError(fallback, 'invalid-response')
  return body
}

/**
 * Read one session's mount configuration.
 * @param sessionId - live session id from the slot props.
 * @param signal - aborts the request when the form unmounts or reopens.
 * @returns the validated view.
 */
export async function readMounts(sessionId: string, signal: AbortSignal): Promise<MountsView> {
  const response = await fetch(`${WEB_API_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
    signal,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  return readView(response, 'read-failed')
}

/**
 * Write one complete session override.
 * @param sessionId - live session id.
 * @param config - only the keys the user chose to override.
 * @returns the new validated view.
 */
export async function writeMounts(sessionId: string, config: MountConfig): Promise<MountsView> {
  const response = await fetch(WEB_API_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sessionId, config }),
  })
  return readView(response, 'write-failed')
}

/**
 * Return one session to the deployment configuration.
 * @param sessionId - live session id.
 * @returns the new validated view.
 */
export async function resetMounts(sessionId: string): Promise<MountsView> {
  const response = await fetch(WEB_API_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sessionId, reset: true }),
  })
  return readView(response, 'reset-failed')
}
