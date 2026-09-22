/** 统一任务域路由（用户级资源，DESIGN「统一任务管理」）：REST 管理面（前端任务视图、第三方集成与脚本管理），
 *  与 task_* 工具同源同权（写操作不经审批——REST 已有身份认证边界，与 sessions/env 等既有资源管理端点姿态一致）。
 *  资源文件端点限定在任务资源目录内（任务管理器侧做路径白名单校验）。 */
import type { RouteCtx } from "./context"
import type { Context } from "hono"
import type { AppEnv } from "../app"
import { isValidSessionId } from "../core/base/paths"

export function registerTaskRoutes(rc: RouteCtx): void {
  const { app, d } = rc
  const userOf = rc.userOf

  // 任务 id 格式白名单（32 位 hex，与生成规则一致）：畸形/穿越形态 400。
  // `queue` 是保留路径段（/api/v1/tasks/queue 队列视图），不受该中间件约束。
  const validateTaskId = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const id = c.req.param("id") ?? ""
    if (id === "queue") return await next()
    if (!/^[a-f0-9]{32}$/.test(id)) return c.json({ error: `invalid task id: ${id}` }, 400)
    await next()
  }
  app.use("/api/v1/tasks/:id", validateTaskId)
  app.use("/api/v1/tasks/:id/*", validateTaskId)

  // 能力开关关闭（GEBAI_TASKS_ENABLED=false）：统一 503（与既有资源域一致）
  const disabled = (c: Context<AppEnv>) => c.json({ error: "tasks disabled (GEBAI_TASKS_ENABLED=false)" }, 503)
  const fail = (c: Context<AppEnv>, err: unknown, status: 400 | 404 | 503 = 400) => c.json({ error: String((err as Error).message || err) }, status as 400)

  app.get("/api/v1/tasks", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    const kind = c.req.query("kind")
    const state = c.req.query("state")
    const all = await d.tasks.list(user.id)
    return c.json(all.filter((t) => (!kind || t.kind === kind) && (!state || t.state === state)))
  })

  app.post("/api/v1/tasks", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    try {
      const body = await c.req.json()
      const task = await d.tasks.add(
        user.id,
        body,
        typeof body?.originSessionId === "string" && isValidSessionId(body.originSessionId) ? body.originSessionId : undefined,
      )
      return c.json(task, 201)
    } catch (err) {
      return fail(c, err)
    }
  })

  // 队列视图（额度/排队顺序/运行中）：注册在 :id 之前（同段路径优先精确匹配）
  app.get("/api/v1/tasks/queue", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    return c.json(d.tasks.queueView(user.id))
  })

  app.get("/api/v1/tasks/:id", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    const task = await d.tasks.get(user.id, c.req.param("id"))
    return task ? c.json(task) : c.json({ error: "not found" }, 404)
  })

  app.patch("/api/v1/tasks/:id", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    try {
      const body = await c.req.json()
      const task = await d.tasks.update(user.id, c.req.param("id"), body ?? {})
      if (!task) return c.json({ error: "not found" }, 404)
      return c.json(task)
    } catch (err) {
      return fail(c, err)
    }
  })

  app.delete("/api/v1/tasks/:id", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    const removed = await d.tasks.remove(user.id, c.req.param("id"))
    return removed ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)
  })

  // 手动执行（入队；front=true 置顶）
  app.post("/api/v1/tasks/:id/run", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    try {
      const body = await c.req.json().catch(() => ({}))
      const res = await d.tasks.run(user.id, c.req.param("id"), { front: body?.front === true })
      if (!res) return c.json({ error: "not found" }, 404)
      return c.json(res)
    } catch (err) {
      return fail(c, err)
    }
  })

  // 置顶（排队中）
  app.post("/api/v1/tasks/:id/front", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    try {
      const res = await d.tasks.run(user.id, c.req.param("id"), { front: true })
      if (!res) return c.json({ error: "not found" }, 404)
      return c.json(res)
    } catch (err) {
      return fail(c, err)
    }
  })

  // 出队（取消排队中的执行；运行中的任务用 stop）
  app.delete("/api/v1/tasks/:id/queue", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    const ok = await d.tasks.cancel(user.id, c.req.param("id"))
    return c.json({ ok })
  })

  // 终止运行中的任务
  app.post("/api/v1/tasks/:id/stop", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    const ok = await d.tasks.stopRun(user.id, c.req.param("id"))
    return c.json({ ok })
  })

  // ---- 任务资源文件（脚本/文档） ----
  app.get("/api/v1/tasks/:id/files", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    try {
      return c.json(await d.tasks.files(user.id, c.req.param("id")))
    } catch (err) {
      return fail(c, err, 404)
    }
  })

  app.get("/api/v1/tasks/:id/files/content", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    const path = c.req.query("path") ?? ""
    try {
      return c.json({ path, content: await d.tasks.readFile(user.id, c.req.param("id"), path) })
    } catch (err) {
      return fail(c, err, 404)
    }
  })

  app.put("/api/v1/tasks/:id/files/content", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    try {
      const body = await c.req.json()
      if (typeof body?.path !== "string" || !body.path) return c.json({ error: "missing path" }, 400)
      return c.json(await d.tasks.writeFile(user.id, c.req.param("id"), body.path, String(body.content ?? "")))
    } catch (err) {
      return fail(c, err)
    }
  })

  app.delete("/api/v1/tasks/:id/files", async (c) => {
    if (!d.tasks) return disabled(c)
    const user = await userOf(c)
    try {
      const ok = await d.tasks.deleteFile(user.id, c.req.param("id"), c.req.query("path") ?? "")
      return c.json({ ok })
    } catch (err) {
      return fail(c, err)
    }
  })
}
