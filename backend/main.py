import logging
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException, Depends, Header, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import settings, BASE_DIR
from backend.db import init_db, get_recent_connections, get_stats, export_connections, prune_old_connections
from backend.geolocate import init_geoip, close_geoip, HAS_GEOIP2, get_local_location, get_geoip_status, geolocate_ip
from backend.capture import capture_engine, dropped_packets_count, get_available_interfaces
from backend.enrichment import enrichment_worker
from backend.broadcaster import broadcaster

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format='{"time": "%(asctime)s", "level": "%(levelname)s", "module": "%(name)s", "message": "%(message)s"}'
)
import asyncio
import collections
import time

logger = logging.getLogger(__name__)

async def _retention_loop():
    while True:
        await asyncio.sleep(3600)  # every hour
        try:
            prune_old_connections(settings.RETENTION_HOURS)
            logger.info(f"Pruned connections older than {settings.RETENTION_HOURS}h")
        except Exception as e:
            logger.error(f"Retention prune failed: {e}")

class TokenBucketRateLimiter:
    def __init__(self, rate: float, capacity: float):
        self.rate = rate  # tokens per second
        self.capacity = capacity
        self.buckets = collections.defaultdict(lambda: capacity)
        self.last_check = collections.defaultdict(time.time)

    def consume(self, client_ip: str, tokens: int = 1) -> bool:
        now = time.time()
        elapsed = now - self.last_check[client_ip]
        self.last_check[client_ip] = now
        
        current_tokens = self.buckets[client_ip]
        current_tokens = min(self.capacity, current_tokens + elapsed * self.rate)
        
        if current_tokens >= tokens:
            self.buckets[client_ip] = current_tokens - tokens
            return True
        else:
            self.buckets[client_ip] = current_tokens
            return False

nominatim_limiter = TokenBucketRateLimiter(rate=0.5, capacity=3)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup initialization
    logger.info("Initializing SQLite database...")
    init_db()

    logger.info("Initializing GeoIP databases...")
    init_geoip()

    logger.info("Starting enrichment worker threads...")
    enrichment_worker.start()

    logger.info("Starting WebSocket broadcaster...")
    await broadcaster.start()

    logger.info("Starting background retention pruner task...")
    retention_task = asyncio.create_task(_retention_loop())

    logger.info("Packet capture engine initialized (idle/stopped)")

    yield

    # Shutdown cleanup
    logger.info("Shutting down backend service...")
    retention_task.cancel()
    try:
        await retention_task
    except asyncio.CancelledError:
        pass
    capture_engine.stop()
    enrichment_worker.stop()
    await broadcaster.stop()
    close_geoip()

app = FastAPI(
    title="Automated Network Traffic Geo-Tracker",
    version="2.0.0",
    lifespan=lifespan
)

# Configure CORS (Require explicit origins, reject wildcard)
if not settings.CORS_ORIGINS:
    raise ValueError("CORS_ORIGINS must be explicitly defined. Wildcard '*' is not allowed when credentials are enabled.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def verify_token(x_token: str = Header(None), token: str = Query(None)):
    if settings.API_TOKEN:
        auth_token = x_token or token
        if auth_token != settings.API_TOKEN:
            raise HTTPException(status_code=401, detail="Invalid API Token")
    elif not settings.DEV_MODE:
        raise HTTPException(status_code=401, detail="API Token required but not configured.")

@app.get("/api/config")
def get_config():
    local_lat, local_lng, local_ip = get_local_location()
    return {
        "local_lat": local_lat,
        "local_lng": local_lng,
        "local_ip": local_ip,
        "batch_interval_ms": settings.BATCH_INTERVAL_MS,
        "is_pcap_replay": bool(settings.REPLAY_PCAP_PATH)
    }

@app.get("/api/whoami")
def get_whoami(request: Request):
    x_forwarded_for = request.headers.get("x-forwarded-for")
    if x_forwarded_for:
        client_ip = x_forwarded_for.split(",")[0].strip()
    else:
        client_ip = request.client.host if request.client else "127.0.0.1"

    local_lat, local_lng, local_pub_ip = get_local_location()

    if client_ip in ["127.0.0.1", "::1", "localhost"] or client_ip.startswith("192.168.") or client_ip.startswith("10.") or client_ip.startswith("172."):
        target_ip = local_pub_ip or client_ip
    else:
        target_ip = client_ip

    geo_info = geolocate_ip(target_ip) or {}
    lat = geo_info.get("lat") or local_lat
    lng = geo_info.get("lng") or local_lng
    city = geo_info.get("city", "")
    region = geo_info.get("region", "")
    country = geo_info.get("country", "")

    loc_parts = [p for p in [city, region, country] if p and p != "Unknown"]
    formatted_loc = ", ".join(loc_parts) if loc_parts else "Detected Location"

    return {
        "ip": target_ip,
        "lat": lat,
        "lng": lng,
        "city": city,
        "region": region,
        "country": country,
        "formatted_location": formatted_loc
    }

import requests

@app.get("/api/reverse-geocode")
def reverse_geocode(request: Request, lat: float = Query(...), lng: float = Query(...)):
    # Rate limit based on client IP
    x_forwarded_for = request.headers.get("x-forwarded-for")
    if x_forwarded_for:
        client_ip = x_forwarded_for.split(",")[0].strip()
    else:
        client_ip = request.client.host if request.client else "127.0.0.1"

    if not nominatim_limiter.consume(client_ip):
        raise HTTPException(status_code=429, detail="Too many reverse geocoding requests. Please wait.")

    try:
        url = f"https://nominatim.openstreetmap.org/reverse?format=json&lat={lat}&lon={lng}&zoom=18"
        headers = {"User-Agent": "GeoTrafficLiveDashboard/1.0 (network-monitoring-app)"}
        resp = requests.get(url, headers=headers, timeout=4.0)
        if resp.status_code == 200:
            data = resp.json()
            addr = data.get("address", {})
            road = addr.get("road") or addr.get("street") or addr.get("pedestrian") or addr.get("footway") or ""
            suburb = addr.get("suburb") or addr.get("neighbourhood") or addr.get("residential") or addr.get("quarter") or addr.get("subdivision") or ""
            city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("city_district") or addr.get("county") or ""
            state = addr.get("state") or addr.get("region") or ""
            country = addr.get("country") or ""
            
            parts = [p for p in [road, suburb, city, state, country] if p]
            formatted = ", ".join(parts) if parts else data.get("display_name", "")
            if formatted:
                return {"status": "ok", "formatted_address": formatted, "address_details": addr}
    except Exception as e:
        logger.warning(f"Reverse geocode error: {e}")
    return {"status": "fallback", "formatted_address": ""}

@app.get("/api/interfaces")
def list_interfaces():
    return {
        "interfaces": get_available_interfaces(),
        "default": settings.NETWORK_INTERFACE,
        "is_pcap_replay": bool(settings.REPLAY_PCAP_PATH)
    }

@app.get("/api/health")
def get_health():
    return {
        "status": capture_engine.status,
        "error_message": capture_engine.error_message,
        "is_paused": capture_engine.is_paused,
        "dropped_packets": capture_engine.dropped_packets,
        "packets_processed": capture_engine.packets_processed,
        "duration_seconds": capture_engine.duration_seconds,
        "stop_timestamp": capture_engine.stop_timestamp,
        "selected_interface": capture_engine.selected_interface,
        "geoip2_available": HAS_GEOIP2,
        "geoip_status": get_geoip_status(),
        "active_ws_clients": len(broadcaster.active_connections)
    }

@app.post("/api/capture/start", dependencies=[Depends(verify_token)])
async def start_capture(
    interface: str = Query(""),
    duration_seconds: int = Query(0, ge=0),
    demo_mode: bool = Query(False)
):
    capture_engine.start(
        interface=interface,
        duration_seconds=duration_seconds,
        demo_mode=demo_mode,
        broadcast_cb=broadcaster.broadcast_status
    )
    await broadcaster.broadcast_status({
        "status": capture_engine.status,
        "is_paused": False,
        "geoip_status": get_geoip_status(),
        "error_message": capture_engine.error_message,
        "dropped_packets": capture_engine.dropped_packets,
        "packets_processed": capture_engine.packets_processed,
        "duration_seconds": capture_engine.duration_seconds,
        "stop_timestamp": capture_engine.stop_timestamp,
        "selected_interface": capture_engine.selected_interface
    })
    return {"message": "Capture started", "status": capture_engine.status}

@app.post("/api/capture/stop", dependencies=[Depends(verify_token)])
async def stop_capture():
    capture_engine.stop()
    await broadcaster.broadcast_status({
        "status": "stopped",
        "is_paused": False,
        "geoip_status": get_geoip_status(),
        "error_message": capture_engine.error_message,
        "dropped_packets": capture_engine.dropped_packets,
        "packets_processed": capture_engine.packets_processed,
        "duration_seconds": 0,
        "stop_timestamp": 0,
        "selected_interface": capture_engine.selected_interface
    })
    return {"message": "Capture stopped", "status": "stopped"}

@app.post("/api/capture/pause", dependencies=[Depends(verify_token)])
async def pause_capture():
    capture_engine.pause()
    await broadcaster.broadcast_status({
        "status": capture_engine.status,
        "is_paused": True,
        "geoip_status": get_geoip_status(),
        "error_message": capture_engine.error_message,
        "dropped_packets": capture_engine.dropped_packets
    })
    return {"message": "Capture paused", "status": capture_engine.status}

@app.post("/api/capture/resume", dependencies=[Depends(verify_token)])
async def resume_capture():
    capture_engine.resume()
    await broadcaster.broadcast_status({
        "status": capture_engine.status,
        "is_paused": False,
        "geoip_status": get_geoip_status(),
        "error_message": capture_engine.error_message,
        "dropped_packets": capture_engine.dropped_packets
    })
    return {"message": "Capture resumed", "status": capture_engine.status}

@app.get("/api/connections", dependencies=[Depends(verify_token)])
def get_connections(
    cursor: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    search: str = Query("", max_length=100)
):
    return get_recent_connections(cursor_id=cursor, limit=limit, search=search)

@app.get("/api/stats", dependencies=[Depends(verify_token)])
def get_traffic_stats():
    stats = get_stats()
    stats["dropped_packets"] = capture_engine.dropped_packets
    stats["capture_status"] = capture_engine.status
    return stats

@app.get("/api/export", dependencies=[Depends(verify_token)])
def export_traffic(format: str = Query("json", pattern="^(json|csv)$")):
    data = export_connections(fmt=format)
    media_type = "text/csv" if format == "csv" else "application/json"
    headers = {"Content-Disposition": f"attachment; filename=traffic_log.{format}"}
    return Response(content=data, media_type=media_type, headers=headers)

@app.websocket("/ws/traffic")
async def websocket_traffic(websocket: WebSocket, token: str = Query(None)):
    if settings.API_TOKEN and token != settings.API_TOKEN:
        await websocket.close(code=1008)
        return

    await broadcaster.connect(websocket)

    # Immediately send initial health status envelope
    initial_status = {
        "type": "health_status",
        "v": 1,
        "data": {
            "status": capture_engine.status,
            "is_paused": capture_engine.is_paused,
            "error_message": capture_engine.error_message,
            "packets_processed": capture_engine.packets_processed,
            "duration_seconds": capture_engine.duration_seconds,
            "stop_timestamp": capture_engine.stop_timestamp,
            "selected_interface": capture_engine.selected_interface,
            "geoip_status": get_geoip_status(),
            "dropped_packets": capture_engine.dropped_packets
        }
    }
    await websocket.send_json(initial_status)

    try:
        while True:
            # Keep socket alive and listen for client heartbeats/messages
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        broadcaster.disconnect(websocket)
    except Exception as e:
        logger.debug(f"WS error: {e}")
        broadcaster.disconnect(websocket)

# Mount frontend single page app
frontend_dir = BASE_DIR / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="static")
