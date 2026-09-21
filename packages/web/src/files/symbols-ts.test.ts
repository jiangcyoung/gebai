/**
 * tree-sitter 符号提取（`symbols-ts.ts` + `symbols-ts-rules.ts`）的测试。
 *
 * 语法 wasm 从 `tree-sitter-wasms`（devDependency）读盘注入——**与浏览器同一条代码路径**
 * （浏览器只是把同一个字节加载器换成 HTTP 取 `/vendor/tree-sitter/lang/…`）。
 * 期望值不是照抄规则表，而是在真实语法树上跑出来的结果（覆盖：嵌套归属、方法/构造器判定、
 * 文件层与函数体内的区分、字符串与注释不干扰）。
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Parser, Language } from "web-tree-sitter"
import { flattenSymbols, type Sym } from "./symbols-core"
import { extractWithRuntime, hasTsSupport, parserFor, setGrammarLoader, type GrammarLoader, type TsRuntime } from "./symbols-ts"
import { TS_LANGUAGES } from "./symbols-ts-rules"

const WASM_DIR = join(import.meta.dirname, "..", "..", "node_modules", "tree-sitter-wasms", "out")
const RUNTIME_WASM = join(import.meta.dirname, "..", "..", "node_modules", "web-tree-sitter", "tree-sitter.wasm")
// 浏览器里这一步由 symbols-ts.ts 的 loadTsRuntime 完成（vendor 目录取核心 wasm）；测试里直接初始化
await Parser.init({ locateFile: () => RUNTIME_WASM })
const runtime = { Parser, Language } as unknown as TsRuntime

/** 与浏览器同源的语法加载（只把 HTTP 换成读盘）——多处用例要重复安装，抽成一个常量。 */
const diskLoader: GrammarLoader = async (file) => {
  const f = Bun.file(join(WASM_DIR, file))
  return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null
}
setGrammarLoader(diskLoader)

/** `全限定名:种类` 列表（行号另有专门用例）。 */
const syms = async (src: string, lang: string): Promise<string[] | null> => {
  const tree = await extractWithRuntime(runtime, src, lang)
  return tree ? flattenSymbols(tree).map((s) => `${s.qualified}:${s.kind}`) : null
}

describe("tree-sitter 符号提取 · 语言覆盖", () => {
  test("15 种语言都有映射与语法文件，且与 SDK 的语言表一致", async () => {
    const { TREE_SITTER_GRAMMAR } = await import("@gebai/sdk")
    expect(Object.keys(TS_LANGUAGES).sort()).toEqual(Object.keys(TREE_SITTER_GRAMMAR).sort())
    for (const [lang, spec] of Object.entries(TS_LANGUAGES)) {
      expect(spec.grammar).toBe(TREE_SITTER_GRAMMAR[lang]!)
      expect(hasTsSupport(lang)).toBe(true)
    }
  })

  test("没有映射的语言返回 null（调用方据此回退词法规则）", async () => {
    expect(await extractWithRuntime(runtime, "def f(): pass", "haskell")).toBeNull()
    expect(await extractWithRuntime(runtime, "class A {}", "typescript")).toBeNull()
  })

  test("语法文件取不到时返回 null（不是空数组——空数组会被当成「这文件真没符号」）", async () => {
    setGrammarLoader(async () => null)
    try {
      expect(await extractWithRuntime(runtime, "def f(): pass", "python")).toBeNull()
    } finally {
      setGrammarLoader(diskLoader)
    }
  })

  test("语法加载失败不固化：网络类失败本次当无语法树、下一次重试", async () => {
    let calls = 0
    setGrammarLoader(async (file) => {
      calls += 1
      if (calls === 1) throw new Error("网络抖动")
      return diskLoader(file)
    })
    try {
      expect(await parserFor(runtime, "python")).toBeNull()
      expect(await parserFor(runtime, "python")).not.toBeNull()
      expect(calls).toBe(2)
    } finally {
      setGrammarLoader(diskLoader)
    }
  })

  test("确定拿不到（404 / null）则记住：不反复发请求", async () => {
    let calls = 0
    setGrammarLoader(async () => {
      calls += 1
      return null
    })
    try {
      expect(await parserFor(runtime, "python")).toBeNull()
      expect(await parserFor(runtime, "python")).toBeNull()
      expect(calls).toBe(1)
    } finally {
      setGrammarLoader(diskLoader)
    }
  })
})

describe("tree-sitter 符号提取 · 各语言", () => {
  test("Python：类 / 构造器 / 方法 / 模块常量与变量", async () => {
    const src = `import os

MAX_RETRY = 3
_cache = {}


class Client:
    """客户端"""

    def __init__(self, host):
        self.host = host

    async def fetch(self, url):
        return url


def helper(a):
    return a
`
    expect(await syms(src, "python")).toEqual(["MAX_RETRY:constant", "_cache:variable", "Client:class", "Client.__init__:constructor", "Client.fetch:method", "helper:function"])
  })

  test("Go：常量 / 变量 / struct / interface / 方法（接收者形式）", async () => {
    const src = `package demo

const maxRetry = 3

var cache = map[string]int{}

type Server struct {
	Name string
}

type Handler interface {
	Serve()
}

func New() *Server { return nil }

func (s *Server) Start(addr string) error { return nil }
`
    expect(await syms(src, "go")).toEqual(["maxRetry:constant", "cache:variable", "Server:struct", "Handler:interface", "New:function", "Start:method"])
  })

  test("Rust：impl 内是方法、trait 内签名也是方法、mod 内是函数（mod 不算类性质容器）", async () => {
    const src = `pub const MAX: usize = 8;

pub struct Point { pub x: f64 }

pub trait Draw { fn draw(&self); }

impl Point {
    pub fn new(x: f64) -> Self { Point { x } }
}

unsafe extern "system" fn wnd_proc() {}

mod tests {
    fn helper() {}
}
`
    expect(await syms(src, "rust")).toEqual([
      "MAX:constant",
      "Point:struct",
      "Draw:trait",
      "Draw.draw:method",
      "Point:class",
      "Point.new:method",
      "wnd_proc:function",
      "tests:module",
      "tests.helper:function",
    ])
  })

  test("C：宏 / 结构体 / 枚举 / 暂定定义变量 / 函数；函数体内的局部变量不是符号", async () => {
    const src = `#include <stdio.h>
#define MAX_LEN 256

struct Node { int value; };
enum Color { RED, GREEN };

static int counter;
const char *NAME = "x";

int add(int a, int b) {
    int local = a;
    return a + b;
}
`
    expect(await syms(src, "c")).toEqual(["MAX_LEN:macro", "Node:struct", "Color:enum", "counter:variable", "NAME:variable", "add:function"])
  })

  test("C++：namespace 归属、类内构造器与方法是方法、多行原始字符串之后的定义不丢", async () => {
    const src = `namespace app {

class Widget : public Base {
public:
    Widget() {}
    void paint() {}
};

const char* SCHEMA = R"json({
  "type": "object"
})json";

int helper(int x) { return x; }

}
`
    expect(await syms(src, "cpp")).toEqual([
      "app:namespace",
      "app.Widget:class",
      "app.Widget.Widget:constructor",
      "app.Widget.paint:method",
      "app.SCHEMA:variable",
      "app.helper:function",
    ])
  })

  test("Java：字段名取声明符（不是类型）、注解接口、枚举", async () => {
    const src = `package demo;

public class Repo {
    private int count = 0;
    static final String NAME = "x";

    public Repo(int count) { this.count = count; }

    public int add(int a, int b) { return a + b; }
}

interface Marker {}
enum Color { RED }
`
    expect(await syms(src, "java")).toEqual([
      "Repo:class",
      "Repo.count:field",
      "Repo.NAME:field",
      "Repo.Repo:constructor",
      "Repo.add:method",
      "Marker:interface",
      "Color:enum",
    ])
  })

  test("Kotlin：名字取自标识符子节点（语法无 name 字段）+ 对象与属性", async () => {
    const src = `data class User(val id: Int)

interface Repo { fun find(id: Int): User }

class Impl : Repo {
    override fun find(id: Int): User = TODO()
}

object Single { val x = 1 }
`
    expect(await syms(src, "kotlin")).toEqual(["User:class", "Repo:class", "Repo.find:method", "Impl:class", "Impl.find:method", "Single:object", "Single.x:property"])
  })

  test("Scala：trait / object / def / val（val 名字在 pattern 字段）", async () => {
    const src = `trait Greeter { def greet(name: String): String }

object Main extends Greeter {
  def greet(name: String): String = name
  val version = 1
}
`
    expect(await syms(src, "scala")).toEqual(["Greeter:trait", "Greeter.greet:method", "Main:object", "Main.greet:method", "Main.version:property"])
  })

  test("Swift：class_declaration 按关键字细分 struct / enum / class，协议内声明是方法", async () => {
    const src = `import Foundation

struct Size { let width: Double }

class View {
    func layout() { print("l") }
}

protocol Drawable { func draw() }

enum Direction { case up }
`
    expect(await syms(src, "swift")).toEqual([
      "Size:struct",
      "Size.width:property",
      "View:class",
      "View.layout:method",
      "Drawable:interface",
      "Drawable.draw:method",
      "Direction:enum",
      // 枚举项（`enum_entry`）：一行的多个 case 按「同行只取先命中的」口径记第一个
      "Direction.up:enumMember",
    ])
  })

  test("Dart：类 / 字段 / 构造器（与类同名）/ 方法 / 枚举 / 顶层函数与常量", async () => {
    const src = `class Point {
  final double x;
  Point(this.x);

  double scale(double k) => x * k;
}

enum Color { red }

double area(double r) => 3.14 * r * r;

const maxSide = 10;
`
    expect(await syms(src, "dart")).toEqual(["Point:class", "Point.x:field", "Point.Point:constructor", "Point.scale:method", "Color:enum", "area:function", "maxSide:constant"])
  })

  test("Ruby：类 / 类内常量 / initialize 是构造器 / 方法 / module 也是方法容器", async () => {
    const src = `# comment
class Account
  RATE = 0.05

  def initialize(balance)
    @balance = balance
  end

  def deposit(amount)
    @balance += amount
  end
end

module Util
  def self.format(v)
    v.to_s
  end
end
`
    expect(await syms(src, "ruby")).toEqual(["Account:class", "Account.RATE:constant", "Account.initialize:constructor", "Account.deposit:method", "Util:class", "Util.format:method"])
  })

  test("PHP：命名空间 / 类 / 类内与顶层常量 / 构造器 / 方法 / 自由函数", async () => {
    const src = `<?php
namespace App;

const VERSION = '1.0';

class User
{
    public const ROLE = 'admin';

    public function __construct(string $name) { $this->name = $name; }

    public function greet(): string { return "hi"; }
}

function helper() {}
`
    expect(await syms(src, "php")).toEqual([
      "App:namespace",
      // const 声明的名字在 const_element 的 `name` 记号上（PHP 语法的标识符节点就叫 name）
      "VERSION:constant",
      "User:class",
      "User.ROLE:constant",
      "User.__construct:constructor",
      "User.greet:method",
      "helper:function",
    ])
  })

  test("Lua：function 语句与 local function", async () => {
    const src = `local M = {}

function M.setup(opts)
end

local function helper()
end
`
    expect(await syms(src, "lua")).toEqual(["M:variable", "M.setup:function", "helper:function"])
  })

  test("Shell：函数定义与文件层变量", async () => {
    const src = `#!/bin/bash
set -e
VERSION=1

log() {
  echo "$1"
}
`
    expect(await syms(src, "shell")).toEqual(["VERSION:variable", "log:function"])
  })

  test("Elixir：defmodule / def / defp（宏调用形态）", async () => {
    const src = `defmodule Demo.Worker do
  def start(arg) do
    arg
  end

  defp helper(x), do: x
end
`
    expect(await syms(src, "elixir")).toEqual(["Demo.Worker:module", "Demo.Worker.start:function", "Demo.Worker.helper:function"])
  })
})

describe("tree-sitter 符号提取 · 规则修正回归", () => {
  test("Ruby：小写赋值是变量、大写常量仍是常量，方法归属类", async () => {
    const src = `MAX = 3
count = 0
@ivar = 1

def top; end

class Account
  def initialize; end
  def self.helper; end
end
`
    // 早期实现把 assignment 一律当常量：`count = 0` 会被报成 constant（种类错）
    expect(await syms(src, "ruby")).toEqual([
      "MAX:constant",
      "count:variable",
      "top:function",
      "Account:class",
      "Account.initialize:constructor",
      "Account.helper:method",
    ])
  })

  test("Dart：字段名不含初始化器、getter 也算方法", async () => {
    const src = `class Point {
  final int x;
  int y = 0;
  Point(this.x);
  int get doubleX => x * 2;
  void move(int dx) {}
}
`
    const flat = (await extractWithRuntime(runtime, src, "dart"))!
    const names = flattenSymbols(flat).map((s) => s.name)
    // 早期实现取 initialized_identifier 的整段文本：名字会变成 `y = 0`
    expect(names).toContain("y")
    expect(names).not.toContain("y = 0")
    expect(await syms(src, "dart")).toEqual([
      "Point:class",
      "Point.x:field",
      "Point.y:field",
      "Point.Point:constructor",
      "Point.doubleX:method",
      "Point.move:method",
    ])
  })

  test("Kotlin / Scala / Swift：函数体内的局部变量不冒充文件符号（类字段与顶层属性保留）", async () => {
    const kotlin = `val TOP = 1
class Foo {
  val field = 1
  fun bar() { val local = 2 }
}
fun top() { val inner = 3 }
`
    expect(await syms(kotlin, "kotlin")).toEqual(["TOP:property", "Foo:class", "Foo.field:property", "Foo.bar:method", "top:function"])

    const scala = `object Main {
  val version = 1
  def run(): Unit = {
    val local = 2
  }
}
`
    expect(await syms(scala, "scala")).toEqual(["Main:object", "Main.version:property", "Main.run:method"])

    const swift = `struct S { var field = 1 }
func top() {
  var inner = 2
  let k = 3
}
`
    expect(await syms(swift, "swift")).toEqual(["S:struct", "S.field:property", "top:function"])
  })

  test("Go：类型别名（type Alias = int）与普通类型定义都算类型", async () => {
    const src = `package main

type Point struct { X int }
type Alias = int
type Op interface { Run() }
`
    expect(await syms(src, "go")).toEqual(["Point:struct", "Alias:type", "Op:interface"])
  })

  test("C / C++：typedef 的名字取自声明符（不是整段结构体文本）", async () => {
    const src = `typedef struct { int a; } Point;
typedef unsigned long Size;
`
    expect(await syms(src, "c")).toEqual(["Point:type", "Size:type"])
    expect(await syms(src, "cpp")).toEqual(["Point:type", "Size:type"])
  })

  test("Go：函数体内的局部类型声明不是文件符号", async () => {
    const src = `package main

func f() {
  type Local struct{ X int }
  _ = Local{}
}
`
    expect(await syms(src, "go")).toEqual(["f:function"])
  })
})

describe("tree-sitter 符号提取 · 行号与范围", () => {
  test("行号 0 基、与原文严格对齐；结束行取语法树自身的节点范围", async () => {
    const src = "class A:\n    def m(self):\n        pass\n\n\ndef f():\n    pass\n"
    const tree = (await extractWithRuntime(runtime, src, "python"))!
    const cls = tree[0]!
    expect({ name: cls.name, line: cls.line, column: cls.column }).toEqual({ name: "A", line: 0, column: 6 })
    // 结束行是语法树给出的真实结尾（不受空行/缩进启发式影响）
    expect({ start: cls.line, end: cls.endLine }).toEqual({ start: 0, end: 2 })
    const fn = tree[1]!
    expect({ name: fn.name, line: fn.line, endLine: fn.endLine }).toEqual({ name: "f", line: 5, endLine: 6 })
  })

  test("CRLF 文本同样对齐", async () => {
    const tree = (await extractWithRuntime(runtime, "class A:\r\n    def m(self):\r\n        pass\r\n", "python"))!
    expect(tree[0]!.children[0]!.line).toBe(1)
  })
})

describe("tree-sitter 符号提取 · 真实文件", () => {
  const repo = join(import.meta.dirname, "..", "..", "..", "..")

  test("Python 真实文件：抽到函数与常量，函数体内的局部赋值不冒充文件符号", async () => {
    const src = await Bun.file(join(repo, "keqing/python/driver.py")).text()
    const tree = (await extractWithRuntime(runtime, src, "python"))!
    const names = flattenSymbols(tree).map((s) => s.name)
    expect(names).toContain("set_current_ctx")
    expect(names).toContain("ctx_resolve")
    expect(names.length).toBeGreaterThan(15)
    expect(tree.map((s: Sym) => s.name)).toContain("main")
  })

  test("Go 真实文件：包级 const / var 与函数都在（词法规则在这个文件上漏了 23 个常量变量）", async () => {
    const src = await Bun.file(join(repo, "keqing/go/disk/clean.go")).text()
    const flat = flattenSymbols((await extractWithRuntime(runtime, src, "go"))!)
    const kinds = new Set(flat.map((s) => s.kind))
    expect(kinds.has("constant")).toBe(true)
    expect(kinds.has("variable")).toBe(true)
    expect(flat.length).toBeGreaterThan(50)
  })

  test("C++ 真实文件：结构体 / 函数 / 顶层常量都在（词法规则在这个文件的原始字符串后丢了两个常量）", async () => {
    const src = await Bun.file(join(repo, "keqing/cpp/imgproc/main.cpp")).text()
    const flat = flattenSymbols((await extractWithRuntime(runtime, src, "cpp"))!)
    const kinds = new Set(flat.map((s) => s.kind))
    expect(kinds.has("struct")).toBe(true)
    expect(kinds.has("function")).toBe(true)
    const names = flat.map((s) => s.name)
    // 三个多行原始字符串包裹的顶层常量都应在（词法路径因掩码状态泄漏只找到其中一个）
    expect(names).toContain("SCHEMA_INFO")
    expect(names).toContain("SCHEMA_GRAY")
    expect(names).toContain("SCHEMA_RESIZE")
  })
})
