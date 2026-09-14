param([switch]$Install)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($Install -or -not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    python -m venv .venv
    & ./.venv/Scripts/python.exe -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed' }
}
if ($Install -or -not (Test-Path -LiteralPath 'node_modules')) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Web dependency installation failed' }
}
$pythonPath = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
$backend = Start-Process -FilePath $pythonPath -ArgumentList '-m','uvicorn','server.app:app','--host','127.0.0.1','--port','8000' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
try {
    Start-Sleep -Seconds 1
    if ($backend.HasExited) { throw 'API did not start. Port 8000 may already be in use.' }
    Write-Host 'Orbit Desk: http://127.0.0.1:5173   API: http://127.0.0.1:8000/docs'
    npm run dev
} finally {
    if (-not $backend.HasExited) { Stop-Process -Id $backend.Id }
}
