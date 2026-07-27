import asyncio
import json
import logging
from typing import Set
from fastapi import WebSocket
from backend.config import settings

logger = logging.getLogger(__name__)

class Broadcaster:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self._pending_events = []
        self._lock = asyncio.Lock()
        self._task = None
        self._is_running = False

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info(f"WebSocket client connected. Total clients: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)
        logger.info(f"WebSocket client disconnected. Total clients: {len(self.active_connections)}")

    def enqueue_event(self, event: dict):
        self._pending_events.append(event)

    async def start(self):
        if self._is_running:
            return
        self._is_running = True
        self._task = asyncio.create_task(self._batch_flush_loop())
        logger.info("WebSocket broadcaster batch loop started.")

    async def stop(self):
        self._is_running = False
        if self._task:
            self._task.cancel()

    async def _batch_flush_loop(self):
        flush_interval = settings.BATCH_INTERVAL_MS / 1000.0

        while self._is_running:
            await asyncio.sleep(flush_interval)

            if not self._pending_events or not self.active_connections:
                self._pending_events.clear()
                continue

            events_to_send = list(self._pending_events)
            self._pending_events.clear()

            envelope = {
                "type": "connection_batch",
                "v": 1,
                "timestamp": asyncio.get_event_loop().time(),
                "count": len(events_to_send),
                "data": events_to_send
            }

            message_text = json.dumps(envelope)
            dead_sockets = set()

            for ws in list(self.active_connections):
                try:
                    await ws.send_text(message_text)
                except Exception as e:
                    logger.debug(f"Failed to send to WS client: {e}")
                    dead_sockets.add(ws)

            for ws in dead_sockets:
                self.disconnect(ws)

    async def broadcast_status(self, status_data: dict):
        if not self.active_connections:
            return

        envelope = {
            "type": "health_status",
            "v": 1,
            "data": status_data
        }
        message_text = json.dumps(envelope)

        for ws in list(self.active_connections):
            try:
                await ws.send_text(message_text)
            except Exception:
                pass

broadcaster = Broadcaster()
