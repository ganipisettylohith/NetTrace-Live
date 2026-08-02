import threading
import queue
import time
import logging
import random
from pathlib import Path
from backend.config import settings

logger = logging.getLogger(__name__)

# Scapy import with fallback check
try:
    from scapy.all import sniff, rdpcap, PcapReader, IP, IPv6, TCP, UDP, ICMP
    HAS_SCAPY = True
except ImportError:
    HAS_SCAPY = False

packet_queue = queue.Queue(maxsize=settings.MAX_QUEUE_SIZE)
dropped_packets_count = 0

def get_available_interfaces() -> list[dict]:
    ifaces = []
    try:
        import socket
        hostname = socket.gethostname()
        local_ip = socket.gethostbyname(hostname)
        ifaces.append({
            "name": "Default Network Interface",
            "ip": local_ip,
            "mac": "",
            "description": f"Default Adapter ({local_ip})"
        })
    except Exception:
        ifaces.append({
            "name": "Default Network Interface",
            "ip": "127.0.0.1",
            "mac": "",
            "description": "Default Adapter (127.0.0.1)"
        })
    return ifaces

class CaptureEngine:
    def __init__(self):
        self.is_running = False
        self.is_paused = False
        self.status = "stopped"  # capturing, replaying, paused, stopped, error
        self.error_message = ""
        self.thread = None
        self.timer_thread = None
        self.dropped_packets = 0
        self.packets_processed = 0
        self.start_timestamp = 0
        self.duration_seconds = 0
        self.stop_timestamp = 0
        self.selected_interface = ""

    def start(self, interface: str = "", duration_seconds: int = 0, demo_mode: bool = False, broadcast_cb=None):
        if self.is_running:
            return

        self.is_running = True
        self.is_paused = False
        self.error_message = ""
        self.packets_processed = 0
        self.dropped_packets = 0
        self.start_timestamp = time.time()
        self.duration_seconds = max(0, duration_seconds)
        self.selected_interface = interface.strip() if interface else settings.NETWORK_INTERFACE

        if self.duration_seconds > 0:
            self.stop_timestamp = self.start_timestamp + self.duration_seconds
            
            def _timer_worker():
                time.sleep(self.duration_seconds)
                if self.is_running and self.stop_timestamp > 0:
                    logger.info(f"Auto-stop timer elapsed ({self.duration_seconds}s). Stopping capture.")
                    self.stop()
                    if broadcast_cb:
                        try:
                            import asyncio
                            asyncio.run(broadcast_cb({
                                "status": "stopped",
                                "is_paused": False,
                                "error_message": "",
                                "packets_processed": self.packets_processed,
                                "auto_stopped": True
                            }))
                        except Exception as e:
                            logger.debug(f"Timer broadcast error: {e}")

            self.timer_thread = threading.Thread(target=_timer_worker, daemon=True)
            self.timer_thread.start()
        else:
            self.stop_timestamp = 0

        if demo_mode:
            self.thread = threading.Thread(target=self._run_demo_mode, daemon=True)
            self.status = "capturing"
            logger.info("Starting demo mode packet stream")
        elif settings.REPLAY_PCAP_PATH and Path(settings.REPLAY_PCAP_PATH).exists():
            self.thread = threading.Thread(target=self._run_pcap_replay, daemon=True)
            self.status = "replaying"
            logger.info(f"Starting PCAP replay from {settings.REPLAY_PCAP_PATH}")
        else:
            self.thread = threading.Thread(target=self._run_live_sniff, daemon=True)
            self.status = "capturing"
            logger.info(f"Starting live Scapy capture on interface: {self.selected_interface or 'default'}")

        self.thread.start()

    def pause(self):
        if not self.is_running:
            return
        self.is_paused = True
        self.status = "paused"
        logger.info("Packet capture paused")

    def resume(self):
        if not self.is_running:
            return
        self.is_paused = False
        self.status = "replaying" if settings.REPLAY_PCAP_PATH else "capturing"
        logger.info("Packet capture resumed")

    def stop(self):
        self.is_running = False
        self.is_paused = False
        self.status = "stopped"
        self.stop_timestamp = 0
        logger.info("Packet capture stopped")

    def _process_packet(self, pkt):
        if not self.is_running or self.is_paused:
            return

        self.packets_processed += 1

        try:
            src_ip, dst_ip, proto = None, None, "RAW"
            sport, dport, pkt_len = 0, 0, len(pkt)
            ts = float(getattr(pkt, 'time', time.time()))

            if pkt.haslayer(IP):
                ip_layer = pkt[IP]
                src_ip = ip_layer.src
                dst_ip = ip_layer.dst
                proto = "IPv4"
            elif pkt.haslayer(IPv6):
                ip6_layer = pkt[IPv6]
                src_ip = ip6_layer.src
                dst_ip = ip6_layer.dst
                proto = "IPv6"
            else:
                return

            if pkt.haslayer(TCP):
                sport = pkt[TCP].sport
                dport = pkt[TCP].dport
                proto = "TCP"
            elif pkt.haslayer(UDP):
                sport = pkt[UDP].sport
                dport = pkt[UDP].dport
                proto = "UDP"
            elif pkt.haslayer(ICMP):
                proto = "ICMP"

            pkt_tuple = (src_ip, dst_ip, proto, sport, dport, pkt_len, ts)

            try:
                packet_queue.put_nowait(pkt_tuple)
            except queue.Full:
                self.dropped_packets += 1
                global dropped_packets_count
                dropped_packets_count += 1

        except Exception as e:
            logger.debug(f"Packet parsing error: {e}")

    def _run_live_sniff(self):
        if not HAS_SCAPY:
            logger.error("Scapy not available — cannot perform live capture.")
            self.status = "error"
            self.error_message = "Scapy is not installed. Live capture unavailable."
            return

        try:
            sniff(
                iface=self.selected_interface or None,
                filter=settings.BPF_FILTER or None,
                prn=self._process_packet,
                stop_filter=lambda pkt: not self.is_running,
                store=False
            )
        except PermissionError:
            logger.error("Live capture requires elevated privileges (run as root/Administrator).")
            self.status = "error"
            self.error_message = "Live capture requires administrator/root privileges. Run the app elevated, or use PCAP replay mode instead."
        except Exception as e:
            logger.error(f"Live capture failed: {e}")
            self.status = "error"
            self.error_message = f"Capture failed: {e}"

    def _run_demo_mode(self):
        logger.info("Running seamless packet stream engine.")
        self.status = "capturing"
        self.error_message = ""

        sample_ips = [
            ("8.8.8.8", "DNS"), ("1.1.1.1", "DNS"),
            ("142.250.190.46", "HTTPS"), ("13.225.103.11", "HTTPS"),
            ("151.101.1.140", "HTTPS"), ("104.16.132.229", "HTTPS"),
            ("20.112.250.133", "HTTPS"), ("52.84.18.9", "HTTPS"),
            ("185.199.108.153", "HTTP"), ("13.107.42.14", "HTTPS"),
            ("172.217.16.206", "HTTP"), ("34.223.12.98", "HTTPS")
        ]

        src_ip = "192.168.1.100"

        while self.is_running:
            if self.is_paused:
                time.sleep(0.2)
                continue

            dst_ip, service = random.choice(sample_ips)
            sport = random.randint(49152, 65535)
            dport = 443 if service == "HTTPS" else (53 if service == "DNS" else 80)
            proto = "UDP" if service == "DNS" else "TCP"
            pkt_len = random.randint(64, 1500)
            ts = time.time()

            pkt_tuple = (src_ip, dst_ip, proto, sport, dport, pkt_len, ts)
            self.packets_processed += 1

            try:
                packet_queue.put_nowait(pkt_tuple)
            except queue.Full:
                self.dropped_packets += 1

            time.sleep(random.uniform(0.15, 0.45))

    def _run_pcap_replay(self):
        if not HAS_SCAPY:
            logger.error("Scapy not available — cannot perform PCAP replay.")
            self.status = "error"
            self.error_message = "Scapy is not installed. PCAP replay unavailable."
            return
        if not settings.REPLAY_PCAP_PATH or not Path(settings.REPLAY_PCAP_PATH).exists():
            logger.error(f"PCAP file not found at {settings.REPLAY_PCAP_PATH}")
            self.status = "error"
            self.error_message = f"PCAP file not found at {settings.REPLAY_PCAP_PATH}"
            return

        pcap_path = settings.REPLAY_PCAP_PATH
        logger.info(f"Replaying PCAP: {pcap_path}")

        while self.is_running:
            try:
                for pkt in PcapReader(pcap_path):
                    if not self.is_running:
                        break
                    while self.is_paused:
                        time.sleep(0.2)
                    self._process_packet(pkt)
                    time.sleep(0.01)
            except Exception as e:
                logger.error(f"Error during PCAP replay: {e}")
                time.sleep(1.0)

capture_engine = CaptureEngine()
