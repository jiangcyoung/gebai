/**
 * 报告间对比的测试：度量方向（改善/退化判定）、缺项如实标注、问题清单增删与代价变化。
 *
 * 这些断言锁的是「对比不能撒谎」——方向判错会把优化报成退化（或反之），
 * 缺项若被当成 0 参与运算则会凭空造出差异。
 */
import { describe, expect, test } from "bun:test"
import { compareSnapshots, renderCompare, type SideSnapshot } from "./compare"

const fmtNs = (ns: number) => `${(ns / 1e6).toFixed(2)}ms`

const side = (label: string, metrics: SideSnapshot["metrics"], findings: SideSnapshot["findings"]): SideSnapshot => ({
  label,
  metrics,
  findings,
})

describe("度量差异方向", () => {
  test("高优度量上升记为改善、低优度量上升记为退化", () => {
    const before = side("改前", [
      { name: "GPU 利用率", value: 0.4, higherIsBetter: true, text: "40.0%" },
      { name: "同步等待总时长", value: 10e6, higherIsBetter: false, text: "10.00ms" },
    ], [])
    const after = side("改后", [
      { name: "GPU 利用率", value: 0.7, higherIsBetter: true, text: "70.0%" },
      { name: "同步等待总时长", value: 4e6, higherIsBetter: false, text: "4.00ms" },
    ], [])
    const r = compareSnapshots(before, after)
    const util = r.metrics.find((m) => m.name === "GPU 利用率")!
    const sync = r.metrics.find((m) => m.name === "同步等待总时长")!
    expect(util.kind).toBe("improved")
    expect(sync.kind).toBe("improved") // 同步等待下降 = 改善
    expect(util.changePct).toBeCloseTo(75, 3)
    expect(sync.changePct).toBeCloseTo(-60, 3)
  })

  test("方向相反时如实判为退化（不按数值大小猜）", () => {
    const before = side("改前", [{ name: "GPU 利用率", value: 0.8, higherIsBetter: true, text: "80.0%" }], [])
    const after = side("改后", [{ name: "GPU 利用率", value: 0.5, higherIsBetter: true, text: "50.0%" }], [])
    expect(compareSnapshots(before, after).metrics[0]!.kind).toBe("regressed")
  })

  test("缺项不参与差值运算：仅一侧有则如实标注", () => {
    const before = side("改前", [{ name: "显存传输总时长", value: 3e6, higherIsBetter: false, text: "3.00ms" }], [])
    const after = side("改后", [{ name: "CUDA Graph 执行时长", value: 5e6, higherIsBetter: false, text: "5.00ms" }], [])
    const r = compareSnapshots(before, after)
    expect(r.metrics.map((m) => m.kind).sort()).toEqual(["only-after", "only-before"])
    // 两侧都没有的度量不得凭空出现差值
    expect(r.metrics.every((m) => m.changePct === undefined)).toBe(true)
  })

  test("单位不同不比数值（MB 与 KB 直接比大小会得出错误结论）", () => {
    const before = side("改前", [{ name: "显存传输字节", value: 3.9, unit: "MB", higherIsBetter: false, text: "3.9 MB" }], [])
    const after = side("改后", [{ name: "显存传输字节", value: 679, unit: "KB", higherIsBetter: false, text: "679.0 KB" }], [])
    const d = compareSnapshots(before, after).metrics[0]!
    expect(d.kind).toBe("incomparable")
    expect(d.changePct).toBeUndefined()
  })

  test("差异低于显著性阈值记为持平（不把噪声级差异报成退化）", () => {
    const mk = (v: number) => side("x", [{ name: "同步等待总时长", value: v, unit: "ms", higherIsBetter: false, text: `${v} ms` }], [])
    // 10.0 → 10.2 ms = +2.0%：低于默认 1% 阈值才算显著？
    expect(compareSnapshots(mk(10.0), mk(10.2)).metrics[0]!.kind).toBe("regressed")
    // 阈值调到 5% 后同一变化记为持平（差异在阈值内）
    expect(compareSnapshots(mk(10.0), mk(10.2), { significancePct: 5 }).metrics[0]!.kind).toBe("negligible")
    // 阈值调成 0：任何非零差异都算显著
    expect(compareSnapshots(mk(10.0), mk(10.2), { significancePct: 0 }).metrics[0]!.kind).toBe("regressed")
  })

  test("基准为 0 时算不出百分比：按方向判定且不给出误导性百分比", () => {
    const before = side("改前", [{ name: "采集开销占比（窗口内）", value: 0, unit: "%", higherIsBetter: false, text: "0.0%" }], [])
    const after = side("改后", [{ name: "采集开销占比（窗口内）", value: 0.4, unit: "%", higherIsBetter: false, text: "0.4%" }], [])
    const d = compareSnapshots(before, after).metrics[0]!
    expect(d.kind).toBe("regressed")
    expect(d.changePct).toBeUndefined()
  })

  test("无方向的度量标为无法比较（不猜好坏）", () => {
    const before = side("改前", [{ name: "内核调用次数", value: 100, text: "100" }], [])
    const after = side("改后", [{ name: "内核调用次数", value: 80, text: "80" }], [])
    expect(compareSnapshots(before, after).metrics[0]!.kind).toBe("incomparable")
  })
})

describe("问题清单差异", () => {
  test("新增/消失/严重度变化三类分别识别，代价变化按两侧共有项累计", () => {
    const before = side(
      "改前",
      [],
      [
        { id: "gpu-idle", severity: "critical", title: "GPU 空闲占比高", reclaimableNs: 100e6 },
        { id: "sync-stall", severity: "high", title: "同步等待成为瓶颈", reclaimableNs: 20e6 },
        { id: "device-imbalance", severity: "medium", title: "多卡不均衡", reclaimableNs: 50e6 },
      ],
    )
    const after = side(
      "改后",
      [],
      [
        { id: "gpu-idle", severity: "medium", title: "GPU 空闲占比高", reclaimableNs: 40e6 },
        { id: "sync-stall", severity: "high", title: "同步等待成为瓶颈", reclaimableNs: 20e6 },
        { id: "small-kernels", severity: "low", title: "小内核过多", reclaimableNs: 5e6 },
      ],
    )
    const r = compareSnapshots(before, after)
    const byId = new Map(r.findings.map((f) => [f.id, f]))
    expect(byId.get("device-imbalance")!.kind).toBe("fixed")
    expect(byId.get("small-kernels")!.kind).toBe("new")
    expect(byId.get("gpu-idle")!.kind).toBe("changed")
    expect(byId.get("gpu-idle")!.beforeSeverity).toBe("critical")
    expect(byId.get("gpu-idle")!.afterSeverity).toBe("medium")
    expect(byId.get("sync-stall")!.kind).toBe("unchanged")
    // 净变化按两侧各自全量求和：前 100+20+50=170ms，后 40+20+5=65ms → -105ms
    expect(r.reclaimableDeltaNs).toBe(-105e6)
    expect(r.beforeReclaimableNs).toBe(170e6)
    expect(r.afterReclaimableNs).toBe(65e6)
  })

  test("渲染文本含方向箭头与净变化（模型可直接引用）", () => {
    const before = side("a.nsys-rep", [{ name: "GPU 利用率", value: 0.4, higherIsBetter: true, text: "40.0%" }], [
      { id: "gpu-idle", severity: "high", title: "空闲高", reclaimableNs: 10e6 },
    ])
    const after = side("b.nsys-rep", [{ name: "GPU 利用率", value: 0.6, higherIsBetter: true, text: "60.0%" }], [])
    const text = renderCompare(before, after, compareSnapshots(before, after), fmtNs).join("\n")
    expect(text).toContain("a.nsys-rep → b.nsys-rep")
    expect(text).toContain("改善")
    expect(text).toContain("消失 1 项")
    expect(text).toContain("问题可回收时间合计")
    expect(text).toContain("问题总代价下降")
    // 消失的问题也要计入净变化（修好的问题省了多少必须看得见）
    expect(text).toContain("-10.00ms")
  })
})
