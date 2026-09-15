/**
 * 消息列的块划分规则（纯函数，无 DOM）：消息按固定条数切成块（块是窗口化最小挂载单位），
 * 切分必须尊重「子会话运行过程容器」的分组边界——同一 runId 的过程消息渲染进同一个折叠容器，
 * 边界落在组中间会把一次执行拆成两个容器（回放形态错乱）。
 */

/** 执行过程消息（子会话运行标记 subSession / 旧版 subAgent 存档）。 */
export interface RunMessageLike {
  subSession?: boolean
  subAgent?: boolean
  subSessionId?: string
  subAgentRunId?: string
}

/** 是否为执行过程消息（进折叠容器）。 */
export function isRunMessage(m: RunMessageLike | undefined): boolean {
  return !!m && (m.subSession === true || m.subAgent === true)
}

/** 执行过程消息的运行标识（新版 subSessionId / 旧版 subAgentRunId）。 */
export function runIdOfMessage(m: RunMessageLike): string | undefined {
  return m.subSessionId ?? m.subAgentRunId
}

/**
 * 消息列的窗口化块划分（纯函数）：每块 chunkSize 条消息（块是最小挂载单位），边界**向后**
 * 扩展到执行过程组的组尾——边界落在组内时把整个组并入本块，同一 runId 的过程消息不被拆到
 * 两个块（拆开会渲染出两个折叠容器）。返回值是块边界数组（长度 = 块数 + 1，首元素 0、
 * 末元素 msgs.length）：第 i 块覆盖 [bounds[i], bounds[i+1])。
 */
export function planMessageChunks(msgs: RunMessageLike[], chunkSize: number): number[] {
  const n = msgs.length
  if (n === 0) return [0]
  const size = Math.max(1, Math.floor(chunkSize))
  const bounds: number[] = [0]
  let i = 0
  while (i < n) {
    let end = Math.min(n, i + size)
    // 边界落在组内（下一条与前一条同 runId 的过程消息）→ 向后吞并整个组
    while (end < n && isRunMessage(msgs[end]) && isRunMessage(msgs[end - 1]) && runIdOfMessage(msgs[end]) === runIdOfMessage(msgs[end - 1])) end++
    bounds.push(end)
    i = end
  }
  return bounds
}
