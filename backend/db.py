import sqlite3
import time
import json
import csv
import io
from pathlib import Path
from backend.config import settings, BASE_DIR

DB_PATH = BASE_DIR / "traffic.db"

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL;")
        cursor.execute("PRAGMA synchronous=NORMAL;")

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS connections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                connection_key TEXT UNIQUE,
                src_ip TEXT NOT NULL,
                dst_ip TEXT NOT NULL,
                src_lat REAL,
                src_lng REAL,
                dst_lat REAL,
                dst_lng REAL,
                country TEXT,
                city TEXT,
                asn TEXT,
                service TEXT,
                protocol TEXT,
                packet_count INTEGER DEFAULT 1,
                byte_count INTEGER DEFAULT 0,
                first_seen REAL,
                last_seen REAL
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ip_cache (
                ip TEXT PRIMARY KEY,
                lat REAL,
                lng REAL,
                country TEXT,
                city TEXT,
                asn TEXT,
                updated_at REAL
            )
        """)

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_conn_last_seen ON connections(last_seen);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_conn_dst_ip ON connections(dst_ip);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_conn_src_ip ON connections(src_ip);")
        conn.commit()

def upsert_connection(data: dict):
    conn_key = f"{data['src_ip']}->{data['dst_ip']}:{data['service']}"
    now = data.get("timestamp", time.time())
    byte_len = data.get("bytes", 0)

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO connections (
                connection_key, src_ip, dst_ip, src_lat, src_lng, dst_lat, dst_lng,
                country, city, asn, service, protocol, packet_count, byte_count, first_seen, last_seen
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(connection_key) DO UPDATE SET
                packet_count = packet_count + 1,
                byte_count = byte_count + excluded.byte_count,
                last_seen = excluded.last_seen,
                country = COALESCE(excluded.country, country),
                city = COALESCE(excluded.city, city),
                asn = COALESCE(excluded.asn, asn)
        """, (
            conn_key, data['src_ip'], data['dst_ip'], data.get('src_lat'), data.get('src_lng'),
            data.get('dst_lat'), data.get('dst_lng'), data.get('country', 'Unknown'),
            data.get('city', 'Unknown'), data.get('asn', 'Unknown'), data.get('service', 'UNKNOWN'),
            data.get('protocol', 'RAW'), byte_len, now, now
        ))
        conn.commit()

def get_cached_ip(ip: str):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT ip, lat, lng, country, city, asn FROM ip_cache WHERE ip = ?", (ip,))
        row = cursor.fetchone()
        return dict(row) if row else None

def cache_ip(ip: str, data: dict):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO ip_cache (ip, lat, lng, country, city, asn, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ip) DO UPDATE SET
                lat = excluded.lat, lng = excluded.lng, country = excluded.country,
                city = excluded.city, asn = excluded.asn, updated_at = excluded.updated_at
        """, (
            ip, data.get('lat'), data.get('lng'), data.get('country', 'Unknown'),
            data.get('city', 'Unknown'), data.get('asn', 'Unknown'), time.time()
        ))
        conn.commit()

def get_recent_connections(cursor_id: int = 0, limit: int = 50, search: str = ""):
    with get_db() as conn:
        cursor = conn.cursor()
        params = []
        where_clauses = []

        if cursor_id > 0:
            where_clauses.append("id < ?")
            params.append(cursor_id)

        if search:
            where_clauses.append("(dst_ip LIKE ? OR src_ip LIKE ? OR country LIKE ? OR city LIKE ? OR asn LIKE ? OR service LIKE ?)")
            pattern = f"%{search}%"
            params.extend([pattern] * 6)

        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        query = f"SELECT * FROM connections {where_sql} ORDER BY id DESC LIMIT ?"
        params.append(limit)

        cursor.execute(query, params)
        raw_rows = [dict(row) for row in cursor.fetchall()]
        rows = []
        for r in raw_rows:
            r["remote_ip"] = r.get("dst_ip", "Unknown")
            r["bytes"] = r.get("byte_count", 0)
            r["timestamp"] = r.get("last_seen", time.time())
            rows.append(r)

        next_cursor = rows[-1]['id'] if len(rows) == limit else None
        return {"data": rows, "next_cursor": next_cursor}

def get_stats():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as total_conns, SUM(packet_count) as total_packets, SUM(byte_count) as total_bytes FROM connections")
        total_row = cursor.fetchone()

        cursor.execute("SELECT COUNT(DISTINCT dst_ip) as unique_ips, COUNT(DISTINCT country) as unique_countries FROM connections")
        uniq_row = cursor.fetchone()

        cursor.execute("""
            SELECT dst_ip, country, asn, SUM(byte_count) as bytes, SUM(packet_count) as packets
            FROM connections GROUP BY dst_ip ORDER BY bytes DESC LIMIT 5
        """)
        top_talkers = [dict(row) for row in cursor.fetchall()]

        cursor.execute("SELECT country, COUNT(*) as count FROM connections GROUP BY country ORDER BY count DESC LIMIT 10")
        countries = [dict(row) for row in cursor.fetchall()]

        return {
            "total_connections": total_row["total_conns"] or 0,
            "total_packets": total_row["total_packets"] or 0,
            "total_bytes": total_row["total_bytes"] or 0,
            "unique_ips": uniq_row["unique_ips"] or 0,
            "unique_countries": uniq_row["unique_countries"] or 0,
            "top_talkers": top_talkers,
            "country_breakdown": countries
        }

def export_connections(fmt: str = "json"):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM connections ORDER BY last_seen DESC")
        rows = [dict(row) for row in cursor.fetchall()]

        if fmt.lower() == "csv":
            if not rows:
                return ""
            output = io.StringIO()
            sanitized_rows = []
            for row in rows:
                sanitized_row = {}
                for k, v in row.items():
                    if isinstance(v, str) and v and v[0] in ('=', '+', '-', '@'):
                        sanitized_row[k] = "'" + v
                    else:
                        sanitized_row[k] = v
                sanitized_rows.append(sanitized_row)
            
            writer = csv.DictWriter(output, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(sanitized_rows)
            return output.getvalue()
        else:
            return json.dumps(rows, indent=2)

def prune_old_connections(retention_hours: int):
    cutoff = time.time() - (retention_hours * 3600)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM connections WHERE last_seen < ?", (cutoff,))
        conn.commit()
