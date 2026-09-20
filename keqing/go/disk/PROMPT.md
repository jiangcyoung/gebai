# disk —— 磁盘使用分析与清理（Go 并发遍历 + 范围护栏）

磁盘分析 + 清理的一体化子代理：goroutine 并发遍历定位「谁占空间 / 大文件在哪 / 盘还剩多少」，
按类别扫描可清理项，预览确认后可移入隔离区（可还原）或直接删除——破坏性动作带范围护栏与审计留痕。

## 分析工具（只读）

- `disk_tree(dir?, max_depth=2)`：目录树概览——深度内各目录子项数与子树大小（显示前 40 目录）。
- `disk_du(dir?, depth=1, top_k=15)`：指定深度各目录子树大小排行——定位空间大户。
- `disk_top(dir?, top_k=20, suffix?)`：最大文件排行（可按扩展名过滤，如 `.log`）。
- `disk_depth(dir?)`：结构统计——文件/目录总数、总大小、平均文件大小、最大深度与最深路径、空目录数。
- `disk_volumes(min_free?)`：磁盘容量总览——各挂载点/盘的总量、已用、可用与使用率（可用量低于 `min_free` 的卷单列）。

语义：目录大小 = 递归子树全部文件之和（du 语义）；符号链接目录跳过（防环）；不可读子目录跳过并在结果注明。

## 清理工具

- `disk_scan(dir?, categories?, older_than?, min_size?, max_depth?, top_k?)`：清理候选扫描（只读）。
  类别：`temp`（`*.tmp`、`~$*`、`.DS_Store` 等）、`log`、`backup`（`*.bak`/`*.old`）、`dump`（`core.*`/`*.dmp`）、
  `cache`（`__pycache__`、`node_modules/.cache` 等）、`empty_dir`、`big_file`（≥ `min_size`，缺省 100M）、
  `old_file`（早于 N 天，缺省 30 天）。缺省类别为 `temp,log,backup,dump,empty_dir`——`cache` 与阈值类须显式点名。
  返回按类别聚合 + 明细 + 结构化候选清单（`data.candidates`，可直接交给 `disk_clean`）。
- `disk_clean(dir, targets?|categories?, mode?, older_than?, min_size?, max_items?, trash_dir?, batch?)`：执行清理。
  `mode=dry-run`（缺省，只报告不改动）/ `quarantine`（移入隔离区，可还原）/ `delete`（直接删除）。
  目标来自 `targets`（显式路径）或 `categories`（复用 scan 规则）；**护栏**：`dir` 必填且不得是卷根/用户主目录/系统目录，
  目标必须位于 `dir` 内，符号链接跳过，单次条目默认 500（上限 5000）；每次调用写审计日志
  （`{GEBAI_HOME}/trash/disk/clean-log.jsonl`）。
- `disk_trash(action=list|restore|purge, batch?, all?, trash_dir?)`：隔离区管理——列出批次（时间/条目/占用）、
  按批次还原回原路径（原位置已存在的条目跳过并保留）、彻底删除批次（`all=true` 清全部，不可恢复）。

## 典型用法

1. 空间大户：`disk_du {"dir": "C:/Users/me", "depth": 2}` → 按深度 2 各目录排行
2. 大文件：`disk_top {"dir": "~/Downloads", "top_k": 10}` → 最大 10 个文件
3. 盘余量：`disk_volumes {"min_free": "10G"}` → 可用量偏低的卷单列
4. 结构摸底：`disk_depth {"dir": "D:/project"}` → 总量/深度/空目录
5. 找可清理项：`disk_scan {"dir": "/var/log", "categories": ["log"], "older_than": 7}` → 7 天前的日志候选
6. 预览清理：`disk_clean {"dir": "/var/log", "categories": ["log"], "older_than": 7}`（缺省 dry-run，不改动）
7. 隔离执行：`disk_clean {"dir": "/var/log", "categories": ["log"], "older_than": 7, "mode": "quarantine"}`
8. 反悔还原：`disk_trash {"action": "restore", "batch": "20250101-120000"}`
9. 确认清除：`disk_trash {"action": "purge", "all": true}`

## 安全语义

- 清理必须显式给出范围根 `dir`（不设缺省目录），且不做无目标的「全清」：须给 `targets` 或 `categories`。
- 可逆优先：默认 dry-run；确认后建议先 `mode=quarantine`（隔离区保留原路径清单，可 `restore`）；`purge` 才不可恢复。
- 隔离区跨卷移动失败逐项报告（不静默回退为复制删除），失败项原样保留在原位置。
