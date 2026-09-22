# bench-concurrency-sweep.ps1 — 并发饱和诊断：找出服务端批处理效率损失在哪
# 背景：batched-bench 统一批处理 B=8 → 391 t/s（4.1×），但 llama-server -np 8 只到 349.5（2.67×）
# 目标：扫描 slot 数 × 请求数 × batch 配置，定位差距来源
param(
  [string]$NpList = "8,16",
  [int]$Reqs = 16,
  [int]$Tokens = 200,
  [int]$Port = 8080
)

$ErrorActionPreference = 'Continue'
$env:PATH = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin;' + $env:PATH
$v = 'C:\Users\Administrator\code\gebai\infer\vendor\llama-b11100-win-cuda12.4'
$m = 'C:\Users\Administrator\code\gebai\resources\models\infer\Qwen-AgentWorld-35B-A3B-UD-IQ3_XXS.gguf'

$bodyFile = "$env:TEMP\cs-body.json"
[System.IO.File]::WriteAllText($bodyFile,
  '{"prompt":"请简述混合专家模型的稀疏激活原理。","n_predict":' + $Tokens + ',"temperature":0}',
  [System.Text.UTF8Encoding]::new($false))

function One-Call($out) {
  Remove-Item $out -ErrorAction SilentlyContinue
  & curl.exe -s -X POST "http://127.0.0.1:$Port/completion" -H 'Content-Type: application/json' --data-binary "@$bodyFile" -o $out --max-time 900 2>&1 | Out-Null
}

foreach ($np in ($NpList -split ',' | ForEach-Object { [int]$_.Trim() })) {
  cmd /c taskkill /IM llama-server.exe /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  $log = "$env:TEMP\cs-$np.log"
  $p = Start-Process -FilePath "$v\llama-server.exe" -ArgumentList @(
    '-m',$m,'-ngl','99','-ncmoe','0','-c','32768','--port',"$Port",'-fa','on',
    '-ctk','q8_0','-ctv','q8_0','-t','14','-np',"$np",'-b','4096','-ub','1024','--cont-batching','-bs'
  ) -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
  $ok = $false
  for ($i=0; $i -lt 50; $i++) { Start-Sleep -Seconds 2; try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ok=$true; break } } catch {}; if ($p.HasExited) { break } }
  if (-not $ok) { Write-Host "  np=$np 启动失败"; continue }

  # 预热（付掉 CUDA graph 捕获）
  One-Call "$env:TEMP\cs-w.json"

  # 并发 $Reqs 个请求（可能超过 slot 数 → 排队）
  $outs = @(); $procs = @()
  for ($k=1; $k -le $Reqs; $k++) {
    $o = "$env:TEMP\cs-r-$np-$k.json"; $outs += $o
    $procs += Start-Process -FilePath 'curl.exe' -ArgumentList @('-s','-X','POST',"http://127.0.0.1:$Port/completion",'-H','Content-Type: application/json','--data-binary',"@$bodyFile",'-o',$o,'--max-time','900') -PassThru -NoNewWindow
  }
  $sw = [Diagnostics.Stopwatch]::StartNew(); $procs | Wait-Process -Timeout 900; $sw.Stop()

  $tot=0; $succ=0; $maxMs=0.0; $minMs=1e9
  foreach ($o in $outs) {
    if (-not (Test-Path $o)) { continue }
    try { $j = Get-Content $o -Raw | ConvertFrom-Json
      $tot += [int]$j.timings.predicted_n
      $ms = [double]$j.timings.predicted_ms
      if ($ms -gt $maxMs) { $maxMs = $ms }
      if ($ms -lt $minMs) { $minMs = $ms }
      $succ++
    } catch {}
  }
  $agg = if ($maxMs -gt 0) { $tot / ($maxMs/1000.0) } else { 0 }
  Write-Host ("  np={0,-3} 请求={1,-3} 成功 {2,-3} 总 {3,5} token  最长 {4,5:N2}s  聚合 {5,6:N1} t/s" -f $np,$Reqs,$succ,$tot,($maxMs/1000),$agg)
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
  Start-Sleep -Seconds 3
}
