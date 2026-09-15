import { isAbsolute, resolve } from "node:path"
import type { SubAgentDef } from "@gebai/sdk"
import { projectTool } from "./project"
import { renderTool } from "./render"
import { setupTool } from "./setup"
// 系统提示词独立 md 维护（目录形式约定：{dir}/{dir}.md）。
import systemPromptBase from "./shotcraft.md"

export const name = "shotcraft"
export const description =
  "电影感产品视频制作（video-shotcraft 技能库：157 张镜头配方卡 + 214 条动效 + 已验收模板 + 共享组件与 16 类音效）：把产品页面/前端项目做成宣传片/营销片（分镜、2.5D 运镜、卡点剪辑、声音设计），也支持单镜头动效复刻。开工先 setup（技能库就绪 + 本机渲染档），建工程用 project，渲染走原生渲染库（进程内直连 @remotion/renderer，热 bundle + 热浏览器复用；有 GPU 自动启用 NVENC/VideoToolbox 硬件编码与 Chrome GPU 光栅化，无 GPU 落软件档并如实说明）。输入：产品/页面/素材与视频需求；输出：成片、静帧/预览与渲染档报告。"
export const systemPrompt = systemPromptBase
export const tools = {
  setup: setupTool,
  project: projectTool,
  render: renderTool,
}
export const preload = false

export const envVars = [
  { name: "SHOTCRAFT_LIBRARY_DIR", description: "视频制作技能库与运行时缓存根目录（默认 {GEBAI_HOME}/vendor/video-shotcraft：skill/ 载荷、runtime/ 共享运行时、state/ 调优与作业）" },
  { name: "SHOTCRAFT_SOURCE", description: "技能库载荷来源：本地克隆目录 / 本地 zip 路径 / 自定义下载 URL（离线或镜像环境用；缺省从 GitHub 主源与 AtomGit 镜像获取）" },
  { name: "SHOTCRAFT_PROJECT", description: "默认视频项目根目录：会话默认工作目录即该项目，未指定 project 参数的渲染/工程操作以它为基准" },
  { name: "SHOTCRAFT_GPU", description: "GPU 策略：auto（默认，探测到可用 GPU 即启用硬件编码与 GPU 光栅化）/ off（强制软件档）" },
]

/** 默认项目根兜底：SHOTCRAFT_PROJECT 配置时即判定为项目绑定（提示词注记、子会话工作目录、文件工具默认根同源）。 */
export const projectRoot = (env: Record<string, string>): string | undefined => {
  const value = env.SHOTCRAFT_PROJECT
  if (!value) return undefined
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

export const def: SubAgentDef = { name, description, systemPrompt, tools, preload, envVars, projectRoot }
