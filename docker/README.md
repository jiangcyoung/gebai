# 歌白（GEBAI Agent）· 容器部署

服务模式镜像：Ubuntu 24.04 基础镜像 → 构建阶段跑完仓库既有构建链 → `bun build --compile`
产出**单文件 Linux 可执行** → 运行阶段只有系统库加这一个二进制（不带 node_modules、不带 bun）。

- `../Dockerfile`：镜像定义（多阶段、构建参数、运行期依赖逐项注明用途）
- `build.sh` / `build.ps1`：构建脚本（Linux/macOS 与 Windows 同参数）
- `compose.yaml`：最小可跑的 compose 示例

## 快速开始

```bash
# 1) 构建（默认标签 gebai:<package.json 版本>）
docker/build.sh                       # Windows: pwsh -File docker/build.ps1
docker/build.sh --smoke               # 构建后自动起容器自检（健康检查 + 隔离探测）再清理

# 2) 运行
docker run -d --name gebai -p 3000:3000 \
  -v gebai-data:/data \
  -e GEBAI_LLM_API_KEY=sk-… \
  -e GEBAI_LLM_MODEL=gpt-4o-mini \
  gebai:0.1.0

# 3) 打开 http://localhost:3000
```

## 构建

| 参数（脚本开关） | 默认 | 说明 |
|---|---|---|
| `UBUNTU_VERSION` | `24.04` | 基础镜像版本（构建阶段与运行阶段同版本） |
| `BUN_VERSION` | `1.3.14` | 取 `oven/bun` 里的 bun 可执行文件用于构建；**最终镜像不含 bun** |
| `WITH_CV`（`--no-cv`） | `1` | 内嵌本地 CV（PP-OCR 模型 + onnxruntime-web 运行时）；关闭后本地 OCR/视觉定位不可用 |
| `CV_MODEL_BASE`（`--cv-model-base`） | hf-mirror 的 RapidOCR 托管 | 内网/离线改自备镜像 |
| `WITH_BROWSER`（`--with-browser`） | `0` | 安装 playwright chromium（浏览器类子Agent 用）；镜像显著增大 |
| `PLAYWRIGHT_VERSION` | `1.62.1` | 须与仓库依赖一致，否则运行时版本不匹配 |
| `BUN_TARGET`（`--target`） | 空（按构建机架构） | 跨架构时显式指定（如 `bun-linux-arm64`） |

**架构限制**：二进制内嵌 `@resvg/resvg-js`（平台原生模块），跨架构编译会嵌错平台 —— 本镜像只支持
「构建机架构 = 目标架构」。`linux/arm64` 请在 arm64 机器上构建（或在该架构的 CI runner 上）。

**构建上下文**：`.dockerignore` 排除了工作区的运行期数据与大体积资产（实测 `resources` 68GB、
`infer` 9.4GB、`vendor` 0.7GB、`node_modules` 1.5GB，以及 `users/`、`tmp/`、`.env`、桌面端产物
`*.exe`/`*.bun-build` 等），只传源码；改前端或后端源码不必重装依赖（依赖层只依赖各 `package.json`）。

**构建期网络前置**（全部在构建阶段，与运行期无关）：

| 用途 | 目标 | 不可达时的处理 |
|---|---|---|
| 拉基础镜像 | Docker Hub（`ubuntu:24.04`、`oven/bun`） | 配镜像加速器（`/etc/docker/daemon.json` 的 `registry-mirrors`，或 Docker Desktop 同名设置）；本机实测 `docker.m.daocloud.io`、`docker.1ms.run`、`docker.xuanyuan.me` 可拉到这两个镜像 |
| 装依赖 | npm registry | 换 `registry.npmmirror.com`（bun 的 `BUN_CONFIG_REGISTRY` 或 `.npmrc`） |
| 装系统包 | Ubuntu apt（`archive.ubuntu.com`） | 在派生镜像里换国内镜像源 |
| CV 模型（`WITH_CV=1`） | `hf-mirror.com` | `--cv-model-base` 指向自备镜像；也可先 `bun run resources:download` 后把模型放进构建上下文（脚本优先用本地已有模型） |
| 浏览器（`--with-browser`） | playwright CDN | 内网无出口时不要该开关（浏览器类子Agent 不可用） |

## 运行

### 配置注入（两种，可混用）

1. **环境变量**（`-e` / compose 的 `environment`）——适合密钥与容器编排；
2. **`{GEBAI_HOME}/.env`**，即挂卷里的 `/data/.env`——二进制模式启动时自动读取，适合把一整套配置
   随数据卷走。真实环境变量优先于该文件。

模型配置（`GEBAI_LLM_*`/`GEBAI_VISION_*`）等完整清单见仓库根 `.env.example`。

### 首次登录

- **默认**（未设 `GEBAI_ADMIN_PASSWORD_HASH`）：admin 用户禁用，任意访客可在登录页**自助注册**
  （普通角色）；`GEBAI_SIGNUP_MODE=approval` 时注册需 admin 审批——此时须先有 admin。
- **启用 admin**：设置 `GEBAI_ADMIN_PASSWORD_HASH`（格式 `salt:hash`）。生成方式（在源码检出里）：

  ```bash
  bun run --cwd packages/server hash-password        # 交互输入后输出 salt:hash
  ```

### 数据持久化

`/data`（`GEBAI_HOME`）承载全部持久状态：用户、会话、任务与待办、Webhook 配置，以及二进制模式
运行时物化的目录（`vendor/`：playwright 驱动与 pwcore、d2js、ripgrep；`resources/`：内嵌 CV 模型）。

- **用命名卷**（如 `-v gebai-data:/data`）——首启会继承镜像内 `/data` 的属主（uid 1000）。
- **用宿主目录挂载**时注意属主：容器以非 root 用户 `gebai`（uid 1000）运行，宿主目录需 uid 1000
  可写，否则会出现「会话目录不可写」类错误。确有需要可按宿主 uid 重建镜像或调整目录属主。

## 容器内的隔离与安全

镜像默认 `GEBAI_MODE=server`，因此仓库既有的两条启动期保证直接生效（启动日志会打印
`auth=server, sandbox=true`）：

- **路径沙箱强制开启**（`GEBAI_SANDBOX=off` 与服务模式互斥，启动即拒）；
- **会话目录脚本隔离强制开启**（`GEBAI_SCRIPT_ISOLATION=off` 与服务模式互斥）：脚本 `cwd` 绑定会话目录，
  `HOME`/`USERPROFILE`/`TEMP`/`TMP`/`TMPDIR`/`XDG_*` 全部指向 `{会话}/script-env/`。

在此之上还有一层**文件系统隔离**（bubblewrap）：它需要容器允许创建 user namespace，而**这一步受容器运行时
限制**——不是镜像里装上 `bubblewrap` 就够了。实测（Ubuntu 24.04 容器，Docker 29，非 root 用户）：

| 运行方式 | user namespace | 脚本实际生效档位 |
|---|---|---|
| `docker run`（默认 seccomp） | ✗ `unshare: Operation not permitted` | 环境收敛（HOME/TEMP/XDG 在会话目录内） |
| `--cap-add SYS_ADMIN` | ✓ 能创建，但 bwrap 仍失败：`pivot_root: Operation not permitted` | 环境收敛 |
| `--security-opt seccomp=unconfined` | ✓ | **环境收敛 + bwrap 文件系统隔离**（系统只读、仅会话目录可写、宿主家目录不可见） |

所以要拿满隔离，用 `--security-opt seccomp=unconfined`（compose 里把 `security_opt` 注释打开）。容器内自查：

```bash
docker exec <容器> unshare --user --map-root-user echo ok   # 输出 ok = bwrap 层可用
```

降级是**如实**且安全的：环境收敛始终生效，不会出现「以为隔离了其实没隔离」；显式配置
`GEBAI_SCRIPT_ISOLATION=bwrap` 而不可用时，首次脚本执行会输出一条带失败原因的告警。
`docker/build.sh --smoke` 也会直接打印该容器里 user namespace 是否可用。

## 能力边界（容器内的如实口径）

| 能力 | 状态 | 原因 |
|---|---|---|
| 会话/任务/工具/子Agent/文件工作台/图表渲染 | 可用 | 均已内嵌进二进制 |
| 本地 OCR / 视觉定位 | 默认可用 | `WITH_CV=1` 内嵌模型；`--no-cv` 构建则不可用 |
| 浏览器类子Agent（playwright / reverse_site） | 需 `--with-browser` | 未装浏览器时报「不可用」并给出指引；且同需 user namespace |
| `desktop`（截屏/窗口/键鼠） | 不可用 | 服务模式下整体拒绝（宿主桌面操控不对远程用户开放） |
| `tts_speak`（文本转语音） | 不可用 | 仅 Windows 内置离线语音引擎；工具会如实说明「不做联网合成」。音效/效果/混音为纯计算，可用 |
| 客卿（多语言）子代理 | 不可用 | 服务模式整体禁用（无会话隔离的原生进程） |
| `reel`（产品视频制作） | 不可直接使用 | 需 Node 运行时 + ffmpeg + Chrome（镜像未装）；要此能力请派生镜像补装 |
| `restart_server` 工具 | 不适用 | 容器内请用 `docker restart gebai`（该工具面向宿主机进程拉起的部署，本镜像未验证其在 PID 1 = tini 下的行为） |

## 运维

```bash
docker logs -f gebai                     # 日志（stdout）
docker exec gebai curl -s localhost:3000/api/health   # 健康检查（免鉴权，返回 { ok, boot }）
docker restart gebai                     # 重启
docker compose -f docker/compose.yaml up -d
```

- **升级**：重新构建镜像并重建容器，`/data` 卷原样保留（数据与配置都不动）。
- **反向代理**：Web UI 的 REST/WS/静态资源一律按页面 URL 相对解析，子路径挂载（如 `/gebai/`）
  无需额外配置；代理需转发 WebSocket。
- **多实例**：同一 `/data` 只应有一个实例（调度主实例锁在同一数据根上互斥）；多副本请各自独立卷。

## 故障排查

| 现象 | 处理 |
|---|---|
| 打不开页面 | `docker logs gebai` 看监听地址；确认 `-p 3000:3000` 且容器健康 |
| 登录页无 admin 账号 | 未设 `GEBAI_ADMIN_PASSWORD_HASH`：改用自助注册，或按上文生成哈希后重建容器 |
| 提示会话目录不可写 | 宿主目录挂载的属主问题（容器 uid 1000）——改用命名卷或调整属主 |
| 日志出现 bwrap 不可用告警 | 容器未授予 user namespace：按上文加 `--security-opt seccomp=unconfined`，或接受环境收敛档 |
| 本地 OCR 报模型缺失 | 构建时用了 `--no-cv`，或模型下载失败（看构建日志）；可重建并指定 `--cv-model-base` |
| 浏览器子Agent 报无浏览器 | 用 `--with-browser` 重建镜像 |
