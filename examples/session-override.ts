/**
 * Example host-side hook: give one session a narrower view and one extra
 * writable cache directory. Call this with a Session the host already owns
 * (for example from a session bootstrap or a host settings action).
 *
 * The override is durable: it is appended to the session log as a
 * `plugin:dsh-configurable-linux-sandbox/mounts` plugin record and replayed on restart.
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { setSessionMountConfig } from 'dsh-configurable-linux-sandbox'

/**
 * Restrict the session's view of the home tree while keeping a cache writable
 * and a dataset tree readable.
 * @param session - the session whose confined processes receive the override.
 */
export function configureResearchSession(session: Session): void {
  setSessionMountConfig(session, {
    read_write: ['/home/me/.cache/huggingface'],
    read_only: ['/home/me/datasets'],
    forbidden: ['/home/me'],
    dev: ['/dev/dri'],
  })
}
