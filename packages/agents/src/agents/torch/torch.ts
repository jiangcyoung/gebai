/**
 * torch 子Agent：PyTorch Profiler（Chrome Trace / Kineto）trace 分析与代码问题定位。
 *
 * 报告面（全部工具在 torch-tools.ts）：
 * - 总览（事件规模与采集开关、CPU/GPU 忙碌占比、步级耗时与抖动、算子/内核/CUDA API 排行、显存峰值与碎片率、用户代码热点）；
 * - 算子/内核下钻（按名称筛选、张量形状与 dtype、内核几何、内核→发起算子归属）；
 * - 显存分析（峰值已分配/已保留、碎片率、最大单次分配、按设备分布）；
 * - 问题诊断（同步/CPU 受限/Python 开销/算子碎片化/autograd/小内核/显存/步抖动/精度与布局/用户代码热点），可选定位到源码 文件:行。
 *
 * 与 `nsight` 子Agent 的分工（两面互不依赖，可同时装载）：本面解释「哪个算子、哪行 Python、显存怎么用」；
 * GPU 内核级时间线（Nsight Systems）与单内核硬件计数器（Nsight Compute）由 `nsight` 提供。
 * 注意：Windows 上 PyTorch 的 CUPTI 采集不可用（实测显式启用 CUDA activity 仍无 kernel 事件），
 * 因此本面在 Windows 下通常只含 CPU/内存维度，GPU 侧需用 nsys 采集——工具输出会明确说明这一点。
 *
 * 设计取向：单趟流式扫描（不整文件 JSON.parse，内存与 trace 规模解耦）、结果条数有界、
 * 事实按文件指纹缓存，因此 GB 级 trace 仍可实时分析。
 */
import { isAbsolute, resolve } from "node:path"
import type { SubAgentDef } from "@gebai/sdk"
import { projectAware } from "@gebai/sdk/node"
import systemPromptBase from "./torch.md"
import { torchTools } from "./torch-tools"

export const name = "torch"

export const description =
  "PyTorch Profiler trace（Chrome Trace / Kineto）分析：解析 .pt.trace.json(.gz) 给出算子与内核热点（含自身耗时、张量形状与 dtype）、步级耗时与抖动、显存峰值与碎片率、GPU 空闲缝与 CPU 受限判定，输出量化问题清单（同步阻塞/算子碎片化/autograd 开销/小内核/显存等）并把热点定位到工程源码 文件:行。超大 trace 走流式扫描与缓存（不整文件解析，内存与规模解耦）。输入：trace 路径（可带 gz）+ 源码工程；输出：问题清单、代码位置、修复优先级。"

export const systemPrompt = systemPromptBase

/** trace 路径常位于工程内，故统一加 project 参数（预置项目名/路径/保留名 tmp）以按根解析。 */
export const tools = {
  overview: projectAware(torchTools.overview!, { workdir: true }),
  ops: projectAware(torchTools.ops!, { workdir: true }),
  memory: projectAware(torchTools.memory!, { workdir: true }),
  findings: projectAware(torchTools.findings!, { workdir: true }),
}

export const requiresApproval = {}
export const preload = false

export const envVars = [
  { name: "TORCH_TRACE_PROJECT", description: "默认源码工程根：未指定 project 参数时以其为基准（trace 路径与源码定位的搜索范围）" },
]

/** 默认工程根兜底：TORCH_TRACE_PROJECT 配置时即视为项目绑定。 */
export const projectRoot = (env: Record<string, string>): string | undefined => {
  const value = env.TORCH_TRACE_PROJECT
  if (!value) return undefined
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

export const def: SubAgentDef = { name, description, systemPrompt, tools, requiresApproval, preload, envVars, projectRoot }
