const $ = (id) => document.getElementById(id);

const dom = {
  scanButton: $("scanButton"),
  sessionInfo: $("sessionInfo"),
  statusPill: $("statusPill"),
  totalLatencyMs: $("totalLatencyMs"),
  bufferSize: $("bufferSize"),
  sampleRate: $("sampleRate"),
  trackCount: $("trackCount"),
  totalDevices: $("totalDevices"),
  results: $("results"),
  autoRefreshToggle: $("autoRefreshToggle"),
  refreshInterval: $("refreshInterval"),
  intervalTrigger: $("intervalTrigger"),
  intervalDropdown: $("intervalDropdown"),
  intervalValue: $("intervalValue"),
  byChannelToggle: $("byChannelToggle"),
  byPluginToggle: $("byPluginToggle"),
  reportToolbar: $("reportToolbar"),
  searchInput: $("searchInput"),
  sortSelect: $("sortSelect"),
  showAllToggle: $("showAllToggle"),
  rowCount: $("rowCount"),
  exportJson: $("exportJson"),
  exportCsv: $("exportCsv"),
};

const state = {
  scanning: false,
  autoRefresh: false,
  intervalSeconds: 30,
  intervalId: null,
  consecutiveFailures: 0,
  currentBackoff: 30,
  lastScanTime: null,
  online: null,
  hasReport: false,
  backgroundScanning: false,
  groupMode: "channel",
  latestReport: null,
  searchQuery: "",
  sortKey: "latency-desc",
  showAll: false,
  scanAbort: null,
  statusAbort: null,
};

const activeTweens = new Map();
let tweenFrameId = null;

// ── Utilities ──

function fmtMs(value) {
  const n = Number(value || 0);
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pluginKey(plugin) {
  return String(plugin.device_name || "Unnamed Device")
    .trim()
    .toLowerCase()
    .replace(/\s*\((audio unit|au|vst|vst2|vst3|vst\/vst3)\)\s*$/i, "")
    .replace(/\s*\[(audio unit|au|vst|vst2|vst3|vst\/vst3)\]\s*$/i, "")
    .replace(/\s*-\s*(audio unit|au|vst|vst2|vst3|vst\/vst3)\s*$/i, "")
    .replace(/\s+(audio unit|au|vst|vst2|vst3|vst\/vst3)\s*$/i, "")
    .replace(/\s+/g, " ") || "unnamed device";
}

function hasNumericValue(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function trackNumber(device) {
  if (hasNumericValue(device.track_number)) return Number(device.track_number);
  if (hasNumericValue(device.track_index)) return Number(device.track_index) + 1;
  return "--";
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function stopTween(el) {
  activeTweens.delete(el);
}

function runTweens(now) {
  activeTweens.forEach((tween, el) => {
    const progress = Math.min((now - tween.start) / tween.duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = tween.from + (tween.to - tween.from) * eased;

    el.textContent = tween.format(value);
    el.dataset.value = String(value);

    if (progress >= 1) {
      el.textContent = tween.format(tween.to);
      el.dataset.value = String(tween.to);
      activeTweens.delete(el);
    }
  });

  tweenFrameId = activeTweens.size ? requestAnimationFrame(runTweens) : null;
}

function tweenText(el, nextValue, format, duration = 450) {
  const to = Number(nextValue || 0);
  const currentTween = activeTweens.get(el);
  const from = currentTween ? Number(el.dataset.value || currentTween.from) : Number(el.dataset.value || to);

  if (document.hidden || Math.abs(from - to) < 0.001) {
    stopTween(el);
    el.textContent = format(to);
    el.dataset.value = String(to);
    return;
  }

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    stopTween(el);
    el.textContent = format(to);
    el.dataset.value = String(to);
    return;
  }

  activeTweens.set(el, {
    from,
    to,
    format,
    duration,
    start: performance.now(),
  });

  if (!tweenFrameId) tweenFrameId = requestAnimationFrame(runTweens);
}

// ── Recovery actions ──

const RECOVERY_TIMEOUT_MS = 5000;

function openAbleton() {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), RECOVERY_TIMEOUT_MS);
  fetch("/api/open-ableton", {
    method: "POST",
    headers: { "X-Requested-With": "latency-manager" },
    signal: controller.signal,
  }).catch(() => {});
}

async function reloadOSC() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RECOVERY_TIMEOUT_MS);
  try {
    const res = await fetch("/api/reload-osc", {
      method: "POST",
      headers: { "X-Requested-With": "latency-manager" },
      signal: controller.signal,
    });
    if (res.ok) setTimeout(() => scan({ showLoading: true }), 1500);
  } catch {} finally {
    clearTimeout(timeoutId);
  }
}

// ── Status ──

function setStatus(online) {
  state.online = online;
  const cls = online ? "online" : "offline";
  const label = online ? "Connected" : "Offline";

  dom.statusPill.className = "status-pill " + cls;
  dom.statusPill.querySelector(".status-text").textContent = label;
}

function setCurrentProject(project) {
  dom.sessionInfo.textContent = project?.name || "No Ableton project detected";
  dom.sessionInfo.title = project?.path || "";
}

function preserveConnectedDuringBackgroundScan() {
  return state.backgroundScanning && state.online === true;
}

const STATUS_TIMEOUT_MS = 3000;

async function refreshStatus() {
  if (state.statusAbort) state.statusAbort.abort();
  const controller = new AbortController();
  state.statusAbort = controller;
  const timeoutId = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetch("/api/status", { signal: controller.signal });
    const data = await res.json();
    state.liveRunning = data.live_running;
    state.latencyHandlerAvailable = data.latency_handler_available;
    state.automationPermission = data.automation_permission;
    state.lastError = data.last_error;
    if (data.abletonosc_online || !preserveConnectedDuringBackgroundScan()) {
      setStatus(data.abletonosc_online);
    }
    setCurrentProject(data.current_project);
    if (!state.lastScanTime && data.last_scan_time) {
      state.lastScanTime = new Date(data.last_scan_time);
    }
  } catch {
    if (!preserveConnectedDuringBackgroundScan()) setStatus(false);
    setCurrentProject(null);
  } finally {
    clearTimeout(timeoutId);
    if (state.statusAbort === controller) state.statusAbort = null;
  }
}

// ── Rendering ──

function renderLoading() {
  dom.results.className = "results";
  let rows = "";
  for (let i = 0; i < 5; i++) {
    rows += `<div class="shimmer-row"></div>`;
  }
  dom.results.innerHTML = rows;
}

function renderEmpty() {
  dom.results.className = "results empty";
  dom.results.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">&#9775;</div>
      <strong>No scan yet</strong>
      <span>Open your session in Ableton Live, then scan.</span>
      <div class="recovery-actions">
        <button class="recovery-btn" onclick="scan({showLoading:true})">Scan now</button>
        <button class="recovery-btn secondary" onclick="openAbleton()">Open Live</button>
      </div>
    </div>`;
}

function renderOffline() {
  dom.results.className = "results empty";
  dom.results.innerHTML = `
    <div class="offline-state">
      <div class="offline-icon">&#9888;</div>
      <strong>AbletonOSC Offline</strong>
      <span>Make sure Ableton Live is running with AbletonOSC installed and enabled.</span>
      <div class="recovery-actions">
        <button class="recovery-btn" onclick="scan({showLoading:true})">Retry scan</button>
        <button class="recovery-btn secondary" onclick="openAbleton()">Open Live</button>
        <button class="recovery-btn secondary" onclick="reloadOSC()">Reload AbletonOSC</button>
      </div>
      <span class="recovery-hint">Not working? Check that port 11000 is reachable.</span>
    </div>`;
}

function renderError(message) {
  dom.results.className = "results empty";
  dom.results.innerHTML = `
    <div class="error-state">
      <div class="error-icon">!</div>
      <strong>Scan failed</strong>
      <span>${escapeHtml(message)}</span>
      <div class="recovery-actions">
        <button class="recovery-btn" onclick="scan({showLoading:true})">Retry scan</button>
        <button class="recovery-btn secondary" onclick="reloadOSC()">Reload AbletonOSC</button>
      </div>
    </div>`;
}

function getLatencyClass(samples, ms) {
  const latencyMs = ms || (samples / 48);
  if (latencyMs < 20) return "low";
  if (latencyMs > 100) return "high";
  return "medium";
}

function renderTrackDetails(instances, { nameLabel = "Track name", numberLabel = "" } = {}) {
  const hasNumberCol = Boolean(numberLabel);
  const colClass = hasNumberCol ? "" : " two-col";
  const rows = instances
    .slice()
    .sort((a, b) => Number(b.latency_samples || 0) - Number(a.latency_samples || 0))
    .map((inst) => {
      const activeClass = inst.active === true ? "active" : "";
      const activeText = inst.active === true ? "Active" : inst.active === false ? "Inactive" : "Unknown";
      return `
        <div class="track-item${colClass}">
          <div class="track-name">
            ${escapeHtml(inst.detail_name || inst.track_name || "Unnamed Track")}
            <span class="track-status ${activeClass}">${activeText}</span>
          </div>
          ${hasNumberCol ? `<div class="track-number">${escapeHtml(inst.detail_number ?? trackNumber(inst))}</div>` : ""}
          <div class="track-latency">
            ${fmtMs(inst.latency_ms)} ms
          </div>
        </div>`;
    })
    .join("");

  return `
    <div class="track-details-header${colClass}">
      <span class="header-name">${escapeHtml(nameLabel)}</span>
      ${hasNumberCol ? `<span class="header-number">${escapeHtml(numberLabel)}</span>` : ""}
      <span class="header-latency">Latency</span>
    </div>
    ${rows}`;
}

function updateDashboardStats(report) {
  tweenText(dom.totalLatencyMs, Number(report.total_latency_ms || 0), fmtMs);
  if (hasNumericValue(report.buffer_size)) {
    tweenText(dom.bufferSize, Number(report.buffer_size), (n) => String(Math.round(n)));
  } else {
    dom.bufferSize.textContent = "--";
  }
  tweenText(dom.sampleRate, report.sample_rate ? Number(report.sample_rate) / 1000 : 0, (n) => (n ? `${n.toFixed(1)}k` : "--"));
  tweenText(dom.trackCount, Number(report.track_count || 0), (n) => String(Math.round(n)));
  tweenText(dom.totalDevices, Number(report.device_count || 0), (n) => String(Math.round(n)));
}

function createPluginRow(item, maxSessionSamples) {
  const row = document.createElement("article");
  row.className = "plugin-row";
  row.dataset.key = item.key;
  row.innerHTML = `
    <div class="plugin-main">
      <div class="plugin-info">
        <span class="plugin-name"></span>
        <div class="plugin-tracks"></div>
      </div>
      <div class="plugin-bar-container">
        <div class="latency-bar"></div>
      </div>
      <div class="plugin-latency-val">
        <span class="latency-number"></span> <span style="font-size: 10px; color: var(--muted);">ms</span>
      </div>
      <button class="plugin-toggle" type="button" aria-label="Toggle details">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    </div>
    <div class="track-details"></div>`;
  updatePluginRow(row, item, maxSessionSamples);
  return row;
}

function updatePluginRow(row, item, maxSessionSamples) {
  const latencyClass = getLatencyClass(item.latency_samples, item.latency_ms);
  const widthPercent = Math.max((item.latency_samples / maxSessionSamples) * 100, 2);
  const nameEl = row.querySelector(".plugin-name");
  const tracksEl = row.querySelector(".plugin-tracks");
  const barEl = row.querySelector(".latency-bar");
  const latencyEl = row.querySelector(".plugin-latency-val");
  const latencyNumberEl = row.querySelector(".latency-number");
  const detailsEl = row.querySelector(".track-details");
  const name = item.title || "Unnamed";
  const subtitle = item.subtitle || "";

  if (nameEl.textContent !== name) nameEl.textContent = name;
  nameEl.title = name;
  if (tracksEl.textContent !== subtitle) tracksEl.textContent = subtitle;
  tracksEl.title = subtitle;
  barEl.className = `latency-bar ${latencyClass}`;
  barEl.style.width = `${widthPercent}%`;
  latencyEl.className = `plugin-latency-val ${latencyClass}`;
  latencyNumberEl.textContent = fmtMs(item.latency_ms);
  const detailsHtml = renderTrackDetails(item.instances || [], item.details || {});
  if (row._detailsHtml !== detailsHtml) {
    detailsEl.innerHTML = detailsHtml;
    row._detailsHtml = detailsHtml;
  }
}

// ── Data rows ──

function pluginRows(report) {
  const source = state.showAll ? (report.plugins || []) : (report.top_plugins || []);
  return source.map((plugin) => ({
    key: `plugin:${pluginKey(plugin)}`,
    title: plugin.device_name || "Unnamed Device",
    subtitle: (plugin.tracks || []).join(", "),
    latency_samples: Number(plugin.max_latency_samples || 0),
    latency_ms: Number(plugin.max_latency_ms || 0),
    instance_count: plugin.instance_count || (plugin.instances || []).length,
    instances: plugin.instances || [],
    details: { nameLabel: "Track name", numberLabel: "Track #" },
  }));
}

function allPluginRows(report) {
  return (report.plugins || []).map((plugin) => ({
    key: `plugin:${pluginKey(plugin)}`,
    title: plugin.device_name || "Unnamed Device",
    subtitle: (plugin.tracks || []).join(", "),
    latency_samples: Number(plugin.max_latency_samples || 0),
    latency_ms: Number(plugin.max_latency_ms || 0),
    instance_count: plugin.instance_count || (plugin.instances || []).length,
    instances: plugin.instances || [],
    details: { nameLabel: "Track name", numberLabel: "Track #" },
  }));
}

function channelRows(report) {
  const groups = new Map();
  (report.devices || []).forEach((device) => {
    const number = trackNumber(device);
    const name = device.track_name || "Unnamed Track";
    const key = `channel:${hasNumericValue(device.track_index) ? device.track_index : name}`;
    const group = groups.get(key) || {
      key,
      title: name,
      track_number: number,
      devices: [],
      deviceNames: [],
      latency_samples: 0,
      latency_ms: 0,
    };
    const samples = Number(device.latency_samples || 0);
    const ms = Number(device.latency_ms || 0);
    const deviceName = device.device_name || "Unnamed Device";

    group.latency_samples += samples;
    group.latency_ms += ms;
    if (!group.deviceNames.includes(deviceName)) group.deviceNames.push(deviceName);
    group.devices.push({
      ...device,
      detail_name: deviceName,
      detail_number: device.format || device.class_name || "--",
    });
    groups.set(key, group);
  });

  return [...groups.values()].map((group) => ({
    key: group.key,
    title: group.track_number === "--" ? group.title : `${group.track_number}. ${group.title}`,
    subtitle: `${pluralize(group.devices.length, "plug-in")} · ${group.deviceNames.join(", ")}`,
    latency_samples: group.latency_samples,
    latency_ms: group.latency_ms,
    instance_count: group.devices.length,
    instances: group.devices,
    details: { nameLabel: "Plug-in" },
  }));
}

// ── Filter & sort ──

function sortRows(rows) {
  const key = state.sortKey;
  return rows.slice().sort((a, b) => {
    switch (key) {
      case "latency-asc":
        return a.latency_samples - b.latency_samples || a.latency_ms - b.latency_ms;
      case "instances-desc":
        return (b.instance_count || 0) - (a.instance_count || 0) || b.latency_samples - a.latency_samples;
      default:
        return b.latency_samples - a.latency_samples || b.latency_ms - a.latency_ms;
    }
  });
}

function filterRows(rows) {
  const q = state.searchQuery.toLowerCase().trim();
  if (!q) return rows;
  return rows.filter((row) =>
    row.title.toLowerCase().includes(q) ||
    (row.subtitle && row.subtitle.toLowerCase().includes(q))
  );
}

function currentRows(report) {
  const raw = state.groupMode === "channel" ? channelRows(report) : pluginRows(report);
  const filtered = filterRows(raw);
  const sorted = sortRows(filtered);
  if (!state.showAll && state.groupMode === "channel") return sorted.slice(0, 10);
  return sorted;
}

function totalRowCount(report) {
  const raw = state.groupMode === "channel" ? channelRows(report) : allPluginRows(report);
  return raw.length;
}

function updateRowCount(shown, total) {
  if (shown === total) {
    dom.rowCount.textContent = `${total} items`;
  } else {
    dom.rowCount.textContent = `${shown} / ${total}`;
  }
}

// ── Results rendering ──

function updateResults(report) {
  const total = totalRowCount(report);
  const rows = currentRows(report);

  updateRowCount(rows.length, total);

  if (!total) {
    dom.results.className = "results empty";
    dom.results.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#10003;</div>
        <strong>No latency devices found</strong>
        <span>AbletonOSC responded, but the current set reported no plugin latency.</span>
        <div class="recovery-actions">
          <button class="recovery-btn" onclick="scan({showLoading:true})">Rescan</button>
          <button class="recovery-btn secondary" onclick="reloadOSC()">Reload AbletonOSC</button>
        </div>
      </div>`;
    return;
  }

  if (!rows.length) {
    dom.results.className = "results";
    dom.results.innerHTML = `<div class="no-filter-results">No matches for "${escapeHtml(state.searchQuery)}"</div>`;
    return;
  }

  const maxSessionSamples = Math.max(...rows.map((item) => item.latency_samples), 1);
  const rowsByKey = new Map(
    [...dom.results.querySelectorAll(".plugin-row")].map((row) => [row.dataset.key, row])
  );
  const nextKeys = new Set();

  dom.results.className = "results";
  [...dom.results.children].forEach((child) => {
    if (!child.classList.contains("plugin-row")) child.remove();
  });

  rows.forEach((item, index) => {
    const key = item.key;
    let row = rowsByKey.get(key);
    nextKeys.add(key);

    if (row) {
      updatePluginRow(row, item, maxSessionSamples);
    } else {
      row = createPluginRow(item, maxSessionSamples);
    }

    const currentAtIndex = dom.results.children[index];
    if (currentAtIndex !== row) {
      dom.results.insertBefore(row, currentAtIndex || null);
    }
  });

  rowsByKey.forEach((row, key) => {
    if (!nextKeys.has(key)) row.remove();
  });
}

function renderReport(report) {
  state.latestReport = report;
  updateDashboardStats(report);
  updateResults(report);
  state.hasReport = true;
  dom.reportToolbar.hidden = false;
}

// ── Export ──

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportJson() {
  if (!state.latestReport) return;
  const rows = currentRows(state.latestReport);
  const payload = {
    exported_at: new Date().toISOString(),
    group_mode: state.groupMode,
    sample_rate: state.latestReport.sample_rate,
    total_latency_ms: state.latestReport.total_latency_ms,
    items: rows.map((r) => ({
      name: r.title,
      latency_ms: r.latency_ms,
      latency_samples: r.latency_samples,
      instances: r.instance_count || 0,
      tracks: r.subtitle,
    })),
  };
  downloadFile(JSON.stringify(payload, null, 2), "latency-report.json", "application/json");
}

function exportCsv() {
  if (!state.latestReport) return;
  const rows = currentRows(state.latestReport);
  const header = "Name,Latency (ms),Latency (samples),Instances,Tracks";
  const csvRows = rows.map((r) => {
    const name = `"${(r.title || "").replace(/"/g, '""')}"`;
    const tracks = `"${(r.subtitle || "").replace(/"/g, '""')}"`;
    return `${name},${r.latency_ms},${r.latency_samples},${r.instance_count || 0},${tracks}`;
  });
  downloadFile([header, ...csvRows].join("\n"), "latency-report.csv", "text/csv");
}

// ── Group mode ──

function setGroupMode(mode) {
  if (state.groupMode === mode) return;
  state.groupMode = mode;
  dom.byChannelToggle.classList.toggle("active", mode === "channel");
  dom.byPluginToggle.classList.toggle("active", mode === "plugin");
  dom.byChannelToggle.setAttribute("aria-pressed", String(mode === "channel"));
  dom.byPluginToggle.setAttribute("aria-pressed", String(mode === "plugin"));
  if (state.latestReport) updateResults(state.latestReport);
}

// ── Scan ──

const SCAN_TIMEOUT_MS = 10000;

async function scan({ showLoading = true } = {}) {
  if (state.scanning) return;
  state.scanning = true;
  state.backgroundScanning = !showLoading;

  if (state.scanAbort) state.scanAbort.abort();
  const controller = new AbortController();
  state.scanAbort = controller;

  dom.scanButton.disabled = true;
  dom.scanButton.classList.add("scanning");
  if (showLoading) renderLoading();

  const timeoutId = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "X-Requested-With": "latency-manager" },
      signal: controller.signal,
    });
    const data = await res.json();

    if (!res.ok) {
      if (data.code === "scan_in_progress") {
        return;
      }
      throw new Error(data.error || "Scan failed");
    }

    setStatus(true);
    state.consecutiveFailures = 0;
    state.currentBackoff = state.intervalSeconds;
    state.lastScanTime = new Date();
    renderReport(data);
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    const preserveResults = !showLoading && state.hasReport;
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= 3) {
      state.currentBackoff = Math.min(state.currentBackoff * 2, 120);
      rescheduleAutoRefresh();
    }
    if (err.message && err.message.includes("not responding")) {
      if (!preserveResults && !preserveConnectedDuringBackgroundScan()) setStatus(false);
      if (!preserveResults) {
        state.latestReport = null;
        renderOffline();
      }
    } else if (!preserveResults) {
      state.latestReport = null;
      renderError(err.message);
    }
  } finally {
    clearTimeout(timeoutId);
    if (state.scanAbort === controller) state.scanAbort = null;
    state.scanning = false;
    state.backgroundScanning = false;
    dom.scanButton.disabled = false;
    dom.scanButton.classList.remove("scanning");
  }
}

// ── Auto-refresh ──

function startAutoRefresh() {
  stopAutoRefresh();
  state.intervalId = setInterval(() => scan({ showLoading: false }), state.currentBackoff * 1000);
}

function stopAutoRefresh() {
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  if (state.scanAbort) {
    state.scanAbort.abort();
    state.scanAbort = null;
  }
}

function rescheduleAutoRefresh() {
  if (state.autoRefresh) startAutoRefresh();
}

dom.autoRefreshToggle.addEventListener("change", () => {
  state.autoRefresh = dom.autoRefreshToggle.checked;
  if (state.autoRefresh) {
    scan({ showLoading: false });
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
});

// ── Interval pop-down slider ──

function openIntervalDropdown() {
  dom.intervalDropdown.classList.add("open");
  dom.refreshInterval.focus();
}

function closeIntervalDropdown() {
  dom.intervalDropdown.classList.remove("open");
}

function toggleIntervalDropdown() {
  if (dom.intervalDropdown.classList.contains("open")) {
    closeIntervalDropdown();
  } else {
    openIntervalDropdown();
  }
}

dom.intervalTrigger.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleIntervalDropdown();
});

dom.intervalTrigger.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleIntervalDropdown();
  }
  if (e.key === "Escape") {
    closeIntervalDropdown();
  }
});

dom.intervalDropdown.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeIntervalDropdown();
    dom.intervalTrigger.focus();
  }
});

dom.refreshInterval.addEventListener("input", () => {
  const val = dom.refreshInterval.value;
  dom.intervalTrigger.textContent = val + "s";
  dom.intervalValue.textContent = val + "s";
});

dom.refreshInterval.addEventListener("change", () => {
  const val = parseInt(dom.refreshInterval.value, 10);
  closeIntervalDropdown();
  dom.intervalTrigger.focus();
  state.intervalSeconds = val;
  state.currentBackoff = val;
  if (state.autoRefresh) rescheduleAutoRefresh();
});

document.addEventListener("click", (e) => {
  if (!dom.intervalDropdown.contains(e.target) && e.target !== dom.intervalTrigger) {
    closeIntervalDropdown();
  }
});

// ── Visibility pause ──

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAutoRefresh();
    if (state.scanAbort) {
      state.scanAbort.abort();
      state.scanAbort = null;
    }
    if (state.statusAbort) {
      state.statusAbort.abort();
      state.statusAbort = null;
    }
    activeTweens.clear();
    if (tweenFrameId) {
      cancelAnimationFrame(tweenFrameId);
      tweenFrameId = null;
    }
  } else if (state.autoRefresh) {
    state.currentBackoff = state.intervalSeconds;
    scan({ showLoading: false });
    startAutoRefresh();
  }
});

// ── UI event handlers ──

dom.results.addEventListener("click", (event) => {
  const toggle = event.target.closest(".plugin-toggle");
  if (toggle) toggle.closest(".plugin-row")?.classList.toggle("expanded");
});

dom.byChannelToggle.addEventListener("click", () => setGroupMode("channel"));
dom.byPluginToggle.addEventListener("click", () => setGroupMode("plugin"));

dom.scanButton.addEventListener("click", () => scan({ showLoading: true }));

// ── Report toolbar controls ──

let searchDebounce = null;
dom.searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.searchQuery = dom.searchInput.value;
    if (state.latestReport) updateResults(state.latestReport);
  }, 150);
});

dom.sortSelect.addEventListener("change", () => {
  state.sortKey = dom.sortSelect.value;
  if (state.latestReport) updateResults(state.latestReport);
});

dom.showAllToggle.addEventListener("change", () => {
  state.showAll = dom.showAllToggle.checked;
  if (state.latestReport) updateResults(state.latestReport);
});

dom.exportJson.addEventListener("click", exportJson);
dom.exportCsv.addEventListener("click", exportCsv);

// ── Onboarding ──

const onboarding = {
  overlay: $("onboarding"),
  recheck: $("onboardingRecheck"),
  dismiss: $("onboardingDismiss"),
  steps: {
    ableton_running: $("step-ableton"),
    abletonosc_reachable: $("step-osc"),
    handler_available: $("step-handler"),
    automation_permission: $("step-automation"),
  },
};

const ONBOARDING_DISMISSED_KEY = "latency-onboarding-dismissed";

function showOnboarding() {
  onboarding.overlay.hidden = false;
}

function hideOnboarding() {
  onboarding.overlay.hidden = true;
}

function setStepState(key, passed, skipped) {
  const el = onboarding.steps[key];
  if (!el) return;
  el.classList.remove("pass", "fail", "pending", "skip");
  if (skipped) {
    el.classList.add("skip");
  } else {
    el.classList.add(passed ? "pass" : "fail");
  }
}

function applyOnboardingResults(checks) {
  const keys = ["ableton_running", "abletonosc_reachable", "handler_available", "automation_permission"];
  let blocked = false;
  for (const key of keys) {
    if (key === "automation_permission") {
      setStepState(key, checks[key], !checks.ableton_running);
    } else if (blocked) {
      setStepState(key, false, true);
    } else {
      setStepState(key, checks[key], false);
      if (!checks[key]) blocked = true;
    }
  }
}

function setOnboardingPending() {
  Object.values(onboarding.steps).forEach((el) => {
    el.classList.remove("pass", "fail", "skip");
    el.classList.add("pending");
  });
}

async function runOnboarding() {
  onboarding.recheck.disabled = true;
  setOnboardingPending();
  try {
    const res = await fetch("/api/onboarding");
    const checks = await res.json();
    applyOnboardingResults(checks);
    if (checks.all_passed) {
      sessionStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
      setTimeout(hideOnboarding, 600);
    }
  } catch {
    Object.keys(onboarding.steps).forEach((k) => setStepState(k, false, false));
  } finally {
    onboarding.recheck.disabled = false;
  }
}

onboarding.recheck.addEventListener("click", runOnboarding);
onboarding.dismiss.addEventListener("click", () => {
  sessionStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
  hideOnboarding();
});

// ── Init ──

async function init() {
  refreshStatus();
  setInterval(refreshStatus, 5000);

  if (!sessionStorage.getItem(ONBOARDING_DISMISSED_KEY)) {
    showOnboarding();
    runOnboarding();
  }
}

init();
