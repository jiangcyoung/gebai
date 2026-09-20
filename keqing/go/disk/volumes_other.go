//go:build !linux && !darwin && !windows

// 其它平台的容量探测：不支持（工具如实回报，不静默给空结果）。
package main

func platformVolumes() ([]volumeInfo, []string) {
	return nil, []string{"当前平台不支持磁盘容量探测（volumes 支持 linux/darwin/windows）"}
}
