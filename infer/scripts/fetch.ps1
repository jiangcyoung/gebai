# fetch.ps1 — 健壮下载器（重试 + 断点续传 + 大小校验）
# 用法: pwsh -File infer/scripts/fetch.ps1 -Url <url> -Out <path> [-ExpectBytes N] [-Retries 30] [-Sha256 <hash>]
#
# 为什么需要它：本机到 GitHub release 的链路间歇性可达（同一 URL 时而 200 时而超时），
# 单次 curl 必然半途而废。本脚本循环续传直至字节数达标，并做 sha256 校验。

param(
    [Parameter(Mandatory=$true)][string]$Url,
    [Parameter(Mandatory=$true)][string]$Out,
    [long]$ExpectBytes = 0,
    [int]$Retries = 40,
    [int]$TimeoutSec = 300,
    [string]$Sha256 = ''
)

$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

if ($ExpectBytes -le 0) {
    $hdr = & curl.exe -sIL --max-time 30 $Url 2>$null
    $m = [regex]::Match(($hdr -join "`n"), 'Content-Length:\s*(\d+)')
    if ($m.Success) { $ExpectBytes = [long]$m.Groups[1].Value }
}
Write-Host "目标: $Out"
Write-Host "预期字节: $(if ($ExpectBytes -gt 0) { $ExpectBytes } else { '未知' })"

function Get-Size($p) { if (Test-Path $p) { (Get-Item $p).Length } else { 0 } }

for ($i = 1; $i -le $Retries; $i++) {
    $cur = Get-Size $Out
    if ($ExpectBytes -gt 0 -and $cur -ge $ExpectBytes) { break }

    Write-Host ("[{0}/{1}] 续传自 {2:N2} MB" -f $i, $Retries, ($cur/1MB)) -ForegroundColor DarkGray
    & curl.exe -sL -C - -o $Out --connect-timeout 20 --max-time $TimeoutSec --retry 3 --retry-delay 2 $Url 2>$null

    $now = Get-Size $Out
    if ($ExpectBytes -gt 0 -and $now -ge $ExpectBytes) { break }
    if ($now -eq $cur) { Start-Sleep -Seconds ([Math]::Min(5 * $i, 30)) }   # 无进展则退避
}

$final = Get-Size $Out
if ($ExpectBytes -gt 0 -and $final -lt $ExpectBytes) {
    Write-Host "未完成：$final / $ExpectBytes 字节（重试 $Retries 次后放弃）" -ForegroundColor Red
    exit 1
}
Write-Host ("完成：{0:N2} MB" -f ($final/1MB)) -ForegroundColor Green

if ($Sha256) {
    $h = (Get-FileHash $Out -Algorithm SHA256).Hash.ToLower()
    if ($h -eq $Sha256.ToLower()) { Write-Host "sha256 校验通过: $h" -ForegroundColor Green }
    else { Write-Host "sha256 不匹配！期望 $Sha256，实际 $h" -ForegroundColor Red; exit 2 }
}
exit 0
