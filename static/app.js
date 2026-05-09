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
  intervalTrigger: $("intervalTrigger"),
  intervalDropdown: $("intervalDropdown"),
  byChannelToggle: $("byChannelToggle"),
  byPluginToggle: $("byPluginToggle"),
  reportToolbar: $("reportToolbar"),
  searchInput: $("searchInput"),
  sortSelect: $("sortSelect"),
  showAllToggle: $("showAllToggle"),
  rowCount: $("rowCount"),
  exportJson: $("exportJson"),
  exportCsv: $("exportCsv"),
  exportToast: $("exportToast"),
  shell: document.querySelector(".app-shell"),
  scanTimestamp: $("scanTimestamp"),
  diagnosticsSummary: $("diagnosticsSummary"),
  diagnosticsBody: $("diagnosticsBody"),
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
  diagnostics: null,
  connectionState: "checking",
  searchQuery: "",
  sortKey: "latency-desc",
  showAll: false,
  scanAbort: null,
  statusAbort: null,
  exportToastTimer: null,
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

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.disabled && el.offsetParent !== null);
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

function trackKindLabel(value) {
  switch (value) {
    case "audio":
      return "Audio track";
    case "group":
      return "Group";
    case "instrument":
      return "Instrument track";
    case "return":
      return "Return track";
    default:
      return "Unknown track";
  }
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

const CONNECTION_LABELS = {
  checking: "Checking",
  ready: "Connected",
  live_closed: "Live closed",
  abletonosc_missing: "AbletonOSC missing",
  response_port_conflict: "Port conflict",
  latency_handler_missing: "Handler missing",
  automation_permission_missing: "Automation missing",
  scan_failed: "Scan failed",
};

function statusClass(connectionState) {
  if (connectionState === "ready") return "online";
  if (connectionState === "checking") return "";
  if (connectionState === "automation_permission_missing" || connectionState === "latency_handler_missing") return "warning";
  return "offline";
}

function setStatus(connectionStateOrOnline) {
  const connectionState = typeof connectionStateOrOnline === "boolean"
    ? (connectionStateOrOnline ? "ready" : "abletonosc_missing")
    : (connectionStateOrOnline || "checking");
  state.connectionState = connectionState;
  state.online = connectionState === "ready";
  if (state.scanning) return;
  const cls = statusClass(connectionState);
  const label = CONNECTION_LABELS[connectionState] || "Offline";

  dom.statusPill.className = `status-pill ${cls}`.trim();
  dom.statusPill.querySelector(".status-text").textContent = label;
}

function setScanningPill(active, background = false) {
  if (!active) {
    dom.statusPill.classList.remove("scanning", "scanning-bg");
    return;
  }
  if (background) {
    dom.statusPill.classList.add("scanning-bg");
  } else {
    dom.statusPill.classList.add("scanning");
    dom.statusPill.querySelector(".status-text").textContent = "Scanning…";
  }
}

function setCurrentProject(project) {
  dom.sessionInfo.textContent = project?.name || "No Ableton project detected";
  dom.sessionInfo.title = project?.path || "";
}

function diagnosticsValue(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === null || value === undefined || value === "") return "--";
  return String(value);
}

function renderDiagnostics(diagnostics) {
  state.diagnostics = diagnostics;
  if (!diagnostics) return;
  const stateLabel = CONNECTION_LABELS[diagnostics.state] || diagnostics.state || "Unknown";
  dom.diagnosticsSummary.textContent = stateLabel;
  const candidates = diagnostics.paths?.abletonosc_candidates || [];
  const candidateRows = candidates.map((item) => `
    <div class="diagnostics-row">
      <span>AbletonOSC candidate</span>
      <code>${escapeHtml(item.path)}</code>
      <strong>${item.exists ? "Found" : "Missing"}</strong>
    </div>`).join("");
  const actions = (diagnostics.recovery_actions || []).map((action) => `<li>${escapeHtml(action)}</li>`).join("");
  dom.diagnosticsBody.innerHTML = `
    <div class="diagnostics-grid">
      <div class="diagnostics-row"><span>State</span><code>${escapeHtml(stateLabel)}</code></div>
      <div class="diagnostics-row"><span>Live running</span><code>${diagnosticsValue(diagnostics.checks?.live_running)}</code></div>
      <div class="diagnostics-row"><span>AbletonOSC online</span><code>${diagnosticsValue(diagnostics.checks?.abletonosc_online)}</code></div>
      <div class="diagnostics-row"><span>Latency handler</span><code>${diagnosticsValue(diagnostics.checks?.latency_handler_available)}</code></div>
      <div class="diagnostics-row"><span>Automation permission</span><code>${diagnosticsValue(diagnostics.permissions?.automation)}</code></div>
      <div class="diagnostics-row"><span>AbletonOSC port</span><code>${escapeHtml(diagnostics.ports?.abletonosc_host || "127.0.0.1")}:${escapeHtml(diagnostics.ports?.abletonosc_port ?? "--")}</code></div>
      <div class="diagnostics-row"><span>Response port</span><code>${escapeHtml(diagnostics.ports?.response_port ?? "--")}</code></div>
      <div class="diagnostics-row"><span>Current project</span><code>${escapeHtml(diagnostics.paths?.current_project || "--")}</code></div>
      <div class="diagnostics-row"><span>Default report</span><code>${escapeHtml(diagnostics.paths?.default_report || "--")}</code></div>
      <div class="diagnostics-row"><span>Cached report</span><code>${escapeHtml(diagnostics.paths?.cached_report || "--")}</code></div>
      ${candidateRows}
    </div>
    <div class="diagnostics-actions">
      <strong>Recovery actions</strong>
      <ul>${actions}</ul>
    </div>`;
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
    if (data.connection_state === "ready" || !preserveConnectedDuringBackgroundScan()) {
      setStatus(data.connection_state || data.abletonosc_online);
    }
    renderDiagnostics(data.diagnostics);
    setCurrentProject(data.current_project);
    if (!state.lastScanTime && data.last_scan_time) {
      state.lastScanTime = new Date(data.last_scan_time);
      updateScanTimestamp();
    }
    if (!state.latestReport && data.cached_report) {
      renderReport(data.cached_report);
    }
  } catch {
    if (!preserveConnectedDuringBackgroundScan()) setStatus("scan_failed");
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

function renderStateCard(state, opts = {}) {
  const el = dom.results;
  el.className = "results empty";

  const hasIcon = ["empty", "offline", "error", "success"].includes(state);

  let html = `<div class="state-card" data-state="${escapeHtml(state)}">`;
  if (hasIcon) html += `<div class="state-card__icon"></div>`;
  if (opts.title) html += `<h2 class="state-card__title">${escapeHtml(opts.title)}</h2>`;
  if (opts.description) html += `<p class="state-card__description">${escapeHtml(opts.description)}</p>`;
  if (opts.errorMessage) html += `<div class="state-card__error">${escapeHtml(opts.errorMessage)}</div>`;
  if (opts.actionsHtml) html += `<div class="state-card__actions">${opts.actionsHtml}</div>`;
  if (opts.childrenHtml) html += opts.childrenHtml;
  html += `</div>`;

  el.innerHTML = html;
}

function renderEmpty() {
  renderStateCard("empty", {
    title: "No scan yet",
    description: "Open your session in Ableton Live, then scan to detect latency-inducing devices.",
    actionsHtml: `<button class="recovery-btn" onclick="scan({showLoading:true})">Scan now</button>
      <button class="recovery-btn secondary" onclick="openAbleton()">Open Live</button>`,
  });
}

function renderOffline() {
  renderStateCard("offline", {
    title: "AbletonOSC is offline",
    description: "Make sure Ableton Live is running with AbletonOSC installed and enabled. Port 11000 must be reachable.",
    actionsHtml: `<button class="recovery-btn" onclick="openAbleton()">Open Live</button>
      <button class="recovery-btn secondary" onclick="reloadOSC()">Retry connection</button>`,
    childrenHtml: `<div class="recovery-secondary">
      <button class="text-link" onclick="scan({showLoading:true})">Scan anyway</button>
      <span class="secondary-hint">— only works if AbletonOSC is already running</span>
    </div>`,
  });
}

function renderError(message) {
  renderStateCard("error", {
    title: "Scan failed",
    errorMessage: message,
    actionsHtml: `<button class="recovery-btn" onclick="scan({showLoading:true})">Retry scan</button>
      <button class="recovery-btn secondary" onclick="reloadOSC()">Reload AbletonOSC</button>`,
  });
}

function getLatencyClass(samples, ms) {
  const latencyMs = ms || (samples / 48);
  if (latencyMs < 20) return "low";
  if (latencyMs > 100) return "high";
  return "medium";
}

function updateScanTimestamp() {
  const el = dom.scanTimestamp;
  if (!state.lastScanTime) {
    el.textContent = "Not scanned yet";
    return;
  }
  const now = Date.now();
  const diffSec = Math.floor((now - state.lastScanTime.getTime()) / 1000);
  let label;
  if (diffSec < 5) {
    label = "Just now";
  } else if (diffSec < 60) {
    label = `${diffSec}s ago`;
  } else if (diffSec < 3600) {
    label = `${Math.floor(diffSec / 60)}m ago`;
  } else if (diffSec < 86400) {
    label = `${Math.floor(diffSec / 3600)}h ago`;
  } else {
    label = `${Math.floor(diffSec / 86400)}d ago`;
  }
  el.innerHTML = `Scanned <time datetime="${state.lastScanTime.toISOString()}">${label}</time>`;
}

function setTotalLatencySeverity(totalLatencyMs) {
  if (!hasNumericValue(totalLatencyMs)) {
    dom.totalLatencyMs.style.color = "";
    return false;
  }

  const latencyClass = getLatencyClass(0, Number(totalLatencyMs));
  dom.totalLatencyMs.style.color = latencyClass === "high"
    ? "var(--red)"
    : latencyClass === "medium"
      ? "var(--amber)"
      : "var(--green)";
  return true;
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
  if (setTotalLatencySeverity(report.total_latency_ms)) {
    tweenText(dom.totalLatencyMs, Number(report.total_latency_ms), fmtMs);
  } else {
    stopTween(dom.totalLatencyMs);
    dom.totalLatencyMs.textContent = "--";
    delete dom.totalLatencyMs.dataset.value;
  }
  if (hasNumericValue(report.buffer_size)) {
    tweenText(dom.bufferSize, Number(report.buffer_size), (n) => String(Math.round(n)));
  } else {
    dom.bufferSize.textContent = "--";
  }
  if (hasNumericValue(report.sample_rate)) {
    tweenText(dom.sampleRate, Number(report.sample_rate) / 1000, (n) => (n ? `${n.toFixed(1)}k` : "--"));
  } else {
    dom.sampleRate.textContent = "--";
  }
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
        <span class="latency-number"></span> <span class="latency-unit">ms</span>
      </div>
      <button class="plugin-toggle" type="button" aria-label="Toggle details" aria-expanded="false">
        <span class="icon-chevron" aria-hidden="true"></span>
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

function channelRows(report) {
  const tracksByIndex = new Map((report.tracks || []).map((track) => [track.index, track]));
  const groups = new Map();
  (report.devices || []).forEach((device) => {
    const number = trackNumber(device);
    const name = device.track_name || "Unnamed Track";
    const track = tracksByIndex.get(device.track_index) || {};
    const key = `channel:${hasNumericValue(device.track_index) ? device.track_index : name}`;
    const group = groups.get(key) || {
      key,
      title: name,
      track_number: number,
      track_kind: track.track_kind || device.track_kind || "unknown",
      track_kind_label: track.track_kind_label || device.track_kind_label || trackKindLabel(track.track_kind || device.track_kind || "unknown"),
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
    subtitle: group.track_kind_label,
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
  if (state.groupMode === "channel") {
    const keys = new Set();
    (report.devices || []).forEach((d) => {
      const key = hasNumericValue(d.track_index) ? d.track_index : (d.track_name || "");
      keys.add(key);
    });
    return keys.size;
  }
  return (report.plugins || []).length;
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
    renderStateCard("success", {
      title: "No latency-inducing devices detected",
      description: "AbletonOSC responded, but the current set reported no plugin latency.",
      actionsHtml: `<button class="recovery-btn secondary" onclick="scan({showLoading:true})">Rescan</button>`,
    });
    return;
  }

  if (!rows.length) {
    renderStateCard("empty", {
      title: `No matches for \u201C${escapeHtml(state.searchQuery)}\u201D`,
    });
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

function showExportToast(msg) {
  clearTimeout(state.exportToastTimer);
  const el = dom.exportToast;
  el.textContent = '';
  el.classList.remove('visible');

  state.exportToastTimer = setTimeout(() => {
    el.textContent = msg;
    el.classList.add('visible');

    const dismiss = () => {
      el.classList.remove('visible');
      el.textContent = '';
      clearTimeout(state.exportToastTimer);
      state.exportToastTimer = null;
    };

    document.addEventListener('click', dismiss, { once: true });
    document.addEventListener('keydown', dismiss, { once: true });

    state.exportToastTimer = setTimeout(dismiss, 2000);
  }, 50);
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
  showExportToast("JSON exported");
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
  showExportToast("CSV exported");
}

// ── Group mode ──

function setGroupMode(mode) {
  if (state.groupMode === mode) return;
  state.groupMode = mode;
  dom.byChannelToggle.classList.toggle("active", mode === "channel");
  dom.byPluginToggle.classList.toggle("active", mode === "plugin");
  dom.byChannelToggle.setAttribute("aria-pressed", String(mode === "channel"));
  dom.byPluginToggle.setAttribute("aria-pressed", String(mode === "plugin"));
  dom.searchInput.placeholder =
    mode === "channel" ? "Filter by track or plug-in\u2026" : "Filter by plug-in name\u2026";
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
  if (showLoading && !state.hasReport) renderLoading();
  setScanningPill(true, !showLoading);

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
      const error = new Error(data.error || "Scan failed");
      error.payload = data;
      throw error;
    }

    setStatus(true);
    state.consecutiveFailures = 0;
    state.currentBackoff = state.intervalSeconds;
    state.lastScanTime = new Date();
    updateScanTimestamp();
    renderReport(data);
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    const payload = err.payload || {};
    if (payload.diagnostics) renderDiagnostics(payload.diagnostics);
    if (payload.cached_report) renderReport(payload.cached_report);
    const preserveResults = state.hasReport || Boolean(payload.cached_report);
    setStatus(payload.connection_state || "scan_failed");
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
      renderError(err.message, CONNECTION_LABELS[payload.connection_state] || "Scan failed");
    }
  } finally {
    clearTimeout(timeoutId);
    if (state.scanAbort === controller) state.scanAbort = null;
    state.scanning = false;
    state.backgroundScanning = false;
    setScanningPill(false);
    setStatus(state.connectionState);
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
  const active = dom.intervalDropdown.querySelector(".interval-option.active") || dom.intervalDropdown.querySelector(".interval-option");
  if (active) active.focus();
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

dom.intervalDropdown.addEventListener("click", (e) => {
  const option = e.target.closest(".interval-option");
  if (!option) return;
  const val = parseInt(option.dataset.value, 10);
  dom.intervalDropdown.querySelectorAll(".interval-option").forEach((btn) => {
    btn.classList.toggle("active", btn === option);
  });
  dom.intervalTrigger.textContent = val + "s";
  state.intervalSeconds = val;
  state.currentBackoff = val;
  closeIntervalDropdown();
  dom.intervalTrigger.focus();
  if (state.autoRefresh) rescheduleAutoRefresh();
});

document.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]");
  if (action) {
    switch (action.dataset.action) {
      case "scan":
        scan({ showLoading: true });
        break;
      case "open-ableton":
        openAbleton();
        break;
      case "reload-osc":
        reloadOSC();
        break;
    }
    return;
  }

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

function toggleRow(row) {
  const expanded = row.classList.toggle("expanded");
  const toggleBtn = row.querySelector(".plugin-toggle");
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", String(expanded));
}

dom.results.addEventListener("click", (event) => {
  const toggle = event.target.closest(".plugin-toggle");
  if (toggle) {
    const row = toggle.closest(".plugin-row");
    if (row) toggleRow(row);
    return;
  }

  const main = event.target.closest(".plugin-main");
  if (main) {
    const row = main.closest(".plugin-row");
    if (row) toggleRow(row);
  }
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
  doNotShow: $("onboardingDoNotShow"),
  steps: {
    ableton_running: $("step-ableton"),
    abletonosc_reachable: $("step-osc"),
    handler_available: $("step-handler"),
    automation_permission: $("step-automation"),
  },
};

const ONBOARDING_DISMISSED_KEY = "latency-onboarding-dismissed";
const ONBOARDING_SESSION_DISMISSED_KEY = "latency-onboarding-dismissed-session";

function showOnboarding() {
  onboarding.overlay.hidden = false;
  onboarding.overlay.setAttribute("aria-modal", "true");
  if ("inert" in HTMLElement.prototype) {
    if (dom.shell) dom.shell.inert = true;
  } else {
    if (dom.shell) {
      dom.shell.setAttribute("aria-hidden", "true");
      dom.shell._prevTabIndices = [];
      getFocusableElements(dom.shell).forEach((el) => {
        dom.shell._prevTabIndices.push({ el, tabIndex: el.tabIndex });
        el.tabIndex = -1;
      });
    }
  }
  const focusables = getFocusableElements(onboarding.overlay);
  if (focusables.length > 0) {
    focusables[0].focus();
  }
}

function hideOnboarding(returnFocusTo) {
  onboarding.overlay.hidden = true;
  onboarding.overlay.removeAttribute("aria-modal");
  if ("inert" in HTMLElement.prototype) {
    if (dom.shell) dom.shell.inert = false;
  } else {
    if (dom.shell) {
      dom.shell.removeAttribute("aria-hidden");
      if (dom.shell._prevTabIndices) {
        dom.shell._prevTabIndices.forEach(({ el, tabIndex }) => {
          el.tabIndex = tabIndex;
        });
        delete dom.shell._prevTabIndices;
      }
    }
  }
  const target = returnFocusTo || dom.scanButton || getFocusableElements(dom.shell)[0];
  target?.focus();
}

function isOnboardingDismissed() {
  return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1" || sessionStorage.getItem(ONBOARDING_SESSION_DISMISSED_KEY) === "1";
}

function persistOnboardingDismissal() {
  if (onboarding.doNotShow.checked) {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    sessionStorage.removeItem(ONBOARDING_SESSION_DISMISSED_KEY);
  } else {
    sessionStorage.setItem(ONBOARDING_SESSION_DISMISSED_KEY, "1");
  }
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
      persistOnboardingDismissal();
      setTimeout(() => {
        hideOnboarding(dom.scanButton);
        scan({ showLoading: true });
      }, 600);
    }
  } catch {
    Object.keys(onboarding.steps).forEach((k) => setStepState(k, false, false));
  } finally {
    onboarding.recheck.disabled = false;
  }
}

onboarding.recheck.addEventListener("click", runOnboarding);
onboarding.dismiss.addEventListener("click", () => {
  persistOnboardingDismissal();
  hideOnboarding();
});

function handleOnboardingKeydown(e) {
  if (onboarding.overlay.hidden) return;

  if (e.key === "Escape") {
    e.preventDefault();
    persistOnboardingDismissal();
    hideOnboarding();
    return;
  }

  if (e.key === "Tab") {
    const focusables = getFocusableElements(onboarding.overlay);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

onboarding.overlay.addEventListener("keydown", handleOnboardingKeydown);

onboarding.overlay.addEventListener("focusout", (e) => {
  if (onboarding.overlay.hidden) return;
  if (!onboarding.overlay.contains(e.relatedTarget)) {
    const focusables = getFocusableElements(onboarding.overlay);
    if (focusables.length > 0) {
      focusables[0].focus();
    }
  }
});

// ── App Navigation ──

function setAppView(view) {
  document.querySelectorAll(".app-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.querySelectorAll(".app-section").forEach((section) => {
    section.hidden = section.dataset.view !== view;
  });
}

document.querySelector(".app-nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".app-nav-btn");
  if (!btn) return;
  setAppView(btn.dataset.view);
});

// ── Init ──

async function init() {
  refreshStatus();
  setInterval(refreshStatus, 5000);
  updateScanTimestamp();
  setInterval(updateScanTimestamp, 10000);

  if (isOnboardingDismissed()) {
    scan({ showLoading: true });
    return;
  }

  // Run checks silently; only show the onboarding modal if something is wrong.
  let checks = null;
  try {
    const res = await fetch("/api/onboarding");
    checks = await res.json();
    applyOnboardingResults(checks);
  } catch {
    // Network error — fall through to show onboarding.
  }

  if (checks?.all_passed) {
    persistOnboardingDismissal();
    scan({ showLoading: true });
  } else {
    showOnboarding();
    // Checks already applied above if we got a response; re-run only on network error.
    if (!checks) runOnboarding();
  }
}

init();
