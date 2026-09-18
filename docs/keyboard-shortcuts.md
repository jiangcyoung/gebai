# 歌白键盘快捷键

这份表由键位表生成口径维护：**唯一来源**是 `packages/web/src/keymap.ts`（机制）+ `keymap-main.ts`（主界面表）+ `files/keymap-wb.ts` / `files/main.ts`（工作台表）。页面里的快捷键一览（标题栏轮盘「快捷键」、工作台「更多 → 快捷键」）也由同一张表渲染，不存在第二份手写清单。

## 总则

- **键位族一律 `Ctrl+Alt+*`**：Chromium / Edge / Firefox / Windows / macOS 都没有默认绑定（系统级仅 `Ctrl+Alt+Del`，不涉及）。少数例外是浏览器不独占的键：`Esc`（关闭）、`Enter`（发送/提交）、无输入焦点时的单键 `Y`/`N`、`F2`/`F8`/`F9`、`Alt+Z`（VSCode 同款自动换行）、`Ctrl+C`（终端中断）、`Ctrl+Shift+F`（终端内搜索）。
- **守卫集中在分发器**（`keymap.ts` 的 `createKeymap`）：
  - 焦点在**输入框**内的**工作台**快捷键默认不接管（保存、刷新、提交等显式声明的除外）——在过滤框、提交信息框、日志搜索框里打字不会被全局动作吞掉；
  - **主界面例外**：那里的默认焦点就是聊天输入框（进草稿页/切会话/回答结束都会自动聚焦），所以会话语的带修饰键快捷键（`Ctrl+Alt+N/B/E`）在输入框内**照常生效**——否则它们几乎没机会命中。不带修饰键的 `Y`/`N` 仍排除输入框（打字 `y`/`n` 不应误批）；
  - 焦点在**终端面板**内默认不接管——shell 的 readline 键（`Ctrl+W` 删词、`Ctrl+P` 上一条、`Ctrl+E` 行尾、`Ctrl+K` 删到行尾、`Ctrl+B` 左移）全部回归终端；
  - **输入法组合态**（中文候选）一律不接管，`Enter`/`Esc` 不会被当成发送或关闭；
  - **长按重复**默认不触发动作。
- **`Esc` 只关最上层**：弹窗、菜单、查看器、下拉都以「作用域」入栈，`Esc` 命中的是栈顶那一个（此前 11 个文档级监听互不相让，按一次会连关一排浮层）。
- **机制化防回归**：`keymap.test.ts` 断言主界面表「无重复登记、无浏览器保留键」与「带修饰键的绑定在输入框内也生效」，工作台表在启动时自检；新增键位撞车或守卫写漏会直接让测试变红。

## 主界面

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Alt+N` | 新建会话（进入草稿页；已在草稿页时无操作，防误触清草稿） |
| `Ctrl+Alt+B` | 折叠 / 展开会话列表（窄屏为滑动抽屉） |
| `Ctrl+Alt+E` | 开关文件分屏（连按两次回到无分屏） |
| `Y` / `N` | 审批：通过 / 拒绝最早等待的卡片（无输入焦点时；有修饰键或长按不触发） |
| `Ctrl+Enter` | 中断插入提交（运行中取消当前循环后立即执行；空闲等同发送） |
| `Enter` / `Shift+Enter` | 输入框内：发送 / 换行 |
| `↑` / `↓` | 输入框内：浏览用户级输入历史（空输入进入，`↓` 回到底部恢复草稿） |
| `←→↑↓` / `Home` / `End` / `Enter` / `Space` | 消息分段条获焦后：移动焦点、跳到首/末分段、跳到选中分段 |
| `Esc` | 关闭最上层浮层（确认框 / 输入框 / 主题面板 / 会话菜单 / 文件预览 / 图表与 HTML 查看器 / 动作轮盘 / 输入建议） |

## 文件工作台（`/files` 页与分屏 iframe）

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Alt+S` | 保存（文件内容 / 合并结果 / 暂存结果，按活动标签分派） |
| `Ctrl+Alt+E` | 查看 ↔ 编辑模式 |
| `Ctrl+Alt+O` | 快速打开文件（相对当前根） |
| `Ctrl+Alt+W` | 关闭当前标签 |
| `Ctrl+Alt+K` | 「更多」菜单（新建 / 比较 / 服务端开关 / 快捷键一览） |
| `Ctrl+Alt+B` | 显示 / 隐藏左侧栏 |
| `Ctrl+Alt+1` / `Ctrl+Alt+2` / `Ctrl+Alt+3` | 显示资源管理器 / 搜索视图 / 左侧变更面板 |
| `Ctrl+Alt+F` | 资源管理器：在当前目录过滤 |
| `Ctrl+Alt+G` | 底部 Git 工具窗 |
| `Ctrl+Alt+T` | 底部终端工具窗 |
| `Ctrl+Alt+D` | 比较（任意两个提交 / 提交与工作区） |
| `Ctrl+Alt+R` | 刷新资源管理器与 Git 状态 |
| `F2` | 重命名选中项（资源管理器） |
| `Ctrl+Alt+↓` / `Ctrl+Alt+↑` | 差异视图：下一处 / 上一处差异 |
| `Ctrl+Alt+→` / `Ctrl+Alt+←` | 差异视图：下一个 / 上一个变更文件（多文件审视） |
| `F9` / `F8` | 合并视图：下一处 / 上一处冲突 |
| `Ctrl+Alt+M` | 合并视图：标记为解决（`git add`） |
| `Alt+Z` | 切换自动换行 |
| `Ctrl+Enter` | 提交信息框内：提交 |
| `Esc` | 关闭菜单 / 弹窗 / 浮层（只关最上层） |

> 差异导航的两个组合用**捕获阶段**接管：Monaco 的 diff editor 自带 `F7`/`Shift+F7`（diffReview）并会 `stopPropagation`，document 捕获又早于 Monaco 自己的 keybinding 服务；`Ctrl+Alt+↓/↑` 同时是 Monaco 的「插入光标」组合，因此工作台内多光标改动请用 `Alt+点击`。

## 终端面板内（焦点在终端时，工作台全局键一律让位）

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Alt+C` | 复制选区 |
| `Ctrl+Alt+V` | 粘贴 |
| `Ctrl+Shift+F` | 搜索滚动缓冲 |
| `Ctrl+Alt+=` / `Ctrl+Alt+-` / `Ctrl+Alt+0` | 字号 +1 / −1 / 复位 |
| `Ctrl+C` | 中断当前命令（有选区时改为复制；浏览器不独占该键，终端的中断语义就建在它上面） |
| `Ctrl+Alt+L` | 清屏（仅降级终端；`Ctrl+L` 是浏览器的「聚焦地址栏」） |
| `Enter` / `↑` `↓` | 执行命令 / 命令历史（降级终端的输入框内） |

## 为什么不用那些"顺手"的键

旧键位是照 VSCode 习惯抄的（`Ctrl+S/P/W/E/K/B`、`Ctrl+Shift+*`、`F5`、`F7`），它们恰好全是浏览器保留键：

| 键 | 浏览器行为 | 备注 |
|---|---|---|
| `Ctrl+N` | 新窗口 | **Chromium 不把按键交给网页**，`preventDefault` 无效——旧实现只能靠 `Ctrl+Shift+O` 兜底 |
| `Ctrl+W` | 关闭标签页 | 能拦，但拦不住时关掉的是整个歌白页面 |
| `Ctrl+S` | 保存页面 | 同上 |
| `Ctrl+P` | 打印 | 同上 |
| `Ctrl+K` / `Ctrl+E` / `Ctrl+L` | 地址栏搜索 / 地址栏 / 地址栏 | 焦点被抢走 |
| `Ctrl+F` / `Ctrl+=` `-` `0` | 页面查找 / 缩放 | |
| `Ctrl+Shift+E/F/G/D/R` | Firefox 网络监视器 / — / — / 收藏全部标签 / 强制刷新 | |
| `Ctrl+Shift+C` | DevTools「审查元素」 | DevTools 打开时抢不走（终端复制因此改 `Ctrl+Alt+C`） |
| `F5` / `F7` | 刷新 / Firefox 光标浏览 | |

判据写成了可执行形式 `browserRisk()`：`Ctrl+Alt+*` 一律安全；`Ctrl+*`、`Ctrl+Shift+*`、裸 `Alt+字母/方向`、F 键区（`F2`/`F8`/`F9` 除外）与 `Ctrl+=/−/0` 判为保留键，测试遍历全表断言零命中。

## 旧 → 新对照

| 功能 | 旧 | 新 |
|---|---|---|
| 新会话 | `Ctrl+N` / `Ctrl+Shift+O` | `Ctrl+Alt+N` |
| 会话列表 / 工作台左栏 | `Ctrl+B` | `Ctrl+Alt+B` |
| 文件分屏（主界面） | `Ctrl+Shift+E` | `Ctrl+Alt+E` |
| 保存（工作台） | `Ctrl+S` | `Ctrl+Alt+S` |
| 查看 ↔ 编辑 | `Ctrl+E` | `Ctrl+Alt+E` |
| 快速打开文件 | `Ctrl+P` | `Ctrl+Alt+O` |
| 关闭标签 | `Ctrl+W` | `Ctrl+Alt+W` |
| 「更多」菜单 | `Ctrl+K` | `Ctrl+Alt+K` |
| 资源管理器 / 搜索 / 变更 | `Ctrl+Shift+E` / `Ctrl+Shift+F` / `Ctrl+Shift+G` | `Ctrl+Alt+1` / `Ctrl+Alt+2` / `Ctrl+Alt+3` |
| 比较 | `Ctrl+Shift+D` | `Ctrl+Alt+D` |
| 刷新资源管理器与 Git | `F5` | `Ctrl+Alt+R` |
| 差异块导航 | `F7` / `Shift+F7` / `Alt+↓↑` | `Ctrl+Alt+↓` / `Ctrl+Alt+↑` |
| 跨文件导航 | `Ctrl+Alt+↓` / `Ctrl+Alt+↑` | `Ctrl+Alt+→` / `Ctrl+Alt+←` |
| 标记为解决 | `Ctrl+Shift+R` | `Ctrl+Alt+M` |
| 终端复制 / 粘贴 | `Ctrl+Shift+C` / `Ctrl+Shift+V` | `Ctrl+Alt+C` / `Ctrl+Alt+V` |
| 终端搜索 | `Ctrl+F` | `Ctrl+Shift+F` |
| 终端字号 | `Ctrl+=` / `-` / `0` | `Ctrl+Alt+=` / `-` / `0` |
| 降级终端清屏 | `Ctrl+L` | `Ctrl+Alt+L` |
| 保持不变 | `Y`/`N`、`Enter`、`Shift+Enter`、`Ctrl+Enter`、`↑↓`、`Alt+Z`、`F2`、`F8`/`F9`、`Ctrl+C`（终端）、`Esc` | |

## 新增或修改一个键位

1. 在对应表里加一条声明（`id` / `keys` / `label` / `group` / `run`，必要时 `focus`、`phase`、`when`、`note`）；
2. 键位族遵守上表约束——`browserRisk` 会在测试里拦住保留键；
3. 帮助 UI 与本文档**不需要改**：它们由 `helpGroups()` 从表生成；
4. 提示文案（按钮 `title`/`data-tip`、占位符）仍需手改，保持「动作（快捷键）」两句式；
5. 跑 `bun test`（`keymap.test.ts` 会校验重复与保留键）。
