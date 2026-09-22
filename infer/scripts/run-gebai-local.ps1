# run-gebai-local.ps1 — 用本地推理服务起一个独立 GEBAI 实例
#
# 用途：把 infer 子项目的本地引擎接成 GEBAI 的模型算力，起一份**独立实例**用于体验/对比，
#       不影响既有实例（不同端口、独立日志、不抢调度与飞书长连接）。
#
# 用法:
#   pwsh -File infer/scripts/run-gebai-local.ps1                 # 默认 :3100 指向 :8080
#   pwsh -File infer/scripts/run-gebai-local.ps1 -Port 3200 -MaxContext 16384
#   pwsh -File infer/scripts/run-gebai-local.ps1 -Stop          # 停止本脚本起过的实例
#
# 设计要点：
#   * 服务进程用 WMI 创建，**完全脱离调用方进程树**（否则调用方会挂在长驻子进程的 stdio 句柄上）
#   * **独立数据根**（默认 <仓库根>/.gebai-local）：会话/用户数据与既有实例完全隔离，
#     不会出现两个实例同时写同一会话；`resources/` 以目录联接指向仓库资源，CV 等能力照常可用
#   * 与既有实例共处：GEBAI_SCHEDULER=off（不跑定时/闲时调度）、GC 关闭、
#     飞书机器人关闭（两个实例同时订阅事件会重复响应）
#   * 上下文预算按「推理服务窗口 − 输出预留」取值，避免超出 llama-server 的 -c 上限

param(
    [int]    $Port = 3100,
    [int]    $InferPort = 8080,
    [string] $InferModel = 'agentworld-35b-a3b',
    # 上下文预算上限：实际取值 = min(本值, 服务端 n_ctx − 输出预留)，由脚本探测后自动收敛
    [int]    $MaxContext = 122880,
    [int]    $MaxOutputTokens = 8192,
    [string] $HomeDir = '',
    [switch] $EnableThinking,
    [switch] $Stop,
    [switch] $NoWait
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # infer/
$Repo = Split-Path -Parent $Root                                              # 仓库根
$RepDir = Join-Path $Root 'bench\reports'
New-Item -ItemType Directory -Force -Path $RepDir | Out-Null
if (-not $HomeDir) { $HomeDir = Join-Path $Repo '.gebai-local' }

# ---------- 独立数据根：建目录并把 resources 联接过来 ----------
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
$resLink = Join-Path $HomeDir 'resources'
$resReal = Join-Path $Repo 'resources'
if (-not (Test-Path $resLink)) {
    if (Test-Path $resReal) {
        cmd /c mklink /J "$resLink" "$resReal" > $null 2>&1
        if (Test-Path $resLink) { Write-Host "已联接资源目录 → $resReal" -ForegroundColor DarkGray }
        else { Write-Host "资源目录联接失败（CV 等能力可能不可用），继续启动" -ForegroundColor Yellow }
    }
} elseif ((Get-Item $resLink).LinkType) {
    Write-Host "资源目录联接已存在（$($resLink)）" -ForegroundColor DarkGray
}

# ---------- 停止 ----------
if ($Stop) {
    $net = cmd /c netstat -ano 2>&1 | Select-String -Pattern ":$Port\s+.*LISTENING"
    if (-not $net) { Write-Host "端口 $Port 未监听，无需停止。" -ForegroundColor Yellow; exit 0 }
    $procId = ($net[0].ToString() -split '\s+')[-1]
    cmd /c taskkill /PID $procId /T /F 2>&1 | Select-Object -First 1 | ForEach-Object { Write-Host $_ }
    Write-Host "已停止端口 $Port 上的实例（PID $procId）" -ForegroundColor Green
    exit 0
}

# ---------- 前置检查 ----------
$health = $null
try { $health = (Invoke-WebRequest "http://127.0.0.1:$InferPort/health" -TimeoutSec 5 -UseBasicParsing).StatusCode } catch { }
if ($health -ne 200) {
    Write-Host "本地推理服务未就绪（http://127.0.0.1:$InferPort/health）。" -ForegroundColor Red
    Write-Host "请先启动：pwsh -File `"$(Join-Path $Root 'scripts\run-server.ps1')`" -Profile fast -Background" -ForegroundColor Yellow
    exit 1
}
$modelId = (Invoke-RestMethod "http://127.0.0.1:$InferPort/v1/models" -TimeoutSec 8).data[0].id

# 探测服务端实际上下文窗口，把 GEBAI 预算收敛到 min(期望值, 服务端 n_ctx − 输出预留)：
# 预算超过服务端窗口会直接报错，而服务端窗口由 run-server.ps1 的档位决定（fast=32K / long-context=128K）
$serverCtx = 0
try {
    $props = Invoke-RestMethod "http://127.0.0.1:$InferPort/props" -TimeoutSec 8
    $serverCtx = [int]$props.default_generation_settings.n_ctx
} catch { }
if ($serverCtx -gt 0) {
    $cap = [Math]::Max($serverCtx - $MaxOutputTokens, 4096)
    if ($MaxContext -gt $cap) {
        Write-Host "上下文预算收敛：$MaxContext → $cap（服务端窗口 $serverCtx − 输出预留 $MaxOutputTokens）" -ForegroundColor Yellow
        $MaxContext = $cap
    }
} else {
    Write-Host "未能探测服务端 n_ctx，按给定值 $MaxContext 使用（服务端窗口更小时会报错）" -ForegroundColor Yellow
}

$occupied = cmd /c netstat -ano 2>&1 | Select-String -Pattern ":$Port\s+.*LISTENING"
if ($occupied) {
    Write-Host "端口 $Port 已被占用（PID $(($occupied[0].ToString() -split '\s+')[-1])）。换端口或先 -Stop。" -ForegroundColor Red
    exit 1
}

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }
$entry = Join-Path $Repo 'packages\server\src\index.ts'
if (-not (Test-Path $entry)) { Write-Host "找不到服务端入口：$entry" -ForegroundColor Red; exit 1 }

# ---------- 组装启动命令 ----------
$env_pairs = [ordered]@{
    GEBAI_HOME                  = $HomeDir       # 独立数据根：会话与既有实例隔离（resources 已联接）
    GEBAI_MODE                  = 'local'        # 本地模式（admin 免登录）
    GEBAI_HOST                  = '127.0.0.1'
    GEBAI_PORT                  = "$Port"
    GEBAI_LLM_API_BASE          = "http://127.0.0.1:$InferPort/v1"
    GEBAI_LLM_API_KEY           = 'local-infer'
    GEBAI_LLM_MODEL             = $InferModel
    GEBAI_LLM_API_KIND          = 'openai'
    GEBAI_LLM_MAX_CONTEXT       = "$MaxContext"
    GEBAI_LLM_MAX_OUTPUT_TOKENS = "$MaxOutputTokens"
    GEBAI_SCHEDULER             = 'off'          # 不跑调度：与既有实例共处，不抢定时/闲时任务
    GEBAI_GC_DISABLED           = '1'            # 不跑数据 GC：避免两实例互相清理
    GEBAI_FEISHU_BOT_ENABLED    = 'false'        # 不订阅飞书长连接：避免两实例重复响应
}

# 思考模式：该模型是推理型，思维链可占输出 90%+（实测同一工具调用任务：开思考 315 token / 关思考 27 token，
# 且工具调用结果完全一致）——故默认关闭以换取响应速度；确需复杂推理时用 -EnableThinking 打开。
if (-not $EnableThinking) {
    $env_pairs['GEBAI_LLM_EXTRA_PARAMS'] = '{"chat_template_kwargs":{"enable_thinking":false}}'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $RepDir "gebai-local-$Port-$stamp.log"

# 环境变量经临时 .bat 承载（bat 内 `set "K=V"` 是 cmd 唯一可靠的带引号赋值形式；
# 一行式 `cmd /c set ... && ...` 遇到 JSON 值会被外层引号破坏）
$bat = Join-Path $HomeDir "run-gebai-$Port.bat"
$batLines = @('@echo off', "cd /d `"$Repo`"")
foreach ($kv in $env_pairs.GetEnumerator()) { $batLines += "set `"$($kv.Key)=$($kv.Value)`"" }
$batLines += "`"$bun`" `"$entry`" > `"$log`" 2>&1"
$batLines | Set-Content -Encoding ASCII $bat
$cmdline = "cmd /c `"$bat`""

Write-Host "启动 GEBAI 实例" -ForegroundColor Cyan
Write-Host "  端口        : $Port（既有实例不受影响）"
Write-Host "  模型服务    : http://127.0.0.1:$InferPort  →  模型名 $modelId"
Write-Host "  上下文预算  : $MaxContext（输出预留 $MaxOutputTokens；服务端窗口 $serverCtx）"
Write-Host "  日志        : $log"

$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
if ($created.ReturnValue -ne 0) { Write-Host "启动失败（WMI 返回 $($created.ReturnValue)）" -ForegroundColor Red; exit 1 }
Write-Host "已启动 PID=$($created.ProcessId)（已脱离当前进程树）" -ForegroundColor Green
if ($NoWait) { exit 0 }

Write-Host '等待就绪...'
for ($i = 1; $i -le 90; $i++) {
    Start-Sleep -Seconds 1
    try {
        if ((Invoke-WebRequest "http://127.0.0.1:$Port/" -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200) {
            Write-Host ""
            Write-Host "服务就绪 → http://127.0.0.1:$Port  （用时 ${i}s）" -ForegroundColor Green
            exit 0
        }
    } catch { }
    if (-not (Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue)) { break }
}
$tail = Get-Content $log -Tail 15 -ErrorAction SilentlyContinue
Write-Host "未在 90s 内就绪，日志尾部：" -ForegroundColor Yellow
$tail | ForEach-Object { Write-Host "  $_" }
exit 1
