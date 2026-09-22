# smoke-test.ps1 — 端到端冒烟验证
# 用小模型把小显存/全链路走一遍：引擎可用性 → 加载 → 生成 → OpenAI 兼容 API
# 用法: powershell -File infer/scripts/smoke-test.ps1 [-EngineDir vendor/llama-b11100-win-cuda12.4] [-ModelPath ...] [-Port 8099]
#
# 为什么要有它：大模型每次加载数十秒，任何脚本/参数问题在大模型上调试代价高。
# 本脚本用 0.5B 小模型在秒级验证全链路，是大模型实测前的必经回归。

param(
    [string]$EngineDir = '',
    [string]$ModelPath = '',
    [int]   $Port = 8099
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Repo = Split-Path -Parent $Root
$Cfg  = Get-Content (Join-Path $Root 'config\profiles.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $EngineDir) { $EngineDir = $Cfg.engine_dir }

$fail = 0
function Step($n, $ok, $detail) {
    if ($ok) { Write-Host "  [PASS] $n — $detail" -ForegroundColor Green }
    else     { Write-Host "  [FAIL] $n — $detail" -ForegroundColor Red; $script:fail++ }
    }

Write-Host "`n=== 1. 引擎可用性 ===" -ForegroundColor Cyan
$exe = Join-Path (Join-Path $Root $EngineDir) 'llama-server.exe'
if (-not (Test-Path $exe)) {
    Step 'llama-server.exe 存在' $false $exe
    Write-Host '把预编译包解压到 infer/vendor/<dir> 后重试' -ForegroundColor Yellow
    exit 1
}
Step 'llama-server.exe 存在' $true (Split-Path -Leaf (Split-Path -Parent $exe))

$cudaRoot = Join-Path $env:ProgramFiles 'NVIDIA GPU Computing Toolkit\CUDA'
if (Test-Path $cudaRoot) {
    $v = Get-ChildItem $cudaRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($v) { $env:PATH = "$(Join-Path $v.FullName 'bin');$env:PATH" }
}

$devOut = & $exe --list-devices 2>&1 | Out-String
$gpuSeen = $devOut -match 'CUDA0|Vulkan0'
$devLine = (($devOut -split "`r?`n" | Where-Object { $_ -match 'CUDA|Vulkan|CPU' } | Select-Object -First 3) -join ' / ')
if ($gpuSeen) { Step 'GPU 后端可见' $true $devLine }
else { Write-Host "  [INFO] 未见 GPU 后端（CPU-only 构建或驱动未就绪）— $devLine" -ForegroundColor Yellow }

Write-Host "`n=== 2. 模型加载与生成 ===" -ForegroundColor Cyan
if (-not $ModelPath) {
    $cand = Get-ChildItem (Join-Path $Root 'vendor\smoke') -Filter '*.gguf' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cand) { $ModelPath = $cand.FullName }
}
if (-not $ModelPath -or -not (Test-Path $ModelPath)) {
    Write-Host '  跳过（无冒烟模型，可放任意小 GGUF 到 infer/vendor/smoke/）' -ForegroundColor Yellow
} else {
    $benchExe = Join-Path (Split-Path -Parent $exe) 'llama-bench.exe'
    if (Test-Path $benchExe) {
        $out = & $benchExe -m $ModelPath -ngl 99 -p 128 -n 32 -r 1 2>&1 | Out-String
        $ok = $out -match 'tg\d+' -and $out -notmatch 'error|failed'
        $line = ($out -split "`r?`n" | Where-Object { $_ -match '\|\s*(pp|tg)\d+' } | Select-Object -First 2) -join ' ;; '
        Step 'llama-bench 生成' $ok ($line.Trim())
        if ($out -match 'CUDA0 model buffer size\s*=\s*([\d\.]+)') {
            Write-Host "         GPU model buffer = $($Matches[1]) MiB" -ForegroundColor DarkCyan
        }
    } else {
        Write-Host '  跳过 bench（无 llama-bench.exe）' -ForegroundColor Yellow
    }
}

Write-Host "`n=== 3. OpenAI 兼容端点 ===" -ForegroundColor Cyan
if ($ModelPath -and (Test-Path $ModelPath)) {
    $log = Join-Path $Root "bench\reports\smoke-server.log"
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    $p = Start-Process -FilePath $exe -ArgumentList @('-m', $ModelPath, '--host','127.0.0.1','--port',"$Port",'-ngl','99','-c','2048','-fa','on','--jinja','-a','smoke') `
            -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ready = $true; break } } catch {}
        if ($p.HasExited) { break }
    }
    Step '服务就绪' $ready "PID=$($p.Id), 日志 $log"

    if ($ready) {
        try {
            $body = @{
                model    = 'smoke'
                messages = @(@{ role = 'user'; content = '只回答两个字：就绪' })
                max_tokens = 16
                temperature = 0
            } | ConvertTo-Json -Depth 5
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/chat/completions" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 120
            $sw.Stop()
            $txt = $resp.choices[0].message.content
            Step 'chat/completions 返回' ($null -ne $txt) ("$([math]::Round($sw.Elapsed.TotalSeconds,2))s, 内容='$($txt.Trim())'")
        } catch {
            Step 'chat/completions 返回' $false $_.Exception.Message
        }
        try {
            $models = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 10
            Step '/v1/models 列表' ($models.data.Count -gt 0) ($models.data[0].id)
        } catch { Step '/v1/models 列表' $false $_.Exception.Message }
    }
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Write-Host '  已停止冒烟服务' -ForegroundColor DarkGray
} else {
    Write-Host '  跳过（无冒烟模型）' -ForegroundColor Yellow
}

Write-Host "`n=== 结果: $(if ($fail -eq 0) { '全部通过' } else { "$fail 项失败" }) ===" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
exit $fail
