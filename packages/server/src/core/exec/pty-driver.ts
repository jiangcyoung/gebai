/**
 * 文件工作台 · 终端 PTY 驱动（双平台：Windows ConPTY / POSIX openpty）。
 *
 * 为什么是「编译成独立进程」：伪控制台/伪终端只能经原生 API 创建（Windows 的
 * `CreatePseudoConsole`、POSIX 的 `openpty`+`setsid`），而服务端运行时（Bun）无原生绑定
 * ——node-pty 系 N-API addon 在 Bun 下实测不可用（fd 静默无输出、resize EBADF），bun:ffi
 * 直调 libc 又拿不下控制终端与段错误风险。本模块把一段自包含原生源码（Windows 用 C#，
 * POSIX 用 C）用**系统自带**编译器（`csc.exe` / `cc`）编译成小可执行后 spawn：零第三方依赖、
 * 零编译产物分发——源码与产物都落在系统临时目录（按内容哈希命名，改内容自动换文件），
 * 运行期只付一次编译成本（组合根会预热）。
 *
 * 为什么不用 PowerShell 承载同一段 C#：宿主会消费子进程 stdin/stdout 并做编码转换，
 * 协议通道（JSON 行）与 PTY 数据会被污染；独立进程的两个流完全归驱动所有。
 *
 * 协议（stdin/stdout 均为行分隔 JSON，驱动内自解析——不引 JSON 库；双平台逐字节一致）：
 *   宿主 → 驱动：`{"t":"open","shell":"<命令行>","cwd":"<绝对路径>","cols":N,"rows":M}`（首行，必发）
 *                `{"t":"in","d":"<base64 原始字节>"}` · `{"t":"resize","cols":N,"rows":M}` · `{"t":"close"}`
 *   驱动 → 宿主：`{"t":"ready","pid":N}` · `{"t":"out","d":"<base64 原始字节>"}` ·
 *                `{"t":"exit","code":N}` · `{"t":"error","m":"..."}`
 *
 * 输出走 base64 而非裸字节：stdin/stdout 同时承载协议与数据，文本行协议最稳妥；输出按 16KB
 * 分块（xterm 自身处理跨块转义序列）。Windows 伪控制台创建有两个**必须**做对的点（否则子进程会
 * 绕过伪控制台、直接写宿主 stdout，表现为输出明文泄漏且输入不达）：`STARTF_USESTDHANDLES`
 * 且三个标准句柄置空；`bInheritHandles` 必须为 false。POSIX 侧对应的关键点见 PTY_DRIVER_C 注释。
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { which } from "./which"

/** ConPTY 驱动 C# 源（含入口 Main；编译为 exe 后由服务端 spawn）。 */
export const PTY_DRIVER_CS = String.raw`using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class GebaiPty
{
    [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
    [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFO
    {
        public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
        public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError=true)] static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr phPC);
    [DllImport("kernel32.dll", SetLastError=true)] static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ResizePseudoConsole(IntPtr hPC, COORD size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr hRead, out IntPtr hWrite, ref SECURITY_ATTRIBUTES sa, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, IntPtr buf, uint n, out uint read, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr h, byte[] buf, uint n, out uint written, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    // PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE：lpValue 必须直接传 HPCON 句柄本身
    // （传「指向句柄的指针」会让子进程初始化失败，退出码 0xC0000142）。
    const ulong PSEUDOCONSOLE_ATTR = 0x00020016;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const int STARTF_USESTDHANDLES = 0x00000100;

    static IntPtr hOutRead = IntPtr.Zero;
    static IntPtr hInWrite = IntPtr.Zero;
    static IntPtr hPC = IntPtr.Zero;
    static IntPtr hProcess = IntPtr.Zero;
    static readonly object outLock = new object();

    public static int ChildPid = 0;

    /** 创建伪控制台并拉起子进程；返回空串表示成功，否则为错误描述。 */
    public static string Start(string shell, string cwd, short cols, short rows)
    {
        var sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.bInheritHandle = 1;
        IntPtr inRead, inWrite, outRead, outWrite;
        if (!CreatePipe(out inRead, out inWrite, ref sa, 0)) return "CreatePipe(in) failed: " + Marshal.GetLastWin32Error();
        if (!CreatePipe(out outRead, out outWrite, ref sa, 0)) return "CreatePipe(out) failed: " + Marshal.GetLastWin32Error();
        // 宿主自用的一端不可继承（否则子进程持有一份副本，管道 EOF 语义被破坏）
        SetHandleInformation(inWrite, 1, 0);
        SetHandleInformation(outRead, 1, 0);
        hOutRead = outRead;
        hInWrite = inWrite;

        var size = new COORD();
        size.X = cols;
        size.Y = rows;
        IntPtr pc;
        int hr = CreatePseudoConsole(size, inRead, outWrite, 0, out pc);
        if (hr != 0) return "CreatePseudoConsole failed: hr=" + hr;
        hPC = pc;
        CloseHandle(inRead);
        CloseHandle(outWrite);

        IntPtr listSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
        IntPtr list = Marshal.AllocHGlobal(listSize);
        if (!InitializeProcThreadAttributeList(list, 1, 0, ref listSize)) return "InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error();
        if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PSEUDOCONSOLE_ATTR, pc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) return "UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error();

        var si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // 子进程标准句柄显式置空：不声明 STDHANDLES 的话，子进程会继承宿主 stdout，
        // 绕过伪控制台直接写宿主管道（输出明文泄漏 + 输入不达）；bInheritHandles 也必须为 false。
        si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = IntPtr.Zero;
        si.StartupInfo.hStdOutput = IntPtr.Zero;
        si.StartupInfo.hStdError = IntPtr.Zero;
        si.lpAttributeList = list;
        var pi = new PROCESS_INFORMATION();
        if (!CreateProcess(null, shell, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi)) return "CreateProcess failed: " + Marshal.GetLastWin32Error();
        hProcess = pi.hProcess;
        ChildPid = pi.dwProcessId;
        Marshal.FreeHGlobal(list);
        CloseHandle(pi.hThread);
        return "";
    }

    public static void WriteBytes(byte[] data)
    {
        if (hInWrite == IntPtr.Zero || data.Length == 0) return;
        uint written;
        WriteFile(hInWrite, data, (uint)data.Length, out written, IntPtr.Zero);
    }

    public static bool Resize(short cols, short rows)
    {
        if (hPC == IntPtr.Zero) return false;
        var size = new COORD();
        size.X = cols;
        size.Y = rows;
        return ResizePseudoConsole(hPC, size);
    }

    public static void ClosePty()
    {
        if (hPC != IntPtr.Zero) { ClosePseudoConsole(hPC); hPC = IntPtr.Zero; }
        if (hInWrite != IntPtr.Zero) { CloseHandle(hInWrite); hInWrite = IntPtr.Zero; }
        if (hOutRead != IntPtr.Zero) { CloseHandle(hOutRead); hOutRead = IntPtr.Zero; }
    }

    /** 单行 JSON 写出（stdout 同时是协议通道，独占锁 + 立即 flush）。 */
    static void Emit(string json)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(json + "\n");
        lock (outLock)
        {
            var stdout = Console.OpenStandardOutput();
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
    }

    static string Esc(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    /** 扁平 JSON 取值（协议只有一层对象；不引 JSON 库）。 */
    static string Val(string s, string key)
    {
        if (s == null) return null;
        string pat = "\"" + key + "\":";
        int i = s.IndexOf(pat);
        if (i < 0) return null;
        i += pat.Length;
        if (i >= s.Length) return null;
        if (s[i] == '"')
        {
            var sb = new StringBuilder();
            i++;
            while (i < s.Length)
            {
                char ch = s[i];
                if (ch == '"') break;
                if (ch == '\\' && i + 1 < s.Length)
                {
                    char nx = s[i + 1];
                    if (nx == '"') sb.Append('"');
                    else if (nx == '\\') sb.Append('\\');
                    else if (nx == 'n') sb.Append('\n');
                    else if (nx == 'r') sb.Append('\r');
                    else sb.Append(nx);
                    i += 2;
                    continue;
                }
                sb.Append(ch);
                i++;
            }
            return sb.ToString();
        }
        int j = i;
        while (j < s.Length && s[j] != ',' && s[j] != '}') j++;
        return s.Substring(i, j - i).Trim();
    }

    static int IntVal(string s, string key, int fallback)
    {
        string v = Val(s, key);
        if (v == null) return fallback;
        int n;
        return int.TryParse(v, out n) ? n : fallback;
    }

    /** 输出泵：阻塞读伪控制台输出并逐块推给宿主；读取失败/EOF 即子进程收尾。 */
    static void Pump()
    {
        IntPtr buf = Marshal.AllocHGlobal(16384);
        try
        {
            while (true)
            {
                uint n;
                if (!ReadFile(hOutRead, buf, 16384, out n, IntPtr.Zero)) break;
                if (n == 0) break;
                byte[] chunk = new byte[n];
                Marshal.Copy(buf, chunk, 0, (int)n);
                Emit("{\"t\":\"out\",\"d\":\"" + Convert.ToBase64String(chunk) + "\"}");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
        uint code = 0;
        if (hProcess != IntPtr.Zero) GetExitCodeProcess(hProcess, out code);
        Emit("{\"t\":\"exit\",\"code\":" + code + "}");
        Environment.Exit(0);
    }

    /** 主循环：首行 open，其后 in / resize / close。 */
    public static void Run()
    {
        string first = Console.In.ReadLine();
        if (first == null) return;
        string shell = Val(first, "shell");
        string cwd = Val(first, "cwd");
        int cols = IntVal(first, "cols", 120);
        int rows = IntVal(first, "rows", 30);
        if (shell == null || shell.Length == 0)
        {
            Emit("{\"t\":\"error\",\"m\":\"missing shell\"}");
            return;
        }
        string err = Start(shell, cwd, (short)cols, (short)rows);
        if (err.Length != 0)
        {
            Emit("{\"t\":\"error\",\"m\":\"" + Esc(err) + "\"}");
            return;
        }
        Emit("{\"t\":\"ready\",\"pid\":" + ChildPid + "}");
        var pump = new Thread(Pump);
        pump.IsBackground = true;
        pump.Start();
        while (true)
        {
            string line = Console.In.ReadLine();
            if (line == null) break;
            string type = Val(line, "t");
            if (type == "in")
            {
                string d = Val(line, "d");
                if (d != null && d.Length != 0)
                {
                    try { WriteBytes(Convert.FromBase64String(d)); } catch (Exception) { }
                }
            }
            else if (type == "resize")
            {
                int c = IntVal(line, "cols", 0);
                int r = IntVal(line, "rows", 0);
                if (c > 0 && r > 0) Resize((short)c, (short)r);
            }
            else if (type == "close")
            {
                ClosePty();
                break;
            }
        }
    }

    public static int Main(string[] args)
    {
        Run();
        return 0;
    }
}
`

/** 驱动启动方式：可用的 spawn 命令行，或不可用原因（供上层降级）。 */
export interface PtyDriverLaunch {
  ok: boolean
  /** ok=true：直接 spawn 该命令行（argv 形式，无需 shell 引号处理）。 */
  cmd?: string[]
  /** ok=false：面向用户的中文原因。 */
  reason?: string
}

/** .NET Framework 自带编译器（按平台位宽优先 x64）。 */
function findCsc(): string | null {
  const windir = process.env.WINDIR || "C:\\Windows"
  const candidates = [
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ]
  for (const p of candidates) if (existsSync(p)) return p
  return null
}

/** POSIX C 编译器（cc 是 POSIX 规范工具，每台 Linux/macOS 必有其一；gcc/clang 兑底）。 */
function findCc(): string | null {
  for (const c of ["cc", "gcc", "clang"]) {
    const p = which(c)
    if (p) return p
  }
  return null
}

/** POSIX PTY 驱动 C 源（与上方 C# 同协议、同生命周期；编译为小可执行后由服务端 spawn）。
 *
 * 原生层必做的四件事（Bun/Node 均不可达，故落在驱动里）：
 * 1. `openpty` 创建伪终端对，`TIOCSWINSZ` 设初始窗口尺寸；
 * 2. 子进程 `setsid()` 脱离宿主进程组后**重开** slave 路径（open 后才具备成为控制终端的资格），
 *    再 `ioctl(TIOCSCTTY)` 挂上——不重开则 ioctl 报 ENOTTY，这也是 ssh/expect 的标准做法；
 * 3. `cfmakeraw` 后回补 `ISIG|ICANON|ECHO`（raw 化会清掉）：`\x03`→SIGINT、`\x1c`→SIGQUIT、
 *    行缓冲与回显交回 termios，shell 的行编辑/Tab 补全才是原生行为；
 * 4. 读泵线程 poll master；SIGCHLD 以 self-pipe 唤醒后 WNOHANG 收尸上报退出码（信号处理函数里
 *    只写管道，多线程环境下 async-signal-safe）；SIGTERM/SIGINT/SIGHUP 时 kill(-pid) 整组挂断
 *    （控制终端会给前台进程组发 SIGHUP，覆盖 ssh 掉线的真实行为）。shell 命令行经 /bin/sh -c
 *    解析（与 Windows 侧 CreateProcess 命令行语义对齐，宿主不用拼 argv）。
 */
export const PTY_DRIVER_C = String.raw`#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif

static int g_master = -1;
static pid_t g_child = -1;
static volatile sig_atomic_t g_child_gone = 0;
static volatile sig_atomic_t g_terminate = 0;
static int g_sigpipe[2] = { -1, -1 };
static volatile sig_atomic_t g_exiting = 0;

/* ---------- 协议：无 JSON 库，最小手写解析 ---------- */

static void emit_raw(const char *s) {
    fputs(s, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void emit_error(const char *msg) {
    fputs("{\"t\":\"error\",\"m\":\"", stdout);
    for (const char *p = msg; *p; p++) {
        if (*p == '"' || *p == '\\') fputc('\\', stdout);
        if ((unsigned char)*p >= 0x20) fputc(*p, stdout);
    }
    fputs("\"}\n", stdout);
    fflush(stdout);
}

static const char *jstr(const char *line, const char *key) {
    size_t klen = strlen(key);
    const char *p = line;
    while ((p = strstr(p, key)) != NULL) {
        const char *q = p + klen;
        if (q[0] == '"' && q[1] == ':' && q[2] == '"') return q + 3;
        p += klen;
    }
    return NULL;
}

/* Integer key lookup: build the pattern quote+key+quote+colon by hand (no format string, no
   escape pitfalls). Unlike jstr, the value does not start with a quote (numbers are bare). */
static int jint(const char *line, const char *key, int dflt) {
    char pat[64];
    size_t klen = strlen(key);
    if (klen + 4 >= sizeof pat) return dflt;
    pat[0] = '"';
    memcpy(pat + 1, key, klen);
    pat[klen + 1] = '"';
    pat[klen + 2] = ':';
    pat[klen + 3] = 0;
    const char *p = strstr(line, pat);
    if (!p) return dflt;
    int v = 0;
    int n = 0;
    if (sscanf(p + klen + 3, "%d%n", &v, &n) == 1 && n > 0) return v;
    return dflt;
}

static const char *jval_end(const char *v) {
    const char *e = strchr(v, '"');
    return e ? e : v + strlen(v);
}

/* ---------- base64：入向解码 / 出向分块编码 ---------- */

static int b64d(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static size_t b64_decode(const char *in, size_t in_len, unsigned char *out) {
    size_t n = 0;
    unsigned acc = 0;
    int bits = 0;
    for (size_t i = 0; i < in_len; i++) {
        int d = b64d(in[i]);
        if (d < 0) continue;
        acc = (acc << 6) | (unsigned)d;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[n++] = (unsigned char)((acc >> bits) & 0xFF);
        }
    }
    return n;
}

static void b64_block(const unsigned char *in, size_t n, char *out) {
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i + 2 < n; i += 3) {
        unsigned v = ((unsigned)in[i] << 16) | ((unsigned)in[i + 1] << 8) | in[i + 2];
        out[o++] = T[(v >> 18) & 63];
        out[o++] = T[(v >> 12) & 63];
        out[o++] = T[(v >> 6) & 63];
        out[o++] = T[v & 63];
    }
    size_t rem = n % 3;
    if (rem == 1) {
        unsigned v = (unsigned)in[n - 1] << 16;
        out[o++] = T[(v >> 18) & 63];
        out[o++] = T[(v >> 12) & 63];
        out[o++] = '=';
        out[o++] = '=';
    } else if (rem == 2) {
        unsigned v = ((unsigned)in[n - 2] << 16) | ((unsigned)in[n - 1] << 8);
        out[o++] = T[(v >> 18) & 63];
        out[o++] = T[(v >> 12) & 63];
        out[o++] = T[(v >> 6) & 63];
        out[o++] = '=';
    }
    out[o] = 0;
}

/* ---------- 信号 ---------- */

static void on_signal(int sig) {
    if (sig == SIGCHLD) g_child_gone = 1;
    else g_terminate = 1;
    if (g_sigpipe[1] >= 0) {
        ssize_t r = write(g_sigpipe[1], "x", 1);
        (void)r;
    }
}

static void forward_signal(int sig) {
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(sig, &sa, NULL);
}

/* Startup-phase slave fd (parent side): kept open until the first master data or child death,
 * closing the "openpty→fork→bash reopen slave" window — during it no slave is open and a poll
 * on master would report HUP/EIO spuriously, killing the session at birth (race seen under Bun). */
static int g_startup_slave = -1;

static void release_startup_slave(void) {
    if (g_startup_slave >= 0) {
        close(g_startup_slave);
        g_startup_slave = -1;
    }
}
/* 挂断伪终端：kill(-pid, SIGHUP) 送前台进程组（控制终端语义），再关 master（slave 读到 EOF）。 */
static void close_pty(void) {
    release_startup_slave();
    if (g_child > 0) kill(-g_child, SIGHUP);
    if (g_master >= 0) {
        close(g_master);
        g_master = -1;
    }
}

static int start_shell(const char *shell_cmd, const char *cwd, int cols, int rows) {
    struct winsize ws;
    memset(&ws, 0, sizeof ws);
    ws.ws_col = (unsigned short)cols;
    ws.ws_row = (unsigned short)rows;

    int master, slave_fd;
    char slave_path[128];
    /* aslave must be a real pointer: glibc writes to it unconditionally (only BSD allows NULL). */
    if (openpty(&master, &slave_fd, slave_path, NULL, &ws) != 0) {
        emit_error(strerror(errno));
        return -1;
    }
    /* Parent keeps slave_fd during startup (see g_startup_slave); it would hold EOF off forever,
       so it is released on first master data / child death instead of closed right here. */
    g_startup_slave = slave_fd;
    g_master = master;

    pid_t pid = fork();
    if (pid < 0) {
        emit_error(strerror(errno));
        close(master);
        g_master = -1;
        return -1;
    }
    if (pid == 0) {
        /* 子进程：新会话 → 重开 slave（新会话 leader 首个 tty open 自动成控制终端，BSD/macOS 亦然）→ 配 termios → 重定向 */
        setsid();
        int slave = open(slave_path, O_RDWR);
        if (slave < 0) _exit(127);
        struct termios tio;
        if (tcgetattr(slave, &tio) == 0) {
            cfmakeraw(&tio);
            /* raw 清掉的终端语义回补：信号字符（\x03=SIGINT/\x1c=SIGQUIT）、行缓冲、回显 */
            tio.c_lflag |= ISIG | ICANON | ECHO;
            tio.c_cc[VINTR] = 3;
            tio.c_cc[VQUIT] = 28;
            tio.c_cc[VERASE] = 127;
            tio.c_cc[VEOF] = 4;
            tcsetattr(slave, TCSANOW, &tio);
        }
        dup2(slave, 0);
        dup2(slave, 1);
        dup2(slave, 2);
        if (slave > 2) close(slave);
        close(master);
        if (cwd && *cwd && chdir(cwd) != 0) {
            /* 目录不可达不阻断 shell：留在当前目录 */
        }
        putenv("TERM=xterm-256color");
        execl("/bin/sh", "sh", "-c", shell_cmd, (char *)NULL);
        _exit(127);
    }
    g_child = pid;
    return 0;
}

/* 输出泵：独立线程 poll master，事件经行协议上报；退出条件 = 子进程已收尸且 master 读到 EOF/EIO。 */
static void *pump_output(void *arg) {
    (void)arg;
    unsigned char buf[16384];
    char b64[17000];
    char line[17400];
    int child_status = -1;

    for (;;) {
        if (g_terminate || g_exiting) {
            close_pty();
            break;
        }
        struct pollfd pfd[2];
        pfd[0].fd = g_master;
        pfd[0].events = POLLIN;
        pfd[0].revents = 0;
        pfd[1].fd = g_sigpipe[0];
        pfd[1].events = POLLIN;
        pfd[1].revents = 0;
        int nfd = g_master >= 0 ? 2 : 1;
        int pr = poll(pfd, (nfds_t)nfd, 200);
        if (pr < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (pfd[1].revents & POLLIN) {
            char c;
            ssize_t r = read(g_sigpipe[0], &c, 1);
            (void)r;
        }
        if (pfd[0].revents & (POLLIN | POLLHUP | POLLERR)) {
            if (g_master >= 0) {
                ssize_t n = read(g_master, buf, sizeof buf);
                if (n > 0) {
                    /* First master data: the shell has reopened the slave — safe to release the
                       startup fd (further EOF on master now genuinely means all slaves closed). */
                    release_startup_slave();
                    size_t off = 0;
                    while (off < (size_t)n) {
                        size_t chunk = (size_t)(n - off) > 12288 ? 12288 : (size_t)(n - off);
                        b64_block(buf + off, chunk, b64);
                        snprintf(line, sizeof line, "{\"t\":\"out\",\"d\":\"%s\"}", b64);
                        emit_raw(line);
                        off += chunk;
                    }
                } else if (n <= 0 && (errno == EIO || errno == EAGAIN || n == 0)) {
                    if (n == 0 || errno == EIO) {
                        /* EOF/EIO：slave 侧全关（shell 退出）。非阻塞下 EAGAIN 不算 */
                        if (n == 0 || errno == EIO) close(g_master), g_master = -1;
                    }
                }
            }
        }
        if (g_child_gone) {
            g_child_gone = 0;
            release_startup_slave(); /* child died before reopening slave (e.g. exec fail): release now */
            int st;
            pid_t w;
            while ((w = waitpid(-1, &st, WNOHANG)) > 0) {
                if (w == g_child) child_status = st;
            }
        }
        if (child_status != -1 && g_master < 0) {
            int code = WIFEXITED(child_status) ? WEXITSTATUS(child_status) : WIFSIGNALED(child_status) ? 128 + WTERMSIG(child_status) : 130;
            snprintf(line, sizeof line, "{\"t\":\"exit\",\"code\":%d}", code);
            emit_raw(line);
            break;
        }
    }
    return NULL;
}

int main(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (pipe(g_sigpipe) != 0) return 1;
    signal(SIGPIPE, SIG_IGN);
    forward_signal(SIGCHLD);
    forward_signal(SIGTERM);
    forward_signal(SIGINT);
    forward_signal(SIGHUP);

    char line[65536];
    if (!fgets(line, sizeof line, stdin)) return 1;
    line[strcspn(line, "\r\n")] = 0;

    const char *shell = jstr(line, "shell");
    const char *cwd = jstr(line, "cwd");
    int cols = jint(line, "cols", 120);
    int rows = jint(line, "rows", 30);
    if (!shell || !*shell) {
        emit_error("missing shell");
        return 1;
    }
    char shell_cmd[4096];
    size_t sn = jval_end(shell) - shell;
    if (sn >= sizeof shell_cmd) sn = sizeof shell_cmd - 1;
    memcpy(shell_cmd, shell, sn);
    shell_cmd[sn] = 0;

    char cwd_buf[4096];
    if (cwd) {
        size_t cn = jval_end(cwd) - cwd;
        if (cn >= sizeof cwd_buf) cn = sizeof cwd_buf - 1;
        memcpy(cwd_buf, cwd, cn);
        cwd_buf[cn] = 0;
    } else {
        cwd_buf[0] = 0;
    }

    if (start_shell(shell_cmd, cwd_buf, cols, rows) != 0) return 1;

    char pid_line[64];
    snprintf(pid_line, sizeof pid_line, "{\"t\":\"ready\",\"pid\":%ld}", (long)g_child);
    emit_raw(pid_line);

    pthread_t th;
    pthread_create(&th, NULL, pump_output, NULL);

    while (fgets(line, sizeof line, stdin)) {
        line[strcspn(line, "\r\n")] = 0;
        const char *type = jstr(line, "t");
        if (type && strncmp(type, "close", 5) == 0) {
            g_exiting = 1;
            close_pty();
            break;
        }
        if (g_terminate) break;
        if (!type) continue;
        if (strncmp(type, "in", 2) == 0) {
            const char *d = jstr(line, "d");
            if (d && g_master >= 0) {
                size_t dn = jval_end(d) - d;
                unsigned char raw[49152];
                if (dn > sizeof raw * 4 / 3) dn = sizeof raw * 4 / 3;
                size_t rn = b64_decode(d, dn, raw);
                ssize_t w = write(g_master, raw, rn);
                (void)w;
            }
        } else if (strncmp(type, "resize", 6) == 0) {
            int c = jint(line, "cols", 0);
            int r = jint(line, "rows", 0);
            if (c > 0 && r > 0 && g_master >= 0) {
                struct winsize ws;
                memset(&ws, 0, sizeof ws);
                ws.ws_col = (unsigned short)c;
                ws.ws_row = (unsigned short)r;
                ioctl(g_master, TIOCSWINSZ, &ws);
                if (g_child > 0) kill(-g_child, SIGWINCH);
            }
        }
    }
    if (g_exiting != 1) {
        g_exiting = 1;
        close_pty();
    }
    pthread_join(th, NULL);
    return 0;
}
`

/** 编译结果缓存（成功才缓存：失败允许下次重试，例如临时的杀软拦截）。 */
let cachedLaunch: PtyDriverLaunch | null = null

/**
 * 准备 PTY 驱动（首次调用同步编译，约 1s；组合根在启动后预热以避开用户首点等待）。
 * Windows：C# + csc.exe（ConPTY）；POSIX（Linux/macOS）：C + cc/gcc/clang（openpty）。
 * 任一环节缺失（非目标平台 / 无编译器 / 编译失败）返回 ok:false，由上层降级到管道式终端。
 */
export function preparePtyDriver(): PtyDriverLaunch {
  if (cachedLaunch?.ok) return cachedLaunch
  const win = process.platform === "win32"
  if (!win && process.platform !== "darwin" && process.platform !== "linux") {
    return { ok: false, reason: "PTY 终端仅支持 Windows/macOS/Linux（当前平台降级为管道式终端）" }
  }
  const compiler = win ? findCsc() : findCc()
  if (!compiler) {
    return {
      ok: false,
      reason: win
        ? "未找到 .NET Framework 编译器 csc.exe（降级为管道式终端）"
        : "未找到 C 编译器（cc/gcc/clang 任一；Linux 安装 build-essential / macOS 执行 xcode-select --install 后重试，当前降级为管道式终端）",
    }
  }
  const src = win ? PTY_DRIVER_CS : PTY_DRIVER_C
  const ext = win ? ".cs" : ".c"
  const outExt = win ? ".exe" : ""
  const dir = join(tmpdir(), "gebai-pty")
  // 哈希含平台：多平台共享同一 /tmp（容器卷挂载）时产物不串台
  const hash = createHash("sha256").update(process.platform + ":" + src).digest("hex").slice(0, 16)
  const srcPath = join(dir, "driver-" + hash + ext)
  const binPath = join(dir, "driver-" + hash + outExt)
  try {
    mkdirSync(dir, { recursive: true })
    if (!existsSync(binPath)) {
      // Windows 带 BOM 写入：csc 默认按系统代码页读源文件，源码含中文注释，BOM 保证按 UTF-8 解析
      writeFileSync(srcPath, win ? "\uFEFF" + src : src, "utf8")
      const args = win
        ? ["/nologo", "/target:exe", "/platform:x64", "/out:" + binPath, srcPath]
        : ["-O2", "-o", binPath, srcPath]
      let r = spawnSync(compiler, args, { timeout: 60_000 })
      // POSIX：openpty 在多数 libc 位于 libutil（BSD/macOS）；链接失败补 -lutil 重试（musl 内置则不受影响）
      if (!win && (r.status !== 0 || !existsSync(binPath))) {
        r = spawnSync(compiler, ["-O2", "-o", binPath, srcPath, "-lutil"], { timeout: 60_000 })
      }
      if (r.status !== 0 || !existsSync(binPath)) {
        const detail = (r.stderr?.toString() || r.error?.message || "").trim().slice(0, 200)
        return { ok: false, reason: "PTY 驱动编译失败" + (detail ? "：" + detail : "") + "（降级为管道式终端）" }
      }
      if (!win) {
        try {
          chmodSync(binPath, 0o755)
        } catch {
          /* 权限位失败由编译器默认 umask 兑底 */
        }
      }
    }
    cachedLaunch = { ok: true, cmd: [binPath] }
    return cachedLaunch
  } catch (err) {
    return { ok: false, reason: "PTY 驱动准备失败：" + (err as Error).message + "（降级为管道式终端）" }
  }
}
