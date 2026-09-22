# restore.ps1 — 按清单校验/补齐 infer 子项目的非入库资产（引擎、模型、源码、工具链）
#
# 背景：模型权重（43.5 GB）、引擎二进制（~8 GB）、llama.cpp 源码、LLVM 等体积大且可从上游获取，
#       不入 git；本脚本按 config/assets.manifest.json 在新机器上一键还原，并逐一校验 size + sha256。
#
# 用法:
#   pwsh -File infer/scripts/restore.ps1 -List                # 列清单（不落盘、不联网）
#   pwsh -File infer/scripts/restore.ps1 -Check                # 只校验现状（只读）
#   pwsh -File infer/scripts/restore.ps1                       # 校验并补齐必需项（含解压）
#   pwsh -File infer/scripts/restore.ps1 -All                  # 连同可选资产（其他量化档/工具链）一并补齐
#   pwsh -File infer/scripts/restore.ps1 -Only model-iq3s      # 只处理指定 id（**显式点名即下载，不看 required**）
#   pwsh -File infer/scripts/restore.ps1 -Only model,engine    # 按 id/kind 前缀过滤
#   pwsh -File infer/scripts/restore.ps1 -Proxy http://<proxy-host>:<port>
#   pwsh -File infer/scripts/restore.ps1 -Quick                # 大文件仅比大小（跳过 sha256，快）
#
# 退出码: 0 = 全部就绪；1 = 有缺失/失败；2 = 校验不通过

param(
    [switch]$List,
    [switch]$Check,
    [switch]$Quick,
    [switch]$All,                                     # 连同 required=false 的可选资产一起补齐
    [switch]$Force,                                   # 即使已存在也重新下载
    [string]$Only = '',                               # 逗号分隔的 id 或 kind 前缀
    [string]$Proxy = $env:GEBAI_HTTP_PROXY,           # 默认取环境变量
    [string]$Manifest = ''
)

$ErrorActionPreference = 'Continue'
$Root  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # infer/
$Repo  = Split-Path -Parent $Root                                              # 仓库根
if (-not $Manifest) { $Manifest = Join-Path $Root 'config\assets.manifest.json' }

if (-not (Test-Path $Manifest)) { Write-Host "清单不存在: $Manifest" -ForegroundColor Red; exit 1 }
$mf = Get-Content $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json

$bases = @{ infer = $Root; resources = (Join-Path $Repo 'resources') }
$proxyArg = @()
if ($Proxy) { $proxyArg = @('--proxy', $Proxy) }

function Resolve-Target($entry) {
    $b = if ($entry.base) { $entry.base } else { 'infer' }
    $base = $bases[$b]
    if (-not $base) { throw "未知 base: $b" }
    return (Join-Path $base ($entry.path -replace '/', '\'))
}
function Get-Size($p) { if (Test-Path $p) { (Get-Item $p).Length } else { -1 } }
function Sha256($p) { (Get-FileHash $p -Algorithm SHA256).Hash.ToLower() }

function Test-Entry($entry) {
    # 返回 'ok' | 'missing' | 'size' | 'hash'
    $t = Resolve-Target $entry
    if (-not (Test-Path $t)) { return 'missing' }
    $sz = Get-Size $t
    if ($entry.size -and $sz -ne [long]$entry.size) { return 'size' }
    if (-not $Quick -and $entry.sha256) {
        if ((Sha256 $t) -ne $entry.sha256.ToLower()) { return 'hash' }
    }
    return 'ok'
}

$entries = @($mf.entries)
# -Only 显式点名时，视为“本次确实想要这些资产”→ 不受 required 限制（否则可选档位永远无法拉取）
$explicitPick = $false
if ($Only) {
    $filters = $Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    $entries = $entries | Where-Object {
        $e = $_
        $filters | Where-Object { $e.id -eq $_ -or $e.id -like "$_*" -or $e.kind -like "$_*" }
    }
    $explicitPick = $true
}

if ($List) {
    Write-Host "清单: $Manifest" -ForegroundColor Cyan
    Write-Host ("  {0,-26} {1,-10} {2,14}  {3}" -f 'id', 'kind', 'size', 'description')
    $tot = 0
    foreach ($e in $entries) {
        $tot += [long]($e.size ?? 0)
        Write-Host ("  {0,-26} {1,-10} {2,14:N0}  {3}" -f $e.id, $e.kind, [long]($e.size ?? 0), $e.description)
    }
    Write-Host ("`n  合计 {0:N0} 字节（{1:N1} GB）" -f $tot, ($tot / 1GB))
    exit 0
}

# ---------- 逐项处理 ----------
$stat = @{ ok = 0; missing = 0; size = 0; hash = 0; fetched = 0; failed = 0; skipped = 0 }
$failedIds = @()

foreach ($e in $entries) {
    $t = Resolve-Target $e
    $rel = $t.Replace($Repo + '\', '')

    if ($Force -and (Test-Path $t) -and -not $Check) { Remove-Item $t -Force -ErrorAction SilentlyContinue }

    $verdict = Test-Entry $e
    if ($verdict -eq 'ok') {
        $stat.ok++
        Write-Host ("  [OK]      {0,-26} {1}" -f $e.id, $rel) -ForegroundColor DarkGray
        continue
    }

    $stat[$verdict]++

    if ($Check) {
        $color = if ($verdict -eq 'hash') { 'Red' } else { 'Yellow' }
        Write-Host ("  [{0,-7}] {1,-26} {2}" -f $verdict.ToUpper(), $e.id, $rel) -ForegroundColor $color
        continue
    }

    if ($e.required -eq $false -and -not $All -and -not $explicitPick) {
        Write-Host ("  [SKIP]    {0,-26} 可选资产，未下载（-All 或 -Only {0} 可获取）" -f $e.id) -ForegroundColor DarkGray
        $stat.skipped++
        continue
    }

    # ---------- 下载 ----------
    $sources = @($e.sources) | Where-Object { $_.url }
    if ($sources.Count -eq 0) {
        Write-Host ("  [FAIL]    {0,-26} 清单未提供来源" -f $e.id) -ForegroundColor Red
        $stat.failed++; $failedIds += $e.id; continue
    }

    $dir = Split-Path -Parent $t
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    Write-Host ("  [FETCH]   {0,-26} {1:N2} GB  来源 {2} 个" -f $e.id, ([long]$e.size / 1GB), $sources.Count) -ForegroundColor Cyan

    $done = $false
    foreach ($s in $sources) {
        Write-Host ("            尝试 {0}: {1}" -f $s.kind, ($s.url.Substring(0, [Math]::Min(96, $s.url.Length)))) -ForegroundColor DarkGray
        if ([long]$e.size -gt 1GB) {
            # 大文件：前台并发分片（本机实测后台任务会被系统挂起）
            $fp = Join-Path $Root 'scripts\fetch-parallel.ps1'
            & pwsh -NoProfile -File $fp -Url $s.url -Out $t -TotalBytes ([long]$e.size) -Workers 6 2>&1 |
                Where-Object { $_ -match 'DONE|现在|分片|未完成|超时' } | Select-Object -Last 3 | ForEach-Object { Write-Host "              $_" -ForegroundColor DarkGray }
        } else {
            $fp = Join-Path $Root 'scripts\fetch.ps1'
            & pwsh -NoProfile -File $fp -Url $s.url -Out $t -ExpectBytes ([long]$e.size) -Sha256 ($e.sha256 ?? '') 2>&1 |
                Select-Object -Last 2 | ForEach-Object { Write-Host "              $_" -ForegroundColor DarkGray }
        }

        $v2 = Test-Entry $e
        if ($v2 -eq 'ok') { $done = $true; break }
        Write-Host ("            未通过（{0}），换下一个来源" -f $v2) -ForegroundColor Yellow
    }

    if (-not $done) {
        Write-Host ("  [FAIL]    {0,-26} 所有来源均失败" -f $e.id) -ForegroundColor Red
        $stat.failed++; $failedIds += $e.id; continue
    }
    # 补齐成功：把先前计入的“校验异常”消除（同一项不应既算异常又算新获取）
    if ($stat[$verdict] -gt 0) { $stat[$verdict]-- }
    $stat.fetched++
    Write-Host ("  [OK]      {0,-26} 下载完成并通过校验" -f $e.id) -ForegroundColor Green

    # ---------- 解压 ----------
    if ($e.kind -eq 'archive' -and $e.extractTo) {
        $ex = Join-Path $bases[($e.base ?? 'infer')] ($e.extractTo -replace '/', '\')
        if ((Test-Path $ex) -and -not $Force) {
            Write-Host ("            解压目标已存在，跳过: $($e.extractTo)") -ForegroundColor DarkGray
        } else {
            Write-Host ("            解压 → $($e.extractTo)") -ForegroundColor DarkGray
            if (-not (Test-Path $ex)) { New-Item -ItemType Directory -Force -Path $ex | Out-Null }
            if ($t -like '*.zip') {
                Expand-Archive -Path $t -DestinationPath $ex -Force
            } else {
                & tar -xf $t -C $ex 2>&1 | Select-Object -First 2 | ForEach-Object { Write-Host "              $_" -ForegroundColor DarkGray }
            }
        }
    }
}

# ---------- 汇总 ----------
Write-Host ''
Write-Host '=== 汇总 ===' -ForegroundColor Cyan
Write-Host ("  已就绪 {0}  新获取 {1}  跳过(可选) {2}" -f $stat.ok, $stat.fetched, $stat.skipped)
if ($stat.missing -or $stat.size -or $stat.hash) {
    Write-Host ("  校验异常: missing={0} size={1} hash={2}" -f $stat.missing, $stat.size, $stat.hash) -ForegroundColor Yellow
}
if ($stat.failed) {
    Write-Host ("  失败 {0}: {1}" -f $stat.failed, ($failedIds -join ', ')) -ForegroundColor Red
}

if ($Check) {
    if ($stat.missing -or $stat.size -or $stat.hash) { exit 2 } else { Write-Host '  全部就绪 ✓' -ForegroundColor Green; exit 0 }
}
if ($stat.failed) { exit 1 }
Write-Host '  全部就绪 ✓' -ForegroundColor Green
exit 0
