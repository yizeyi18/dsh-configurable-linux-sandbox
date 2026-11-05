/**
 * The bundle entry and its authenticated Web route. This suite mounts the
 * actual package plugin (not its three classes separately), stubs only the
 * connection carrier, and exercises the route the Client form calls.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { LINUX_SANDBOX_INVALID_CONFIG, WEB_API_PATH, setSessionMountConfig } from '../src/index.ts'
import type { MountsView } from '../src/index.ts'
import * as Plugin from '../src/index.ts'
import { cleanupDirs, makeDir } from './support.ts'

interface CapturedRoute {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  cleanupDirs()
})

async function mountWeb() {
  let route: CapturedRoute | undefined
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: makeDir() })
  // A carrier stand-in: the bundle registers its exact route on this service.
  ctx.provide('connection', {
    fetch: {
      register: (registered: CapturedRoute) => {
        route = registered
        return async () => {}
      },
    },
  } as never)
  await ctx.plugin(Plugin, { read_only: [makeDir('dsh-configurable-linux-sandbox-web-global-')] })
  await vi.waitFor(() => { expect(route).toBeDefined() })
  return { ctx, route: route as NonNullable<typeof route> }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

describe('bundle entry', () => {
  it('mounts the core, process sandbox, and filesystem from one plugin row', async () => {
    const { ctx } = await mountWeb()
    expect(typeof ctx.get('configurableSandbox')).toBe('object')
    expect(typeof ctx.get('sandbox')).toBe('object')
    expect(typeof ctx.get('fs')).toBe('object')
  })

  it('registers one authenticated GET/POST route with buffered JSON bodies', async () => {
    const { route } = await mountWeb()
    expect(route.path).toBe(WEB_API_PATH)
    expect(route.methods).toEqual(['GET', 'POST'])
    expect(route.requestBody).toBe('buffered')
  })
})

describe('mount-config web route', () => {
  it('returns the global, session, and effective view for a live session', async () => {
    const { ctx, route } = await mountWeb()
    const session = ctx.sessions.create()
    const override = makeDir('dsh-configurable-linux-sandbox-web-session-')
    setSessionMountConfig(session, { read_write: [override] })

    const response = await route.fetch(request(`${WEB_API_PATH}?sessionId=${encodeURIComponent(String(session.id))}`))
    expect(response.status).toBe(200)
    const view = await response.json() as MountsView
    expect(view.sessionId).toBe(String(session.id))
    expect(view.mode).toBe('workspace-write')
    expect(view.session).toEqual({ read_write: [override] })
    expect(view.global.read_only).toHaveLength(1)
    expect(view.effective.read_write).toContain(override)
  })

  it('writes a complete session override and validates its paths', async () => {
    const { ctx, route } = await mountWeb()
    const session = ctx.sessions.create()
    const grant = makeDir('dsh-configurable-linux-sandbox-web-grant-')
    const url = `${WEB_API_PATH}?sessionId=${encodeURIComponent(String(session.id))}`

    const saved = await route.fetch(request(WEB_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: String(session.id), config: { read_write: [grant] } }),
    }))
    expect(saved.status).toBe(200)
    const afterSave = await saved.json() as MountsView
    expect(afterSave.session).toEqual({ read_write: [grant] })
    expect(afterSave.effective.read_write).toContain(grant)

    const invalid = await route.fetch(request(WEB_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: String(session.id), config: { read_write: ['relative'] } }),
    }))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: 'invalid-config' })
    expect(LINUX_SANDBOX_INVALID_CONFIG).toBe('LINUX_SANDBOX_INVALID_CONFIG')

    const reset = await route.fetch(request(WEB_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: String(session.id), reset: true }),
    }))
    expect(reset.status).toBe(200)
    expect((await reset.json() as MountsView).session).toBeNull()

    const after = await route.fetch(request(url))
    expect((await after.json() as MountsView).session).toBeNull()
  })

  it('rejects a missing live session and a non-JSON POST', async () => {
    const { route } = await mountWeb()

    const missing = await route.fetch(request(`${WEB_API_PATH}?sessionId=missing`))
    expect(missing.status).toBe(409)

    const notJson = await route.fetch(request(WEB_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'nope',
    }))
    expect(notJson.status).toBe(415)
  })

  it('serves a vanished configured path as a config failure instead of a widened view', async () => {
    const { ctx, route } = await mountWeb()
    const session = ctx.sessions.create()
    const vanished = makeDir('dsh-configurable-linux-sandbox-web-vanished-')
    setSessionMountConfig(session, { read_only: [vanished] })
    rmSync(vanished, { recursive: true, force: true })
    const response = await route.fetch(request(`${WEB_API_PATH}?sessionId=${encodeURIComponent(String(session.id))}`))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid-config' })
  })

  it.skipIf(!existsSync(join(import.meta.dirname, '../lib/client.js')))('ships a client bundle that registers the shared module-loader factory', () => {
    const bundle = readFileSync(join(import.meta.dirname, '../lib/client.js'), 'utf8')
    expect(bundle.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(bundle).toContain('id: "dsh-configurable-linux-sandbox"')
    expect(bundle).toContain('factory: (require) =>')
    expect(bundle).toContain('return module.exports;')
  })
})
