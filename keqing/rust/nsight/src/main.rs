// nsight 子代理的原生聚合后端（Rust 边车常驻进程）。
//
// 职责：对 Nsight Systems 报告导出的事件库（SQLite）做**单趟流式聚合**，产出与 TS 侧
// nsys-analysis 同构的时间线事实（并集忙碌时间、空闲缝、最大并发、时间线占用序列、
// 每内核分组统计、每流统计、显存传输聚合、启动间隔排行、小内核/小网格/占用压力归类）。
//
// 为什么原生：事件库可达 GB 级、千万级事件，宿主 JS 层逐行取列与聚合的开销较大
// （实测 1000 万行：JS 流式 16.2s → 本实现 11.5s，1.4×；峰值 RSS 143 MB → 83 MB）。
// 瓶颈口径：扫描循环内耗时几乎全在行读取（行解码 ≈ 1 µs × 15 列），聚合逻辑只占零头——
// 故换语言不是主要杆杆，减少需解码的列/行（窄列扫描：15 列 8.7s → 2 列 2.0s）收益更大。
// 关键设计：① 全程游标流式，内存与事件规模解耦（固定容量聚合器）；② 内核名按
// (demangled, short, mangled) 整数三元组记忆化映射到分组下标，避免逐行长字符串哈希；
// ③ 排行（Top-K）带最小值提前返回，避免逐行分配键字符串。
use framework::{register_tool, schema, tool_err, tool_ok, Json, ToolDef};
use rusqlite::{Connection, OpenFlags};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::time::Instant;

/// 默认阈值（与 TS 侧 FINDING_THRESHOLDS / ANALYSIS_LIMITS 同口径，可由参数覆盖）。
const DEF_GAP_MIN_NS: i64 = 50_000;
const DEF_SMALL_KERNEL_NS: i64 = 10_000;
const DEF_TIMELINE_POINTS: usize = 240;
const DEF_TIMELINE_BINS: usize = 1_000;
const DEF_TOP_ROWS: usize = 20;
const DEF_UNDERSIZED_THREADS: i64 = 100_000;
const DEF_HIGH_REGISTERS: i64 = 64;
const DEF_HIGH_SMEM: i64 = 48 * 1024;
/// 空闲缝与分组数量上限（防止极端报告把内存推高；超出即标记截断）。
const MAX_GAPS: usize = 50_000;
const MAX_GROUPS: usize = 20_000;
/// 每分组分位数采样容量与可分位分组数上限（与 TS 侧受控采样同语义）。
const GROUP_SAMPLE_CAP: usize = 64;
const MAX_SAMPLED_GROUPS: usize = 2_000;
/// 全局内核耗时采样容量（输出 p50/p90/p99 供上层展示分布）。
const GLOBAL_SAMPLE_CAP: usize = 50_000;

struct Params {
    sqlite: String,
    gap_min_ns: i64,
    small_kernel_ns: i64,
    timeline_points: usize,
    timeline_bins: usize,
    top_rows: usize,
    /// 时间窗（绝对 ns；None = 不筛选）——与活动区间相交的活动才计入。
    from_ns: Option<i64>,
    to_ns: Option<i64>,
}

impl Params {
    fn from_json(args: &Json) -> Result<Params, String> {
        let sqlite = args
            .get_str("sqlite")
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "需要 sqlite 参数（nsys 导出的事件库绝对路径）".to_string())?;
        let num = |key: &str, def: f64| args.get_num(key).unwrap_or(def);
        Ok(Params {
            sqlite,
            gap_min_ns: num("gap_min_ns", DEF_GAP_MIN_NS as f64) as i64,
            small_kernel_ns: num("small_kernel_ns", DEF_SMALL_KERNEL_NS as f64) as i64,
            timeline_points: (num("timeline_points", DEF_TIMELINE_POINTS as f64).max(1.0)) as usize,
            timeline_bins: (num("timeline_bins", DEF_TIMELINE_BINS as f64).max(8.0)) as usize,
            top_rows: (num("top_rows", DEF_TOP_ROWS as f64).max(1.0)) as usize,
            from_ns: args.get_num("from_ns").map(|v| v as i64),
            to_ns: args.get_num("to_ns").map(|v| v as i64),
        })
    }
}

// ---------------- 受控采样（分位数） ----------------

/// 蓄水池采样：前 cap 个值精确保留，超出后按等概率替换（内存恒定；sampled 标记为估计值）。
#[derive(Clone)]
struct Sampler {
    cap: usize,
    vals: Vec<i64>,
    seen: u64,
    sampled: bool,
    rng: u64,
}

impl Sampler {
    fn new(cap: usize) -> Sampler {
        Sampler {
            cap,
            vals: Vec::with_capacity(cap.min(1024)),
            seen: 0,
            sampled: false,
            rng: 0x9E3779B97F4A7C15,
        }
    }

    fn add(&mut self, v: i64) {
        self.seen += 1;
        if self.vals.len() < self.cap {
            self.vals.push(v);
            return;
        }
        self.sampled = true;
        // xorshift：无需 rand 依赖，分布足够蓄水池抽样使用
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        let idx = (self.rng % self.seen.max(1)) as usize;
        if idx < self.cap {
            self.vals[idx] = v;
        }
    }

    fn quantile(&self, q: f64) -> i64 {
        if self.vals.is_empty() {
            return 0;
        }
        let mut sorted = self.vals.clone();
        sorted.sort_unstable();
        let pos = (sorted.len() - 1) as f64 * q;
        let lo = pos.floor() as usize;
        let hi = pos.ceil() as usize;
        if lo == hi {
            sorted[lo]
        } else {
            let frac = pos - lo as f64;
            (sorted[lo] as f64 + (sorted[hi] as f64 - sorted[lo] as f64) * frac).round() as i64
        }
    }
}

// ---------------- 自适应分辨率时间线分桶 ----------------

/// 时间线占用分桶：窗口事前未知，桶溢出即倍粗分辨率并合并相邻桶——单趟完成、桶数恒定。
struct Bins {
    cap: usize,
    width: f64,
    origin: Option<i64>,
    last_end: i64,
    counts: Vec<f64>,
    busy: Vec<f64>,
}

impl Bins {
    fn new(cap: usize) -> Bins {
        Bins {
            cap,
            width: 100_000.0,
            origin: None,
            last_end: 0,
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

    fn add(&mut self, start: i64, end: i64) {
        if end <= start {
            return;
        }
        if self.origin.is_none() {
            self.origin = Some(start);
            self.last_end = start;
        }
        let origin = self.origin.unwrap();
        if end > self.last_end {
            self.last_end = end;
        }
        while ((end - origin) as f64) / self.width >= self.cap as f64 {
            self.coarsen();
        }
        let first = (((start - origin) as f64) / self.width).floor().max(0.0) as usize;
        let last = ((((end - origin) as f64) / self.width).floor() as usize).min(self.cap - 1);
        for b in first..=last {
            if b >= self.cap {
                break;
            }
            let bin_start = origin as f64 + b as f64 * self.width;
            let bin_end = bin_start + self.width;
            self.counts[b] += 1.0;
            let lo = (start as f64).max(bin_start);
            let hi = (end as f64).min(bin_end);
            if hi > lo {
                self.busy[b] += hi - lo;
            }
        }
    }

    /// 降采样为占用序列（0~1，长度不超 target）。
    fn series(&self, target: usize) -> Vec<f64> {
        let origin = self.origin.unwrap_or(0);
        let used_f = ((self.last_end - origin) as f64 / self.width).ceil();
        let used = (used_f.max(1.0) as usize).min(self.cap).max(1);
        let stride = (used + target - 1) / target.max(1);
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
            out.push(if span > 0.0 { (busy / span).min(1.0) } else { 0.0 });
            b += stride;
        }
        out
    }
}

// ---------------- Top-K（容量恒定、纯数值累积，JSON 只在最后构造一次） ----------------
//
// 设计要点：逐行只写 Copy 类型（无堆分配、无字符串克隆）——千万级事件下每行构造 Json 负载
// 会变成主成本（实测：逐行构造 4 个 BTreeMap 使 10M 行的聚合由 11s 级恶化到 20s 级）。
// 名称/几何等展示字段按分组下标（gid）保留，输出阶段一次性回溯。

/// 分组类排行条目（小内核 / 网格不足 / 占用压力共用；各排行只取自己需要的字段输出）。
#[derive(Clone, Copy, Default)]
struct NamedEntry {
    gid: usize,
    weight: i64,
    instances: u64,
    total: i64,
    grid: (i64, i64, i64),
    block: (i64, i64, i64),
    regs: i64,
    smem: i64,
    total_threads: i64,
}

/// 分组类 Top-K：同名（同 gid）更新累计值，容量恒定。
///
/// 逐行路径必须是 O(1)：用「gid → 下标」索引做定点更新，排序推迟到输出阶段——
/// 每行做一次线性扫描或排序（10M 行 × 20 项）会成为主成本。
struct NamedTopK {
    cap: usize,
    items: Vec<NamedEntry>,
    index: HashMap<usize, usize>,
}

impl NamedTopK {
    fn new(cap: usize) -> NamedTopK {
        NamedTopK {
            cap,
            items: Vec::with_capacity(cap.min(64)),
            index: HashMap::new(),
        }
    }

    fn upsert(&mut self, entry: NamedEntry) {
        if let Some(&i) = self.index.get(&entry.gid) {
            self.items[i] = entry;
            return;
        }
        if self.items.len() < self.cap {
            self.index.insert(entry.gid, self.items.len());
            self.items.push(entry);
            return;
        }
        // 已满：仅当权重超过当前最小项时替换（最小项现算，
        // 替换是低频路径——绝大多数行走上面的定点更新）
        let (min_i, min_w) = self
            .items
            .iter()
            .enumerate()
            .map(|(i, e)| (i, e.weight))
            .min_by_key(|(_, w)| *w)
            .unwrap_or((0, i64::MIN));
        if entry.weight > min_w {
            self.index.remove(&self.items[min_i].gid);
            self.items[min_i] = entry;
            self.index.insert(entry.gid, min_i);
        }
    }

    /// 输出（按权重降序，只排一次）。
    fn entries(&self) -> Vec<NamedEntry> {
        let mut out = self.items.clone();
        out.sort_by(|a, b| b.weight.cmp(&a.weight));
        out
    }
}

/// 启动间隔条目（流 + 前序内核 + 后续活动 + 间隔）。
#[derive(Clone, Copy)]
struct GapEntry {
    stream: i64,
    from: usize,
    to: usize,
    gap: i64,
}

/// 启动间隔 Top-K（键 = 流 + 前序内核 + 后续活动）：键索引做 O(1) 定点更新、
/// 最小值提前拒绝，排序推迟到输出阶段。
struct GapTopK {
    cap: usize,
    min_w: i64,
    items: Vec<GapEntry>,
    index: HashMap<(i64, usize, usize), usize>,
}

impl GapTopK {
    fn new(cap: usize) -> GapTopK {
        GapTopK {
            cap,
            min_w: i64::MIN,
            items: Vec::with_capacity(cap.min(64)),
            index: HashMap::new(),
        }
    }

    fn upsert(&mut self, entry: GapEntry) {
        let key = (entry.stream, entry.from, entry.to);
        if let Some(&i) = self.index.get(&key) {
            self.items[i] = entry;
            return;
        }
        if self.items.len() < self.cap {
            self.index.insert(key, self.items.len());
            self.items.push(entry);
            if self.items.len() == self.cap {
                self.min_w = self.items.iter().map(|it| it.gap).min().unwrap_or(i64::MIN);
            }
            return;
        }
        if entry.gap <= self.min_w {
            return;
        }
        let (min_i, min_w) = self
            .items
            .iter()
            .enumerate()
            .map(|(i, e)| (i, e.gap))
            .min_by_key(|(_, w)| *w)
            .unwrap_or((0, i64::MIN));
        let _ = min_w;
        let old = self.items[min_i];
        self.index.remove(&(old.stream, old.from, old.to));
        self.items[min_i] = entry;
        self.index.insert(key, min_i);
        self.min_w = self.items.iter().map(|it| it.gap).min().unwrap_or(i64::MIN);
    }

    /// 输出（按间隔降序，只排一次）。
    fn entries(&self) -> Vec<GapEntry> {
        let mut out = self.items.clone();
        out.sort_by(|a, b| b.gap.cmp(&a.gap));
        out
    }
}

/// 单次传输条目（最慢传输排行）。
#[derive(Clone, Copy)]
struct CopyEntry {
    kind: i64,
    dur: i64,
    bytes: i64,
    start: i64,
}

/// 最慢传输 Top-K（权重 = 单次耗时）。
struct CopyTopK {
    cap: usize,
    min_w: i64,
    items: Vec<CopyEntry>,
}

impl CopyTopK {
    fn new(cap: usize) -> CopyTopK {
        CopyTopK {
            cap,
            min_w: i64::MIN,
            items: Vec::with_capacity(cap.min(64)),
        }
    }

    fn add(&mut self, entry: CopyEntry) {
        if self.items.len() < self.cap {
            self.items.push(entry);
            if self.items.len() == self.cap {
                self.min_w = self.items.iter().map(|it| it.dur).min().unwrap_or(i64::MIN);
            }
            return;
        }
        if entry.dur <= self.min_w {
            return;
        }
        let (min_i, _) = self
            .items
            .iter()
            .enumerate()
            .map(|(i, e)| (i, e.dur))
            .min_by_key(|(_, d)| *d)
            .unwrap_or((0, i64::MIN));
        self.items[min_i] = entry;
        self.min_w = self.items.iter().map(|it| it.dur).min().unwrap_or(i64::MIN);
    }

    /// 输出（按耗时降序，只排一次）。
    fn entries(&self) -> Vec<CopyEntry> {
        let mut out = self.items.clone();
        out.sort_by(|a, b| b.dur.cmp(&a.dur));
        out
    }
}

// ---------------- 名称记忆化（整数三元组 → 分组下标/名称） ----------------

/// 报告里的名称经 StringIds 间接引用：先把 (demangled, short, mangled) 三元组映射为
/// 紧凑下标，逐行只做整数哈希（长 demangled 名逐行做字符串哈希会显著拖慢扫描）。
struct NameMemo {
    map: HashMap<(i64, i64, i64), usize>,
    names: Vec<(String, String)>, // (显示名, mangled 名)
}

impl NameMemo {
    fn new() -> NameMemo {
        NameMemo {
            map: HashMap::new(),
            names: Vec::new(),
        }
    }

    fn id_of(
        &mut self,
        key: (i64, i64, i64),
        resolve: &dyn Fn(i64) -> Option<String>,
    ) -> usize {
        if let Some(id) = self.map.get(&key) {
            return *id;
        }
        let (d, s, m) = key;
        let display = resolve(d)
            .or_else(|| resolve(s))
            .or_else(|| resolve(m))
            .unwrap_or_else(|| "(未命名 kernel)".to_string());
        let mangled = resolve(m).unwrap_or_default();
        let id = self.names.len();
        self.names.push((display, mangled));
        self.map.insert(key, id);
        id
    }
}

/// 单个内核分组的累计值。
#[derive(Clone)]
struct GroupAcc {
    instances: u64,
    total: i64,
    min: i64,
    max: i64,
    regs: i64,
    smem: i64,
    grid: (i64, i64, i64),
    block: (i64, i64, i64),
    streams: Vec<i64>,
    sampler: Option<Sampler>,
}

#[derive(Clone, Copy, Default)]
struct StreamAcc {
    kernel_instances: u64,
    kernel_total: i64,
    memcpy_count: u64,
    memcpy_bytes: i64,
    first: i64,
    last: i64,
}

#[derive(Default)]
struct MemcpyKindAcc {
    count: u64,
    total: i64,
    bytes: i64,
}

// ---------------- 事件行（拷贝出列值，避免在扫描循环里持有行借用） ----------------

#[derive(Clone, Copy)]
struct KRow {
    start: i64,
    end: i64,
    device: i64,
    stream: i64,
    demangled: i64,
    short: i64,
    mangled: i64,
    regs: i64,
    grid: (i64, i64, i64),
    block: (i64, i64, i64),
    smem: i64,
}

#[derive(Clone, Copy)]
struct MRow {
    start: i64,
    end: i64,
    device: i64,
    stream: i64,
    bytes: i64,
    kind: i64,
}

const KERNEL_SQL_BASE: &str = "SELECT start, end, {DEV}, streamId, demangledName, shortName, mangledName, registersPerThread,
        gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory
 FROM CUPTI_ACTIVITY_KIND_KERNEL{WIN} ORDER BY start";
const MEMCPY_SQL_BASE: &str = "SELECT start, end, {DEV}, streamId, bytes, copyKind FROM CUPTI_ACTIVITY_KIND_MEMCPY{WIN} ORDER BY start";
const MEMSET_SQL_BASE: &str = "SELECT start, end, {DEV}, streamId, bytes, 0 AS copyKind FROM CUPTI_ACTIVITY_KIND_MEMSET{WIN} ORDER BY start";

/// 表是否含 deviceId 列（旧版本或部分采集配置缺该列时以 0 代替，不阻断分析）。
fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut st| {
            let mut rows = st.query([])?;
            let mut found = false;
            while let Some(r) = rows.next()? {
                let name: String = r.get::<_, Option<String>>(1)?.unwrap_or_default();
                if name == column {
                    found = true;
                    break;
                }
            }
            Ok(found)
        })
        .unwrap_or(false)
}

fn opt_i64(r: &rusqlite::Row, idx: usize) -> rusqlite::Result<i64> {
    Ok(r.get::<_, Option<i64>>(idx)?.unwrap_or(-1))
}

fn next_kernel(rows: &mut rusqlite::Rows) -> rusqlite::Result<Option<KRow>> {
    match rows.next()? {
        Some(r) => Ok(Some(KRow {
            start: r.get(0)?,
            end: r.get(1)?,
            device: opt_i64(r, 2)?.max(0),
            stream: opt_i64(r, 3)?,
            demangled: opt_i64(r, 4)?,
            short: opt_i64(r, 5)?,
            mangled: opt_i64(r, 6)?,
            regs: opt_i64(r, 7)?.max(0),
            grid: (opt_i64(r, 8)?.max(0), opt_i64(r, 9)?.max(0), opt_i64(r, 10)?.max(0)),
            block: (opt_i64(r, 11)?.max(0), opt_i64(r, 12)?.max(0), opt_i64(r, 13)?.max(0)),
            smem: opt_i64(r, 14)?.max(0) + opt_i64(r, 15)?.max(0),
        })),
        None => Ok(None),
    }
}

fn next_memcpy(rows: &mut rusqlite::Rows) -> rusqlite::Result<Option<MRow>> {
    match rows.next()? {
        Some(r) => Ok(Some(MRow {
            start: r.get(0)?,
            end: r.get(1)?,
            device: opt_i64(r, 2)?.max(0),
            stream: opt_i64(r, 3)?,
            bytes: opt_i64(r, 4)?.max(0),
            kind: opt_i64(r, 5)?,
        })),
        None => Ok(None),
    }
}

fn arr3(v: (i64, i64, i64)) -> Json {
    Json::Arr(vec![Json::Num(v.0 as f64), Json::Num(v.1 as f64), Json::Num(v.2 as f64)])
}

// ---------------- 聚合主体 ----------------

struct Aggregated {
    facts: Json,
    elapsed_ms: f64,
}

/// 时间线聚合器（并集忙碌/空闲缝/最大并发/分桶）：每张卡各持一份——
/// 多卡报告里「A 卡空闲而 B 卡在忙」必须能被看见，合并成一条时间线会掩盖单卡停滞。
struct TimelineAcc {
    first_activity: i64,
    last_activity: i64,
    busy_ns: i64,
    running_max_end: i64,
    gaps: Vec<(i64, i64)>,
    gaps_truncated: bool,
    heap: BinaryHeap<Reverse<i64>>,
    max_concurrent: usize,
    bins: Bins,
}

impl TimelineAcc {
    fn new(bins_cap: usize) -> TimelineAcc {
        TimelineAcc {
            first_activity: i64::MAX,
            last_activity: i64::MIN,
            busy_ns: 0,
            running_max_end: i64::MIN,
            gaps: Vec::new(),
            gaps_truncated: false,
            heap: BinaryHeap::new(),
            max_concurrent: 0,
            bins: Bins::new(bins_cap),
        }
    }

    /// 并入一行 GPU 活动（内核 / 显存传输 / memset 共用）。
    fn ingest(&mut self, start: i64, end: i64, gap_min_ns: i64) {
        if end <= start {
            return;
        }
        if start < self.first_activity {
            self.first_activity = start;
        }
        if end > self.last_activity {
            self.last_activity = end;
        }
        self.bins.add(start, end);
        if self.running_max_end != i64::MIN && start > self.running_max_end && start - self.running_max_end >= gap_min_ns {
            if self.gaps.len() < MAX_GAPS {
                self.gaps.push((self.running_max_end, start));
            } else {
                self.gaps_truncated = true;
            }
        }
        if self.running_max_end == i64::MIN {
            self.busy_ns += end - start;
        } else if end > self.running_max_end {
            self.busy_ns += end - self.running_max_end.max(start);
        }
        if end > self.running_max_end {
            self.running_max_end = end;
        }
        while let Some(Reverse(top)) = self.heap.peek() {
            if *top <= start {
                self.heap.pop();
            } else {
                break;
            }
        }
        self.heap.push(Reverse(end));
        if self.heap.len() > self.max_concurrent {
            self.max_concurrent = self.heap.len();
        }
    }
}

/// 单卡的完整累计值（时间线 + 内核/传输计数）。
struct DeviceAcc {
    timeline: TimelineAcc,
    kernel_instances: u64,
    kernel_total_ns: i64,
    memcpy_count: u64,
    memcpy_bytes: i64,
}

fn run_aggregate(p: &Params) -> Result<Aggregated, String> {
    let started = Instant::now();
    let conn = Connection::open_with_flags(
        &p.sqlite,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("打开事件库失败：{e}（{}）", p.sqlite))?;
    conn.execute_batch("PRAGMA query_only = true; PRAGMA cache_size = -262144;")
        .map_err(|e| format!("设置只读连接参数失败：{e}"))?;

    let has_table = |name: &str| -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false)
    };
    let has_kernel = has_table("CUPTI_ACTIVITY_KIND_KERNEL");
    let has_memcpy = has_table("CUPTI_ACTIVITY_KIND_MEMCPY");
    // 显存 memset 也是 GPU 活动（不计入会低估利用率）；表或列缺失时降级跳过
    let has_memset = has_table("CUPTI_ACTIVITY_KIND_MEMSET");
    // 缺表时该维度为空（不抛错）：仅对存在的表探测 deviceId 列
    let dev_expr = |table: &str| -> &'static str {
        if has_column(&conn, table, "deviceId") {
            "deviceId"
        } else {
            "0 AS deviceId"
        }
    };
    // 时间窗筛选下推到 SQL（与活动区间相交即命中；无窗口时片段为空）
    let win = match (p.from_ns, p.to_ns) {
        (None, None) => String::new(),
        (from, to) => {
            let lower = from.map(|v| format!(" AND end >= {v}")).unwrap_or_default();
            let upper = to.map(|v| format!(" AND start <= {v}")).unwrap_or_default();
            format!(" WHERE 1=1{lower}{upper}")
        }
    };
    let kernel_sql = KERNEL_SQL_BASE.replace("{DEV}", dev_expr("CUPTI_ACTIVITY_KIND_KERNEL")).replace("{WIN}", &win);
    let memcpy_sql = MEMCPY_SQL_BASE.replace("{DEV}", dev_expr("CUPTI_ACTIVITY_KIND_MEMCPY")).replace("{WIN}", &win);
    let memset_sql = MEMSET_SQL_BASE.replace("{DEV}", dev_expr("CUPTI_ACTIVITY_KIND_MEMSET")).replace("{WIN}", &win);

    let mut names: HashMap<i64, String> = HashMap::new();
    if has_table("StringIds") {
        let mut stmt = conn.prepare("SELECT id, value FROM StringIds").map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let id: i64 = r.get(0).map_err(|e| e.to_string())?;
            let value: String = r
                .get::<_, Option<String>>(1)
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            names.insert(id, value);
        }
    }
    let mut memcpy_kinds: HashMap<i64, String> = HashMap::new();
    if has_table("ENUM_CUDA_MEMCPY_OPER") {
        let mut stmt = conn
            .prepare("SELECT id, label, name FROM ENUM_CUDA_MEMCPY_OPER")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let id: i64 = r.get(0).map_err(|e| e.to_string())?;
            let label: Option<String> = r.get(1).map_err(|e| e.to_string())?;
            let name: Option<String> = r.get(2).map_err(|e| e.to_string())?;
            memcpy_kinds.insert(id, label.or(name).unwrap_or_else(|| format!("kind#{id}")));
        }
    }
    let session_start: String = conn
        .query_row("SELECT utcTime FROM TARGET_INFO_SESSION_START_TIME LIMIT 1", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .ok()
        .flatten()
        .unwrap_or_default();
    let resolve_name = |id: i64| -> Option<String> {
        if id < 0 {
            None
        } else {
            names.get(&id).cloned()
        }
    };

    let mut memo = NameMemo::new();
    let mut groups: Vec<GroupAcc> = Vec::new();
    let mut overflow_groups: u64 = 0;
    let mut streams: HashMap<i64, StreamAcc> = HashMap::new();
    let mut stream_last: HashMap<i64, (i64, usize)> = HashMap::new();
    let mut small_top = NamedTopK::new(p.top_rows);
    let mut undersized_top = NamedTopK::new(p.top_rows);
    let mut pressured_top = NamedTopK::new(p.top_rows);
    let mut gap_top = GapTopK::new(p.top_rows);
    let mut memcpy_kinds_acc: HashMap<i64, MemcpyKindAcc> = HashMap::new();
    let mut memcpy_slowest = CopyTopK::new(p.top_rows);

    let mut acc = TimelineAcc::new(p.timeline_bins);
    // 每卡一份（卡数极少，多份并集/分桶不构成内存压力）
    let mut devices: HashMap<i64, DeviceAcc> = HashMap::new();

    let scan_started = Instant::now();
    let mut kernel_instances: u64 = 0;
    let mut kernel_total_ns: i64 = 0;
    let mut small_instances: u64 = 0;
    let mut small_total_ns: i64 = 0;
    let mut global_sampler = Sampler::new(GLOBAL_SAMPLE_CAP);
    let mut memcpy_count: u64 = 0;
    let mut memcpy_total_ns: i64 = 0;
    let mut memcpy_bytes: i64 = 0;

    // 单趟归并扫描：内核与显存传输两路游标各自走 start 索引，按 start 顺序归并——
    // 避免 UNION 要求的全局排序与临时落盘。
    let mut kstmt = if has_kernel {
        Some(conn.prepare(&kernel_sql).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let mut mstmt = if has_memcpy {
        Some(conn.prepare(&memcpy_sql).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let mut msstmt = if has_memset {
        conn.prepare(&memset_sql).ok()
    } else {
        None
    };
    let mut krows = match kstmt.as_mut() {
        Some(s) => Some(s.query([]).map_err(|e| e.to_string())?),
        None => None,
    };
    let mut mrows = match mstmt.as_mut() {
        Some(s) => Some(s.query([]).map_err(|e| e.to_string())?),
        None => None,
    };
    let mut kcur: Option<KRow> = match krows.as_mut() {
        Some(rows) => next_kernel(rows).map_err(|e| e.to_string())?,
        None => None,
    };
    let mut mcur: Option<MRow> = match mrows.as_mut() {
        Some(rows) => next_memcpy(rows).map_err(|e| e.to_string())?,
        None => None,
    };
    let mut msrows = match msstmt.as_mut() {
        Some(s2) => Some(s2.query([]).map_err(|e| e.to_string())?),
        None => None,
    };
    let mut mscur: Option<MRow> = match msrows.as_mut() {
        Some(rows) => next_memcpy(rows).map_err(|e| e.to_string())?,
        None => None,
    };

    loop {
        let ks = kcur.as_ref().map(|r| r.start).unwrap_or(i64::MAX);
        let ms = mcur.as_ref().map(|r| r.start).unwrap_or(i64::MAX);
        let ss = mscur.as_ref().map(|r| r.start).unwrap_or(i64::MAX);
        if ks == i64::MAX && ms == i64::MAX && ss == i64::MAX {
            break;
        }
        if ks <= ms && ks <= ss {
            let row = kcur.expect("kernel row");
            kcur = match krows.as_mut() {
                Some(rows) => next_kernel(rows).map_err(|e| e.to_string())?,
                None => None,
            };
            let dur = row.end - row.start;
            if dur <= 0 {
                continue;
            }
            acc.ingest(row.start, row.end, p.gap_min_ns);
            let dev = devices.entry(row.device).or_insert_with(|| DeviceAcc {
                timeline: TimelineAcc::new(p.timeline_bins),
                kernel_instances: 0,
                kernel_total_ns: 0,
                memcpy_count: 0,
                memcpy_bytes: 0,
            });
            dev.timeline.ingest(row.start, row.end, p.gap_min_ns);
            dev.kernel_instances += 1;
            dev.kernel_total_ns += dur;
            kernel_instances += 1;
            kernel_total_ns += dur;
            global_sampler.add(dur);

            let key = (row.demangled, row.short, row.mangled);
            let gid = memo.id_of(key, &resolve_name);
            if gid >= groups.len() {
                if groups.len() >= MAX_GROUPS {
                    overflow_groups += 1;
                } else {
                    groups.push(GroupAcc {
                        instances: 0,
                        total: 0,
                        min: i64::MAX,
                        max: 0,
                        regs: 0,
                        smem: 0,
                        grid: row.grid,
                        block: row.block,
                        streams: Vec::new(),
                        sampler: if groups.len() < MAX_SAMPLED_GROUPS {
                            Some(Sampler::new(GROUP_SAMPLE_CAP))
                        } else {
                            None
                        },
                    });
                }
            }
            if gid < groups.len() {
                let acc = &mut groups[gid];
                acc.instances += 1;
                acc.total += dur;
                if dur < acc.min {
                    acc.min = dur;
                }
                if dur > acc.max {
                    acc.max = dur;
                }
                if row.regs > acc.regs {
                    acc.regs = row.regs;
                }
                if row.smem > acc.smem {
                    acc.smem = row.smem;
                }
                if !acc.streams.contains(&row.stream) {
                    acc.streams.push(row.stream);
                }
                if let Some(s) = acc.sampler.as_mut() {
                    s.add(dur);
                }
                let total_threads =
                    row.grid.0 * row.grid.1 * row.grid.2 * row.block.0 * row.block.1 * row.block.2;
                let (instances, total) = (acc.instances, acc.total);
                let entry = NamedEntry {
                    gid,
                    weight: total,
                    instances,
                    total,
                    grid: row.grid,
                    block: row.block,
                    regs: row.regs,
                    smem: row.smem,
                    total_threads,
                };
                if dur < p.small_kernel_ns {
                    small_instances += 1;
                    small_total_ns += dur;
                    small_top.upsert(entry);
                }
                if total_threads > 0 && total_threads < DEF_UNDERSIZED_THREADS {
                    undersized_top.upsert(entry);
                }
                if row.regs > DEF_HIGH_REGISTERS || row.smem > DEF_HIGH_SMEM {
                    pressured_top.upsert(entry);
                }
            }

            let s = streams.entry(row.stream).or_insert(StreamAcc {
                first: i64::MAX,
                last: i64::MIN,
                ..Default::default()
            });
            s.kernel_instances += 1;
            s.kernel_total += dur;
            if row.start < s.first {
                s.first = row.start;
            }
            if row.end > s.last {
                s.last = row.end;
            }
            if let Some((prev_end, prev_gid)) = stream_last.get(&row.stream).copied() {
                let gap = row.start - prev_end;
                if gap > 0 && prev_gid < memo.names.len() && gid < memo.names.len() {
                    gap_top.upsert(GapEntry {
                        stream: row.stream,
                        from: prev_gid,
                        to: gid,
                        gap,
                    });
                }
            }
            if gid < memo.names.len() {
                stream_last.insert(row.stream, (row.end, gid));
            }
        } else {
            let is_memset = ss <= ms;
            let row = if is_memset { mscur.take() } else { mcur.take() }.expect("transfer row");
            if is_memset {
                mscur = match msrows.as_mut() {
                    Some(rows) => next_memcpy(rows).map_err(|e| e.to_string())?,
                    None => None,
                };
            } else {
                mcur = match mrows.as_mut() {
                    Some(rows) => next_memcpy(rows).map_err(|e| e.to_string())?,
                    None => None,
                };
            }
            let dur = row.end - row.start;
            if dur <= 0 {
                continue;
            }
            acc.ingest(row.start, row.end, p.gap_min_ns);
            let dev = devices.entry(row.device).or_insert_with(|| DeviceAcc {
                timeline: TimelineAcc::new(p.timeline_bins),
                kernel_instances: 0,
                kernel_total_ns: 0,
                memcpy_count: 0,
                memcpy_bytes: 0,
            });
            dev.timeline.ingest(row.start, row.end, p.gap_min_ns);
            dev.memcpy_count += 1;
            dev.memcpy_bytes += row.bytes;
            memcpy_count += 1;
            memcpy_total_ns += dur;
            memcpy_bytes += row.bytes;
            // memset 无 copyKind 语义，用 -1 作为方向键（输出时映射为 Memset）
            let kind_key = if is_memset { -1 } else { row.kind };
            let acc = memcpy_kinds_acc.entry(kind_key).or_default();
            acc.count += 1;
            acc.total += dur;
            acc.bytes += row.bytes;
            memcpy_slowest.add(CopyEntry {
                kind: kind_key,
                dur,
                bytes: row.bytes,
                start: row.start,
            });
            let s = streams.entry(row.stream).or_insert(StreamAcc {
                first: i64::MAX,
                last: i64::MIN,
                ..Default::default()
            });
            s.memcpy_count += 1;
            s.memcpy_bytes += row.bytes;
            if row.start < s.first {
                s.first = row.start;
            }
            if row.end > s.last {
                s.last = row.end;
            }
        }
    }

    let scan_ms = scan_started.elapsed().as_secs_f64() * 1000.0;
    let output_started = Instant::now();
    let first_activity = acc.first_activity;
    let last_activity = acc.last_activity;
    let busy_ns = acc.busy_ns;
    let window_ns = if first_activity == i64::MAX {
        0
    } else {
        (last_activity - first_activity).max(0)
    };
    let utilization = if window_ns > 0 {
        busy_ns as f64 / window_ns as f64
    } else {
        0.0
    };

    let mut group_rows: Vec<(usize, &GroupAcc)> = groups.iter().enumerate().collect();
    group_rows.sort_by(|a, b| b.1.total.cmp(&a.1.total));
    let kernels: Vec<Json> = group_rows
        .iter()
        .take(p.top_rows)
        .map(|(gid, g)| {
            let (name, mangled) = &memo.names[*gid];
            let threads_per_block = g.block.0 * g.block.1 * g.block.2;
            let grid_blocks = g.grid.0 * g.grid.1 * g.grid.2;
            let (p50, sampled) = match g.sampler.as_ref() {
                Some(s) => (s.quantile(0.5), s.sampled),
                None => (g.total / g.instances.max(1) as i64, true),
            };
            let mut streams_sorted = g.streams.clone();
            streams_sorted.sort_unstable();
            Json::obj(vec![
                ("name", Json::str(name.clone())),
                ("mangled", Json::str(mangled.clone())),
                ("instances", Json::Num(g.instances as f64)),
                ("totalNs", Json::Num(g.total as f64)),
                ("avgNs", Json::Num(g.total as f64 / g.instances.max(1) as f64)),
                ("minNs", Json::Num(if g.min == i64::MAX { 0 } else { g.min } as f64)),
                ("maxNs", Json::Num(g.max as f64)),
                ("p50Ns", Json::Num(p50 as f64)),
                ("p50Sampled", Json::Bool(sampled)),
                ("grid", arr3(g.grid)),
                ("block", arr3(g.block)),
                ("registersPerThread", Json::Num(g.regs as f64)),
                ("smemBytes", Json::Num(g.smem as f64)),
                (
                    "streams",
                    Json::Arr(streams_sorted.into_iter().map(|s| Json::Num(s as f64)).collect()),
                ),
                ("threadsPerBlock", Json::Num(threads_per_block as f64)),
                ("gridBlocks", Json::Num(grid_blocks as f64)),
                ("totalThreads", Json::Num((threads_per_block * grid_blocks) as f64)),
            ])
        })
        .collect();

    let mut stream_rows: Vec<(i64, StreamAcc)> = streams.into_iter().collect();
    stream_rows.sort_by(|a, b| b.1.kernel_total.cmp(&a.1.kernel_total));
    let streams_json: Vec<Json> = stream_rows
        .iter()
        .map(|(id, s)| {
            Json::obj(vec![
                ("streamId", Json::Num(*id as f64)),
                ("kernelInstances", Json::Num(s.kernel_instances as f64)),
                ("kernelTotalNs", Json::Num(s.kernel_total as f64)),
                ("memcpyCount", Json::Num(s.memcpy_count as f64)),
                ("memcpyBytes", Json::Num(s.memcpy_bytes as f64)),
                ("firstStart", Json::Num(if s.first == i64::MAX { 0 } else { s.first } as f64)),
                ("lastEnd", Json::Num(if s.last == i64::MIN { 0 } else { s.last } as f64)),
            ])
        })
        .collect();

    let mut kind_rows: Vec<(i64, &MemcpyKindAcc)> = memcpy_kinds_acc.iter().map(|(k, v)| (*k, v)).collect();
    kind_rows.sort_by(|a, b| b.1.total.cmp(&a.1.total));
    let memcpy_kinds_json: Vec<Json> = kind_rows
        .iter()
        .map(|(k, acc)| {
            let kind = if *k < 0 {
                "Memset".to_string()
            } else {
                memcpy_kinds.get(k).cloned().unwrap_or_else(|| format!("kind#{k}"))
            };
            Json::obj(vec![
                ("kind", Json::str(kind)),
                ("count", Json::Num(acc.count as f64)),
                ("totalNs", Json::Num(acc.total as f64)),
                ("bytes", Json::Num(acc.bytes as f64)),
                ("avgBytes", Json::Num(acc.bytes as f64 / acc.count.max(1) as f64)),
            ])
        })
        .collect();

    let max_concurrent = acc.max_concurrent;
    let gaps_truncated = acc.gaps_truncated;
    let gaps = acc.gaps;
    let mut gaps_json: Vec<Json> = gaps
        .iter()
        .map(|(s, e)| {
            Json::obj(vec![
                ("start", Json::Num(*s as f64)),
                ("end", Json::Num(*e as f64)),
                ("durNs", Json::Num((e - s) as f64)),
            ])
        })
        .collect();
    gaps_json.sort_by(|a, b| {
        let da = a.get_num("durNs").unwrap_or(0.0);
        let db = b.get_num("durNs").unwrap_or(0.0);
        db.partial_cmp(&da).unwrap_or(std::cmp::Ordering::Equal)
    });
    let gap_total_ns: i64 = gaps.iter().map(|(s, e)| e - s).sum();

    let facts = Json::obj(vec![
        ("sessionStartUtc", Json::str(session_start)),
        (
            "firstActivityNs",
            Json::Num(if first_activity == i64::MAX { 0 } else { first_activity } as f64),
        ),
        (
            "lastActivityNs",
            Json::Num(if last_activity == i64::MIN { 0 } else { last_activity } as f64),
        ),
        ("windowNs", Json::Num(window_ns as f64)),
        ("busyNs", Json::Num(busy_ns as f64)),
        ("utilization", Json::Num(utilization)),
        ("maxConcurrent", Json::Num(max_concurrent as f64)),
        ("gaps", Json::Arr(gaps_json)),
        ("gapsTruncated", Json::Bool(gaps_truncated)),
        ("gapCount", Json::Num(gaps.len() as f64)),
        ("gapTotalNs", Json::Num(gap_total_ns as f64)),
        (
            "timeline",
            Json::Arr(acc.bins.series(p.timeline_points).into_iter().map(Json::Num).collect()),
        ),
        ("timelineSpanNs", Json::Num(window_ns as f64)),
        ("kernels", Json::Arr(kernels)),
        (
            "kernelDistinctGroups",
            Json::Num((groups.len() as u64 + overflow_groups) as f64),
        ),
        ("kernelInstances", Json::Num(kernel_instances as f64)),
        ("kernelTotalNs", Json::Num(kernel_total_ns as f64)),
        ("smallKernelInstances", Json::Num(small_instances as f64)),
        ("smallKernelTotalNs", Json::Num(small_total_ns as f64)),
        ("smallKernelGroups", Json::Arr(small_top
            .entries()
            .iter()
            .map(|e| {
                let name = memo.names[e.gid].0.clone();
                Json::obj(vec![
                    ("name", Json::str(name)),
                    ("instances", Json::Num(e.instances as f64)),
                    ("totalNs", Json::Num(e.total as f64)),
                    ("avgNs", Json::Num(e.total as f64 / e.instances.max(1) as f64)),
                ])
            })
            .collect())),
        ("undersizedGroups", Json::Arr(undersized_top
            .entries()
            .iter()
            .map(|e| {
                let name = memo.names[e.gid].0.clone();
                Json::obj(vec![
                    ("name", Json::str(name)),
                    ("instances", Json::Num(e.instances as f64)),
                    ("totalNs", Json::Num(e.total as f64)),
                    ("grid", arr3(e.grid)),
                    ("block", arr3(e.block)),
                    ("totalThreads", Json::Num(e.total_threads as f64)),
                ])
            })
            .collect())),
        ("pressuredGroups", Json::Arr(pressured_top
            .entries()
            .iter()
            .map(|e| {
                let name = memo.names[e.gid].0.clone();
                Json::obj(vec![
                    ("name", Json::str(name)),
                    ("instances", Json::Num(e.instances as f64)),
                    ("totalNs", Json::Num(e.total as f64)),
                    ("registersPerThread", Json::Num(e.regs as f64)),
                    ("smemBytes", Json::Num(e.smem as f64)),
                    ("block", arr3(e.block)),
                ])
            })
            .collect())),
        ("streams", Json::Arr(streams_json)),
        ("memcpyKinds", Json::Arr(memcpy_kinds_json)),
        ("memcpyCount", Json::Num(memcpy_count as f64)),
        ("memcpyTotalNs", Json::Num(memcpy_total_ns as f64)),
        ("memcpyBytes", Json::Num(memcpy_bytes as f64)),
        ("memcpySlowest", Json::Arr(memcpy_slowest
            .entries()
            .iter()
            .map(|e| {
                let kind = if e.kind < 0 {
                    "Memset".to_string()
                } else {
                    memcpy_kinds.get(&e.kind).cloned().unwrap_or_else(|| format!("kind#{}", e.kind))
                };
                Json::obj(vec![
                    ("kind", Json::str(kind)),
                    ("durNs", Json::Num(e.dur as f64)),
                    ("bytes", Json::Num(e.bytes as f64)),
                    ("start", Json::Num(e.start as f64)),
                ])
            })
            .collect())),
        ("launchGaps", Json::Arr(gap_top
            .entries()
            .iter()
            .map(|e| {
                let from_name = memo.names[e.from].0.clone();
                let to_name = memo.names[e.to].0.clone();
                Json::obj(vec![
                    ("from", Json::str(from_name)),
                    ("to", Json::str(to_name)),
                    ("streamId", Json::Num(e.stream as f64)),
                    ("gapNs", Json::Num(e.gap as f64)),
                ])
            })
            .collect())),
        (
            "kernelDurationNs",
            Json::obj(vec![
                ("count", Json::Num(global_sampler.seen as f64)),
                ("sampled", Json::Bool(global_sampler.sampled)),
                ("p50", Json::Num(global_sampler.quantile(0.5) as f64)),
                ("p90", Json::Num(global_sampler.quantile(0.9) as f64)),
                ("p99", Json::Num(global_sampler.quantile(0.99) as f64)),
            ]),
        ),
        ("devices", Json::Arr({
            let mut ids: Vec<i64> = devices.keys().copied().collect();
            ids.sort_unstable();
            ids.into_iter()
                .map(|id| {
                    let d = devices.get(&id).expect("device acc");
                    let dgaps: Vec<Json> = d
                        .timeline
                        .gaps
                        .iter()
                        .take(p.top_rows)
                        .map(|(s0, e0)| {
                            Json::obj(vec![
                                ("start", Json::Num(*s0 as f64)),
                                ("end", Json::Num(*e0 as f64)),
                                ("durNs", Json::Num((e0 - s0) as f64)),
                            ])
                        })
                        .collect();
                    Json::obj(vec![
                        ("deviceId", Json::Num(id as f64)),
                        (
                            "firstActivityNs",
                            Json::Num(if d.timeline.first_activity == i64::MAX { 0 } else { d.timeline.first_activity } as f64),
                        ),
                        (
                            "lastActivityNs",
                            Json::Num(if d.timeline.last_activity == i64::MIN { 0 } else { d.timeline.last_activity } as f64),
                        ),
                        ("busyNs", Json::Num(d.timeline.busy_ns as f64)),
                        (
                            "utilization",
                            Json::Num(if window_ns > 0 { d.timeline.busy_ns as f64 / window_ns as f64 } else { 0.0 }),
                        ),
                        ("maxConcurrent", Json::Num(d.timeline.max_concurrent as f64)),
                        ("gaps", Json::Arr(dgaps)),
                        ("gapCount", Json::Num(d.timeline.gaps.len() as f64)),
                        (
                            "gapTotalNs",
                            Json::Num(d.timeline.gaps.iter().map(|(s0, e0)| e0 - s0).sum::<i64>() as f64),
                        ),
                        (
                            "timeline",
                            Json::Arr(d.timeline.bins.series(p.timeline_points).into_iter().map(Json::Num).collect()),
                        ),
                        ("kernelInstances", Json::Num(d.kernel_instances as f64)),
                        ("kernelTotalNs", Json::Num(d.kernel_total_ns as f64)),
                        ("memcpyCount", Json::Num(d.memcpy_count as f64)),
                        ("memcpyBytes", Json::Num(d.memcpy_bytes as f64)),
                    ])
                })
                .collect()
        })),
        ("deviceCount", Json::Num(devices.len() as f64)),
        ("hasKernelEvents", Json::Bool(has_kernel)),
        ("hasMemcpyEvents", Json::Bool(has_memcpy)),
        ("scanMs", Json::Num(scan_ms)),
        ("outputMs", Json::Num(output_started.elapsed().as_secs_f64() * 1000.0)),
    ]);

    Ok(Aggregated {
        facts,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

// ---------------- 工具注册 ----------------

fn aggregate_handler(args: &Json) -> framework::ToolResult {
    let params = match Params::from_json(args) {
        Ok(p) => p,
        Err(e) => return tool_err(e),
    };
    match run_aggregate(&params) {
        Ok(r) => {
            let summary = format!(
                "原生聚合完成：{} 次内核调用 / {} 个内核，GPU 忙碌 {} ms，耗时 {:.2}s",
                r.facts.get_num("kernelInstances").unwrap_or(0.0) as i64,
                r.facts.get_num("kernelDistinctGroups").unwrap_or(0.0) as i64,
                (r.facts.get_num("busyNs").unwrap_or(0.0) / 1e6).round() as i64,
                r.elapsed_ms / 1000.0
            );
            // 边车自报耗时（上层如实回报「原生聚合」与「JS 聚合」的差异）
            let elapsed_ms = r.elapsed_ms;
            let mut facts = r.facts;
            if let Json::Obj(ref mut map) = facts {
                map.insert("elapsedMs".to_string(), Json::Num(elapsed_ms));
            }
            tool_ok(summary, Some(facts))
        }
        Err(e) => tool_err(e),
    }
}

fn main() {
    register_tool(ToolDef {
        name: "aggregate",
        description: "NVIDIA Nsight Systems 报告事件库（SQLite）的原生单趟聚合后端：游标流式扫描内核与显存传输事件，输出并集忙碌时间、空闲缝、最大并发、时间线占用序列、每内核分组统计、每流统计、传输聚合与启动间隔排行（内存与事件规模解耦，千万级事件报告亦可实时完成）。供 nsight 分析类工具内部调用；也可直接用 sqlite 参数对已导入的事件库取原始聚合结果。"
            .to_string(),
        parameters: schema(
            r#"{"type":"object","properties":{
"sqlite":{"type":"string","description":"nsys 导出的事件库（SQLite）绝对路径"},
"gap_min_ns":{"type":"number","description":"空闲缝统计下限（纳秒，默认 50000）"},
"small_kernel_ns":{"type":"number","description":"小内核判定阈值（纳秒，默认 10000）"},
"timeline_points":{"type":"number","description":"时间线占用序列点数（默认 240）"},
"timeline_bins":{"type":"number","description":"时间线分桶上限（默认 1000，跨度大时自动倍粗分辨率）"},
"top_rows":{"type":"number","description":"各排行条数（默认 20）"}},
"required":["sqlite"]}"#,
        ),
        handler: aggregate_handler,
    });
    framework::run();
}
