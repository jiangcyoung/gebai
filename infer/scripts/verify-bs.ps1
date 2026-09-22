# verify-bs.ps1 — 验证 -bs（后端采样）的收益与正确性
# 判据：temperature=0 下输出必须与默认完全一致（否则不能进推荐档位），且吞吐应提升
param([int]$Port = 8080, [int]$Tokens = 300)

$ErrorActionPreference = 'Continue'
$env:PATH = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin;' + $env:PATH
$v = 'C:\Users\Administrator\code\gebai\infer\vendor\llama-b11100-win-cuda12.4'
$m = 'C:\Users\Administrator\code\gebai\resources\models\infer\Qwen-AgentWorld-35B-A3B-UD-IQ3_XXS.gguf'
$body = '{"prompt":"请简要说明混合专家模型中路由器的负载均衡为何重要。","n_predict":' + $Tokens + ',"temperature":0,"seed":42}'
$bodyFile = "$env:TEMP\bs-body.json"
[System.IO.File]::WriteAllText($bodyFile, $body, [System.Text.UTF8Encoding]::new($false))

function RunCase($tag, $extra) {
  cmd /c taskkill /IM llama-server.exe /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  $log = "$env:TEMP\bsv-$tag.log"
  $args = @('-m',$m,'-ngl','99','-ncmoe','0','-c','8192','--port',"$Port",'-fa','on','-ctk','q8_0','-ctv','q8_0','-t','14','-np','1','--jinja') + $extra
  $p = Start-Process -FilePath "$v\llama-server.exe" -ArgumentList $args -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
  $ok = $false
  for ($i=0; $i -lt 45; $i++) { Start-Sleep -Seconds 2; try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ok=$true; break } } catch {}; if ($p.HasExited) { break } }
  if (-not $ok) { Write-Host "  [$tag] 启动失败"; if(-not $p.HasExited){Stop-Process -Id $p.Id -Force}; return $null }

  # 预热（付掉 CUDA graph 捕获）
  $null = & curl.exe -s -X POST "http://127.0.0.1:$Port/completion" -H 'Content-Type: application/json' --data-binary "@$bodyFile" -o "$env:TEMP\bsv-w.json" --max-time 600

  $out = "$env:TEMP\bsv-$tag.json"
  Remove-Item $out -ErrorAction SilentlyContinue
  & curl.exe -s -X POST "http://127.0.0.1:$Port/completion" -H 'Content-Type: application/json' --data-binary "@$bodyFile" -o $out --max-time 600 2>&1 | Out-Null
  $r = Get-Content $out -Raw -ErrorAction SilentlyContinue
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
  if (-not $r) { Write-Host "  [$tag] 无响应"; return $null }
  try { return ($r | ConvertFrom-Json) } catch { Write-Host "  [$tag] 解析失败"; return $null }
}

Write-Host '=== -bs 后端采样：性能与正确性 ==='
$a = RunCase 'off' @()
$b = RunCase 'on'  @('-bs')
if ($a -and $b) {
  $ta = [double]$a.timings.predicted_per_second
  $tb = [double]$b.timings.predicted_per_second
  $sha = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($a.content))) -Algorithm SHA256).Hash.Substring(0,16)
  $shb = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($b.content))) -Algorithm SHA256).Hash.Substring(0,16)
  Write-Host ""
  Write-Host ("  默认   : {0,7:N1} t/s   正文 {1} 字   指纹 {2}" -f $ta, $a.content.Length, $sha)
  Write-Host ("  -bs    : {0,7:N1} t/s   正文 {1} 字   指纹 {2}" -f $tb, $b.content.Length, $shb)
  Write-Host ("  提升   : {0:N1}%" -f (($tb/$ta - 1) * 100))
  Write-Host ("  正确性 : {0}" -f $(if ($sha -eq $shb) { '输出逐字节一致 ✓（可安全启用）' } else { '输出不一致 ✗（不可启用）' }))
}
