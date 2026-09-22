# bench-concurrency-precise.ps1 — 精确测并发吞吐（用墙钟，且请求数=slot 数避免分波）
param(
  [string]$NpList = "8,16,24,32",
  [int]$Tokens = 200,
  [int]$Port = 8080
)

$ErrorActionPreference = 'Continue'
$env:PATH = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin;' + $env:PATH
$v = 'C:\Users\Administrator\code\gebai\infer\vendor\llama-b11100-win-cuda12.4'
$m = 'C:\Users\Administrator\code\gebai\resources\models\infer\Qwen-AgentWorld-35B-A3B-UD-IQ3_XXS.gguf'

$bodyFile = "$env:TEMP\cp-body.json"
[System.IO.File]::WriteAllText($bodyFile,
  '{"prompt":"请简述混合专家模型的稀疏激活原理。","n_predict":' + $Tokens + ',"temperature":0}',
  [System.Text.UTF8Encoding]::new($false))

function One-Call($out) {
  Remove-Item $out -ErrorAction SilentlyContinue
  & curl.exe -s -X POST "http://127.0.0.1:$Port/completion" -H 'Content-Type: application/json' --data-binary "@$bodyFile" -o $out --max-time 900 2>&1 | Out-Null
}

Write-Host "  配置          并发=slot  总token  墙钟(s)  聚合(t/s)  单请求(t/s)  相对单流"
Write-Host "  " + ("-" * 76)

foreach ($np in ($NpList -split ',' | ForEach-Object { [int]$_.Trim() })) {
  cmd /c taskkill /IM llama-server.exe /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  $log = "$env:TEMP\cp-$np.log"
  # ctx 固定 32768，np 决定每 slot 大小
  $p = Start-Process -FilePath "$v\llama-server.exe" -ArgumentList @(
    '-m',$m,'-ngl','99','-ncmoe','0','-c','32768','--port',"$Port",'-fa','on',
    '-ctk','q8_0','-ctv','q8_0','-t','14','-np',"$np",'-b','4096','-ub','1024','--cont-batching','-bs'
  ) -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
  $ok = $false
  for ($i=0; $i -lt 50; $i++) { Start-Sleep -Seconds 2; try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ok=$true; break } } catch {}; if ($p.HasExited) { break } }
  if (-not $ok) { Write-Host "  np=$np 启动失败"; continue }

  One-Call "$env:TEMP\cp-w.json"     # 预热

  # 请求数 = slot 数，一波处理完，墙钟即真实聚合时间
  $outs = @(); $procs = @()
  for ($k=1; $k -le $np; $k++) {
    $o = "$env:TEMP\cp-r-$np-$k.json"; $outs += $o
  }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  for ($k=0; $k -lt $np; $k++) {
    $procs += Start-Process -FilePath 'curl.exe' -ArgumentList @('-s','-X','POST',"http://127.0.0.1:$Port/completion",'-H','Content-Type: application/json','--data-binary',"@$bodyFile",'-o',$outs[$k],'--max-time','900') -PassThru -NoNewWindow
  }
  $procs | Wait-Process -Timeout 900
  $sw.Stop()
  $wall = $sw.Elapsed.TotalSeconds

  $tot=0; $succ=0
  foreach ($o in $outs) {
    if (-not (Test-Path $o)) { continue }
    try { $j = Get-Content $o -Raw | ConvertFrom-Json; $tot += [int]$j.timings.predicted_n; $succ++ } catch {}
  }
  $agg = $tot / $wall
  $perReq = $tot / $succ / $wall      # 单请求视角（每请求独立墙钟相同）
  Write-Host ("  np={0,-3}        {1,-3}      {2,5}   {3,6:N2}   {4,7:N1}   {5,8:N1}   {6,6:N2}x" -f $np,$succ,$tot,$wall,$agg,$perReq,($agg/140.0))
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
  Start-Sleep -Seconds 3
}
Write-Host ""
Write-Host "  参考：单流 140 t/s ｜ batched-bench B=8 统一批处理 391 t/s（4.1x）"
