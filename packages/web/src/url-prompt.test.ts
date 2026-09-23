import { describe, expect, test } from "bun:test"
import { parseUrlPrompt, redirectToSession, runUrlPromptFromLocation, type UrlPromptDeps } from "./url-prompt"

/** 记录调用顺序的依赖替身。 */
function harness(opts: { sessions?: Array<{ id: string }>; running?: string[]; createFails?: boolean } = {}) {
  const calls: string[] = []
  let nextId = "s-new"
  const deps: UrlPromptDeps = {
    findSession: (id) => {
      calls.push(`find:${id}`)
      return (opts.sessions ?? []).find((s) => s.id === id)
    },
    isRunning: (id) => {
      calls.push(`running:${id}`)
      return (opts.running ?? []).includes(id)
    },
    createSession: async () => {
      calls.push("create")
      if (opts.createFails) throw new Error("disk full")
      return { id: nextId }
    },
    openSession: async (s) => {
      calls.push(`open:${s.id}`)
    },
    send: (s, text) => {
      calls.push(`send:${s.id}:${text}`)
    },
    redirect: (url) => {
      calls.push(`redirect:${url}`)
    },
    fallback: (text, reason) => {
      calls.push(`fallback:${text}:${reason}`)
    },
  }
  return { deps, calls }
}

describe("parseUrlPrompt（URL 提示词参数）", () => {
  test("未携带/空值返回 null", () => {
    expect(parseUrlPrompt("")).toBeNull()
    expect(parseUrlPrompt("?session=abc")).toBeNull()
    expect(parseUrlPrompt("?gb_prompt=")).toBeNull()
    expect(parseUrlPrompt("?gb_prompt=%20%20")).toBeNull()
  })

  test("解析文本/强制新建/指定会话，首尾空白裁掉", () => {
    expect(parseUrlPrompt("?gb_prompt=%E4%BD%A0%E5%A5%BD")).toEqual({ text: "你好", forceNew: false })
    expect(parseUrlPrompt("?gb_prompt=%20a%20b%20&gb_new=1&session=s1")).toEqual({ text: "a b", forceNew: true, sessionId: "s1" })
    expect(parseUrlPrompt("?gb_new=1")).toBeNull()
  })
})

describe("redirectToSession（重定向地址）", () => {
  test("去掉提示词参数、写入会话 id、保留其余参数", () => {
    expect(redirectToSession("?gb_prompt=hi&gb_new=1&gb_style=ink&session=old", "s2")).toBe("/?gb_style=ink&session=s2")
    expect(redirectToSession("?gb_prompt=hi", "s2", "/gebai/")).toBe("/gebai/?session=s2")
  })
})

describe("runUrlPromptFromLocation（自动建会话运行 + 重定向）", () => {
  test("无提示词参数：什么都不做", async () => {
    const { deps, calls } = harness()
    expect(await runUrlPromptFromLocation(deps, { search: "?session=x", pathname: "/" })).toBe("none")
    expect(calls).toEqual([])
  })

  test("配置关闭入口：不建会话、不重定向", async () => {
    const { deps, calls } = harness()
    const outcome = await runUrlPromptFromLocation(deps, { search: "?gb_prompt=hi", pathname: "/", allowed: () => false })
    expect(outcome).toBe("disabled")
    expect(calls).toEqual([])
  })

  test("新建会话：重定向在发送之前、打开会话在发送之前", async () => {
    const { deps, calls } = harness()
    const outcome = await runUrlPromptFromLocation(deps, { search: "?gb_prompt=hi", pathname: "/" })
    expect(outcome).toBe("sent")
    expect(calls).toEqual(["create", "redirect:/?session=s-new", "open:s-new", "send:s-new:hi"])
  })

  test("URL 指定已存在的空闲会话：不新建，直接在该会话发送", async () => {
    const { deps, calls } = harness({ sessions: [{ id: "s1" }] })
    const outcome = await runUrlPromptFromLocation(deps, { search: "?gb_prompt=hi&session=s1", pathname: "/" })
    expect(outcome).toBe("sent")
    expect(calls).toEqual(["find:s1", "running:s1", "redirect:/?session=s1", "open:s1", "send:s1:hi"])
  })

  test("URL 指定会话正在运行：不抢占，回落输入框并重定向", async () => {
    const { deps, calls } = harness({ sessions: [{ id: "s1" }], running: ["s1"] })
    const outcome = await runUrlPromptFromLocation(deps, { search: "?gb_prompt=hi&session=s1", pathname: "/" })
    expect(outcome).toBe("queued")
    expect(calls).toEqual(["find:s1", "running:s1", "redirect:/?session=s1", "fallback:hi:该会话已有任务在运行：提示词未自动发送，已放入输入框"])
  })

  test("gb_new=1：即使带 session 也新建", async () => {
    const { deps, calls } = harness({ sessions: [{ id: "s1" }] })
    const outcome = await runUrlPromptFromLocation(deps, { search: "?gb_prompt=hi&session=s1&gb_new=1", pathname: "/" })
    expect(outcome).toBe("sent")
    expect(calls).toEqual(["create", "redirect:/?session=s-new", "open:s-new", "send:s-new:hi"])
  })

  test("URL 指定会话不存在：新建", async () => {
    const { deps, calls } = harness()
    expect(await runUrlPromptFromLocation(deps, { search: "?gb_prompt=hi&session=gone", pathname: "/" })).toBe("sent")
    expect(calls).toEqual(["find:gone", "create", "redirect:/?session=s-new", "open:s-new", "send:s-new:hi"])
  })

  test("建会话失败：提示词回落输入框且不重定向（刷新重试仍会执行）", async () => {
    const { deps, calls } = harness({ createFails: true })
    expect(await runUrlPromptFromLocation(deps, { search: "?gb_prompt=hi", pathname: "/" })).toBe("failed")
    expect(calls).toEqual(["create", "fallback:hi:自动创建会话失败（disk full）：提示词已放入输入框"])
  })

  test("打开会话异常不阻断发送", async () => {
    const { deps, calls } = harness()
    deps.openSession = async (s) => {
      calls.push(`open:${s.id}`)
      throw new Error("load failed")
    }
    expect(await runUrlPromptFromLocation(deps, { search: "?gb_prompt=hi", pathname: "/" })).toBe("sent")
    expect(calls).toEqual(["create", "redirect:/?session=s-new", "open:s-new", "send:s-new:hi"])
  })
})
