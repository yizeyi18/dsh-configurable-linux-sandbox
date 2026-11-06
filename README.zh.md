# dsh-configurable-linux-sandbox

[English](README.md) | 中文

一个 Linux-only 的可配置 DeepSeek Harness 沙箱实现。

<del>作者又想GPU直通又不想开full access，怒而蹬大肥鱼 v41f 1017写出了这个</del>

| Key | 含义 |
|---|---|
| `read_write` | 工作区之外的宿主目录；`workspace-write` 下可写，`read-only` 下只读。 |
| `read_only` | 在所有模式下都只读暴露的宿主目录。 |
| `forbidden` | 用空 tmpfs 遮盖、并由文件系统 provider 拒绝访问的宿主目录。 |
| `dev` | 通过 bwrap `--dev-bind` 暴露的字符/块设备或 `/dev` 下路径；例如用于 GPU 直通的 `/dev/dri`。 |

## 要求

- Linux。bundle 声明了 `dsh.bundle.platforms: ["linux"]`；其他宿主会保留内置 provider。
- 基于 base 的 Harness profile（`web`、`headless`、`sdk` 或 `acp`）。不要与其他已提供 `ctx.sandbox` 或 `ctx.fs` 的插件一起安装。
- `PATH` 中有可创建命名空间的 `bwrap`。不可用时以 `SANDBOX_UNAVAILABLE` 失败关闭。
- DeepSeek Harness `^0.2.2-rc.1`。

## 安装

```sh
dsh plugin --profile web add dsh-configurable-linux-sandbox
```

bundle patch 会停用内置的 `sandbox` 和 `fs-sandbox` 行，并插入 `configurable-sandbox`。在 Web **插件** 页启用会立即生效；否则下次启动生效。

本地 checkout：

```sh
npm install
npm run build
dsh plugin --profile web add link:/绝对路径/dsh-configurable-linux-sandbox
```

行必须使用包名（bundle patch 已如此），否则只能加载 Host 端，不会加载 Web UI。

## 部署级配置

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

`read_write`、`read_only`、`forbidden`、`dev` 默认 `[]`；`probeTimeoutMs` 默认 `5000`，用于限制一次功能探测的时长。

路径规则：

- 条目必须绝对、不含 NUL 且存在。`read_write`、`read_only`、`forbidden` 必须是目录；`dev` 接受字符/块设备和 `/dev` 下已存在的路径。
- `read_write` 必须使用物理路径（`realpath`）；其他 key 会解析别名。
- 拒绝 `/`。`/dev`、`/proc` 及其下路径是保留的基础挂载；`/dev` 下的路径只允许出现在 `dev`。workspace 位于 `/dev` 或 `/proc` 下也会被拒绝。
- 同一物理路径不能出现在两个 key 中。祖先/后代重叠允许，由深度决定生效结果。
- 配置后消失的路径会让下一次操作以 `LINUX_SANDBOX_INVALID_CONFIG` 失败，而不是悄悄改变策略。

## 会话级覆盖

打开会话，点击 Session 头部的齿轮按钮。弹窗显示模式、workspace，以及每个 key 一节：

- **Override** 决定该 key 是否进入会话覆盖；未勾选时使用部署列表，并以只读方式显示。
- 路径按独立行增删，含逗号或空格的路径无需编码。
- **保存** 写入被勾选的 key；勾选但列表为空会清空该 key 的会话值。
- **恢复全局配置** 让会话回到部署配置。

更改作用于下一条受限命令和下一次文件系统操作，并会持久化：每次保存追加一条 `plugin:dsh-configurable-linux-sandbox/mounts` 记录，Host 在重放时折叠。

宿主代码可以通过包根导出的 `setSessionMountConfig(session, config)` 使用同一条写入路径。每次调用追加一个完整覆盖：最后一条生效，省略的 key 继承部署列表，空数组清空该 key，`{}` 重置全部。存储的记录校验失败时，该会话的受限命令和文件系统操作都会失败关闭。

## 实际约束范围

**进程（`ctx.sandbox`）。** `workspace-write` 以可写方式 bind workspace 和 `read_write` 路径，并加入临时 `/tmp`；`read-only` 以只读方式 bind workspace 和 `read_write` 路径。`forbidden` 路径变成空 tmpfs 挂载，`dev` 路径使用 `--dev-bind`。来自 `ctx.sandboxPolicy` 的额外可写根只在 `workspace-write` 下追加。

**文件系统工具（`ctx.fs`）。** bundle 用同一 sandboxed backend 加挂载围栏替换 `dsh-fs-sandbox`：拒绝 `forbidden` 或 `read_only` 下的写入，把 `read_write` 加入本次调用的可写根，并让读取、`stat`、`lstat`、`listDir`、`resolve` 和 `watch` 拒绝或过滤 `forbidden` 路径。

`ctx.fs.sandboxMode` 仍会提供 `sandbox_permissions`；已批准的 `danger-full-access` 升级会跳过挂载围栏，因为该模式下不会调用进程沙箱。

## 挂载优先级

挂载按路径深度、再按路径排序；更深的条目覆盖更浅的条目。workspace 始终挂载，因此 `forbidden` 祖先不能遮住会话自己的工作目录。同一路径的矛盾声明会在 runner 启动前失败。

```yaml
# 遮住 home，但保留两个子树。
forbidden: [/home/me]
read_only: [/home/me/datasets]
read_write: [/home/me/projects]

# 在可写树里让一个子目录只读。
read_write: [/home/me/projects]
read_only: [/home/me/projects/vendor]
```

## 安全说明

进程 profile 与内置 Linux 沙箱一致：只读宿主根目录、全新的 `/dev`、私有 PID namespace，以及挂载自该 namespace 的 `/proc`。网络、UTS、IPC 和 cgroup namespace 仍与宿主共享；沙箱约束文件效果，不约束网络或进程可见性。

`dev` 使用 `--dev-bind`，授予设备访问，而两种文件模式都不会限制它。暴露的设备（或 `/dev/shm` 这类可写的 `/dev` 路径）可以绕过挂载的文件策略写入。请把 `dev` 当作显式的运维授权，保持最小。

这是基于路径的约束，不是内核边界：设备、继承的文件描述符、硬链接和挂载文件系统之外的内核接口都可能绕过路径级意图。文件系统 provider 是可信代码对模型可控路径的围栏；不受信代码的隔离仍由进程沙箱负责。

## 开发

```sh
npm install        # 或 npm ci
npm run typecheck
npm test
npm run build
```

`test` 运行单元、组合、实时启用、文件系统、Web 路由、客户端渲染和 bundle 测试，外加真实 `bwrap` e2e；宿主无法创建命名空间时 e2e 自动跳过。若 `lib/client.js` 尚不存在，先运行 `build` 再跑客户端产物测试。

构建会生成声明文件，把 Host 入口打包为 `lib/index.js`，把 Client 闭包工厂生成为 `lib/client.js`。要针对未发布的 DSH checkout 测试，运行 `DSH_CHECKOUT=/path/to/deepseek-harness npm run link`；重新 `npm install` 可恢复 npm 包。

发布：

```sh
npm run build
npm pack --dry-run
npm publish
```

## 已知限制

- **`grep` 和 `glob` 尚未接入挂载配置。** 它们通过 `ctx.subprocess` 而不是 `ctx.fs` 运行，因此搜索树内的 `forbidden` 目录仍可能被遍历。
- **仅支持基于 base 的 profile。** 如果组合已由另一个 bundle 提供 `ctx.sandbox` 或 `ctx.fs`，注册时会冲突；活跃的第三方 provider 会在实时启用时以 `LINUX_SANDBOX_PROVIDER_CONFLICT` 失败，而不会被替换。
- **仅 Linux + bwrap。** 未覆盖自定义 runner argv、Landlock、Seatbelt 或 Windows。探测结果在 provider 生命周期内缓存；安装或修复 bwrap 后需要重新加载插件或重启。
- **`forbidden` 是可见性围栏，不是 inode 边界。** 围栏之外的硬链接或已打开文件描述符仍可访问同一数据。
- **会话覆盖是插件记录。** 没有本插件的构建会跳过它们，Session 迁移只会尽力保留；记录丢失后该会话回退到部署配置。
