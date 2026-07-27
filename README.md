# Automated Network Traffic → Leaflet & OpenStreetMap Dashboard

An enterprise-grade, real-time network traffic geo-tracking system. Captures live IPv4/IPv6 traffic continuously in the background using Scapy (or replays pre-recorded PCAP files), resolves remote IP geolocation via GeoIP2 and token-bucket rate-limited HTTP APIs, streams updates over WebSockets, persists connection logs in SQLite (WAL mode), and visualizes live connections on an interactive Leaflet + OpenStreetMap dashboard — with **zero API keys, zero billing, and zero account verification required**.

---

## Features

- **Zero-Config Mapping**: Powered by **Leaflet.js + OpenStreetMap** tiles. No API key, credit card, or cloud account setup needed.
- **Live & Replay Modes**: Continuously sniffs network interfaces or replays `.pcap` files deterministically.
- **Scapy Packet Engine**: Extracts IPv4/IPv6 source/destination pairs, TCP/UDP/ICMP transport protocols, and byte throughput.
- **Decoupled Enrichment Pipeline**: Thread-safe ingestion queue (`maxsize=10000`) with bounded drop metrics.
- **Multi-Source Geolocation**: Local MaxMind `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` support, falling back to a token-bucket rate-limited `ip-api.com` API with SQLite caching.
- **Batched WebSocket Protocol**: Pushes framed JSON envelopes every 500ms (`connection_batch`, `health_status`).
- **SQLite WAL Mode**: Thread-safe persistence with indexes on `timestamp`, `dst_ip`, and `src_ip`.
- **Interactive Leaflet Dashboard**: Dynamic host pin, custom SVG remote IP markers, automatic marker clustering (`Leaflet.markercluster`), animated polylines, heatmap toggle (`Leaflet.heat`), side-panel filtering, throughput sparklines, watchlist alerts, dark/light themes, and CSV log export.

---

## Prerequisites & One-Time Setup

### 1. Packet Sniffing Driver / Capabilities

- **Windows**: Install **[Npcap](https://npcap.com/#download)**. During installation, check **"Install Npcap in WinPcap API-compatible Mode"**.
- **Linux**: Grant network raw capabilities to Python or run with `sudo`:
  ```bash
  sudo setcap cap_net_raw,cap_net_admin=eip $(readlink -f $(which python3))
  ```

### 2. MaxMind GeoLite2 Databases (Optional but Recommended)

For offline geolocation without external API requests:
1. Download `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb`.
2. Place `.mmdb` files directly in the project root directory.

---

## Quickstart Guide

### Windows (PowerShell)

```powershell
.\start.ps1
```
Open your browser at `http://127.0.0.1:8000`.

### Linux / macOS (Bash)

```bash
chmod +x start.sh
./start.sh
```
Open your browser at `http://127.0.0.1:8000`.

### Docker Compose

```bash
docker-compose up --build
```

---

## PCAP Replay Mode (Testing Without Admin / Npcap)

To test the full system without live packet sniffing or admin privileges, configure `REPLAY_PCAP_PATH`:

### 1. Persistent `.env` (Cross-Platform)
Add to `.env`:
```ini
REPLAY_PCAP_PATH=wire.pcap
```

### 2. Windows PowerShell
```powershell
# Using start.ps1 parameter:
.\start.ps1 -ReplayPcap wire.pcap

# Or setting environment variable directly:
$env:REPLAY_PCAP_PATH="wire.pcap"
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

### 3. Windows CMD
```cmd
set REPLAY_PCAP_PATH=wire.pcap
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

### 4. Linux / macOS (Bash / Zsh)
```bash
REPLAY_PCAP_PATH=wire.pcap python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

---

## Visualization Features & Scope Status

- **Pins Mode & Marker Clustering**: Individual remote IP markers with custom SVG pin styling and popups displaying IP address, location, ASN/organization, and active service. Overlapping remote markers cluster using `Leaflet.markercluster`.
- **Heatmap Toggle**: Interactive `Leaflet.heat` visualization showing spatial density of active network connections.
- **Time Scrubber Playback**: History scrubber range control filtering map markers, animated connection lines, and data tables by historical time windows.
- **Country Choropleth (Future Scope Note)**: Intentionally deprioritized in favor of point markers + heatmaps. To add a country choropleth in the future, load country boundary GeoJSON files into Leaflet (`L.geoJSON`) and bind region style fills to the `country_breakdown` metrics provided by `GET /api/stats`.

---

## Tile Usage Policy Notice

> [!NOTE]
> This application uses public OpenStreetMap tiles (`https://{s}.tile.openstreetmap.org`). For single-user local network monitoring, this tile server is completely free and unthrottled. If deploying this application to heavy production enterprise environments with hundreds of concurrent users, consider pointing the tile layer in `app.js` to a self-hosted tile server or commercial tile provider.

---

## Legal & Consent Notice

> [!CAUTION]
> Network traffic capture software must only be operated on networks, hardware, and devices that you own or where you have obtained explicit written permission to monitor traffic. Unauthorized packet sniffing on public or third-party networks may violate local legal regulations.
