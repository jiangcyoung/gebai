// disk 子代理单元测试：候选分类/参数解析、范围护栏、扫描聚合、隔离区往返、删除与预览语义。
// 运行：go test ./disk（需 go >= 1.23，见 go.mod）。
package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func writeFixtureFile(t *testing.T, path string, size int, mod time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
	if !mod.IsZero() {
		if err := os.Chtimes(path, mod, mod); err != nil {
			t.Fatal(err)
		}
	}
}

// fixtureDir —— 各类别夹具：日志/临时/备份/转储/大文件/缓存目录/空目录/普通文件。
func fixtureDir(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFixtureFile(t, filepath.Join(root, "app.log"), 2048, time.Time{})
	writeFixtureFile(t, filepath.Join(root, "cache.tmp"), 512, time.Time{})
	writeFixtureFile(t, filepath.Join(root, "old.bak"), 256, time.Now().Add(-60*24*time.Hour))
	writeFixtureFile(t, filepath.Join(root, "core.1234"), 128, time.Time{})
	writeFixtureFile(t, filepath.Join(root, "keep.txt"), 64, time.Time{})
	writeFixtureFile(t, filepath.Join(root, "big.bin"), 4096, time.Time{})
	writeFixtureFile(t, filepath.Join(root, "node_modules", ".cache", "x.json"), 128, time.Time{})
	if err := os.MkdirAll(filepath.Join(root, "empty_dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

func scanWith(t *testing.T, root string, args map[string]any) ([]candidate, walkStats) {
	t.Helper()
	opt, _, errMsg := parseScanOptions(args)
	if errMsg != "" {
		t.Fatalf("参数解析失败: %s", errMsg)
	}
	cands, stats, _ := scanCandidates(root, opt)
	return cands, stats
}

func countByCategory(cands []candidate) map[string]int {
	out := map[string]int{}
	for _, c := range cands {
		out[c.Category]++
	}
	return out
}

func TestClassifyName(t *testing.T) {
	cases := []struct {
		name     string
		isDir    bool
		parent   string
		expected string
	}{
		{"x.tmp", false, "", catTemp},
		{"x.log", false, "", catLog},
		{"x.log.1", false, "", catLog},
		{"x.bak", false, "", catBackup},
		{"core.1234", false, "", catDump},
		{"x.dmp", false, "", catDump},
		{"~$doc.docx", false, "", catTemp},
		{".DS_Store", false, "", catTemp},
		{"keep.txt", false, "", ""},
		{"__pycache__", true, "src", catCache},
		{"cache", true, "node_modules", catCache},
		{"cache", true, "somewhere", ""},
		{"src", true, "app", ""},
	}
	for _, c := range cases {
		if got := classifyName(c.name, c.isDir, c.parent); got != c.expected {
			t.Errorf("classifyName(%q, dir=%v, parent=%q) = %q，期望 %q", c.name, c.isDir, c.parent, got, c.expected)
		}
	}
}

func TestParseSizeArgAndCategories(t *testing.T) {
	cases := []struct {
		in       any
		expected int64
	}{
		{float64(1024), 1024},
		{"10M", 10 << 20},
		{"1.5G", int64(1.5 * float64(int64(1)<<30))},
		{"512K", 512 << 10},
		{"2048", 2048},
	}
	for _, c := range cases {
		got, err := parseSizeArg(c.in, 0)
		if err != nil || got != c.expected {
			t.Errorf("parseSizeArg(%v) = %d, %v；期望 %d", c.in, got, err, c.expected)
		}
	}
	if _, err := parseSizeArg("abc", 0); err == nil {
		t.Error("非法尺寸应报错")
	}
	set, names, errMsg := expandCategories(nil)
	if errMsg != "" || !set[catTemp] || set[catCache] {
		t.Errorf("缺省类别应含 temp 不含 cache：%v %s", names, errMsg)
	}
	if _, _, errMsg := expandCategories([]string{"all"}); errMsg != "" {
		t.Errorf("all 应可展开: %s", errMsg)
	}
	if _, _, errMsg := expandCategories([]string{"nope"}); errMsg == "" {
		t.Error("未知类别应报错")
	}
}

func TestScanCandidates(t *testing.T) {
	root := fixtureDir(t)
	cands, stats := scanWith(t, root, map[string]any{"categories": []any{"temp", "log", "backup", "dump", "empty_dir"}})
	byCat := countByCategory(cands)
	if byCat[catTemp] != 1 || byCat[catLog] != 1 || byCat[catBackup] != 1 || byCat[catDump] != 1 || byCat[catEmpty] != 1 {
		t.Fatalf("类别统计不符: %v（候选 %v）", byCat, cands)
	}
	if stats.Files == 0 || stats.Dirs == 0 {
		t.Fatalf("遍历统计异常: %+v", stats)
	}
	// big_file 阈值
	bigs, _ := scanWith(t, root, map[string]any{"categories": []any{"big_file"}, "min_size": "4K"})
	if len(bigs) != 1 || !strings.HasSuffix(bigs[0].Path, "big.bin") {
		t.Fatalf("big_file 命中不符: %v", bigs)
	}
	// old_file（夹具中 old.bak 为 60 天前；缺省阈值 30 天）
	olds, _ := scanWith(t, root, map[string]any{"categories": []any{"old_file"}})
	if len(olds) != 1 || !strings.HasSuffix(olds[0].Path, "old.bak") {
		t.Fatalf("old_file 命中不符: %v", olds)
	}
	// cache 类别须显式点名
	caches, _ := scanWith(t, root, map[string]any{"categories": []any{"cache"}})
	if len(caches) != 1 || !strings.HasSuffix(caches[0].Path, filepath.Join("node_modules", ".cache")) {
		t.Fatalf("cache 命中不符: %v", caches)
	}
	// 深度限制
	deep, _ := scanWith(t, root, map[string]any{"categories": []any{"temp", "log"}, "max_depth": 0})
	if len(deep) != 2 {
		t.Fatalf("max_depth 缺省应不限深度: %v", deep)
	}
	shallow, _ := scanWith(t, root, map[string]any{"categories": []any{"log"}, "max_depth": 1})
	if len(shallow) != 1 {
		t.Fatalf("max_depth=1 应命中根级日志: %v", shallow)
	}
}

func TestCheckScopeGuards(t *testing.T) {
	if reason := checkScope("/"); reason == "" {
		t.Error("卷根应被拒绝")
	}
	if runtime.GOOS != "windows" {
		if reason := checkScope("/etc"); reason == "" {
			t.Error("/etc 应被拒绝")
		}
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			if reason := checkScope(home); reason == "" {
				t.Errorf("用户主目录应被拒绝: %s", home)
			}
		}
	}
	allowed := t.TempDir() // 系统临时目录下的常规路径可清理
	if reason := checkScope(allowed); reason != "" {
		t.Errorf("%s 应被允许: %s", allowed, reason)
	}
}

func TestCleanRejects(t *testing.T) {
	root := fixtureDir(t)
	trash := filepath.Join(t.TempDir(), "trash")
	// 1) 目标越界
	outside := filepath.Join(filepath.Dir(root), "outside.txt")
	writeFixtureFile(t, outside, 10, time.Time{})
	res := toolClean(map[string]any{"dir": root, "mode": "quarantine", "targets": []any{outside}, "trash_dir": trash})
	d, _ := res.Data.(map[string]any)
	if d == nil || d["items"].(int) != 0 {
		t.Fatalf("越界目标应被拒绝: %s", res.Output)
	}
	// 2) 范围根为受保护位置
	res = toolClean(map[string]any{"dir": "/", "categories": []any{"temp"}, "trash_dir": trash})
	if !strings.Contains(res.Output, "受保护") {
		t.Fatalf("卷根应被拒绝: %s", res.Output)
	}
	// 3) 缺 dir
	res = toolClean(map[string]any{"categories": []any{"temp"}, "trash_dir": trash})
	if !strings.Contains(res.Output, "需要 dir") {
		t.Fatalf("缺 dir 应报错: %s", res.Output)
	}
	// 4) 无目标
	res = toolClean(map[string]any{"dir": root, "trash_dir": trash})
	if !strings.Contains(res.Output, "targets") {
		t.Fatalf("无目标应报错: %s", res.Output)
	}
	// 5) 非法 mode
	res = toolClean(map[string]any{"dir": root, "mode": "wipe", "targets": []any{filepath.Join(root, "app.log")}, "trash_dir": trash})
	if !strings.Contains(res.Output, "mode") {
		t.Fatalf("非法 mode 应报错: %s", res.Output)
	}
	// 6) 符号链接跳过（Windows 创建链接需权限，跳过该用例）
	if runtime.GOOS != "windows" {
		link := filepath.Join(root, "link.log")
		if err := os.Symlink(filepath.Join(root, "app.log"), link); err != nil {
			t.Fatal(err)
		}
		res = toolClean(map[string]any{"dir": root, "targets": []any{link}, "trash_dir": trash})
		d, _ = res.Data.(map[string]any)
		if d == nil || d["items"].(int) != 0 {
			t.Fatalf("符号链接应被跳过: %s", res.Output)
		}
	}
}

func TestCleanDryRunDoesNotTouch(t *testing.T) {
	root := fixtureDir(t)
	trash := filepath.Join(t.TempDir(), "trash")
	target := filepath.Join(root, "cache.tmp")
	res := toolClean(map[string]any{"dir": root, "targets": []any{target}, "trash_dir": trash})
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("dry-run 不应改动文件: %v（%s）", err, res.Output)
	}
	if !strings.Contains(res.Output, "预览") {
		t.Fatalf("dry-run 输出应标明预览: %s", res.Output)
	}
}

func TestCleanQuarantineAndRestore(t *testing.T) {
	root := fixtureDir(t)
	trash := filepath.Join(t.TempDir(), "trash")
	target := filepath.Join(root, "app.log")
	res := toolClean(map[string]any{
		"dir": root, "mode": "quarantine", "targets": []any{target},
		"trash_dir": trash, "batch": "b1",
	})
	d, _ := res.Data.(map[string]any)
	if d == nil || d["failed"].(int) != 0 || d["moved"].(int) != 1 {
		t.Fatalf("隔离失败: %s", res.Output)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("原文件应已移走: %v", err)
	}
	manifest := filepath.Join(trash, "b1", "manifest.jsonl")
	if _, err := os.Stat(manifest); err != nil {
		t.Fatalf("隔离清单缺失: %v", err)
	}
	// 还原
	rr := toolTrash(map[string]any{"action": "restore", "batch": "b1", "trash_dir": trash})
	rd, _ := rr.Data.(map[string]any)
	if rd == nil || rd["restored"].(int) != 1 {
		t.Fatalf("还原失败: %s", rr.Output)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("文件未还原: %v", err)
	}
	// 全量还原后批次目录应被回收
	if _, err := os.Stat(filepath.Join(trash, "b1")); !os.IsNotExist(err) {
		t.Fatalf("空批次目录应被回收: %v", err)
	}
}

func TestTrashPurgeAndList(t *testing.T) {
	root := fixtureDir(t)
	trash := filepath.Join(t.TempDir(), "trash")
	res := toolClean(map[string]any{
		"dir": root, "mode": "quarantine", "categories": []any{"temp", "backup"},
		"trash_dir": trash,
	})
	d, _ := res.Data.(map[string]any)
	if d == nil || d["moved"].(int) != 2 {
		t.Fatalf("隔离失败: %s", res.Output)
	}
	lst := toolTrash(map[string]any{"action": "list", "trash_dir": trash})
	if !strings.Contains(lst.Output, "隔离区") || !strings.Contains(lst.Output, "2 项") {
		t.Fatalf("批次列表不符: %s", lst.Output)
	}
	pg := toolTrash(map[string]any{"action": "purge", "all": true, "trash_dir": trash})
	pd, _ := pg.Data.(map[string]any)
	if pd == nil || pd["purged"].(int) != 1 || pd["freedBytes"].(int64) <= 0 {
		t.Fatalf("彻底清除失败: %s", pg.Output)
	}
	lst = toolTrash(map[string]any{"action": "list", "trash_dir": trash})
	if !strings.Contains(lst.Output, "隔离区为空") {
		t.Fatalf("清除后隔离区应为空: %s", lst.Output)
	}
}

func TestCleanDeleteModes(t *testing.T) {
	root := fixtureDir(t)
	trash := filepath.Join(t.TempDir(), "trash")
	file := filepath.Join(root, "cache.tmp")
	dir := filepath.Join(root, "empty_dir")
	res := toolClean(map[string]any{"dir": root, "mode": "delete", "targets": []any{file, dir}, "trash_dir": trash})
	d, _ := res.Data.(map[string]any)
	if d == nil || d["deleted"].(int) != 2 {
		t.Fatalf("删除失败: %s", res.Output)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("文件应已删除: %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("目录应已删除: %v", err)
	}
	// 审计留痕
	if _, err := os.Stat(filepath.Join(trash, "clean-log.jsonl")); err != nil {
		t.Fatalf("审计日志缺失: %v", err)
	}
}

func TestScanToolOutputAndVolumes(t *testing.T) {
	root := fixtureDir(t)
	res := toolScan(map[string]any{"dir": root, "categories": []any{"temp", "log"}})
	if !strings.Contains(res.Output, "清理候选") {
		t.Fatalf("scan 输出不符: %s", res.Output)
	}
	d, _ := res.Data.(map[string]any)
	if d == nil || d["count"].(int) != 2 {
		t.Fatalf("scan 候选数不符: %s", res.Output)
	}
	vols, _ := platformVolumes()
	if len(vols) == 0 {
		t.Skip("当前环境无可用挂载点信息")
	}
	for _, v := range vols {
		if v.Total < 0 || v.Used < 0 || v.Percent < 0 {
			t.Fatalf("容量字段异常: %+v", v)
		}
	}
	if res := toolVolumes(map[string]any{}); !strings.Contains(res.Output, "磁盘容量") && !strings.Contains(res.Output, "不可用") {
		t.Fatalf("volumes 输出不符: %s", res.Output)
	}
}
