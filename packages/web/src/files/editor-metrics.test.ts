import { afterEach, describe, expect, test } from "bun:test"
import { createMetricsSync, ensureEditorFont, fastPathTrustworthy, MONOSPACE_DRIFT_TOLERANCE } from "./editor-metrics"

describe("等宽快速路径可信判定（fastPathTrustworthy）", () => {
  test("缓存宽度与实绘前进宽度一致（含恰好等于容差）：可信", () => {
    expect(fastPathTrustworthy(8, 8)).toBe(true)
    expect(fastPathTrustworthy(7.8, 7.8 + MONOSPACE_DRIFT_TOLERANCE)).toBe(true)
    expect(fastPathTrustworthy(7.8, 7.8 - MONOSPACE_DRIFT_TOLERANCE)).toBe(true)
  })

  test("偏差超过容差（回退字体的宽度被缓存成了「本字体」的宽度）：不可信", () => {
    // Windows 回退的 Consolas 是 0.55em、JetBrains Mono 是 0.6em：13px 下差 0.65px/字符
    expect(fastPathTrustworthy(7.15, 7.8)).toBe(false)
    expect(fastPathTrustworthy(7.8, 7.8 + MONOSPACE_DRIFT_TOLERANCE + 0.001)).toBe(false)
  })

  test("量不到实绘宽度或数值不可用：判为可信（宁可不干预，也不误关优化）", () => {
    expect(fastPathTrustworthy(8, null)).toBe(true)
    expect(fastPathTrustworthy(8, Number.NaN)).toBe(true)
    expect(fastPathTrustworthy(8, 0)).toBe(true)
    expect(fastPathTrustworthy(Number.NaN, 8)).toBe(true)
    expect(fastPathTrustworthy(0, 8)).toBe(true)
  })
})

/*
 * ensureEditorFont 的缓存是模块级（就绪一次即长期命中），因此本组用例**顺序敏感**：
 * 先在「未就绪」的世界里跑超时/不缓存语义，成功那一步放最后。
 */
describe("编辑器字体就绪等待（ensureEditorFont）", () => {
  const doc = document as unknown as { fonts?: unknown }
  const fontSet = (v: unknown): void => {
    doc.fonts = v
  }
  const prev = doc.fonts
  afterEach(() => {
    doc.fonts = prev
  })

  test("缺 FontFaceSet API：返回 false 且不抛", async () => {
    fontSet(undefined)
    expect(await ensureEditorFont(10)).toBe(false)
  })

  test("字体取不回来：到上限即返回 false（不阻塞建编辑器）", async () => {
    fontSet({ check: () => false, load: () => new Promise(() => {}), ready: new Promise(() => {}) })
    const t0 = Date.now()
    expect(await ensureEditorFont(30)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  test("首次未就绪不缓存结论：字体稍后就绪时下次调用拿到 true（此后走缓存）", async () => {
    let ready = false
    let loads = 0
    fontSet({
      check: () => ready,
      load: () => {
        loads++
        return Promise.resolve([])
      },
      ready: Promise.resolve(),
    })
    expect(await ensureEditorFont(20)).toBe(false) // 加载成功但 check 仍未就绪 → 不算就绪，不缓存
    ready = true
    expect(await ensureEditorFont(20)).toBe(true)
    expect(await ensureEditorFont(20)).toBe(true)
    expect(loads).toBeLessThanOrEqual(2) // 就绪后走缓存，不再触达 fonts.load
  })
})

describe("度量同步（createMetricsSync）", () => {
  /** 等一帧（bun 的 requestAnimationFrame 是异步的，同步器把复检排在帧上）。 */
  const flush = () => new Promise((r) => setTimeout(r, 25))

  /** 最小 monaco 桩：run() 只用到编辑部选项 id 与全局重测。 */
  function fakeMonaco() {
    let remeasures = 0
    return {
      monaco: {
        editor: {
          EditorOption: { fontInfo: 1 },
          remeasureFonts: () => {
            remeasures++
          },
        },
      } as unknown as Parameters<typeof createMetricsSync>[0],
      remeasures: () => remeasures,
    }
  }

  /** 让 paintedAdvance 能读到「一条纯标识符渲染行」：桩掉区间几何（位置 = 字符序号 × advance）。 */
  function stubPaintedLine(advance: number) {
    const doc = document as unknown as Record<string, unknown>
    const prevRange = doc.createRange
    const prevWarn = console.warn
    const warns: string[] = []
    doc.createRange = () => {
      let idx = 0
      return {
        setStart: (_node: unknown, i: number) => {
          idx = i
        },
        setEnd() {},
        getBoundingClientRect: () => ({ left: idx * advance }),
      }
    }
    console.warn = ((msg: string) => {
      warns.push(String(msg))
    }) as typeof console.warn
    return {
      restore: () => {
        doc.createRange = prevRange
        console.warn = prevWarn
      },
      warns,
    }
  }

  /** 假编辑器 DOM：一条渲染行、行内一个纯标识符文本节点。 */
  const fakeDom = () => ({
    isConnected: true,
    offsetWidth: 100,
    querySelectorAll: () => [{ childNodes: [{ nodeType: 3, data: "identifier_name" }] }],
    appendChild() {},
  })

  function fakeEditor(opts: { spaceWidth: () => number; dom?: unknown; edits: Array<Record<string, unknown>> }) {
    return {
      getOption: () => ({ typicalHalfwidthCharacterWidth: opts.spaceWidth() }),
      getDomNode: () => opts.dom ?? null,
      layout() {},
      updateOptions: (o: Record<string, unknown>) => opts.edits.push(o),
    }
  }

  /** 按读取次序给宽度的桩编辑器：模拟「重测前 = 回退字体宽度、重测后 = 真字体宽度」。 */
  function sequenceEditor(widths: number[], dom: unknown, edits: Array<Record<string, unknown>>) {
    let reads = 0
    return fakeEditor({ spaceWidth: () => widths[Math.min(reads++, widths.length - 1)], dom, edits })
  }

  test("量不到实绘宽度（编辑器未布局）：不重测、不改选项，保持未校准", async () => {
    const { monaco, remeasures } = fakeMonaco()
    const edits: Array<Record<string, unknown>> = []
    const sync = createMetricsSync(monaco, () => [fakeEditor({ spaceWidth: () => 8, edits }) as never])
    await flush()
    expect(remeasures()).toBe(0)
    expect(edits).toEqual([])
    sync.dispose()
    sync.check() // 销毁后再调不做事
    await flush()
    expect(remeasures()).toBe(0)
  })

  test("缓存宽度与实绘一致：标为已校准，此后 check 不再复检", async () => {
    const { monaco, remeasures } = fakeMonaco()
    const stub = stubPaintedLine(8)
    const edits: Array<Record<string, unknown>> = []
    try {
      const sync = createMetricsSync(monaco, () => [fakeEditor({ spaceWidth: () => 8, dom: fakeDom(), edits }) as never])
      await flush()
      expect(remeasures()).toBe(0)
      expect(edits).toEqual([])
      sync.check()
      await flush()
      expect(remeasures()).toBe(0)
      sync.dispose()
    } finally {
      stub.restore()
    }
  })

  test("不一致 → 先重测；重测后一致即校准（字体晚到留下陈旧缓存的常规路径）", async () => {
    const { monaco, remeasures } = fakeMonaco()
    const stub = stubPaintedLine(8)
    const edits: Array<Record<string, unknown>> = []
    try {
      const sync = createMetricsSync(monaco, () => [sequenceEditor([7.15, 8], fakeDom(), edits) as never])
      await flush()
      expect(remeasures()).toBe(1)
      expect(edits).toEqual([]) // 重测即校准，不动编辑器选项
      expect(stub.warns).toEqual([])
      sync.dispose()
    } finally {
      stub.restore()
    }
  })

  test("重测后仍不一致 → 关掉等宽快速路径并留一条诊断", async () => {
    const { monaco, remeasures } = fakeMonaco()
    const stub = stubPaintedLine(8)
    const edits: Array<Record<string, unknown>> = []
    try {
      const sync = createMetricsSync(monaco, () => [sequenceEditor([7.15, 7.15], fakeDom(), edits) as never])
      await flush()
      expect(remeasures()).toBe(1)
      expect(edits).toEqual([{ disableMonospaceOptimizations: true }])
      expect(stub.warns.length).toBe(1)
      expect(stub.warns[0]).toContain("字符宽度测量与实绘不一致")
      sync.dispose()
    } finally {
      stub.restore()
    }
  })
})
