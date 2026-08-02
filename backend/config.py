import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

class Settings:
    BIND_HOST: str = os.getenv("BIND_HOST", "127.0.0.1")
    PORT: int = int(os.getenv("PORT", "8000"))
    API_TOKEN: str = os.getenv("API_TOKEN", "")
    CORS_ORIGINS: list[str] = [
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", "http://127.0.0.1:8000,http://localhost:8000").split(",")
        if origin.strip()
    ]

    DEV_MODE: bool = os.getenv("DEV_MODE", "false").lower() in ("true", "1", "yes")

    NETWORK_INTERFACE: str = os.getenv("NETWORK_INTERFACE", "")
    BPF_FILTER: str = os.getenv("BPF_FILTER", "")
    MAX_QUEUE_SIZE: int = int(os.getenv("MAX_QUEUE_SIZE", "10000"))

    GEOLITE2_CITY_DB: str = os.getenv("GEOLITE2_CITY_DB", str(BASE_DIR / "GeoLite2-City.mmdb"))
    GEOLITE2_ASN_DB: str = os.getenv("GEOLITE2_ASN_DB", str(BASE_DIR / "GeoLite2-ASN.mmdb"))
    REPLAY_PCAP_PATH: str = os.getenv("REPLAY_PCAP_PATH", "wire.pcap")

    BATCH_INTERVAL_MS: int = int(os.getenv("BATCH_INTERVAL_MS", "500"))
    RETENTION_HOURS: int = int(os.getenv("RETENTION_HOURS", "24"))

    LOCAL_LAT: float = float(os.getenv("LOCAL_LAT", "37.7749"))
    LOCAL_LNG: float = float(os.getenv("LOCAL_LNG", "-122.4194"))

settings = Settings()

if not settings.API_TOKEN and not settings.DEV_MODE:
    raise ValueError(
        "CRITICAL SECURITY ERROR: API_TOKEN is empty and DEV_MODE is false/not set. "
        "Please specify a secure API_TOKEN in your environment or .env file, or set DEV_MODE=true for local development."
    )

