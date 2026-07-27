import ipaddress
import socket
import time
import requests
import logging
from pathlib import Path
from backend.config import settings
from backend.db import get_cached_ip, cache_ip

try:
    import geoip2.database
    HAS_GEOIP2 = True
except ImportError:
    HAS_GEOIP2 = False

logger = logging.getLogger(__name__)

# Token bucket rate limiter for ip-api.com (45 requests / 60 seconds)
RATE_LIMIT_MAX = 45
RATE_LIMIT_WINDOW = 60.0
_request_timestamps = []

_dns_cache = {}
_city_reader = None
_asn_reader = None

def init_geoip():
    global _city_reader, _asn_reader
    if HAS_GEOIP2:
        city_path = Path(settings.GEOLITE2_CITY_DB)
        asn_path = Path(settings.GEOLITE2_ASN_DB)

        if city_path.exists():
            try:
                _city_reader = geoip2.database.Reader(str(city_path))
                logger.info(f"Loaded GeoLite2 City database from {city_path}")
            except Exception as e:
                logger.warning(f"Failed to load GeoLite2 City database: {e}")

        if asn_path.exists():
            try:
                _asn_reader = geoip2.database.Reader(str(asn_path))
                logger.info(f"Loaded GeoLite2 ASN database from {asn_path}")
            except Exception as e:
                logger.warning(f"Failed to load GeoLite2 ASN database: {e}")

def close_geoip():
    global _city_reader, _asn_reader
    if _city_reader:
        _city_reader.close()
    if _asn_reader:
        _asn_reader.close()

def get_geoip_status() -> str:
    if not HAS_GEOIP2:
        return "disabled"
    if _city_reader is not None:
        return "ok"
    return "geoip_db_missing_using_fallback"

def is_public_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
        if ip.is_private or ip.is_loopback or ip.is_multicast or ip.is_link_local or ip.is_reserved or ip.is_unspecified:
            return False
        # Check Carrier Grade NAT (100.64.0.0/10)
        if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"):
            return False
        # Check IPv6 ULA (fc00::/7)
        if ip.version == 6 and ip in ipaddress.ip_network("fc00::/7"):
            return False
        return True
    except ValueError:
        return False

def _can_make_api_request() -> bool:
    now = time.time()
    global _request_timestamps
    _request_timestamps = [ts for ts in _request_timestamps if now - ts < RATE_LIMIT_WINDOW]
    if len(_request_timestamps) < RATE_LIMIT_MAX:
        _request_timestamps.append(now)
        return True
    return False

def resolve_port_service(port: int, proto: str) -> str:
    service_map = {
        53: "DNS", 80: "HTTP", 443: "HTTPS", 22: "SSH", 21: "FTP",
        25: "SMTP", 110: "POP3", 143: "IMAP", 123: "NTP", 445: "SMB",
        3389: "RDP", 8080: "HTTP-ALT", 8443: "HTTPS-ALT", 5353: "mDNS"
    }
    if port in service_map:
        return service_map[port]
    return f"{proto.upper()}/{port}"

def get_reverse_dns(ip_str: str) -> str:
    if ip_str in _dns_cache:
        return _dns_cache[ip_str]
    try:
        host, _ = socket.getnameinfo((ip_str, 0), 0)
        _dns_cache[ip_str] = host
        return host
    except Exception:
        _dns_cache[ip_str] = ip_str
        return ip_str

def geolocate_ip(ip_str: str) -> dict:
    if not is_public_ip(ip_str):
        return {"ip": ip_str, "lat": None, "lng": None, "country": "Local", "city": "Internal", "asn": "Private Network"}

    # 1. Check SQLite cache
    cached = get_cached_ip(ip_str)
    if cached:
        return cached

    lat, lng, country, city, asn = None, None, "Unknown", "Unknown", "Unknown"
    found_in_db = False

    # 2. Try GeoLite2 City Local DB
    if _city_reader:
        try:
            response = _city_reader.city(ip_str)
            lat = response.location.latitude
            lng = response.location.longitude
            country = response.country.name or response.registered_country.name or "Unknown"
            city = response.city.name or "Unknown"
            found_in_db = True
        except Exception:
            pass

    # 3. Try GeoLite2 ASN Local DB
    if _asn_reader:
        try:
            asn_resp = _asn_reader.asn(ip_str)
            asn = asn_resp.autonomous_system_organization or f"AS{asn_resp.autonomous_system_number}"
        except Exception:
            pass

    # 4. Fallback to ip-api.com HTTP API if not found or DB unavailable
    if not found_in_db and _can_make_api_request():
        try:
            resp = requests.get(f"http://ip-api.com/json/{ip_str}?fields=status,country,city,lat,lon,as,org", timeout=3.0)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("status") == "success":
                    lat = data.get("lat")
                    lng = data.get("lon")
                    country = data.get("country", "Unknown")
                    city = data.get("city", "Unknown")
                    asn = data.get("org") or data.get("as") or "Unknown"
        except Exception as e:
            logger.warning(f"HTTP GeoIP fallback error for {ip_str}: {e}")

    result = {
        "ip": ip_str,
        "lat": lat,
        "lng": lng,
        "country": country,
        "city": city,
        "asn": asn
    }

    if lat is not None and lng is not None:
        cache_ip(ip_str, result)

    return result

def get_local_location() -> tuple[float, float, str]:
    try:
        resp = requests.get("http://ip-api.com/json/?fields=status,lat,lon,query", timeout=3.0)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("status") == "success":
                return data.get("lat", settings.LOCAL_LAT), data.get("lon", settings.LOCAL_LNG), data.get("query", "Local Host")
    except Exception as e:
        logger.warning(f"Failed to lookup local host location: {e}")
    return settings.LOCAL_LAT, settings.LOCAL_LNG, "127.0.0.1"
