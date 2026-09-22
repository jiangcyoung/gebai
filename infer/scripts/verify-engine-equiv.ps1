# verify-engine-equiv.ps1 — 引擎等价性验证：官方 vs 自建 的输出逐字节对比
# 方法：两版各启一次 llama-server，发同一确定性请求（temp=0 + 固定 seed），比对输出指纹
param([int]$Port = 8080, [int]$Tokens = 64)

$ErrorActionPreference = 'Continue'
$env:PATH = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin;' + $env:PATH
$m = 'C:\Users\Administrator\code\gebai\resources\models\infer\Qwen-AgentWorld-35B-A3B-UD-IQ3_XXS.gguf'

$body = '{"prompt":"请用一句话说明混合专家模型的核心思想。","n_predict":' + $Tokens + ',"temperature":0,"seed":42}'
$bodyFile = "$env:TEMP\equiv.json"
[System.IO.File]::WriteAllText($bodyFile, $body, [System.Text.UTF8Encoding]::new($false))

function Run-Engine($tag, $binDir) {
  cmd /c taskkill /IM llama-server.exe /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 4
  $log = "$env:TEMP\equiv-$tag.log"
  Start-Process -FilePath "$binDir\llama-server.exe" -ArgumentList @(
    '-m',$m,'-ngl','99','-ncmoe','0','-c','8192','--port',"$Port",'-fa','on',
    '-ctk','q8_0','-ctv','q8_0','-t','14','-np','1','-bs','-a','t'
  ) -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden | Out-Null
  $ok = $false
  for ($i=0; $i -lt 45; $i++) { Start-Sleep -Seconds 2; try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ok=$true; break } } catch {} }
  if (-not $ok) { Write-Host "  [$tag] 启动失败"; return $null }
  # 预热
  & curl.exe -s -X POST "http://127.0.0.1:$Port/completion" -H 'Content-Type: application/json' --data-binary "@$bodyFile" -o "$env:TEMP\equiv-w.json" --max-time 300 2>&1 | Out-Null
  $o = "$env:TEMP\equiv-$tag.json"
  Remove-Item $o -ErrorAction SilentlyContinue
  & curl.exe -s -X POST "http://127.0.0.1:$Port/completion" -H 'Content-Type: application/json' --data-binary "@$bodyFile" -o $o --max-time 300 2>&1 | Out-Null
  $r = Get-Content $o -Raw -ErrorAction SilentlyContinue
  cmd /c taskkill /IM llama-server.exe /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 3
  if (-not $r) { Write-Host "  [$tag] 无响应"; return $null }
  try { return ($r | ConvertFrom-Json) } catch { Write-Host "  [$tag] 解析失败"; return $null }
}

Write-Host '=== 引擎等价性验证（temp=0 + seed=42，确定性生成）==='
$a = Run-Engine 'official'  'C:\Users\Administrator\code\gebai\infer\vendor\llama-b11100-win-cuda12.4'
$b = Run-Engine 'selfbuilt' 'C:\Users\Administrator\code\gebai\infer\engine\llama.cpp-b11100\build-cuda-opt\bin'

if ($a -and $b) {
  $ha = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($a.content))) -Algorithm SHA256).Hash.Substring(0,16)
  $hb = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($b.content))) -Algorithm SHA256).Hash.Substring(0,16)
  Write-Host ""
  Write-Host ("  官方   : {0,6:N1} t/s  {1} 字  指纹 {2}" -f $a.timings.predicted_per_second, $a.content.Length, $ha)
  Write-Host ("  自建   : {0,6:N1} t/s  {1} 字  指纹 {2}" -f $b.timings.predicted_per_second, $b.content.Length, $hb)
  Write-Host ""
  if ($ha -eq $hb) {
    Write-Host "  ✓ 输出逐字节一致 —— 可安全切换到自建引擎" -ForegroundColor Green
  } else {
    Write-Host "  ⚠ 输出不同，逐字对照：" -ForegroundColor Yellow
    Write-Host "    官方  : $($a.content)"
    Write-Host "    自建  : $($b.content)"
  }
}
