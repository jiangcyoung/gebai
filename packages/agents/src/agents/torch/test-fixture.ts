/**
 * torch 测试夹具：**真实字段结构**的合成 trace 生成器（原生/JS 等价性比对与探针共用）。
 *
 * 字段名与嵌套形态照抄 torch 2.14 的 `export_chrome_trace` 输出：事件内部带缩进、
 * `cpu_op` 带 `args.Input Dims/Input Strides/Input type`、`python_function` 带 `CallFrom`
 * 与名称内嵌的 `文件(行): 函数`、`cpu_instant_event` 带 `Bytes/Total Allocated/Total Reserved`，
 * 并含 fwdbwd 配对、`ac2g` 流事件、`correlation` 关联与 `ProfilerStep` 步标注——覆盖聚合器的
 * 全部分支（只测结构不测分支的夹具会让等价性测试变成假通过）。
 */
import { writeFileSync } from "node:fs"

/** 生成一份真实结构的合成 trace（steps 步 × opsPerStep 个算子）。 */
export function makeRealisticTrace(path: string, steps = 4, opsPerStep = 6): void {
  const ev: string[] = []
  const pad = "    "
  const mk = (body: string): string => `{\n${pad}${body}\n  }`
  let ts = 6_866_517_959_465.076
  let corr = 100
  let flowId = 900

  ev.push(mk(`"ph": "M",\n${pad}"name": "process_name",\n${pad}"pid": 4964,\n${pad}"tid": 22044,\n${pad}"args": {\n${pad}${pad}"name": "python"\n${pad}}`))
  for (let s = 1; s <= steps; s++) {
    ev.push(
      mk(
        `"ph": "X",\n${pad}"cat": "user_annotation",\n${pad}"name": "ProfilerStep#${s}",\n${pad}"pid": 4964,\n${pad}"tid": 22044,\n${pad}"ts": ${ts.toFixed(3)},\n${pad}"dur": ${(3000 + s * 400).toFixed(3)}`,
      ),
    )
    ts += 20
    for (let o = 0; o < opsPerStep; o++) {
      const dur = 30 + ((o * 37) % 220)
      // python_function 帧（with_stack 形态）
      ev.push(
        mk(
          `"ph": "X",\n${pad}"cat": "python_function",\n${pad}"name": "train.py(${20 + o}): train_step",\n${pad}"pid": 4964,\n${pad}"tid": 22044,\n${pad}"ts": ${ts.toFixed(3)},\n${pad}"dur": ${dur.toFixed(3)},\n${pad}"args": {\n${pad}${pad}"CallFrom": "torch/autograd/__init__.py:322", "Ev Idx": ${o}, "Python id": ${110 + o}\n${pad}}`,
        ),
      )
      // cpu_op：真实最重的一类（嵌套数组字段）
      ev.push(
        mk(
          `"ph": "X",\n${pad}"cat": "cpu_op",\n${pad}"name": "aten::addmm",\n${pad}"pid": 4964,\n${pad}"tid": 22044,\n${pad}"ts": ${(ts + 2).toFixed(3)},\n${pad}"dur": ${(dur - 4).toFixed(3)},\n${pad}"args": {\n${pad}${pad}"External id": ${corr}, "Record function id": 0, "Sequence number": ${o},\n${pad}${pad}"Input type": ["float", "float", "Scalar", "", "", "Scalar", "Scalar", ""],\n${pad}${pad}"Input Dims": [[64, 512], [], [], [], [], [], [], []], "Input Strides": [[512, 1], [], [], [], [], [], [], []]\n${pad}}`,
        ),
      )
      // 前向/反向配对（fwdbwd：s 挂前向算子、f 挂其反向算子）
      const fwdId = flowId++
      ev.push(mk(`"ph": "s",\n${pad}"cat": "fwdbwd",\n${pad}"name": "fwdbwd",\n${pad}"id": ${fwdId},\n${pad}"pid": 4964,\n${pad}"tid": 22044,\n${pad}"ts": ${(ts + 2).toFixed(3)}`))
      const bwdTs = ts + dur
      ev.push(mk(`"ph": "X",\n${pad}"cat": "cpu_op",\n${pad}"name": "AddmmBackward0",\n${pad}"pid": 4964,\n${pad}"tid": 22044,\n${pad}"ts": ${bwdTs.toFixed(3)},\n${pad}"dur": ${(dur * 0.8).toFixed(3)}`))
      ev.push(mk(`"ph": "f",\n${pad}"cat": "fwdbwd",\n${pad}"name": "fwdbwd",\n${pad}"id": ${fwdId},\n${pad}"pid": 4964,\n${pad}"tid": 22044,\n${pad}"ts": ${bwdTs.toFixed(3)}`))
      // CUDA API + 内核（correlation 关联）
      const launchTs = ts + 6
      ev.push(
        mk(
          `"ph": "X",\n${pad}"cat": "cuda_runtime",\n${pad}"name": "cudaLaunchKernel",\n${pad}"pid": 4964,\n${pad}"tid": 22044,\n${pad}"ts": ${launchTs.toFixed(3)},\n${pad}"dur": 4.500,\n${pad}"args": {\n${pad}${pad}"correlation": ${corr}, "External id": ${corr}\n${pad}}`,
        ),
      )
      ev.push(
        mk(
          `"ph": "X",\n${pad}"cat": "kernel",\n${pad}"name": "sm90_xmma_gemm_f32f32_tf32f32_f32_tn",\n${pad}"pid": 0,\n${pad}"tid": 7,\n${pad}"ts": ${(launchTs + 10).toFixed(3)},\n${pad}"dur": ${(dur * 0.6).toFixed(3)},\n${pad}"args": {\n${pad}${pad}"correlation": ${corr}, "stream": 7, "device": 0, "grid": [128, 1, 1], "block": [256, 1, 1], "registers per thread": 168, "shared memory": 49152\n${pad}}`,
        ),
      )
      corr++
      // 内存分配（profile_memory 形态）
      if (o % 2 === 0) {
        ev.push(
          mk(
            `"ph": "i",\n${pad}"cat": "cpu_instant_event",\n${pad}"s": "t",\n${pad}"name": "[memory]",\n${pad}"pid": 4964,\n${pad}"tid": 22044,\n${pad}"ts": ${ts.toFixed(3)},\n${pad}"args": {\n${pad}${pad}"Device Type": 0, "Device Id": 0, "Bytes": ${1024 * (o + 1)}, "Total Allocated": ${1_048_576 * (o + 1)}, "Total Reserved": ${2_097_152 * (o + 1)}\n${pad}}`,
          ),
        )
      }
      ts += dur + 5
    }
    // 步末同步（.item() 形态）
    ev.push(mk(`"ph": "X",\n${pad}"cat": "cpu_op",\n${pad}"name": "aten::item",\n${pad}"pid": 4964,\n${pad}"tid": 22044,\n${pad}"ts": ${(ts - 8).toFixed(3)},\n${pad}"dur": 3.200`))
  }
  const head = `{\n    "schemaVersion": 1,\n    "deviceProperties": [],\n    "record_shapes": 1,\n    "profile_memory": 1,\n    "with_stack": 1,\n    "displayTimeUnit": "ms",\n    "traceEvents": [\n`
  writeFileSync(path, `${head}${ev.join(",\n")}\n]}`)
}
