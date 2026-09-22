# plan-memory.ps1 — 显存规划搜索（找出本机最优 -ncmoe）
#
# 原理：MoE 专家权重占模型的绝大部分。把前 N 层专家留在 CPU（-ncmoe N），
#       其余层专家进显存。N 越小 → 显存占用越高、CPU 侧流量越小 → 越快，直到 OOM。
#       本脚本扫描 N，实测每档的「显存占用 + 解码吞吐」，给出 Pareto 推荐点。
#
# 用法: powershell -File infer/scripts/plan-memory.ps1 [-Model xx.gguf] [-Values 0,4,8,10,12,14,16,20,40] [-Quick]
#
# 输出：bench/reports/plan-memory-<时间戳>.json / .md

param(
    [string] $Model = '',
    [int[]]  $Values = @(0, 4, 8, 10, 12, 14, 16, 20, 24, 40),
    [int]    $GenTokens = 64,
    [int]    $PromptTokens = 512,
    [switch] $Quick
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Repo = Split-Path -Parent $Root
$Cfg  = Get-Content (Join-Path $Root 'config\profiles.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$benchExe = Join-Path (Join-Path $Root $Cfg.engine_dir) 'llama-bench.exe'
if (-not (Test-Path $benchExe)) { throw "找不到 llama-bench: $benchExe" }

$modelsDir = Join-Path $Repo 'resources\models\infer'
if (-not $Model) { $Model = $Cfg.default_model }
$modelPath = if ([System.IO.Path]::IsPathRooted($Model)) { $Model } else { Join-Path $modelsDir $Model }
if (-not (Test-Path $modelPath)) { throw "找不到模型: $modelPath" }

if ($Quick) { $Values = @(8, 12, 16, 40) }

$cudaRoot = Join-Path $env:ProgramFiles 'NVIDIA GPU Computing Toolkit\CUDA'
if (Test-Path $cudaRoot) {
    $v = Get-ChildItem $cudaRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($v) { $env:PATH = "$(Join-Path $v.FullName 'bin');$env:PATH" }
}

$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$repDir = Join-Path $Root 'bench\reports'
if (-not (Test-Path $repDir)) { New-Item -ItemType Directory -Force -Path $repDir | Out-Null }

# 显存基线（跑测试前的已占用，含系统/桌面）
$smiBase = & nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>$null
$vramBaseMiB = if ($smiBase) { [int]($smiBase | Select-Object -First 1) } else { 0 }
$vramTotalMiB = 16376
$vramBudgetMiB = $vramTotalMiB - 512   # 留 512MiB 安全垫

Write-Host "显存基线: 已用 ${vramBaseMiB}MiB / 总 ${vramTotalMiB}MiB  (预算 ${vramBudgetMiB}MiB)" -ForegroundColor Cyan
Write-Host "扫描 ncmoe: $($Values -join ', ')" -ForegroundColor Cyan

$results = @()
foreach ($n in $Values) {
    Write-Host "`n>>> ncmoe=$n" -ForegroundColor Yellow
    $argv = @(
        '-m', $modelPath, '-ngl', '99', '-fa', 'on',
        '-ctk', 'q8_0', '-ctv', 'q8_0',
        '-p', "$PromptTokens", '-n', "$GenTokens", '-r', '1'
    )
    if ($n -gt 0) { $argv += @('-ncmoe', "$n") }

    $out = & $benchExe @argv 2>&1 | Out-String
    if ($out -match 'error|failed|out of memory|CUDA error|ggml_backend_cuda_buffer_type_alloc_buffer') {
        Write-Host "    失败/OOM" -ForegroundColor Red
        $results += [pscustomobject]@{ n_cpu_moe = $n; ok = $false; gpu_mib = $null; cpu_mib = $null; tg_ts = $null; pp_ts = $null }
        continue
    }

    # 从日志解析 buffer 分配（llama.cpp 加载期打印）
    $gpuMiB = $null; $cpuMiB = $null
    $mGpu = [regex]::Matches($out, 'CUDA\d+\s+model buffer size\s*=\s*([\d\.]+)\s*MiB')
    if ($mGpu.Count -gt 0) { $gpuMiB = [math]::Round((($mGpu | ForEach-Object { [double]$_.Groups[1].Value }) | Measure-Object -Sum).Sum, 1) }
    $mCpu = [regex]::Matches($out, 'CPU(?:_Mapped)?\s+model buffer size\s*=\s*([\d\.]+)\s*MiB')
    if ($mCpu.Count -gt 0) { $cpuMiB = [math]::Round((($mCpu | ForEach-Object { [double]$_.Groups[1].Value }) | Measure-Object -Sum).Sum, 1) }

    # 解析吞吐（llama-bench 文本行： | model | size | params | backend | ngl | test | t/s |）
    $tg = $null; $pp = $null
    foreach ($line in ($out -split "`r?`n")) {
        if ($line -match '\|\s*(pp\d+|tg\d+)\s*\|') {
            $cells = $line -split '\|' | ForEach-Object { $_.Trim() }
            $test = $cells | Where-Object { $_ -match '^(pp|tg)\d+$' } | Select-Object -First 1
            $val  = $cells | Where-Object { $_ -match '^\d+(\.\d+)?(\s*±\s*\d+(\.\d+)?)?$' } | Select-Object -Last 1
            if ($test -and $val) {
                $num = [double](($val -split '±')[0].Trim())
                if ($test -match '^pp') { $pp = [math]::Round($num,2) } else { $tg = [math]::Round($num,2) }
            }
        }
    }

    Write-Host ("    GPU model buffer = {0} MiB | CPU model buffer = {1} MiB | pp = {2} t/s | tg = {3} t/s" -f $gpuMiB, $cpuMiB, $pp, $tg)
    $results += [pscustomobject]@{ n_cpu_moe = $n; ok = $true; gpu_mib = $gpuMiB; cpu_mib = $cpuMiB; tg_ts = $tg; pp_ts = $pp }
}

# ---------- 推荐 ----------
$ok = $results | Where-Object { $_.ok -and $_.tg_ts -ne $null }
$best = $null
$fits = $ok | Where-Object { $_.gpu_mib -ne $null -and ($_.gpu_mib + $vramBaseMiB) -le $vramBudgetMiB } | Sort-Object n_cpu_moe
if ($fits) { $best = $fits | Select-Object -First 1 }   # 显存放得下的最小 ncmoe = 最多专家驻 GPU
$fastest = $ok | Sort-Object tg_ts -Descending | Select-Object -First 1

# ---------- 报告 ----------
$payload = [ordered]@{
    generated_at = (Get-Date).ToString('s')
    model        = (Split-Path -Leaf $modelPath)
    vram_total_mib = $vramTotalMiB
    vram_base_mib  = $vramBaseMiB
    vram_budget_mib = $vramBudgetMiB
    recommended_n_cpu_moe = if ($best) { $best.n_cpu_moe } else { $null }
    fastest_n_cpu_moe     = if ($fastest) { $fastest.n_cpu_moe } else { $null }
    results      = $results
}
$jsonPath = Join-Path $repDir "plan-memory-$stamp.json"
$payload | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $jsonPath

$md = [System.Collections.Generic.List[string]]::new()
$md.Add("# 显存规划扫描 $stamp")
$md.Add('')
$md.Add("- 模型: $($payload.model)")
$md.Add("- 显存: 总 ${vramTotalMiB}MiB / 基线已用 ${vramBaseMiB}MiB / 预算 ${vramBudgetMiB}MiB")
$md.Add("- **推荐 ncmoe = $($payload.recommended_n_cpu_moe)**（显存放得下且专家驻 GPU 最多）")
$md.Add("- 实测最快 ncmoe = $($payload.fastest_n_cpu_moe)")
$md.Add('')
$md.Add('| n_cpu_moe | 成功 | GPU buffer MiB | CPU buffer MiB | GPU+基线 MiB | pp t/s | tg t/s |')
$md.Add('|---|---|---|---|---|---|---|')
foreach ($r in $results) {
    $tot = if ($r.gpu_mib) { [math]::Round($r.gpu_mib + $vramBaseMiB,1) } else { '' }
    $md.Add("| $($r.n_cpu_moe) | $($r.ok) | $($r.gpu_mib) | $($r.cpu_mib) | $tot | $($r.pp_ts) | $($r.tg_ts) |")
}
$mdPath = Join-Path $repDir "plan-memory-$stamp.md"
$md -join "`n" | Set-Content -Encoding UTF8 $mdPath

Write-Host "`n=== 扫描结果 ===" -ForegroundColor Green
$results | Format-Table -AutoSize
Write-Host "推荐 ncmoe = $($payload.recommended_n_cpu_moe)   实测最快 = $($payload.fastest_n_cpu_moe)" -ForegroundColor Green
Write-Host "JSON: $jsonPath"
Write-Host "MD  : $mdPath"
