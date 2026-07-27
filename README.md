# NetTrace Live

> A real-time network traffic capture, geolocation, and visualization platform built with Python, FastAPI, WebSockets, Scapy, and Leaflet OpenStreetMap.

![Python](https://img.shields.io/badge/Python-3.9+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)
![Leaflet](https://img.shields.io/badge/Leaflet-1.9.4-199900?style=for-the-badge&logo=leaflet&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)

---

## 🌐 Overview

**NetTrace Live** is a web-based network traffic analysis tool designed to capture network packets, extract transport and network layer metadata, geolocate remote endpoints, and render real-time connection telemetry on an interactive map.

When analyzing network activity using traditional command-line utilities like `tcpdump` or packet analyzers like Wireshark, understanding the geographic distribution and spatial flow of network connections can be difficult. NetTrace Live bridges this gap by combining low-level packet processing with geospatial mapping and real-time data streaming over WebSockets.

### Why NetTrace Live Was Built
- **Spatial Awareness**: Translates raw remote IP addresses into geographical coordinates on an interactive world map.
- **Educational Value**: Demonstrates core concepts in TCP/IP packet parsing, socket programming, multi-threaded packet enrichment, and asynchronous event broadcasting.
- **Network Troubleshooting**: Assists system administrators and developers in identifying unauthorized outbound connections, active remote endpoints, and protocol distribution across local interfaces.

---

## ⚡ Key Features

- **Live Packet Capture & Replay**: Captures incoming and outgoing network packets across local interfaces using Scapy or replays pre-captured `.pcap` files.
- **Geographic Endpoint Mapping**: Geolocates public IPv4/IPv6 addresses using local MaxMind GeoLite2 databases (`GeoLite2-City.mmdb`, `GeoLite2-ASN.mmdb`) with fallback to rate-limited REST APIs.
- **Interactive OpenStreetMap Dashboard**: Visualizes connections using Leaflet.js with marker clustering (`Leaflet.markercluster`), connection heatmaps, and dynamic arc lines between local and remote endpoints.
- **Real-Time Data Streaming**: Uses FastAPI WebSockets with an asynchronous batching broadcaster to stream connection telemetry to the browser at low latency.
- **High-Performance Persistence**: Utilizes SQLite in Write-Ahead Logging (WAL) mode with connection indexing for fast upserts and historical tracking.
- **Protocol Inspection & Statistics**: Monitors IPv4, IPv6, TCP, UDP, ICMP, DNS, HTTP, HTTPS, SSH, FTP, SMTP, and custom port services.
- **CSV Data Export**: Enables exporting active connection records, packet counts, byte volumes, and geolocation metrics for external reporting.
- **Configurable Capture Controls**: Supports automated duration limiters (30s, 1m, 5m, 15m), manual pause/resume, and interface selection.

---

## 🛠️ Tech Stack

### Backend
| Component | Technology | Description |
| :--- | :--- | :--- |
| Core Language | **Python 3.9+** | High-level backend implementation |
| Web Framework | **FastAPI** | REST API endpoints & WebSocket event delivery |
| ASGI Server | **Uvicorn** | High-performance asynchronous server |
| Database | **SQLite3 (WAL Mode)** | Persistent storage for traffic metrics and IP caches |
| Async / Task Queue | **Python `asyncio` & `queue`** | Concurrent packet processing and batching |

### Networking & Data Enrichment
| Component | Technology | Description |
| :--- | :--- | :--- |
| Packet Inspection | **Scapy** | Packet sniffing, protocol header decoding, PCAP reading |
| IP Geolocation | **MaxMind GeoIP2 / GeoLite2** | Local offline IP-to-city and ASN resolution |
| Fallback Geolocation | **`ip-api.com` REST API** | Token-bucket rate-limited HTTP fallback |
| Reverse DNS | **Python `socket.getnameinfo`** | Domain name resolution with local caching |

### Frontend & Visualization
| Component | Technology | Description |
| :--- | :--- | :--- |
| Markup & Styling | **HTML5 / Vanilla CSS3** | Glassmorphism UI, custom CSS variables, dark mode theme |
| Dynamic Logic | **JavaScript (ES6+)** | Native WebSockets, async fetch, state management |
| Mapping Engine | **Leaflet.js (v1.9.4)** | OpenStreetMap canvas rendering |
| Plugins | **Leaflet MarkerCluster & Heatmap** | Dynamic pin clustering and density heatmaps |

---

## 🏗️ System Architecture

```
┌────────────────────────────────────────────────────────┐
│             Network Interface / PCAP File              │
└──────────────────────────┬─────────────────────────────┘
                           │ Raw Packets
                           ▼
┌────────────────────────────────────────────────────────┐
│           Scapy Packet Capture Engine                  │
│       (Header Parsing: IP, IPv6, TCP, UDP, ICMP)       │
└──────────────────────────┬─────────────────────────────┘
                           │ Packet Tuples
                           ▼
┌────────────────────────────────────────────────────────┐
│           Thread-Safe In-Memory Queue                  │
└──────────────────────────┬─────────────────────────────┘
                           │ Worker Dequeue
                           ▼
┌────────────────────────────────────────────────────────┐
│            Enrichment Worker Threads                   │
│   (GeoIP Resolution, ASN Lookup, Service Mapping)      │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
               ▼                          ▼
┌──────────────────────────────┐ ┌──────────────────────┐
│       SQLite Database        │ │ WebSocket Broadcaster│
│  (WAL Mode / Connections)    │ │   (Batch Flusher)    │
└──────────────────────────────┘ └──────────┬───────────┘
                                            │ JSON Batches
                                            ▼
                                 ┌──────────────────────┐
                                 │ Leaflet Dashboard UI │
                                 └──────────────────────┘
```

### Data Processing Pipeline

1. **Packet Capture Stage**: The `CaptureEngine` sniffs network interfaces or streams frames from a `.pcap` file using Scapy. Packet headers are parsed to extract IP addresses, ports, protocol types, payload size, and timestamps.
2. **Queueing Stage**: Parsed packet metadata is placed into a thread-safe `queue.Queue` with a configurable upper limit to prevent memory overflow during high traffic volume.
3. **Enrichment Worker Stage**: Background worker threads dequeue items, filter out internal loopback/private IPs, resolve public IP geolocation via `GeoLite2-City.mmdb` or `ip-api.com`, and determine destination service names (e.g., HTTPS on port 443).
4. **Persistence & Caching**: Resolved connection metrics (packet count, byte count, lat/lng, country, city, ASN) are upserted into `traffic.db` (`PRAGMA journal_mode=WAL`).
5. **WebSocket Broadcast Stage**: The `Broadcaster` collects enriched events, batches them at configurable intervals (`BATCH_INTERVAL_MS`), and pushes JSON packets to all connected browser clients.

---

## 📂 Project Structure

```
NetTrace-Live/
├── backend/
│   ├── __init__.py
│   ├── broadcaster.py      # Async WebSocket client manager & batch flusher
│   ├── capture.py          # Scapy packet sniffer engine & PCAP reader
│   ├── config.py           # Environment variables & settings loader
│   ├── db.py               # SQLite WAL database management & connection indexes
│   ├── enrichment.py       # Multi-threaded worker queue & IP enrichment logic
│   ├── geolocate.py        # MaxMind GeoIP2 reader & REST API rate limiter
│   ├── main.py             # FastAPI server routes, static file serving, app lifespan
│   └── requirements.txt    # Backend Python package dependencies
├── frontend/
│   ├── app.js              # Leaflet map setup, WebSocket receiver, chart updates
│   ├── index.html          # Main HTML structure & dashboard layout
│   └── styles.css          # Dark-mode design system & visual styles
├── .env.example            # Environment variable template
├── .gitignore              # Git file exclusion rules
├── docker-compose.yml      # Docker multi-container deployment manifest
├── Dockerfile              # Docker build file for backend container
├── README.md               # Project documentation
├── start.ps1               # Automated startup script for Windows PowerShell
├── start.sh                # Automated startup script for Linux / macOS
└── traffic.db              # SQLite persistent traffic database
```

---

## 💻 Installation

### Prerequisites

- **Python 3.9+** installed on your system.
- **Git** installed.
- *(Optional - Windows Users)*: **[Npcap](https://npcap.com/)** installed if performing live interface sniffing via Scapy.

### Step-by-Step Setup

1. **Clone the Repository**
   ```bash
   git clone https://github.com/ganipisettylohith/NetTrace-Live.git
   cd NetTrace-Live
   ```

2. **Create a Virtual Environment**
   - **Linux / macOS:**
     ```bash
     python3 -m venv venv
     source venv/bin/activate
     ```
   - **Windows:**
     ```cmd
     python -m venv venv
     .\venv\Scripts\activate
     ```

3. **Install Dependencies**
   ```bash
   pip install --upgrade pip
   pip install -r backend/requirements.txt
   ```

4. **Environment Configuration (Optional)**
   Copy the example environment configuration:
   ```bash
   cp .env.example .env
   ```
   *You can customize `PORT`, `BATCH_INTERVAL_MS`, `LOCAL_LAT`, `LOCAL_LNG`, and MaxMind database paths in `.env`.*

5. **Start the Application**
   - **Using Automated PowerShell Script (Windows):**
     ```powershell
     Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass; .\start.ps1
     ```
   - **Using Automated Shell Script (Linux / macOS):**
     ```bash
     chmod +x start.sh
     ./start.sh
     ```
   - **Using Direct Uvicorn Command:**
     ```bash
     python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
     ```

6. **Open the Dashboard**
   Open your browser and navigate to:
   ```text
   http://127.0.0.1:8000
   ```

---

## 📊 Dashboard & Screenshots

### 1. Main Dashboard Overview
![Home Dashboard](screenshots/dashboard.png)
*The central dashboard interface featuring real-time connection counters, active bandwidth indicators, network protocol breakdowns, and Leaflet OpenStreetMap connection lines.*

---

### 2. Live Packet Capture & Geolocation Mapping
![Live Packet Capture](screenshots/capture_map.png)
*Active packet stream view rendering geographical markers for remote servers across the globe, with marker clustering for dense geographical regions.*

---

### 3. Traffic Analytics & Protocol Distribution
![Traffic Analytics](screenshots/analytics.png)
*Detailed packet count, byte volume metrics, and protocol usage distribution (TCP, UDP, ICMP, DNS, HTTP, HTTPS).*

---

### 4. Connection Details & Protocol Inspection
![Protocol Analysis](screenshots/connection_details.png)
*Tabular display of active network connections showing source/destination IP pairs, resolved hostnames, ASNs, geographic locations, and duration metadata.*

---

## 🔄 Networking Workflow

```
[ Local Interface Packet ]
          │
          ▼
[ Scapy Link-Layer Sniffer ]
          │ Extract Header (IP / IPv6)
          ▼
[ Transport Header Extraction ] ──► Protocol: TCP / UDP / ICMP
          │                        Ports: e.g. 443 (HTTPS), 53 (DNS)
          ▼
[ Geolocation & ASN Resolution ]
          ├─► 1. Check SQLite IP Cache
          ├─► 2. Check GeoLite2 MMDB Files
          └─► 3. Fallback to ip-api.com (Rate limited)
          │
          ▼
[ Database Synchronization ] ──► Upsert to SQLite (WAL Mode)
          │
          ▼
[ WebSocket Broadcast Engine ] ──► JSON Batch Event Delivery (500ms Window)
          │
          ▼
[ Browser DOM & Canvas Map ] ──► Leaflet Polyline Draw + Marker Clustering
```

---

## 🎓 Key Learnings & Engineering Concepts

- **Asynchronous IO & Threading**: Integrating multi-threaded Python packet processing with FastAPI's asynchronous `asyncio` event loop.
- **High-Frequency Database Writes**: Leveraging SQLite's Write-Ahead Logging (`PRAGMA journal_mode=WAL`) and composite indexing to handle high-frequency IP log upserts without blocking read operations.
- **Rate-Limiting Algorithms**: Implementing token-bucket rate limiters for external REST API lookups to comply with provider request quotas.
- **Spatial Clustering**: Managing dynamic UI performance when rendering hundreds of active network endpoints on a vector map using marker clustering algorithms.
- **WebSocket Protocol**: Structuring batch transmission envelopes over WebSockets to reduce browser DOM re-render overhead.

---

## 🚀 Future Roadmap

- [ ] **PCAP Export**: Ability to export captured packet sessions directly as `.pcap` files for offline Wireshark analysis.
- [ ] **Custom BPF Filters**: UI controls to filter capture streams by Berkley Packet Filter syntax (e.g. `tcp port 80 or udp port 53`).
- [ ] **Deep Packet Inspection (DPI)**: Inspection of HTTP header metadata and TLS Server Name Indication (SNI) hostnames.
- [ ] **Alerting Engine**: Configurable thresholds for bandwidth spikes or connection attempts to blacklisted IP ranges.
- [ ] **Docker Compose Support**: Pre-configured multi-container stack with NGINX reverse proxy.

---

## 🤝 Contributing

Contributions are welcome! To contribute to NetTrace Live:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/AmazingFeature`).
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4. Push to the branch (`git push origin feature/AmazingFeature`).
5. Open a Pull Request.

---

## 📜 License

Distributed under the **MIT License**. See `LICENSE` for more information.

---

## 📬 Contact & Links

- **GitHub Repository**: [ganipisettylohith/NetTrace-Live](https://github.com/ganipisettylohith/NetTrace-Live)
- **LinkedIn**: [Lohith Ganipisetty](https://www.linkedin.com/)
- **Email**: [lohith.ganipisetty@example.com](mailto:lohith.ganipisetty@example.com)
