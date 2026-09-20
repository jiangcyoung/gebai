//go:build linux

// 平台容量探测（Linux）：解析 /proc/mounts 得到挂载点，逐个 statfs 取容量。
package main

import (
	"os"
	"strings"
	"syscall"
)

// pseudoFS —— 内核伪文件系统：无容量语义，跳过。
var pseudoFS = map[string]bool{
	"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true, "cgroup": true, "cgroup2": true,
	"pstore": true, "securityfs": true, "debugfs": true, "tracefs": true, "bpf": true, "fusectl": true,
	"configfs": true, "mqueue": true, "hugetlbfs": true, "rpc_pipefs": true, "autofs": true,
	"binfmt_misc": true, "nsfs": true, "efivarfs": true, "ramfs": true, "selinuxfs": true,
}

func platformVolumes() ([]volumeInfo, []string) {
	raw, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return nil, []string{"/proc/mounts 读取失败: " + err.Error()}
	}
	var out []volumeInfo
	var errs []string
	seen := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		device, mount, fsType := fields[0], fields[1], fields[2]
		mount = strings.ReplaceAll(mount, `\040`, " ") // 挂载点中的空格转义
		if pseudoFS[fsType] || seen[mount] {
			continue
		}
		seen[mount] = true
		var st syscall.Statfs_t
		if err := syscall.Statfs(mount, &st); err != nil {
			errs = append(errs, mount+": "+err.Error())
			continue
		}
		bsize := uint64(st.Bsize)
		out = append(out, makeVolume(mount, device, fsType,
			int64(st.Blocks*bsize), int64(st.Bfree*bsize), int64(st.Bavail*bsize)))
	}
	return out, errs
}
