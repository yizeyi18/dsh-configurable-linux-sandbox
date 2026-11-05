/**
 * Browser half of the bundle: registers the session-header mount action and
 * its locale dictionaries. The Host half is the package root; this module is
 * loaded from `exports["./client"]` because the same Loader row declares
 * `dsh.client`.
 *
 * @module dsh-configurable-linux-sandbox/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the slots/locale Context merges.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MountsAction } from './MountsAction.tsx'
import { en, zh, NS } from './locales.ts'

/** Services this browser plugin waits for. */
export const inject = ['slots', 'locale']

/**
 * Register the Session-header action while the conversation slot exists.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'configurable-sandbox: locales')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'configurable-linux-sandbox',
    order: -7,
    locale: NS,
  }, MountsAction))
}
