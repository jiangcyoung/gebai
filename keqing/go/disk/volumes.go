// disk 子代理项目：磁盘容量总览（各挂载点/盘的总量、已用、可用、使用率）——「盘还剩多少」。
// 平台探测实现见 volumes_{linux,darwin,windows,other}.go（构建标签），本文件只做结果整形与工具入口。
package main

import (
	"fmt"
	"sort"
	"strings"

	fw "gebai/keqing-framework/framework"
)

// volumeInfo —— 单个挂载点/卷的容量信息（字节）。
type volumeInfo struct {
	Mount   string  `json:"mount"`
	Device  string  `json:"device"`
	FSType  string  `json:"fsType"`
	Total   int64   `json:"totalBytes"`
	Used    int64   `json:"usedBytes"`
	Free    int64   `json:"freeBytes"`
	Avail   int64   `json:"availBytes"`
	Percent float64 `json:"usedPercent"`
}

// makeVolume —— 统一口径：已用 = 总量 - 剩余量；可用量单列（普通用户可写空间，可能小于剩余量）。
func makeVolume(mount, device, fsType string, total, free, avail int64) volumeInfo {
	used := total - free
	if used < 0 {
		used = 0
	}
	pct := 0.0
	if total > 0 {
		pct = float64(used) / float64(total) * 100
	}
	return volumeInfo{
		Mount: mount, Device: device, FSType: fsType,
		Total: total, Used: used, Free: free, Avail: avail, Percent: pct,
	}
}

// toolVolumes —— 磁盘容量总览（只读）。
func toolVolumes(args map[string]any) fw.ToolResult {
	vols, errs := platformVolumes()
	if len(vols) == 0 {
		msg := "磁盘容量信息不可用"
		if len(errs) > 0 {
			msg += "：" + strings.Join(errs, "; ")
		}
		return fw.ToolErr(msg)
	}
	sort.Slice(vols, func(i, j int) bool { return vols[i].Mount < vols[j].Mount })
	lines := []string{"磁盘容量（总量 / 已用 / 可用 / 使用率）："}
	for _, v := range vols {
		label := v.Mount
		detail := []string{}
		if v.Device != "" && v.Device != v.Mount {
			detail = append(detail, v.Device)
		}
		if v.FSType != "" {
			detail = append(detail, v.FSType)
		}
		if len(detail) > 0 {
			label = fmt.Sprintf("%s [%s]", v.Mount, strings.Join(detail, " "))
		}
		lines = append(lines, fmt.Sprintf("  %-34s %10s 总  %10s 已用  %10s 可用  %5.1f%%",
			label, humanSize(v.Total), humanSize(v.Used), humanSize(v.Avail), v.Percent))
	}
	if len(errs) > 0 {
		lines = append(lines, fmt.Sprintf("（%d 个卷不可读或未就绪，已跳过）", len(errs)))
	}
	// 关注阈值（如 10G）：可用量偏低的卷单独列出，便于优先处理
	if raw, ok := args["min_free"]; ok && raw != nil {
		if limit, err := parseSizeArg(raw, 0); err == nil && limit > 0 {
			var low []string
			for _, v := range vols {
				if v.Avail < limit {
					low = append(low, fmt.Sprintf("%s（可用 %s）", v.Mount, humanSize(v.Avail)))
				}
			}
			if len(low) > 0 {
				lines = append(lines, fmt.Sprintf("可用量低于 %s：%s", humanSize(limit), strings.Join(low, "、")))
			} else {
				lines = append(lines, "全部卷可用量均不低于 "+humanSize(limit))
			}
		}
	}
	return fw.ToolOk(strings.Join(lines, "\n"), map[string]any{
		"volumes": vols, "errors": len(errs), "errorSample": firstN(errs, 5),
	})
}

func firstN(items []string, n int) []string {
	if len(items) <= n {
		return items
	}
	return items[:n]
}
