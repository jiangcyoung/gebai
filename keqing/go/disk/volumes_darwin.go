//go:build darwin

// 平台容量探测（macOS）：Getfsstat 枚举已挂载文件系统，逐个取容量。
package main

import "syscall"

const mntNowait = 2 // syscall.MNT_NOWAIT

func cstrToStr(b []int8) string {
	buf := make([]byte, 0, len(b))
	for _, c := range b {
		if c == 0 {
			break
		}
		buf = append(buf, byte(c))
	}
	return string(buf)
}

func platformVolumes() ([]volumeInfo, []string) {
	n, err := syscall.Getfsstat(nil, mntNowait)
	if err != nil || n <= 0 {
		return nil, []string{"Getfsstat 枚举失败"}
	}
	buf := make([]syscall.Statfs_t, n)
	n, err = syscall.Getfsstat(buf, mntNowait)
	if err != nil {
		return nil, []string{"Getfsstat 读取失败: " + err.Error()}
	}
	if n > len(buf) {
		n = len(buf)
	}
	var out []volumeInfo
	var errs []string
	for i := 0; i < n; i++ {
		st := buf[i]
		mount := cstrToStr(st.Mntonname[:])
		if mount == "" {
			continue
		}
		bsize := uint64(st.Bsize)
		out = append(out, makeVolume(mount,
			cstrToStr(st.Mntfromname[:]), cstrToStr(st.Fstypename[:]),
			int64(st.Blocks*bsize), int64(st.Bfree*bsize), int64(st.Bavail*bsize)))
	}
	return out, errs
}
