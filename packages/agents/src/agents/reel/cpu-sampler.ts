/**
 * 渲染期 CPU 采样：用来判断「这台机器是不是被 CPU 配额卡住了」。
 *
 * 为什么需要：分片只在单浏览器留有余量时才有意义。实测（4 核配额容器 · 1080p · 90 帧）——
 * 1 片 7.2 fps（占 3.69/4 核，全程节流）→ 2 片 5.0 → 4 片 4.5：配额被打满时加片只会加剧争抢。
 * 而"是否打满"无法从核数推断（容器可能只拿到宿主的一部分配额），只能实测。
 *
 * 口径：优先读 cgroup v2 的 `cpu.stat`（容器配额下的真实用量，与宿主规模无关）；
 * 取不到时回落 `/proc/stat`（宿主全局，含其他租户，仅作参考）；再取不到记 none。
 * 采样是同步小读，开销可忽略；`startCpuSampling()` 返回停止函数，调用即得区间内的 CPU 秒数与口径。
 */
import { readFileSync } from "node:fs"

export interface CpuSample {
  cpuSeconds: number
  /** cgroup = 本容器真实用量；proc = 宿主全局（仅参考）；none = 不可用。 */
  source: "cgroup" | "proc" | "none"
}

const CGROUP_CPU_STAT = "/sys/fs/cgroup/cpu.stat"
/** /proc/stat 的 USER_HZ：Linux 上恒为 100，用于把 jiffies 折算成秒。 */
const USER_HZ = 100

function readCgroupSeconds(): number | null {
  try {
    const matched = /usage_usec\s+(\d+)/.exec(readFileSync(CGROUP_CPU_STAT, "utf8"))
    return matched ? Number(matched[1]) / 1e6 : null
  } catch {
    return null
  }
}

/** 宿主全局的忙时秒数（user+nice+system+irq+softirq+steal；不含 idle/iowait）。 */
function readProcSeconds(): number | null {
  try {
    const f = readFileSync("/proc/stat", "utf8").split("\n")[0].split(/\s+/).slice(1).map(Number)
    const busy = (f[0] ?? 0) + (f[1] ?? 0) + (f[2] ?? 0) + (f[5] ?? 0) + (f[6] ?? 0) + (f[7] ?? 0)
    return busy / USER_HZ
  } catch {
    return null
  }
}

/** 开始采样；返回的函数给出区间内的 CPU 秒数（不可用时为 0 + source:none）。 */
export function startCpuSampling(): () => CpuSample {
  const cgroupStart = process.platform === "linux" ? readCgroupSeconds() : null
  const procStart = cgroupStart === null ? readProcSeconds() : null
  const source: CpuSample["source"] = cgroupStart !== null ? "cgroup" : procStart !== null ? "proc" : "none"
  return () => {
    if (source === "cgroup") {
      const now = readCgroupSeconds()
      return { cpuSeconds: now === null ? 0 : Math.max(0, now - (cgroupStart as number)), source }
    }
    if (source === "proc") {
      const now = readProcSeconds()
      return { cpuSeconds: now === null ? 0 : Math.max(0, now - (procStart as number)), source }
    }
    return { cpuSeconds: 0, source }
  }
}

/** 区间内的平均在用核数（CPU 秒 ÷ 墙钟秒）；不可用或墙钟非正时返回 0。 */
export function averageCoresUsed(sample: CpuSample, wallMs: number): number {
  if (sample.source === "none" || wallMs <= 0) return 0
  return sample.cpuSeconds / (wallMs / 1000)
}
