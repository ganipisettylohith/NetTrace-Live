/**
 * GeoTraffic Live Dashboard Application Script
 * OpenStreetMap + Leaflet Curves + Directional Animations + Chart.js Analytics + IP Detail Modal
 */

let map = null;
let deviceMarker = null;
let remoteMarkers = {};
let markerClusterGroup = null;
let polylines = [];
let ws = null;
let wsReconnectDelay = 1000;
let isPaused = false;
let config = {};
let connectionsStore = [];
let watchlist = [];
let throughputHistory = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
let prevPackets = 0;
let prevUniqueIps = 0;
let prevCountries = 0;

let heatmapLayer = null;
let mapMode = 'pins';
let timeScrubberCutoff = 0;

// Analytics Charts
let serviceChart = null;
let countryChart = null;

// Capture State Tracking
let captureStatus = 'stopped'; // 'stopped', 'capturing', 'replaying', 'paused', 'no_permissions', 'interface_not_found', 'error'
let packetsProcessed = 0;
let stopTimestamp = 0;
let countdownInterval = null;
let sessionStartTimestamp = 0;
let isRequestInFlight = false;
let deviceIp = '';
let ipLat = null, ipLng = null, ipLocationStr = '';
let isUserZoomedManually = false;

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initEventListeners();
  initMap();
  initCharts();
  requestDeviceLocation();
  initKeyboardShortcuts();

  // Load async API configuration and WebSocket cleanly
  loadConfig().then(() => {
    initWebSocket();
    fetchInterfaces();
    fetchInitialData();
  }).catch(err => {
    console.error('Async init error:', err);
  });
});

window.addEventListener('load', () => {
  if (map) {
    map.invalidateSize();
  }
});

function initTheme() {
  const savedTheme = localStorage.getItem('geo_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) themeBtn.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('geo_theme', next);
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) themeBtn.textContent = next === 'dark' ? '☀️' : '🌙';
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      config = await res.json();
    }
  } catch (err) {
    console.error('Failed to load server config:', err);
  }
}

async function fetchInterfaces() {
  const select = document.getElementById('select-interface');
  const replayBadge = document.getElementById('replay-badge');
  const selectSource = document.getElementById('select-source');

  // Handle capture source dropdown changes
  if (selectSource) {
    selectSource.addEventListener('change', () => {
      const source = selectSource.value;
      const demoBanner = document.getElementById('demo-banner');
      const ifaceContainer = document.getElementById('interface-container');
      
      if (source === 'demo') {
        if (demoBanner) demoBanner.classList.remove('hidden');
        if (ifaceContainer) ifaceContainer.classList.add('hidden');
      } else {
        if (demoBanner) demoBanner.classList.add('hidden');
        if (ifaceContainer) ifaceContainer.classList.remove('hidden');
      }
    });
  }

  if (config.is_pcap_replay) {
    if (selectSource) {
      selectSource.value = 'replay';
      Array.from(selectSource.options).forEach(opt => {
        if (opt.value !== 'replay') opt.disabled = true;
      });
    }
    if (select) {
      select.classList.add('hidden');
      select.style.display = 'none';
    }
    if (replayBadge) replayBadge.classList.remove('hidden');
    return;
  }

  if (select) {
    select.innerHTML = `<option value="" disabled selected>Loading available interfaces...</option>`;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const res = await fetch('/api/interfaces', { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      const interfaces = data.interfaces || [];
      const savedIface = localStorage.getItem('geo_last_interface') || data.default || '';

      if (select) {
        if (interfaces.length === 0) {
          select.innerHTML = `<option value="">Default Network Interface</option>`;
        } else {
          select.innerHTML = interfaces.map(iface => `
            <option value="${iface.name}" ${iface.name === savedIface ? 'selected' : ''}>
              ${iface.description || iface.name}
            </option>
          `).join('');
        }
      }
    }
  } catch (err) {
    console.error('Error fetching interfaces (falling back):', err);
    if (select) select.innerHTML = `<option value="">Default Network Interface</option>`;
  }

  const durationSelect = document.getElementById('select-duration');
  const savedDuration = localStorage.getItem('geo_last_duration');
  if (durationSelect && savedDuration) {
    durationSelect.value = savedDuration;
  }
}

function requestDeviceLocation() {
  const ipEl = document.getElementById('device-ip');
  const locEl = document.getElementById('device-location');

  if (locEl) locEl.textContent = 'Awaiting location permission...';

  fetch('/api/whoami')
    .then(res => res.json())
    .then(data => {
      deviceIp = data.ip || '';
      ipLat = data.lat;
      ipLng = data.lng;
      ipLocationStr = data.formatted_location || 'Detected Location';

      if (ipEl) ipEl.textContent = `IP: ${deviceIp}`;
    })
    .catch(err => {
      console.error('whoami error:', err);
    });

  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        fetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`)
          .then(r => r.json())
          .then(data => {
            if (data.status === 'ok' && data.formatted_address) {
              if (locEl) locEl.textContent = data.formatted_address;
              updateDeviceMarker(lat, lng, deviceIp, data.formatted_address, true);
            } else {
              fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18`)
                .then(r => r.json())
                .then(geoData => {
                  const addr = geoData.address || {};
                  const road = addr.road || addr.street || addr.pedestrian || '';
                  const suburb = addr.suburb || addr.neighbourhood || addr.residential || addr.quarter || addr.subdivision || '';
                  const city = addr.city || addr.town || addr.village || addr.city_district || addr.county || '';
                  const state = addr.state || addr.region || '';
                  const country = addr.country || '';

                  const parts = [road, suburb, city, state, country].filter(Boolean);
                  const preciseAddress = parts.length > 0 ? parts.join(', ') : ipLocationStr;

                  if (locEl) locEl.textContent = preciseAddress;
                  updateDeviceMarker(lat, lng, deviceIp, preciseAddress, true);
                })
                .catch(() => {
                  if (locEl) locEl.textContent = ipLocationStr;
                  updateDeviceMarker(lat, lng, deviceIp, ipLocationStr, true);
                });
            }
          })
          .catch(() => {
            if (locEl) locEl.textContent = ipLocationStr;
            updateDeviceMarker(lat, lng, deviceIp, ipLocationStr, true);
          });
      },
      (error) => {
        console.log('GPS Geolocation permission fallback to IP location:', error);
        if (locEl) locEl.textContent = ipLocationStr || 'Location Permission Denied';
        if (ipLat && ipLng) {
          updateDeviceMarker(ipLat, ipLng, deviceIp, ipLocationStr, true);
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }
}

function updateDeviceMarker(lat, lng, labelIp, labelLoc, shouldFly = true) {
  if (!map || !lat || !lng) return;
  const pos = [lat, lng];

  const deviceIcon = L.divIcon({
    className: 'custom-visitor-pin',
    html: `
      <div class="visitor-ring"></div>
      <div style="background-color: #0284c7; width: 18px; height: 18px; border-radius: 50%; border: 3px solid #ffffff; box-shadow: 0 0 14px #38bdf8;"></div>
    `,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });

  if (deviceMarker) {
    deviceMarker.setLatLng(pos);
  } else {
    deviceMarker = L.marker(pos, { icon: deviceIcon, zIndexOffset: 1000 }).addTo(map);
  }

  deviceMarker.bindPopup(`
    <div style="font-family: sans-serif; color: #0f172a; min-width: 160px;">
      <strong style="color:#0284c7;">📍 Your Device Location</strong><br>
      ${labelIp ? `IP: <strong>${labelIp}</strong><br>` : ''}
      Location: <strong>${labelLoc}</strong>
    </div>
  `);

  if (shouldFly) {
    map.flyTo(pos, 12, { animate: true, duration: 1.8 });
  }
  setTimeout(() => { if (map) map.invalidateSize(); }, 200);
}

function initMap() {
  const mapElement = document.getElementById('map');
  if (!mapElement || typeof L === 'undefined') return;

  map = L.map('map', {
    center: [20, 0],
    zoom: 2.5,
    zoomControl: true,
    attributionControl: false,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    touchZoom: true,
    dragging: true,
    tap: true
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);

  if (typeof L.control.attribution === 'function') {
    L.control.attribution({ collapsed: true, prefix: false }).addTo(map);
  }

  if (typeof L.markerClusterGroup === 'function') {
    markerClusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      disableClusteringAtZoom: 14
    });
    map.addLayer(markerClusterGroup);
  }

  map.on('zoomstart dragstart', () => {
    isUserZoomedManually = true;
  });

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (map) map.invalidateSize();
    });
    ro.observe(mapElement);
  }

  setTimeout(() => { if (map) map.invalidateSize(); }, 100);
  setTimeout(() => { if (map) map.invalidateSize(); }, 500);
}

function createRemotePinIcon() {
  return L.divIcon({
    className: 'custom-remote-pin',
    html: `<div style="background-color: #ef4444; width: 14px; height: 14px; border-radius: 50%; border: 2px solid #ffffff; box-shadow: 0 0 10px rgba(239, 68, 68, 0.9);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
}

function getProtocolColor(serviceStr) {
  const s = (serviceStr || '').toUpperCase();
  if (s.includes('HTTPS') || s.includes('443')) return '#38bdf8';
  if (s.includes('DNS') || s.includes('53')) return '#a855f7';
  if (s.includes('HTTP') || s.includes('80')) return '#f97316';
  return '#10b981';
}

function calculateBezierControlPoint(srcPos, dstPos, offsetIndex = 0) {
  const midLat = (srcPos[0] + dstPos[0]) / 2;
  const midLng = (srcPos[1] + dstPos[1]) / 2;

  const dx = dstPos[1] - srcPos[1];
  const dy = dstPos[0] - srcPos[0];
  const len = Math.sqrt(dx * dx + dy * dy);

  if (len === 0) return [midLat + 0.1, midLng + 0.1];

  const normX = -dy / len;
  const normY = dx / len;

  const offsetFactor = 0.18 + (offsetIndex % 4) * 0.06;
  const offset = len * offsetFactor;
  return [midLat + normX * offset, midLng + normY * offset];
}

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/traffic`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    const wsBadge = document.getElementById('ws-badge');
    if (wsBadge) {
      wsBadge.textContent = 'WS Online';
      wsBadge.className = 'badge badge-success';
    }
    wsReconnectDelay = 1000;
  };

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleWebSocketEnvelope(payload);
    } catch (e) {
      console.error('WS JSON parse error:', e);
    }
  };

  ws.onclose = () => {
    const wsBadge = document.getElementById('ws-badge');
    if (wsBadge) {
      wsBadge.textContent = 'WS Offline';
      wsBadge.className = 'badge badge-offline';
    }
    setTimeout(initWebSocket, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
  };

  ws.onerror = (err) => {
    console.error('WS Error:', err);
  };
}

function handleWebSocketEnvelope(envelope) {
  if (envelope.type === 'connection_batch') {
    processConnectionBatch(envelope.data || []);
  } else if (envelope.type === 'health_status') {
    updateHealthStatus(envelope.data || {});
  }
}

function getFilteredConnections() {
  if (!timeScrubberCutoff || timeScrubberCutoff === 0) {
    return connectionsStore;
  }
  return connectionsStore.filter(c => {
    const ts = c.timestamp || c.last_seen || 0;
    return ts <= timeScrubberCutoff;
  });
}

function processConnectionBatch(batch) {
  if (!batch || batch.length === 0) return;

  let addedCount = 0;
  let batchBytes = 0;

  batch.forEach((item) => {
    batchBytes += item.bytes || 0;
    packetsProcessed++;

    checkWatchlist(item);

    const remoteIp = item.remote_ip || item.dst_ip;
    const existingIndex = connectionsStore.findIndex(c => (c.remote_ip || c.dst_ip) === remoteIp && c.service === item.service);
    if (existingIndex >= 0) {
      connectionsStore[existingIndex].bytes = (connectionsStore[existingIndex].bytes || 0) + (item.bytes || 0);
      connectionsStore[existingIndex].timestamp = item.timestamp || item.last_seen || Date.now() / 1000;
    } else {
      connectionsStore.unshift(item);
      addedCount++;
    }

    renderConnectionOnMap(item);
    addLiveFeedEntry(item);
  });

  const throughputKb = (batchBytes / 1024.0).toFixed(1);
  updateSparkline(parseFloat(throughputKb));

  refreshMapView();
  renderTable();
  updateStatsHeader();
  updateAnalyticsCharts();
  updateLiveWidget();
}

function addLiveFeedEntry(conn) {
  const container = document.getElementById('live-feed-container');
  if (!container) return;

  const emptyEl = container.querySelector('.feed-empty');
  if (emptyEl) emptyEl.remove();

  const service = (conn.service || 'RAW').toUpperCase();
  let icon = '🟢';
  let flashClass = 'flash-other';
  if (service.includes('HTTPS') || service.includes('443')) {
    icon = '🔵';
    flashClass = 'flash-https';
  } else if (service.includes('DNS') || service.includes('53')) {
    icon = '🟣';
    flashClass = 'flash-dns';
  } else if (service.includes('HTTP') || service.includes('80')) {
    icon = '🟠';
    flashClass = 'flash-http';
  }

  const remoteIp = conn.remote_ip || conn.dst_ip || 'Unknown IP';
  const city = conn.city || '';
  const country = conn.country || 'Unknown';
  const locStr = city ? `${city}, ${country}` : country;
  const kbStr = ((conn.bytes || 100) / 1024.0).toFixed(1);
  const nowTs = Date.now();

  const div = document.createElement('div');
  div.className = `feed-item ${flashClass}`;
  div.dataset.ts = nowTs;
  div.innerHTML = `
    <span class="feed-icon">${icon}</span>
    <span class="feed-text"><strong>${service} traffic</strong> → ${locStr} (<code>${remoteIp}</code>)</span>
    <span class="feed-size">${kbStr} KB</span>
    <span class="feed-time">just now</span>
  `;

  container.insertBefore(div, container.firstChild);

  while (container.children.length > 100) {
    container.removeChild(container.lastChild);
  }
}

setInterval(() => {
  const container = document.getElementById('live-feed-container');
  if (!container) return;
  const now = Date.now();
  const items = container.querySelectorAll('.feed-item');
  items.forEach(item => {
    const ts = parseInt(item.dataset.ts || '0', 10);
    if (!ts) return;
    const diffSec = Math.floor((now - ts) / 1000);
    const timeEl = item.querySelector('.feed-time');
    if (timeEl) {
      if (diffSec < 3) timeEl.textContent = 'just now';
      else if (diffSec < 60) timeEl.textContent = `${diffSec}s ago`;
      else timeEl.textContent = `${Math.floor(diffSec / 60)}m ago`;
    }
  });
}, 3000);

function renderConnectionOnMap(conn) {
  if (!map || !conn.dst_lat || !conn.dst_lng) return;

  const remotePos = [conn.dst_lat, conn.dst_lng];
  const remoteIp = conn.remote_ip || conn.dst_ip || 'Unknown';

  if (!remoteMarkers[remoteIp]) {
    const marker = L.marker(remotePos, { icon: createRemotePinIcon() });
    marker.bindPopup(`
      <div style="font-family: sans-serif; color: #0f172a; min-width: 150px;">
        <strong style="color:#ef4444;">${remoteIp}</strong><br>
        ${conn.city || ''}${conn.city && conn.country ? ', ' : ''}${conn.country || 'Unknown'}<br>
        ASN / Org: <em>${conn.asn || 'Unknown ASN'}</em><br>
        Service: <strong>${conn.service || 'RAW'}</strong><br>
        <button onclick="openIpDetailModal('${remoteIp}')" style="margin-top:0.4rem; width:100%; background:#0284c7; color:#fff; border:none; padding:0.25rem 0.5rem; border-radius:4px; cursor:pointer; font-size:0.75rem;">View Full Details</button>
      </div>
    `);

    remoteMarkers[remoteIp] = marker;
    if (mapMode === 'pins' && markerClusterGroup) {
      markerClusterGroup.addLayer(marker);
    }
  }

  // Curved Bezier Arc Vector with Directional Animation
  const localPos = deviceMarker ? [deviceMarker.getLatLng().lat, deviceMarker.getLatLng().lng] : [conn.src_lat || config.local_lat || 17.3850, conn.src_lng || config.local_lng || 78.4867];
  
  let line;
  const color = getProtocolColor(conn.service);
  const weight = Math.min(4.5, Math.max(1.8, (conn.bytes || 100) / 2048));

  if (typeof L.curve === 'function') {
    const controlPos = calculateBezierControlPoint(localPos, remotePos, polylines.length);
    line = L.curve(['M', localPos, 'Q', controlPos, remotePos], {
      color: color,
      weight: weight,
      opacity: 0.85,
      dashArray: '8, 8',
      className: 'traffic-arc'
    });
  } else {
    line = L.polyline([localPos, remotePos], {
      color: color,
      weight: weight,
      opacity: 0.85,
      dashArray: '8, 8',
      className: 'traffic-arc'
    });
  }

  line.lastSeen = conn.timestamp || (Date.now() / 1000);

  if (mapMode === 'pins') {
    line.addTo(map);
  }

  polylines.push(line);
  if (polylines.length > 60) {
    const oldLine = polylines.shift();
    if (map.hasLayer(oldLine)) map.removeLayer(oldLine);
  }
}

function refreshMapView() {
  if (!map) return;
  const filtered = getFilteredConnections();
  const nowTs = Date.now() / 1000;

  if (mapMode === 'heatmap') {
    if (markerClusterGroup && map.hasLayer(markerClusterGroup)) {
      map.removeLayer(markerClusterGroup);
    }
    polylines.forEach(p => {
      if (map.hasLayer(p)) map.removeLayer(p);
    });

    const points = filtered
      .filter(c => c.dst_lat && c.dst_lng)
      .map(c => [c.dst_lat, c.dst_lng, 0.8]);

    if (typeof L.heatLayer === 'function') {
      if (!heatmapLayer) {
        heatmapLayer = L.heatLayer(points, { radius: 25, blur: 15, maxZoom: 10 });
        heatmapLayer.addTo(map);
      } else {
        heatmapLayer.setLatLngs(points);
        if (!map.hasLayer(heatmapLayer)) heatmapLayer.addTo(map);
      }
    }
  } else {
    if (heatmapLayer && map.hasLayer(heatmapLayer)) {
      map.removeLayer(heatmapLayer);
    }
    if (markerClusterGroup && !map.hasLayer(markerClusterGroup)) {
      map.addLayer(markerClusterGroup);
    }

    if (markerClusterGroup) {
      markerClusterGroup.clearLayers();
    }
    const currentIps = new Set(filtered.map(c => c.remote_ip || c.dst_ip));

    Object.entries(remoteMarkers).forEach(([ip, marker]) => {
      if (currentIps.has(ip) && markerClusterGroup) {
        markerClusterGroup.addLayer(marker);
      }
    });

    polylines.forEach(p => {
      // Inactivity Opacity Fade-Out
      const age = nowTs - (p.lastSeen || nowTs);
      const opacity = Math.max(0.15, 0.85 - (age / 180.0));
      if (typeof p.setStyle === 'function') {
        p.setStyle({ opacity: opacity });
      }
      if (!map.hasLayer(p)) p.addTo(map);
    });

    fitMapToBounds();
  }
}

function fitMapToBounds() {
  if (!map || isUserZoomedManually) return;
  const positions = [];

  if (deviceMarker) {
    positions.push(deviceMarker.getLatLng());
  }

  Object.values(remoteMarkers).forEach(marker => {
    if (marker && markerClusterGroup && markerClusterGroup.hasLayer(marker)) {
      positions.push(marker.getLatLng());
    }
  });

  if (positions.length > 1) {
    const bounds = L.latLngBounds(positions);
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 11, animate: true });
  }
}

function initCharts() {
  if (typeof Chart === 'undefined') return;

  const ctxServices = document.getElementById('chart-services');
  if (ctxServices) {
    serviceChart = new Chart(ctxServices, {
      type: 'doughnut',
      data: {
        labels: ['HTTPS', 'DNS', 'HTTP', 'Other'],
        datasets: [{
          data: [0, 0, 0, 0],
          backgroundColor: ['#38bdf8', '#a855f7', '#f97316', '#10b981'],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        cutout: '68%'
      }
    });
  }

  const ctxCountries = document.getElementById('chart-countries');
  if (ctxCountries) {
    countryChart = new Chart(ctxCountries, {
      type: 'bar',
      data: {
        labels: ['--', '--', '--'],
        datasets: [{
          data: [0, 0, 0],
          backgroundColor: '#0284c7',
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: { display: false },
          y: {
            ticks: { color: '#94a3b8', font: { size: 9 } },
            grid: { display: false }
          }
        }
      }
    });
  }
}

function updateAnalyticsCharts() {
  const filtered = getFilteredConnections();

  let httpsCount = 0, dnsCount = 0, httpCount = 0, otherCount = 0;
  const countryCounts = {};
  const destinationMap = {};

  filtered.forEach(c => {
    const s = (c.service || '').toUpperCase();
    if (s.includes('HTTPS') || s.includes('443')) httpsCount++;
    else if (s.includes('DNS') || s.includes('53')) dnsCount++;
    else if (s.includes('HTTP') || s.includes('80')) httpCount++;
    else otherCount++;

    const country = c.country || c.country_name || 'Unknown';
    if (country && country !== 'Unknown') {
      countryCounts[country] = (countryCounts[country] || 0) + 1;
    }

    const city = c.city || '';
    const region = c.region || c.state || '';
    const locParts = [city, region, country].filter(p => p && p !== 'Unknown');
    const destName = locParts.length > 0 ? locParts.join(', ') : 'Unknown Endpoint';

    if (!destinationMap[destName]) {
      destinationMap[destName] = { count: 0, bytes: 0 };
    }
    destinationMap[destName].count += 1;
    destinationMap[destName].bytes += (c.bytes || c.byte_count || 0);
  });

  if (serviceChart) {
    const total = httpsCount + dnsCount + httpCount + otherCount;
    serviceChart.data.datasets[0].data = total > 0 ? [httpsCount, dnsCount, httpCount, otherCount] : [1, 0, 0, 0];
    if (total === 0) {
      serviceChart.data.datasets[0].backgroundColor = ['#334155', '#334155', '#334155', '#334155'];
    } else {
      serviceChart.data.datasets[0].backgroundColor = ['#38bdf8', '#a855f7', '#f97316', '#10b981'];
    }
    serviceChart.update('none');
  }

  if (countryChart) {
    const sortedCountries = Object.entries(countryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const labels = sortedCountries.map(e => e[0]);
    const data = sortedCountries.map(e => e[1]);

    countryChart.data.labels = labels.length > 0 ? labels : ['--'];
    countryChart.data.datasets[0].data = data.length > 0 ? data : [0];
    countryChart.update('none');
  }

  const destListEl = document.getElementById('top-destinations-list');
  if (destListEl) {
    const sortedDestinations = Object.entries(destinationMap)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);

    if (sortedDestinations.length === 0) {
      destListEl.innerHTML = `<div class="dest-empty">No active destination traffic</div>`;
    } else {
      destListEl.innerHTML = sortedDestinations.map(([name, stat]) => `
        <div class="dest-item">
          <span class="dest-name" title="${name}">📍 ${name}</span>
          <span class="dest-count">${stat.count} conn (${(stat.bytes / 1024.0).toFixed(1)} KB)</span>
        </div>
      `).join('');
    }
  }
}

function openIpDetailModal(ipStr) {
  const conn = connectionsStore.find(c => (c.remote_ip || c.dst_ip) === ipStr) || { remote_ip: ipStr, country: 'Unknown', asn: 'Unknown', service: 'RAW', bytes: 0 };
  const allConns = connectionsStore.filter(c => (c.remote_ip || c.dst_ip) === ipStr);

  document.getElementById('detail-ip').textContent = ipStr;
  document.getElementById('detail-badge-country').textContent = conn.country || 'Unknown';
  document.getElementById('detail-asn').textContent = conn.asn || 'Unknown';
  document.getElementById('detail-service').textContent = conn.service || 'RAW';

  const totalBytes = allConns.reduce((acc, c) => acc + (c.bytes || c.byte_count || 0), 0);
  document.getElementById('detail-bytes').textContent = `${(totalBytes / 1024.0).toFixed(1)} KB`;

  const tsVal = conn.timestamp || conn.last_seen || (Date.now() / 1000);
  document.getElementById('detail-time').textContent = new Date(tsVal * 1000).toLocaleTimeString();

  const tbody = document.getElementById('detail-packets-tbody');
  if (allConns.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No connection records</td></tr>`;
  } else {
    tbody.innerHTML = allConns.slice(0, 10).map(c => `
      <tr>
        <td><strong>${c.service || 'IPv4'}</strong></td>
        <td>${c.port || 443}</td>
        <td>${((c.bytes || 100) / 1024.0).toFixed(1)} KB</td>
        <td>${new Date((c.timestamp || Date.now() / 1000) * 1000).toLocaleTimeString()}</td>
      </tr>
    `).join('');
  }

  document.getElementById('modal-ip-detail').classList.remove('hidden');
}

function updateHealthStatus(statusData) {
  const previousStatus = captureStatus;
  captureStatus = statusData.status || 'stopped';
  if (typeof statusData.packets_processed !== 'undefined') {
    packetsProcessed = statusData.packets_processed;
  }

  stopTimestamp = statusData.stop_timestamp || 0;

  const healthBadge = document.getElementById('health-badge');
  const toggleBtn = document.getElementById('btn-capture-toggle');
  const toggleText = document.getElementById('capture-toggle-text');
  const captureIcon = document.getElementById('capture-icon');
  const selectIface = document.getElementById('select-interface');
  const selectDuration = document.getElementById('select-duration');
  const selectSource = document.getElementById('select-source');
  const liveWidget = document.getElementById('live-capture-widget');

  const isRunning = (captureStatus === 'capturing' || captureStatus === 'replaying');

  // Handle capture error visibility
  const systemBanner = document.getElementById('system-banner');
  const systemBannerText = document.getElementById('system-banner-text');
  if (systemBanner && systemBannerText) {
    if (captureStatus === 'error' && statusData.error_message) {
      systemBannerText.textContent = statusData.error_message;
      systemBanner.className = 'system-banner error';
      systemBanner.classList.remove('hidden');
    } else {
      systemBanner.classList.add('hidden');
    }
  }

  if (healthBadge) {
    healthBadge.textContent = captureStatus.toUpperCase();
    if (isRunning) {
      healthBadge.className = 'badge badge-success';
    } else if (captureStatus === 'paused') {
      healthBadge.className = 'badge badge-warning';
    } else {
      healthBadge.className = 'badge badge-offline';
    }
  }

  if (toggleBtn && toggleText) {
    if (isRunning || captureStatus === 'paused') {
      toggleBtn.className = 'btn btn-danger';
      toggleText.textContent = 'Stop Capture';
      if (captureIcon) captureIcon.innerHTML = `<path fill="currentColor" d="M6 6h12v12H6z"/>`;
      if (selectIface) selectIface.disabled = true;
      if (selectDuration) selectDuration.disabled = true;
      if (selectSource) selectSource.disabled = true;
      if (liveWidget) liveWidget.classList.remove('hidden');
      startCountdownTimer();
    } else {
      toggleBtn.className = 'btn btn-success';
      toggleText.textContent = 'Start Capture';
      if (captureIcon) captureIcon.innerHTML = `<path fill="currentColor" d="M8 5v14l11-7z"/>`;
      if (selectIface) selectIface.disabled = false;
      if (selectDuration) selectDuration.disabled = false;
      if (selectSource) selectSource.disabled = false;
      stopCountdownTimer();
    }
  }


  if ((previousStatus === 'capturing' || previousStatus === 'replaying') && (captureStatus === 'stopped' || statusData.auto_stopped)) {
    showSessionSummary();
  }

  if (map) map.invalidateSize();
  updateLiveWidget();
  renderTable();
  updateAnalyticsCharts();
}

function updateLiveWidget() {
  const pktBadge = document.getElementById('widget-pkt-count');
  if (pktBadge) {
    pktBadge.textContent = `Pkts: ${packetsProcessed}`;
  }
}

function startCountdownTimer() {
  const timerBadge = document.getElementById('widget-timer');
  if (!timerBadge) return;

  if (stopTimestamp <= 0) {
    timerBadge.classList.add('hidden');
    return;
  }

  timerBadge.classList.remove('hidden');
  updateTimerDisplay();

  if (!countdownInterval) {
    countdownInterval = setInterval(updateTimerDisplay, 1000);
  }
}

function updateTimerDisplay() {
  const timerBadge = document.getElementById('widget-timer');
  if (!timerBadge || stopTimestamp <= 0) return;

  const now = Date.now() / 1000;
  const remaining = Math.max(0, Math.ceil(stopTimestamp - now));

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  timerBadge.textContent = `⏱ ${formatted}`;

  if (remaining <= 0) {
    stopCountdownTimer();
  }
}

function stopCountdownTimer() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  const timerBadge = document.getElementById('widget-timer');
  if (timerBadge) timerBadge.classList.add('hidden');
}

async function toggleCapture() {
  if (isRequestInFlight) return;

  const isRunning = (captureStatus === 'capturing' || captureStatus === 'replaying' || captureStatus === 'paused');

  if (isRunning) {
    if (stopTimestamp > 0) {
      const now = Date.now() / 1000;
      const remainingSec = Math.max(0, Math.ceil(stopTimestamp - now));
      if (remainingSec > 0) {
        const confirmed = confirm(`Stop capture early? ${remainingSec} seconds remaining in auto-stop timer.`);
        if (!confirmed) return;
      }
    }

    setInFlightState(true);
    try {
      const res = await fetch('/api/capture/stop', { method: 'POST' });
      if (res.ok) {
        updateHealthStatus({ status: 'stopped' });
      }
    } catch (e) {
      console.error('Error stopping capture:', e);
    } finally {
      setInFlightState(false);
    }
  } else {
    const selectIface = document.getElementById('select-interface');
    const selectDuration = document.getElementById('select-duration');
    const selectSource = document.getElementById('select-source');

    const iface = selectIface ? selectIface.value : '';
    const duration = selectDuration ? parseInt(selectDuration.value, 10) : 0;
    const source = selectSource ? selectSource.value : 'live';
    const demoMode = (source === 'demo');

    if (iface) localStorage.setItem('geo_last_interface', iface);
    localStorage.setItem('geo_last_duration', duration.toString());

    sessionStartTimestamp = Date.now();
    setInFlightState(true);

    try {
      const url = `/api/capture/start?interface=${encodeURIComponent(iface)}&duration_seconds=${duration}&demo_mode=${demoMode}`;
      const res = await fetch(url, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        updateHealthStatus({ status: data.status || 'capturing' });
      } else {
        updateHealthStatus({ status: 'stopped' });
      }
    } catch (e) {
      console.error('Error starting capture:', e);
      updateHealthStatus({ status: 'stopped' });
    } finally {
      setInFlightState(false);
    }

  }
}

function setInFlightState(inFlight) {
  isRequestInFlight = inFlight;
  const toggleBtn = document.getElementById('btn-capture-toggle');
  if (toggleBtn) {
    toggleBtn.disabled = inFlight;
    toggleBtn.style.opacity = inFlight ? '0.6' : '1.0';
  }
}

function showSessionSummary() {
  const durationSec = sessionStartTimestamp > 0 ? Math.round((Date.now() - sessionStartTimestamp) / 1000) : 0;
  const totalPackets = packetsProcessed || connectionsStore.length;
  const uniqueIps = new Set(connectionsStore.map(c => c.remote_ip || c.dst_ip)).size;
  const countries = new Set(connectionsStore.map(c => c.country)).size;

  document.getElementById('sum-duration').textContent = `${durationSec}s`;
  document.getElementById('sum-packets').textContent = totalPackets;
  document.getElementById('sum-ips').textContent = uniqueIps;
  document.getElementById('sum-countries').textContent = countries;

  document.getElementById('modal-summary').classList.remove('hidden');
}

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag !== 'input' && activeTag !== 'textarea' && activeTag !== 'select') {
        e.preventDefault();
        toggleCapture();
      }
    }
  });
}

async function fetchInitialData() {
  try {
    const healthRes = await fetch('/api/health');
    if (healthRes.ok) {
      const health = await healthRes.json();
      updateHealthStatus(health);

      if (health.status === 'capturing' || health.status === 'replaying') {
        const res = await fetch('/api/connections?limit=100');
        if (res.ok) {
          const payload = await res.json();
          connectionsStore = payload.data || [];
          connectionsStore.forEach(c => renderConnectionOnMap(c));
        }
      } else {
        connectionsStore = [];
      }
      renderTable();
      updateAnalyticsCharts();
    }

    const statsRes = await fetch('/api/stats');
    if (statsRes.ok) {
      const stats = await statsRes.json();
      updateStatsFromApi(stats);
    }
  } catch (err) {
    console.error('Error fetching initial data:', err);
  }
}

function renderTable() {
  const tbody = document.getElementById('connections-tbody');
  const searchInput = document.getElementById('table-search').value.toLowerCase();
  const filteredConnections = getFilteredConnections();

  let filtered = filteredConnections.filter(c => {
    const ip = (c.remote_ip || c.dst_ip || '').toLowerCase();
    const country = (c.country || '').toLowerCase();
    const asn = (c.asn || '').toLowerCase();
    const service = (c.service || '').toLowerCase();
    if (!searchInput) return true;
    return (
      ip.includes(searchInput) ||
      country.includes(searchInput) ||
      asn.includes(searchInput) ||
      service.includes(searchInput)
    );
  });

  document.getElementById('conn-count').textContent = filtered.length;

  if (filtered.length === 0) {
    const isStopped = (captureStatus === 'stopped' || captureStatus === 'idle');
    const msg = isStopped ? 'No active traffic. Click "Start Capture" to begin monitoring connections.' : 'No connection matches found';
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(c => {
    const remoteIp = c.remote_ip || c.dst_ip || 'Unknown';
    const bytesVal = typeof c.bytes !== 'undefined' ? c.bytes : (c.byte_count || 0);
    const tsVal = c.timestamp || c.last_seen || (Date.now() / 1000);
    const kbStr = (bytesVal / 1024.0).toFixed(1);
    const timeStr = new Date(tsVal * 1000).toLocaleTimeString();

    return `
      <tr onclick="openIpDetailModal('${remoteIp}')">
        <td><strong>${remoteIp}</strong></td>
        <td>${c.city || ''}${c.city && c.country ? ', ' : ''}${c.country || 'Unknown'}</td>
        <td>${c.asn || 'Unknown'}</td>
        <td>${c.service || 'RAW'}</td>
        <td>${kbStr} KB</td>
        <td>${timeStr}</td>
      </tr>
    `;
  }).join('');
}

function animateValue(id, start, end, duration) {
  const obj = document.getElementById(id);
  if (!obj) return;
  if (start === end) {
    obj.textContent = end;
    return;
  }
  let startTimestamp = null;
  const step = (timestamp) => {
    if (!startTimestamp) startTimestamp = timestamp;
    const progress = Math.min((timestamp - startTimestamp) / duration, 1);
    obj.textContent = Math.floor(progress * (end - start) + start);
    if (progress < 1) {
      window.requestAnimationFrame(step);
    } else {
      obj.textContent = end;
    }
  };
  window.requestAnimationFrame(step);
}

function updateStatsHeader() {
  const filtered = getFilteredConnections();
  const newPackets = filtered.length;
  const totalBytes = filtered.reduce((acc, c) => acc + (c.bytes || (c.byte_count || 0)), 0);
  document.getElementById('stat-bytes').textContent = `${(totalBytes / (1024 * 1024)).toFixed(2)} MB`;

  const newUniqueIps = new Set(filtered.map(c => c.remote_ip || c.dst_ip)).size;
  const newCountries = new Set(filtered.map(c => c.country)).size;

  animateValue('stat-packets', prevPackets, newPackets, 400);
  animateValue('stat-ips', prevUniqueIps, newUniqueIps, 400);
  animateValue('stat-countries', prevCountries, newCountries, 400);

  prevPackets = newPackets;
  prevUniqueIps = newUniqueIps;
  prevCountries = newCountries;
}


function updateStatsFromApi(stats) {
  document.getElementById('stat-dropped').textContent = `${stats.dropped_packets || 0} dropped`;
  if (stats.country_breakdown && stats.country_breakdown.length > 0) {
    document.getElementById('stat-top-country').textContent = `Top: ${stats.country_breakdown[0].country}`;
  }
}

function updateSparkline(kbVal) {
  throughputHistory.push(kbVal);
  if (throughputHistory.length > 15) throughputHistory.shift();

  document.getElementById('stat-throughput').textContent = kbVal.toFixed(1);

  const canvas = document.getElementById('sparkline-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const maxVal = Math.max(...throughputHistory, 1.0);
  ctx.beginPath();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;

  throughputHistory.forEach((val, index) => {
    const x = (index / (throughputHistory.length - 1)) * canvas.width;
    const y = canvas.height - (val / maxVal) * (canvas.height - 4);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function checkWatchlist(conn) {
  if (!watchlist || watchlist.length === 0) return;
  const ip = conn.remote_ip || conn.dst_ip || '';
  const country = conn.country || 'Unknown';
  const asn = conn.asn || 'Unknown';
  const str = `${ip} ${country} ${asn}`.toLowerCase();
  const match = watchlist.some(rule => rule && str.includes(rule.toLowerCase()));
  if (match) {
    announceAria(`Watchlist match detected for ${ip} (${conn.country})`);
    
    // Add to Watchlist Alerts Panel
    const alertsPanel = document.getElementById('alerts-panel');
    const alertsList = document.getElementById('alerts-list');
    if (alertsPanel && alertsList) {
      alertsPanel.classList.remove('hidden');
      const div = document.createElement('div');
      div.className = 'alert-item';
      const timeStr = new Date().toLocaleTimeString();
      div.innerHTML = `<span>🚨 <strong>${ip}</strong> (${country}) - Matched watchlist rule</span><span style="font-size:0.7rem; opacity: 0.8;">${timeStr}</span>`;
      alertsList.insertBefore(div, alertsList.firstChild);
      
      while (alertsList.children.length > 50) {
        alertsList.removeChild(alertsList.lastChild);
      }
    }
  }
}


function initEventListeners() {
  const closeBannerBtn = document.getElementById('btn-close-banner');
  if (closeBannerBtn) {
    closeBannerBtn.addEventListener('click', () => {
      const banner = document.getElementById('system-banner');
      if (banner) banner.classList.add('hidden');
    });
  }

  const clearAlertsBtn = document.getElementById('btn-clear-alerts');
  if (clearAlertsBtn) {
    clearAlertsBtn.addEventListener('click', () => {
      const alertsList = document.getElementById('alerts-list');
      if (alertsList) alertsList.innerHTML = '';
      const alertsPanel = document.getElementById('alerts-panel');
      if (alertsPanel) alertsPanel.classList.add('hidden');
    });
  }

  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  document.getElementById('btn-capture-toggle').addEventListener('click', toggleCapture);

  window.addEventListener('resize', () => {
    if (map) map.invalidateSize();
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    connectionsStore = [];
    packetsProcessed = 0;
    prevPackets = 0;
    prevUniqueIps = 0;
    prevCountries = 0;
    polylines.forEach(p => {
      if (map && map.hasLayer(p)) map.removeLayer(p);
    });
    polylines = [];
    if (markerClusterGroup) markerClusterGroup.clearLayers();
    remoteMarkers = {};
    if (heatmapLayer && map && map.hasLayer(heatmapLayer)) map.removeLayer(heatmapLayer);
    const feedContainer = document.getElementById('live-feed-container');
    if (feedContainer) feedContainer.innerHTML = `<div class="feed-empty">No activity yet. Click "Start Capture" to view live traffic stream.</div>`;
    
    // Clear watchlist alerts too
    const alertsList = document.getElementById('alerts-list');
    if (alertsList) alertsList.innerHTML = '';
    const alertsPanel = document.getElementById('alerts-panel');
    if (alertsPanel) alertsPanel.classList.add('hidden');

    renderTable();
    updateStatsHeader();
    updateAnalyticsCharts();
    updateLiveWidget();
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    window.location.href = '/api/export?format=csv';
  });

  document.getElementById('btn-watchlist').addEventListener('click', () => {
    document.getElementById('modal-watchlist').classList.remove('hidden');

  });

  document.getElementById('btn-close-watchlist').addEventListener('click', () => {
    document.getElementById('modal-watchlist').classList.add('hidden');
  });

  document.getElementById('btn-save-watchlist').addEventListener('click', () => {
    const input = document.getElementById('watchlist-input').value;
    watchlist = input.split(',').map(s => s.trim()).filter(Boolean);
    localStorage.setItem('geo_watchlist', JSON.stringify(watchlist));
    document.getElementById('modal-watchlist').classList.add('hidden');
  });

  document.getElementById('btn-close-summary').addEventListener('click', () => {
    document.getElementById('modal-summary').classList.add('hidden');
  });

  document.getElementById('btn-close-detail').addEventListener('click', () => {
    document.getElementById('modal-ip-detail').classList.add('hidden');
  });

  document.getElementById('table-search').addEventListener('input', renderTable);

  document.getElementById('mode-pins').addEventListener('click', () => {
    mapMode = 'pins';
    document.getElementById('mode-pins').classList.add('active');
    document.getElementById('mode-heatmap').classList.remove('active');
    refreshMapView();
  });

  document.getElementById('mode-heatmap').addEventListener('click', () => {
    mapMode = 'heatmap';
    document.getElementById('mode-heatmap').classList.add('active');
    document.getElementById('mode-pins').classList.remove('active');
    refreshMapView();
  });

  const scrubber = document.getElementById('time-scrubber');
  if (scrubber) {
    scrubber.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      const label = document.getElementById('scrubber-label');
      if (val === 100) {
        if (label) label.textContent = 'Live';
        timeScrubberCutoff = 0;
      } else {
        if (label) label.textContent = `${val}%`;
        if (connectionsStore.length > 0) {
          const timestamps = connectionsStore.map(c => c.timestamp || c.last_seen || 0).sort((a, b) => a - b);
          const minTs = timestamps[0];
          const maxTs = timestamps[timestamps.length - 1];
          timeScrubberCutoff = minTs + (maxTs - minTs) * (val / 100.0);
        }
      }
      refreshMapView();
      renderTable();
      updateStatsHeader();
      updateAnalyticsCharts();
    });
  }
}

function announceAria(text) {
  const el = document.getElementById('aria-announcer');
  if (el) el.textContent = text;
}
