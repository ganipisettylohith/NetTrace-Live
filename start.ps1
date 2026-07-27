param (
    [string]$ReplayPcap = ""
)

# Start script for Windows PowerShell
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host " Automated Network Traffic -> OpenStreetMap Dashboard " -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan

if ($ReplayPcap -ne "") {
    $env:REPLAY_PCAP_PATH = $ReplayPcap
    Write-Host "[+] Setting REPLAY_PCAP_PATH=$ReplayPcap" -ForegroundColor Yellow
}

# Create virtual environment if missing
if (-not (Test-Path "venv")) {
    Write-Host "[+] Creating Python virtual environment..." -ForegroundColor Yellow
    python -m venv venv
}

# Activate virtual environment
if (Test-Path ".\venv\Scripts\Activate.ps1") {
    Write-Host "[+] Activating virtual environment..." -ForegroundColor Yellow
    .\venv\Scripts\Activate.ps1
}

# Install requirements
Write-Host "[+] Installing/verifying dependencies..." -ForegroundColor Yellow
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt

# Copy .env.example to .env if .env doesn't exist
if (-not (Test-Path ".env")) {
    Write-Host "[+] Copying .env.example to .env..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
}

if ($env:REPLAY_PCAP_PATH -and (Test-Path $env:REPLAY_PCAP_PATH)) {
    Write-Host "[+] Replay PCAP Mode active: $env:REPLAY_PCAP_PATH" -ForegroundColor Green
}

Write-Host "`n[!] Starting FastAPI Uvicorn Server on http://127.0.0.1:8000" -ForegroundColor Green
Write-Host "[!] Open your browser at http://127.0.0.1:8000`n" -ForegroundColor Green

python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
