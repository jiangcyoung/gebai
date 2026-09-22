# verify.ps1 — 正确性基线验证（质量回归用）
# 用法: pwsh -File infer/scripts/verify.ps1 [-Port 8080] [-Tag baseline] [-Save]
#
# 目的：性能优化很容易引入质量退化（参见上游 issue #28879：GDN 架构上精度与困惑度非单调）。
# 因此每次改配置/换量化/打补丁，都要用同一组固定提示词 + 温度 0 做输出回归对比。
#
# 用法约定：
#   -Save       记录为基线（verify-baseline-<time>.json）
#   不带 -Save  与最近基线对比，输出差异

param(
    [int]    $Port = 8080,
    [string] $Tag = '',
    [switch] $Save,
    [string] $BaselineFile = ''
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$repDir = Join-Path $Root 'bench\reports'
New-Item -ItemType Directory -Force -Path $repDir | Out-Null

# 固定提示词集：覆盖事实问答 / 结构化输出 / 工具调用 JSON / 长文摘要 / 代码
$prompts = @(
    @{ id = 'fact';     text = '用一句话说明 MoE（混合专家）模型为什么比同规模稠密模型推理更快。' },
    @{ id = 'json';     text = '只输出 JSON（不要任何解释）：{"name":"<你的模型名>","sparse":<是否为稀疏模型,布尔>,"experts_total":<总专家数,整数>}' },
    @{ id = 'toolcall'; text = '把下面需求表达成一个函数调用 JSON（只输出 JSON）：查询北京今天的天气，温度单位摄氏度。' },
    @{ id = 'count';    text = '从 1 数到 20，用逗号分隔，只输出数字。' },
    @{ id = 'reason';   text = '一个水池有甲乙两个进水管，甲单独注满需 6 小时，乙需 4 小时，两管同时开需几小时注满？只给最终答案与一行算式。' },
    @{ id = 'zh';       text = '把这句话压缩到 15 字以内，保留核心信息：我们计划在下周三之前完成本地推理引擎的显存规划调优与基准测试工作。' }
)

$results = @()
foreach ($p in $prompts) {
    $body = @{
        messages    = @(@{ role = 'user'; content = $p.text })
        max_tokens  = 256
        temperature = 0
        seed        = 12345
        top_k       = 1
    } | ConvertTo-Json -Depth 6
    try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/chat/completions" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 300
        $sw.Stop()
        $txt = $r.choices[0].message.content
        $results += [pscustomobject]@{
            id      = $p.id
            prompt  = $p.text
            output  = $txt
            chars   = $txt.Length
            elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
            usage   = $r.usage
        }
        Write-Host "  [$($p.id)] $([math]::Round($sw.Elapsed.TotalSeconds,2))s, $($txt.Length) 字" -ForegroundColor Green
    } catch {
        Write-Host "  [$($p.id)] 失败: $($_.Exception.Message)" -ForegroundColor Red
        $results += [pscustomobject]@{ id = $p.id; prompt = $p.text; output = $null; error = $_.Exception.Message }
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$payload = [ordered]@{ generated_at = (Get-Date).ToString('s'); tag = $Tag; port = $Port; results = $results }

if ($Save -or -not $BaselineFile) {
    $out = Join-Path $repDir "verify-$($Tag)${stamp}.json"
    $payload | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $out
    Write-Host "`n已记录: $out" -ForegroundColor Cyan
    if (-not $Save) {
        $prev = Get-ChildItem $repDir -Filter 'verify-*.json' | Where-Object { $_.FullName -ne $out } |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($prev) {
            Write-Host "`n=== 与上一次（$($prev.Name)）对比 ===" -ForegroundColor Cyan
            $old = Get-Content $prev.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($n in $results) {
                $o = $old.results | Where-Object { $_.id -eq $n.id } | Select-Object -First 1
                if (-not $o) { Write-Host "  [$($n.id)] 新增（无对比）" -ForegroundColor Yellow; continue }
                if ($o.output -eq $n.output) { Write-Host "  [$($n.id)] 输出一致" -ForegroundColor Green }
                else {
                    Write-Host "  [$($n.id)] 输出变化:" -ForegroundColor Yellow
                    Write-Host "      old: $($o.output -replace "`n",' ' | Select-Object -First 1)" -ForegroundColor DarkGray
                    Write-Host "      new: $($n.output -replace "`n",' ' | Select-Object -First 1)" -ForegroundColor DarkGray
                }
            }
        }
    }
} else {
    $out = $BaselineFile
}
