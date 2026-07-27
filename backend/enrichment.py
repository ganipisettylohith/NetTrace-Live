import threading
import queue
import time
import logging
from backend.capture import packet_queue
from backend.geolocate import geolocate_ip, is_public_ip, resolve_port_service, get_local_location
from backend.db import upsert_connection
from backend.broadcaster import broadcaster

logger = logging.getLogger(__name__)

class EnrichmentWorker:
    def __init__(self, num_workers=2):
        self.num_workers = num_workers
        self.is_running = False
        self.threads = []
        self.local_lat, self.local_lng, self.local_ip = settings.LOCAL_LAT, settings.LOCAL_LNG, "127.0.0.1"

    def start(self):
        if self.is_running:
            return
        self.is_running = True

        # Fetch local host geolocation at startup
        try:
            self.local_lat, self.local_lng, self.local_ip = get_local_location()
            logger.info(f"Local Host Location resolved: Lat {self.local_lat}, Lng {self.local_lng}")
        except Exception as e:
            logger.warning(f"Could not resolve local host location: {e}")

        for i in range(self.num_workers):
            t = threading.Thread(target=self._worker_loop, name=f"EnrichmentWorker-{i}", daemon=True)
            t.start()
            self.threads.append(t)
        logger.info(f"Started {self.num_workers} enrichment worker threads.")

    def stop(self):
        self.is_running = False

    def _worker_loop(self):
        while self.is_running:
            try:
                pkt_tuple = packet_queue.get(timeout=0.5)
            except queue.Empty:
                continue

            try:
                src_ip, dst_ip, proto, sport, dport, pkt_len, ts = pkt_tuple

                # Resolve public vs internal remote IP
                if is_public_ip(dst_ip):
                    remote_ip = dst_ip
                    remote_port = dport
                    direction = "outbound"
                    src_lat, src_lng = self.local_lat, self.local_lng
                    geo = geolocate_ip(remote_ip)
                    dst_lat, dst_lng = geo.get("lat"), geo.get("lng")
                elif is_public_ip(src_ip):
                    remote_ip = src_ip
                    remote_port = sport
                    direction = "inbound"
                    dst_lat, dst_lng = self.local_lat, self.local_lng
                    geo = geolocate_ip(remote_ip)
                    src_lat, src_lng = geo.get("lat"), geo.get("lng")
                else:
                    # Skip purely internal local-to-local RFC1918 traffic
                    continue

                service = resolve_port_service(remote_port, proto)

                enriched_data = {
                    "src_ip": src_ip,
                    "dst_ip": dst_ip,
                    "remote_ip": remote_ip,
                    "direction": direction,
                    "src_lat": src_lat,
                    "src_lng": src_lng,
                    "dst_lat": dst_lat,
                    "dst_lng": dst_lng,
                    "country": geo.get("country", "Unknown"),
                    "city": geo.get("city", "Unknown"),
                    "asn": geo.get("asn", "Unknown"),
                    "service": service,
                    "protocol": proto,
                    "bytes": pkt_len,
                    "timestamp": ts
                }

                # 1. Upsert into SQLite
                upsert_connection(enriched_data)

                # 2. Queue for WebSocket broadcast
                broadcaster.enqueue_event(enriched_data)

            except Exception as e:
                logger.error(f"Enrichment processing error: {e}")

from backend.config import settings
enrichment_worker = EnrichmentWorker()
