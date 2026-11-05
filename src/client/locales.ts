/**
 * Locale dictionaries and the typed namespace merge for the session mount
 * form. Only English and Chinese are shipped; the locale service falls back to
 * English for other active languages.
 *
 * @module dsh-configurable-linux-sandbox/client/locales
 */

/** Locale namespace owned by this client plugin. */
export const NS = 'sandbox.mounts'

export const en = {
  open: 'Sandbox mounts',
  title: 'Session sandbox mounts',
  close: 'Close',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  reset: 'Reset to global',
  resetting: 'Resetting…',
  loading: 'Loading mount configuration…',
  loadError: 'Could not load the sandbox configuration.',
  saveError: 'Could not save the sandbox configuration.',
  saved: 'Saved. The next confined command uses the new configuration.',
  inherited: 'Inherited from global',
  override: 'Override',
  none: 'No paths',
  add: 'Add path',
  remove: 'Remove path',
  path: 'Path {{index}}',
  pathPlaceholder: '/absolute/physical/path',
  read_write: 'Read-write',
  read_write_hint: 'Directories outside the workspace writable in workspace-write mode. Each entry must be a physical directory path.',
  read_only: 'Read-only',
  read_only_hint: 'Directories outside the workspace visible read-only in every mode.',
  forbidden: 'Forbidden',
  forbidden_hint: 'Directories hidden behind an empty tmpfs. Deeper entries can re-expose their own subtree.',
  dev: 'Devices',
  dev_hint: 'Character/block device nodes or paths under /dev exposed with --dev-bind, for example /dev/dri.',
  mode: 'Mode: {{mode}}',
  cwd: 'Workspace: {{cwd}}',
  detail: 'The Host rejected the configuration: {{detail}}',
  devWarning: 'Devices are outside the file modes and can act as a write channel.',
} as const

/** Every form copy key. */
export type Key = keyof typeof en

export const zh: Record<Key, string> = {
  open: '沙箱挂载',
  title: '会话沙箱挂载',
  close: '关闭',
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  reset: '恢复全局配置',
  resetting: '恢复中…',
  loading: '正在加载挂载配置…',
  loadError: '无法加载沙箱配置。',
  saveError: '无法保存沙箱配置。',
  saved: '已保存。下一条受限命令将使用新配置。',
  inherited: '继承全局配置',
  override: '覆盖',
  none: '没有路径',
  add: '添加路径',
  remove: '删除路径',
  path: '路径 {{index}}',
  pathPlaceholder: '/绝对物理路径',
  read_write: '可读写',
  read_write_hint: '工作区之外、在 workspace-write 模式下可写的目录。每一项必须是物理目录路径。',
  read_only: '只读',
  read_only_hint: '工作区之外、在所有模式下都只读可见的目录。',
  forbidden: '禁止访问',
  forbidden_hint: '用空 tmpfs 遮盖的目录。更深层的条目可以重新暴露自己的子树。',
  dev: '设备',
  dev_hint: '通过 --dev-bind 暴露的字符/块设备节点或 /dev 下路径，例如 /dev/dri。',
  mode: '模式：{{mode}}',
  cwd: '工作区：{{cwd}}',
  detail: 'Host 拒绝了此配置：{{detail}}',
  devWarning: '设备访问不受文件模式限制，可能成为写入通道。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session sandbox mount form copy. */
    'sandbox.mounts': Key
  }
}
