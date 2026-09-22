# conc-test2.ps1 — 服务端并发吞吐测试（修正版：预热 + 服务端内部计时）
# 教训：首请求含 CUDA graph 捕获（本模型约 10s），用墙钟会把捕获算进吞吐，
#       得到「恒定 ~13s / 与 token 数无关」的假数据。必须先预热，再取 timings。
param([string]$Slots = '1,2,4,8', [int]$NPredict = 200, [int]$Port = 8080)

$ErrorActionPreference = 'Continue'
$v = 'C:\Users\Administrator\code\gebai\infer\vendor\llama-b11100-win-cuda12.4'
$m = 'C:\Users\Administrator\code\gebai\resources\models\infer\Qwen-AgentWorld-35B-A3B-UD-IQ3_XXS.gguf'
$body = '{"prompt":"请简述混合专家模型的特点。","n_predict":' + $NPredict + ',"temperature":0}'
$bodyFile = "$env:TEMP\ct-body.json"
[System.IO.File]::WriteAllText($bodyFile, $body, [System.Text.UTF8Encoding]::new($false))

function Call-One($tag) {
  $o = "$env:TEMP\ct-out-$tag.json"
  Remove-Item $o -ErrorAction SilentlyContinue
  & curl.exe -s -X POST "http://127.0.0.1:$Port/completion" -H 'Content-Type: application/json' --data-binary "@$bodyFile" -o $o --max-time 600 2>&1 | Out-Null
  $r = Get-Content $o -Raw -ErrorAction SilentlyContinue
  if (-not $r) { return $null }
  try { return ($r | ConvertFrom-Json) } catch { return $null }
}

foreach ($np in ($Slots -split ',' | ForEach-Object { [int]$_.Trim() })) {
  cmd /c taskkill /IM llama-server.exe /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  $log = "$env:TEMP\ct-$np.log"
  $p = Start-Process -FilePath "$v\llama-server.exe" -ArgumentList @(
    '-m',$m,'-ngl','99','-ncmoe','0','-c','32768','--port',"$Port",'-fa','on',
    '-ctk','q8_0','-ctv','q8_0','-t','14','-np',"$np",'-b','2048','-ub','512','--cont-batching'
  ) -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
  $ok = $false
  for ($i=0; $i -lt 45; $i++) { Start-Sleep -Seconds 2; try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ok=$true; break } } catch {}; if ($p.HasExited) { break } }
  if (-not $ok) { Write-Host "  np=$np 启动失败"; continue }

  # ★ 关键：预热一次，付掉 CUDA graph 捕获成本（不计入测量）
  Write-Host "  np=$np 预热中..." -NoNewline
  $warm = Call-One "warm-$np"
  if (-not $warm) { Write-Host " 预热失败"; if(-not $p.HasExited){Stop-Process -Id $p.Id -Force}; continue }
  Write-Host (" 预热完成（首请求已捕获图，耗时 {0:N1}s）" -f ($warm.timings.predicted_ms/1000))

  # 正式测量：np 路并发，各 NPredict token，取服务端内部计时
  $procs = @(); $outs = @()
  for ($k=1; $k -le $np; $k++) {
    $o = "$env:TEMP\ct-m-$np-$k.json"; Remove-Item $o -ErrorAction SilentlyContinue
    $outs += $o
    $procs += Start-Process -FilePath 'curl.exe' -ArgumentList @('-s','-X','POST',"http://127.0.0.1:$Port/completion",'-H','Content-Type: application/json','--data-binary',"@$bodyFile",'-o',$o,'--max-time','600') -PassThru -NoNewWindow
  }
  $sw = [Diagnostics.Stopwatch]::StartNew(); $procs | Wait-Process -Timeout 600; $sw.Stop()

  $tot = 0; $succ = 0; $maxMs = 0.0
  foreach ($o in $outs) {
    if (-not (Test-Path $o)) { continue }
    try { $j = Get-Content $o -Raw | ConvertFrom-Json
      $tot += [int]$j.timings.predicted_n
      $ms = [double]$j.timings.predicted_ms
      if ($ms -gt $maxMs) { $maxMs = $ms }
      $succ++
    } catch {}
  }
  # 聚合吞吐 = 总 token / 最慢那路的生成耗时（服务端内部计时，剔除 HTTP/捕获开销）
  $agg = if ($maxMs -gt 0) { $tot / ($maxMs/1000.0) } else { 0 }
  Write-Host ("  np={0,-3} 成功 {1}/{2}  总 {3} token  内部最长 {4:N2}s  → 聚合 {5,7:N1} t/s   墙钟 {6:N1}s" -f $np,$succ,$np,$tot,($maxMs/1000),$agg,$sw.Elapsed.TotalSeconds)
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
  Start-Sleep -Seconds 3
}
