import { describe, expect, test } from "bun:test"
import { applyPatch, parsePatch, PATCH_ANCHOR_TOLERANCE, PATCH_FUZZ_LINES } from "./patch"

describe("parsePatch", () => {
  test("standard patch with file headers and hunk", () => {
    const files = parsePatch("--- a/old.ts\n+++ b/new.ts\n@@ -1,4 +1,4 @@\n a\n-b\n+x\n c\n d\n")
    expect(files).toHaveLength(1)
    expect(files[0].oldPath).toBe("a/old.ts")
    expect(files[0].newPath).toBe("b/new.ts")
    expect(files[0].isNew).toBe(false)
    expect(files[0].hunks).toHaveLength(1)
    expect(files[0].hunks[0].startA).toBe(1)
    expect(files[0].hunks[0].lines).toEqual([
      { kind: 0, text: "a" },
      { kind: -1, text: "b" },
      { kind: 1, text: "x" },
      { kind: 0, text: "c" },
      { kind: 0, text: "d" },
    ])
  })

  test("hunk header without counts tolerated", () => {
    const files = parsePatch("@@ -10 +11 @@\n+new\n")
    expect(files).toHaveLength(1)
    expect(files[0].hunks[0].startA).toBe(10)
    expect(files[0].hunks[0].lines).toEqual([{ kind: 1, text: "new" }])
  })

  test("multiple files produce one entry per file", () => {
    const files = parsePatch("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-c\n+d\n")
    expect(files).toHaveLength(2)
    expect(files.map((f) => f.hunks.length)).toEqual([1, 1])
  })

  test("git metadata lines tolerated", () => {
    const text = [
      "diff --git a/x.ts b/x.ts",
      "index 111..222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
    ].join("\n")
    const files = parsePatch(text)
    expect(files).toHaveLength(1)
    expect(files[0].hunks).toHaveLength(1)
    expect(files[0].hunks[0].lines.filter((l) => l.kind === -1)).toEqual([{ kind: -1, text: "b" }])
  })

  test("No newline marker skipped", () => {
    const files = parsePatch("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n")
    expect(files[0].hunks[0].lines).toEqual([
      { kind: -1, text: "a" },
      { kind: 1, text: "b" },
    ])
  })

  test("CRLF patch text tolerated", () => {
    const files = parsePatch("@@ -1 +1 @@\r\n-a\r\n+b\r\n")
    expect(files[0].hunks[0].lines).toEqual([
      { kind: -1, text: "a" },
      { kind: 1, text: "b" },
    ])
  })

  test("new file detection via /dev/null old side", () => {
    const files = parsePatch("--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n")
    expect(files[0].isNew).toBe(true)
  })

  test("no hunks yields empty list", () => {
    expect(parsePatch("--- a/x\n+++ b/x\n")).toEqual([])
    expect(parsePatch("")).toEqual([])
  })
})

describe("applyPatch", () => {
  test("modify line with context", () => {
    const r = applyPatch("a\nb\nc\nd", parsePatch("@@ -1,4 +1,4 @@\n a\n-b\n+x\n c\n d\n")[0])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toBe("a\nx\nc\nd")
    expect(r.applied).toEqual([{ index: 0, line: 2, delta: 0 }])
  })

  test("round-trip: unified diff text applies back to original", () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n"
    const newText = oldText.replace("l3", "L3").replace("l17", "L17")
    const files = parsePatch(
      "--- old\n+++ new\n@@ -1,6 +1,6 @@\n l1\n l2\n-l3\n+L3\n l4\n l5\n l6\n@@ -14,7 +14,7 @@\n l14\n l15\n l16\n-l17\n+L17\n l18\n l19\n l20\n",
    )
    const r = applyPatch(oldText, files[0])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe(newText)
  })

  test("fuzz: stale head context trimmed (up to PATCH_FUZZ_LINES)", () => {
    const r = applyPatch("aa\nbb\ncc\ndd\nee", parsePatch("@@ -1,4 +1,4 @@\n aa\n zz\n-cc\n+CC\n dd\n")[0])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toBe("aa\nbb\nCC\ndd\nee")
    expect(r.applied[0].line).toBe(3)
  })

  test("fuzz tolerance limit: mismatched del line fails", () => {
    const r = applyPatch("aa\nbb\ncc\ndd\nee", parsePatch("@@ -1,3 +1,3 @@\n aa\n bb\n-YY\n+yy\n")[0])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hunkIndex).toBe(0)
    expect(r.error).toContain("未匹配")
  })

  test("pure add hunk positioned by header line number", () => {
    const r = applyPatch("a\nb\nc", parsePatch("@@ -2,1 +2,2 @@\n b\n+NEW\n")[0])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toBe("a\nb\nNEW\nc")
    expect(r.applied[0].line).toBe(3)
    expect(r.applied[0].delta).toBe(1)
  })

  test("pure add with context verifies surrounding lines", () => {
    const ok = applyPatch("a\nb\nc", parsePatch("@@ -2,1 +2,2 @@\n b\n+NEW\n c\n")[0])
    expect(ok.ok).toBe(true)
    // 上下文完全对不上：裁剪到只剩零行上下文仍无法定位 → 失败（宽松档命中时会带 fuzzy 标注）
    const bad = applyPatch("a\nX\nc", parsePatch("@@ -2,1 +2,2 @@\n zz\n+NEW\n yy\n")[0])
    expect(bad.ok).toBe(false)
  })

  test("multi-hunk with offset accumulation", () => {
    const text = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n"
    const patch = parsePatch("@@ -3,1 +3,0 @@\n-l3\n@@ -7,1 +6,2 @@\n l7\n+AFTER\n")[0]
    const r = applyPatch(text, patch)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toBe("l1\nl2\nl4\nl5\nl6\nl7\nAFTER\nl8\nl9\nl10\n")
    expect(r.applied.map((a) => a.delta)).toEqual([-1, 1])
  })

  test("new file creation from /dev/null patch", () => {
    const patch = parsePatch("--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n")[0]
    const r = applyPatch("", patch)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toBe("a\nb\n")
  })

  test("all-delete patch empties file", () => {
    const patch = parsePatch("@@ -1,3 +0,0 @@\n-a\n-b\n-c\n")[0]
    const r = applyPatch("a\nb\nc\n", patch)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toBe("")
  })

  test("trailing newline state preserved", () => {
    const noNL = applyPatch("a\nb\nc", parsePatch("@@ -2,1 +2,1 @@\n-b\n+B\n")[0])
    expect(noNL.ok && noNL.result).toBe("a\nB\nc")
    const withNL = applyPatch("a\nb\nc\n", parsePatch("@@ -2,1 +2,1 @@\n-b\n+B\n")[0])
    expect(withNL.ok && withNL.result).toBe("a\nB\nc\n")
  })

  test("interleaved add before del keeps written order", () => {
    const r = applyPatch("a\nb\nc", parsePatch("@@ -1,3 +1,4 @@\n+X\n a\n-b\n c\n")[0])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toBe("X\na\nc")
  })

  test("PATCH_FUZZ_LINES export is 3", () => {
    expect(PATCH_FUZZ_LINES).toBe(3)
  })
})

describe("applyPatch tolerant matching", () => {
  test("empty line inside hunk = empty context line (blank body allowed)", () => {
    const file = ["l1", "", "l3"].join("\n")
    const r = applyPatch(file, parsePatch("@@ -1,3 +1,4 @@\n l1\n\n+l2\n l3\n")[0])
    expect(r.ok && r.result).toBe("l1\n\nl2\nl3")
  })

  test("trailing blank lines after hunk body are not file content", () => {
    const r = applyPatch("a\nb\nc", parsePatch("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\n\n")[0])
    expect(r.ok && r.result).toBe("a\nB\nc")
  })

  test("pure-add lines interleaved in context land in place (not appended)", () => {
    const file = ["L1", "L2", "L3"].join("\n")
    const r = applyPatch(file, parsePatch("@@ -1,3 +1,4 @@\n L1\n L2\n+INSERT\n L3\n")[0])
    expect(r.ok && r.result).toBe("L1\nL2\nINSERT\nL3")
  })

  test("duplicate blocks: declared line number picks the nearest occurrence", () => {
    const file = ["header", "  dup();", "  end();", "mid", "mid2", "  dup();", "  end();", "tail"].join("\n")
    const r = applyPatch(file, parsePatch("@@ -6,3 +6,3 @@\n   dup();\n-  end();\n+  end(2);\n")[0])
    expect(r.ok && r.result).toBe(
      ["header", "  dup();", "  end();", "mid", "mid2", "  dup();", "  end(2);", "tail"].join("\n"),
    )
  })

  test("duplicate blocks without usable line number fail as ambiguity (never guess)", () => {
    const file = ["header", "  dup();", "  end();", "mid", "mid2", "  dup();", "  end();", "tail"].join("\n")
    const r = applyPatch(file, parsePatch("@@ -999,3 +999,3 @@\n   dup();\n-  end();\n+  end(2);\n")[0])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("候选")
    expect(r.diagnosis).toContain("上下文行")
  })

  test("pure add without context validates declared line number", () => {
    const bad = applyPatch("a\nb\nc", parsePatch("@@ -10 +11 @@\n+new\n")[0])
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain("只有 3 行")
    const ok = applyPatch("a\nb\nc", parsePatch("@@ -3 +3 @@\n+new\n")[0])
    expect(ok.ok && ok.result).toBe("a\nb\nnew\nc")
  })

  test("whitespace-tolerant match keeps the file's own lines and is annotated", () => {
    const r = applyPatch(["a", "  b", "c"].join("\n"), parsePatch("@@ -1,3 +1,3 @@\n a\n b\n-c\n+C\n")[0])
    expect(r.ok && r.result).toBe("a\n  b\nC")
    expect(r.ok && r.applied[0].fuzzy).toContain("忽略行首尾空白")
  })

  test("missing middle context recovered by head/tail trim, annotated", () => {
    const r = applyPatch(["1", "2", "3", "4", "5", "6"].join("\n"), parsePatch("@@ -1,4 +1,4 @@\n 1\n 2\n-4\n+4x\n 5\n")[0])
    expect(r.ok && r.result).toBe("1\n2\n3\n4x\n5\n6")
    expect(r.ok && r.applied[0].fuzzy).toContain("已裁剪")
  })

  test("dels-only fallback when context beyond trim cap is wrong", () => {
    const file = ["  alpha();", "  beta();", "  gamma();"].join("\n")
    const r = applyPatch(file, parsePatch("@@ -2,5 +2,5 @@\n w1\n w2\n w3\n w4\n-  beta();\n+  beta(2);\n")[0])
    expect(r.ok && r.result).toBe(["  alpha();", "  beta(2);", "  gamma();"].join("\n"))
    expect(r.ok && r.applied[0].fuzzy).toContain("仅按删除行")
  })

  test("failure diagnosis: nearest positions with line numbers and read advice", () => {
    const near = applyPatch(
      ["const a = 1", "  return total;", "const b = 2"].join("\n"),
      parsePatch("@@ -1,3 +1,3 @@\n const a = 1\n-  return totals;\n+  return total();\n const b = 2\n")[0],
    )
    expect(near.ok).toBe(false)
    if (near.ok) return
    expect(near.diagnosis).toContain("第 2 行")
    expect(near.diagnosis).toContain("最相近")
    expect(near.diagnosis).toContain("建议 read")
    const none = applyPatch(
      ["const a = 1", "const b = 2"].join("\n"),
      parsePatch("@@ -5,2 +5,2 @@\n   return total;\n-  sum(a);\n+  sum(b);\n")[0],
    )
    expect(none.ok).toBe(false)
    if (none.ok) return
    expect(none.diagnosis).toContain("没有内容相近的行")
  })

  test("tolerance constants", () => {
    expect(PATCH_FUZZ_LINES).toBe(3)
    expect(PATCH_ANCHOR_TOLERANCE).toBe(30)
  })
})
