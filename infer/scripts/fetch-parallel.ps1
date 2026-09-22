# fetch-parallel.ps1 — 前台并发分片下载器（带预算，可分次调用）
#
# 为什么不用后台任务：本机环境下 sh 的 async 子进程会被系统降级/挂起（实测：同一 URL
# 前台 14MB/s、后台 0），所以大文件改由前台并发拉取，用 -BudgetMB 控制单次时长以适配超时。
#
# 用法:
#   pwsh -File infer/scripts/fetch-parallel.ps1 -Url <u> -Out <f.gguf.incomplete> -TotalBytes 17785036032 -BudgetMB 4800
#   重复调用直至打印 DONE（脚本会从当前文件大小续传）

param(
    [Parameter(Mandatory=$true)][string]$Url,
    [Parameter(Mandatory=$true)][string]$Out,
    [Parameter(Mandatory=$true)][long]$TotalBytes,
    [int]$Workers = 6,
    [int]$ChunkMB = 256,
    [int]$BudgetMB = 4600,
    [int]$TimeoutSec = 200
)

$ErrorActionPreference = 'Continue'
$prefix = "$Out.chunk"
$cur = if (Test-Path $Out) { (Get-Item $Out).Length } else { New-Item -ItemType File -Force -Path $Out | Out-Null; 0 }

if ($cur -ge $TotalBytes) { Write-Host "DONE 已完整：$cur / $TotalBytes"; exit 0 }
Write-Host ("当前 {0:N0} / {1:N0} 字节（{2:N1}%），本次预算 {3} MB" -f $cur, $TotalBytes, (100.0*$cur/$TotalBytes), $BudgetMB) -ForegroundColor Cyan

$chunkBytes = [long]$ChunkMB * 1MB
$budget = [long]$BudgetMB * 1MB
$end = [Math]::Min($cur + $budget, $TotalBytes)

# 切片
$chunks = @()
$pos = $cur
while ($pos -lt $end) {
    $e = [Math]::Min($pos + $chunkBytes, $end) - 1
    $chunks += [pscustomobject]@{ idx = $chunks.Count; start = $pos; end = $e; file = "$prefix$($chunks.Count)" }
    $pos = $e + 1
}
Write-Host "分片数: $($chunks.Count)（每片 $ChunkMB MB，并发 $Workers）"

# 断点：已存在的完整分片可跳过（大小 == 期望）
$toFetch = @()
foreach ($c in $chunks) {
    $want = $c.end - $c.start + 1
    if ((Test-Path $c.file) -and ((Get-Item $c.file).Length -eq $want)) { continue }
    $toFetch += $c
}
Write-Host "需下载分片: $($toFetch.Count)"

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$jobs = @()
foreach ($c in $toFetch) {
    while (($jobs | Where-Object { $_.State -eq 'Running' }).Count -ge $Workers) { Start-Sleep -Milliseconds 200 }
    $jobs += Start-Job -ScriptBlock {
        param($url, $s, $e, $file)
        & curl.exe -s -L --max-time 900 --retry 4 --retry-delay 2 -r "$s-$e" -o $file $url
        if (Test-Path $file) { (Get-Item $file).Length } else { 0 }
    } -ArgumentList $Url, $c.start, $c.end, $c.file
}

# 回收并按序合并
$done = @{}
$deadline = (Get-Date).AddSeconds($TimeoutSec + 120)
while ($jobs.Count -gt 0) {
    $finished = $jobs | Where-Object { $_.State -ne 'Running' }
    foreach ($j in $finished) {
        $jobs = $jobs | Where-Object { $_.Id -ne $j.Id }
        $null = Receive-Job $j
        Remove-Job $j -Force -ErrorAction SilentlyContinue
    }
    if ($jobs.Count -eq 0) { break }
    if ((Get-Date) -gt $deadline) {
        Write-Host '超时：终止剩余作业（已下分片保留，可继续调用）' -ForegroundColor Yellow
        $jobs | Stop-Job -ErrorAction SilentlyContinue
        $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
        break
    }
    Start-Sleep -Milliseconds 300
}
$sw.Stop()
Write-Host ("并发下载完成，用时 {0:N1}s" -f $sw.Elapsed.TotalSeconds)

# 按序 append 到目标（流式，避免一次性载入内存）
$merged = 0
$skipped = 0
$outStream = [System.IO.File]::Open($Out, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write)
try {
    $buf = New-Object byte[] (4MB)
    foreach ($c in $chunks) {
        $want = $c.end - $c.start + 1
        if (-not (Test-Path $c.file)) { continue }
        $sz = (Get-Item $c.file).Length
        if ($sz -ne $want) {
            Write-Host "  分片 $($c.idx) 尺寸异常（$sz != $want），丢弃待重试" -ForegroundColor Yellow
            $skipped++
            continue
        }
        $inStream = [System.IO.File]::OpenRead($c.file)
        try {
            while (($read = $inStream.Read($buf, 0, $buf.Length)) -gt 0) { $outStream.Write($buf, 0, $read) }
        } finally { $inStream.Dispose() }
        $outStream.Flush()
        Remove-Item $c.file -Force
        $merged++
    }
} finally { $outStream.Dispose() }
Write-Host "已合并 $merged 个分片（跳过 $skipped）"

$now = (Get-Item $Out).Length
Write-Host ("现在 {0:N0} / {1:N0} 字节（{2:N1}%）" -f $now, $TotalBytes, (100.0*$now/$TotalBytes)) -ForegroundColor Green
if ($now -ge $TotalBytes) {
    Write-Host 'DONE 下载完成' -ForegroundColor Green
    exit 0
}
Write-Host '未完成——请再次调用本脚本继续（预算控制单次时长）' -ForegroundColor Yellow
exit 2
