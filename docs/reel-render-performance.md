# reel 渲染性能：实测诊断与提速方案

> 本文是**实测报告**（不是估算），用于决定渲染架构下一步怎么走。
> 机器：i7-14700KF（20 核 / 28 线程）· 32GB · RTX 4080 SUPER 16GB · Windows 11 · Remotion 4.0.484 · Chrome 149
> 复现脚本与样张：见文末「观测数据留存」

---

## 一、基线：现状有多慢，慢在哪

| 项 | 实测值 |
|---|---|
| 现状成片（gebai-promo · 1350 帧 @1920×1080/30fps） | 57.9s → **23.3 fps** |
| 单浏览器进程并发 2 / 4 / 8 / 14 / 20 / 28 页 | 14.8 / 20.1 / 20.8 / 21.3 / 21.7 / 21.5 fps |
| 渲染期间整机 CPU 占用 | **33%** |
| 每帧耗时构成（单页 1080p） | seek（React 渲染+布局）**19ms** ／ 截帧通道 **~50–90ms** |

**结论 1：单浏览器进程有串行瓶颈。** 页数从 2 加到 28，吞吐锁死在 ~21 fps；CPU 只用三分之一。加并发只是把每帧延迟从 130ms 拉到 1000ms，不提吞吐。

**结论 2：瓶颈在「截帧」段，不在编码。** JPEG 质量 82→40 无差异；`-q 0` 无差异；480×270 仍有 38ms —— 该段大部分是**与像素数无关的固定开销**。

**结论 3：硬件编码在现架构下不可能启用。** Remotion 自带 ffmpeg 是 `--disable-encoders` 编译的（只启用 libx264/x265/aom 等软件编码器，无 nvenc/qsv/amf）；compositor（`remotion.exe`）通过 rust-ffmpeg **直接链接 `avcodec-61.dll`**（符号 `__imp_avcodec_find_encoder`），**不 spawn `ffmpeg.exe`** —— 所以「换一个带 nvenc 的 ffmpeg 到 `binaries_directory`」这条路是死的（该参数对硬件编码无效）。实测探针报 `Hardware encoder "h264_nvenc" is not available in your FFmpeg build`。

---

## 二、已验证有效的三条提效路径

### 路线 A：多进程分片并行（**+1.8x**，低风险）

每片自带浏览器进程与页面池，各渲一段后再拼接：

| 分片 | 聚合吞吐 | 整机 CPU |
|---|---|---|
| 1 进程 × 4 页（基线） | 13.2 fps | 33% |
| 6 进程 × 4 页 | **38.4 fps** | 59% |
| 8 进程 × 3 页 | 39.1 fps（1 进程崩） | 60% |
| ≥10 进程 | 子进程开始失败 | 60% |

天花板不在 CPU（60%）也不在内存（余 12GB），而在进程规模带来的稳定性问题。**注意**：单进程内页数 ≤4 是甜蜜点；把页数堆到 14/28 纯属浪费。

### 路线 B：换光栅化后端（**每帧 −23%**）

`chromiumOptions.gl = "vulkan"` 时每帧 97ms → 75ms。默认档是软件光栅（SwiftShader），GPU 基本闲置。

### 路线 C：把「截帧+编码」整条链搬进页面（**4–5x**，已验证但见第四节风险）

Chrome 的 HTML-in-canvas：`<canvas layoutsubtree>` + `ctx.drawElementImage(stage, …)` —— 本机 Chrome 149 支持（Remotion 默认就给浏览器开了 `CanvasDrawElement`）。

**受控对照（同一画面内容，只换 GL）**

| GL | `drawElementImage` | `new VideoFrame(canvas)`（真正的栅格化） | 单页上限 |
|---|---|---|---|
| 默认（软件） | 0.12ms | **20.19ms** | 49 fps |
| `angle`（D3D11） | 0.03ms | **6.18ms** | 161 fps |
| `vulkan` | 0.02ms | 6.27ms | 159 fps |

**真片端到端（gebai-promo，6 页，帧 600–1199 共 600 帧）**

| 管道 | 耗时 | 吞吐 |
|---|---|---|
| 新管道（页面内取帧 + WebCodecs H.264 + mediabunny 封装 MP4） | 5.09s | **117.9 fps** |
| 现状（renderMedia：CDP 截图 + ffmpeg） | 24.70s | 24.3 fps |
| | | **4.85x** |

同帧段逐帧 PSNR（两条管道解码后逐像素比对）：**mean 38.7 dB**（视觉一致），但 **worst 22 dB** —— 个别帧内容不一致，见第四节。

新管道的每帧构成（真片，单页）：`setFrame 0.06ms` + `就绪轮询 0.13ms` + **等一帧 rAF 18.35ms** + `drawElementImage 0.03ms` + `栅格 0.37ms`；4 页 109 fps、8 页 121 fps（聚合）。

> 关键：`drawElementImage` 用的是**已缓存的绘制记录**。DOM 改完后必须发生一次真正绘制才能取到本帧；实测 `Promise.resolve()` 后取 → 全为陈旧帧，`setTimeout(0)` → 仍错，**必须等 ≥1 次 rAF**（≈18ms）。所以单页上限被钉在 ~60fps，突破要靠确定性帧控制（`--enable-begin-frame-control` + `HeadlessExperimental.beginFrame`）或解除帧率限制。

---

## 三、附带发现：渲染页其实是 Remotion Studio

生产渲染的 URL 是 `http://localhost:<port>/?/Reel`，页面里 `remotion_isStudio === true`、标题是 `Reel / gebai-promo - Remotion Studio`、带 `#__remotion-studio-container` 与整条时间轴 UI。也就是说**每一帧都在让 Studio 那套 React 应用重渲染**，截帧也覆盖着 Studio 的界面（靠 clip 只取合成区）。

→ 「换一个精简捕获页」是一条尚未开发的独立优化项（省掉 Studio 的重渲染与多余层）。

---

## 四、**保真边界（关键风险，必须正视）**

逐项对照「同一份内容」的 `drawElementImage` 取像与普通 DOM 的 CDP 截图：

| CSS 手法 | canvas 取像是否与截图一致 |
|---|---|
| 普通面板（无变换） | ✅ 一致 |
| `backdrop-filter: blur()` | ⚠️ 面板在，**模糊效果丢失** |
| `filter: blur()` | ❌ **整块丢失** |
| `mix-blend-mode` | ❌ **整块丢失** |
| `transform: translate/scale` | ❌ **整块丢失** |
| `zoom` | ❌ **整块丢失** |

（对照图：`tmp/bench/work/css-ref.png` 与 `css-canvas.png`；前者 5 块，后者只有 2 块）

原因推测：`drawElementImage` 只绘制该元素自身绘制记录里的内容，**不递归那些自成绘制块/合成层的子元素**（filter / mix-blend / transform / zoom 都会创建独立绘制块）。

对 reel 的现实影响很硬：镜头原语与 PageCam **大量依赖 `transform` 与 `zoom`**（PageCam 的运镜就是 `zoom`+`transform`），面板普遍用 `backdrop-filter`。真片跑下来的表现是「大多数帧对得上（mean 38.7dB）、个别帧内容缺失（worst 22dB）」——**不满足交付级一致性**。

---

### 已核查并排除的三项（附证据，避免后人重走）

| 项 | 结论 | 证据 |
|---|---|---|
| 生产渲染页是 Remotion Studio（每帧让 Studio 的 React 跟着重渲染） | **不成立**：生产渲染已在 composition 模式，Studio 不在页面里 | Remotion 的 `makePage` 会调 `remotion_setBundleMode({type:'composition'})`，而 Studio 在 bundle 里是**惰性 `import()`**。同页实测：Studio 模式 1327 个 DOM 节点 / `#video-container` 高 0 / seek 34.1ms；composition 模式 **73 个节点** / 容器 1920×1080 / **seek 11.4ms**。（早前微基准以为“页面是 Studio”，是因为我在探针里直接 `goto` 而未调 `setBundleMode`——错的，不是生产） |
| Chromium 帧率/垂直同步旗标可提速 | **单位置有效、生产无效** | 单页微基准：默认 107.7ms/帧 → `--disable-frame-rate-limit` 81.1 → 再加 `--disable-gpu-vsync` **76.8ms（×1.40）**，且输出保真（PSNR 77.7 dB）。但端到端（1 浏览器 × 6 页）35.6 → 35.8 fps（**×1.005**）；扫「浏览器数 × 片内页数 × 旗标」后：6×4 默认 **72.6 fps**（当前默认档）vs 6×4+旗标 71.4、8×2+旗标 74.7（在噪声内）。**旗标只在页面未打满时有效，而分片并行已把等待盖住** |
| 页面内取帧（HTML-in-canvas）管道可替代截帧 | **保真有硬边界，不可用于交付** | 重做保真判定（内容**从一开始就建在 canvas 子树内**、不 reparent；用官方 `canvas.requestPaint()` + `paint` 事件等真绘制完成，不猜 rAF）：`plain` 与 `backdrop` 卡片画出来了，而 **`filter` / `mix-blend-mode` / `transform` / `zoom` 四种卡片整块缺失**。说明是 `drawElementImage` 的语义限制（不递归自成绘制块的子元素），不是时序问题——而 PageCam 的运镜恰恰全靠 `zoom` + `transform` |

另：`canvas.requestPaint()` 在 Chrome 149 可用（`@remotion/canvas-capture` 的官方通道就是靠它）——但它解决的是「何时该画」，解决不了上面那条绘制块递归限制。

---

## 五、结论与落地情况

1. **瓶颈诊断定案**：不是算力，是「截帧通道」——单浏览器串行 + 软件光栅 + 回读/传输固定开销。
2. **已实测落地的两把旋钮（真片 600 帧验证）**：

| 路径 | 耗时 | 吞吐 |
|---|---|---|
| 整段·默认档 | 25.6s | 23.4 fps |
| 整段·实测调优档（gl=angle） | 21.2s | 28.3 fps（×1.21） |
| **分片并行（6 片）·调优档** | **9.9s** | **60.6 fps（×2.14）** |
| **合计** | | **×2.59** |

同帧段逐帧 PSNR（分片 vs 整段）：**mean 56.0 dB / worst 42.8 dB**；容器时长、帧数、音视频流完全一致。

   - **分片并行**（`shards.ts` + `jobs.ts`）：每片一个独立 Chrome，无声视频段并行渲染后 concat 无损拼接，音轨整段单独渲一次再合轨；片数自动（上限 6，实测饱和点），失败回退整段。
   - **光栅化后端纳入 bench 实测**：默认档（交给 Chrome 自选）也作为候选参与实测，最快者写调优缓存。
3. **一个被顺手修掉的真实缺陷**：`gl`/`chromeMode` 是**浏览器启动参数**，而原实现先用未调优档位启动浏览器、再用调优档位渲染——浏览器不是那个档位的，调优里的 gl 形同虚设。现改为先定档再准备浏览器（合成 ID 未知时定档后换对应档位的浏览器）。
4. **仍未做的（需另开一轮，风险已标明）**：页面内取帧 + WebCodecs 管道（吞吐 4.85x，但保真有硬边界，见第四节）/ 精简捕获页（绕开 Studio）/ 确定性帧控制（干掉每帧 18ms 的 rAF 等待）/ 页面内硬编码。

### 待办（按优先级）

| # | 事项 | 预期 | 状态 |
|---|---|---|---|
| 1 | 分片并行渲染编排（多浏览器 + 无损拼接 + 音轨合回 + 失败回退） | ×2.14 | ✅ 已落地 |
| 2 | 光栅化后端纳入 bench 实测（含“Chrome 自选”候选） | ×1.21 | ✅ 已落地 |
| 3 | 先定档再启动浏览器（修 gl/chromeMode 不生效） | — | ✅ 已落地 |
| 4 | 精简捕获页（绕开 Studio） | — | ✅ 核查后不成立：生产已在 composition 模式（Remotion 自带行为） |
| 5 | 确定性帧控制（`--enable-begin-frame-control`）或解帧率限制 | — | ✅ 实测后不采用：单位置 −29ms/帧，分片形态下无收益（并发已盖住等待） |
| 6 | 页面内取帧 + WebCodecs 管道 | — | ❌ 重测后判死：`filter`/`blend`/`transform`/`zoom` 整块丢失（语义限制） |
| 7 | 页面内编码强制走硬件（`prefer-hardware`） | 释放 CPU | 待实测（仅在页面内管道成立时才有意义） |
| 8 | 换渲染基底：镜头原语移植到 Canvas2D/WebGL + WebCodecs | 目标 10x+ | 待论证（大改；不受上述 DOM 绘制块限制，是唯一能绕开截帧回读的路） |

---

## 六、观测数据留存

脚本（会话工作区 `tmp/bench/`）：

- `harness.ts` / `battery.ts`：单进程并发矩阵、分辨率与格式对照、分片矩阵
- `shard2.ts` / `mem.ts`：多进程分片吞吐与内存/CPU 采样（严格统计真实写出帧）
- `phases.ts` / `capture.ts`：帧内相位拆解（seek / 截图 / CDP 往返）
- `micro2.ts`：受控微基准（zoom vs transform、blur、backdrop-filter）
- `webcodecs.ts`：WebCodecs 编码能力与吞吐（真实成片帧）
- `drawperf.ts` / `inpage*.ts` / `canvas-v2.ts` / `canvas-v3.ts`：HTML-in-canvas 通道探测与真片流水线
- `staleness.ts`：绘制记录陈旧帧判定（必须等 rAF）
- `fidelity2.ts`：**保真边界重测**（内容不 reparent + 官方 `requestPaint()`/`paint` 事件）——第四节「已核查并排除」表格的来源
- `page-mode.ts`：Studio 模式 vs composition 模式（DOM 节点数 / seek 成本）
- `shot-variants.ts`：各种「取一帧」实现与 Chromium 旗标的单位置对照
- `flags.ts` / `flags-e2e.ts` / `flag-shard.ts`：旗标在单位置 / 单浏览器 / 分片形态下的效果与保真
- `e2e.ts`：**端到端**（新管道出 MP4 + 与现状逐帧 PSNR）
- `fidelity.ts`：**保真边界对照**（第四节表格的来源）

结果与样张（`tmp/bench/work/`）：`results.jsonl`、`shard2.jsonl`、`drawpipe-sample.png`、`css-ref.png` vs `css-canvas.png`、`e2e/newpath.mp4` vs `e2e/refpath.mp4`、`e2e/cmp-new-16.png` vs `cmp-ref-16.png`。
