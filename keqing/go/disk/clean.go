// disk 子代理项目：磁盘清理（候选扫描 / 执行清理 / 隔离区管理）。
// 设计约束：清理必须显式给出范围根（dir），不设缺省目录；目标一律经范围校验——必须位于根内、
// 拒绝系统目录与卷根、不跟随符号链接；破坏性动作具备 dry-run 预览、可选隔离区（可还原）与审计留痕。
// 分析遍历复用 main.go 的 walkConcurrent（du 语义子树大小）。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	fw "gebai/keqing-framework/framework"
)

const (
	catTemp   = "temp"
	catLog    = "log"
	catBackup = "backup"
	catDump   = "dump"
	catCache  = "cache"
	catEmpty  = "empty_dir"
	catBig    = "big_file"
	catOld    = "old_file"
)

// 缺省扫描类别：cache 目录重建成本高（可能含状态），阈值类需要条件才成立，均须显式点名。
var defaultScanCategories = []string{catTemp, catLog, catBackup, catDump, catEmpty}

var allScanCategories = []string{catTemp, catLog, catBackup, catDump, catCache, catEmpty, catBig, catOld}

var categoryLabel = map[string]string{
	catTemp:   "临时文件",
	catLog:    "日志文件",
	catBackup: "备份文件",
	catDump:   "崩溃转储",
	catCache:  "缓存目录",
	catEmpty:  "空目录",
	catBig:    "大文件",
	catOld:    "久未修改",
}

// 名字规则（大小写不敏感）。
var (
	tempSuffixes   = []string{".tmp", ".temp", ".swp", ".swo", ".part", ".crdownload", ".download", "~"}
	tempNames      = map[string]bool{".ds_store": true, "thumbs.db": true, "desktop.ini": true}
	backupSuffixes = []string{".bak", ".old", ".orig", ".save", ".sav", ".backup"}
	dumpSuffixes   = []string{".dmp", ".stackdump", ".hprof", ".mdmp"}
	cacheDirNames  = map[string]bool{
		"__pycache__": true, ".pytest_cache": true, ".mypy_cache": true, ".ruff_cache": true,
		".ipynb_checkpoints": true, ".parcel-cache": true, ".turbo": true, ".sass-cache": true,
		".nyc_output": true, ".cache": true, ".gradle": true, ".tox": true,
	}
	// basename 为 cache 且父目录命中时也算缓存目录（node_modules/.cache、.next/cache 等）
	cacheParentNames = map[string]bool{
		"node_modules": true, ".next": true, ".nuxt": true, ".vite": true,
		".parcel-cache": true, ".turbo": true, "dist": true, "target": true,
	}
)

// candidate —— 清理候选：路径 + 子树大小（du 语义）+ 类别与命中理由。
type candidate struct {
	Path     string `json:"path"`
	Rel      string `json:"rel"`
	Size     int64  `json:"size"`
	IsDir    bool   `json:"isDir"`
	Category string `json:"category"`
	Reason   string `json:"reason"`
}

// scanOptions —— 扫描条件（categories 已展开为集合）。
type scanOptions struct {
	categories    map[string]bool
	olderThan     time.Duration // 0 = 不限（old_file 类别自带缺省）
	minSize       int64         // big_file 阈值（<=0 表示用缺省）
	maxDepth      int           // 0 = 不限（遍历始终全量）
	includeHidden bool
	limit         int // 候选收集上限
}

type walkStats struct {
	Files  int `json:"files"`
	Dirs   int `json:"dirs"`
	Errors int `json:"errors"`
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func isHiddenName(name string) bool {
	return strings.HasPrefix(name, ".") && name != "." && name != ".."
}

// classifyName —— 按名字归类（不含空目录与阈值类：那是上下文相关判定）；未命中返回空串。
func classifyName(name string, isDir bool, parentName string) string {
	lower := strings.ToLower(name)
	if isDir {
		if cacheDirNames[lower] {
			return catCache
		}
		if lower == "cache" && cacheParentNames[strings.ToLower(parentName)] {
			return catCache
		}
		return ""
	}
	if tempNames[lower] || strings.HasPrefix(lower, "~$") {
		return catTemp
	}
	for _, s := range tempSuffixes {
		if strings.HasSuffix(lower, s) {
			return catTemp
		}
	}
	for _, s := range backupSuffixes {
		if strings.HasSuffix(lower, s) {
			return catBackup
		}
	}
	for _, s := range dumpSuffixes {
		if strings.HasSuffix(lower, s) {
			return catDump
		}
	}
	if lower == "core" || (strings.HasPrefix(lower, "core.") && isDigits(lower[len("core."):])) {
		return catDump
	}
	if strings.HasSuffix(lower, ".log") || strings.Contains(lower, ".log.") {
		return catLog
	}
	return ""
}

func modTimeOf(path string) (time.Time, bool) {
	info, err := os.Lstat(path)
	if err != nil {
		return time.Time{}, false
	}
	return info.ModTime(), true
}

// scanCandidates —— 遍历 root，按类别/阈值/年龄收集清理候选（只读；不跟随符号链接目录）。
// 目录候选的大小为该目录子树文件总大小（du 语义）。
func scanCandidates(root string, opt scanOptions) ([]candidate, walkStats, []string) {
	entries, errs := walkConcurrent(root)
	stats := walkStats{Errors: len(errs)}
	childCount := map[string]int{}
	for _, e := range entries {
		childCount[filepath.Dir(e.path)]++
		if e.isDir {
			stats.Dirs++
		} else {
			stats.Files++
		}
	}
	sizes := subtreeSize(entries, root)
	now := time.Now()
	var out []candidate
	seen := map[string]bool{}
	add := func(e fileInfo, category, reason string, size int64) {
		if seen[e.path] || (opt.limit > 0 && len(out) >= opt.limit) {
			return
		}
		seen[e.path] = true
		rel, err := filepath.Rel(root, e.path)
		if err != nil {
			rel = e.path
		}
		out = append(out, candidate{
			Path: e.path, Rel: rel, Size: size, IsDir: e.isDir,
			Category: category, Reason: reason,
		})
	}
	for _, e := range entries {
		name := filepath.Base(e.path)
		if !opt.includeHidden && isHiddenName(name) {
			continue
		}
		if opt.maxDepth > 0 && e.depth > opt.maxDepth {
			continue
		}
		size := e.size
		category, reason := "", ""
		if e.isDir {
			size = sizes[e.path]
			if opt.categories[catEmpty] && childCount[e.path] == 0 {
				category, reason = catEmpty, categoryLabel[catEmpty]
			} else {
				if c := classifyName(name, true, filepath.Base(filepath.Dir(e.path))); c != "" && opt.categories[c] {
					category, reason = c, categoryLabel[c]
				}
			}
		} else {
			if c := classifyName(name, false, ""); c != "" && opt.categories[c] {
				category, reason = c, categoryLabel[c]
			}
			if category == "" {
				switch {
				case opt.categories[catBig] && opt.minSize > 0 && e.size >= opt.minSize:
					category, reason = catBig, fmt.Sprintf("大小 ≥ %s", humanSize(opt.minSize))
				case opt.categories[catOld]:
					category, reason = catOld, "久未修改的文件"
				default:
				}
			}
		}
		if category == "" {
			continue
		}
		// 年龄条件：显式 older_than 对所有类别生效（空目录除外）；old_file 类别未给定则套用缺省。
		if category != catEmpty {
			age := opt.olderThan
			if category == catOld && age <= 0 {
				age = defaultOldAge
			}
			if age > 0 {
				mt, ok := modTimeOf(e.path)
				if !ok || now.Sub(mt) < age {
					continue
				}
				reason = fmt.Sprintf("%s（%d 天未修改）", reason, int(now.Sub(mt).Hours()/24))
			}
		}
		add(e, category, reason, size)
	}
	return out, stats, errs
}

const defaultOldAge = 30 * 24 * time.Hour
const defaultBigSize = 100 << 20 // 100 MiB

// expandCategories —— categories 参数展开（all = 全类别；缺省为安全子集）。
func expandCategories(raw []string) (map[string]bool, []string, string) {
	set := map[string]bool{}
	if len(raw) == 0 {
		for _, c := range defaultScanCategories {
			set[c] = true
		}
	} else {
		for _, r := range raw {
			for _, part := range strings.Split(r, ",") {
				p := strings.ToLower(strings.TrimSpace(part))
				if p == "" {
					continue
				}
				if p == "all" {
					for _, c := range allScanCategories {
						set[c] = true
					}
					continue
				}
				valid := false
				for _, c := range allScanCategories {
					if c == p {
						valid = true
						break
					}
				}
				if !valid {
					return nil, nil, fmt.Sprintf("未知类别: %s（可选 %s 或 all）", p, strings.Join(allScanCategories, "/"))
				}
				set[p] = true
			}
		}
	}
	if len(set) == 0 {
		return nil, nil, "categories 为空——请给出类别（如 temp,log）或 all"
	}
	names := make([]string, 0, len(set))
	for _, c := range allScanCategories {
		if set[c] {
			names = append(names, c)
		}
	}
	return set, names, ""
}

// parseSizeArg —— 尺寸参数：数字（字节）或 10M / 1.5G / 500K 形式。
func parseSizeArg(v any, fallback int64) (int64, error) {
	switch t := v.(type) {
	case nil:
		return fallback, nil
	case float64:
		if t < 0 {
			return 0, fmt.Errorf("尺寸不能为负: %v", t)
		}
		return int64(t), nil
	case string:
		s := strings.TrimSpace(strings.ToUpper(t))
		if s == "" {
			return fallback, nil
		}
		mult := int64(1)
		switch {
		case strings.HasSuffix(s, "KB"), strings.HasSuffix(s, "K"):
			mult = 1 << 10
			s = strings.TrimSuffix(strings.TrimSuffix(s, "B"), "K")
		case strings.HasSuffix(s, "MB"), strings.HasSuffix(s, "M"):
			mult = 1 << 20
			s = strings.TrimSuffix(strings.TrimSuffix(s, "B"), "M")
		case strings.HasSuffix(s, "GB"), strings.HasSuffix(s, "G"):
			mult = 1 << 30
			s = strings.TrimSuffix(strings.TrimSuffix(s, "B"), "G")
		case strings.HasSuffix(s, "TB"), strings.HasSuffix(s, "T"):
			mult = 1 << 40
			s = strings.TrimSuffix(strings.TrimSuffix(s, "B"), "T")
		case strings.HasSuffix(s, "B"):
			s = strings.TrimSuffix(s, "B")
		}
		n, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil {
			return 0, fmt.Errorf("尺寸无法解析: %s", t)
		}
		return int64(n * float64(mult)), nil
	default:
		return 0, fmt.Errorf("尺寸参数类型不支持: %T", v)
	}
}

func parseScanOptions(args map[string]any) (scanOptions, []string, string) {
	set, names, errMsg := expandCategories(fw.StrListArg(args, "categories"))
	if errMsg != "" {
		return scanOptions{}, nil, errMsg
	}
	opt := scanOptions{categories: set, limit: 2000, includeHidden: true}
	if v, ok := args["include_hidden"].(bool); ok {
		opt.includeHidden = v
	}
	if d := fw.NumArg(args, "older_than"); d > 0 {
		opt.olderThan = time.Duration(d * float64(24*time.Hour))
	}
	minSize, err := parseSizeArg(args["min_size"], defaultBigSize)
	if err != nil {
		return scanOptions{}, nil, err.Error()
	}
	opt.minSize = minSize
	if d := fw.NumArg(args, "max_depth"); d > 0 {
		opt.maxDepth = int(d)
	}
	if k := fw.NumArg(args, "limit"); k > 0 {
		opt.limit = int(k)
	}
	return opt, names, ""
}

// summarizeCandidates —— 按类别聚合（类别顺序稳定：类别定义序）。
func summarizeCandidates(cands []candidate, categoryOrder []string) []map[string]any {
	type agg struct {
		count int
		bytes int64
	}
	byCat := map[string]*agg{}
	for _, c := range cands {
		a := byCat[c.Category]
		if a == nil {
			a = &agg{}
			byCat[c.Category] = a
		}
		a.count++
		a.bytes += c.Size
	}
	var out []map[string]any
	for _, name := range categoryOrder {
		if a := byCat[name]; a != nil {
			out = append(out, map[string]any{"name": name, "label": categoryLabel[name], "count": a.count, "bytes": a.bytes})
		}
	}
	return out
}

func candidatesToJSON(cands []candidate, limit int) []map[string]any {
	out := make([]map[string]any, 0, len(cands))
	for i, c := range cands {
		if i >= limit {
			break
		}
		out = append(out, map[string]any{
			"path": c.Path, "rel": c.Rel, "size": c.Size, "isDir": c.IsDir,
			"category": c.Category, "reason": c.Reason,
		})
	}
	return out
}

// toolScan —— 清理候选扫描（只读）。
func toolScan(args map[string]any) fw.ToolResult {
	opt, names, errMsg := parseScanOptions(args)
	if errMsg != "" {
		return fw.ToolErr(errMsg)
	}
	root, errStr := func() (string, string) {
		dirArg := fw.StrArg(args, "dir")
		if dirArg == "" {
			dirArg = fw.AgentDir()
		}
		return resolveRoot(dirArg)
	}()
	if errStr != "" {
		return fw.ToolErr(errStr)
	}
	cands, stats, errs := scanCandidates(root, opt)
	sort.Slice(cands, func(i, j int) bool {
		if cands[i].Size != cands[j].Size {
			return cands[i].Size > cands[j].Size
		}
		return cands[i].Path < cands[j].Path
	})
	topK := 20
	if k := fw.NumArg(args, "top_k"); k > 0 {
		topK = int(k)
	}
	var total int64
	for _, c := range cands {
		total += c.Size
	}
	lines := []string{fmt.Sprintf("清理候选（根 %s，类别 %s）：", root, strings.Join(names, ","))}
	lines = append(lines, fmt.Sprintf("共 %d 项，可回收 %s", len(cands), humanSize(total)))
	for _, row := range summarizeCandidates(cands, names) {
		lines = append(lines, fmt.Sprintf("  %-10s %5d 项  %s", row["name"], row["count"], humanSize(row["bytes"].(int64))))
	}
	n := cands
	if len(n) > topK {
		n = n[:topK]
	}
	if len(n) > 0 {
		lines = append(lines, fmt.Sprintf("明细（前 %d）：", len(n)))
	}
	for i, c := range n {
		lines = append(lines, fmt.Sprintf("%3d. %10s  [%s] %s", i+1, humanSize(c.Size), c.Category, c.Rel))
	}
	lines = append(lines, fmt.Sprintf("（扫描 %d 文件 / %d 目录，%d 个不可读目录已跳过）", stats.Files, stats.Dirs, len(errs)))
	lines = append(lines, "执行清理：disk_clean（先 dry-run 预览）")
	return fw.ToolOk(strings.Join(lines, "\n"), map[string]any{
		"root": root, "categories": names, "count": len(cands), "totalBytes": total,
		"byCategory": summarizeCandidates(cands, names), "candidates": candidatesToJSON(cands, 2000),
		"scanned": stats, "errors": len(errs),
	})
}

// ---------------- 范围护栏 ----------------

// protectedSubtrees —— 这些位置**及其子树**不可清理（系统目录）。
func protectedSubtrees() []string {
	if runtime.GOOS == "windows" {
		var out []string
		for c := 'A'; c <= 'Z'; c++ {
			root := strings.ToLower(string(c) + ":\\")
			for _, sub := range []string{"windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "recovery", "perflogs", "system volume information"} {
				out = append(out, filepath.Join(root, sub))
			}
		}
		return out
	}
	return []string{
		"/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/libexec", "/proc", "/root",
		"/sbin", "/srv", "/sys", "/usr", "/var", "/System", "/Library", "/Applications",
		"/private", "/cores", "/.vol", "/dev",
	}
}

// protectedExact —— 仅**自身**不可清理（卷根、用户主目录、家目录集合）。
func protectedExact() []string {
	var out []string
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		out = append(out, filepath.Clean(home))
	}
	if runtime.GOOS == "windows" {
		for c := 'A'; c <= 'Z'; c++ {
			out = append(out, strings.ToUpper(string(c))+":\\")
		}
		if up := os.Getenv("USERPROFILE"); up != "" {
			out = append(out, filepath.Clean(up))
		}
		out = append(out, "C:\\Users")
		return out
	}
	out = append(out, "/", "/home", "/Users", "/Volumes", "/mnt", "/media")
	return out
}

// samePath —— 平台归一后的路径相等判定（Windows 大小写不敏感）。
func samePath(a, b string) bool {
	p, q := filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		p, q = strings.ToLower(p), strings.ToLower(q)
	}
	return p == q
}

func sameOrUnder(path, prefix string) bool {
	p, q := filepath.Clean(path), filepath.Clean(prefix)
	if runtime.GOOS == "windows" {
		p, q = strings.ToLower(p), strings.ToLower(q)
	}
	return p == q || strings.HasPrefix(p, q+string(os.PathSeparator))
}

// checkScope —— 范围校验：返回空串表示通过，否则为拒绝理由。
func checkScope(path string) string {
	// 卷根（父目录即自身）：任何平台都拒绝（Windows 下 "/" 亦解析为当前盘根）
	if cleaned := filepath.Clean(path); filepath.Dir(cleaned) == cleaned {
		return fmt.Sprintf("拒绝操作 %s：这是受保护位置（卷根）", cleaned)
	}
	for _, p := range protectedExact() {
		if samePath(path, p) {
			return fmt.Sprintf("拒绝操作 %s：这是受保护位置（卷根/用户主目录）", path)
		}
	}
	for _, p := range protectedSubtrees() {
		if sameOrUnder(path, p) {
			return fmt.Sprintf("拒绝操作 %s：位于受保护的系统目录 %s 之下", path, p)
		}
	}
	return ""
}

// ---------------- 执行清理 ----------------

const (
	modeDryRun     = "dry-run"
	modeQuarantine = "quarantine"
	modeDelete     = "delete"
	maxItemsHard   = 5000
)

type cleanOptions struct {
	root            string
	mode            string
	trashRoot       string
	batch           string
	explicitTargets []string
	targets         []candidate
	rejected        []map[string]any
	maxItems        int
}

type cleanEntryResult struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	IsDir  bool   `json:"isDir"`
	Status string `json:"status"` // planned | moved | deleted | skipped | failed
	Note   string `json:"note"`
}

type trashEntry struct {
	Seq      int    `json:"seq"`
	Original string `json:"original"`
	Stored   string `json:"stored"`
	IsDir    bool   `json:"isDir"`
	Size     int64  `json:"size"`
	At       string `json:"at"`
}

// resolveTrashRoot —— 隔离区根：参数优先 → {GEBAI_HOME}/trash/disk → 系统临时目录。
func resolveTrashRoot(arg string) string {
	if strings.TrimSpace(arg) != "" {
		return fw.CtxResolve(strings.TrimSpace(arg))
	}
	if home := fw.CtxEnv("GEBAI_HOME"); home != "" {
		return filepath.Join(home, "trash", "disk")
	}
	return filepath.Join(os.TempDir(), "gebai-trash", "disk")
}

func newBatchName() string {
	return time.Now().Format("20060102-150405")
}

// collectCleanTargets —— targets 与类别扫描合并、去重、范围校验、上限截断。
func collectCleanTargets(opt *cleanOptions, scanOpt scanOptions) error {
	seen := map[string]bool{}
	addCandidate := func(c candidate) {
		if seen[filepath.Clean(c.Path)] {
			return
		}
		seen[filepath.Clean(c.Path)] = true
		opt.targets = append(opt.targets, c)
	}
	reject := func(path, reason string) {
		opt.rejected = append(opt.rejected, map[string]any{"path": path, "reason": reason})
	}
	// 显式目标
	for _, raw := range opt.explicitTargets {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		p := raw
		if !filepath.IsAbs(p) {
			p = filepath.Join(opt.root, p)
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			reject(raw, fmt.Sprintf("路径解析失败: %v", err))
			continue
		}
		abs = filepath.Clean(abs)
		if abs == filepath.Clean(opt.root) {
			reject(abs, "目标是范围根本身——请指定范围根内的具体条目")
			continue
		}
		rel, err := filepath.Rel(opt.root, abs)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			reject(abs, "目标不在 dir 范围内")
			continue
		}
		if opt.trashRoot != "" && sameOrUnder(abs, opt.trashRoot) {
			reject(abs, "目标位于隔离区内——请用 disk_trash 管理（restore/purge）")
			continue
		}
		if reason := checkScope(abs); reason != "" {
			reject(abs, reason)
			continue
		}
		info, err := os.Lstat(abs)
		if err != nil {
			reject(abs, fmt.Sprintf("不可访问: %v", err))
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			reject(abs, "符号链接不删（避免误删链接指向的真实内容）")
			continue
		}
		size := info.Size()
		if info.IsDir() {
			size = dirSize(abs)
		}
		addCandidate(candidate{Path: abs, Rel: rel, Size: size, IsDir: info.IsDir(), Category: "explicit", Reason: "显式指定"})
	}
	// 类别扫描
	if len(scanOpt.categories) > 0 {
		cands, _, _ := scanCandidates(opt.root, scanOpt)
		for _, c := range cands {
			if reason := checkScope(c.Path); reason != "" {
				reject(c.Path, reason)
				continue
			}
			if opt.trashRoot != "" && sameOrUnder(c.Path, opt.trashRoot) {
				continue
			}
			addCandidate(c)
		}
	}
	if len(opt.targets) == 0 && len(opt.rejected) == 0 {
		return fmt.Errorf("无清理目标：请给出 targets（显式路径）或 categories（类别扫描）")
	}
	// 目标互含时只保留父级（短路径先入列，其下子项随父级一并处理）
	sort.Slice(opt.targets, func(i, j int) bool { return len(opt.targets[i].Path) < len(opt.targets[j].Path) })
	var kept []candidate
	for _, c := range opt.targets {
		covered := false
		for _, k := range kept {
			if k.IsDir && sameOrUnder(c.Path, k.Path) {
				covered = true
				break
			}
		}
		if !covered {
			kept = append(kept, c)
		}
	}
	opt.targets = kept
	if len(opt.targets) > opt.maxItems {
		for _, c := range opt.targets[opt.maxItems:] {
			reject(c.Path, fmt.Sprintf("超出本次条目上限 %d（本次不处理）", opt.maxItems))
		}
		opt.targets = opt.targets[:opt.maxItems]
	}
	return nil
}

// dirSize —— 目录子树文件总大小（du 语义，跳过符号链接目录）。
func dirSize(dir string) int64 {
	entries, _ := walkConcurrent(dir)
	var total int64
	for _, e := range entries {
		if !e.isDir {
			total += e.size
		}
	}
	return total
}

func appendAudit(trashRoot string, rec map[string]any) error {
	if err := os.MkdirAll(trashRoot, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(trashRoot, "clean-log.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		return err
	}
	return nil
}

// runClean —— 执行清理（dry-run 只报告）。
func runClean(opt cleanOptions) ([]cleanEntryResult, map[string]any, error) {
	results := make([]cleanEntryResult, 0, len(opt.targets))
	summary := map[string]any{
		"root": opt.root, "mode": opt.mode, "batch": opt.batch, "trashDir": opt.trashRoot,
	}
	var items, moved, deleted, failed int
	var bytes int64
	var batchDir, manifestPath string
	var manifestFile *os.File
	if opt.mode == modeQuarantine {
		batchDir = filepath.Join(opt.trashRoot, opt.batch)
		entriesDir := filepath.Join(batchDir, "entries")
		if err := os.MkdirAll(entriesDir, 0o755); err != nil {
			return nil, nil, fmt.Errorf("隔离区创建失败: %v", err)
		}
		manifestPath = filepath.Join(batchDir, "manifest.jsonl")
		f, err := os.OpenFile(manifestPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return nil, nil, fmt.Errorf("隔离区清单创建失败: %v", err)
		}
		manifestFile = f
		defer manifestFile.Close()
		meta, _ := json.Marshal(map[string]any{
			"batch": opt.batch, "createdAt": time.Now().Format(time.RFC3339),
			"root": opt.root, "mode": opt.mode,
		})
		if err := os.WriteFile(filepath.Join(batchDir, "meta.json"), meta, 0o644); err != nil {
			return nil, nil, fmt.Errorf("隔离区元数据写入失败: %v", err)
		}
	}
	for i, t := range opt.targets {
		items++
		bytes += t.Size
		status, note := "planned", ""
		switch opt.mode {
		case modeDryRun:
		case modeQuarantine:
			stored := filepath.Join(batchDir, "entries", strconv.Itoa(i+1))
			if err := os.Rename(t.Path, stored); err != nil {
				status, note = "failed", fmt.Sprintf("移动到隔离区失败: %v", err)
				failed++
				break
			}
			rec, _ := json.Marshal(trashEntry{
				Seq: i + 1, Original: t.Path, Stored: stored, IsDir: t.IsDir,
				Size: t.Size, At: time.Now().Format(time.RFC3339),
			})
			if _, err := manifestFile.Write(append(rec, '\n')); err != nil {
				status, note = "failed", fmt.Sprintf("隔离区清单写入失败: %v", err)
				failed++
				break
			}
			status, note, moved = "moved", "已移入隔离区", moved+1
		case modeDelete:
			var err error
			if t.IsDir {
				err = os.RemoveAll(t.Path)
			} else {
				err = os.Remove(t.Path)
			}
			if err != nil {
				status, note = "failed", fmt.Sprintf("删除失败: %v", err)
				failed++
				break
			}
			status, note, deleted = "deleted", "已删除", deleted+1
		}
		results = append(results, cleanEntryResult{Path: t.Path, Size: t.Size, IsDir: t.IsDir, Status: status, Note: note})
	}
	summary["items"] = items
	summary["bytes"] = bytes
	summary["moved"] = moved
	summary["deleted"] = deleted
	summary["failed"] = failed
	summary["rejected"] = len(opt.rejected)
	audit := map[string]any{
		"time": time.Now().Format(time.RFC3339), "mode": opt.mode, "root": opt.root,
		"batch": opt.batch, "items": items, "bytes": bytes,
		"moved": moved, "deleted": deleted, "failed": failed,
		"sessionId": fw.Ctx().SessionID, "user": fw.Ctx().User,
	}
	if err := appendAudit(opt.trashRoot, audit); err != nil {
		summary["auditError"] = err.Error()
	}
	return results, summary, nil
}

// ---------------- 工具入口：clean ----------------

func toolClean(args map[string]any) fw.ToolResult {
	dirArg := strings.TrimSpace(fw.StrArg(args, "dir"))
	if dirArg == "" {
		return fw.ToolErr("clean 需要 dir 参数（清理范围根）——为避免误删不设缺省目录")
	}
	root, errStr := resolveRoot(dirArg)
	if errStr != "" {
		return fw.ToolErr(errStr)
	}
	if reason := checkScope(root); reason != "" {
		return fw.ToolErr(reason + "——请改用更具体的范围根（如该位置下的子目录）")
	}
	mode := strings.ToLower(strings.TrimSpace(fw.StrArg(args, "mode")))
	if mode == "" {
		mode = modeDryRun
	}
	if mode != modeDryRun && mode != modeQuarantine && mode != modeDelete {
		return fw.ToolErr("mode 只能是 dry-run / quarantine / delete")
	}
	scanOpt, _, errMsg := parseScanOptions(args)
	if errMsg != "" {
		return fw.ToolErr(errMsg)
	}
	explicit := fw.StrListArg(args, "targets")
	rawCats := fw.StrListArg(args, "categories")
	if len(explicit) == 0 && len(rawCats) == 0 {
		return fw.ToolErr("clean 需要 targets（显式路径）或 categories（类别，如 temp,log）之一——不做无目标的「顺手全清」")
	}
	if len(rawCats) == 0 {
		scanOpt.categories = map[string]bool{} // clean 不套用 scan 的缺省类别：必须显式点名
	}
	maxItems := 500
	if k := fw.NumArg(args, "max_items"); k > 0 {
		maxItems = int(k)
	}
	if maxItems > maxItemsHard {
		maxItems = maxItemsHard
	}
	batch := strings.TrimSpace(fw.StrArg(args, "batch"))
	if batch == "" {
		batch = newBatchName()
	}
	opt := cleanOptions{
		root: root, mode: mode, trashRoot: resolveTrashRoot(fw.StrArg(args, "trash_dir")),
		batch: batch, explicitTargets: explicit, maxItems: maxItems,
	}
	if err := collectCleanTargets(&opt, scanOpt); err != nil {
		return fw.ToolErr(err.Error())
	}
	results, summary, err := runClean(opt)
	if err != nil {
		return fw.ToolErr(err.Error())
	}
	var total int64
	for _, c := range opt.targets {
		total += c.Size
	}
	modeLabel := map[string]string{modeDryRun: "预览（未改动）", modeQuarantine: "移入隔离区", modeDelete: "直接删除"}[mode]
	lines := []string{fmt.Sprintf("清理%s：根 %s，%d 项 / %s", modeLabel, root, len(opt.targets), humanSize(total))}
	if mode == modeQuarantine {
		lines = append(lines, fmt.Sprintf("隔离批次 %s（%v）", batch, summary["trashDir"]))
	}
	shown := results
	if len(shown) > 30 {
		shown = shown[:30]
	}
	for i, r := range shown {
		note := ""
		if r.Note != "" {
			note = "  " + r.Note
		}
		lines = append(lines, fmt.Sprintf("%3d. %-8s %10s  %s%s", i+1, r.Status, humanSize(r.Size), r.Path, note))
	}
	if len(results) > len(shown) {
		lines = append(lines, fmt.Sprintf("（共 %d 项，显示前 %d）", len(results), len(shown)))
	}
	if len(opt.rejected) > 0 {
		lines = append(lines, fmt.Sprintf("未处理 %d 项：", len(opt.rejected)))
		for i, r := range opt.rejected {
			if i >= 10 {
				lines = append(lines, "  …")
				break
			}
			lines = append(lines, fmt.Sprintf("  - %v：%v", r["path"], r["reason"]))
		}
	}
	switch mode {
	case modeDryRun:
		lines = append(lines, "预览未改动任何文件；确认后 mode=quarantine（可还原）或 mode=delete 执行")
	case modeQuarantine:
		lines = append(lines, "还原：disk_trash action=restore；彻底清除：disk_trash action=purge")
	case modeDelete:
		lines = append(lines, "已直接删除（不可恢复）")
	}
	if aerr, ok := summary["auditError"].(string); ok && aerr != "" {
		lines = append(lines, "审计日志写入失败："+aerr)
	}
	summary["rejected"] = opt.rejected
	summary["results"] = results
	summary["totalBytes"] = total
	return fw.ToolOk(strings.Join(lines, "\n"), summary)
}

// ---------------- 隔离区（trash） ----------------

type trashBatch struct {
	Batch   string `json:"batch"`
	Dir     string `json:"dir"`
	Created string `json:"createdAt"`
	Root    string `json:"root"`
	Entries int    `json:"entries"`
	Bytes   int64  `json:"bytes"`
}

func readManifest(path string) ([]trashEntry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []trashEntry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var e trashEntry
		if err := json.Unmarshal([]byte(line), &e); err == nil {
			out = append(out, e)
		}
	}
	return out, sc.Err()
}

func listBatches(trashRoot string) ([]trashBatch, error) {
	dirents, err := os.ReadDir(trashRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []trashBatch
	for _, de := range dirents {
		if !de.IsDir() {
			continue
		}
		dir := filepath.Join(trashRoot, de.Name())
		b := trashBatch{Batch: de.Name(), Dir: dir}
		if raw, err := os.ReadFile(filepath.Join(dir, "meta.json")); err == nil {
			var meta map[string]any
			if json.Unmarshal(raw, &meta) == nil {
				b.Created, _ = meta["createdAt"].(string)
				b.Root, _ = meta["root"].(string)
			}
		}
		entries, _ := readManifest(filepath.Join(dir, "manifest.jsonl"))
		b.Entries = len(entries)
		for _, e := range entries {
			b.Bytes += e.Size
		}
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Batch > out[j].Batch }) // 新批次在前
	return out, nil
}

func toolTrash(args map[string]any) fw.ToolResult {
	action := strings.ToLower(strings.TrimSpace(fw.StrArg(args, "action")))
	if action == "" {
		action = "list"
	}
	trashRoot := resolveTrashRoot(fw.StrArg(args, "trash_dir"))
	batch := strings.TrimSpace(fw.StrArg(args, "batch"))
	switch action {
	case "list":
		return trashList(trashRoot)
	case "restore":
		return trashRestore(trashRoot, batch)
	case "purge":
		all, _ := args["all"].(bool)
		return trashPurge(trashRoot, batch, all)
	default:
		return fw.ToolErr("action 只能是 list / restore / purge")
	}
}

func trashList(trashRoot string) fw.ToolResult {
	batches, err := listBatches(trashRoot)
	if err != nil {
		return fw.ToolErr("隔离区读取失败: " + err.Error())
	}
	if len(batches) == 0 {
		return fw.ToolOk(fmt.Sprintf("隔离区为空（%s）——disk_clean mode=quarantine 的条目会落在这里", trashRoot),
			map[string]any{"trashDir": trashRoot, "batches": []any{}})
	}
	var total int64
	lines := []string{fmt.Sprintf("隔离区 %s：", trashRoot)}
	for _, b := range batches {
		total += b.Bytes
		lines = append(lines, fmt.Sprintf("  %s  %s  %d 项 / %s  源 %s", b.Batch, b.Created, b.Entries, humanSize(b.Bytes), b.Root))
	}
	lines = append(lines, fmt.Sprintf("合计 %d 批次 / %s", len(batches), humanSize(total)))
	lines = append(lines, "还原：disk_trash action=restore [batch]；彻底清除：disk_trash action=purge [batch|all=true]")
	return fw.ToolOk(strings.Join(lines, "\n"), map[string]any{"trashDir": trashRoot, "batches": batches, "totalBytes": total})
}

func trashRestore(trashRoot, batch string) fw.ToolResult {
	batches, err := listBatches(trashRoot)
	if err != nil {
		return fw.ToolErr("隔离区读取失败: " + err.Error())
	}
	if len(batches) == 0 {
		return fw.ToolErr(fmt.Sprintf("隔离区为空（%s）：无批次可还原", trashRoot))
	}
	b := batches[0] // 缺省 = 最新批次
	if batch != "" {
		found := false
		for _, x := range batches {
			if x.Batch == batch {
				b, found = x, true
				break
			}
		}
		if !found {
			return fw.ToolErr("未找到批次: " + batch + "（disk_trash action=list 查看可用批次）")
		}
	}
	entries, err := readManifest(filepath.Join(b.Dir, "manifest.jsonl"))
	if err != nil {
		return fw.ToolErr("隔离区清单读取失败: " + err.Error())
	}
	var restored, skipped, failed int
	var remaining []trashEntry
	lines := []string{fmt.Sprintf("还原批次 %s（%s）：", b.Batch, b.Created)}
	for _, e := range entries {
		if _, err := os.Lstat(e.Original); err == nil {
			skipped++
			remaining = append(remaining, e)
			lines = append(lines, "  跳过（原位置已存在）: "+e.Original)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(e.Original), 0o755); err != nil {
			failed++
			remaining = append(remaining, e)
			lines = append(lines, fmt.Sprintf("  失败: %s（%v）", e.Original, err))
			continue
		}
		if err := os.Rename(e.Stored, e.Original); err != nil {
			failed++
			remaining = append(remaining, e)
			lines = append(lines, fmt.Sprintf("  失败: %s（%v）", e.Original, err))
			continue
		}
		restored++
	}
	if len(remaining) == 0 {
		if err := os.RemoveAll(b.Dir); err != nil {
			lines = append(lines, "批次目录清理失败: "+err.Error())
		}
	} else {
		f, err := os.Create(filepath.Join(b.Dir, "manifest.jsonl"))
		if err != nil {
			lines = append(lines, "清单重写失败: "+err.Error())
		} else {
			for _, e := range remaining {
				raw, _ := json.Marshal(e)
				f.Write(append(raw, '\n'))
			}
			f.Close()
		}
	}
	lines = append(lines, fmt.Sprintf("已还原 %d 项，跳过 %d 项，失败 %d 项", restored, skipped, failed))
	if skipped > 0 {
		lines = append(lines, "跳过项仍留在隔离区，可先处理原位置再重复还原或用 purge 清除")
	}
	return fw.ToolOk(strings.Join(lines, "\n"), map[string]any{
		"trashDir": trashRoot, "batch": b.Batch,
		"restored": restored, "skipped": skipped, "failed": failed,
	})
}

func trashPurge(trashRoot, batch string, all bool) fw.ToolResult {
	batches, err := listBatches(trashRoot)
	if err != nil {
		return fw.ToolErr("隔离区读取失败: " + err.Error())
	}
	if len(batches) == 0 {
		return fw.ToolErr(fmt.Sprintf("隔离区为空（%s）：无可清除批次", trashRoot))
	}
	var target []trashBatch
	switch {
	case all:
		target = batches
	case batch != "":
		for _, x := range batches {
			if x.Batch == batch {
				target = append(target, x)
			}
		}
		if len(target) == 0 {
			return fw.ToolErr("未找到批次: " + batch + "（disk_trash action=list 查看可用批次）")
		}
	default:
		target = batches[:1] // 缺省 = 最新批次
	}
	var freed int64
	var purged int
	lines := []string{"彻底清除（不可恢复）："}
	for _, b := range target {
		if !sameOrUnder(b.Dir, trashRoot) {
			return fw.ToolErr("批次路径越界，拒绝清除: " + b.Dir)
		}
		size := dirSize(b.Dir)
		if err := os.RemoveAll(b.Dir); err != nil {
			lines = append(lines, fmt.Sprintf("  失败 %s（%v）", b.Batch, err))
			continue
		}
		freed += size
		purged++
		lines = append(lines, fmt.Sprintf("  已清除 %s（%d 项 / %s）", b.Batch, b.Entries, humanSize(size)))
	}
	lines = append(lines, fmt.Sprintf("合计清除 %d 批次，释放 %s", purged, humanSize(freed)))
	return fw.ToolOk(strings.Join(lines, "\n"), map[string]any{
		"trashDir": trashRoot, "purged": purged, "freedBytes": freed,
	})
}
