// torch 子代理的原生聚合后端（Rust 边车常驻进程）。
//
// 职责：对 PyTorch Profiler / Kineto 的 Chrome Trace（`*.pt.trace.json[.gz]`）做**单趟聚合**，
// 产出与 TS 侧 `packages/agents/src/agents/torch/torch-trace.ts` 的 `aggregateTorchTrace`
// **逐字段同构**的 TorchFacts（规模、分组排行、自身耗时、时间线并集/分桶、显存、python 热点、
// 内核归属、前反向拆分、流事件可用性、未采集维度说明）。
//
// 为什么原生：宿主 JS 路径在真实 torch 输出格式（平均 350 字节/事件）下实测约 32 MB/s——
// 瓶颈是流式扫描的逐块字符串拼接与 `text[i]` 单字符索引。原生实现**整文件读入内存**
// （GB 级内存可接受，这是明确取舍：换来 `&[u8]` 字节级扫描，无任何逐块拼接）。
//
// 等价性口径：本文件是 TS 实现的**等价重写**，不是重新设计——
// - 数值一律 f64（TS 侧全部是 JS number），避免整数/浮点口径分叉（ts×1000 换算等保持同序运算）；
// - 采样器用 mulberry32 固定种子（与 `ValueSampler` 同序列），分位数同算法；
// - 区间并集/空闲缝/自适应分桶/Top-K 与 `core/perf/agg.ts` 同语义（含稳定排序的并列顺序）；
// - 字段提取沿用 `torch-events.ts` 的「首个出现」规则与正则语义（含其边界行为）；
// - TS 实现自身的怪异之处（如收尾关闭未闭合帧时的类别键拆分）**一并保留**，等价性优先。
//
// 两条采集路径（结果必须逐字段一致，`packages/agents/src/agents/torch/native-parallel.test.ts` 锁定）：
// - 单趟直接路径（`TORCH_NATIVE_THREADS=1`、小文件自动）：本文件里 `State::process` 直写状态；
// - 分块并行路径（rayon）：块内只做可交换聚合 + 顺序依赖日志，归并阶段按全局序回放。
//   两条路径共用同一批 helper（`close_frame_at`/`pair_flow`/`pair_fwd_bwd`/`upsert_attr`/
//   `Union::add`/`Bins::add`/`Sampler::add`/`apply_mem_instant`），语义只有一份实现。
//
// stdout 只允许协议行（handler 内禁用 println!，排障用 eprintln!）。
use framework::{register_tool, schema, tool_err, tool_ok, Json, ToolDef};
use rayon::prelude::*;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};
use std::fmt::Write as _;
use std::io::{Read, Seek, SeekFrom};
use std::time::Instant;

// ==================================================================================
// 零、聚合内部的快哈希（逐事件查表是热路径，SipHash 的小键固定开销占比过高）
// ==================================================================================

/// FxHash 风格的非加密哈希（8 字节一步的乘法-异或混合）。
/// 只用于聚合内部的临时映射：各表的**输出顺序**都由插入序 Vec 决定，迭代顺序不承载语义。
#[derive(Default)]
struct FastHasher(u64);

const FAST_HASH_K: u64 = 0x51_7c_c1_b7_27_22_0a_95;

impl Hasher for FastHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let mut h = self.0;
        let mut i = 0usize;
        while i + 8 <= bytes.len() {
            let mut w = [0u8; 8];
            w.copy_from_slice(&bytes[i..i + 8]);
            h = (h.rotate_left(5) ^ u64::from_le_bytes(w)).wrapping_mul(FAST_HASH_K);
            i += 8;
        }
        if i < bytes.len() {
            let mut tail = 0u64;
            for &b in &bytes[i..] {
                tail = (tail << 8) | b as u64;
            }
            h = (h.rotate_left(5) ^ tail).wrapping_mul(FAST_HASH_K);
        }
        self.0 = h;
    }

    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }
}

type FastMap<K, V> = HashMap<K, V, BuildHasherDefault<FastHasher>>;
type FastSet<K> = HashSet<K, BuildHasherDefault<FastHasher>>;

// ---------------- 聚合上限（与 TS 侧 TORCH_LIMITS 逐项对齐） ----------------

/// 参与排行的分组上限（超出计入溢出）。
const MAX_GROUPS: usize = 20_000;
/// 排行条数。
const TOP_ROWS: usize = 20;
/// 每分组的耗时采样容量（分位数用）。
const SAMPLES_PER_GROUP: usize = 64;
/// 分配采样器的分组上限。
const SAMPLER_GROUPS: usize = 2_000;
/// 每分组保留的形状/类型样本条数。
const SHAPE_SAMPLES: usize = 3;
/// python 位置热点条数。
const PYTHON_HOTSPOTS: usize = 40;
/// 时间线分桶数（自适应分辨率）+ 输出点数。
const TIMELINE_BINS: usize = 1_000;
const TIMELINE_POINTS: usize = 240;
/// 空闲缝保留上限。
const MAX_GAPS: usize = 20_000;
/// 内存地址追踪上限（超出即只保留累计值，不再逐地址追踪活跃集）。
const MAX_TRACKED_ADDRS: usize = 200_000;
/// 关联表条目上限（correlation 发起上下文、内核↔发起方）。
const MAX_FLOWS: usize = 100_000;
/// 流事件（ph:"s"/"f"）在途配对上限。
const MAX_FLOW_PAIRS: usize = 200_000;
/// fwdbwd 标记（前向/反向）保留上限。
const MAX_FWDBWD_MARKS: usize = 100_000;
/// 每组保留的发起 Python 位置样本条数。
const LAUNCH_SITES: usize = 3;
/// 每微秒的纳秒数（时间线组件按纳秒语义工作，边界换算用）。
const NS_PER_US: f64 = 1_000.0;
/// 单个元素的字节上限（TS 侧为 64 M 字符，防脏文件把内存吃满）。
const MAX_ITEM_BYTES: usize = 64 * 1024 * 1024;
/// 扫描时间预算的默认值（毫秒；0 表示不限）——与 TS 侧 DEFAULT_SCAN_BUDGET_MS 同义。
const DEFAULT_SCAN_BUDGET_MS: f64 = 5.0 * 60_000.0;

// ==================================================================================
// 一、JS 语义小工具（数值/空白/字符串转义/数值文本化）
// ==================================================================================

/// 扫描状态机与 `readValue` 的空白集（与 jsonstream/torch-events 的 `isWs` 一致：只有四种）。
fn is_ws4(c: u8) -> bool {
    c == b' ' || c == b'\n' || c == b'\r' || c == b'\t'
}

/// JS 正则 `\s` 的 ASCII 子集（键与冒号之间的空白；非 ASCII 空白在 trace 中不存在）。
fn is_ws_js(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

/// `Math.max`（NaN 传染，与 Rust 的 f64::max 语义不同）。
fn js_max2(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min`（NaN 传染）。
fn js_min2(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// JS 数值 → 字符串（键拼接用：`${addr}:${ts}`、`String(pid)`）。
/// 不能用 `{}` 的默认格式化：非整数在 JS 里可能是指数形态，会影响键的碰撞行为。
fn js_num_str(v: f64) -> String {
    let mut s = String::new();
    push_js_num(&mut s, v);
    s
}

/// 整数的十进制写入（等价 `write!(out, "{}", v)`，但省去 fmt 机制的开销）。
fn push_int_dec(out: &mut String, mut v: i128) {
    if v == 0 {
        out.push('0');
        return;
    }
    let neg = v < 0;
    let mut buf = [0u8; 48];
    let mut i = buf.len();
    while v != 0 {
        i -= 1;
        buf[i] = b'0' + (v % 10).unsigned_abs() as u8;
        v /= 10;
    }
    if neg {
        i -= 1;
        buf[i] = b'-';
    }
    out.push_str(std::str::from_utf8(&buf[i..]).unwrap_or(""));
}

/// JS 数值写入已有缓冲（`js_num_str` 的复用缓冲版）。
fn push_js_num(out: &mut String, v: f64) {
    if v.is_nan() {
        out.push_str("NaN");
        return;
    }
    if v.is_infinite() {
        out.push_str(if v > 0.0 { "Infinity" } else { "-Infinity" });
        return;
    }
    if v == v.trunc() && v.abs() < 1e21 {
        push_int_dec(out, v as i128);
        return;
    }
    let _ = write!(out, "{}", v);
}

/// JS `Number(text)`（保留其宽松语义：空串为 0、非法为 NaN）。
fn js_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let c0 = t.as_bytes()[0];
    if !(c0.is_ascii_digit() || c0 == b'-' || c0 == b'+' || c0 == b'.') {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(text)` 的字节版：合法 UTF-8 零拷贝；否则按 lossy 文本解析（与原 `v.text(b)` 路径一致）。
fn js_number_bytes(raw: &[u8]) -> f64 {
    match std::str::from_utf8(raw) {
        Ok(s) => js_number(s),
        Err(_) => js_number(&String::from_utf8_lossy(raw)),
    }
}

/// 数值 → Json（非有限值输出 null：TS 侧经 JSON.stringify 后正是 null）。
fn jnum(v: f64) -> Json {
    if v.is_finite() {
        Json::Num(v)
    } else {
        Json::Null
    }
}

fn jstr(s: &str) -> Json {
    Json::Str(s.to_string())
}

/// 朴素子串查找（args 取值用；与 `String.prototype.indexOf` 同语义）。
fn find_sub(h: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || h.len() < needle.len() {
        return None;
    }
    let first = needle[0];
    let n = h.len();
    let mut i = 0;
    while i + needle.len() <= n {
        if h[i] == first && &h[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// 从 `from` 起找第一个等于 `ch` 的字节。
fn find_byte(h: &[u8], from: usize, ch: u8) -> Option<usize> {
    let mut i = from;
    while i < h.len() {
        if h[i] == ch {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// 严格反转义（等价 `JSON.parse('"'+raw+'"')`）：非法转义/裸控制字符返回 None（调用方回落原文）。
fn unescape_strict(raw: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(raw);
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if (c as u32) < 0x20 {
            return None;
        }
        if c != '\\' {
            out.push(c);
            continue;
        }
        let e = it.next()?;
        match e {
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            '/' => out.push('/'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'u' => {
                let mut cp: u32 = 0;
                for _ in 0..4 {
                    let h = it.next()?;
                    cp = cp * 16 + h.to_digit(16)?;
                }
                if (0xD800..=0xDBFF).contains(&cp) {
                    // 代理对：低位缺失即降级为替换字符（JS 会保留孤立代理项，Rust 字符串无法表示）
                    let mut hi_ok = false;
                    if let Some('\\') = it.peek().copied() {
                        let mut probe = it.clone();
                        probe.next();
                        if probe.next() == Some('u') {
                            let mut lo: u32 = 0;
                            let mut ok = true;
                            for _ in 0..4 {
                                match probe.next().and_then(|h| h.to_digit(16)) {
                                    Some(d) => lo = lo * 16 + d,
                                    None => {
                                        ok = false;
                                        break;
                                    }
                                }
                            }
                            if ok && (0xDC00..=0xDFFF).contains(&lo) {
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                it = probe;
                                hi_ok = true;
                            }
                        }
                    }
                    if !hi_ok {
                        out.push('\u{FFFD}');
                        continue;
                    }
                }
                out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
            }
            _ => return None,
        }
    }
    Some(out)
}

/// 与 `torch-events.ts` 的 `unescapeJson` 同语义：无反斜杠直接返回，转义失败回落原文。
fn unescape_json(raw: &[u8]) -> String {
    if !raw.contains(&b'\\') {
        return String::from_utf8_lossy(raw).into_owned();
    }
    match unescape_strict(raw) {
        Some(s) => s,
        None => String::from_utf8_lossy(raw).into_owned(),
    }
}

/// 合法 UTF-8 借用、否则 lossy 拥有（与原 `String::from_utf8_lossy(raw).into_owned()` 等价）。
fn cow_lossy<'a>(raw: &'a [u8]) -> Cow<'a, str> {
    match std::str::from_utf8(raw) {
        Ok(s) => Cow::Borrowed(s),
        Err(_) => Cow::Owned(String::from_utf8_lossy(raw).into_owned()),
    }
}

/// 64 位字中是否存在 0 字节（SWAR 经典位技巧；对真实存在的 0 字节绝不漏报）。
#[inline]
fn has_zero_byte(x: u64) -> bool {
    x.wrapping_sub(0x0101_0101_0101_0101) & !x & 0x8080_8080_8080_8080 != 0
}

/// 一次扫描判定「全 ASCII（必然合法 UTF-8）且不含转义反斜杠」——热路径字符串借用的前置条件。
#[inline]
fn is_plain_ascii(raw: &[u8]) -> bool {
    let n = raw.len();
    let mut i = 0usize;
    while i + 8 <= n {
        let mut w = [0u8; 8];
        w.copy_from_slice(&raw[i..i + 8]);
        let x = u64::from_le_bytes(w);
        if (x & 0x8080_8080_8080_8080) != 0 || has_zero_byte(x ^ 0x5c5c_5c5c_5c5c_5c5c) {
            return false;
        }
        i += 8;
    }
    while i < n {
        let c = raw[i];
        if c >= 0x80 || c == b'\\' {
            return false;
        }
        i += 1;
    }
    true
}

/// `unescape_json` 的借用优先版：无转义且合法 UTF-8 时零拷贝借用 trace 缓冲，
/// 其余情况（含转义 / 非法 UTF-8）走 `unescape_json`——两者结果字符串完全一致。
fn cow_unescaped<'a>(raw: &'a [u8]) -> Cow<'a, str> {
    if is_plain_ascii(raw) {
        // 全 ASCII ⟹ 合法 UTF-8，可直接借用（等价于原来的 lossy 转换结果）
        if let Ok(s) = std::str::from_utf8(raw) {
            return Cow::Borrowed(s);
        }
    } else if !raw.contains(&b'\\') {
        // 非 ASCII 但无转义：仍按原路径尝试借用
        if let Ok(s) = std::str::from_utf8(raw) {
            return Cow::Borrowed(s);
        }
    }
    Cow::Owned(unescape_json(raw))
}

// ==================================================================================
// 二、JSON 值切片读取（`torch-events.ts` 的 readValue 字节版）
// ==================================================================================

struct RawVal {
    /// 原始切片起点（字符串为正引号后一位）。
    rs: usize,
    /// 原始切片终点（不含；字符串为闭引号前一位）。
    re: usize,
    /// 扫描推进位置（字符串为闭引号后一位）。
    end: usize,
    is_string: bool,
}

impl RawVal {
    fn slice<'a>(&self, b: &'a [u8]) -> &'a [u8] {
        let n = b.len();
        let s = self.rs.min(n);
        let e = self.re.min(n);
        if e <= s {
            &b[s..s]
        } else {
            &b[s..e]
        }
    }

    fn text(&self, b: &[u8]) -> String {
        String::from_utf8_lossy(self.slice(b)).into_owned()
    }

    /// `isString ? unescapeJson(raw) : raw`（键与字符串值用）。
    fn value_text(&self, b: &[u8]) -> String {
        if self.is_string {
            unescape_json(self.slice(b))
        } else {
            self.text(b)
        }
    }

    /// `value_text` 的借用优先版（逐事件热路径：常见形态零分配）。
    fn cow_value_text<'a>(&self, b: &'a [u8]) -> Cow<'a, str> {
        if self.is_string {
            cow_unescaped(self.slice(b))
        } else {
            cow_lossy(self.slice(b))
        }
    }
}

/// 从 `i` 处读一个完整 JSON 值（跳过前置空白；字符串按转义推进、对象/数组按括号平衡推进）。
fn read_value(b: &[u8], mut i: usize) -> RawVal {
    let n = b.len();
    while i < n && is_ws4(b[i]) {
        i += 1;
    }
    let start = i;
    if i < n && b[i] == b'"' {
        let mut j = i + 1;
        loop {
            if j >= n {
                break;
            }
            let ch = b[j];
            if ch == b'\\' {
                j += 2;
                continue;
            }
            if ch == b'"' {
                j += 1;
                break;
            }
            j += 1;
        }
        return RawVal {
            rs: start + 1,
            re: j.saturating_sub(1),
            end: j,
            is_string: true,
        };
    }
    if i < n && (b[i] == b'{' || b[i] == b'[') {
        let mut depth: i64 = 0;
        let mut j = i;
        let mut in_str = false;
        while j < n {
            let ch = b[j];
            if in_str {
                if ch == b'\\' {
                    j += 2;
                    continue;
                }
                if ch == b'"' {
                    in_str = false;
                }
            } else if ch == b'"' {
                in_str = true;
            } else if ch == b'{' || ch == b'[' {
                depth += 1;
            } else if ch == b'}' || ch == b']' {
                depth -= 1;
                if depth == 0 {
                    j += 1;
                    break;
                }
            }
            j += 1;
        }
        return RawVal {
            rs: start,
            re: j,
            end: j,
            is_string: false,
        };
    }
    let mut j = i;
    while j < n && b[j] != b',' && b[j] != b'}' && b[j] != b']' && b[j] != b' ' {
        j += 1;
    }
    RawVal {
        rs: start,
        re: j,
        end: j,
        is_string: false,
    }
}

/// 定位 `"key"` 的键与冒号（等价 `KEY_RE = /"((?:[^"\\]|\\.)*)"\s*:/g` 的下一处匹配）。
/// 返回 (键原文起点, 键原文终点, 冒号位置)。
fn next_key_match(b: &[u8], from: usize) -> Option<(usize, usize, usize)> {
    let n = b.len();
    let mut q = from;
    while q < n {
        if b[q] != b'"' {
            q += 1;
            continue;
        }
        let ks = q + 1;
        let mut j = ks;
        let mut closed: Option<usize> = None;
        while j < n {
            let ch = b[j];
            if ch == b'\\' {
                j += 2;
                continue;
            }
            if ch == b'"' {
                closed = Some(j);
                break;
            }
            j += 1;
        }
        let Some(ke) = closed else {
            return None;
        };
        let mut k = ke + 1;
        while k < n && is_ws_js(b[k]) {
            k += 1;
        }
        if k < n && b[k] == b':' {
            return Some((ks, ke, k));
        }
        q += 1;
    }
    None
}

// ==================================================================================
// 三、事件字段提取（`torch-events.ts` 的 parseEventFast 字节版）
// ==================================================================================

#[derive(Clone, Debug)]
enum Pid<'a> {
    Num(f64),
    Str(Cow<'a, str>),
}

impl Pid<'_> {
    fn to_js_string(&self) -> String {
        match self {
            Pid::Num(v) => js_num_str(*v),
            Pid::Str(s) => s.to_string(),
        }
    }

    /// `to_js_string` 的「写入已有缓冲」版本（热路径复用缓冲，零分配）。
    fn write_js_string(&self, out: &mut String) {
        match self {
            Pid::Num(v) => push_js_num(out, *v),
            Pid::Str(s) => out.push_str(s),
        }
    }
}

/// `args` 的取值区间：`Known(rs, re)` 已算出（与 `read_value` 返回值同口径）；
/// `Pending(pos)` 只记下值起点前的推进位置——终点按需再算（多数事件根本不查 args，
/// 而对象/数组值的终点要逐字节做括号平衡，是解析阶段最贵的一步）。
#[derive(Clone, Copy)]
enum ArgsRange {
    Known(usize, usize),
    Pending(usize),
}

/// `args` 的按需求值视图：借用元素文本，首次 `resolve` 时才补算终点（并记住结果，
/// 同一事件上的多次 arg 取值不再重复走括号平衡——与原来「先算一次、多次复用」同量）。
#[derive(Clone, Copy)]
struct ArgsRef<'a> {
    text: &'a [u8],
    range: &'a std::cell::Cell<ArgsRange>,
}

impl<'a> ArgsRef<'a> {
    /// 与 `process` 里原来的 `&text[s.min(n)..e.min(n).max(s)]` 同口径给出 args 切片。
    #[inline]
    fn resolve(self) -> &'a [u8] {
        let n = self.text.len();
        let (rs, re) = match self.range.get() {
            ArgsRange::Known(rs, re) => (rs, re),
            ArgsRange::Pending(pos) => {
                let v = read_value(self.text, pos);
                let got = (v.rs, v.re);
                self.range.set(ArgsRange::Known(got.0, got.1));
                got
            }
        };
        let s = rs.min(n);
        let e = re.min(n).max(s);
        &self.text[s..e]
    }
}

/// 提取后的字段（`args` 为元素内的字节区间；JSON 兜底路径无 args）。
/// 字段值借用 trace 缓冲（`Cow`）——仅遇到转义/非法 UTF-8 时才拥有字符串。
struct EvFields<'a> {
    ph: Cow<'a, str>,
    cat: Cow<'a, str>,
    name: Cow<'a, str>,
    pid: Option<Pid<'a>>,
    tid: Option<Pid<'a>>,
    ts: f64,
    dur: f64,
    args: Option<ArgsRange>,
    /// 仅 JSON 兜底路径可得（字段级提取器不取 `id`）。
    id: Option<f64>,
}

/// 待提字段（槽位序与 `WANTED` 一致，热路径用整数派发免字符串比较）。
const WANTED: [&str; 8] = ["ph", "cat", "name", "ts", "dur", "pid", "tid", "args"];

/// 键原文 → 槽位（无转义时按字节直比；含转义时解转义后与 `WANTED` 比对，语义同原实现）。
#[inline]
fn wanted_slot(key_raw: &[u8]) -> Option<u8> {
    if key_raw.contains(&b'\\') {
        let k = unescape_json(key_raw);
        return WANTED.iter().position(|w| *w == k.as_str()).map(|i| i as u8);
    }
    match key_raw {
        b"ph" => Some(0),
        b"cat" => Some(1),
        b"name" => Some(2),
        b"ts" => Some(3),
        b"dur" => Some(4),
        b"pid" => Some(5),
        b"tid" => Some(6),
        b"args" => Some(7),
        _ => None,
    }
}

fn parse_event_fast(b: &[u8]) -> Option<EvFields<'_>> {
    let mut ph: Option<Cow<str>> = None;
    let mut cat: Cow<str> = Cow::Borrowed("");
    let mut name: Cow<str> = Cow::Borrowed("");
    let mut pid: Option<Pid> = None;
    let mut tid: Option<Pid> = None;
    let mut ts: f64 = 0.0;
    let mut dur: f64 = 0.0;
    let mut args: Option<ArgsRange> = None;
    let mut seen = 0usize;
    let mut pos = 0usize;
    loop {
        let Some((ks, ke, colon)) = next_key_match(b, pos) else {
            break;
        };
        pos = colon + 1;
        let key_raw = &b[ks.min(b.len())..ke.min(b.len())];
        // 键槽位：无转义时按字节直比（与「先 unescape 再与 WANTED 比对」等价），含转义才解转义
        let Some(slot) = wanted_slot(key_raw) else {
            continue;
        };
        if slot == 7 {
            // args：先只记起点（终点要括号平衡，而多数事件既不跨 args 继续扫描、也不查 args）
            if args.is_none() {
                args = Some(ArgsRange::Pending(pos));
                seen += 1;
            }
            if seen >= 8 || (ph.is_some() && args.is_some() && !cat.is_empty() && !name.is_empty()) {
                break;
            }
            // 还需继续扫描后续键：补算终点（与原来走 read_value 完全一致）
            let v = read_value(b, pos);
            args = Some(ArgsRange::Known(v.rs.min(b.len()), v.re.min(b.len())));
            pos = v.end;
            continue;
        }
        let v = read_value(b, pos);
        pos = v.end;
        match slot {
            0 => {
                if ph.is_none() {
                    ph = Some(v.cow_value_text(b));
                    seen += 1;
                }
            }
            1 => {
                if cat.is_empty() && v.is_string {
                    cat = cow_unescaped(v.slice(b));
                    seen += 1;
                }
            }
            2 => {
                if name.is_empty() && v.is_string {
                    name = cow_unescaped(v.slice(b));
                    seen += 1;
                }
            }
            3 => {
                if ts == 0.0 {
                    ts = js_number_bytes(v.slice(b));
                    seen += 1;
                }
            }
            4 => {
                if dur == 0.0 {
                    dur = js_number_bytes(v.slice(b));
                    seen += 1;
                }
            }
            5 => {
                pid = Some(if v.is_string {
                    Pid::Str(cow_unescaped(v.slice(b)))
                } else {
                    Pid::Num(js_number_bytes(v.slice(b)))
                });
                seen += 1;
            }
            6 => {
                tid = Some(if v.is_string {
                    Pid::Str(cow_unescaped(v.slice(b)))
                } else {
                    Pid::Num(js_number_bytes(v.slice(b)))
                });
                seen += 1;
            }
            _ => {}
        }
        if seen >= 8 || (ph.is_some() && args.is_some() && !cat.is_empty() && !name.is_empty()) {
            break;
        }
    }
    let ph = ph?;
    Some(EvFields {
        ph,
        cat,
        name,
        pid,
        tid,
        ts: if ts.is_finite() { ts } else { f64::NAN },
        dur: if dur.is_finite() { dur } else { f64::NAN },
        args,
        id: None,
    })
}

/// 兜底路径：字段级提取失败（无 `"ph"` 键）时按 `JSON.parse` 语义取字段（argsText 恒为 undefined）。
fn parse_event_json_fallback(text: &[u8]) -> Option<EvFields<'_>> {
    let s = String::from_utf8_lossy(text);
    let j = Json::parse(&s)?;
    let as_str = |k: &str| -> Option<Cow<'_, str>> {
        match j.get(k) {
            Some(Json::Str(v)) => Some(Cow::Owned(v.clone())),
            _ => None,
        }
    };
    let ph = match j.get("ph") {
        None | Some(Json::Null) => Cow::Borrowed(""),
        Some(Json::Str(v)) => Cow::Owned(v.clone()),
        // 非字符串 ph：JS 侧 `ph === "X"` 等比较恒为 false，用不可比对哨兵表达
        Some(_) => Cow::Owned("\u{1}".to_string()),
    };
    let num = |k: &str| -> Option<f64> {
        match j.get(k) {
            Some(Json::Num(v)) => Some(*v),
            _ => None,
        }
    };
    let pid = match j.get("pid") {
        Some(Json::Num(v)) => Some(Pid::Num(*v)),
        Some(Json::Str(v)) => Some(Pid::Str(Cow::Owned(v.clone()))),
        None | Some(Json::Null) => Some(Pid::Num(0.0)),
        Some(_) => Some(Pid::Num(0.0)),
    };
    let tid = match j.get("tid") {
        Some(Json::Num(v)) => Some(Pid::Num(*v)),
        Some(Json::Str(v)) => Some(Pid::Str(Cow::Owned(v.clone()))),
        None | Some(Json::Null) => Some(Pid::Num(0.0)),
        Some(_) => Some(Pid::Num(0.0)),
    };
    Some(EvFields {
        ph,
        cat: as_str("cat").unwrap_or(Cow::Borrowed("")),
        name: as_str("name").unwrap_or(Cow::Borrowed("")),
        pid,
        tid,
        // `typeof ev.ts === "number" ? ev.ts : NaN`
        ts: num("ts").unwrap_or(f64::NAN),
        dur: num("dur").unwrap_or(0.0),
        args: None,
        id: num("id"),
    })
}

// ==================================================================================
// 四、args 取值（`argNumber` / `argRaw` 的字节版）
// ==================================================================================

/// `"key"` 的首次出现位置——等价 `find_sub(a, format!("\"{}\"", key))`，但不建临时串。
fn find_quoted_key(h: &[u8], key: &str) -> Option<usize> {
    let k = key.as_bytes();
    let n = h.len();
    let need = k.len() + 2;
    if need > n {
        return None;
    }
    let mut i = 0usize;
    while i + need <= n {
        if h[i] == b'"' && &h[i + 1..i + 1 + k.len()] == k && h[i + 1 + k.len()] == b'"' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn arg_value<'a>(args: Option<ArgsRef<'a>>, key: &str) -> Option<(RawVal, &'a [u8])> {
    let a = args?.resolve();
    if a.is_empty() {
        return None; // `if (!argsText)`——空串为假
    }
    let i = find_quoted_key(a, key)?;
    let colon = find_byte(a, i + key.len() + 2, b':')?;
    let v = read_value(a, colon + 1);
    Some((v, a))
}

fn arg_number(args: Option<ArgsRef<'_>>, key: &str) -> Option<f64> {
    let (v, a) = arg_value(args, key)?;
    let n = if v.is_string {
        js_number(&cow_unescaped(v.slice(a)))
    } else {
        js_number_bytes(v.slice(a))
    };
    if n.is_finite() {
        Some(n)
    } else {
        None
    }
}

fn arg_raw(args: Option<ArgsRef<'_>>, key: &str) -> Option<String> {
    let (v, a) = arg_value(args, key)?;
    Some(v.value_text(a))
}

// ==================================================================================
// 五、名称/几何/传输方向解析（与 TS 侧同名函数同语义）
// ==================================================================================

/// `parsePythonSite`：`文件(行): 函数`（非贪婪前缀 + ASCII 数字 + 冒号 + 空白 + 剩余）。
/// 返回原文切片（热路径零分配）；函数名为 None 表示匿名（`(匿名)`）。
fn parse_python_site(name: &str) -> Option<(&str, f64, Option<&str>)> {
    let bytes = name.as_bytes();
    let n = bytes.len();
    let mut k = 1usize; // `(.+?)` 至少 1 字符
    while k < n {
        if bytes[k] == b'(' {
            // 前缀不得含换行（JS 正则的 `.` 不跨行）
            if name[..k].contains('\n') {
                return None;
            }
            let mut j = k + 1;
            while j < n && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > k + 1 && j < n && bytes[j] == b')' && j + 1 < n && bytes[j + 1] == b':' {
                let line = js_number(&name[k + 1..j]);
                if !line.is_finite() {
                    return None;
                }
                let rest = &name[j + 2..];
                let rest = rest.trim_start_matches(|c: char| c.is_whitespace());
                if rest.contains('\n') {
                    return None;
                }
                return Some((&name[..k], line, if rest.is_empty() { None } else { Some(rest) }));
            }
        }
        k += 1;
    }
    None
}

/// `parseTripleText`：从原始文本抓出前三个数字（`-?\d+(?:\.\d+)?`），缺省补 1。
fn parse_triple_text(raw: &str) -> Option<[f64; 3]> {
    let b = raw.as_bytes();
    let n = b.len();
    let mut nums: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < n && nums.len() < 3 {
        let start = i;
        let mut ok = false;
        if b[i] == b'-' && i + 1 < n && b[i + 1].is_ascii_digit() {
            i += 1;
            ok = true;
        } else if b[i].is_ascii_digit() {
            ok = true;
        }
        if !ok {
            i += 1;
            continue;
        }
        while i < n && b[i].is_ascii_digit() {
            i += 1;
        }
        if i + 1 < n && b[i] == b'.' && b[i + 1].is_ascii_digit() {
            i += 1;
            while i < n && b[i].is_ascii_digit() {
                i += 1;
            }
        }
        nums.push(raw[start..i].to_string());
    }
    if nums.is_empty() {
        return None;
    }
    let pick = |v: Option<&String>, def: f64| -> f64 {
        match v {
            None => def,
            Some(s) => {
                let n = js_number(s);
                if n == 0.0 || n.is_nan() {
                    def
                } else {
                    n
                }
            }
        }
    };
    Some([
        pick(Some(&nums[0]), 0.0),
        pick(nums.get(1), 1.0),
        pick(nums.get(2), 1.0),
    ])
}

/// `normalizeTypeList`：去掉 `[`/`]`/`"`/空白。
fn normalize_type_list(raw: &str) -> String {
    raw.chars()
        .filter(|c| !matches!(c, '[' | ']' | '"') && !c.is_whitespace())
        .collect()
}

/// `normalizeShapeList`：去掉全部空白，限长 120（截断以省略号收尾）。
fn normalize_shape_list(raw: &str) -> String {
    let compact: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    let chars: Vec<char> = compact.chars().collect();
    if chars.len() <= 120 {
        compact
    } else {
        let mut s: String = chars[..119].iter().collect();
        s.push('…');
        s
    }
}

fn is_word_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// `transferKind`：方向标签（词边界），Memset 次之，最后取首词。全部返回原文借用（零分配）。
fn transfer_kind(name: &str) -> Cow<'_, str> {
    let b = name.as_bytes();
    let n = b.len();
    for i in 0..n {
        if !b[i].is_ascii_alphabetic() {
            continue;
        }
        if i > 0 && is_word_byte(b[i - 1]) {
            continue;
        }
        for cand in ["HtoD", "DtoH", "DtoD", "HtoH", "PtoP"] {
            let cb = cand.as_bytes();
            if i + cb.len() <= n && &b[i..i + cb.len()] == cb {
                let after = i + cb.len();
                if after >= n || !is_word_byte(b[after]) {
                    return Cow::Borrowed(cand);
                }
            }
        }
    }
    let lower = name.to_ascii_lowercase();
    if lower.contains("memset") {
        return Cow::Borrowed("Memset");
    }
    match name.split(' ').next() {
        Some(s) => Cow::Borrowed(s),
        None => Cow::Borrowed(""),
    }
}

/// `eventIdOf`：原文里首个 `"id"` 之后首个冒号后的前导数字。
fn event_id_of(text: &[u8]) -> Option<f64> {
    let i = find_sub(text, b"\"id\"")?;
    let colon = find_byte(text, i + 4, b':')?;
    let mut j = colon + 1;
    let n = text.len();
    while j < n && is_ws_js(text[j]) {
        j += 1;
    }
    let start = j;
    while j < n && text[j].is_ascii_digit() {
        j += 1;
    }
    if j == start {
        return None;
    }
    let v = js_number(&String::from_utf8_lossy(&text[start..j]));
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

/// `/^ProfilerStep#?\d*$/`
fn is_profiler_step(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("ProfilerStep") else {
        return false;
    };
    let rest = rest.strip_prefix('#').unwrap_or(rest);
    rest.bytes().all(|c| c.is_ascii_digit())
}

/// UTF-16 码元长度（`scannedChars` 是 JS 字符串长度，不是字节数）。
fn utf16_len(b: &[u8]) -> usize {
    let n = b.len();
    let mut count = 0usize;
    let mut i = 0usize;
    while i < n {
        let c = b[i];
        if c < 0x80 {
            // 纯 ASCII 块（每字节 1 个码元）整块跳过——trace 绝大多数字节落在这一支
            if i + 8 <= n {
                let w = u64::from_le_bytes(b[i..i + 8].try_into().unwrap());
                if w & 0x8080_8080_8080_8080 == 0 {
                    count += 8;
                    i += 8;
                    continue;
                }
            }
            count += 1;
            i += 1;
        } else if c < 0xE0 {
            count += 1;
            i += 2;
        } else if c < 0xF0 {
            count += 1;
            i += 3;
        } else {
            count += 2;
            i += 4;
        }
    }
    count
}

// ==================================================================================
// 六、共享聚合原语（core/perf/agg.ts 的 Rust 等价实现）
// ==================================================================================

/// 受控采样器（分位数估计）：先精确保存至多 cap 个样本，超出后蓄水池替换。
/// 随机数是 mulberry32 固定种子（0x9e3779b9）——与 JS 侧同序列，分位数才能逐位对齐。
struct Sampler {
    cap: usize,
    vals: Vec<f64>,
    seen: u64,
    sampled: bool,
    rng: u32,
}

const SAMPLER_SEED: u32 = 0x9e3779b9;

impl Sampler {
    fn new(cap: usize) -> Sampler {
        Sampler {
            cap,
            vals: Vec::with_capacity(cap.min(256)),
            seen: 0,
            sampled: false,
            rng: SAMPLER_SEED,
        }
    }

    /// `(rngState + 0x6d2b79f5) >>> 0` 后的 mulberry32 混合（全 32 位无符号运算）。
    fn next_random(&mut self) -> f64 {
        self.rng = self.rng.wrapping_add(0x6d2b79f5);
        let mut t = self.rng;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }

    fn add(&mut self, v: f64) {
        self.seen += 1;
        if self.vals.len() < self.cap {
            self.vals.push(v);
            return;
        }
        self.sampled = true;
        let idx = (self.next_random() * self.seen as f64).floor();
        if idx < self.cap as f64 {
            self.vals[idx as usize] = v;
        }
    }

    fn quantile(&self, q: f64) -> f64 {
        if self.vals.is_empty() {
            return 0.0;
        }
        let mut sorted = self.vals.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let pos = (sorted.len() - 1) as f64 * q;
        let lo = pos.floor();
        let hi = pos.ceil();
        if lo == hi {
            sorted[lo as usize]
        } else {
            let l = sorted[lo as usize];
            let h = sorted[hi as usize];
            l + (h - l) * (pos - lo)
        }
    }
}

/// 单次分配（最大分配排行条目）。
#[derive(Clone)]
struct Alloc {
    bytes: f64,
    addr: f64,
    device_id: f64,
    ts_us: f64,
}

/// Top-K（键去重 + 权重降序，容量恒定）。复刻 JS 版：满时「最小项权重 >= 新权重即丢弃」，
/// 且每次 add 后做一次**稳定**降序排序（并列顺序由此定型，必须一致）。
struct AllocTopK {
    k: usize,
    items: Vec<(String, f64, Alloc)>,
    /// 去重键的复用缓冲（`${addr}:${ts}`）——热路径逐次分配改为写入后复用。
    key_buf: String,
}

impl AllocTopK {
    fn new(k: usize) -> AllocTopK {
        AllocTopK { k, items: Vec::with_capacity(k.min(64)), key_buf: String::new() }
    }

    fn add(&mut self, v: Alloc) {
        let weight = v.bytes;
        self.key_buf.clear();
        push_js_num(&mut self.key_buf, v.addr);
        self.key_buf.push(':');
        push_js_num(&mut self.key_buf, v.ts_us);
        let key: &str = &self.key_buf;
        let mut existing: Option<usize> = None;
        for (i, it) in self.items.iter().enumerate() {
            if it.0 == key {
                existing = Some(i);
                break;
            }
        }
        match existing {
            Some(i) => {
                self.items[i].1 = weight;
                self.items[i].2 = v;
            }
            None => {
                if self.items.len() >= self.k {
                    let mut min_i = 0usize;
                    for i in 1..self.items.len() {
                        if self.items[i].1 < self.items[min_i].1 {
                            min_i = i;
                        }
                    }
                    if self.items[min_i].1 >= weight {
                        return;
                    }
                    self.items[min_i] = (key.to_string(), weight, v);
                } else {
                    self.items.push((key.to_string(), weight, v));
                }
            }
        }
        self.items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    }

    fn to_array(&self) -> Vec<Alloc> {
        self.items.iter().map(|i| i.2.clone()).collect()
    }
}

/// 自适应分辨率时间线分桶（内存恒定；桶溢出即倍粗并合并相邻桶）。
struct Bins {
    cap: usize,
    width: f64,
    origin: f64,
    last_end: f64,
    counts: Vec<f64>,
    busy: Vec<f64>,
}

impl Bins {
    fn new(cap: usize) -> Bins {
        Bins {
            cap,
            width: 100_000.0,
            origin: f64::INFINITY,
            last_end: 0.0,
            counts: vec![0.0; cap],
            busy: vec![0.0; cap],
        }
    }

    fn coarsen(&mut self) {
        let mut counts = vec![0.0; self.cap];
        let mut busy = vec![0.0; self.cap];
        for i in 0..self.cap {
            counts[i >> 1] += self.counts[i];
            busy[i >> 1] += self.busy[i];
        }
        self.counts = counts;
        self.busy = busy;
        self.width *= 2.0;
    }

    fn add(&mut self, start: f64, end: f64) {
        if end <= start {
            return;
        }
        if self.origin == f64::INFINITY {
            self.origin = start;
            self.last_end = start;
        }
        if end > self.last_end {
            self.last_end = end;
        }
        while (end - self.origin) / self.width >= self.cap as f64 {
            self.coarsen();
        }
        let first = js_max2(0.0, ((start - self.origin) / self.width).floor()) as usize;
        let last = js_min2(
            self.cap as f64 - 1.0,
            ((end - self.origin) / self.width).floor(),
        ) as usize;
        if first >= self.cap {
            return;
        }
        for b in first..=last.min(self.cap - 1) {
            let bin_start = self.origin + b as f64 * self.width;
            let bin_end = bin_start + self.width;
            self.counts[b] += 1.0;
            self.busy[b] += js_max2(0.0, js_min2(end, bin_end) - js_max2(start, bin_start));
        }
    }

    /// 降采样为占用序列（0~1，长度不超 target）。
    fn series(&self, target: usize) -> Vec<f64> {
        let used_f = js_min2(
            self.cap as f64,
            js_max2(1.0, ((self.last_end - self.origin) / self.width).ceil()),
        );
        if !used_f.is_finite() {
            return Vec::new();
        }
        let used = js_max2(1.0, used_f) as usize;
        let used = used.min(self.cap).max(1);
        let stride = js_max2(1.0, (used as f64 / target as f64).ceil()) as usize;
        let stride = stride.max(1);
        let mut out = Vec::new();
        let mut b = 0usize;
        while b < used {
            let end_b = (b + stride).min(used);
            let mut busy = 0.0;
            for k in b..end_b {
                busy += self.busy[k];
            }
            let span = self.width * (end_b - b) as f64;
            out.push(js_min2(1.0, if span > 0.0 { busy / span } else { 0.0 }));
            b += stride;
        }
        out
    }
}

/// 区间并集流式聚合（忙碌总时长、最大并发、空闲缝）；输入按 start 升序。
struct Union {
    min_gap: f64,
    busy: f64,
    heap: Vec<f64>,
    max_concurrent: u64,
    first_start: f64,
    last_end: f64,
    running_max_end: f64,
    gaps: Vec<(f64, f64)>,
    truncated: bool,
}

impl Union {
    fn new(min_gap: f64) -> Union {
        Union {
            min_gap,
            busy: 0.0,
            heap: Vec::new(),
            max_concurrent: 0,
            first_start: f64::NEG_INFINITY,
            last_end: f64::NEG_INFINITY,
            running_max_end: f64::NEG_INFINITY,
            gaps: Vec::with_capacity(64),
            truncated: false,
        }
    }

    fn heap_push(&mut self, v: f64) {
        self.heap.push(v);
        let mut i = self.heap.len() - 1;
        while i > 0 {
            let parent = (i - 1) >> 1;
            if self.heap[parent] <= self.heap[i] {
                break;
            }
            self.heap.swap(parent, i);
            i = parent;
        }
    }

    fn heap_pop(&mut self) {
        let last = self.heap.pop().unwrap();
        if self.heap.is_empty() {
            return;
        }
        self.heap[0] = last;
        let mut i = 0usize;
        loop {
            let l = 2 * i + 1;
            let r = l + 1;
            let mut smallest = i;
            if l < self.heap.len() && self.heap[l] < self.heap[smallest] {
                smallest = l;
            }
            if r < self.heap.len() && self.heap[r] < self.heap[smallest] {
                smallest = r;
            }
            if smallest == i {
                break;
            }
            self.heap.swap(smallest, i);
            i = smallest;
        }
    }

    fn add(&mut self, start: f64, end: f64) {
        if end <= start {
            return;
        }
        if self.first_start == f64::NEG_INFINITY || start < self.first_start {
            self.first_start = start;
        }
        if end > self.last_end {
            self.last_end = end;
        }
        if self.running_max_end != f64::NEG_INFINITY
            && start > self.running_max_end
            && start - self.running_max_end >= self.min_gap
        {
            if self.gaps.len() < MAX_GAPS {
                self.gaps.push((self.running_max_end, start));
            } else {
                self.truncated = true;
            }
        }
        if self.running_max_end == f64::NEG_INFINITY {
            self.busy += end - start;
            self.running_max_end = end;
        } else if end > self.running_max_end {
            self.busy += end - js_max2(start, self.running_max_end);
            self.running_max_end = end;
        }
        while !self.heap.is_empty() && self.heap[0] <= start {
            self.heap_pop();
        }
        self.heap_push(end);
        if self.heap.len() as u64 > self.max_concurrent {
            self.max_concurrent = self.heap.len() as u64;
        }
    }

    fn finalize(&self) -> UnionResult {
        let first_start = if self.first_start.is_finite() { self.first_start } else { 0.0 };
        let last_end = if self.last_end.is_finite() { self.last_end } else { 0.0 };
        let mut gaps = self.gaps.clone();
        gaps.sort_by(|a, b| {
            (b.1 - b.0)
                .partial_cmp(&(a.1 - a.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        UnionResult {
            busy: self.busy,
            first_start,
            last_end,
            span: js_max2(0.0, last_end - first_start),
            gaps,
            truncated: self.truncated,
            max_concurrent: self.max_concurrent,
        }
    }
}

struct UnionResult {
    busy: f64,
    first_start: f64,
    last_end: f64,
    span: f64,
    /// 空闲缝已按间隔降序（稳定排序保持发现顺序）。
    gaps: Vec<(f64, f64)>,
    truncated: bool,
    max_concurrent: u64,
}

/// 由空闲缝反推并集区间（升序）——并集 = [from,to] 去除空闲缝的补集。
fn merged_from_gaps(gaps: &[(f64, f64)], from: f64, to: f64) -> Vec<(f64, f64)> {
    if to <= from {
        return Vec::new();
    }
    let mut sorted = gaps.to_vec();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<(f64, f64)> = Vec::new();
    let mut cursor = from;
    for (gs, ge) in sorted {
        let s = js_max2(from, gs);
        let e = js_min2(to, ge);
        if e <= cursor {
            continue;
        }
        if s > cursor {
            out.push((cursor, s));
        }
        cursor = js_max2(cursor, e);
    }
    if cursor < to {
        out.push((cursor, to));
    }
    out.retain(|iv| iv.1 > iv.0);
    out
}

/// 两组升序区间的交集总长（双指针）；`with_per_item` 时另给 b 中每项的交集长度。
fn intersection_totals(a: &[(f64, f64)], b: &[(f64, f64)], with_per_item: bool) -> (f64, Vec<f64>) {
    let mut i = 0usize;
    let mut j = 0usize;
    let mut total = 0.0;
    let mut per = if with_per_item { vec![0.0; b.len()] } else { Vec::new() };
    while i < a.len() && j < b.len() {
        let lo = js_max2(a[i].0, b[j].0);
        let hi = js_min2(a[i].1, b[j].1);
        if hi > lo {
            total += hi - lo;
            if with_per_item {
                per[j] += hi - lo;
            }
        }
        if a[i].1 <= b[j].1 {
            i += 1;
        } else {
            j += 1;
        }
    }
    (total, per)
}

// ==================================================================================
// 七、聚合状态（与 aggregateTorchTrace 的局部状态一一对应）
// ==================================================================================

struct CatTime {
    count: u64,
    total_us: f64,
    self_us: f64,
}

struct GroupAcc {
    cat: String,
    name: String,
    count: u64,
    total_us: f64,
    child_us: f64,
    self_us: f64,
    min_us: f64,
    max_us: f64,
    devices: Vec<f64>,
    streams: Vec<f64>,
    shapes: Vec<String>,
    dtypes: Vec<String>,
    launch_sites: Vec<String>,
    launch_ops: Vec<String>,
    grid: Option<[f64; 3]>,
    block: Option<[f64; 3]>,
    registers: Option<f64>,
    occupancy: Option<f64>,
    shared_memory: Option<f64>,
    sampler: Option<Sampler>,
}

impl GroupAcc {
    fn new(cat: &str, name: &str, sampler: Option<Sampler>) -> GroupAcc {
        GroupAcc {
            cat: cat.to_string(),
            name: name.to_string(),
            count: 0,
            total_us: 0.0,
            child_us: 0.0,
            self_us: 0.0,
            min_us: f64::INFINITY,
            max_us: 0.0,
            devices: Vec::new(),
            streams: Vec::new(),
            shapes: Vec::new(),
            dtypes: Vec::new(),
            launch_sites: Vec::new(),
            launch_ops: Vec::new(),
            grid: None,
            block: None,
            registers: None,
            occupancy: None,
            shared_memory: None,
            sampler,
        }
    }
}

struct Frame {
    name: String,
    /// 压栈时已解析的分组下标（`ensure_group(cat, name)` 的结果，映射只增不改，关闭时直接复用）
    gi: usize,
    start: f64,
    end: f64,
    child_us: f64,
}

/// 单个（类别, 进程, 线程）的浅栈：`frames` 为未闭合帧，`pool` 为关闭帧回收的名称缓冲
/// （复用 String 容量，避免逐事件 malloc/free——热路径上每个 X 事件都要压一帧）。
#[derive(Default)]
struct Stack {
    frames: Vec<Frame>,
    pool: Vec<String>,
}

/// 逐事件复用的字符串缓冲（把 `format!` 临时串降为「写进已有缓冲」，命中时零分配）。
#[derive(Default)]
struct Scratch {
    pid: String,
    tid: String,
    /// `sc.pid`/`sc.tid` 当前的数值键（`None` = 不可复用，下次必须重写）
    pid_key: Option<u64>,
    tid_key: Option<u64>,
    thread_key: String,
    stack_key: String,
    frame_key: String,
    py_key: String,
    flow_key: String,
}

#[derive(Clone)]
struct Activity {
    cat: String,
    name: String,
    ts: f64,
    dur: f64,
}

struct LaunchCtx {
    api: String,
    op: Option<String>,
    python: Option<String>,
}

struct AttrEntry {
    kernel: String,
    op: String,
    api: Option<String>,
    python: Option<String>,
    via: &'static str,
    count: u64,
    kernel_us: f64,
}

struct FlowOpen {
    cat: String,
    name: Option<String>,
}

struct FlowLink {
    launcher: String,
    count: u64,
}

impl Clone for FlowLink {
    fn clone(&self) -> FlowLink {
        FlowLink { launcher: self.launcher.clone(), count: self.count }
    }
}

struct FwdOpen {
    ts: f64,
    act: Option<Activity>,
}

struct Mark {
    forward_us: f64,
    backward_us: f64,
    forward_name: Option<String>,
    backward_name: Option<String>,
    ts_us: f64,
}

struct DevMem {
    alloc_count: u64,
    bytes: f64,
    peak_bytes: f64,
    live_bytes: f64,
}

struct PySite {
    location: String,
    file: String,
    line: f64,
    func: String,
    count: u64,
    self_us: f64,
    total_us: f64,
}

struct Transfer {
    count: u64,
    bytes: f64,
    total_us: f64,
}

struct Mem {
    events: u64,
    alloc_count: u64,
    free_count: u64,
    allocated_bytes: f64,
    freed_bytes: f64,
    peak_allocated: f64,
    peak_reserved: f64,
    saw_trace_totals: bool,
    live: FastMap<u64, f64>,
    live_bytes: f64,
    peak_live_bytes: f64,
    by_device: Vec<(f64, DevMem)>,
    by_device_index: FastMap<u64, usize>,
    largest: AllocTopK,
    addr_truncated: bool,
}

/// f64 作 Map 键（JS Map 的 SameValueZero；-0 与 +0 视为同键）。
fn fkey(v: f64) -> u64 {
    if v == 0.0 {
        0
    } else {
        v.to_bits()
    }
}

// ==================================================================================
// 七之二、分块并行：块内顺序依赖日志（块内只记不判，归并阶段按全局序回放）
// ==================================================================================
//
// 为什么需要日志：聚合状态里有一半带**顺序依赖**（浅栈自身耗时、采样器蓄水池、时间线并集的
// running-max 语义、显存活跃集/TopK、flow 配对与全局活动、correlation 启发表、分组首现序）。
// 分块并行时这些状态无法简单地按块求和，故块内只记**紧凑记录**，归并阶段按全局序用与顺序
// 路径**同一批 helper** 回放——逐字段一致由「语义只有一份实现」保证，而不是靠近似。

/// 单个栈事件记录（`gi` 为本块内分组下标，归并时按块的映射表换成全局下标）。
struct StackRec {
    gi: u32,
    ts: f64,
    dur: f64,
    /// 该事件关联的 corr 日志下标（发起事件恒记，内核仅在带 correlation 时记）
    corr: Option<u32>,
}

/// 显存瞬时事件记录（`ph:"i"`）。
struct MemRec {
    bytes: f64,
    addr: f64,
    device_id: f64,
    total_allocated: Option<f64>,
    total_reserved: Option<f64>,
    ts: f64,
}

/// 流事件记录（`ph:"s"/"f"`，含 fwdbwd 配对）。
struct FlowRec {
    key: String,
    is_fwdbwd: bool,
    is_start: bool,
    ts: f64,
    /// 块内最近活动（None = 本块尚无 X 事件 —— 归并时用上游块携带的活动）
    act: Option<Activity>,
}

/// correlation 相关事件记录（cuda_runtime 发起事件恒记；内核仅在带 correlation 时记）。
struct CorrEntry {
    is_launch: bool,
    gi: u32,
    name: String,
    corr: Option<f64>,
    dur: f64,
    /// 归并阶段：本块映射出的全局分组下标（None = 该分组被 MAX_GROUPS 截断，顺序路径整块跳过）
    global_gi: Option<u32>,
    /// 归并阶段：按 key 回放解析出的（发起算子帧名, 发起 python 帧名）
    res_op: Option<String>,
    res_py: Option<String>,
    /// 归并阶段：全局序下标（供按 key 回放回填解析结果）
    gidx: u32,
}

/// 块内顺序依赖日志。
#[derive(Default)]
struct ChunkLogs {
    /// 栈事件流：（`进程:线程`）→ 记录序列（帧按类别分栈，与顺序路径的 `类别|进程|线程` 键等价）
    stacks: Vec<(String, Vec<StackRec>)>,
    stack_index: FastMap<String, usize>,
    /// 时间线区间（纳秒）：cpu 侧 / gpu 侧（块内顺序即全局序的片段）
    cpu_iv: Vec<(f64, f64)>,
    gpu_iv: Vec<(f64, f64)>,
    /// 采样时长：本块内分组下标 → 时长序列（仅本地下标 < SAMPLER_GROUPS 的分组）
    group_durs: Vec<(usize, Vec<f64>)>,
    group_dur_index: FastMap<usize, usize>,
    /// 步时长（ProfilerStep，按事件序）
    step_durs: Vec<f64>,
    mem: Vec<MemRec>,
    flow: Vec<FlowRec>,
    corr: Vec<CorrEntry>,
}

struct State {
    events: u64,
    by_category: Vec<(String, u64)>,
    by_category_index: FastMap<String, usize>,
    processes: Vec<String>,
    process_seen: FastSet<String>,
    threads: FastSet<String>,

    category_time: Vec<(String, CatTime)>,
    category_index: FastMap<String, usize>,

    groups: Vec<GroupAcc>,
    cat_order: Vec<String>,
    cat_index: FastMap<String, usize>,
    cat_groups: Vec<Vec<usize>>,
    cat_group_index: Vec<FastMap<String, usize>>,
    group_count: usize,
    overflow_groups: u64,

    stacks: FastMap<String, Stack>,

    steps: Vec<(String, f64, f64)>,
    step_sampler: Sampler,
    last_item_end: usize,

    cpu_union: Union,
    gpu_union: Union,
    cpu_bins: Bins,
    gpu_bins: Bins,

    transfer_agg: Vec<(String, Transfer)>,
    transfer_index: FastMap<String, usize>,
    transfer_count: u64,
    transfer_bytes: f64,

    mem: Mem,

    python_sites: Vec<(String, PySite)>,
    python_index: FastMap<String, usize>,

    kernel_events: u64,
    gpu_transfer_events: u64,

    launch_context: FastMap<u64, LaunchCtx>,
    kernel_attr: Vec<AttrEntry>,
    kernel_attr_index: FastMap<String, usize>,

    flow_open: FastMap<String, FlowOpen>,
    flow_link: Vec<(String, FlowLink)>,
    flow_link_index: FastMap<String, usize>,
    flow_pairs: u64,
    last_activity: Option<Activity>,

    fwd_bwd_open: FastMap<String, FwdOpen>,
    fwd_bwd_marks: Vec<Mark>,
    /// 分块模式的块内顺序依赖日志（None = 直接单趟路径；两份路径共用同一套语义实现）
    logs: Option<Box<ChunkLogs>>,
}

/// 数值型 pid/tid 的复用键（位相等 ⟹ JS 文本相等）；字符串型/缺失不可复用（None）。
fn pid_num_key(p: &Pid) -> Option<u64> {
    match p {
        Pid::Num(v) => Some(v.to_bits()),
        Pid::Str(_) => None,
    }
}

/// 分组自身耗时入账（按帧内已解析的分组下标直接写入：`group_of(cat, name)` 的等价结果）。
fn close_frame_at(groups: &mut [GroupAcc], f: &Frame) {
    let g = &mut groups[f.gi];
    g.child_us += f.child_us;
    g.self_us += js_max2(0.0, f.end - f.start - f.child_us);
}

/// 显存瞬时事件入账（`ph:"i"` 的 `[memory]` 事件）。
///
/// 顺序路径直接调用；分块模式由归并阶段按全局序回放日志调用——**只有一份实现**，
/// 两条路径的显存语义（活跃集/降级/每设备峰值/最大分配 TopK）不可能漂移。
fn apply_mem_instant(
    mem: &mut Mem,
    bytes: f64,
    addr: f64,
    device_id: f64,
    total_allocated: Option<f64>,
    total_reserved: Option<f64>,
    ts: f64,
) {
    mem.events += 1;
    if bytes >= 0.0 {
        mem.alloc_count += 1;
        mem.allocated_bytes += bytes;
    } else {
        mem.free_count += 1;
        mem.freed_bytes += -bytes;
    }
    if let Some(ta) = total_allocated {
        mem.saw_trace_totals = true;
        if ta > mem.peak_allocated {
            mem.peak_allocated = ta;
        }
    }
    if let Some(tr) = total_reserved {
        if tr > mem.peak_reserved {
            mem.peak_reserved = tr;
        }
    }
    // 活跃集（按地址）：追踪上限内维护，超出即降级
    if !mem.addr_truncated {
        let k = fkey(addr);
        if let Some(prev) = mem.live.remove(&k) {
            mem.live_bytes -= prev;
        }
        if bytes > 0.0 {
            if mem.live.len() >= MAX_TRACKED_ADDRS {
                mem.addr_truncated = true;
                mem.live.clear();
            } else {
                mem.live.insert(k, bytes);
                mem.live_bytes += bytes;
            }
        }
        if mem.live_bytes > mem.peak_live_bytes {
            mem.peak_live_bytes = mem.live_bytes;
        }
    }
    // 每设备分解
    let dk = fkey(device_id);
    let idx = match mem.by_device_index.get(&dk) {
        Some(&i) => i,
        None => {
            mem.by_device.push((
                device_id,
                DevMem { alloc_count: 0, bytes: 0.0, peak_bytes: 0.0, live_bytes: 0.0 },
            ));
            let i = mem.by_device.len() - 1;
            mem.by_device_index.insert(dk, i);
            i
        }
    };
    let d = &mut mem.by_device[idx].1;
    if bytes > 0.0 {
        d.alloc_count += 1;
        d.bytes += bytes;
        d.live_bytes += bytes;
        d.peak_bytes = js_max2(d.peak_bytes, d.live_bytes);
        mem.largest.add(Alloc { bytes, addr, device_id, ts_us: ts });
    } else {
        d.live_bytes = js_max2(0.0, d.live_bytes + bytes);
    }
}

impl State {
    fn new() -> State {
        State {
            events: 0,
            by_category: Vec::new(),
            by_category_index: FastMap::default(),
            processes: Vec::new(),
            process_seen: FastSet::default(),
            threads: FastSet::default(),
            category_time: Vec::new(),
            category_index: FastMap::default(),
            groups: Vec::new(),
            cat_order: Vec::new(),
            cat_index: FastMap::default(),
            cat_groups: Vec::new(),
            cat_group_index: Vec::new(),
            group_count: 0,
            overflow_groups: 0,
            stacks: FastMap::default(),
            steps: Vec::new(),
            step_sampler: Sampler::new(4_096),
            last_item_end: 0,
            cpu_union: Union::new(50_000.0),
            gpu_union: Union::new(50_000.0),
            cpu_bins: Bins::new(TIMELINE_BINS),
            gpu_bins: Bins::new(TIMELINE_BINS),
            transfer_agg: Vec::new(),
            transfer_index: FastMap::default(),
            transfer_count: 0,
            transfer_bytes: 0.0,
            mem: Mem {
                events: 0,
                alloc_count: 0,
                free_count: 0,
                allocated_bytes: 0.0,
                freed_bytes: 0.0,
                peak_allocated: 0.0,
                peak_reserved: 0.0,
                saw_trace_totals: false,
                live: FastMap::default(),
                live_bytes: 0.0,
                peak_live_bytes: 0.0,
                by_device: Vec::new(),
                by_device_index: FastMap::default(),
                largest: AllocTopK::new(TOP_ROWS),
                addr_truncated: false,
            },
            python_sites: Vec::new(),
            python_index: FastMap::default(),
            kernel_events: 0,
            gpu_transfer_events: 0,
            launch_context: FastMap::default(),
            kernel_attr: Vec::new(),
            kernel_attr_index: FastMap::default(),
            flow_open: FastMap::default(),
            flow_link: Vec::new(),
            flow_link_index: FastMap::default(),
            flow_pairs: 0,
            last_activity: None,
            fwd_bwd_open: FastMap::default(),
            fwd_bwd_marks: Vec::new(),
            logs: None,
        }
    }

    /// 分块模式的块内状态：分组表**不设上限**（溢出判定归并时按全局序做）、不建采样器
    /// （时长记进日志、由归并阶段按全局序喂给全局采样器），顺序依赖部分只记日志。
    fn new_chunked() -> State {
        let mut st = State::new();
        st.logs = Some(Box::new(ChunkLogs::default()));
        st
    }

    #[inline]
    fn chunked(&self) -> bool {
        self.logs.is_some()
    }

    fn bump_category(&mut self, cat: &str) {
        if let Some(&i) = self.by_category_index.get(cat) {
            self.by_category[i].1 += 1;
            return;
        }
        self.by_category_index.insert(cat.to_string(), self.by_category.len());
        self.by_category.push((cat.to_string(), 1));
    }

    /// 进程名去重入账（借用入口：命中时零分配，语义同原「insert(clone) 成功才 push」）。
    fn add_process(&mut self, s: &str) {
        if !self.process_seen.contains(s) {
            self.process_seen.insert(s.to_string());
            self.processes.push(s.to_string());
        }
    }

    /// 线程键去重入账（`${pid}:${tid}`，语义同 `threads.insert(...)`，命中时零分配）。
    fn add_thread_key(&mut self, key: &str) {
        if !self.threads.contains(key) {
            self.threads.insert(key.to_string());
        }
    }

    fn bump_category_time(&mut self, cat: &str, dur: f64) {
        if let Some(&i) = self.category_index.get(cat) {
            self.category_time[i].1.count += 1;
            self.category_time[i].1.total_us += dur;
            return;
        }
        self.category_index.insert(cat.to_string(), self.category_time.len());
        self.category_time.push((cat.to_string(), CatTime { count: 1, total_us: dur, self_us: 0.0 }));
    }

    /// `ensureGroup(cat, name, sample)`：超上限即计入溢出并返回 None（该名称此后每次都会再计一次溢出）。
    ///
    /// 分块模式（`logs.is_some()`）下**不设上限、不建采样器**：上限与采样器资格都取决于全局创建序，
    /// 只能归并阶段按块序 + 块内创建序判定；块内改为记录时长序列（仅本地下标 < SAMPLER_GROUPS 的分组——
    /// 全局创建序 ≥ 本地创建序，故不在该范围内的分组必无采样器，记录范围是精确的上界）。
    fn ensure_group(&mut self, cat: &str, name: &str, sample: bool) -> Option<usize> {
        let chunked = self.logs.is_some();
        let ci = match self.cat_index.get(cat) {
            Some(&i) => i,
            None => {
                let i = self.cat_order.len();
                self.cat_index.insert(cat.to_string(), i);
                self.cat_order.push(cat.to_string());
                self.cat_groups.push(Vec::new());
                self.cat_group_index.push(FastMap::default());
                i
            }
        };
        if let Some(&gi) = self.cat_group_index[ci].get(name) {
            return Some(gi);
        }
        if !chunked && self.group_count >= MAX_GROUPS {
            self.overflow_groups += 1;
            return None;
        }
        let sampleable = self.group_count < SAMPLER_GROUPS && sample;
        let sampler = if sampleable && !chunked {
            Some(Sampler::new(SAMPLES_PER_GROUP))
        } else {
            None
        };
        let gi = self.groups.len();
        self.groups.push(GroupAcc::new(cat, name, sampler));
        self.cat_groups[ci].push(gi);
        self.cat_group_index[ci].insert(name.to_string(), gi);
        self.group_count += 1;
        if chunked && sampleable {
            let logs = self.logs.as_mut().unwrap();
            logs.group_dur_index.insert(gi, logs.group_durs.len());
            logs.group_durs.push((gi, Vec::new()));
        }
        Some(gi)
    }

    fn group_of(&self, cat: &str, name: &str) -> Option<usize> {
        let ci = *self.cat_index.get(cat)?;
        self.cat_group_index[ci].get(name).copied()
    }

    /// 同一（进程, 线程）上包含 `ts` 的最内层同类帧（浅栈自顶向下）。
    fn enclosing_frame(&self, key: &str, ts: f64) -> Option<&Frame> {
        let stack = self.stacks.get(key)?;
        for f in stack.frames.iter().rev() {
            if ts >= f.start && ts <= f.end {
                return Some(f);
            }
        }
        None
    }

    /// `closeFrame(cat, frame)`：父帧累计子事件时长，自身耗时 = 总时长 − 子事件时长。
    fn close_frame(&mut self, cat: &str, name: &str, start: f64, end: f64, child: f64) {
        if let Some(gi) = self.group_of(cat, name) {
            self.groups[gi].child_us += child;
            self.groups[gi].self_us += js_max2(0.0, end - start - child);
        }
    }

    fn push_unique(list: &mut Vec<String>, v: String) {
        if !list.contains(&v) {
            list.push(v);
        }
    }

    fn upsert_attr(&mut self, key: String, entry: AttrEntry) {
        if let Some(&i) = self.kernel_attr_index.get(&key) {
            self.kernel_attr[i].count += entry.count;
            self.kernel_attr[i].kernel_us += entry.kernel_us;
            return;
        }
        self.kernel_attr_index.insert(key, self.kernel_attr.len());
        self.kernel_attr.push(entry);
    }

    // ---------------------------------------------------------------- 单事件处理

    fn process(&mut self, text: &[u8], sc: &mut Scratch) {
        if text.is_empty() || text[0] != b'{' {
            // 顶层标量/字符串元素（罕见）——只计入规模
            self.events += 1;
            return;
        }
        let ev = match parse_event_fast(text) {
            Some(e) => e,
            None => match parse_event_json_fallback(text) {
                Some(e) => e,
                None => {
                    self.events += 1;
                    return;
                }
            },
        };
        self.events += 1;
        let cat: &str = &ev.cat;
        let by_cat_key = if cat.is_empty() { "(无类别)" } else { cat };
        self.bump_category(by_cat_key);

        if ev.ph == "M" {
            // 元数据：进程/线程名与顶层开关（flags 由文件头部单独提取）
            if let Some(p) = ev.pid.as_ref() {
                self.add_process(&p.to_js_string());
            }
            if let Some(t) = ev.tid.as_ref() {
                let p = ev.pid.as_ref().map(|p| p.to_js_string()).unwrap_or_else(|| js_num_str(0.0));
                self.add_thread_key(&format!("{}:{}", p, t.to_js_string()));
            }
            return;
        }

        let name: &str = &ev.name;
        let ts = ev.ts;
        // args 按需解析（括号平衡只在该事件真要用到 args 时才跑，算过一次即记住）
        let args_cell = ev.args.map(std::cell::Cell::new);
        let args: Option<ArgsRef> = args_cell.as_ref().map(|range| ArgsRef { text, range });

        if ev.ph == "i" {
            // 瞬时事件：内存分配器事件即在此形态（`[memory]`）
            if name == "[memory]" || cat == "memory" || arg_number(args, "Bytes").is_some() {
                let bytes = arg_number(args, "Bytes").unwrap_or(0.0);
                let addr = arg_number(args, "Addr").unwrap_or(0.0);
                let device_id = arg_number(args, "Device Id").unwrap_or(0.0);
                let total_allocated = arg_number(args, "Total Allocated");
                let total_reserved = arg_number(args, "Total Reserved");
                match self.logs.as_mut() {
                    // 分块模式：显存状态全程顺序依赖（活跃集/峰值/TopK/每设备峰值），只记记录、归并时回放
                    Some(logs) => logs.mem.push(MemRec {
                        bytes,
                        addr,
                        device_id,
                        total_allocated,
                        total_reserved,
                        ts,
                    }),
                    None => apply_mem_instant(
                        &mut self.mem,
                        bytes,
                        addr,
                        device_id,
                        total_allocated,
                        total_reserved,
                        ts,
                    ),
                }
            }
            return;
        }

        if ev.ph == "s" || ev.ph == "f" {
            // 流事件：跟随其所属活动写出，按「流类型:id」配对
            let mark_id = ev.id.or_else(|| event_id_of(text));
            if let Some(id) = mark_id {
                sc.flow_key.clear();
                sc.flow_key.push_str(cat);
                sc.flow_key.push(':');
                push_js_num(&mut sc.flow_key, id);
                if self.logs.is_some() {
                    // 分块模式：配对表与「最近活动」都是全局序语义（活动可能来自上一块的最后一个 X 事件），
                    // 只记记录；`act` 为 None 表示本块尚无 X 事件，归并时用上游块携带的活动。
                    let act = self.last_activity.clone();
                    let key = sc.flow_key.clone();
                    let logs = self.logs.as_mut().unwrap();
                    logs.flow.push(FlowRec {
                        key,
                        is_fwdbwd: cat == "fwdbwd",
                        is_start: ev.ph == "s",
                        ts,
                        act,
                    });
                } else {
                    // 取走而非克隆（用完原样放回）：值语义与 `last_activity.clone()` 一致
                    let act = self.last_activity.take();
                    if cat == "fwdbwd" {
                        self.pair_fwd_bwd(&sc.flow_key, &ev.ph, act.as_ref(), ts);
                    } else if self.pair_flow(&sc.flow_key, &ev.ph, act.as_ref(), ts) {
                        self.flow_pairs += 1;
                    }
                    self.last_activity = act;
                }
            }
            return;
        }

        if ev.ph != "X" {
            return;
        }
        let dur = ev.dur;
        if !ts.is_finite() || dur < 0.0 {
            return;
        }
        // pid/tid 文本化：数值型按位相等即复用上次结果（同线程连续事件免重复格式化）
        let pid_key = ev.pid.as_ref().and_then(pid_num_key);
        let pid_reuse = pid_key.is_some() && pid_key == sc.pid_key;
        if !pid_reuse {
            sc.pid.clear();
            match ev.pid.as_ref() {
                Some(p) => p.write_js_string(&mut sc.pid),
                None => sc.pid.push('0'),
            }
            sc.pid_key = pid_key;
        }
        let tid_key = ev.tid.as_ref().and_then(pid_num_key);
        let tid_reuse = tid_key.is_some() && tid_key == sc.tid_key;
        if !tid_reuse {
            sc.tid.clear();
            match ev.tid.as_ref() {
                Some(t) => t.write_js_string(&mut sc.tid),
                None => sc.tid.push('0'),
            }
            sc.tid_key = tid_key;
        }
        let pid_s: &str = &sc.pid;
        let tid_s: &str = &sc.tid;
        // 两个键都复用时，该（进程名 / `pid:tid` 线程键）文本上一个同键事件已入账
        // （两者都是集合语义，重复入账与去重后结果相同；进程名列表顺序只取首次出现）
        if !(pid_reuse && tid_reuse) {
            self.add_process(pid_s);
            sc.thread_key.clear();
            sc.thread_key.push_str(pid_s);
            sc.thread_key.push(':');
            sc.thread_key.push_str(tid_s);
            self.add_thread_key(&sc.thread_key);
        }
        // 流事件所挂的活动（下一个非流事件若为流事件，即取此活动）
        // 复用既有 Activity 的字符串缓冲（值语义不变，逐事件零分配）
        match self.last_activity.as_mut() {
            Some(a) => {
                a.cat.clear();
                a.cat.push_str(cat);
                a.name.clear();
                a.name.push_str(name);
                a.ts = ts;
                a.dur = dur;
            }
            None => self.last_activity = Some(Activity { cat: cat.to_string(), name: name.to_string(), ts, dur }),
        }

        let is_gpu_side = cat == "kernel" || cat == "gpu_memcpy" || cat == "gpu_memset";
        self.bump_category_time(&cat, dur);

        // 时间线组件按**纳秒**语义设计（与 nsys 同口径），入参处统一换算
        // （分块模式只记区间：并集的 running-max 与分桶自适应分辨率都是全局序语义）
        let istart = ts * NS_PER_US;
        let iend = (ts + dur) * NS_PER_US;
        if is_gpu_side {
            match self.logs.as_mut() {
                Some(logs) => logs.gpu_iv.push((istart, iend)),
                None => {
                    self.gpu_union.add(istart, iend);
                    self.gpu_bins.add(istart, iend);
                }
            }
            if cat == "kernel" {
                self.kernel_events += 1;
            } else {
                self.gpu_transfer_events += 1;
            }
        } else {
            match self.logs.as_mut() {
                Some(logs) => logs.cpu_iv.push((istart, iend)),
                None => {
                    self.cpu_union.add(istart, iend);
                    self.cpu_bins.add(istart, iend);
                }
            }
        }

        // 步骤标注
        if cat == "user_annotation" && is_profiler_step(name) {
            self.steps.push((name.to_string(), dur, ts));
            match self.logs.as_mut() {
                Some(logs) => logs.step_durs.push(dur),
                None => self.step_sampler.add(dur),
            }
            return;
        }

        // 分组聚合（各 cat 的排行都用同一份分组表）
        let tracked = matches!(
            cat,
            "cpu_op" | "kernel" | "cuda_runtime" | "user_annotation" | "python_function" | "gpu_memcpy" | "gpu_memset"
        );
        if !tracked {
            return;
        }

        let g = self.ensure_group(cat, name, true);
        if let Some(gi) = g {
            // 自身耗时栈键（`类别|进程|线程`）：写入复用缓冲，逐事件零分配
            sc.stack_key.clear();
            sc.stack_key.push_str(cat);
            sc.stack_key.push('|');
            sc.stack_key.push_str(pid_s);
            sc.stack_key.push('|');
            sc.stack_key.push_str(tid_s);
            {
                let gr = &mut self.groups[gi];
                gr.count += 1;
                gr.total_us += dur;
                if dur < gr.min_us {
                    gr.min_us = dur;
                }
                if dur > gr.max_us {
                    gr.max_us = dur;
                }
                if let Some(sp) = gr.sampler.as_mut() {
                    sp.add(dur);
                }
                if cat == "cpu_op" {
                    if gr.shapes.len() < SHAPE_SAMPLES {
                        if let Some(dims) = arg_raw(args, "Input Dims") {
                            if !dims.is_empty() {
                                gr.shapes.push(normalize_shape_list(&dims));
                            }
                        }
                    }
                    if gr.dtypes.len() < SHAPE_SAMPLES {
                        if let Some(types) = arg_raw(args, "Input type") {
                            if !types.is_empty() {
                                gr.dtypes.push(normalize_type_list(&types));
                            }
                        }
                    }
                } else if cat == "kernel" || cat == "gpu_memcpy" || cat == "gpu_memset" {
                    if let Some(dev) = arg_number(args, "device") {
                        if !gr.devices.contains(&dev) {
                            gr.devices.push(dev);
                        }
                    }
                    if let Some(stream) = arg_number(args, "stream") {
                        if !gr.streams.contains(&stream) {
                            gr.streams.push(stream);
                        }
                    }
                    if cat == "kernel" && gr.grid.is_none() {
                        gr.grid = arg_raw(args, "grid").as_deref().and_then(parse_triple_text);
                        gr.block = arg_raw(args, "block").as_deref().and_then(parse_triple_text);
                        gr.registers = arg_number(args, "registers per thread");
                        gr.occupancy = arg_number(args, "est. achieved occupancy %");
                        gr.shared_memory = arg_number(args, "shared memory");
                    }
                }
            }
            if let Some(logs) = self.logs.as_mut() {
                // 分块模式：采样时长按块内顺序记录（本地下标 < SAMPLER_GROUPS 才有这条记录；
                // 归并阶段按全局序喂给全局采样器——蓄水池的逐次替换依赖全局 add 序号）
                if let Some(&idx) = logs.group_dur_index.get(&gi) {
                    logs.group_durs[idx].1.push(dur);
                }
            }
            // correlation：内核→发起算子归属（启发表跨线程）与发起上下文（cuda_runtime 事件）
            // 分块模式下只记日志：发起帧的解析放归并阶段的「按栈键回放」（同一栈键的事件序在那里完整）
            let mut corr_idx: Option<u32> = None;
            if self.chunked() {
                let corr = arg_number(args, "correlation");
                let mut entry: Option<CorrEntry> = None;
                if cat == "kernel" {
                    if let Some(corr) = corr {
                        entry = Some(CorrEntry {
                            is_launch: false,
                            gi: gi as u32,
                            name: name.to_string(),
                            corr: Some(corr),
                            dur,
                            global_gi: None,
                            res_op: None,
                            res_py: None,
                            gidx: 0,
                        });
                    }
                } else if cat == "cuda_runtime" {
                    // 发起事件恒记：launch_ops/launch_sites 与启发表都依赖它解析出的发起帧
                    entry = Some(CorrEntry {
                        is_launch: true,
                        gi: gi as u32,
                        name: name.to_string(),
                        corr,
                        dur,
                        global_gi: None,
                        res_op: None,
                        res_py: None,
                        gidx: 0,
                    });
                }
                if let Some(e) = entry {
                    let logs = self.logs.as_mut().unwrap();
                    corr_idx = Some(logs.corr.len() as u32);
                    logs.corr.push(e);
                }
            } else {
                if cat == "kernel" || cat == "gpu_memcpy" || cat == "gpu_memset" {
                    let corr = arg_number(args, "correlation");
                    if cat == "kernel" {
                        if let Some(corr) = corr {
                            if let Some(ctx) = self.launch_context.get(&fkey(corr)) {
                                let op = ctx.op.clone().unwrap_or_else(|| ctx.api.clone());
                                let key = format!("{}\u{0}{}\u{0}{}", name, op, ctx.python.clone().unwrap_or_default());
                                let entry = AttrEntry {
                                    kernel: name.to_string(),
                                    op,
                                    api: Some(ctx.api.clone()),
                                    python: ctx.python.clone(),
                                    via: "correlation",
                                    count: 1,
                                    kernel_us: dur,
                                };
                                self.upsert_attr(key, entry);
                            }
                            // 一次启动只对应一个内核：用完即删
                            self.launch_context.remove(&fkey(corr));
                        }
                    }
                }
                if cat == "cuda_runtime" {
                    // 发起上下文：同一线程上最内层的 cpu_op 帧（发起算子）与 python_function 帧（发起行）
                    // （栈键写入复用缓冲；两次查栈分别是 cpu_op / python_function 的浅栈）
                    sc.frame_key.clear();
                    sc.frame_key.push_str("cpu_op");
                    sc.frame_key.push('|');
                    sc.frame_key.push_str(pid_s);
                    sc.frame_key.push('|');
                    sc.frame_key.push_str(tid_s);
                    let op_frame = self.enclosing_frame(&sc.frame_key, ts).map(|f| f.name.clone());
                    sc.frame_key.clear();
                    sc.frame_key.push_str("python_function");
                    sc.frame_key.push('|');
                    sc.frame_key.push_str(pid_s);
                    sc.frame_key.push('|');
                    sc.frame_key.push_str(tid_s);
                    let py_frame = self.enclosing_frame(&sc.frame_key, ts).map(|f| f.name.clone());
                    {
                        let gr = &mut self.groups[gi];
                        if let Some(op) = &op_frame {
                            if gr.launch_ops.len() < LAUNCH_SITES {
                                State::push_unique(&mut gr.launch_ops, op.clone());
                            }
                        }
                        if let Some(py) = &py_frame {
                            if gr.launch_sites.len() < LAUNCH_SITES {
                                State::push_unique(&mut gr.launch_sites, py.clone());
                            }
                        }
                    }
                    if let Some(corr) = arg_number(args, "correlation") {
                        if self.launch_context.len() < MAX_FLOWS {
                            self.launch_context.insert(
                                fkey(corr),
                                LaunchCtx { api: name.to_string(), op: op_frame, python: py_frame },
                            );
                        }
                    }
                }
            }

            // 自身耗时：同类嵌套做减法（父帧记入子事件时长，关闭时自身 = 总时长 − 子事件时长）
            if self.chunked() {
                // 分块模式：帧可能跨块（懒关闭时机、跨块携带都依赖全局事件序），只记事件流；
                // 归并阶段按**（进程,线程）**回放——两类跨栈查询（cuda_runtime 找最内层 cpu_op /
                // python_function 帧）与顺序路径一致（顺序路径的键是 `类别|进程|线程`，按线程归组回放等价）。
                // 键用 `进程:线程`（与进程/线程登记的复用缓冲一致：pid/tid 都复用时键仍有效）。
                let logs = self.logs.as_mut().unwrap();
                let idx = match logs.stack_index.get(sc.thread_key.as_str()) {
                    Some(&i) => i,
                    None => {
                        let key = sc.thread_key.clone();
                        logs.stacks.push((key.clone(), Vec::new()));
                        let i = logs.stacks.len() - 1;
                        logs.stack_index.insert(key, i);
                        i
                    }
                };
                logs.stacks[idx].1.push(StackRec { gi: gi as u32, ts, dur, corr: corr_idx });
            } else {
            // 栈按键就地取用（不再 remove + insert 两次哈希、不再逐事件分配键串）；
            // 关闭帧的 String 存入该栈的缓冲池，压栈时复用，避免逐事件分配释放。
            {
                let State { groups, stacks, .. } = self;
                match stacks.get_mut(sc.stack_key.as_str()) {
                    Some(stack) => {
                        loop {
                            let close = matches!(stack.frames.last(), Some(f) if f.end <= ts);
                            if !close {
                                break;
                            }
                            let f = stack.frames.pop().unwrap();
                            close_frame_at(groups, &f);
                            stack.pool.push(f.name);
                        }
                        let mut clear = false;
                        if let Some(top) = stack.frames.last_mut() {
                            if ts >= top.start && ts + dur <= top.end {
                                top.child_us += dur;
                            } else {
                                // 与栈顶不成包含关系（乱序/跨线程交叠）：清栈，避免错误归属
                                clear = true;
                            }
                        }
                        if clear {
                            while let Some(f) = stack.frames.pop() {
                                close_frame_at(groups, &f);
                                stack.pool.push(f.name);
                            }
                        }
                        let mut nm = stack.pool.pop().unwrap_or_default();
                        nm.clear();
                        nm.push_str(name);
                        stack.frames.push(Frame { name: nm, gi, start: ts, end: ts + dur, child_us: 0.0 });
                    }
                    None => {
                        let mut stack = Stack::default();
                        stack.frames.push(Frame {
                            name: name.to_string(),
                            gi,
                            start: ts,
                            end: ts + dur,
                            child_us: 0.0,
                        });
                        stacks.insert(sc.stack_key.clone(), stack);
                    }
                }
            }
            }
        }

        // 传输聚合
        if cat == "gpu_memcpy" || cat == "gpu_memset" {
            let kind = transfer_kind(name);
            let bytes = arg_number(args, "bytes").unwrap_or(0.0);
            let idx = match self.transfer_index.get(kind.as_ref()) {
                Some(&i) => i,
                None => {
                    self.transfer_agg.push((kind.to_string(), Transfer { count: 0, bytes: 0.0, total_us: 0.0 }));
                    let i = self.transfer_agg.len() - 1;
                    self.transfer_index.insert(kind.to_string(), i);
                    i
                }
            };
            let t = &mut self.transfer_agg[idx].1;
            t.count += 1;
            t.bytes += bytes;
            t.total_us += dur;
            self.transfer_count += 1;
            self.transfer_bytes += bytes;
        }

        // python 位置
        if cat == "python_function" {
            if let Some((file, line, func)) = parse_python_site(name) {
                // 站点键 `文件:行` 写入复用缓冲（命中时零分配）
                sc.py_key.clear();
                sc.py_key.push_str(file);
                sc.py_key.push(':');
                push_js_num(&mut sc.py_key, line);
                let idx = match self.python_index.get(sc.py_key.as_str()) {
                    Some(&i) => i,
                    None => {
                        let key = sc.py_key.clone();
                        self.python_sites.push((
                            key.clone(),
                            PySite {
                                location: key.clone(),
                                file: file.to_string(),
                                line,
                                func: func.unwrap_or("(匿名)").to_string(),
                                count: 0,
                                self_us: 0.0,
                                total_us: 0.0,
                            },
                        ));
                        let i = self.python_sites.len() - 1;
                        self.python_index.insert(key, i);
                        i
                    }
                };
                let s = &mut self.python_sites[idx].1;
                s.count += 1;
                s.total_us += dur;
            }
        }
    }

    // ---------------------------------------------------------------- 流事件配对

    /// 流事件所挂活动的时长（未对齐时视为未关联）。
    fn flow_activity_of(act: Option<&Activity>, ts: f64) -> Option<Activity> {
        let a = act?;
        if !a.ts.is_finite() || (a.ts - ts).abs() > 0.001 {
            return None;
        }
        Some(a.clone())
    }

    fn pair_fwd_bwd(&mut self, key: &str, ph: &str, act: Option<&Activity>, ts: f64) {
        if !ts.is_finite() {
            return;
        }
        if ph == "s" {
            if self.fwd_bwd_open.len() < MAX_FWDBWD_MARKS {
                self.fwd_bwd_open.insert(
                    key.to_string(),
                    FwdOpen { ts, act: State::flow_activity_of(act, ts) },
                );
            }
            return;
        }
        let Some(start) = self.fwd_bwd_open.remove(key) else {
            return;
        };
        if self.fwd_bwd_marks.len() >= MAX_FWDBWD_MARKS {
            return;
        }
        let backward = State::flow_activity_of(act, ts);
        self.fwd_bwd_marks.push(Mark {
            forward_us: start.act.as_ref().map(|a| a.dur).unwrap_or(0.0),
            backward_us: backward.as_ref().map(|a| a.dur).unwrap_or(0.0),
            forward_name: start.act.as_ref().map(|a| a.name.clone()),
            backward_name: backward.as_ref().map(|a| a.name.clone()),
            ts_us: start.act.as_ref().map(|a| a.ts).unwrap_or(start.ts),
        });
    }

    /// 返回是否完成一次配对（flowPairs 计数口径）。
    fn pair_flow(&mut self, key: &str, ph: &str, act: Option<&Activity>, ts: f64) -> bool {
        if ph == "s" {
            if self.flow_open.len() < MAX_FLOW_PAIRS {
                self.flow_open.insert(
                    key.to_string(),
                    FlowOpen {
                        cat: act.map(|a| a.cat.clone()).unwrap_or_default(),
                        name: act.map(|a| a.name.clone()),
                    },
                );
            }
            return false;
        }
        let Some(start) = self.flow_open.remove(key) else {
            return false;
        };
        let end = State::flow_activity_of(act, ts);
        let end = match end {
            Some(e) => e,
            None => return true,
        };
        if !(end.cat == "kernel" || end.cat == "gpu_memcpy" || end.cat == "gpu_memset") {
            return true;
        }
        let launcher = match start.name {
            Some(n) => n,
            None => return true,
        };
        if launcher.is_empty() || end.name.is_empty() {
            return true;
        }
        if let Some(&i) = self.flow_link_index.get(&end.name) {
            self.flow_link[i].1.count += 1;
        } else if self.flow_link.len() < MAX_FLOWS {
            self.flow_link.push((end.name.clone(), FlowLink { launcher, count: 1 }));
            let i = self.flow_link.len() - 1;
            self.flow_link_index.insert(end.name.clone(), i);
        }
        true
    }
}

// ==================================================================================
// 八、trace 顶层开关（`readTraceFlags`）：`traceEvents` 数组之外，单独从文件头部提取
// ==================================================================================

const FLAG_KEYS: [&str; 6] = [
    "schemaVersion",
    "profile_memory",
    "with_stack",
    "record_shapes",
    "with_modules",
    "traceName",
];

fn read_trace_flags(buf: &[u8], gz: bool) -> Vec<(String, Json)> {
    // gzip 变体先解压再匹配（TensorBoard 产物默认 gzip）；非 gzip 直接取前 8192 字节
    let head: String = if gz {
        String::from_utf8_lossy(buf).chars().take(8_192).collect()
    } else {
        let n = buf.len().min(8_192);
        String::from_utf8_lossy(&buf[..n]).into_owned()
    };
    let hb = head.as_bytes();
    let mut flags: Vec<(String, Json)> = Vec::new();
    let mut i = 0usize;
    while i < hb.len() {
        if hb[i] != b'"' {
            i += 1;
            continue;
        }
        let mut hit: Option<(&str, usize)> = None;
        for k in FLAG_KEYS {
            if head[i + 1..].starts_with(k) {
                let after = i + 1 + k.len();
                if after < hb.len() && hb[after] == b'"' {
                    hit = Some((k, after + 1));
                    break;
                }
            }
        }
        let Some((key, mut p)) = hit else {
            i += 1;
            continue;
        };
        while p < hb.len() && is_ws_js(hb[p]) {
            p += 1;
        }
        if p >= hb.len() || hb[p] != b':' {
            i += 1;
            continue;
        }
        p += 1;
        while p < hb.len() && is_ws_js(hb[p]) {
            p += 1;
        }
        let vstart = p;
        let parsed: Option<(Json, usize)> = if p < hb.len() && hb[p] == b'"' {
            let mut j = p + 1;
            while j < hb.len() && hb[j] != b'"' {
                j += 1;
            }
            if j < hb.len() {
                Some((jstr(&head[p + 1..j]), j + 1))
            } else {
                None
            }
        } else if head[p..].starts_with("true") {
            Some((Json::Bool(true), p + 4))
        } else if head[p..].starts_with("false") {
            Some((Json::Bool(false), p + 5))
        } else {
            let mut j = p;
            if j < hb.len() && hb[j] == b'-' {
                j += 1;
            }
            let d0 = j;
            while j < hb.len() && hb[j].is_ascii_digit() {
                j += 1;
            }
            if j == d0 {
                None
            } else if j + 1 < hb.len() && hb[j] == b'.' && hb[j + 1].is_ascii_digit() {
                j += 1;
                while j < hb.len() && hb[j].is_ascii_digit() {
                    j += 1;
                }
                Some((jnum(js_number(&head[p..j])), j))
            } else {
                Some((jnum(js_number(&head[p..j])), j))
            }
        };
        match parsed {
            Some((v, next)) => {
                if let Some(slot) = flags.iter_mut().find(|(k, _)| k == key) {
                    slot.1 = v;
                } else {
                    flags.push((key.to_string(), v));
                }
                i = next.max(vstart + 1);
            }
            None => {
                i += 1;
            }
        }
    }
    flags
}

// ==================================================================================
// 九、字节级扫描（jsonstream.ts 的状态机，&[u8] 版）
// ==================================================================================

/// 扫描 `"traceEvents": [ ... ]` 并逐个元素交给 `emit`；返回 (最后元素结束偏移, 元素数, 是否因预算中止)。
fn scan_elements<F: FnMut(&[u8])>(
    buf: &[u8],
    mut emit: F,
    mut over_budget: impl FnMut() -> bool,
) -> Result<(usize, u64, bool), String> {
    let key = b"\"traceEvents\"";
    let n = buf.len();
    let mut pos = 0usize;
    let mut state = 0u8; // 0=找键 1=找数组起点 2=数组内 3=结束
    let mut key_match = 0usize;
    let mut in_element = false;
    let mut depth: i64 = 0;
    let mut in_string = false;
    let mut escaped = false;
    let mut element_start = 0usize;
    let mut found = false;
    let mut items: u64 = 0;
    let mut last_end = 0usize;
    let mut aborted = false;
    let mut since_check = 0u64;

    while pos < n {
        let c = buf[pos];
        if state == 0 {
            if c == key[key_match] {
                key_match += 1;
                pos += 1;
                if key_match == key.len() {
                    state = 1;
                    key_match = 0;
                }
            } else {
                key_match = if c == key[0] { 1 } else { 0 };
                pos += 1;
            }
            continue;
        }
        if state == 1 {
            if c == b'[' {
                state = 2;
                found = true;
                pos += 1;
                continue;
            }
            if c == b':' || is_ws4(c) {
                pos += 1;
                continue;
            }
            state = 0;
            key_match = 0;
            continue;
        }
        if state == 3 {
            break;
        }
        // state === 2：数组内
        if !in_element {
            if is_ws4(c) || c == b',' {
                pos += 1;
                continue;
            }
            if c == b']' {
                state = 3;
                pos += 1;
                continue;
            }
            in_element = true;
            element_start = pos;
            depth = 0;
            in_string = false;
            escaped = false;
        }
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
            pos += 1;
            continue;
        }
        if c == b'"' {
            in_string = true;
            pos += 1;
            continue;
        }
        if c == b'{' || c == b'[' {
            depth += 1;
            pos += 1;
            continue;
        }
        if c == b'}' || c == b']' {
            depth -= 1;
            pos += 1;
            if depth == 0 {
                let text = &buf[element_start..pos];
                if text.len() > MAX_ITEM_BYTES {
                    return Err(format!(
                        "trace 元素超过 {} MB 上限，疑似格式异常（键：traceEvents）",
                        MAX_ITEM_BYTES / 1048576
                    ));
                }
                items += 1;
                last_end = pos;
                in_element = false;
                since_check += 1;
                if since_check >= 4_096 {
                    since_check = 0;
                    if over_budget() {
                        aborted = true;
                        break;
                    }
                }
                emit(text);
                continue;
            }
            if depth < 0 {
                // 结构异常（多余闭合符）：结束数组，避免误吞后续内容
                in_element = false;
                state = 3;
                continue;
            }
            continue;
        }
        // 顶层标量元素：以分隔符结束
        if depth == 0 && (c == b',' || c == b']' || is_ws4(c)) {
            let text = &buf[element_start..pos];
            items += 1;
            last_end = pos;
            in_element = false;
            since_check += 1;
            if since_check >= 4_096 {
                since_check = 0;
                if over_budget() {
                    aborted = true;
                    break;
                }
            }
            emit(text);
            if c == b']' {
                state = 3;
                pos += 1;
            } else if c == b',' {
                pos += 1;
            }
            continue;
        }
        pos += 1;
    }
    if !found {
        return Err(
            "未在文件中找到 \"traceEvents\" 数组——这不是预期的 Chrome Trace（PyTorch Profiler）格式。\
             请确认导出方式：torch.profiler.profile(...).export_chrome_trace(path) 或 TensorBoard 的 *.pt.trace.json(.gz)。"
                .to_string(),
        );
    }
    Ok((last_end, items, aborted))
}

// ==================================================================================
// 十、前向/反向拆分（`buildFwdBwdFacts`）
// ==================================================================================

fn build_fwd_bwd(marks: &[Mark], steps: &[(String, f64, f64)]) -> Json {
    let mut forward_us = 0.0;
    let mut backward_us = 0.0;
    let mut forward_count: u64 = 0;
    let mut backward_count: u64 = 0;
    let mut linked: u64 = 0;
    let mut samples: Vec<(f64, Json)> = Vec::new();
    for m in marks {
        if m.forward_us > 0.0 || m.backward_us > 0.0 {
            linked += 1;
        }
        if m.forward_us > 0.0 {
            forward_us += m.forward_us;
            forward_count += 1;
        }
        if m.backward_us > 0.0 {
            backward_us += m.backward_us;
            backward_count += 1;
        }
        if m.forward_name.is_some() || m.backward_name.is_some() {
            samples.push((
                m.backward_us,
                Json::obj(vec![
                    ("forward", jstr(m.forward_name.as_deref().unwrap_or("(未知)"))),
                    ("backward", jstr(m.backward_name.as_deref().unwrap_or("(未知)"))),
                    ("forwardUs", jnum(m.forward_us)),
                    ("backwardUs", jnum(m.backward_us)),
                ]),
            ));
        }
    }
    samples.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let samples: Vec<Json> = samples.into_iter().take(5).map(|s| s.1).collect();

    let mut sorted: Vec<&Mark> = marks.iter().collect();
    sorted.sort_by(|a, b| a.ts_us.partial_cmp(&b.ts_us).unwrap_or(std::cmp::Ordering::Equal));
    let mut buckets: Vec<(String, f64, f64)> = Vec::new();
    let mut index: FastMap<String, usize> = FastMap::default();
    if !steps.is_empty() {
        let mut windows: Vec<&(String, f64, f64)> = steps.iter().collect();
        windows.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
        let mut w = 0usize;
        for m in sorted {
            while w < windows.len() && windows[w].2 + windows[w].1 <= m.ts_us {
                w += 1;
            }
            let Some(win) = windows.get(w) else { continue };
            // 配对落在步窗口内才归属（步外配对只进总量，不伪造步）
            if m.ts_us < win.2 || m.ts_us > win.2 + win.1 {
                continue;
            }
            let at = match index.get(&win.0) {
                Some(&i) => i,
                None => {
                    let i = buckets.len();
                    buckets.push((win.0.clone(), 0.0, 0.0));
                    index.insert(win.0.clone(), i);
                    i
                }
            };
            buckets[at].1 += m.forward_us;
            buckets[at].2 += m.backward_us;
        }
    } else {
        for m in sorted {
            buckets.push((format!("配对 #{}", buckets.len()), m.forward_us, m.backward_us));
        }
    }

    let total = forward_us + backward_us;
    Json::obj(vec![
        ("available", Json::Bool(linked > 0)),
        ("marks", jnum(marks.len() as f64)),
        ("linked", jnum(linked as f64)),
        ("forwardUs", jnum(forward_us)),
        ("backwardUs", jnum(backward_us)),
        ("forwardCount", jnum(forward_count as f64)),
        ("backwardCount", jnum(backward_count as f64)),
        (
            "backwardShare",
            jnum(if total > 0.0 { backward_us / total } else { 0.0 }),
        ),
        (
            "avgForwardUs",
            jnum(if forward_count > 0 { forward_us / forward_count as f64 } else { 0.0 }),
        ),
        (
            "avgBackwardUs",
            jnum(if backward_count > 0 { backward_us / backward_count as f64 } else { 0.0 }),
        ),
        ("samples", Json::Arr(samples)),
        (
            "perStep",
            Json::Arr(
                buckets
                    .into_iter()
                    .map(|(step, f, b)| {
                        let t = f + b;
                        Json::obj(vec![
                            ("step", Json::Str(step)),
                            ("forwardUs", jnum(f)),
                            ("backwardUs", jnum(b)),
                            ("backwardShare", jnum(if t > 0.0 { b / t } else { 0.0 })),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}

// ==================================================================================
// 十一、聚合输出（与 aggregateTorchTrace 的返回结构逐字段一致）
// ==================================================================================

fn stat_json(g: &GroupAcc) -> Json {
    let p50 = match &g.sampler {
        Some(s) => s.quantile(0.5),
        None => {
            if g.count > 0 {
                g.total_us / g.count as f64
            } else {
                0.0
            }
        }
    };
    let p50_sampled = match &g.sampler {
        Some(s) => s.sampled,
        None => true,
    };
    let mut fields: Vec<(&str, Json)> = vec![
        ("cat", jstr(&g.cat)),
        ("name", jstr(&g.name)),
        ("count", jnum(g.count as f64)),
        ("totalUs", jnum(g.total_us)),
        ("selfUs", jnum(g.self_us)),
        ("minUs", jnum(if g.min_us.is_finite() { g.min_us } else { 0.0 })),
        ("maxUs", jnum(g.max_us)),
        ("p50Us", jnum(p50)),
        ("p50Sampled", Json::Bool(p50_sampled)),
        (
            "devices",
            Json::Arr({
                let mut d = g.devices.clone();
                d.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                d.into_iter().map(jnum).collect()
            }),
        ),
        (
            "streams",
            Json::Arr({
                let mut s = g.streams.clone();
                s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                s.into_iter().map(jnum).collect()
            }),
        ),
        ("shapeSamples", Json::Arr(g.shapes.iter().map(|s| jstr(s)).collect())),
        ("dtypeSamples", Json::Arr(g.dtypes.iter().map(|s| jstr(s)).collect())),
        ("launchSites", Json::Arr(g.launch_sites.iter().map(|s| jstr(s)).collect())),
        ("launchOps", Json::Arr(g.launch_ops.iter().map(|s| jstr(s)).collect())),
    ];
    if let Some(gr) = g.grid {
        fields.push(("grid", Json::Arr(gr.iter().map(|v| jnum(*v)).collect())));
    }
    if let Some(bl) = g.block {
        fields.push(("block", Json::Arr(bl.iter().map(|v| jnum(*v)).collect())));
    }
    if let Some(r) = g.registers {
        fields.push(("registers", jnum(r)));
    }
    if let Some(o) = g.occupancy {
        fields.push(("occupancy", jnum(o)));
    }
    if let Some(s) = g.shared_memory {
        fields.push(("sharedMemory", jnum(s)));
    }
    Json::obj(fields)
}

fn str_array(v: &[String]) -> Json {
    Json::Arr(v.iter().map(|s| jstr(s)).collect())
}

// ==================================================================================
// 十一之二、分块并行（rayon）：结构摘要 → 精确块起点 → 块内采集 → 有序归并
// ==================================================================================
//
// 三个事实决定了这里的做法：
// ① **块起点不能猜**：扫描器状态（括号深度 + 字符串/转义）决定元素边界，猜错就会把嵌套对象
//    当成顶层元素（静默污染结果）。故先并行算「块间结构摘要」，再顺序合成得到每个块起点的
//    **精确**状态（K 步，与字节数无关），块内沿用同一套状态机。
// ② **元素归属按起点**：元素起点落在本块范围就归本块，跨块的那个元素由本块扫完；
//    下一块从自己的起点起扫时把「起点之前已开始」的片段整段跳过（不重复计入）。
// ③ **顺序依赖状态由日志回放**：块内只算可交换的部分（计数/求和/min/max、分组统计、
//    类别统计、python 位置、传输聚合…），顺序依赖的部分（浅栈自身耗时、采样器蓄水池、
//    时间线并集与分桶、显存活跃集与 TopK、flow 配对与全局活动、correlation 启发表）
//    记紧凑日志，归并阶段按全局序用**同一批 helper** 回放——语义只有一份实现。

/// 小于此体积且未显式指定线程数时走单趟直接路径（并行开销不划算）。
const PARALLEL_MIN_BYTES: usize = 4 * 1024 * 1024;

/// 块起点状态（相对 `traceEvents` 数组的括号深度 + 字符串态）。
/// `depth`：未闭合的 `{`/`[` 计数（**含数组自身的 `[`**）——1 = 数组层级（元素之间），
/// ≥2 = 元素内部（值 − 1 即扫描器元素内相对深度），0 = 数组已结束。
#[derive(Clone, Copy)]
struct ChunkStart {
    depth: i64,
    in_string: bool,
    escaped: bool,
}

/// 16 字节「结构字符」掩码（SSE2：x86_64 基线指令集，无需运行时特征检测）。
/// 置位 = 该字节**可能**是结构字符（`"` / `\` / `[` / `{` / `]` / `}`）；只允许**多报**
/// （`|` 会被当作 `\`），绝不允许漏报——多报只是回到逐字节处理这一字节，不影响结果。
/// 串内只需盯 `"` 与 `\`（其余字节不改状态），因而串内掩码更窄、更快。
#[cfg(target_arch = "x86_64")]
#[inline]
fn struct_mask16(buf: &[u8], i: usize, in_string: bool) -> u32 {
    use std::arch::x86_64::*;
    unsafe {
        let v = _mm_loadu_si128(buf.as_ptr().add(i) as *const __m128i);
        let quote = _mm_cmpeq_epi8(v, _mm_set1_epi8(0x22));
        let esc = _mm_cmpeq_epi8(v, _mm_set1_epi8(0x5Cu8 as i8));
        let m = if in_string {
            _mm_or_si128(quote, esc)
        } else {
            // `[`(0x5B)/`{`(0x7B) 与 `]`(0x5D)/`}`(0x7D) 各只差 bit5：抹掉后各一次比较即可
            let vm = _mm_and_si128(v, _mm_set1_epi8(0xDFu8 as i8));
            let open = _mm_cmpeq_epi8(vm, _mm_set1_epi8(0x5Bu8 as i8));
            let close = _mm_cmpeq_epi8(vm, _mm_set1_epi8(0x5Du8 as i8));
            _mm_or_si128(_mm_or_si128(quote, esc), _mm_or_si128(open, close))
        };
        _mm_movemask_epi8(m) as u32
    }
}

/// 非 x86_64 回退：8 字节 SWAR 判定（与 SSE2 版同语义，只是慢些）。
#[cfg(not(target_arch = "x86_64"))]
#[inline]
fn struct_mask_swar(buf: &[u8], i: usize, in_string: bool) -> bool {
    let w = u64::from_le_bytes(buf[i..i + 8].try_into().unwrap());
    let word_has = |c: u8| has_zero_byte(w ^ (c as u64).wrapping_mul(0x0101_0101_0101_0101));
    if in_string {
        word_has(b'"') || word_has(b'\\')
    } else {
        word_has(b'"') || word_has(b'\\') || word_has(b'{') || word_has(b'}') || word_has(b'[') || word_has(b']')
    }
}

/// 结构摘要：在给定字符串入态下扫过 `[s,e)`，给出（括号深度增量, 出态在串内, 出态转义中）。
/// 状态机语义与 `scan_elements`/`scan_chunk` 一致（字符串感知的括号平衡）。
/// 快跳：整段不含结构字符的字节对状态机毫无影响，用 SIMD 掩码一次躍过 16 字节（无则下一次
/// 加载），只在掩码置位的字节上跑逐字节状态机——纯文本区占比高的 trace 上比逐字节快数倍。
fn structural_summary(buf: &[u8], s: usize, e: usize, mut in_string: bool, mut escaped: bool) -> (i64, bool, bool) {
    let mut depth: i64 = 0;
    let n = buf.len().min(e);
    let mut i = s.min(n);
    while i < n {
        #[cfg(target_arch = "x86_64")]
        if !escaped && i + 16 <= n {
            let mask = struct_mask16(buf, i, in_string);
            if mask == 0 {
                i += 16;
                continue;
            }
            // 躍到本 16 字节组里第一个可能的字符结构字节
            i += mask.trailing_zeros() as usize;
        }
        #[cfg(not(target_arch = "x86_64"))]
        if !escaped && i + 8 <= n && !struct_mask_swar(buf, i, in_string) {
            i += 8;
            continue;
        }
        let c = buf[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => in_string = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    (depth, in_string, escaped)
}

/// 找 `"traceEvents"` 数组**内容起点**（`[` 之后一位）。
/// 语义对齐 `scan_elements` 的头部：键后允许空白与 `:`，再要求 `[`；不成立则从下一处键继续。
fn find_array_start(buf: &[u8]) -> Option<usize> {
    let key = b"\"traceEvents\"";
    let mut from = 0usize;
    while from < buf.len() {
        let pos = find_sub(&buf[from..], key)?;
        let mut p = from + pos + key.len();
        while p < buf.len() && is_ws4(buf[p]) {
            p += 1;
        }
        if p < buf.len() && buf[p] == b':' {
            p += 1;
            while p < buf.len() && is_ws4(buf[p]) {
                p += 1;
            }
            if p < buf.len() && buf[p] == b'[' {
                return Some(p + 1);
            }
        }
        from += pos + 1;
    }
    None
}

/// 该位置是否落在元素起点（前一个非空白字节是 `,` 或 `[`；行首视为是）。
fn at_element_boundary(buf: &[u8], pos: usize) -> bool {
    let mut i = pos;
    while i > 0 {
        let c = buf[i - 1];
        if is_ws4(c) {
            i -= 1;
            continue;
        }
        return c == b',' || c == b'[';
    }
    true
}

/// 分块计划：把数组内容切成 K 段，给出每段起点与**精确**起扫状态。
fn plan_chunks(buf: &[u8], array_start: usize, k: usize) -> (Vec<usize>, Vec<ChunkStart>) {
    let n = buf.len();
    let k = k.max(1);
    let span = n.saturating_sub(array_start);
    let mut starts: Vec<usize> = Vec::with_capacity(k);
    for i in 0..k {
        let s = array_start + span * i / k;
        if starts.last().map(|&p| s > p).unwrap_or(true) {
            starts.push(s);
        }
    }
    if starts.is_empty() {
        starts.push(array_start);
    }
    let m = starts.len();
    let segs: Vec<(usize, usize)> = (0..m)
        .map(|i| (starts[i], if i + 1 < m { starts[i + 1] } else { n }))
        .collect();
    // 第一遍：只算「串外」入态的摘要（并行）。块起点落在字符串内部是罕见情形，按需补算。
    let out_sums: Vec<(i64, bool, bool)> = segs
        .par_iter()
        .map(|&(s, e)| structural_summary(buf, s, e, false, false))
        .collect();
    let mut in_sums: Vec<Option<(i64, bool, bool)>> = vec![None; m];
    // 顺序合成（K 步，与字节数无关）：得到每块的精确起点状态
    let mut states: Vec<ChunkStart> = Vec::with_capacity(m);
    let mut cur = ChunkStart { depth: 1, in_string: false, escaped: false };
    for i in 0..m {
        states.push(cur);
        let (s, e) = segs[i];
        if cur.in_string && in_sums[i].is_none() {
            // 罕见：本块起点在字符串内部——为 i..m 补算「串内」摘要（并行一次）
            let tail: Vec<(i64, bool, bool)> = segs[i..]
                .par_iter()
                .map(|&(s, e)| structural_summary(buf, s, e, true, false))
                .collect();
            for (k, v) in tail.into_iter().enumerate() {
                in_sums[i + k] = Some(v);
            }
        }
        let (dd, ins, esc) = if cur.in_string {
            if cur.escaped {
                // 起点字节被上一块末尾的反斜杠转义：先吃掉它，再按串内继续
                if s + 1 <= e {
                    structural_summary(buf, s + 1, e, true, false)
                } else {
                    (0, true, false)
                }
            } else {
                in_sums[i].unwrap()
            }
        } else {
            out_sums[i]
        };
        cur = ChunkStart { depth: cur.depth + dd, in_string: ins, escaped: esc };
    }
    (starts, states)
}

/// 块内扫描：从 `start`（已知精确状态 `st`）扫起，只处理**起点 < `next_start`** 的元素
/// （跨界的那个元素扫完为止），遇到数组结束 `]` 即停。
/// 返回（最后一个元素的结束位置, 元素数, 是否因预算中止, 数组是否已结束）。
fn scan_chunk<F: FnMut(&[u8])>(
    buf: &[u8],
    start: usize,
    next_start: usize,
    st: ChunkStart,
    mut emit: F,
    mut over_budget: impl FnMut() -> bool,
) -> Result<(usize, u64, bool, bool), String> {
    let n = buf.len();
    if st.depth <= 0 {
        // 数组在本块之前就结束了（尾部对象/多余内容）：本块不产出元素
        return Ok((0, 0, false, true));
    }
    let mut pos = start.min(n);
    let mut depth = st.depth;
    let mut in_string = st.in_string;
    let mut escaped = st.escaped;
    let mut in_element = false;
    let mut container = false;
    let mut element_start = 0usize;
    let mut items: u64 = 0;
    let mut last_end = 0usize;
    let mut aborted = false;
    let mut since_check: u64 = 0;
    let mut array_ended = false;

    // ---- 前缀跳过：把「起点之前已开始」的片段整段跳过（它归上一块产出）----
    if in_string || depth >= 2 || !at_element_boundary(buf, pos) {
        loop {
            if pos >= n {
                return Ok((0, 0, false, true));
            }
            let c = buf[pos];
            if in_string {
                if escaped {
                    escaped = false;
                } else if c == b'\\' {
                    escaped = true;
                } else if c == b'"' {
                    in_string = false;
                }
                pos += 1;
                continue;
            }
            if depth >= 2 {
                match c {
                    b'"' => in_string = true,
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth <= 1 {
                            pos += 1;
                            break;
                        }
                    }
                    _ => {}
                }
                pos += 1;
                continue;
            }
            // depth == 1：可能是标量元素的中段
            match c {
                b'"' => in_string = true,
                b']' => {
                    return Ok((0, 0, false, true));
                }
                b',' => {
                    pos += 1;
                    break;
                }
                _ => {}
            }
            pos += 1;
        }
    }

    while pos < n {
        let c = buf[pos];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
            pos += 1;
            continue;
        }
        if !in_element {
            if is_ws4(c) || c == b',' {
                pos += 1;
                continue;
            }
            if c == b']' {
                array_ended = true;
                break;
            }
            // 元素起点已越出本块范围：停（跨界的那个元素已在上一次迭代里扫完）
            if pos >= next_start {
                break;
            }
            in_element = true;
            container = c == b'{' || c == b'[';
            element_start = pos;
        }
        if c == b'"' {
            in_string = true;
            pos += 1;
            continue;
        }
        if c == b'{' || c == b'[' {
            depth += 1;
            pos += 1;
            continue;
        }
        if c == b'}' || c == b']' {
            depth -= 1;
            pos += 1;
            if depth == 1 && container {
                let text = &buf[element_start..pos];
                if text.len() > MAX_ITEM_BYTES {
                    return Err(format!(
                        "trace 元素超过 {} MB 上限，疑似格式异常（键：traceEvents）",
                        MAX_ITEM_BYTES / 1048576
                    ));
                }
                items += 1;
                last_end = pos;
                in_element = false;
                since_check += 1;
                if since_check >= 4_096 {
                    since_check = 0;
                    if over_budget() {
                        aborted = true;
                        break;
                    }
                }
                emit(text);
                continue;
            }
            if depth < 1 {
                // 结构异常（多余闭合符）：结束数组，避免误吞后续内容
                array_ended = true;
                break;
            }
            continue;
        }
        // 顶层标量元素：以分隔符结束
        if !container && (c == b',' || c == b']' || is_ws4(c)) {
            let text = &buf[element_start..pos];
            items += 1;
            last_end = pos;
            in_element = false;
            since_check += 1;
            if since_check >= 4_096 {
                since_check = 0;
                if over_budget() {
                    aborted = true;
                    break;
                }
            }
            emit(text);
            if c == b']' {
                array_ended = true;
                break;
            }
            if c == b',' {
                pos += 1;
            }
            continue;
        }
        pos += 1;
    }
    Ok((last_end, items, aborted, array_ended))
}

/// 并行度：`TORCH_NATIVE_THREADS`（未设置 = 自动：小文件走单趟直接路径；
/// 设置 = 精确使用该值，`1` 即单趟——A/B 校验靠它）。
fn native_threads(buf_len: usize) -> usize {
    match std::env::var("TORCH_NATIVE_THREADS").ok().and_then(|s| s.trim().parse::<usize>().ok()) {
        Some(n) => n.max(1),
        None => {
            if buf_len < PARALLEL_MIN_BYTES {
                return 1;
            }
            std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).max(1)
        }
    }
}

/// 分块并行采集 + 有序归并。
fn collect_chunked(
    buf: &[u8],
    budget_ms: f64,
    t0: Instant,
    probe: &str,
    threads: usize,
) -> Result<(State, usize, bool), String> {
    let array_start = match find_array_start(buf) {
        Some(p) => p,
        None => {
            return Err(
                "未在文件中找到 \"traceEvents\" 数组——这不是预期的 Chrome Trace（PyTorch Profiler）格式。\
                 请确认导出方式：torch.profiler.profile(...).export_chrome_trace(path) 或 TensorBoard 的 *.pt.trace.json(.gz)。"
                    .to_string(),
            )
        }
    };
    let (starts, states) = plan_chunks(buf, array_start, threads);
    let t_plan = t0.elapsed().as_secs_f64() * 1000.0;
    let budgeted = budget_ms > 0.0;
    let outs: Vec<Result<(State, usize, bool), String>> = (0..starts.len())
        .into_par_iter()
        .map(|i| {
            let next = if i + 1 < starts.len() { starts[i + 1] } else { buf.len() };
            let mut st = State::new_chunked();
            let mut sc = Scratch::default();
            let (last_end, _items, aborted, _ended) = scan_chunk(
                buf,
                starts[i],
                next,
                states[i],
                |text| match probe {
                    "noop" => {}
                    "parse" => {
                        st.events += 1;
                        let _ = parse_event_fast(text);
                    }
                    _ => st.process(text, &mut sc),
                },
                || budgeted && t0.elapsed().as_secs_f64() * 1000.0 > budget_ms,
            )?;
            st.last_item_end = last_end;
            Ok((st, last_end, aborted))
        })
        .collect();
    let mut chunks: Vec<State> = Vec::with_capacity(outs.len());
    let mut last_end = 0usize;
    let mut aborted = false;
    for o in outs {
        let (st, le, ab) = o?;
        if le > last_end {
            last_end = le;
        }
        aborted |= ab;
        chunks.push(st);
    }
    let t_chunks = t0.elapsed().as_secs_f64() * 1000.0;
    let g = merge_chunks(chunks);
    if std::env::var("TORCH_BENCH_PHASES").is_ok() {
        let t_end = t0.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "[phase] threads={} plan={:.0}ms chunks={:.0}ms merge={:.0}ms total={:.0}ms",
            threads,
            t_plan,
            t_chunks - t_plan,
            t_end - t_chunks,
            t_end
        );
    }
    Ok((g, last_end, aborted))
}

/// 单线程回放出来的帧（只带全局分组下标：帧名从全局分组表取）。
struct FrameRT {
    gi: u32,
    start: f64,
    end: f64,
    child_us: f64,
}

/// 单（进程,线程）回放结果。
struct ThreadReplayOut {
    /// （全局分组下标, childUs, selfUs）——已按分组累加（各线程互不干扰，无并发写冲突）
    acc: Vec<(u32, f64, f64)>,
    /// （corr 全局序下标, 发起算子帧名, 发起 python 帧名）
    resolved: Vec<(u32, Option<String>, Option<String>)>,
    /// 回放结束时仍打开的帧（交给顺序阶段按收尾 1 的语义处理：栈键按 `\u{0}` 拆类别 → 实际不命中）
    leftover: Vec<(String, String, f64, f64, f64)>,
}

/// 最内层包含 `ts` 的帧名（与 `State::enclosing_frame` 同语义：自顶向下、边界含等号）。
fn enclosing_name(
    stacks: &FastMap<String, Vec<FrameRT>>,
    cat: &str,
    ts: f64,
    names: &[(String, String)],
) -> Option<String> {
    let frames = stacks.get(cat)?;
    for f in frames.iter().rev() {
        if ts >= f.start && ts <= f.end {
            return Some(names[f.gi as usize].1.clone());
        }
    }
    None
}

/// 按（进程,线程）回放事件流：自身耗时（懒关闭 + 包含关系 + 清栈）与发起帧解析。
/// 逐条对应 `State::process` 里的顺序实现（只把「分组下标」换成了全局下标、把帧名换成查表）。
fn replay_thread(
    key: &str,
    segs: &[(usize, usize)],
    chunks: &[State],
    names: &[(String, String)],
) -> ThreadReplayOut {
    let mut stacks: FastMap<String, Vec<FrameRT>> = FastMap::default();
    let mut acc: FastMap<u32, (f64, f64)> = FastMap::default();
    let mut resolved: Vec<(u32, Option<String>, Option<String>)> = Vec::new();
    for &(cidx, sidx) in segs {
        let logs = chunks[cidx].logs.as_ref().unwrap();
        for r in &logs.stacks[sidx].1 {
            let gi = r.gi;
            if gi == u32::MAX {
                // 该分组被 MAX_GROUPS 截断：顺序路径整块（含关闭循环）跳过
                continue;
            }
            let cat: &str = names[gi as usize].0.as_str();
            // 1) 发起事件：最内层 cpu_op / python_function 帧（与顺序路径同序：压栈之前、关闭循环尚未跑）
            if let Some(ci) = r.corr {
                let e = &logs.corr[ci as usize];
                if e.is_launch {
                    let op = enclosing_name(&stacks, "cpu_op", r.ts, names);
                    let py = enclosing_name(&stacks, "python_function", r.ts, names);
                    resolved.push((e.gidx, op, py));
                }
            }
            // 2) 关闭循环（懒关闭）+ 包含关系 + 压栈
            let frames = stacks.entry(cat.to_string()).or_default();
            loop {
                let close = matches!(frames.last(), Some(f) if f.end <= r.ts);
                if !close {
                    break;
                }
                let f = frames.pop().unwrap();
                let a = acc.entry(f.gi).or_insert((0.0, 0.0));
                a.0 += f.child_us;
                a.1 += js_max2(0.0, f.end - f.start - f.child_us);
            }
            let mut clear = false;
            if let Some(top) = frames.last_mut() {
                if r.ts >= top.start && r.ts + r.dur <= top.end {
                    top.child_us += r.dur;
                } else {
                    clear = true;
                }
            }
            if clear {
                while let Some(f) = frames.pop() {
                    let a = acc.entry(f.gi).or_insert((0.0, 0.0));
                    a.0 += f.child_us;
                    a.1 += js_max2(0.0, f.end - f.start - f.child_us);
                }
            }
            frames.push(FrameRT { gi, start: r.ts, end: r.ts + r.dur, child_us: 0.0 });
        }
    }
    let mut leftover: Vec<(String, String, f64, f64, f64)> = Vec::new();
    for (cat, frames) in stacks.iter_mut() {
        let whole = format!("{}|{}", cat, key);
        for f in frames.drain(..) {
            leftover.push((whole.clone(), names[f.gi as usize].1.clone(), f.start, f.end, f.child_us));
        }
    }
    ThreadReplayOut {
        acc: acc.into_iter().map(|(gi, (c, s))| (gi, c, s)).collect(),
        resolved,
        leftover,
    }
}

/// 有序归并：块序 = 全局序。可交换部分按块序叠加（保留首现序与「前 N 样本」语义），
/// 顺序依赖部分按全局序回放日志（与顺序路径共用同一批 helper）。
fn merge_chunks(mut chunks: Vec<State>) -> State {
    let nchunks = chunks.len();
    let mut g = State::new();
    let t_m0 = Instant::now();
    let dbg = std::env::var("TORCH_BENCH_PHASES").is_ok();

    // ---- 1) 分组表：块序 + 块内创建序 → 全局下标（上限截断与采样器资格都取决于全局创建序）----
    let mut gmap: Vec<Vec<Option<u32>>> = Vec::with_capacity(nchunks);
    for st in chunks.iter() {
        let mut m: Vec<Option<u32>> = vec![None; st.groups.len()];
        for (li, gr) in st.groups.iter().enumerate() {
            let ci = match g.cat_index.get(&gr.cat) {
                Some(&i) => i,
                None => {
                    let i = g.cat_order.len();
                    g.cat_index.insert(gr.cat.clone(), i);
                    g.cat_order.push(gr.cat.clone());
                    g.cat_groups.push(Vec::new());
                    g.cat_group_index.push(FastMap::default());
                    i
                }
            };
            if let Some(&gi) = g.cat_group_index[ci].get(&gr.name) {
                m[li] = Some(gi as u32);
                continue;
            }
            if g.group_count >= MAX_GROUPS {
                // 顺序路径：该名称此后每个事件都计一次溢出，且不建分组、不做任何统计
                g.overflow_groups += gr.count;
                continue;
            }
            let sampler = if g.group_count < SAMPLER_GROUPS {
                Some(Sampler::new(SAMPLES_PER_GROUP))
            } else {
                None
            };
            let gi = g.groups.len();
            g.groups.push(GroupAcc::new(&gr.cat, &gr.name, sampler));
            g.cat_groups[ci].push(gi);
            g.cat_group_index[ci].insert(gr.name.clone(), gi);
            g.group_count += 1;
            m[li] = Some(gi as u32);
        }
        gmap.push(m);
    }

    // ---- 2) 可交换统计 + 分组统计（块序 + 块内序；首现序与「前 N 样本」照旧）----
    for (cidx, st) in chunks.iter().enumerate() {
        g.events += st.events;
        for (cat, n) in st.by_category.iter() {
            match g.by_category_index.get(cat) {
                Some(&i) => g.by_category[i].1 += n,
                None => {
                    g.by_category_index.insert(cat.clone(), g.by_category.len());
                    g.by_category.push((cat.clone(), *n));
                }
            }
        }
        for p in st.processes.iter() {
            if !g.process_seen.contains(p) {
                g.process_seen.insert(p.clone());
                g.processes.push(p.clone());
            }
        }
        for t in st.threads.iter() {
            g.threads.insert(t.clone());
        }
        for (cat, ct) in st.category_time.iter() {
            match g.category_index.get(cat) {
                Some(&i) => {
                    g.category_time[i].1.count += ct.count;
                    g.category_time[i].1.total_us += ct.total_us;
                }
                None => {
                    g.category_index.insert(cat.clone(), g.category_time.len());
                    g.category_time.push((
                        cat.clone(),
                        CatTime { count: ct.count, total_us: ct.total_us, self_us: 0.0 },
                    ));
                }
            }
        }
        for (kind, t) in st.transfer_agg.iter() {
            match g.transfer_index.get(kind) {
                Some(&i) => {
                    let x = &mut g.transfer_agg[i].1;
                    x.count += t.count;
                    x.bytes += t.bytes;
                    x.total_us += t.total_us;
                }
                None => {
                    g.transfer_index.insert(kind.clone(), g.transfer_agg.len());
                    g.transfer_agg.push((
                        kind.clone(),
                        Transfer { count: t.count, bytes: t.bytes, total_us: t.total_us },
                    ));
                }
            }
        }
        g.transfer_count += st.transfer_count;
        g.transfer_bytes += st.transfer_bytes;
        g.kernel_events += st.kernel_events;
        g.gpu_transfer_events += st.gpu_transfer_events;
        g.steps.extend(st.steps.iter().cloned());
        for (key, site) in st.python_sites.iter() {
            match g.python_index.get(key) {
                Some(&i) => {
                    let s = &mut g.python_sites[i].1;
                    s.count += site.count;
                    s.total_us += site.total_us;
                }
                None => {
                    g.python_index.insert(key.clone(), g.python_sites.len());
                    g.python_sites.push((
                        key.clone(),
                        PySite {
                            location: site.location.clone(),
                            file: site.file.clone(),
                            line: site.line,
                            func: site.func.clone(),
                            count: site.count,
                            self_us: 0.0,
                            total_us: site.total_us,
                        },
                    ));
                }
            }
        }
        let m = &gmap[cidx];
        for (li, gr) in st.groups.iter().enumerate() {
            let Some(gi) = m[li] else { continue };
            let dst = &mut g.groups[gi as usize];
            dst.count += gr.count;
            dst.total_us += gr.total_us;
            if gr.min_us < dst.min_us {
                dst.min_us = gr.min_us;
            }
            if gr.max_us > dst.max_us {
                dst.max_us = gr.max_us;
            }
            for d in gr.devices.iter() {
                if !dst.devices.contains(d) {
                    dst.devices.push(*d);
                }
            }
            for s in gr.streams.iter() {
                if !dst.streams.contains(s) {
                    dst.streams.push(*s);
                }
            }
            for s in gr.shapes.iter() {
                if dst.shapes.len() < SHAPE_SAMPLES {
                    dst.shapes.push(s.clone());
                }
            }
            for s in gr.dtypes.iter() {
                if dst.dtypes.len() < SHAPE_SAMPLES {
                    dst.dtypes.push(s.clone());
                }
            }
            // 顺序路径的语义是「grid 仍为空就整组覆盖（含 None）」——按块序取最后一个
            if dst.grid.is_none() {
                dst.grid = gr.grid;
                dst.block = gr.block;
                dst.registers = gr.registers;
                dst.occupancy = gr.occupancy;
                dst.shared_memory = gr.shared_memory;
            }
        }
    }

    // ---- 3) 采样器：步时长 + 分组时长（全局序喂入；蓄水池逐次替换依赖 add 序号）----
    let t_s3 = Instant::now();
    for st in chunks.iter() {
        for d in st.logs.as_ref().unwrap().step_durs.iter() {
            g.step_sampler.add(*d);
        }
    }
    for (cidx, st) in chunks.iter().enumerate() {
        let m = &gmap[cidx];
        for (li, durs) in st.logs.as_ref().unwrap().group_durs.iter() {
            let Some(gi) = m[*li] else { continue };
            if let Some(sp) = g.groups[gi as usize].sampler.as_mut() {
                for d in durs.iter() {
                    sp.add(*d);
                }
            }
        }
    }

    // ---- 4) 时间线区间回放（并集 running-max / 分桶自适应分辨率都是全局序语义）----
    if dbg {
        eprintln!("[merge] └ 采样器 {:.0}ms", t_s3.elapsed().as_secs_f64() * 1000.0);
    }
    let t_s4 = Instant::now();
    for st in chunks.iter() {
        let logs = st.logs.as_ref().unwrap();
        for (s, e) in logs.cpu_iv.iter() {
            g.cpu_union.add(*s, *e);
            g.cpu_bins.add(*s, *e);
        }
        for (s, e) in logs.gpu_iv.iter() {
            g.gpu_union.add(*s, *e);
            g.gpu_bins.add(*s, *e);
        }
    }

    // ---- 5) 显存回放 ----
    if dbg {
        eprintln!("[merge] └ 区间回放 {:.0}ms", t_s4.elapsed().as_secs_f64() * 1000.0);
    }
    let t_s5 = Instant::now();
    for st in chunks.iter() {
        for r in st.logs.as_ref().unwrap().mem.iter() {
            apply_mem_instant(
                &mut g.mem,
                r.bytes,
                r.addr,
                r.device_id,
                r.total_allocated,
                r.total_reserved,
                r.ts,
            );
        }
    }

    // ---- 6) 流事件回放（含跨块「最近活动」携带：块内尚无 X 事件时取上游块的活动）----
    if dbg {
        eprintln!("[merge] └ 显存回放 {:.0}ms", t_s5.elapsed().as_secs_f64() * 1000.0);
    }
    let t_s6 = Instant::now();
    let mut carry_act: Option<Activity> = None;
    for st in chunks.iter() {
        for r in st.logs.as_ref().unwrap().flow.iter() {
            let act = match r.act.as_ref() {
                Some(a) => Some(a.clone()),
                None => carry_act.clone(),
            };
            let ph = if r.is_start { "s" } else { "f" };
            if r.is_fwdbwd {
                g.pair_fwd_bwd(&r.key, ph, act.as_ref(), r.ts);
            } else if g.pair_flow(&r.key, ph, act.as_ref(), r.ts) {
                g.flow_pairs += 1;
            }
        }
        if let Some(a) = st.last_activity.as_ref() {
            carry_act = Some(a.clone());
        }
    }

    // ---- 7) 归并前预处理：corr 记录分配全局序下标 + 块内分组下标换全局；
    //         栈记录的下标同样就地换成全局（u32::MAX = 被上限截断）----
    if dbg {
        eprintln!("[merge] └ flow 回放 {:.0}ms", t_s6.elapsed().as_secs_f64() * 1000.0);
    }
    if dbg {
        eprintln!("[merge] 合并+回放（区间/显存/flow/采样器/分组表） {:.0}ms", t_m0.elapsed().as_secs_f64() * 1000.0);
    }
    let t_m1 = Instant::now();
    let mut gidx_total: u32 = 0;
    let mut by_gidx: Vec<(usize, usize)> = Vec::new();
    for (cidx, st) in chunks.iter_mut().enumerate() {
        let m = gmap[cidx].clone();
        let logs = st.logs.as_mut().unwrap();
        for (ei, e) in logs.corr.iter_mut().enumerate() {
            e.global_gi = m[e.gi as usize];
            e.gidx = gidx_total;
            gidx_total += 1;
            by_gidx.push((cidx, ei));
        }
        for (_key, recs) in logs.stacks.iter_mut() {
            for r in recs.iter_mut() {
                r.gi = m[r.gi as usize].unwrap_or(u32::MAX);
            }
        }
    }

    // ---- 8) 按（进程,线程）并行回放：自身耗时（跨块帧懒关闭/携带）+ 发起帧解析 ----
    let names: Vec<(String, String)> = g.groups.iter().map(|x| (x.cat.clone(), x.name.clone())).collect();
    let mut job_index: FastMap<String, usize> = FastMap::default();
    let mut jobs: Vec<(String, Vec<(usize, usize)>)> = Vec::new();
    for (cidx, st) in chunks.iter().enumerate() {
        let logs = st.logs.as_ref().unwrap();
        for (sidx, (key, _)) in logs.stacks.iter().enumerate() {
            let ji = match job_index.get(key) {
                Some(&i) => i,
                None => {
                    let i = jobs.len();
                    job_index.insert(key.clone(), i);
                    jobs.push((key.clone(), Vec::new()));
                    i
                }
            };
            jobs[ji].1.push((cidx, sidx));
        }
    }
    let outs: Vec<ThreadReplayOut> = jobs
        .par_iter()
        .map(|(key, segs)| replay_thread(key, segs, &chunks, &names))
        .collect();
    if dbg {
        eprintln!(
            "[merge] 分组下标重映射/序号分配 + 按（进程,线程）回放栈流 {:.0}ms（键数 {}）",
            t_m1.elapsed().as_secs_f64() * 1000.0,
            jobs.len()
        );
    }
    let t_m2 = Instant::now();
    for o in outs {
        for (gi, child, self_us) in o.acc {
            let dst = &mut g.groups[gi as usize];
            dst.child_us += child;
            dst.self_us += self_us;
        }
        for (gidx, op, py) in o.resolved {
            let (cidx, ei) = by_gidx[gidx as usize];
            let e = &mut chunks[cidx].logs.as_mut().unwrap().corr[ei];
            e.res_op = op;
            e.res_py = py;
        }
        for (whole, name, start, end, child) in o.leftover {
            // 收尾 1 的照实复刻：栈键按 `\u{0}` 拆类别（栈键用 `|` 分隔，故取到整键）→ 实际不命中任何分组
            let cat = whole.split('\u{0}').next().unwrap_or("").to_string();
            g.close_frame(&cat, &name, start, end, child);
        }
    }

    // ---- 9) correlation 回放（全局序）：发起帧 → launch_ops/sites、启发表插入/删除、内核归属 ----
    let mut launch_ctx: FastMap<u64, LaunchCtx> = FastMap::default();
    for st in chunks.iter() {
        for e in st.logs.as_ref().unwrap().corr.iter() {
            let Some(gi) = e.global_gi else { continue };
            if e.is_launch {
                {
                    let gr = &mut g.groups[gi as usize];
                    if let Some(op) = e.res_op.as_ref() {
                        if gr.launch_ops.len() < LAUNCH_SITES {
                            State::push_unique(&mut gr.launch_ops, op.clone());
                        }
                    }
                    if let Some(py) = e.res_py.as_ref() {
                        if gr.launch_sites.len() < LAUNCH_SITES {
                            State::push_unique(&mut gr.launch_sites, py.clone());
                        }
                    }
                }
                if let Some(corr) = e.corr {
                    if launch_ctx.len() < MAX_FLOWS {
                        launch_ctx.insert(
                            fkey(corr),
                            LaunchCtx { api: e.name.clone(), op: e.res_op.clone(), python: e.res_py.clone() },
                        );
                    }
                }
            } else if let Some(corr) = e.corr {
                if let Some(ctx) = launch_ctx.get(&fkey(corr)) {
                    let op = ctx.op.clone().unwrap_or_else(|| ctx.api.clone());
                    let key = format!("{}\u{0}{}\u{0}{}", e.name, op, ctx.python.clone().unwrap_or_default());
                    let entry = AttrEntry {
                        kernel: e.name.clone(),
                        op,
                        api: Some(ctx.api.clone()),
                        python: ctx.python.clone(),
                        via: "correlation",
                        count: 1,
                        kernel_us: e.dur,
                    };
                    g.upsert_attr(key, entry);
                }
                // 一次启动只对应一个内核：用完即删
                launch_ctx.remove(&fkey(corr));
            }
        }
    }

    if dbg {
        eprintln!("[merge] corr 回放 {:.0}ms（共 {:.0}ms）", t_m2.elapsed().as_secs_f64() * 1000.0, t_m0.elapsed().as_secs_f64() * 1000.0);
    }
    g
}

struct AggOut {
    facts: Json,
    elapsed_ms: f64,
    events: u64,
    bytes: usize,
    aborted: bool,
}

fn run_aggregate(path: &str, budget_ms: f64) -> Result<AggOut, String> {
    let t0 = Instant::now();
    let buf = read_all(path)?;
    let gz = path.to_ascii_lowercase().ends_with(".gz");
    let flags = read_trace_flags(&buf, gz);

    let budgeted = budget_ms > 0.0;
    // 临时性能探针：TORCH_BENCH_NOOP=1 只跑扫描器（不做聚合），TORCH_BENCH_PARSE=1 只做字段提取；
    // TORCH_BENCH_PHASES=1 打印并行分块各阶段耗时（读文件/块起点摘要/块内采集/归并/输出组装）
    let probe = std::env::var("TORCH_BENCH_PROBE").unwrap_or_default();
    // 并行度：TORCH_NATIVE_THREADS（未设置 = 自动：小文件单趟）；=1 即单趟直接路径（A/B 校验基准）
    let threads = native_threads(buf.len());
    let (mut st, last_end, aborted) = if threads <= 1 {
        let mut st = State::new();
        // 逐事件复用的字符串缓冲（键拼接等），避免热路径分配
        let mut sc = Scratch::default();
        let (last_end, _items, aborted) = scan_elements(
            &buf,
            |text| match probe.as_str() {
                "noop" => {}
                "parse" => {
                    st.events += 1;
                    let _ = parse_event_fast(text);
                }
                _ => st.process(text, &mut sc),
            },
            || budgeted && t0.elapsed().as_secs_f64() * 1000.0 > budget_ms,
        )?;
        (st, last_end, aborted)
    } else {
        collect_chunked(&buf, budget_ms, t0, probe.as_str(), threads)?
    };
    st.last_item_end = last_end;
    let scanned_chars = utf16_len(&buf[..last_end.min(buf.len())]);

    // ---- 收尾 1：关闭所有未闭合帧（TS 侧按 "\u0000" 拆键取类别——与栈键的 "|" 分隔不一致，
    //      故实际上不会命中任何分组；此处**照实复刻**，等价性优先） ----
    let stack_keys: Vec<String> = st.stacks.keys().cloned().collect();
    for key in stack_keys {
        let cat = key.split('\u{0}').next().unwrap_or("").to_string();
        let mut frames = st.stacks.remove(&key).unwrap_or_default().frames;
        while let Some(f) = frames.pop() {
            st.close_frame(&cat, &f.name, f.start, f.end, f.child_us);
        }
    }

    // ---- 收尾 2：流事件关联对账（扫描后做，不依赖事件先后） ----
    let t_tail0 = Instant::now();
    let mut flow_kernel_links: u64 = 0;
    if !st.flow_link.is_empty() {
        if let Some(&kci) = st.cat_index.get("kernel") {
            let mut kernel_groups: FastMap<String, (u64, f64)> = FastMap::default();
            for &gi in &st.cat_groups[kci] {
                kernel_groups.insert(st.groups[gi].name.clone(), (st.groups[gi].count, st.groups[gi].total_us));
            }
            let mut correlated: FastSet<String> = FastSet::default();
            for a in &st.kernel_attr {
                if a.via == "correlation" {
                    correlated.insert(a.kernel.clone());
                }
            }
            let links = st.flow_link.clone();
            for (kernel_name, link) in links {
                let Some(&(cnt, tot)) = kernel_groups.get(&kernel_name) else {
                    continue;
                };
                flow_kernel_links += link.count;
                if correlated.contains(&kernel_name) {
                    continue;
                }
                let key = format!("{}\u{0}{}", kernel_name, link.launcher);
                if st.kernel_attr_index.contains_key(&key) {
                    continue;
                }
                st.kernel_attr_index.insert(key, st.kernel_attr.len());
                st.kernel_attr.push(AttrEntry {
                    kernel: kernel_name,
                    op: link.launcher,
                    api: None,
                    python: None,
                    via: "flow",
                    count: cnt,
                    kernel_us: tot,
                });
            }
        }
    }

    // ---- 收尾 3：自身耗时回填到类别统计与 python 位置热点 ----
    let mut cat_self: Vec<f64> = Vec::with_capacity(st.category_time.len());
    let mut py_backfill: Vec<(usize, f64)> = Vec::new();
    for (cat, _) in st.category_time.iter() {
        let mut self_us = 0.0;
        if let Some(&ci) = st.cat_index.get(cat) {
            for &gi in &st.cat_groups[ci] {
                self_us += st.groups[gi].self_us;
            }
            if cat == "python_function" {
                for &gi in &st.cat_groups[ci] {
                    let gname = st.groups[gi].name.clone();
                    if let Some((file, line, _)) = parse_python_site(&gname) {
                        let key = format!("{}:{}", file, js_num_str(line));
                        if let Some(&pi) = st.python_index.get(&key) {
                            py_backfill.push((pi, st.groups[gi].self_us));
                        }
                    }
                }
            }
        }
        cat_self.push(self_us);
    }
    for (i, v) in cat_self.into_iter().enumerate() {
        st.category_time[i].1.self_us = v;
    }
    for (pi, v) in py_backfill {
        st.python_sites[pi].1.self_us += v;
    }

    // ---- 排行（byCat） ----
    let t_tail1 = Instant::now();
    let by_cat = |st: &State, cat: &str| -> Vec<Json> {
        let gpu_ranked = cat == "kernel" || cat == "gpu_memcpy" || cat == "gpu_memset";
        // 先排序取下标，再只为入选行（TOP_ROWS）构 JSON（大类别可达上万分组）
        let mut rows: Vec<(f64, usize)> = Vec::new();
        if let Some(&ci) = st.cat_index.get(cat) {
            for &gi in &st.cat_groups[ci] {
                let g = &st.groups[gi];
                rows.push((if gpu_ranked { g.total_us } else { g.self_us }, gi));
            }
        }
        rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        rows.into_iter().take(TOP_ROWS).map(|(_, gi)| stat_json(&st.groups[gi])).collect()
    };

    // ---- 时间线 ----
    let cpu_res = st.cpu_union.finalize();
    let gpu_res = st.gpu_union.finalize();
    let cpu_first_us = if cpu_res.span > 0.0 { cpu_res.first_start / NS_PER_US } else { f64::INFINITY };
    let gpu_first_us = if gpu_res.span > 0.0 { gpu_res.first_start / NS_PER_US } else { f64::INFINITY };
    let cpu_last_us = if cpu_res.span > 0.0 {
        cpu_res.last_end / NS_PER_US
    } else {
        f64::NEG_INFINITY
    };
    let gpu_last_us = if gpu_res.span > 0.0 {
        gpu_res.last_end / NS_PER_US
    } else {
        f64::NEG_INFINITY
    };
    let first_ts = js_min2(cpu_first_us, gpu_first_us);
    let last_ts = js_max2(cpu_last_us, gpu_last_us);
    let span_us = if first_ts.is_finite() && last_ts.is_finite() {
        js_max2(0.0, last_ts - first_ts)
    } else {
        0.0
    };
    let cpu_busy_us = cpu_res.busy / NS_PER_US;
    let gpu_busy_us = gpu_res.busy / NS_PER_US;
    let cpu_series = st.cpu_bins.series(TIMELINE_POINTS);
    let gpu_series = st.gpu_bins.series(TIMELINE_POINTS);

    let cpu_merged = merged_from_gaps(&cpu_res.gaps, cpu_res.first_start, cpu_res.last_end);
    let gpu_merged = merged_from_gaps(&gpu_res.gaps, gpu_res.first_start, gpu_res.last_end);
    let overlap_ns = if !gpu_merged.is_empty() && !cpu_merged.is_empty() {
        intersection_totals(&cpu_merged, &gpu_merged, false).0
    } else {
        0.0
    };
    let gap_intervals: Vec<(f64, f64)> = gpu_res.gaps.clone();
    let gap_cpu_busy = if !gap_intervals.is_empty() && !cpu_merged.is_empty() {
        intersection_totals(&cpu_merged, &gap_intervals, true).1
    } else {
        Vec::new()
    };
    let mut gaps_with_cpu: Vec<(f64, usize)> = gpu_res
        .gaps
        .iter()
        .enumerate()
        .map(|(i, (s, e))| ((e - s) / NS_PER_US, i))
        .collect();
    gaps_with_cpu.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let gaps_with_cpu: Vec<Json> = gaps_with_cpu
        .into_iter()
        .take(TOP_ROWS)
        .map(|(_, i)| {
            let (s, e) = gpu_res.gaps[i];
            Json::obj(vec![
                ("startUs", jnum(s / NS_PER_US)),
                ("endUs", jnum(e / NS_PER_US)),
                ("durUs", jnum((e - s) / NS_PER_US)),
                ("cpuBusyUs", jnum(gap_cpu_busy.get(i).copied().unwrap_or(0.0) / NS_PER_US)),
            ])
        })
        .collect();
    let gap_total_us: f64 = gpu_res.gaps.iter().map(|(s, e)| (e - s) / NS_PER_US).sum();

    let has_gpu_events = st.kernel_events > 0 || st.gpu_transfer_events > 0;
    let mem = &st.mem;
    let peak_allocated_bytes = if mem.saw_trace_totals { mem.peak_allocated } else { mem.peak_live_bytes };
    let peak_source = if mem.saw_trace_totals {
        "trace"
    } else if mem.peak_live_bytes > 0.0 {
        "live-set"
    } else {
        "none"
    };

    // 排序只取前 PYTHON_HOTSPOTS 行：先按自身耗时（稳定）排序取下标，再只为入选行构 JSON——
    // 站点数可达数万级，为全部站点构 JSON 再丢掉是纯浪费（并行/单趟两条路径都受益）。
    let mut py_order: Vec<(f64, usize)> = st.python_sites.iter().enumerate().map(|(i, (_, s))| (s.self_us, i)).collect();
    py_order.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let python_rows: Vec<Json> = py_order
        .into_iter()
        .take(PYTHON_HOTSPOTS)
        .map(|(_, i)| {
            let s = &st.python_sites[i].1;
            Json::obj(vec![
                ("location", jstr(&s.location)),
                ("file", jstr(&s.file)),
                ("line", jnum(s.line)),
                ("func", jstr(&s.func)),
                ("count", jnum(s.count as f64)),
                ("selfUs", jnum(s.self_us)),
                ("totalUs", jnum(s.total_us)),
            ])
        })
        .collect();

    let mut attr_order: Vec<(f64, usize)> = st.kernel_attr.iter().enumerate().map(|(i, a)| (a.kernel_us, i)).collect();
    attr_order.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let attr_rows: Vec<Json> = attr_order
        .into_iter()
        .take(TOP_ROWS)
        .map(|(_, i)| {
            let a = &st.kernel_attr[i];
            let mut fields: Vec<(&str, Json)> = vec![
                ("kernel", jstr(&a.kernel)),
                ("op", jstr(&a.op)),
            ];
            if let Some(api) = &a.api {
                fields.push(("api", jstr(api)));
            }
            if let Some(py) = &a.python {
                fields.push(("python", jstr(py)));
            }
            fields.push(("via", jstr(a.via)));
            fields.push(("count", jnum(a.count as f64)));
            fields.push(("kernelUs", jnum(a.kernel_us)));
            Json::obj(fields)
        })
        .collect();

    let notes: Vec<Json> = {
        let mut v: Vec<Json> = Vec::new();
        if !has_gpu_events {
            v.push(jstr(
                "trace 中无 GPU 事件（kernel/传输）——GPU 侧时间线需另采：Windows 上 PyTorch 的 CUPTI 采集不可用（实测显式启用 CUDA activity 仍无 kernel 事件），\
                 请用 nsight_capture kind=nsys 采集 GPU 时间线；Linux 上可用 activities=[ProfilerActivity.CUDA] 重新采集。",
            ));
        }
        if st.mem.events == 0 {
            v.push(jstr("trace 中无分配器事件（`[memory]`）——需要采集时启用 profile_memory=True。"));
        }
        if st.kernel_events > 0 && st.flow_pairs == 0 {
            v.push(jstr(
                "trace 中无流事件（ph:\"s\"/\"f\"）——内核→发起算子归属仅依赖 correlation 字段（该字段缺失的内核无法归属）。",
            ));
        }
        v
    };

    let scanned_chars_f = scanned_chars as f64;
    let t_tail2 = Instant::now();
    let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let mut top: Vec<(&str, Json)> = vec![
        ("source", jstr(path)),
        ("scanMs", jnum(elapsed_ms)),
        (
            "scale",
            Json::obj(vec![
                ("events", jnum(st.events as f64)),
                ("scannedChars", jnum(scanned_chars_f)),
                (
                    "byCategory",
                    Json::Obj({
                        let mut rows = st.by_category.clone();
                        rows.sort_by(|a, b| b.1.cmp(&a.1));
                        rows.into_iter().map(|(k, v)| (k, jnum(v as f64))).collect()
                    }),
                ),
                (
                    "processes",
                    Json::Arr({
                        let mut p: Vec<f64> = st
                            .processes
                            .iter()
                            .map(|s| js_number(s))
                            .filter(|v| v.is_finite())
                            .collect();
                        p.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                        p.into_iter().map(jnum).collect()
                    }),
                ),
                ("threads", jnum(st.threads.len() as f64)),
                ("flags", Json::Obj(flags.iter().cloned().collect())),
            ]),
        ),
        ("hasGpuEvents", Json::Bool(has_gpu_events)),
        ("hasMemoryEvents", Json::Bool(mem.events > 0)),
        (
            "steps",
            Json::Arr(
                st.steps
                    .iter()
                    .map(|(name, dur, ts)| {
                        Json::obj(vec![
                            ("name", jstr(name)),
                            ("durUs", jnum(*dur)),
                            ("tsUs", jnum(*ts)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "stepStats",
            Json::obj(vec![
                ("count", jnum(st.step_sampler.seen as f64)),
                (
                    "avgUs",
                    jnum(if st.step_sampler.seen > 0 {
                        st.step_sampler.quantile(0.5)
                    } else {
                        0.0
                    }),
                ),
                ("medianUs", jnum(st.step_sampler.quantile(0.5))),
                ("p90Us", jnum(st.step_sampler.quantile(0.9))),
                ("minUs", jnum(st.step_sampler.quantile(0.0))),
                ("maxUs", jnum(st.step_sampler.quantile(1.0))),
            ]),
        ),
        (
            "categories",
            Json::Arr({
                let mut rows: Vec<(f64, Json)> = st
                    .category_time
                    .iter()
                    .map(|(cat, ct)| {
                        (
                            ct.total_us,
                            Json::obj(vec![
                                ("cat", jstr(cat)),
                                ("count", jnum(ct.count as f64)),
                                ("totalUs", jnum(ct.total_us)),
                                ("selfUs", jnum(ct.self_us)),
                            ]),
                        )
                    })
                    .collect();
                rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
                rows.into_iter().map(|r| r.1).collect()
            }),
        ),
        ("ops", Json::Arr(by_cat(&st, "cpu_op"))),
        ("kernels", Json::Arr(by_cat(&st, "kernel"))),
        ("cudaApis", Json::Arr(by_cat(&st, "cuda_runtime"))),
        ("annotations", Json::Arr(by_cat(&st, "user_annotation"))),
        (
            "opGroups",
            jnum(
                (st.cat_index
                    .get("cpu_op")
                    .map(|&ci| st.cat_groups[ci].len())
                    .unwrap_or(0) as u64
                    + st.overflow_groups) as f64,
            ),
        ),
        (
            "kernelGroups",
            jnum(st.cat_index.get("kernel").map(|&ci| st.cat_groups[ci].len()).unwrap_or(0) as f64),
        ),
        (
            "transfers",
            Json::Arr({
                let mut rows: Vec<(f64, Json)> = st
                    .transfer_agg
                    .iter()
                    .map(|(kind, t)| {
                        (
                            t.total_us,
                            Json::obj(vec![
                                ("kind", jstr(kind)),
                                ("count", jnum(t.count as f64)),
                                ("bytes", jnum(t.bytes)),
                                ("totalUs", jnum(t.total_us)),
                                (
                                    "avgBytes",
                                    jnum(if t.count > 0 { t.bytes / t.count as f64 } else { 0.0 }),
                                ),
                            ]),
                        )
                    })
                    .collect();
                rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
                rows.into_iter().map(|r| r.1).collect()
            }),
        ),
        ("transferCount", jnum(st.transfer_count as f64)),
        ("transferBytes", jnum(st.transfer_bytes)),
        (
            "memory",
            Json::obj(vec![
                ("available", Json::Bool(mem.events > 0)),
                ("events", jnum(mem.events as f64)),
                ("allocCount", jnum(mem.alloc_count as f64)),
                ("freeCount", jnum(mem.free_count as f64)),
                ("allocatedBytes", jnum(mem.allocated_bytes)),
                ("freedBytes", jnum(mem.freed_bytes)),
                ("peakAllocatedBytes", jnum(peak_allocated_bytes)),
                ("peakReservedBytes", jnum(mem.peak_reserved)),
                ("peakSource", jstr(peak_source)),
                (
                    "fragmentation",
                    jnum(if mem.peak_allocated > 0.0 {
                        mem.peak_reserved / mem.peak_allocated
                    } else {
                        0.0
                    }),
                ),
                (
                    "largestAllocs",
                    Json::Arr(
                        mem.largest
                            .to_array()
                            .into_iter()
                            .map(|a| {
                                Json::obj(vec![
                                    ("bytes", jnum(a.bytes)),
                                    ("addr", jnum(a.addr)),
                                    ("deviceId", jnum(a.device_id)),
                                    ("tsUs", jnum(a.ts_us)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "byDevice",
                    Json::Arr(
                        mem.by_device
                            .iter()
                            .map(|(device_id, d)| {
                                Json::obj(vec![
                                    ("deviceId", jnum(*device_id)),
                                    ("allocCount", jnum(d.alloc_count as f64)),
                                    ("bytes", jnum(d.bytes)),
                                    ("peakBytes", jnum(d.peak_bytes)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                ("addrTrackingTruncated", Json::Bool(mem.addr_truncated)),
            ]),
        ),
        (
            "timeline",
            Json::obj(vec![
                ("spanUs", jnum(span_us)),
                ("firstTsUs", jnum(if first_ts.is_finite() { first_ts } else { 0.0 })),
                ("lastTsUs", jnum(if last_ts.is_finite() { last_ts } else { 0.0 })),
                ("cpuBusyUs", jnum(cpu_busy_us)),
                (
                    "cpuUtilization",
                    jnum(if span_us > 0.0 { cpu_busy_us / span_us } else { 0.0 }),
                ),
                ("gpuBusyUs", jnum(gpu_busy_us)),
                (
                    "gpuUtilization",
                    jnum(if span_us > 0.0 { gpu_busy_us / span_us } else { 0.0 }),
                ),
                ("gpuGapCount", jnum(gpu_res.gaps.len() as f64)),
                ("gpuGapTotalUs", jnum(gap_total_us)),
                ("gpuGaps", Json::Arr(gaps_with_cpu)),
                ("gpuMaxConcurrent", jnum(gpu_res.max_concurrent as f64)),
                ("overlapUs", jnum(overlap_ns / NS_PER_US)),
                ("cpuSeries", Json::Arr(cpu_series.into_iter().map(jnum).collect())),
                ("gpuSeries", Json::Arr(gpu_series.into_iter().map(jnum).collect())),
            ]),
        ),
        ("pythonSites", Json::Arr(python_rows)),
        ("kernelAttribution", Json::Arr(attr_rows)),
        ("fwdBwd", build_fwd_bwd(&st.fwd_bwd_marks, &st.steps)),
        (
            "flows",
            Json::obj(vec![
                ("available", Json::Bool(st.flow_pairs > 0)),
                ("pairs", jnum(st.flow_pairs as f64)),
                ("kernelLinks", jnum(flow_kernel_links as f64)),
            ]),
        ),
        ("notes", Json::Arr(notes)),
    ];
    if aborted {
        top.push((
            "incomplete",
            Json::obj(vec![
                ("budgetMs", jnum(budget_ms)),
                ("elapsedMs", jnum(elapsed_ms)),
                ("scannedChars", jnum(scanned_chars_f)),
                ("events", jnum(st.events as f64)),
            ]),
        ));
    }

    if std::env::var("TORCH_BENCH_PHASES").is_ok() {
        let t3 = Instant::now();
        eprintln!(
            "[tail] 收尾={:.0}ms 排行/时间线/热点行={:.0}ms 组装={:.0}ms",
            (t_tail1 - t_tail0).as_secs_f64() * 1000.0,
            (t_tail2 - t_tail1).as_secs_f64() * 1000.0,
            (t3 - t_tail2).as_secs_f64() * 1000.0
        );
    }
    Ok(AggOut {
        facts: Json::Obj(top.into_iter().map(|(k, v)| (k.to_string(), v)).collect()),
        elapsed_ms,
        events: st.events,
        bytes: buf.len(),
        aborted,
    })
}
/// 整文件读入内存（`.gz` 用 flate2 解压后再处理，不落中间文件）。
///
/// 非 gz 且文件较大时**按分片并行读**（每片独立文件句柄 + `seek` 到片起点——跨平台，不依赖
/// 平台专属的 `read_at`）：GB 级 trace 的单线程读入是纯串行段（实测 672 MB 约 300 ms），
/// 分片并行能把这段压掉一半以上。文件被删/被截断仍走友好报错（与改造前同一套文案）。
fn read_all(path: &str) -> Result<Vec<u8>, String> {
    let f = std::fs::File::open(path)
        .map_err(|e| format!("无法读取 trace 文件：{}（{}）——请确认路径存在且可读", path, e))?;
    if path.to_ascii_lowercase().ends_with(".gz") {
        // gzip 解压本身是串行单流，不并行
        let mut buf: Vec<u8> = Vec::new();
        let mut d = flate2::read::MultiGzDecoder::new(f);
        d.read_to_end(&mut buf)
            .map_err(|e| format!("gzip 解压失败：{}（{}）——请确认是完整的 *.pt.trace.json.gz", path, e))?;
        return Ok(buf);
    }
    let len = f.metadata().map(|m| m.len() as usize).unwrap_or(0);
    drop(f);
    let threads = native_threads(len);
    let open_err = |e: std::io::Error| {
        format!("无法读取 trace 文件：{}（{}）——请确认路径存在且可读", path, e)
    };
    let read_err = |e: std::io::Error| format!("读取 trace 文件失败：{}（{}）", path, e);
    if threads <= 1 {
        // 按文件大小预分配，免去 `read_to_end` 几何扩容的反复搬运（GB 级文件下可省一次全量拷贝）
        let mut f = std::fs::File::open(path).map_err(open_err)?;
        let mut buf: Vec<u8> = Vec::new();
        if let Ok(md) = f.metadata() {
            buf.reserve(md.len() as usize);
        }
        f.read_to_end(&mut buf).map_err(read_err)?;
        return Ok(buf);
    }
    let mut buf: Vec<u8> = Vec::with_capacity(len);
    // u8 无析构：先 set_len 再填充是安全的（短读会返回 Err，不会把未初始化内容当成数据使用）
    unsafe { buf.set_len(len) };
    // 读分片数可与并行度解耦：I/O 并行度不受 CPU 数限制，冷读时更多分片才能把磁盘队列压满
    // （片大小下限 16 MB，避免小文件上过度分片）
    let slices = threads.max((len / (16 * 1024 * 1024)).min(64)).max(1);
    let chunk = (len + slices - 1) / slices;
    buf.par_chunks_mut(chunk)
        .enumerate()
        .try_for_each(|(i, part)| -> Result<(), String> {
            let mut fh = std::fs::File::open(path).map_err(open_err)?;
            fh.seek(SeekFrom::Start((i * chunk) as u64)).map_err(read_err)?;
            fh.read_exact(part).map_err(read_err)?;
            Ok(())
        })?;
    Ok(buf)
}

// ==================================================================================
// 十二、工具注册
// ==================================================================================

fn aggregate_handler(args: &Json) -> framework::ToolResult {
    let path = match args.get_str("path").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(p) => p.to_string(),
        None => {
            return tool_err(
                "需要 path 参数（PyTorch Profiler trace 的绝对路径，支持 *.pt.trace.json 与 *.pt.trace.json.gz）",
            )
        }
    };
    let budget_ms = args.get_num("budget_ms").unwrap_or(DEFAULT_SCAN_BUDGET_MS);
    let resolved = framework::ctx_resolve(&path);
    match run_aggregate(&resolved, budget_ms) {
        Ok(r) => {
            let mb = r.bytes as f64 / 1048576.0;
            let secs = (r.elapsed_ms / 1000.0).max(1e-6);
            let summary = format!(
                "原生聚合完成：{} 个事件 / {:.1} MB（{:.2}s，{:.0} MB/s，{:.0} 万事件/s）{}",
                r.events,
                mb,
                secs,
                mb / secs,
                r.events as f64 / secs / 10_000.0,
                if r.aborted { "［时间预算耗尽，结果为部分聚合］" } else { "" }
            );
            tool_ok(summary, Some(r.facts))
        }
        Err(e) => tool_err(e),
    }
}

fn main() {
    register_tool(ToolDef {
        name: "aggregate",
        description: "PyTorch Profiler / Kineto trace（*.pt.trace.json[.gz]）的原生单趟聚合后端：整文件读入 + 字节级扫描定位 traceEvents 数组，输出与 JS 实现逐字段同构的聚合事实（规模与类别、算子/内核/CUDA API/标注排行与自身耗时、分位数受控采样、时间线并集与空闲缝、显存与最大分配、python 位置热点、内核→发起方归属、前反向拆分、流事件可用性与未采集维度说明）。供 torch 分析类工具内部调用，通常无需直接使用。"
            .to_string(),
        parameters: schema(
            r#"{"type":"object","properties":{
"path":{"type":"string","description":"trace 文件绝对路径（*.pt.trace.json 或 *.pt.trace.json.gz）"},
"budget_ms":{"type":"number","description":"扫描时间预算（毫秒，默认 300000；0 表示不限）——超预算即中止扫描并返回带 incomplete 的部分结果"}},
"required":["path"]}"#,
        ),
        handler: aggregate_handler,
    });
    framework::run();
}
