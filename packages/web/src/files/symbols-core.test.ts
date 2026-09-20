import { describe, expect, test } from "bun:test"
import { extractSymbols, findDefinitions, flattenSymbols, searchSymbols, symbolsSupported, SYMBOL_LANGUAGES } from "./symbols-core"

/** `全限定名:种类` 列表——断言里只关心「有哪些符号、什么种类」，不写行号（行号另有专门用例）。 */
const syms = (text: string, lang: string): string[] => flattenSymbols(extractSymbols(text, lang)).map((s) => `${s.qualified}:${s.kind}`)

describe("符号提取 · 语言覆盖与开关", () => {
  test("支持的语言都在表里，内置语言服务覆盖的语言不在（避免符号列表出现两份）", () => {
    for (const lang of ["python", "go", "rust", "java", "kotlin", "scala", "c", "cpp", "csharp", "php", "ruby", "swift", "dart", "lua", "shell", "powershell", "sql", "yaml", "ini", "markdown", "graphql", "protobuf", "hcl", "dockerfile", "makefile", "cmake"]) {
      expect(symbolsSupported(lang)).toBe(true)
    }
    // 内置语言服务（本地 worker）负责的语言不重复注册，否则符号列表会出两份
    for (const lang of ["typescript", "javascript", "json", "css", "scss", "less", "html", "plaintext", ""]) {
      expect(symbolsSupported(lang)).toBe(false)
    }
    expect(SYMBOL_LANGUAGES).toContain("python")
  })

  test("不支持的语言返回空（不抛错、不猜）", () => {
    expect(extractSymbols("a { color: red }", "css")).toEqual([])
    expect(extractSymbols("class A {}", "typescript")).toEqual([])
    expect(extractSymbols("", "python")).toEqual([])
  })
})

describe("符号提取 · 正则字面量不污染分层", () => {
  test("Ruby 正则里的花括号不参与 brace/插值统计", () => {
    const s = 'RX = /[^;{}]*\\{/\n\ndef top\nend\n\nclass Box\n  def method\n  end\nend\n'
    expect(syms(s, "ruby")).toEqual(["RX:constant", "top:function", "Box:class", "Box.method:method"])
  })
})

describe("符号提取 · Python", () => {
  const src = `# 注释里的 def fake(): pass
"""docstring
class Ghost:
"""

MAX_RETRY = 3


class Client:
    """客户端"""

    def __init__(self, host: str):
        self.host = host

    async def fetch(self, url):
        return url


def helper(a, b):
    return a + b
`

  test("类 / 方法 / 函数 / 模块常量，注释与 docstring 里的伪定义不误报", () => {
    expect(syms(src, "python")).toEqual([
      "MAX_RETRY:constant",
      "Client:class",
      "Client.__init__:constructor",
      "Client.fetch:method",
      "helper:function",
    ])
  })

  test("字符串里的伪定义不成符号，真定义照常", () => {
    expect(syms('s = "class Fake:"\ndef real(): pass\n', "python")).toEqual(["real:function"])
  })

  test("装饰器行不吞定义", () => {
    expect(syms("@decorator\ndef wrapped():\n    pass\n", "python")).toEqual(["wrapped:function"])
  })
})

describe("符号提取 · Go", () => {
  test("函数、方法（带接收者）、struct / interface 类型", () => {
    const src = `package main

type Server struct {
	Name string
}

type Handler interface {
	Serve()
}

func New() *Server { return nil }

func (s *Server) Start(addr string) error {
	return nil
}
`
    expect(syms(src, "go")).toEqual(["Server:struct", "Handler:interface", "New:function", "Start:method"])
  })
})

describe("符号提取 · Rust", () => {
  test("impl 内的方法成为方法，trait 内签名同理", () => {
    const src = `pub const MAX: usize = 8;

pub struct Point {
    pub x: f64,
}

pub trait Draw {
    fn draw(&self);
}

impl Point {
    pub fn new(x: f64) -> Self {
        Point { x }
    }

    fn scale(&self, k: f64) -> f64 {
        self.x * k
    }
}
`
    expect(syms(src, "rust")).toEqual([
      "MAX:constant",
      "Point:struct",
      "Draw:trait",
      "Draw.draw:method",
      "Point:class",
      "Point.new:method",
      "Point.scale:method",
    ])
  })
})

describe("符号提取 · Java / Kotlin / Scala", () => {
  const java = `package com.example;

public class Repo {
    private int count;

    public Repo(int count) {
        this.count = count;
    }

    public int add(int a, int b) {
        return a + b;
    }

    @Override
    public String toString() {
        return "Repo";
    }
}
`

  test("类 / 字段 / 构造器（与类同名即构造器）/ 方法，注解行不干扰", () => {
    expect(syms(java, "java")).toEqual(["Repo:class", "Repo.count:field", "Repo.Repo:constructor", "Repo.add:method", "Repo.toString:method"])
  })

  test("控制语句不被当成方法定义", () => {
    const src = `class A {
    void run(boolean flag) {
        if (flag) {
            return;
        }
        for (int i = 0; i < 3; i++) {
        }
    }
}
`
    expect(syms(src, "java")).toEqual(["A:class", "A.run:method"])
  })

  test("花括号口径分层：缩进被打乱的同级方法仍归到类下（不靠缩进猜）", () => {
    const src = `class A {
public void one() {
}
        public void two() {
}
}
`
    expect(syms(src, "java")).toEqual(["A:class", "A.one:method", "A.two:method"])
  })

  test("Kotlin：fun / class / val", () => {
    const src = `data class User(val id: Int)

interface Repo {
    fun find(id: Int): User
}

class Impl : Repo {
    override fun find(id: Int): User = TODO()
}
`
    expect(syms(src, "kotlin")).toEqual(["User:class", "Repo:interface", "Repo.find:method", "Impl:class", "Impl.find:method"])
  })

  test("Scala：def / class / object / trait", () => {
    const src = `trait Greeter {
  def greet(name: String): String
}

object Main extends Greeter {
  def greet(name: String): String = s"hi $name"
}
`
    expect(syms(src, "scala")).toEqual(["Greeter:trait", "Greeter.greet:method", "Main:object", "Main.greet:method"])
  })
})

describe("符号提取 · C / C++ / C#", () => {
  const c = `#include <stdio.h>

#define MAX_LEN 256

struct Node {
    int value;
};

enum Color { RED, GREEN };

static int counter;

int add(int a, int b)
{
    if (a > b) {
        return a;
    }
    return a + b;
}

void log_all(void) {
    for (int i = 0; i < 10; i++) { }
}
`

  test("两类函数定义风格（K&R 与 Allman）、宏、结构体/枚举、顶层变量", () => {
    expect(syms(c, "c")).toEqual(["MAX_LEN:macro", "Node:struct", "Color:enum", "counter:variable", "add:function", "log_all:function"])
  })

  test("函数体内的局部变量不是符号（只收顶层变量）", () => {
    const src = `int global_count;

int compute(void) {
    int local = 1;
    return local;
}
`
    expect(syms(src, "c")).toEqual(["global_count:variable", "compute:function"])
  })

  test("C++：namespace / class / 构造器 / 单行函数体", () => {
    const src = `namespace app {

class Widget : public Base {
public:
    Widget() {}
    void paint() {}
};

int helper(int x) { return x; }

}
`
    expect(syms(src, "cpp")).toEqual(["app:namespace", "app.Widget:class", "app.Widget.Widget:constructor", "app.Widget.paint:method", "app.helper:function"])
  })

  test("C#：class / 属性（带 get/set）/ 方法 / 字段", () => {
    const src = `namespace Demo {
    public class Account {
        private int _balance;

        public int Balance { get; set; }

        public void Deposit(int amount) {
            _balance += amount;
        }
    }
}
`
    expect(syms(src, "csharp")).toEqual(["Demo:namespace", "Demo.Account:class", "Demo.Account._balance:field", "Demo.Account.Balance:property", "Demo.Account.Deposit:method"])
  })
})

describe("符号提取 · 脚本语言", () => {
  test("PHP：命名空间 / 类 / 常量 / 属性 / 方法", () => {
    const src = `<?php
namespace App;

class User
{
    public const ROLE = 'admin';
    private string $name;

    public function __construct(string $name)
    {
        $this->name = $name;
    }

    public function greet(): string
    {
        return "hi";
    }
}
`
    expect(syms(src, "php")).toEqual(["App:namespace", "User:class", "User.ROLE:constant", "User.name:property", "User.__construct:constructor", "User.greet:method"])
  })

  test("Ruby：缩进口径的类与方法，类内常量不误报为模块常量", () => {
    const src = `# 注释
require "json"

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
    expect(syms(src, "ruby")).toEqual(["Account:class", "Account.initialize:constructor", "Account.deposit:method", "Util:class", "Util.format:method"])
  })

  test("Shell：两种函数写法，字符串里的内容不干扰", () => {
    const src = `#!/bin/bash
set -e

log() {
  echo "$1"
}

function deploy() {
  echo "deploy"
}
`
    expect(syms(src, "shell")).toEqual(["log:function", "deploy:function"])
  })

  test("Swift：class / struct / func / let", () => {
    const src = `struct Size {
    let width: Double
}

class View {
    func layout() {
        print("layout")
    }
}
`
    expect(syms(src, "swift")).toEqual(["Size:struct", "Size.width:field", "View:class", "View.layout:method"])
  })

  test("Lua：function 两种写法", () => {
    const src = `local M = {}

function M.setup(opts)
end

M.run = function()
end
`
    expect(syms(src, "lua")).toEqual(["M:variable", "M.setup:function", "M.run:function"])
  })
})

describe("符号提取 · 数据/配置/标记语言", () => {
  test("SQL：表 / 视图 / 函数", () => {
    const src = `-- schema
CREATE TABLE users (
  id INT PRIMARY KEY,
  name TEXT
);

CREATE OR REPLACE VIEW active_users AS SELECT * FROM users;

CREATE FUNCTION add_one(x INT) RETURNS INT AS $$ SELECT x + 1; $$ LANGUAGE sql;
`
    expect(syms(src, "sql")).toEqual(["users:table", "active_users:view", "add_one:function"])
  })

  test("YAML：只留前两层（更深的键是数据不是结构）", () => {
    const src = `# config
name: demo
version: 1
services:
  web:
    image: nginx
    ports:
      - "80:80"
  db:
    image: mysql
`
    expect(syms(src, "yaml")).toEqual(["name:key", "version:key", "services:key", "services.web:key", "services.db:key"])
  })

  test("INI/TOML：节归属", () => {
    const src = `# comment
[core]
editor = vim

[remote "origin"]
url = git@example.com
`
    expect(syms(src, "ini")).toEqual(['core:section', 'core.editor:key', 'remote "origin":section', 'remote "origin".url:key'])
  })

  test("Markdown：标题按级别成树", () => {
    const src = `# Title

intro

## Section A

text

### Deep

## Section B
`
    expect(syms(src, "markdown")).toEqual(["Title:heading", "Title.Section A:heading", "Title.Section A.Deep:heading", "Title.Section B:heading"])
  })

  test("GraphQL / Protobuf / HCL：容器内字段归到容器下", () => {
    expect(syms('type User {\n  id: ID!\n  name: String\n}\n', "graphql")).toEqual(["User:type", "User.id:field", "User.name:field"])
    expect(syms('message Ping {\n  string id = 1;\n}\n\nservice Echo {\n  rpc Send(Ping) returns (Ping);\n}\n', "protobuf")).toEqual(["Ping:class", "Ping.id:field", "Echo:interface", "Echo.Send:method"])
    expect(syms('resource "aws_instance" "web" {\n  ami = "x"\n}\n\nvariable "region" {\n  default = "us"\n}\n', "hcl")).toEqual(["aws_instance.web:resource", "region:variable"])
  })
})

describe("符号提取 · 位置与范围", () => {
  test("行号列号 0 基且与原文对齐（CRLF 同样成立）", () => {
    const tree = extractSymbols("class A:\r\n    def m(self):\r\n        pass\r\n", "python")
    expect(tree.map((s) => ({ name: s.name, line: s.line, column: s.column }))).toEqual([{ name: "A", line: 0, column: 6 }])
    const method = tree[0]!.children[0]!
    expect({ name: method.name, line: method.line, column: method.column }).toEqual({ name: "m", line: 1, column: 8 })
    expect(tree[0]!.endLine).toBe(2)
  })

  test("结束行延续到下一个同级定义之前，子级不越过父范围", () => {
    const src = `class A:
    def one(self):
        pass

    def two(self):
        pass


class B:
    pass
`
    const tree = extractSymbols(src, "python")
    expect(tree.map((s) => [s.name, s.line, s.endLine])).toEqual([["A", 0, 5], ["B", 8, 9]])
    expect(tree[0]!.children.map((s) => [s.name, s.endLine])).toEqual([["one", 2], ["two", 5]])
  })

  test("同名多定义全部收集（文件内跳转的候选来源）", () => {
    const src = `class A:
    def run(self):
        pass


class B:
    def run(self):
        pass
`
    expect(findDefinitions(extractSymbols(src, "python"), "run").map((s) => s.line)).toEqual([1, 6])
    expect(findDefinitions(extractSymbols(src, "python"), "missing")).toEqual([])
  })
})

describe("符号搜索（面板用）", () => {
  const src = `class PaymentService:
    def charge(self):
        pass

    def refund(self):
        pass


def settle():
    pass
`
  const flat = flattenSymbols(extractSymbols(src, "python"))

  test("空查询按出现顺序全列", () => {
    expect(searchSymbols(flat, "").map((s) => s.qualified)).toEqual(["PaymentService", "PaymentService.charge", "PaymentService.refund", "settle"])
  })

  test("模糊匹配：缩写与全限定名都能命中，名字前缀优先", () => {
    expect(searchSymbols(flat, "refund").map((s) => s.name)).toEqual(["refund"])
    expect(searchSymbols(flat, "pscharge").map((s) => s.name)).toEqual(["charge"])
    expect(searchSymbols(flat, "settle").map((s) => s.name)).toEqual(["settle"])
    expect(searchSymbols(flat, "zzz")).toEqual([])
  })

  test("层级深度随嵌套递增（面板据此缩进显示）", () => {
    expect(flat.map((s) => s.depth)).toEqual([0, 1, 1, 0])
  })
})
