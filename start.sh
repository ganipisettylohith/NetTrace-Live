#!/bin/bash
set -e

echo "======================================================="
echo " Automated Network Traffic -> OpenStreetMap Dashboard "
echo "======================================================="

if [ ! -d "venv" ]; then
    echo "[+] Creating Python virtual environment..."
    python3 -m venv venv
fi

echo "[+] Activating virtual environment..."
source venv/bin/activate

echo "[+] Installing dependencies..."
pip install --upgrade pip
pip install -r backend/requirements.txt

if [ ! -f ".env" ]; then
    echo "[+] Copying .env.example to .env..."
    cp .env.example .env
fi

echo ""
echo "[!] Starting FastAPI Uvicorn Server on http://127.0.0.1:8000"
echo "[!] Open your browser at http://127.0.0.1:8000"
echo ""

python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
