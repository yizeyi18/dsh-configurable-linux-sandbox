/**
 * The per-session mount form: a Session-header action opening an accessible
 * modal with one editable path list per mount key. The form reads the current
 * view over the authenticated Host route and writes only the keys the user
 * chose to override.
 *
 * @module dsh-configurable-linux-sandbox/client/MountsAction
 */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Button,
  Checkbox,
  IconCloseOutlineRegular,
  IconPlusOutlineRegular,
  IconSettingsOutlineRegular,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the conversation SlotMap entry and its session-scoped standard props.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the sessionId/useSession standard props.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { MOUNT_KEYS } from '../contract.ts'
import type { MountKey, MountsView } from '../contract.ts'
import type { MountConfig } from '../types.ts'
import { NS } from './locales.ts'
import type { Key } from './locales.ts'
import { MountsApiError, readMounts, resetMounts, writeMounts } from './mounts-api.ts'

/** One key's editable state. */
interface KeyDraft {
  /** Whether this key overrides the deployment value. */
  enabled: boolean
  /** One row per configured path; empty strings are dropped on save. */
  paths: string[]
}

type Drafts = Record<MountKey, KeyDraft>

const bodyStyle = {
  display: 'grid',
  gap: 18,
  maxHeight: 'min(64vh, 640px)',
  overflowY: 'auto',
} satisfies CSSProperties

const sectionStyle = { display: 'grid', gap: 8 } satisfies CSSProperties
const rowStyle = { display: 'flex', gap: 8, alignItems: 'center' } satisfies CSSProperties
const headerStyle = { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between' } satisfies CSSProperties
const hintStyle = { margin: 0, opacity: 0.72 } satisfies CSSProperties
const metaStyle = { display: 'grid', gap: 4 } satisfies CSSProperties
const footerStyle = { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', width: '100%' } satisfies CSSProperties
const footerActions = { display: 'flex', gap: 8, alignItems: 'center' } satisfies CSSProperties
const pathsStyle = { display: 'grid', gap: 6 } satisfies CSSProperties
const inheritedStyle = { margin: 0, wordBreak: 'break-all' } satisfies CSSProperties

/** Per-key hint copy. */
const HINTS: Record<MountKey, Key> = {
  read_write: 'read_write_hint',
  read_only: 'read_only_hint',
  forbidden: 'forbidden_hint',
  dev: 'dev_hint',
}

/** Props bound by the Session-header utilities slot. */
export type MountsActionProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>

function draftFor(view: MountsView, key: MountKey): KeyDraft {
  const override = view.session?.[key]
  return override === undefined
    ? { enabled: false, paths: [...(view.global[key] ?? [])] }
    : { enabled: true, paths: [...override] }
}

function draftsFrom(view: MountsView): Drafts {
  return {
    read_write: draftFor(view, 'read_write'),
    read_only: draftFor(view, 'read_only'),
    forbidden: draftFor(view, 'forbidden'),
    dev: draftFor(view, 'dev'),
  }
}

function detailOf(cause: unknown): string {
  if (cause instanceof MountsApiError) return cause.detail ?? cause.message
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function mountConfigOf(drafts: Drafts): MountConfig {
  const config: MountConfig = {}
  for (const key of MOUNT_KEYS) {
    const draft = drafts[key]
    if (!draft.enabled) continue
    config[key] = draft.paths.map(path => path.trim()).filter(path => path.length > 0)
  }
  return config
}

/**
 * Render the Session-header sandbox action and its modal form.
 * @param props - session identity, localized copy, and the slot's standard seats.
 * @returns the header button, plus the modal while open.
 */
export function MountsAction(props: MountsActionProps) {
  const { sessionId, t } = props
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<MountsView>()
  const [drafts, setDrafts] = useState<Drafts>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    setSaved(false)
    setView(undefined)
    setDrafts(undefined)
    readMounts(sessionId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setView(next)
        setDrafts(draftsFrom(next))
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(detailOf(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => { controller.abort() }
  }, [open, sessionId])

  const editPath = (key: MountKey, index: number, value: string): void => {
    setSaved(false)
    setDrafts((current) => {
      if (current === undefined) return current
      const paths = [...current[key].paths]
      paths[index] = value
      return { ...current, [key]: { ...current[key], paths } }
    })
  }

  const addPath = (key: MountKey): void => {
    setSaved(false)
    setDrafts((current) => {
      if (current === undefined) return current
      return { ...current, [key]: { ...current[key], paths: [...current[key].paths, ''] } }
    })
  }

  const removePath = (key: MountKey, index: number): void => {
    setSaved(false)
    setDrafts((current) => {
      if (current === undefined) return current
      return { ...current, [key]: { ...current[key], paths: current[key].paths.filter((_, at) => at !== index) } }
    })
  }

  const toggleOverride = (key: MountKey, enabled: boolean): void => {
    setDrafts((current) => {
      if (current === undefined) return current
      const source = enabled
        ? (view?.session?.[key] ?? view?.global[key] ?? [])
        : (view?.global[key] ?? [])
      return { ...current, [key]: { enabled, paths: [...source] } }
    })
    setSaved(false)
  }

  const applyView = (next: MountsView): void => {
    setView(next)
    setDrafts(draftsFrom(next))
    setSaved(true)
    setError(undefined)
  }

  const save = async (): Promise<void> => {
    if (drafts === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      applyView(await writeMounts(sessionId, mountConfigOf(drafts)))
    } catch (cause: unknown) {
      setError(detailOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      applyView(await resetMounts(sessionId))
    } catch (cause: unknown) {
      setError(detailOf(cause))
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    if (!busy) setOpen(false)
  }

  const fields = view === undefined || drafts === undefined ? null : (
    <div style={bodyStyle}>
      <div style={metaStyle}>
        <span>{t('mode', { mode: view.mode })}</span>
        <span style={{ wordBreak: 'break-all' }}>{t('cwd', { cwd: view.cwd })}</span>
      </div>
      {MOUNT_KEYS.map((key) => {
        const draft = drafts[key]
        return (
          <section key={key} style={sectionStyle}>
            <div style={headerStyle}>
              <strong>{t(key)}</strong>
              <Checkbox
                checked={draft.enabled}
                onChange={(next) => { toggleOverride(key, next) }}
                label={t('override')}
                disabled={busy}
                modalAutofocus={key === 'read_write'}
              />
            </div>
            <p style={hintStyle}>{t(HINTS[key])}</p>
            {draft.enabled
              ? (
                <div style={pathsStyle}>
                  {draft.paths.map((path, index) => (
                    <div key={index} style={rowStyle}>
                      <Input
                        value={path}
                        onChange={(event) => { editPath(key, index, event.target.value) }}
                        aria-label={t('path', { index: index + 1 })}
                        placeholder={t('pathPlaceholder')}
                        spellCheck={false}
                        disabled={busy}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<IconCloseOutlineRegular size={14} />}
                        aria-label={`${t('remove')} ${index + 1}`}
                        disabled={busy}
                        onClick={() => { removePath(key, index) }}
                      />
                    </div>
                  ))}
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<IconPlusOutlineRegular size={14} />}
                      disabled={busy}
                      onClick={() => { addPath(key) }}
                    >
                      {t('add')}
                    </Button>
                  </div>
                </div>
              )
              : (
                <div>
                  <p style={inheritedStyle}>
                    {(view.global[key] ?? []).length === 0
                      ? t('none')
                      : (view.global[key] ?? []).join('\n')}
                  </p>
                  <p style={hintStyle}>{t('inherited')}</p>
                </div>
              )}
            {key === 'dev' && <p style={hintStyle}>{t('devWarning')}</p>}
          </section>
        )
      })}
      {saved && <p style={hintStyle}>{t('saved')}</p>}
      {error !== undefined && (
        <p style={hintStyle}>
          {t(drafts === undefined ? 'loadError' : 'saveError')}{' '}
          {t('detail', { detail: error })}
        </p>
      )}
    </div>
  )

  return (
    <>
      <Button
        variant="toolbar"
        icon={<IconSettingsOutlineRegular size={16} />}
        aria-label={t('open')}
        title={t('open')}
        onClick={() => { setOpen(true) }}
      />
      <Modal
        open={open}
        onClose={close}
        title={t('title')}
        closeLabel={t('close')}
        footer={(
          <div style={footerStyle}>
            <Button variant="ghost" disabled={busy || loading} onClick={() => { void reset() }}>
              {t('reset')}
            </Button>
            <div style={footerActions}>
              <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
              <Button
                variant="primary"
                disabled={busy || loading || drafts === undefined}
                onClick={() => { void save() }}
              >
                {busy ? t('saving') : t('save')}
              </Button>
            </div>
          </div>
        )}
      >
        {loading && <p style={hintStyle}>{t('loading')}</p>}
        {!loading && drafts === undefined && error !== undefined && (
          <p style={hintStyle}>
            {t('loadError')}{' '}
            {t('detail', { detail: error })}
          </p>
        )}
        {fields}
      </Modal>
    </>
  )
}
