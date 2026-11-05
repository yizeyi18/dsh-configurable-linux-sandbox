# new-linux-sandbox

[English](README.md) | 中文

一个可配置的、仅面向 Linux 的 bwrap 沙箱，以 Cordis 插件形式提供给 DeepSeek Harness。

这是第一阶段的原型：项目自带沙箱只有“只读 / 工作区可写 / 完全权限”三档，本插件在保留同样系统资源隔离的前提下，增加四个项目自带策略无法表达的挂载意图 key：

| Key | 含义 |
|---|---|
| `read_write` | 工作区之外、在 `workspace-write` 模式下以读写方式暴露的宿主目录（在 `read-only` 模式下退化为只读）。 |
| `read_only` | 工作区之外、在所有模式下都只读暴露的宿主目录。 |
| `forbidden` | 用空 tmpfs 遮盖的宿主目录，沙箱内看不到其内容。 |
| `dev` | 通过 bwrap `--dev-bind` 暴露的宿主设备节点或 `/dev` 下的设备目录，例如用于显卡直通的 `/dev/dri`。 |

配置提供两个层级：插件行的全局配置，以及持久化的会话级覆盖。无论配置来自哪个层级，挂载都按前缀语义生效：更深层的路径覆盖更浅层的路径，因此可以用 `forbidden` 遮住父目录，再用 `read_only` 子目录重新暴露一个子树。

## 目录

- [状态与要求](#状态与要求)
- [配置全局沙箱](#配置全局沙箱)
- [配置单个会话](#配置单个会话)
- [挂载顺序与优先级](#挂载顺序与优先级)
- [隔离与安全说明](#隔离与安全说明)
- [构建与测试](#构建与测试)
- [已知限制与下一阶段](#已知限制与下一阶段)

## 状态与要求

第一阶段是独立包，不在仓库的 pnpm workspace 中。运行要求：

- Linux（`process.platform === 'linux'`）；插件构造函数在其他平台直接拒绝加载。
- `PATH` 中有可创建命名空间的 `bwrap`。每个 provider 生命周期只做一次功能探测；bwrap 不可用时以 `SANDBOX_UNAVAILABLE` 失败关闭，命令不会启动。
- 已列为 peer dependency 的 DeepSeek Harness 包必须能从挂载该插件的 profile 解析到。
- 该原型嵌套在 checkout 中：`tsconfig.json` 和 `vitest.config.ts` 引用 checkout 根做源码解析，因此构建和测试需要保持该布局。
- 在本 checkout 中构建和测试需要 Node.js 24.9 或更高版本。

provider 对每次包装都报告 `enforcement: 'full'`：bwrap 挂载覆盖了所有承诺的文件效果。设备访问不属于文件效果，由 `dev` 单独控制（见[隔离与安全说明](#隔离与安全说明)）。

## 配置全局沙箱

用 profile patch 停用自带的 `sandbox` 行，再以新 id 插入本 provider：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: sandbox
  disabled: true
- insert:
    - id: sandbox-linux
      name: new-linux-sandbox
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

这个例子故意把 `forbidden: ['/home/me']` 与它下面的授权并存：tmpfs 先遮住 `/home/me`，更深的 `read_write`、`read_only` 条目再把各自子树重新暴露出来。`read_write` 条目必须是物理路径（不允许符号链接授权）；`read_only`、`forbidden`、`dev` 条目会被规范化为物理路径。

完整示例见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)。插入行的 `name` 必须能从 profile 的包树解析到，因此在启动 profile 之前需要把构建好的包安装或链接进去。

### 字段参考

| 字段 | 默认值 | 含义 |
|---|---|---|
| `read_write` | `[]` | 绝对物理目录。`read-only` 模式下降为只读；`workspace-write` 模式下以读写 bind。 |
| `read_only` | `[]` | 绝对目录。始终以只读 bind。 |
| `forbidden` | `[]` | 绝对目录。挂载为空 tmpfs；更深的条目可以重新暴露子树。 |
| `dev` | `[]` | 绝对的字符/块设备节点，或 `/dev` 下的路径。始终使用 `--dev-bind`，在两种文件模式中都生效。 |
| `probeTimeoutMs` | `5000` | 一次功能探测的正超时。 |

bwrap 启动前会强制检查路径规则：

- 每个条目必须是绝对路径、不含 NUL，并且在执行受限命令时存在。
- `read_write`、`read_only`、`forbidden` 必须是目录。`dev` 允许字符/块设备节点以及 `/dev` 下已存在的路径（设备节点或设备目录）；其他普通文件、socket 和任意位置的目录会被拒绝。
- `read_write` 必须使用物理路径拼写（`realpath`），使校验和 bind 指向同一个物理目录；校验时存在的别名会被拒绝，校验之后被替换的路径仍属于基于路径的残余竞态。其余 key 会解析别名。
- 所有 key 都不允许列出 `/`；根目录由基础 profile 自己挂载。`/dev`、`/proc` 以及 `/proc` 下的所有路径都是保留的基础挂载，在所有 key 中都会被拒绝。`/dev` 下的路径只允许出现在 `dev` 中，因此设备暴露只有一个入口。
- 同一个物理路径不能出现在两个 key 中。一个路径可以作为另一个 key 路径的祖先或后代出现；由深度顺序决定最终生效的挂载。
- 配置时存在、执行时已消失的路径会让本次受限调用以 `LINUX_SANDBOX_INVALID_CONFIG` 失败。

## 配置单个会话

会话级配置是持久化的：覆盖被记录为 `plugin:new-linux-sandbox/mounts` 插件记录（plugin record），由 host-only 的 `sandboxLinuxMounts` projection 折叠。该记录对不认识本包的读取方是 `ignorable` 的，因此当前格式的读取方会保留并跳过它，而不是拒绝整个日志；本插件在重放时折叠它，而格式迁移只会尽力保留插件记录。它只属于一个会话，并且不会进入模型对话记录。存储的记录如果校验失败，受限调用会失败关闭，而不是悄悄回退到全局配置。

```ts
import type { Session } from '@deepseek-ai/dsh-session'
import { setSessionMountConfig } from 'new-linux-sandbox'

function grantGpuAndDocs(session: Session): void {
  setSessionMountConfig(session, {
    read_write: ['/home/me/.cache/huggingface'],
    read_only: ['/home/me/datasets'],
    forbidden: ['/home/me/.ssh'],
    dev: ['/dev/dri'],
  })
}
```

语义：

- 每次调用追加一条记录，携带该会话的完整覆盖。最后的记录生效；两个会话之间互不影响。
- 事件中出现的 key 会整体替换该 key 的全局列表；省略的 key 继承全局列表。
- 显式空数组用于清空该会话的某个全局 key。
- `setSessionMountConfig(session, {})` 让会话回到全局配置。
- 写入路径在追加事件前检查路径是否绝对、格式是否正确；文件系统存在性和可用性在每次受限调用时重新检查，因此目录被删除时会失败关闭，而不是悄悄放大或缩小策略。
- key 是独立替换的，因此把继承来的授权收窄为只读必须同时清空另一个 key：全局 `read_write: [X]` 加会话 `{ read_write: [], read_only: [X] }` 可行，而单独的 `{ read_only: [X] }` 会与继承的 `read_write: [X]` 冲突并失败关闭。
- 会话覆盖不能移除 policy 的 `additionalWritableRoots`；这是 seam 层授权，在 `workspace-write` 下追加在会话/全局列表之后。
- 如果 policy 指定的会话已不在活动 store 中，受限调用以 `LINUX_SANDBOX_SESSION_UNAVAILABLE` 失败，不会回退到全局配置。本 provider 需要活动的 `Session` 对象来读取 projection，因此携带 `sessionId` 的 policy 无法为 detached 会话提供服务。

第一阶段没有用于该写入路径的 Web UI 或工具。宿主 UI、工具插件或会话初始化代码可以用自己持有的 `Session` 调用它。

## 挂载顺序与优先级

最终 argv 以 `bwrap` 开头，随后是自带隔离前缀，再后是按路径深度、再按路径排序的挂载：

```text
bwrap
--ro-bind / /
--dev /dev
--unshare-pid
--proc /proc
--die-with-parent
<有效挂载：浅路径在前，深路径覆盖>
```

`workspace` 始终挂载一次：`workspace-write` 下可写，`read-only` 下只读；因此 `forbidden` 祖先不能遮住会话自己的工作目录。`workspace-write` 下还会在基础前缀之后加入临时 `--tmpfs /tmp`，除非任一 key 已经显式列出 `/tmp`。policy 的 `additionalWritableRoots` 在 `workspace-write` 下追加到可写集合，在 `read-only` 下不授予任何权限，与 seam 契约一致。

深度顺序就是全部优先级规则。例如：

```yaml
# 遮住 home，但保留两个子树。
forbidden: [/home/me]
read_only: [/home/me/datasets]
read_write: [/home/me/projects]

# 在可写树里让一个子目录只读。
read_write: [/home/me/projects]
read_only: [/home/me/projects/vendor]
```

同一路径的矛盾声明（同一物理路径同时出现在 `read_write` 与 `forbidden`、两个 key 同时指向 workspace、policy 额外可写根与已配置的 `forbidden` 冲突）会在 runner 启动前失败。

## 隔离与安全说明

隔离前缀与自带 Linux profile 一致：只读宿主根目录、全新的 `/dev`、私有 PID namespace，以及来自该 namespace 的 `/proc`。网络、UTS、IPC 和 cgroup namespace 仍与宿主共享；沙箱共享宿主内核、用户和文件系统。它约束文件效果，不约束网络或进程可见性。
全新的 `/dev` 只包含 bwrap 的最小设备集，因此 `/dev/dri`、`/dev/shm` 等宿主路径在列入 `dev` 之前不存在。

`dev` 使用 `--dev-bind`，允许设备访问。设备访问不是文件效果：两种文件模式都不会限制它，暴露的设备（或 `/dev/shm` 这类可写的 `/dev` 路径）可以绕过挂载策略向内存或存储写入。provider 只允许字符/块设备和 `/dev` 下的路径，但这是类型检查，不是能力检查；请把 `dev` 当作显式的运维授权，保持列表最小。显卡直通通常只需要 `/dev/dri`。

与所有同世界挂载沙箱一样，这是基于路径的约束。设备、继承的文件描述符、在祖先可写时创建的硬链接，或挂载文件系统之外的内核接口，都可能绕过路径级意图；provider 不会宣称能阻止这些。

第一阶段只包装进程。仓库的文件系统工具由它们自己的 fs 约束管理；这里的 `read_write` 作用于受限进程（bash 及其他 `ctx.sandbox` 消费者），不作用于独立的 fs 工具策略。把同一意图接入 fs seam 是第二阶段工作。

## 构建与测试

在仓库 checkout 根目录执行：

```sh
npm --prefix new-linux-sandbox run typecheck
npm --prefix new-linux-sandbox run test
npm --prefix new-linux-sandbox run build
```

`test` 运行单元测试、Cordis 组合测试和真实 bwrap e2e 测试。宿主无法创建命名空间时 e2e 自动跳过，与仓库自带的 bwrap 测试策略一致；受限宿主（例如 AppArmor 限制非特权 user namespace 的容器）会跳过 e2e 用例，argv、生命周期和会话用例仍会运行。

构建先用 `tsc -b` 生成 `lib/types/`（声明和 JavaScript），再用 tsdown 把插件入口打包为 `lib/index.js`。Harness 包、`zod` 和 `@deepseek-ai/schemastery` 保持 external。

若想直接从本 checkout 以绝对路径加载构建好的插件，而无需安装进 profile，可把 checkout 中的 peer 包链接到本包自己的 `node_modules`：

```sh
npm --prefix new-linux-sandbox run link
```

随后插入行可以直接指向构建入口：

```yaml
- insert:
    - id: sandbox-linux
      name: /absolute/path/to/deepseek-harness/new-linux-sandbox/lib/index.js
      config:
        read_only: [/home/me/datasets]
```

[`scripts/link-local-deps.sh`](scripts/link-local-deps.sh) 只链接本 checkout 中的包；正常打包安装时会按声明的依赖解析。移动 checkout 后需要重新运行它。

源码地图：

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口与 `ctx.sandbox` provider：配置、workspace/模式解析、bwrap 探测、包装。 |
| [`src/paths.ts`](src/paths.ts) | 形状校验与物理路径解析，包括符号链接策略和跨 key 冲突。 |
| [`src/mounts.ts`](src/mounts.ts) | 挂载规划、深度排序和 bwrap argv 渲染。 |
| [`src/session.ts`](src/session.ts) | 插件记录声明、projection 单元和 `setSessionMountConfig` 写入路径。 |
| [`src/types.ts`](src/types.ts) | 公共配置与挂载计划类型。 |
| [`tests/`](tests) | 单元、组合和真实 bwrap 测试。 |

## 已知限制与下一阶段

- 仅 Linux；固定使用 bwrap。未覆盖自定义 runner argv、Landlock、Seatbelt 或 Windows 后端。
- bwrap 功能探测结果在 provider 生命周期内缓存；安装或修复 bwrap 后需要重新加载插件（或重启 profile）。
- `read-only` 下仍会以只读方式重新挂载 workspace（避免 `forbidden` 祖先遮住会话 cwd），因此即使在该模式下 workspace 也必须存在；workspace 被删除时调用会失败。
- 会话覆盖是插件记录：没有本插件的构建会跳过它，Session 格式迁移只会尽力保留插件记录，因此记录丢失后该会话会回退到部署配置。若要更强的持久性保证，需要把事件声明进仓库内的会话事件格式。
- 网络、UTS、IPC、cgroup namespace 仍共享，与自带 Linux profile 一致。
- 文件系统工具 seam 尚未接入四个 key；`read_write` 目前只放宽进程约束。
- 第一阶段没有用于会话配置的客户端、宿主 UI 或模型可见工具；导出的写入路径面向宿主插件。
- 该包是 `private` 的独立包。安装进 profile 时，需要让 profile 能解析它的 peer 包。
- 若把该包移入 harness workspace，需要把 `plugin:new-linux-sandbox/mounts` 登记进生产 plugin record 目录（或经格式评审后改为声明的会话事件）。
- 真实命名空间覆盖取决于宿主是否允许非特权 user namespace；受限宿主会跳过 e2e。
