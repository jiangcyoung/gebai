//go:build windows

// 平台容量探测（Windows）：GetLogicalDrives 枚举盘符，GetDiskFreeSpaceExW 取容量，
// GetVolumeInformationW 取卷标与文件系统名。
package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	modkernel32               = syscall.NewLazyDLL("kernel32.dll")
	procGetLogicalDrives      = modkernel32.NewProc("GetLogicalDrives")
	procGetDiskFreeSpaceExW   = modkernel32.NewProc("GetDiskFreeSpaceExW")
	procGetVolumeInformationW = modkernel32.NewProc("GetVolumeInformationW")
)

func volumeLabelAndFS(rootPtr *uint16) (string, string) {
	var nameBuf [261]uint16
	var fsBuf [261]uint16
	procGetVolumeInformationW.Call(
		uintptr(unsafe.Pointer(rootPtr)),
		uintptr(unsafe.Pointer(&nameBuf[0])), uintptr(len(nameBuf)),
		0, 0, 0,
		uintptr(unsafe.Pointer(&fsBuf[0])), uintptr(len(fsBuf)),
	)
	return syscall.UTF16ToString(nameBuf[:]), syscall.UTF16ToString(fsBuf[:])
}

func platformVolumes() ([]volumeInfo, []string) {
	mask, _, _ := procGetLogicalDrives.Call()
	var out []volumeInfo
	var errs []string
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := fmt.Sprintf("%c:\\", 'A'+i)
		ptr, err := syscall.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		var freeAvail, total, totalFree uint64
		r1, _, e1 := procGetDiskFreeSpaceExW.Call(
			uintptr(unsafe.Pointer(ptr)),
			uintptr(unsafe.Pointer(&freeAvail)),
			uintptr(unsafe.Pointer(&total)),
			uintptr(unsafe.Pointer(&totalFree)),
		)
		if r1 == 0 {
			// 空读卡器/未就绪卷：跳过并记因
			errs = append(errs, fmt.Sprintf("%s: %v", root, e1))
			continue
		}
		label, fsName := volumeLabelAndFS(ptr)
		out = append(out, makeVolume(root, label, fsName,
			int64(total), int64(totalFree), int64(freeAvail)))
	}
	return out, errs
}
