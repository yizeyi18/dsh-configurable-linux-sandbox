// @vitest-environment jsdom
/**
 * Browser-half registration and render: the plugin registers one Session
 * header action, and the action renders its accessible trigger without
 * touching the network while closed.
 */

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { MountsAction } from '../src/client/MountsAction.tsx'

afterEach(cleanup)

interface Registration {
  options: { name: string; id: string; order?: number }
  component: unknown
}

describe('client plugin', () => {
  it('declares the slots and locale services and registers into the session header', () => {
    const registrations: Registration[] = []
    let injected: string | undefined
    const ctx = {
      effect: (create: () => () => void) => create(),
      locale: {
        register: () => () => {},
        bind: () => (key: string) => key,
      },
      slots: {
        inject: (name: string, callback: () => () => void) => {
          injected = name
          return callback()
        },
        register: (options: Registration['options'], component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }

    apply(ctx as never)

    expect(inject).toEqual(['slots', 'locale'])
    expect(injected).toBe('conversation.session.header.utilities')
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.options).toMatchObject({
      name: 'conversation.session.header.utilities',
      id: 'configurable-linux-sandbox',
    })
    expect(registrations[0]?.component).toBe(MountsAction)
  })

  it('renders the closed header action without touching the network', () => {
    render(createElement(MountsAction, { sessionId: 'session-1', t: (key: string) => key } as never))
    const button = screen.getByRole('button', { name: 'open' })
    expect(button).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
