/**
 * Browser-safe contract shared by the Host Web route and the Client form: the
 * mount-intent key names, the authenticated route path, and the JSON view both
 * sides exchange. This module has no Node imports so the Client bundle can
 * inline it.
 *
 * @module dsh-configurable-linux-sandbox/contract
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { MountConfig } from './types.ts'

/** The four mount-intent keys in display order. */
export const MOUNT_KEYS = ['read_write', 'read_only', 'forbidden', 'dev'] as const

/** One mount-intent key. */
export type MountKey = typeof MOUNT_KEYS[number]

/** Absolute path of the authenticated Host route. */
export const WEB_API_PATH = '/api/dsh-configurable-linux-sandbox/mounts'

/** Browser-relative form of {@link WEB_API_PATH} for document-relative fetch. */
export const WEB_API_ROUTE = 'api/dsh-configurable-linux-sandbox/mounts'

/** Every resolved mount list, as the Web view reports it. */
export interface ResolvedMountLists {
  /** Physical directories writable under `workspace-write`. */
  read_write: string[]
  /** Physical directories exposed read-only. */
  read_only: string[]
  /** Physical directories hidden by an empty tmpfs. */
  forbidden: string[]
  /** Physical device nodes or `/dev`-tree paths exposed with `--dev-bind`. */
  dev: string[]
}

/** One session's mount configuration as the Web UI sees it. */
export interface MountsView {
  /** Session this view belongs to. */
  sessionId: string
  /** Workspace root the session's policy resolves. */
  cwd: string
  /** Session file-effect mode. */
  mode: SandboxMode
  /** Deployment-wide mount intent. */
  global: MountConfig
  /** The session override, or null when the session inherits every key. */
  session: MountConfig | null
  /** Effective physical lists after inheritance, mode gating, and policy extras. */
  effective: ResolvedMountLists
}

/** Successful GET/POST response body; failures use `{ error, detail? }`. */
export interface MountsErrorBody {
  /** Stable machine-readable failure kind. */
  error: string
  /** Actionable detail when the failure names invalid input. */
  detail?: string
}
