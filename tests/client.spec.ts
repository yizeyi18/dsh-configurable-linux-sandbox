// @vitest-environment jsdom
/**
 * Browser-half registration and render: the plugin registers one Session
 * header action, and the action renders its accessible trigger without
 * touching the network while closed.
 */

import { createElement, type ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { MountsAction } from '../src/client/MountsAction.tsx'

/**
 * The Web shell provides `ui-primitives` as a platform module. Its published
 * npm package does not carry the transitive packages the shell installation
 * supplies, so the render test substitutes the seven atoms the action uses.
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  type AnyProps = Record<string, unknown> & { children?: ReactNode }

  const Icon = (props: Record<string, unknown>) =>
    React.createElement('span', { 'aria-hidden': true, ...props })
  const Button = ({ children, icon: _icon, variant: _variant, size: _size, ...props }: AnyProps) =>
    React.createElement('button', { type: 'button', ...props }, children)
  const Checkbox = ({ checked, onChange, label, disabled }: AnyProps & {
    checked?: boolean
    onChange?: (next: boolean) => void
    label?: string
    disabled?: boolean
  }) => React.createElement(
    'label',
    { 'data-disabled': disabled === true ? true : undefined },
    React.createElement('input', {
      type: 'checkbox',
      checked: checked === true,
      disabled,
      onChange: () => { onChange?.(checked !== true) },
    }),
    label,
  )
  const Input = (props: AnyProps) => React.createElement('input', props)
  const Modal = ({ open, title, children }: AnyProps & { open?: boolean; title?: string }) =>
    open === true ? React.createElement('div', { role: 'dialog', 'aria-label': title }, children) : null
  return {
    Button,
    Checkbox,
    IconCloseOutlineRegular: Icon,
    IconPlusOutlineRegular: Icon,
    IconSettingsOutlineRegular: Icon,
    Input,
    Modal,
  }
})

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
