# dsh-configurable-linux-sandbox

[English](README.md) | 中文

一个仅面向 Linux 的 DeepSeek Harness bundle：用一个懂挂载的进程沙箱和文件系统沙箱替换项目自带的 `sandbox` 与 `fs-sandbox`，由四个 key 配置，并可在 Web UI 中按会话覆盖。

<del>作者又想GPU直通又不想开full access，怒而蹬大肥鱼 v41f 1017写出了这个</del>

| Key | 含义 |
|---|---|
| `read_write` | 工作区之外、在 `workspace-write` 模式下以读写方式暴露的宿主目录（在 `read-only` 模式下退化为只读）。 |
| `read_only` | 工作区之外、在所有模式下都只读暴露的宿主目录。 |
| `forbidden` | 进程沙箱用空 tmpfs 遮盖、文件系统 provider 拒绝读取并过滤列表的宿主目录。 |
| `dev` | 通过 bwrap `--dev-bind` 暴露的字符/块设备节点或 `/dev` 下路径，例如用于显卡直通的 `/dev/dri`。 |

部署级配置位于 bundle 唯一的插件行上。每个会话都可以通过 Session 头部的按钮覆盖任意 key；覆盖会写入会话的持久 plugin record，并作用于下一条受限命令和下一次文件系统操作。

## 目录

- [要求](#要求)
- [安装](#安装)
- [配置全局沙箱](#配置全局沙箱)
- [在 Web UI 中配置单个会话](#在-web-ui-中配置单个会话)
- [实际约束范围](#实际约束范围)
- [挂载顺序与优先级](#挂载顺序与优先级)
- [隔离与安全说明](#隔离与安全说明)
- [构建、测试与发布](#构建测试与发布)
- [已知限制](#已知限制)

## 要求

- Linux（`process.platform === 'linux'`）；bundle 声明了 `dsh.bundle.platforms: ["linux"]`，其他宿主会跳过该层并保留自带 provider。
- 基于 base 的 Harness profile（`web`、`headless`、`sdk` 或 `acp`）。bundle 的 patch 会停用自带的 `sandbox` 和 `fs-sandbox` 行并插入自己的行；不要把它装进已经挂载了另一个 `ctx.sandbox` 或 `ctx.fs` provider 的组合。
- `PATH` 中有可创建命名空间的 `bwrap`。每个 provider 生命周期只做一次功能探测；bwrap 不可用时以 `SANDBOX_UNAVAILABLE` 失败关闭。
- DeepSeek Harness `^0.2.2-rc.1`（由 `engines.dsh` 和 DSH peer 范围共同约束）。

## 安装

包发布到 npm 后：

```sh
dsh plugin --profile web add dsh-configurable-linux-sandbox
```

重启 profile。bundle 层位于 base 和 Web 层之后，因此其 patch 会停用 `sandbox` 与 `fs-sandbox` 并插入 `configurable-sandbox` 行。若要恢复自带 provider，请关闭整个 bundle；只关闭插入的行会让 profile 失去进程和文件系统 provider。

从本 checkout 开发时，构建后以本地链接安装到 profile：

```sh
npm --prefix dsh-configurable-linux-sandbox run build
dsh plugin --profile web add link:/绝对路径/dsh-configurable-linux-sandbox
```

profile 中的行必须使用包名（bundle patch 已如此），客户端模块扫描才能找到它的 `dsh.client` 半。使用绝对 `lib/index.js` 路径的行只适合调试 Host，不会加载 Web UI，因为 subpath/file 行不是 client row。[`scripts/link-local-deps.sh`](scripts/link-local-deps.sh) 还会把本 checkout 的运行时 peer 链接进包内，便于直接加载 Host；正常打包安装会按声明的 peer 解析依赖。

## 配置全局沙箱

bundle 行上的 config 就是部署级挂载意图：

```yaml
- id: configurable-sandbox
  config:
    read_write:
      - /home/me/.cache/uv
      - /home/me/projects/shared
    read_only:
      - /home/me/datasets
      - /var/log
    forbidden:
      - /home/me
    dev:
      - /dev/dri
    probeTimeoutMs: 5000
```

profile patch 会整体替换该行的 config，因此需要重述所有要保留的字段。完整示例见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `read_write` | `[]` | 绝对物理目录。`workspace-write` 下可读写；`read-only` 下变为只读。 |
| `read_only` | `[]` | 在所有模式下只读暴露的绝对目录。 |
| `forbidden` | `[]` | 用空 tmpfs 遮盖的绝对目录；文件系统 provider 拒绝读取其下内容。更深的条目可以重新暴露子树。 |
| `dev` | `[]` | 绝对的字符/块设备节点或 `/dev` 下路径。始终使用 `--dev-bind`，在两种文件模式中都生效。 |
| `probeTimeoutMs` | `5000` | 一次功能探测的正超时。 |

任何命令或文件系统操作之前都会强制检查路径规则：

- 每个条目必须是绝对路径、不含 NUL，并且存在。
- `read_write`、`read_only`、`forbidden` 必须是目录；`dev` 允许字符/块设备以及 `/dev` 下已存在的路径（设备节点或设备目录）。
- `read_write` 必须使用物理路径拼写（`realpath`）；校验时存在的别名会被拒绝，使 bind 或包含性检查指向被检查的目录。其余 key 会解析别名。
- 所有 key 都不允许列出 `/`。`/dev`、`/proc` 以及 `/proc` 下所有路径都是保留的基础挂载；`/dev` 下的路径只允许出现在 `dev` 中。workspace 位于 `/dev` 或 `/proc` 下也会被拒绝。
- 同一个物理路径不能出现在两个 key 中。祖先/后代重叠是允许的，由深度顺序决定生效结果。
- 配置时存在、执行时已消失的路径会让下一次操作以 `LINUX_SANDBOX_INVALID_CONFIG` 失败，而不是悄悄放大或缩小策略。

## 在 Web UI 中配置单个会话

打开一个会话，点击 Session 头部的齿轮按钮。弹窗显示会话模式、workspace，以及每个 key 一节：

- **Override** 复选框决定该 key 是否进入会话覆盖；未勾选时使用部署列表，并以只读方式显示。
- 路径以独立输入行呈现，可增删，因此含逗号或空格的路径无需编码。
- **保存** 写入被勾选的 key；勾选但列表为空会清空该 key 的会话值。
- **恢复全局配置** 追加一个空覆盖，让会话回到部署配置。

更改作用于下一条受限命令和下一次文件系统操作。它是持久化的：保存会追加 `plugin:dsh-configurable-linux-sandbox/mounts` plugin record，Host 在重放时折叠。表单使用现有 `/api` 通道上的认证、仅 owner 可用的路由（`GET`/`POST /api/dsh-configurable-linux-sandbox/mounts`），不是新的公开 API。

宿主代码可以使用同一条写入路径：

```ts
import type { Session } from '@deepseek-ai/dsh-session'
import { setSessionMountConfig } from 'dsh-configurable-linux-sandbox'

function configureResearchSession(session: Session): void {
  setSessionMountConfig(session, {
    read_write: ['/home/me/.cache/huggingface'],
    read_only: ['/home/me/datasets'],
    forbidden: ['/home/me'],
    dev: ['/dev/dri'],
  })
}
```

语义：

- 每次调用追加一个完整的会话覆盖；最后一条生效，两个会话之间互不影响。
- 覆盖中出现的 key 会替换该 key 的部署列表；省略的 key 继承部署列表。
- 显式空数组清空该会话的某个部署 key；`setSessionMountConfig(session, {})` 重置所有 key。
- key 相互独立，因此把继承来的授权收窄为只读需要同时清空另一个 key：部署 `read_write: [X]` 加会话 `{ read_write: [], read_only: [X] }` 可行，而单独的 `{ read_only: [X] }` 会与继承的 `read_write: [X]` 冲突并失败关闭。
- 第一阶段的记录名 `plugin:new-linux-sandbox/mounts` 仍会被折叠以兼容已有会话；新写入使用新名字。
- 存储的记录如果校验失败，该会话的受限调用和文件系统操作会失败关闭，而不是回退到部署配置。

## 实际约束范围

**进程（`ctx.sandbox`）。** provider 返回 `bwrap` 加自带隔离前缀，再加按序挂载。`workspace-write` 以可写方式 bind workspace 和配置的 `read_write` 路径，并加入临时 `/tmp`；`read-only` 以只读方式 bind workspace 和 `read_write` 路径。`forbidden` 路径变成空 tmpfs 挂载，`dev` 路径使用 `--dev-bind`。来自 `ctx.sandboxPolicy` 的额外可写根在 `workspace-write` 下追加，在 `read-only` 下不授予任何权限。

**文件系统工具（`ctx.fs`）。** bundle 用扩展同一 sandboxed backend 的 provider 替换 `dsh-fs-sandbox`。写操作保留部署模式、workspace、`additionalWritableRoots` 和临时区域的约束，并额外拒绝 `forbidden` 或 `read_only` 路径下的写入；`read_write` 路径会加入本次调用的可写根。读取、`stat`、`lstat`、`listDir`、`resolve` 和 `watch` 会拒绝或过滤 `forbidden` 路径，因此 `read`、`write`、`edit`、`patch`、`delete`、`move` 以及列表工具共享同一套边界。读取通过 Agent initiator scope 解析调用会话；写操作信任 policy 的 `sessionId`。

`ctx.fs.sandboxMode` 报告部署默认模式，因此 `tool-fs` 仍会提供 `sandbox_permissions` 与升级入口。已批准的升级会被遵守：`danger-full-access` 跳过挂载约束，此时进程沙箱也不会被调用。

## 挂载顺序与优先级

进程 argv 以 `bwrap` 开头，随后是自带隔离前缀，再后是按路径深度、再按路径排序的挂载：

```text
bwrap
--ro-bind / /
--dev /dev
--unshare-pid
--proc /proc
--die-with-parent
<有效挂载：浅路径在前，深路径覆盖>
```

workspace 始终挂载——`workspace-write` 下可写，`read-only` 下只读——因此 `forbidden` 祖先不能遮住会话自己的工作目录。文件系统 provider 使用同一份有效挂载列表（不含临时 `/tmp`），两条执行路径都会把路径解析到同一个最深条目。

深度顺序就是全部优先级规则：

```yaml
# 遮住 home，但保留两个子树。
forbidden: [/home/me]
read_only: [/home/me/datasets]
read_write: [/home/me/projects]

# 在可写树里让一个子目录只读。
read_write: [/home/me/projects]
read_only: [/home/me/projects/vendor]
```

同一路径的矛盾声明会在 runner 启动前失败。与已配置 `forbidden` 路径冲突的 policy `additionalWritableRoots` 会被拒绝，而不是被悄悄化解。

## 隔离与安全说明

进程 profile 与自带 Linux 沙箱一致：只读宿主根目录、全新的 `/dev`、私有 PID namespace，以及来自该 namespace 的 `/proc`。网络、UTS、IPC 和 cgroup namespace 仍与宿主共享；沙箱共享宿主内核、用户和文件系统。它约束文件效果，不约束网络或进程可见性。全新的 `/dev` 只包含 bwrap 的最小设备集，因此 `/dev/dri`、`/dev/shm` 等宿主路径在列入 `dev` 之前不存在。

`dev` 使用 `--dev-bind`，允许设备访问。设备访问不是文件效果：两种文件模式都不会限制它，暴露的设备（或 `/dev/shm` 这类可写的 `/dev` 路径）可以绕过挂载策略向内存或存储写入。provider 只允许字符/块设备和 `/dev` 下的路径，但这是类型检查，不是能力检查。请把 `dev` 当作显式的运维授权，保持列表最小。

与所有同世界沙箱一样，这是基于路径的约束。设备、继承的文件描述符、祖先可写时创建的硬链接，或挂载文件系统之外的内核接口，都可能绕过路径级意图；provider 不会宣称能阻止这些。

文件系统 provider 是可信代码对模型可控路径的围栏，不是内核边界：读取由 Host 进程拒绝，而不受信代码的隔离仍由进程沙箱负责。

## 构建、测试与发布

在仓库 checkout 根目录执行：

```sh
npm --prefix dsh-configurable-linux-sandbox run typecheck
npm --prefix dsh-configurable-linux-sandbox run test
npm --prefix dsh-configurable-linux-sandbox run build
```

`test` 运行单元、Cordis 组合、文件系统约束、Web 路由、客户端渲染和 bundle 组合测试，外加真实 bwrap e2e 测试。宿主无法创建命名空间时 e2e 自动跳过，与仓库自带的 bwrap 测试策略一致。如果 `lib/client.js` 尚不存在，请先运行 `build`，再运行客户端产物测试。

构建先用 `tsc -b` 生成声明和 JavaScript，再把 Host 入口打包为 `lib/index.js`，把 Client 闭包工厂生成为 `lib/client.js`。Host face 将 Harness 包和 `zod` 保持 external；Client face 只外置 shell 的平台模块。

发布：

```sh
npm --prefix dsh-configurable-linux-sandbox run build
cd dsh-configurable-linux-sandbox
npm pack --dry-run
npm publish
```

`npm publish` 需要已认证的 npm 账号。包名无 scope，因此不需要 `--access`。发布产物包含 `lib/index.js`、`lib/client.js`、声明文件、`cordis.patch.yml`、`locale/*.json`、README 和许可证；不会包含源码、测试或 source map。

源码地图：

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Bundle 入口：config schema 和三个 Host 插件。 |
| [`src/core.ts`](src/core.ts) | 挂载配置服务、projection 折叠和认证 Web 路由。 |
| [`src/provider.ts`](src/provider.ts) | bwrap 进程 provider。 |
| [`src/fs.ts`](src/fs.ts) | 懂挂载的文件系统 provider。 |
| [`src/mounts.ts`](src/mounts.ts) | 挂载规划、深度排序和 bwrap argv 渲染。 |
| [`src/paths.ts`](src/paths.ts) | 形状校验和物理路径解析。 |
| [`src/session.ts`](src/session.ts) | 持久会话记录与 projection 定义。 |
| [`src/contract.ts`](src/contract.ts) | 共享路由路径和 Web 视图词汇。 |
| [`src/client/`](src/client) | Session 头部按钮、弹窗表单、locale 字典和路由客户端。 |
| [`cordis.patch.yml`](cordis.patch.yml) | bundle 层：停用自带 provider 并插入本 bundle 行。 |
| [`tests/`](tests) | 单元、组合、fs、Web 路由、客户端和 bundle 测试。 |

## 已知限制

- **`grep` 和 `glob` 尚未接入挂载配置。** 它们通过 `ctx.subprocess` 运行 ripgrep，而不是 `ctx.fs`，因此搜索树内的 `forbidden` 目录仍可能被这两个工具遍历。读写、编辑、列表等文件系统工具和所有受限进程会遵守配置。
- **仅支持基于 base 的 profile。** bundle 停用自带的 `sandbox`/`fs-sandbox` 行；如果组合已由另一个 bundle 提供 `ctx.sandbox` 或 `ctx.fs`，会在服务注册时冲突。
- **仅 Linux + bwrap。** 未覆盖自定义 runner argv、Landlock、Seatbelt 或 Windows。功能探测结果在 provider 生命周期内缓存；安装或修复 bwrap 后需要重新加载插件或重启。
- **网络 namespace 仍共享**，与自带 Linux profile 一致。
- **设备访问绕过文件模式**，如上所述。
- **`forbidden` 是可见性围栏，不是 inode 能力边界。** 围栏之外的同 inode 硬链接或已打开文件描述符仍可访问同一数据。
- **会话覆盖是插件记录。** 没有本插件的构建会跳过它们，Session 格式迁移只会尽力保留插件记录；记录丢失后该会话会回退到部署配置。若要更强的持久性保证，需要把事件声明进仓库内的会话事件格式。
- **两种模式下 workspace 都必须存在。** `read-only` 下仍会以只读方式重新挂载 workspace，避免 `forbidden` 祖先遮住会话 cwd；workspace 被删除时调用会失败。
