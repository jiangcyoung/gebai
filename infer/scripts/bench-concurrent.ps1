# conc-test.ps1 — 并发吞吐测试（临时）
param([int]$Slots = 4, [int]$Ctx = 32768, [int]$Port = 8088, [int]$NPredict = 200)

$ErrorActionPreference = 'Continue'
$env:PATH = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin;' + $env:PATH
$v = 'C:\Users\Administrator\code\gebai\infer\vendor\llama-b11100-win-cuda12.4'
$m = 'C:\Users\Administrator\code\gebai\resources\models\infer\Qwen-AgentWorld-35B-A3B-UD-IQ3_XXS.gguf'
$log = "$env:TEMP\conc-$Slots.log"

Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$p = Start-Process -FilePath "$v\llama-server.exe" -ArgumentList @(
    '-m',$m,'-ngl','99','-ncmoe','0','-c',"$Ctx",'--port',"$Port",'-fa','on',
    '-ctk','q8_0','-ctv','q8_0','-t','14','-np',"$Slots",'-b','4096','-ub','1024'
) -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden

$ok = $false
for ($i=0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { $ok=$true; break } } catch {}
    if ($p.HasExited) { break }
}
$vram = (& nvidia-smi --query-gpu=memory.used --format=csv,noheader) -join ''
Write-Host "服务就绪=$ok (约 $($i*2)s, ctx=$Ctx, np=$Slots)  显存 $vram"
if (-not $ok) { Get-Content "$log.err" -Tail 6; exit 1 }

$bodyObj = @{
    prompt      = '请用大约200字介绍稀疏激活模型相比稠密模型的优势。'
    n_predict   = $NPredict
    temperature = 0
}
$bodyFile = "$env:TEMP\conc-body.json"
[System.IO.File]::WriteAllText($bodyFile, ($bodyObj | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))

$outFiles = 1..$Slots | ForEach-Object { "$env:TEMP\conc-out-$_.json" }
foreach ($f in $outFiles) { if (Test-Path $f) { Remove-Item $f -Force } }

$procs = @()
for ($k = 0; $k -lt $Slots; $k++) {
    $procs += Start-Process -FilePath 'curl.exe' -ArgumentList @(
        '-s','-X','POST',"http://127.0.0.1:$Port/completion",
        '-H','Content-Type: application/json','--data-binary',"@$bodyFile",'--max-time','300'
    ) -RedirectStandardOutput $outFiles[$k] -PassThru -NoNewWindow
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$procs | Wait-Process -Timeout 300
$sw.Stop()

$tot = 0; $succ = 0; $tgSum = 0.0
foreach ($f in $outFiles) {
    if (-not (Test-Path $f)) { continue }
    try {
        $j = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json
        $tot += [int]$j.timings.predicted_n
        $tgSum += [double]$j.timings.predicted_per_second
        $succ++
    } catch { }
}
Write-Host ("成功 {0}/{1}   总生成 {2} token   墙钟 {3:N1}s" -f $succ, $Slots, $tot, $sw.Elapsed.TotalSeconds)
if ($succ -gt 0 -and $sw.Elapsed.TotalSeconds -gt 0) {
    Write-Host ("聚合吞吐 = {0:N1} t/s       单请求均值 = {1:N1} t/s" -f ($tot/$sw.Elapsed.TotalSeconds), ($tgSum/$succ))
}
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
