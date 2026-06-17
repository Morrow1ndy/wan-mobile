# Wan Mobile - run script (Windows / PowerShell)
# First run creates a venv and installs deps; later runs just start the server.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    py -m venv .venv
    & .\.venv\Scripts\python.exe -m pip install --upgrade pip
    & .\.venv\Scripts\python.exe -m pip install -r requirements.txt
}

if (-not (Test-Path ".env")) {
    Write-Host "No .env found - copy .env.example to .env and fill it in first." -ForegroundColor Yellow
    exit 1
}

Write-Host "Starting Wan Mobile on http://0.0.0.0:8000" -ForegroundColor Green
Write-Host "On your phone (Tailscale up on both): http://<your-pc-tailscale-name>:8000" -ForegroundColor Green
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
