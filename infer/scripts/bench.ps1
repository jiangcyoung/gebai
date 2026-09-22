# bench.ps1 — 基准测试（llama-bench 驱动）
# 用法: powershell -File infer/scripts/bench.ps1 [-Model xx.gguf] [-NCpuMoe 12] [-PromptTokens 512,4096,32768] [-GenTokens 128] [-Reps 3]
#
# 输出：控制台表格 + bench/reports/bench-<时间戳>.json（原始）+ .md（可读报告）
# 口径：avg_ts 为 llama-bench 报告的平均吞吐（token/s）；pp=prompt processing，tg=token generation

param(
    [string]   $Model = '',
    [int]      $NCpuMoe = -1,
    [int[]]    $PromptTokens = @(512, 4096, 32768),
    [int]      $GenTokens = 128,
    [int]      $Reps = 3,
    [int]      $NGpuLayers = -1,
    [int]      $Threads = 0,
    [string]   $CacheType = '',
    [string]   $FlashAttn = '',
    [string]   $SpecType = '',
    [string[]] $ExtraArgs = @()
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Repo = Split-Path -Parent $Root
$Cfg  = Get-Content (Join-Path $Root 'config\profiles.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$benchExe = Join-Path (Join-Path $Root $Cfg.engine_dir) 'llama-bench.exe'
if (-not (Test-Path $benchExe)) { throw "找不到 llama-bench: $benchExe" }

$modelsDir = Join-Path $Repo 'resources\models\infer'
if (-not $Model) { $Model = $Cfg.default_model }
$modelPath = if ([System.IO.Path]::IsPathRooted($Model)) { $Model } else { Join-Path $modelsDir $Model }
if (-not (Test-Path $modelPath)) { throw "找不到模型: $modelPath" }

$cudaRoot = Join-Path $env:ProgramFiles 'NVIDIA GPU Computing Toolkit\CUDA'
if (Test-Path $cudaRoot) {
    $v = Get-ChildItem $cudaRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($v) { $env:PATH = "$(Join-Path $v.FullName 'bin');$env:PATH" }
}
if ($FlashAttn -eq '') { $FlashAttn = 'on' }
if ($CacheType -eq '') { $CacheType = 'q8_0' }
if ($Threads -le 0) { $Threads = [int](0.5 * (Get-CimInstance Win32_Processor | Select-Object -First 1).NumberOfLogicalProcessors) }
if ($NGpuLayers -lt 0) { $NGpuLayers = 99 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$repDir = Join-Path $Root 'bench\reports'
if (-not (Test-Path $repDir)) { New-Item -ItemType Directory -Force -Path $repDir | Out-Null }

# ---------- 逐个上下文长度跑 llama-bench ----------
$allRows = @()
foreach ($pp in $PromptTokens) {
    $argv = @(
        '-m', $modelPath,
        '-ngl', "$NGpuLayers",
        '-fa', $FlashAttn,
        '-ctk', $CacheType, '-ctv', $CacheType,
        '-t', "$Threads",
        '-p', "$pp",
        '-n', "$GenTokens",
        '-r', "$Reps",
        '-o', 'json'
    )
    if ($NCpuMoe -ge 0) { $argv += @('-ncmoe', "$NCpuMoe") }
    if ($SpecType)     { $argv += @('--spec-type', $SpecType) }
    $argv += $ExtraArgs

    Write-Host "`n>>> pp=$pp tg=$GenTokens reps=$Reps  ncmoe=$NCpuMoe" -ForegroundColor Cyan
    & $benchExe @argv 2>&1 | ForEach-Object { Write-Host "    $_" }
    $raw = & $benchExe @argv 2>$null | Out-String
    try {
        $json = $raw | ConvertFrom-Json
        foreach ($e in $json) {
            $allRows += [pscustomobject]@{
                n_prompt = $e.n_prompt
                n_gen    = $e.n_gen
                pp_ts    = if ($e.n_prompt -gt 0) { [math]::Round($e.avg_ts, 2) } else { $null }
                tg_ts    = if ($e.n_gen   -gt 0) { [math]::Round($e.avg_ts, 2) } else { $null }
                stddev   = if ($e.stddev_ts) { [math]::Round($e.stddev_ts, 2) } else { $null }
            }
        }
    } catch {
        Write-Host "    解析 JSON 失败，原始输出已保留" -ForegroundColor Yellow
    }
}

# ---------- 报告 ----------
$meta = [ordered]@{
    generated_at = (Get-Date).ToString('s')
    model        = (Split-Path -Leaf $modelPath)
    model_gb     = [math]::Round((Get-Item $modelPath).Length / 1GB, 2)
    n_cpu_moe    = $NCpuMoe
    n_gpu_layers = $NGpuLayers
    flash_attn   = $FlashAttn
    cache_type   = $CacheType
    threads      = $Threads
    reps         = $Reps
    spec_type    = $SpecType
}
$payload = [ordered]@{ meta = $meta; rows = $allRows }
$jsonPath = Join-Path $repDir "bench-$stamp.json"
$payload | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $jsonPath

$md = [System.Collections.Generic.List[string]]::new()
$md.Add("# infer 基准报告 $stamp")
$md.Add('')
$md.Add("| 项 | 值 |")
$md.Add("|---|---|")
foreach ($k in $meta.Keys) { $md.Add("| $k | $($meta[$k]) |") }
$md.Add('')
$md.Add('| prompt tokens | gen tokens | pp tok/s | tg tok/s | 标准差 |')
$md.Add('|---|---|---|---|---|')
foreach ($r in $allRows) {
    $md.Add("| $($r.n_prompt) | $($r.n_gen) | $($r.pp_ts) | $($r.tg_ts) | $($r.stddev) |")
}
$mdPath = Join-Path $repDir "bench-$stamp.md"
$md -join "`n" | Set-Content -Encoding UTF8 $mdPath

Write-Host "`n=== 结果 ===" -ForegroundColor Green
$allRows | Format-Table -AutoSize
Write-Host "JSON: $jsonPath"
Write-Host "MD  : $mdPath"
