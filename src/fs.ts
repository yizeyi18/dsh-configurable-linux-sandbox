/**
 * The mount-aware filesystem provider (`ctx.fs`), replacing the built-in
 * `dsh-fs-sandbox` row. It extends the stock sandboxed backend, so the
 * deployment policy's mode, workspace, `additionalWritableRoots`, and temp
 * areas keep their usual fence, and layers the four mount keys on top:
 * `forbidden` paths are hidden from reads and writes, `read_only` paths reject
 * mutations, and `read_write` paths are writable under `workspace-write` even
 * though they are outside the policy's own writable roots.
 *
 * Reads have no per-call policy argument, so the provider resolves the calling
 * session from the Agent initiator scope; mutations trust the policy's
 * `sessionId` and fall back to the same scope for direct callers. This mirrors
 * the process provider's session selection.
 *
 * @module dsh-configurable-linux-sandbox/fs
 */

import { sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsDeleteOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsMoveOutcome,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
// Type-only: supplies the sandboxPolicy Context merge.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
// Type-only: supplies the agents Context merge used for read-session resolution.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: supplies the configurableSandbox Context merge.
import type {} from './core.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MountEntry } from './types.ts'

/** Whether one canonical absolute path equals a root or lies below it. */
function isAtOrUnder(path: string, root: string): boolean {
  if (path === root) return true
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/** The deepest mount entry that covers one path; entries arrive depth-sorted. */
function deepestEntry(entries: readonly MountEntry[], path: string): MountEntry | undefined {
  let winner: MountEntry | undefined
  for (const entry of entries) {
    if (isAtOrUnder(path, entry.path)) winner = entry
  }
  return winner
}

/** Refuse one operation with the structured sandbox denial code. */
function denied(action: 'read' | 'write', target: FsTarget, reason: string): FsError {
  return new FsError(`cannot ${action} "${target.displayPath}": ${reason}`, 'FS_SANDBOX_DENIED')
}

/** Return a policy with one extra writable root, preserving the policy's own roots. */
function withExtraRoot(policy: SandboxExecutionPolicy, root: string): SandboxExecutionPolicy {
  const roots = policy.additionalWritableRoots ?? []
  if (roots.includes(root)) return policy
  return { ...policy, additionalWritableRoots: [...roots, root] }
}

/**
 * Mount-aware local filesystem. Reads and mutations both consult the shared
 * mount configuration; the inherited backend still owns atomic writes, locks,
 * target identity, and the mode/workspace fence.
 */
export class MountAwareFileSystem extends SandboxedFileSystem {
  static override inject = ['sandboxPolicy', 'configurableSandbox']

  /**
   * @param ctx - Cordis context that owns the service.
   * @param config - local backend knobs (cwd resolution default, diff bound).
   */
  constructor(ctx: Context, config: LocalConfig = {}) {
    super(ctx, config)
  }

  /**
   * Resolve and then reject a hidden target.
   * @param path - path from the tool or consumer.
   * @param opts - optional cwd override and cancellation.
   * @returns the resolved target.
   */
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const target = await super.resolve(path, opts)
    this.assertReadable(target)
    return target
  }

  /**
   * @param target - resolved target.
   * @param signal - aborts the read.
   * @returns the full decoded text.
   */
  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    this.assertReadable(target)
    return super.readText(target, signal)
  }

  /**
   * @param target - resolved target.
   * @param signal - aborts the stream.
   * @returns the decoded chunk iterable.
   */
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    this.assertReadable(target)
    return super.streamText(target, signal)
  }

  /**
   * @param target - resolved target.
   * @param signal - aborts the read.
   * @param maxBytes - caller's bound.
   * @returns the raw bytes.
   */
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    this.assertReadable(target)
    return super.readBytes(target, signal, maxBytes)
  }

  /**
   * @param target - resolved target.
   * @param range - offset and length.
   * @param signal - aborts the read.
   * @returns the requested bytes.
   */
  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.assertReadable(target)
    return super.readByteRange(target, range, signal)
  }

  /**
   * @param target - resolved target.
   * @param signal - aborts the probe.
   * @returns metadata, or undefined when absent or hidden.
   */
  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    this.assertReadable(target)
    return super.stat(target, signal)
  }

  /**
   * @param path - path-level probe target.
   * @param opts - optional cwd override.
   * @param signal - aborts the probe.
   * @returns path metadata, or undefined when absent or hidden.
   */
  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    // The guard follows the final symlink; a link whose target is visible stays usable.
    const guarded = await super.resolve(path, opts)
    this.assertReadable(guarded)
    return super.lstat(path, opts, signal)
  }

  /**
   * @param target - resolved directory.
   * @param signal - aborts the listing.
   * @returns visible direct entries; hidden children are omitted.
   */
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await super.listDir(target, signal)
    const plan = this.readPlan()
    if (plan === undefined) return entries
    if (deepestEntry(plan, target.targetKey)?.kind === 'tmpfs') {
      throw denied('read', target, 'hidden by the sandbox mount policy')
    }
    return entries.filter(entry => deepestEntry(plan, entry.target.targetKey)?.kind !== 'tmpfs')
  }

  /**
   * @param target - resolved target.
   * @param changed - invalidation callback.
   * @param signal - cancels watcher initialization.
   * @returns the watcher close function.
   */
  override async watch(
    target: FsTarget,
    changed: (error?: Error) => void,
    signal: AbortSignal,
  ): Promise<() => Promise<void>> {
    this.assertReadable(target)
    return super.watch(target, changed, signal)
  }

  /**
   * @param target - resolved target.
   * @param content - full new content.
   * @param expected - optional write intent.
   * @param signal - aborts before publication.
   * @param sandboxPolicy - per-call policy.
   * @returns the write outcome.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const policy = this.fenceWrites([target], sandboxPolicy)
    return super.writeText(target, content, expected, signal, policy)
  }

  /**
   * @param target - resolved target.
   * @param edit - literal search/replace.
   * @param expected - version guard.
   * @param signal - aborts before publication.
   * @param sandboxPolicy - per-call policy.
   * @returns the edit outcome.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const policy = this.fenceWrites([target], sandboxPolicy)
    return super.editText(target, edit, expected, signal, policy)
  }

  /**
   * @param target - resolved target.
   * @param hunks - patch hunks.
   * @param expected - version guard.
   * @param signal - aborts before publication.
   * @param sandboxPolicy - per-call policy.
   * @returns the edit outcome.
   */
  override async patchText(
    target: FsTarget,
    hunks: Parameters<SandboxedFileSystem['patchText']>[1],
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const policy = this.fenceWrites([target], sandboxPolicy)
    return super.patchText(target, hunks, expected, signal, policy)
  }

  /**
   * @param target - resolved target.
   * @param expected - version guard.
   * @param signal - aborts before removal.
   * @param sandboxPolicy - per-call policy.
   * @returns the delete outcome.
   */
  override async deleteFile(
    target: FsTarget,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsDeleteOutcome> {
    const policy = this.fenceWrites([target], sandboxPolicy)
    return super.deleteFile(target, expected, signal, policy)
  }

  /**
   * @param source - resolved source.
   * @param destination - resolved destination.
   * @param options - move options.
   * @param signal - aborts before publication.
   * @param sandboxPolicy - per-call policy.
   * @returns the move outcome.
   */
  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: Parameters<SandboxedFileSystem['moveFile']>[2],
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsMoveOutcome> {
    const policy = this.fenceWrites([source, destination], sandboxPolicy)
    return super.moveFile(source, destination, options, signal, policy)
  }

  /** The calling session from the Agent initiator scope, or undefined outside one. */
  private currentSession(): Session | undefined {
    return this.ctx.get('agents')?.currentInitiator()?.session
  }

  /** The policy the current read belongs to. */
  private readPolicy(): SandboxExecutionPolicy {
    const session = this.currentSession()
    return this.ctx.sandboxPolicy.resolve(session === undefined ? {} : { session })
  }

  /** Ordered mount entries for the current read, or undefined under full access. */
  private readPlan(): readonly MountEntry[] | undefined {
    const policy = this.readPolicy()
    if (policy.mode === 'danger-full-access') return undefined
    return this.ctx.configurableSandbox.plan(policy, this.currentSession(), {
      includeDefaultTmpfs: false,
    }).entries
  }

  /** Reject a target hidden by a `forbidden` mount. */
  private assertReadable(target: FsTarget): void {
    const plan = this.readPlan()
    if (plan === undefined) return
    if (deepestEntry(plan, target.targetKey)?.kind === 'tmpfs') {
      throw denied('read', target, 'hidden by the sandbox mount policy')
    }
  }

  /**
   * Fence mutations by the mount keys, returning the policy the inherited
   * backend should enforce (with every covering `read_write` path added to the
   * writable roots). The inherited check still owns the mode/workspace fence.
   */
  private fenceWrites(targets: readonly FsTarget[], sandboxPolicy?: SandboxExecutionPolicy): SandboxExecutionPolicy {
    const session = this.currentSession()
    const base = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve(session === undefined ? {} : { session })
    if (base.mode === 'danger-full-access') return base
    const plan = this.ctx.configurableSandbox.plan(base, session, {
      includeDefaultTmpfs: false,
    }).entries
    let policy = base
    for (const target of targets) {
      const winner = deepestEntry(plan, target.targetKey)
      if (winner?.kind === 'tmpfs') throw denied('write', target, 'hidden by the sandbox mount policy')
      if (winner?.kind === 'read-only') throw denied('write', target, 'read-only in the sandbox mount policy')
      if (winner?.kind === 'read-write') policy = withExtraRoot(policy, winner.path)
    }
    return policy
  }
}

export default MountAwareFileSystem
