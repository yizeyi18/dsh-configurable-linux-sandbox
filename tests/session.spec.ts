/**
 * Session-level mount configuration: the durable write path and the
 * last-wins projection fold it feeds.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { appendPluginRecord, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LinuxSandboxConfigError } from '../src/index.ts'
import { SANDBOX_MOUNTS_RECORD, sandboxMountsProjection, setSessionMountConfig } from '../src/session.ts'
import { cleanupDirs, makeDir } from './support.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  cleanupDirs()
})

async function project() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const handle = await ctx.sessionProjections.register(sandboxMountsProjection)
  const session = ctx.sessions.create()
  return { ctx, handle, session }
}

describe('sandbox mount projection', () => {
  it('has no override before the first record', async () => {
    const { handle, session } = await project()
    expect(handle.stateOf(session)).toEqual({ config: null, invalid: null })
  })

  it('takes the last event wholesale instead of merging keys', async () => {
    const { handle, session } = await project()
    const first = makeDir('dsh-configurable-linux-sandbox-first-')
    const second = makeDir('dsh-configurable-linux-sandbox-second-')
    setSessionMountConfig(session, { read_only: [first] })
    setSessionMountConfig(session, { read_write: [second] })
    expect(handle.stateOf(session)).toEqual({ config: { read_write: [second] }, invalid: null })
  })

  it('keeps an explicit empty list as the override', async () => {
    const { handle, session } = await project()
    setSessionMountConfig(session, { read_write: [] })
    expect(handle.stateOf(session)).toEqual({ config: { read_write: [] }, invalid: null })
  })

  it('restores the deployment configuration when the override is {}', async () => {
    const { handle, session } = await project()
    setSessionMountConfig(session, { read_only: [makeDir()] })
    setSessionMountConfig(session, {})
    expect(handle.stateOf(session)).toEqual({ config: {}, invalid: null })
  })

  it('keeps two sessions independent', async () => {
    const { ctx, handle, session } = await project()
    const other = ctx.sessions.create()
    setSessionMountConfig(session, { read_only: [makeDir()] })
    expect(handle.stateOf(other)).toEqual({ config: null, invalid: null })
  })

  it('detaches the recorded override from later caller mutation', async () => {
    const { handle, session } = await project()
    const dir = makeDir()
    const input = { read_write: [dir] }
    setSessionMountConfig(session, input)
    input.read_write.push('/tmp/not-recorded')
    expect(handle.stateOf(session)).toEqual({ config: { read_write: [dir] }, invalid: null })
  })

  it('fails the projection closed when a stored record is malformed', async () => {
    const { handle, session } = await project()
    // A durable-boundary test: the typed write path rejects this shape, so the
    // malformed payload is injected directly to exercise the tolerant reader.
    appendPluginRecord(session, SANDBOX_MOUNTS_RECORD, { read_only: 42 } as never)
    const state = handle.stateOf(session)
    expect(state.config).toBeNull()
    expect(state.invalid).not.toBeNull()
  })

  it('folds a stored plugin record into a restored session', async () => {
    const { ctx, session } = await project()
    setSessionMountConfig(session, { read_only: ['/tmp'] })
    // Simulate the persistence read path: one ignorable plugin record is the
    // entire seed. The cast injects a record outside SessionEventMap exactly as
    // the log stores it; Session still validates the envelope at runtime.
    const restored = Session.create(SessionId('restored'), [
      {
        type: SANDBOX_MOUNTS_RECORD,
        seq: 0,
        time: 0,
        data: { read_only: ['/tmp'] },
        ignorable: true,
      },
    ] as never)
    const handle = await ctx.sessionProjections.register(sandboxMountsProjection)
    expect(handle.stateOf(restored)).toEqual({ config: { read_only: ['/tmp'] }, invalid: null })
  })

  it('rejects a malformed override before it reaches the log', async () => {
    const { session } = await project()
    expect(() => setSessionMountConfig(session, { read_only: ['relative/path'] }))
      .toThrow(LinuxSandboxConfigError)
  })
})
