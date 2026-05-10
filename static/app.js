const $ = (id) => document.getElementById(id);
const api = window.LatencyApi;
const components = window.LatencyComponents;

const dom = {
  scanButton: $("scanButton"),
  sessionInfo: $("sessionInfo"),
  statusPill: $("statusPill"),
  results: $("results"),
  scanTimestamp: $("scanTimestamp"),
  sessionSkeletons: $("sessionSkeletons"),
  timestampSkeleton: $("timestampSkeleton"),
  diagnosticsSkeletons: $("diagnosticsSkeletons"),
};

let _domDeferred = null;
function getDom() {
  if (_domDeferred) return _domDeferred;
  _domDeferred = {
    ...dom,
    totalLatencyMs: $("totalLatencyMs"),
    bufferSize: $("bufferSize"),
    sampleRate: $("sampleRate"),
    trackCount: $("trackCount"),
    totalDevices: $("totalDevices"),
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
    diagnosticsSummary: $("diagnosticsSummary"),
    diagnosticsBody: $("diagnosticsBody"),
    compareToggle: $("compareToggle"),
    sessionInfo: $("sessionInfo"),
    timestampSkeleton: $("timestampSkeleton"),
    sessionSkeletons: $("sessionSkeletons"),
    diagnosticsSkeletons: $("diagnosticsSkeletons"),
  };
  return _domDeferred;
}

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
  compare: false,
  previousReport: null,
  scanAbort: null,
  statusAbort: null,
  exportToastTimer: null,
  currentView: "scan",
  viewScrollPositions: new Map(),
  transitioning: false,
};

const activeTweens = new Map();
let tweenFrameId = null;

// ── Virtualization ──

const VIRTUAL_ROW_HEIGHT = 72;
const VIRTUAL_ROW_GAP = 12;
const VIRTUAL_BUFFER = 5;

const virtual = {
  rows: [],
  heightCache: new Map(),
  spacer: null,
  scrollTop: 0,
  viewportHeight: 0,
  active: false,
  focusedKey: null,
};

function rowY(index) {
  let y = 0;
  for (let i = 0; i < index; i++) {
    y += (virtual.heightCache.get(i) || VIRTUAL_ROW_HEIGHT) + VIRTUAL_ROW_GAP;
  }
  return y;
}

function totalHeight() {
  let h = 0;
  for (let i = 0; i < virtual.rows.length; i++) {
    h += (virtual.heightCache.get(i) || VIRTUAL_ROW_HEIGHT) + VIRTUAL_ROW_GAP;
  }
  return Math.max(0, h - VIRTUAL_ROW_GAP);
}

function setupVirtualization() {
  if (virtual.spacer) virtual.spacer.remove();
  virtual.spacer = document.createElement("div");
  virtual.spacer.className = "results-virtual-spacer";
  dom.results.appendChild(virtual.spacer);
  virtual.active = true;
}

function teardownVirtualization() {
  if (virtual.spacer) {
    virtual.spacer.remove();
    virtual.spacer = null;
  }
  virtual.active = false;
  virtual.heightCache.clear();
}

function renderVisibleRows() {
  if (!virtual.active || !virtual.rows.length) return;

  const st = dom.results.scrollTop;
  const vh = dom.results.clientHeight;
  if (st === virtual.scrollTop && vh === virtual.viewportHeight) return;
  virtual.scrollTop = st;
  virtual.viewportHeight = vh;

  const focused = dom.results.querySelector(".plugin-row:focus-within");
  if (focused) virtual.focusedKey = focused.dataset.key;

  let cumulative = 0;
  let start = 0;
  for (let i = 0; i < virtual.rows.length; i++) {
    const h = (virtual.heightCache.get(i) || VIRTUAL_ROW_HEIGHT) + VIRTUAL_ROW_GAP;
    if (cumulative + h > st) { start = Math.max(0, i - VIRTUAL_BUFFER); break; }
    cumulative += h;
  }

  cumulative = 0;
  let end = virtual.rows.length - 1;
  for (let i = 0; i < virtual.rows.length; i++) {
    const h = (virtual.heightCache.get(i) || VIRTUAL_ROW_HEIGHT) + VIRTUAL_ROW_GAP;
    if (cumulative > st + vh) { end = Math.min(virtual.rows.length - 1, i + VIRTUAL_BUFFER); break; }
    cumulative += h;
  }

  const nextKeys = new Set();
  for (let i = start; i <= end; i++) {
    const item = virtual.rows[i];
    const key = item.key;
    nextKeys.add(key);

    let row = dom.results.querySelector(`.plugin-row[data-key="${CSS.escape(key)}"]`);
    if (!row) {
      row = createPluginRow(item, virtual.maxSamples);
      row.classList.add("virtualized");
    }

    const y = rowY(i);
    row.style.top = y + "px";

    if (row._virtual_index == null || row._virtual_index !== i) {
      updatePluginRow(row, item, virtual.maxSamples);
      row._virtual_index = i;
    }

    if (row.parentNode !== dom.results) dom.results.appendChild(row);
  }

  dom.results.querySelectorAll(".plugin-row.virtualized").forEach((row) => {
    if (!nextKeys.has(row.dataset.key)) row.remove();
  });

  if (virtual.focusedKey && nextKeys.has(virtual.focusedKey)) {
    const rowToFocus = dom.results.querySelector(`.plugin-row[data-key="${CSS.escape(virtual.focusedKey)}"]`);
    if (rowToFocus) {
      const focusable = rowToFocus.querySelector(".plugin-toggle") || rowToFocus;
      focusable.focus();
    }
    virtual.focusedKey = null;
  }

  if (virtual.spacer) virtual.spacer.style.height = totalHeight() + "px";
}

function scheduleRenderVisible() {
  if (!virtual._raf) {
    virtual._raf = requestAnimationFrame(() => {
      virtual._raf = null;
      renderVisibleRows();
    });
  }
}

function onResultsScroll() {
  scheduleRenderVisible();
}

function measureRowHeight(row) {
  return row.offsetHeight || VIRTUAL_ROW_HEIGHT;
}

function refreshVirtualHeights() {
  dom.results.querySelectorAll(".plugin-row.virtualized").forEach((row) => {
    const idx = row._virtual_index;
    if (idx != null) virtual.heightCache.set(idx, measureRowHeight(row));
  });
  if (virtual.spacer) virtual.spacer.style.height = totalHeight() + "px";
}

const FLIP_DURATION = 200;
const FLIP_EASING = "ease-out";
const VIEW_TRANSITION_DURATION = 180;
const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function getRect(el) {
  return el.getBoundingClientRect();
}

function rowSortNumber(row) {
  if (hasNumericValue(row.track_number)) return Number(row.track_number);
  const match = String(row.title || "").match(/^\s*(\d+)\./);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareRowsByStableLabel(a, b) {
  const byTrack = rowSortNumber(a) - rowSortNumber(b);
  if (byTrack) return byTrack;
  return String(a.title || "").localeCompare(String(b.title || ""), undefined, { numeric: true, sensitivity: "base" });
}

function resetRowAnimation(row) {
  if (!row) return;
  if (row._flipCleanup) row._flipCleanup();
  row.style.transition = "";
  row.style.opacity = "";
  row.style.transform = "";
  row.classList.remove("flip-animating");
}

function applyFlipAnimation(row, fromRect, toRect, action) {
  if (reducedMotion) return;

  resetRowAnimation(row);
  row.classList.add("flip-animating");

  if (action === "add") {
    row.style.opacity = "0";
    row.style.transform = `translateY(12px)`;
    row.offsetHeight;
    row.style.transition = `opacity ${FLIP_DURATION}ms ${FLIP_EASING}, transform ${FLIP_DURATION}ms ${FLIP_EASING}`;
    row.style.opacity = "1";
    row.style.transform = "translateY(0)";
  } else if (action === "remove") {
    row.style.transition = `opacity ${FLIP_DURATION}ms ${FLIP_EASING}, transform ${FLIP_DURATION}ms ${FLIP_EASING}`;
    row.style.opacity = "0";
    row.style.transform = `translateY(-8px)`;
  } else if (action === "move" && fromRect && toRect) {
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
      row.classList.remove("flip-animating");
      return;
    }
    row.style.transition = "none";
    row.style.transform = `translate(${dx}px, ${dy}px)`;
    row.offsetHeight;
    row.style.transition = `transform ${FLIP_DURATION}ms ${FLIP_EASING}`;
    row.style.transform = "translate(0, 0)";
  }

  const cleanup = () => {
    row.removeEventListener("transitionend", cleanup);
    if (row._flipTimer) {
      clearTimeout(row._flipTimer);
      row._flipTimer = null;
    }
    row._flipCleanup = null;
    row.style.transition = "";
    if (action !== "remove") {
      row.style.opacity = "";
      row.style.transform = "";
    }
    row.classList.remove("flip-animating");
  };
  row._flipCleanup = cleanup;
  row.addEventListener("transitionend", cleanup);
  row._flipTimer = setTimeout(cleanup, FLIP_DURATION + 50);
}

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

var PLUGIN_NAME_ALIASES = {
  "fabfilter pro-q 3": "pro-q 3",
  "fabfilter pro-q 4": "pro-q 4",
  "fabfilter pro-q": "pro-q",
  "fabfilter pro-c 2": "pro-c 2",
  "fabfilter pro-c": "pro-c",
  "fabfilter pro-l 2": "pro-l 2",
  "fabfilter pro-l": "pro-l",
  "fabfilter pro-mb": "pro-mb",
  "fabfilter pro-ds": "pro-ds",
  "fabfilter pro-g": "pro-g",
  "fabfilter pro-r": "pro-r",
  "fabfilter saturn 2": "saturn 2",
  "fabfilter saturn": "saturn",
  "fabfilter timeless 3": "timeless 3",
  "fabfilter timeless 2": "timeless 2",
  "fabfilter timeless": "timeless",
  "fabfilter volcano 3": "volcano 3",
  "fabfilter volcano 2": "volcano 2",
  "fabfilter volcano": "volcano",
  "fabfilter twin 3": "twin 3",
  "fabfilter twin 2": "twin 2",
  "fabfilter twin": "twin",
  "fabfilter one": "one",
  "fabfilter simplon": "simplon",
  "fabfilter micro": "micro",
};

var FORMAT_RE = /\s*\((audio unit|au|vst|vst2|vst3|vst\/vst3)\)\s*$/i;
var FORMAT_BRACKET_RE = /\s*\[(audio unit|au|vst|vst2|vst3|vst\/vst3)\]\s*$/i;
var FORMAT_DASH_RE = /\s*-\s*(audio unit|au|vst|vst2|vst3|vst\/vst3)\s*$/i;
var FORMAT_SPACE_RE = /\s+(audio unit|au|vst|vst2|vst3|vst\/vst3)\s*$/i;

function stripFormat(name) {
  return name
    .replace(FORMAT_RE, "")
    .replace(FORMAT_BRACKET_RE, "")
    .replace(FORMAT_DASH_RE, "")
    .replace(FORMAT_SPACE_RE, "")
    .replace(/\s+/g, " ").trim();
}

function displayPluginName(name) {
  return stripFormat(String(name || "Unnamed Device").trim()) || "Unnamed Device";
}

function pluginKey(plugin) {
  var name = String(plugin.device_name || "Unnamed Device")
    .trim()
    .toLowerCase();

  name = name
    .replace(/\bv\d+(?:\.\d+)*\b/gi, "")
    .replace(/\b\d+(?:\.\d+)+\b/g, "")
    .replace(/\bx(?:64|86)\b/gi, "")
    .replace(/\(\d{2}-bit\)/gi, "")
    .replace(/\s*\(build\s+\d+\)/gi, "")
    .replace(/\s+/g, " ").trim();

  var formatStripped = stripFormat(name);
  if (PLUGIN_NAME_ALIASES[formatStripped]) {
    name = PLUGIN_NAME_ALIASES[formatStripped];
  }

  name = stripFormat(name);

  return name || "unnamed device";
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

const CROSSFADE_MS = 150;

function revealContent(contentEls, skeletonEls) {
  const contentArr = Array.isArray(contentEls) ? contentEls : [contentEls];
  const skeletonArr = Array.isArray(skeletonEls) ? skeletonEls : [skeletonEls];

  skeletonArr.forEach((el) => {
    if (!el) return;
    el.style.transition = `opacity ${CROSSFADE_MS}ms ease`;
    el.style.opacity = "0";
    el.addEventListener("transitionend", () => {
      el.hidden = true;
      el.style.opacity = "";
      el.style.transition = "";
    }, { once: true });
  });

  contentArr.forEach((el) => {
    if (!el) return;
    el.hidden = false;
    el.classList.add("skeleton-fade-enter");
    el.addEventListener("animationend", () => {
      el.classList.remove("skeleton-fade-enter");
    }, { once: true });
  });
}

function showSkeletons(skeletonEls, contentEls) {
  const skeletonArr = Array.isArray(skeletonEls) ? skeletonEls : [skeletonEls];
  const contentArr = Array.isArray(contentEls) ? contentEls : [contentEls];

  contentArr.forEach((el) => {
    if (!el) return;
    el.hidden = true;
  });

  skeletonArr.forEach((el) => {
    if (!el) return;
    el.hidden = false;
    el.style.opacity = "1";
  });
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
  api.localPost("/api/open-ableton", {
    signal: controller.signal,
  }).catch(() => {});
}

async function reloadOSC() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RECOVERY_TIMEOUT_MS);
  try {
    const { res } = await api.localPost("/api/reload-osc", {
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
  const name = project?.name || "No Ableton project detected";
  if (dom.sessionInfo.textContent !== name || dom.sessionInfo.hidden) {
    dom.sessionInfo.textContent = name;
    dom.sessionInfo.title = project?.path || "";
    revealContent(dom.sessionInfo, getDom().sessionSkeletons);
  }
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
  const d = getDom();
  if (d.diagnosticsSkeletons && !d.diagnosticsSkeletons.hidden) {
    revealContent(d.diagnosticsBody, d.diagnosticsSkeletons);
  }
  const stateLabel = CONNECTION_LABELS[diagnostics.state] || diagnostics.state || "Unknown";
  d.diagnosticsSummary.textContent = stateLabel;
  const candidates = diagnostics.paths?.abletonosc_candidates || [];
  const candidateRows = candidates.map((item) => `
    <div class="diagnostics-row">
      <span>AbletonOSC candidate</span>
      <code>${escapeHtml(item.path)}</code>
      <strong>${item.exists ? "Found" : "Missing"}</strong>
    </div>`).join("");
  const actions = (diagnostics.recovery_actions || []).map((action) => `<li>${escapeHtml(action)}</li>`).join("");
  d.diagnosticsBody.innerHTML = `
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
    const { data } = await api.request("/api/status", { signal: controller.signal });
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
  dom.results.className = "results loading";
  dom.results.dataset.state = "loading";
  dom.results.innerHTML = `
    <div class="skeleton skeleton-row"></div>
    <div class="skeleton skeleton-row"></div>
    <div class="skeleton skeleton-row"></div>
    <div class="skeleton skeleton-row"></div>
    <div class="skeleton skeleton-row"></div>`;
}

function renderStateCard(state, opts = {}) {
  const el = dom.results;
  el.className = "results empty";
  el.dataset.state = "";

  el.innerHTML = components.stateCard(state, opts);
}

function renderEmpty() {
  renderStateCard("empty", {
    title: "No scan yet",
    description: "Open your session in Ableton Live, then scan to detect latency-inducing devices.",
    actionsHtml: `${components.actionButton("scan", "Scan now")}
      ${components.actionButton("open-ableton", "Open Live", "secondary")}`,
  });
}

function renderOffline() {
  renderStateCard("offline", {
    title: "AbletonOSC is offline",
    description: "Make sure Ableton Live is running with AbletonOSC installed and enabled. Port 11000 must be reachable.",
    actionsHtml: `${components.actionButton("open-ableton", "Open Live")}
      ${components.actionButton("reload-osc", "Retry connection", "secondary")}`,
    childrenHtml: `<div class="recovery-secondary">
      <button class="text-link" type="button" data-action="scan">Scan anyway</button>
      <span class="secondary-hint">— only works if AbletonOSC is already running</span>
    </div>`,
  });
}

function renderError(message) {
  renderStateCard("error", {
    title: "Scan failed",
    errorMessage: message,
    actionsHtml: `${components.actionButton("scan", "Retry scan")}
      ${components.actionButton("reload-osc", "Reload AbletonOSC", "secondary")}`,
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
  if (el.hidden) {
    revealContent(el, getDom().timestampSkeleton);
  }
}

function setTotalLatencySeverity(totalLatencyMs) {
  if (!hasNumericValue(totalLatencyMs)) {
    getDom().totalLatencyMs.style.color = "";
    return false;
  }

  const latencyClass = getLatencyClass(0, Number(totalLatencyMs));
  getDom().totalLatencyMs.style.color = latencyClass === "high"
    ? "var(--red)"
    : latencyClass === "medium"
      ? "var(--amber)"
      : "var(--green)";
  return true;
}

function renderTrackDetails(instances, { nameLabel = "Track name", numberLabel = "" } = {}, previousReport = null, currentDeviceName = null) {
  let withDeltas = instances.map((inst) => ({ ...inst, track_number: trackNumber(inst) }));
  if (previousReport && currentDeviceName) {
    const prevInstanceMap = _previousInstanceMap(pluginKey({ device_name: currentDeviceName }));
    withDeltas = withDeltas.map((inst) => {
      const instKey = `${inst.device_name || ""}|${inst.track_index}`;
      const prevInst = prevInstanceMap.get(instKey);
      let deltaHtml = "";
      if (prevInst) {
        const delta = Number(inst.latency_ms || 0) - Number(prevInst.latency_ms || 0);
        if (Math.abs(delta) > 0.005) {
          const sign = delta > 0 ? "+" : "";
          const cls = delta > 0 ? "positive" : "negative";
          deltaHtml = ` <span class="delta-badge ${cls}">${sign}${delta.toFixed(2)} ms</span>`;
        }
      } else {
        deltaHtml = ` <span class="delta-badge new">new</span>`;
      }
      return { ...inst, _delta_html: deltaHtml, track_number: trackNumber(inst) };
    });
  }
  return components.trackDetails(withDeltas, { nameLabel, numberLabel, formatLatency: fmtMs });
}

function updateDashboardStats(report) {
  const d = getDom();
  const hasLatency = setTotalLatencySeverity(report.total_latency_ms);
  if (hasLatency) {
    tweenText(d.totalLatencyMs, Number(report.total_latency_ms), fmtMs);
  } else {
    stopTween(d.totalLatencyMs);
    d.totalLatencyMs.textContent = "--";
    delete d.totalLatencyMs.dataset.value;
  }
  if (hasNumericValue(report.buffer_size)) {
    tweenText(d.bufferSize, Number(report.buffer_size), (n) => String(Math.round(n)));
  } else {
    d.bufferSize.textContent = "--";
  }
  if (hasNumericValue(report.sample_rate)) {
    tweenText(d.sampleRate, Number(report.sample_rate) / 1000, (n) => (n ? `${n.toFixed(1)}k` : "--"));
  } else {
    d.sampleRate.textContent = "--";
  }
  tweenText(d.trackCount, Number(report.track_count || 0), (n) => String(Math.round(n)));
  tweenText(d.totalDevices, Number(report.device_count || 0), (n) => String(Math.round(n)));

  const anyValueVisible = hasLatency || hasNumericValue(report.buffer_size) || hasNumericValue(report.sample_rate);
  if (anyValueVisible) {
    revealContent([d.totalLatencyMs, d.bufferSize, d.sampleRate, d.trackCount, d.totalDevices], []);
  }
}

function createPluginRow(item, maxSessionSamples) {
  const row = document.createElement("article");
  row.className = "plugin-row";
  row.dataset.key = item.key;
  row.innerHTML = components.pluginRowShell();
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
  const deltaEl = row.querySelector(".delta-badge");
  const detailsEl = row.querySelector(".track-details");
  const name = item.title || "Unnamed";
  const subtitle = item.subtitle || "";
  const subtitleKind = item.subtitle_kind || "";

  if (nameEl.textContent !== name) nameEl.textContent = name;
  nameEl.title = name;
  if (subtitleKind && subtitle) {
    const subtitleHtml = `<span class="track-kind ${escapeHtml(subtitleKind)}">${escapeHtml(subtitle)}</span>`;
    if (tracksEl.innerHTML !== subtitleHtml) tracksEl.innerHTML = subtitleHtml;
  } else if (tracksEl.textContent !== subtitle) {
    tracksEl.textContent = subtitle;
  }
  tracksEl.title = subtitle;
  barEl.className = `latency-bar ${latencyClass}`;
  barEl.style.width = `${widthPercent}%`;
  latencyEl.className = `plugin-latency-val ${latencyClass}`;
  latencyNumberEl.textContent = fmtMs(item.latency_ms);

  if (deltaEl) {
    let deltaHtml = "";
    if (state.compare && state.previousReport) {
      const prevMap = _previousPluginMap();
      const key = pluginKey({ device_name: item.title });
      const prev = prevMap.get(key);
      if (prev) {
        const delta = Number(item.latency_ms) - Number(prev.max_latency_ms);
        if (Math.abs(delta) > 0.005) {
          const sign = delta > 0 ? "+" : "";
          const cls = delta > 0 ? "positive" : "negative";
          deltaEl.innerHTML = `${sign}${delta.toFixed(2)} ms`;
          deltaEl.className = `delta-badge ${cls}`;
          deltaEl.hidden = false;
        } else {
          deltaEl.hidden = true;
        }
      } else {
        deltaEl.innerHTML = "new";
        deltaEl.className = "delta-badge new";
        deltaEl.hidden = false;
      }
    } else {
      deltaEl.hidden = true;
    }
  }

  const prevReport = state.compare ? state.previousReport : null;
  const currentDeviceName = item.title;
  const detailsHtml = renderTrackDetails(item.instances || [], item.details || {}, prevReport, currentDeviceName);
  if (row._detailsHtml !== detailsHtml) {
    detailsEl.innerHTML = detailsHtml;
    row._detailsHtml = detailsHtml;
  }
}

// ── Data rows ──

function _previousPluginMap() {
  const map = new Map();
  if (state.previousReport) {
    (state.previousReport.plugins || []).forEach((p) => {
      map.set(pluginKey(p), p);
    });
  }
  return map;
}

function _previousInstanceMap(pluginNameKey) {
  const map = new Map();
  if (state.previousReport) {
    (state.previousReport.plugins || []).forEach((p) => {
      if (pluginKey(p) === pluginNameKey) {
        (p.instances || []).forEach((inst) => {
          const instKey = `${inst.device_name || ""}|${inst.track_index}`;
          map.set(instKey, inst);
        });
      }
    });
  }
  return map;
}

function _renderRemovedPlugins(currentReport) {
  if (!state.compare || !state.previousReport || !currentReport) return "";
  const currentKeys = new Set((currentReport.plugins || []).map((p) => pluginKey(p)));
  const removed = (state.previousReport.plugins || []).filter((p) => !currentKeys.has(pluginKey(p)));
  if (!removed.length) return "";

  const rows = removed
    .map((p) => {
      const name = escapeHtml(displayPluginName(p.device_name));
      const ms = fmtMs(p.max_latency_ms);
      const instances = p.instance_count || p.instances?.length || 0;
      return `<div class="removed-row">
        <span class="removed-name" title="${name}">${name}</span>
        <span class="removed-latency">${ms} ms</span>
        <span>${instances} instance${instances !== 1 ? "s" : ""}</span>
      </div>`;
    })
    .join("");

  return `<div class="removed-section">
    <details>
      <summary>${removed.length} removed since last scan</summary>
      <div class="removed-list">${rows}</div>
    </details>
  </div>`;
}

function pluginRows(report) {
  const source = state.showAll ? (report.plugins || []) : (report.top_plugins || []);
  return source.map((plugin) => ({
    key: `plugin:${pluginKey(plugin)}`,
    title: displayPluginName(plugin.device_name),
    subtitle: (plugin.tracks || []).join(", "),
    latency_samples: Number(plugin.max_latency_samples || 0),
    latency_ms: Number(plugin.max_latency_ms || 0),
    instance_count: plugin.instance_count || (plugin.instances || []).length,
    impact_score: Number(plugin.impact_score || 0),
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
      detail_name: displayPluginName(deviceName),
      detail_number: device.format || device.class_name || "--",
    });
    groups.set(key, group);
  });

  return [...groups.values()].map((group) => ({
    key: group.key,
    title: group.track_number === "--" ? group.title : `${group.track_number}. ${group.title}`,
    subtitle: group.track_kind_label,
    subtitle_kind: group.track_kind,
    latency_samples: group.latency_samples,
    latency_ms: group.latency_ms,
    instance_count: group.devices.length,
    impact_score: Math.round(group.latency_ms * group.devices.length * 1000) / 1000,
    instances: group.devices,
    details: { nameLabel: "Plug-in", showTrackKind: false },
  }));
}

// ── Filter & sort ──

function sortRows(rows) {
  const key = state.sortKey;
  return rows.slice().sort((a, b) => {
    switch (key) {
      case "latency-asc":
        return a.latency_samples - b.latency_samples || a.latency_ms - b.latency_ms || compareRowsByStableLabel(a, b);
      case "instances-desc":
        return (b.instance_count || 0) - (a.instance_count || 0) || b.latency_samples - a.latency_samples || compareRowsByStableLabel(a, b);
      default:
        return b.latency_samples - a.latency_samples || b.latency_ms - a.latency_ms || compareRowsByStableLabel(a, b);
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
  const d = getDom();
  if (shown === total) {
    d.rowCount.textContent = `${total} items`;
  } else {
    d.rowCount.textContent = `${shown} / ${total}`;
  }
}

// ── Results rendering ──

function updateResults(report) {
  const total = totalRowCount(report);
  const rows = currentRows(report);
  const rowKeys = rows.map((row) => row.key).join("\n");

  updateRowCount(rows.length, total);

  if (dom.results.dataset.state === "loading") {
    dom.results.className = "results";
    dom.results.dataset.state = "";
    dom.results.innerHTML = "";
  }

  if (!total) {
    teardownVirtualization();
    renderStateCard("success", {
      title: "No latency-inducing devices detected",
      description: "AbletonOSC responded, but the current set reported no plugin latency.",
      actionsHtml: components.actionButton("scan", "Rescan", "secondary"),
    });
    return;
  }

  if (!rows.length) {
    teardownVirtualization();
    renderStateCard("empty", {
      title: `No matches for \u201C${escapeHtml(state.searchQuery)}\u201D`,
    });
    return;
  }

  const maxSessionSamples = Math.max(...rows.map((item) => item.latency_samples), 1);

  if (rows.length > 50) {
    const preserveScroll = virtual.active && virtual.rowKeys === rowKeys;
    virtual.rows = rows;
    virtual.maxSamples = maxSessionSamples;
    virtual.rowKeys = rowKeys;
    if (!preserveScroll) {
      virtual.heightCache.clear();
      dom.results.scrollTop = 0;
      virtual.scrollTop = 0;
      virtual.viewportHeight = 0;
    }
    dom.results.className = "results virtualized";
    if (!virtual.active) setupVirtualization();
    if (preserveScroll) {
      dom.results.querySelectorAll(".plugin-row.virtualized").forEach((row) => {
        const index = virtual.rows.findIndex((item) => item.key === row.dataset.key);
        if (index >= 0) {
          updatePluginRow(row, virtual.rows[index], maxSessionSamples);
          row._virtual_index = index;
        }
      });
      if (virtual.spacer) virtual.spacer.style.height = totalHeight() + "px";
    } else {
      renderVisibleRows();
    }
    renderVisibleRows();
  } else {
    teardownVirtualization();
    dom.results.className = "results";
    const rowsByKey = new Map(
      [...dom.results.querySelectorAll(".plugin-row")].map((row) => [row.dataset.key, row])
    );
    const nextKeys = new Set();
    const prevRects = new Map();

    rowsByKey.forEach((row, key) => {
      resetRowAnimation(row);
      prevRects.set(key, getRect(row));
    });

    [...dom.results.children].forEach((child) => {
      if (!child.classList.contains("plugin-row")) child.remove();
    });

    const fragment = document.createDocumentFragment();
    const rowsToInsert = [];

    rows.forEach((item, index) => {
      const key = item.key;
      let row = rowsByKey.get(key);
      nextKeys.add(key);

      if (row) {
        updatePluginRow(row, item, maxSessionSamples);
      } else {
        row = createPluginRow(item, maxSessionSamples);
        rowsToInsert.push({ row, key });
      }

      fragment.appendChild(row);
    });

    dom.results.appendChild(fragment);

    rowsToInsert.forEach(({ row }) => {
      applyFlipAnimation(row, null, getRect(row), "add");
    });

    rows.forEach((item, index) => {
      const key = item.key;
      const row = dom.results.children[index];
      if (prevRects.has(key) && !rowsToInsert.find(r => r.key === key)) {
        const prevRect = prevRects.get(key);
        const nextRect = getRect(row);
        applyFlipAnimation(row, prevRect, nextRect, "move");
      }
    });

    rowsByKey.forEach((row, key) => {
      if (!nextKeys.has(key)) {
        resetRowAnimation(row);
        row.remove();
      }
    });
  }

  const removedHtml = _renderRemovedPlugins(report);
  if (removedHtml) {
    dom.results.insertAdjacentHTML("beforeend", removedHtml);
  }
}

function renderReport(report) {
  state.latestReport = report;
  updateDashboardStats(report);
  updateResults(report);
  state.hasReport = true;
  getDom().reportToolbar.hidden = false;
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
  const el = getDom().exportToast;
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
      impact_score: r.impact_score || 0,
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
  const d = getDom();
  d.byChannelToggle.classList.toggle("active", mode === "channel");
  d.byPluginToggle.classList.toggle("active", mode === "plugin");
  d.byChannelToggle.setAttribute("aria-pressed", String(mode === "channel"));
  d.byPluginToggle.setAttribute("aria-pressed", String(mode === "plugin"));
  d.searchInput.placeholder =
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
    const prevRes = await fetch("/api/last-scan");
    const prevData = await prevRes.json();
    state.previousReport = prevData.report || null;
  } catch {
    state.previousReport = null;
  }

  try {
    const { res, data } = await api.localPost("/api/scan", {
      signal: controller.signal,
    });

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

function bindDeferredEvents() {
  const d = getDom();

  d.autoRefreshToggle.addEventListener("change", () => {
    state.autoRefresh = d.autoRefreshToggle.checked;
    if (state.autoRefresh) {
      scan({ showLoading: false });
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  });

  d.intervalTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleIntervalDropdown();
  });

  d.intervalTrigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleIntervalDropdown();
    }
    if (e.key === "Escape") {
      closeIntervalDropdown();
    }
  });

  d.intervalDropdown.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeIntervalDropdown();
      d.intervalTrigger.focus();
    }
  });

  d.intervalDropdown.addEventListener("click", (e) => {
    const option = e.target.closest(".interval-option");
    if (!option) return;
    const val = parseInt(option.dataset.value, 10);
    d.intervalDropdown.querySelectorAll(".interval-option").forEach((btn) => {
      btn.classList.toggle("active", btn === option);
    });
    d.intervalTrigger.textContent = val + "s";
    state.intervalSeconds = val;
    state.currentBackoff = val;
    closeIntervalDropdown();
    d.intervalTrigger.focus();
    if (state.autoRefresh) rescheduleAutoRefresh();
  });

  d.byChannelToggle.addEventListener("click", () => setGroupMode("channel"));
  d.byPluginToggle.addEventListener("click", () => setGroupMode("plugin"));

  let searchDebounce = null;
  d.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.searchQuery = d.searchInput.value;
      if (state.latestReport) updateResults(state.latestReport);
    }, 150);
  });

  d.sortSelect.addEventListener("change", () => {
    state.sortKey = d.sortSelect.value;
    if (state.latestReport) updateResults(state.latestReport);
  });

  d.showAllToggle.addEventListener("change", () => {
    state.showAll = d.showAllToggle.checked;
    if (state.latestReport) updateResults(state.latestReport);
  });

  d.compareToggle.addEventListener("change", () => {
    state.compare = d.compareToggle.checked;
    if (state.latestReport) updateResults(state.latestReport);
  });

  d.exportJson.addEventListener("click", exportJson);
  d.exportCsv.addEventListener("click", exportCsv);
}

function openIntervalDropdown() {
  const d = getDom();
  d.intervalDropdown.classList.add("open");
  const active = d.intervalDropdown.querySelector(".interval-option.active") || d.intervalDropdown.querySelector(".interval-option");
  if (active) active.focus();
}

function closeIntervalDropdown() {
  getDom().intervalDropdown.classList.remove("open");
}

function toggleIntervalDropdown() {
  const d = getDom();
  if (d.intervalDropdown.classList.contains("open")) {
    closeIntervalDropdown();
  } else {
    openIntervalDropdown();
  }
}

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

  const d = getDom();
  if (!d.intervalDropdown.contains(e.target) && e.target !== d.intervalTrigger) {
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
    if (row) {
      toggleRow(row);
      if (virtual.active) {
        requestAnimationFrame(() => refreshVirtualHeights());
      }
    }
    return;
  }

  const main = event.target.closest(".plugin-main");
  if (main) {
    const row = main.closest(".plugin-row");
    if (row) {
      toggleRow(row);
      if (virtual.active) {
        requestAnimationFrame(() => refreshVirtualHeights());
      }
    }
  }
});

dom.results.addEventListener("scroll", onResultsScroll, { passive: true });

dom.results.addEventListener("keydown", (e) => {
  if (!virtual.active) return;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;

  const focused = dom.results.querySelector(".plugin-row:focus-within, .plugin-row:focus");
  if (!focused) return;

  e.preventDefault();
  const currentKey = focused.dataset.key;
  let currentIndex = virtual.rows.findIndex((r) => r.key === currentKey);
  if (currentIndex < 0) return;

  const nextIndex = e.key === "ArrowDown"
    ? Math.min(currentIndex + 1, virtual.rows.length - 1)
    : Math.max(currentIndex - 1, 0);

  if (nextIndex === currentIndex) return;

  const nextRow = dom.results.querySelector(`.plugin-row[data-key="${CSS.escape(virtual.rows[nextIndex].key)}"]`);
  if (!nextRow) {
    dom.results.scrollTop = rowY(nextIndex);
    requestAnimationFrame(() => {
      const rendered = dom.results.querySelector(`.plugin-row[data-key="${CSS.escape(virtual.rows[nextIndex].key)}"]`);
      if (rendered) {
        const toggle = rendered.querySelector(".plugin-toggle");
        if (toggle) toggle.focus();
      }
    });
  } else {
    const toggle = nextRow.querySelector(".plugin-toggle");
    if (toggle) toggle.focus();
  }
});

dom.scanButton.addEventListener("click", () => scan({ showLoading: true }));

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
  const d = getDom();
  if ("inert" in HTMLElement.prototype) {
    if (d.shell) d.shell.inert = true;
  } else {
    if (d.shell) {
      d.shell.setAttribute("aria-hidden", "true");
      d.shell._prevTabIndices = [];
      getFocusableElements(d.shell).forEach((el) => {
        d.shell._prevTabIndices.push({ el, tabIndex: el.tabIndex });
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
  const d = getDom();
  if ("inert" in HTMLElement.prototype) {
    if (d.shell) d.shell.inert = false;
  } else {
    if (d.shell) {
      d.shell.removeAttribute("aria-hidden");
      if (d.shell._prevTabIndices) {
        d.shell._prevTabIndices.forEach(({ el, tabIndex }) => {
          el.tabIndex = tabIndex;
        });
        delete d.shell._prevTabIndices;
      }
    }
  }
  const target = returnFocusTo || dom.scanButton || getFocusableElements(d.shell)[0];
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
    const { data: checks } = await api.request("/api/onboarding");
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

function saveScrollPosition(view) {
  state.viewScrollPositions.set(view, window.scrollY);
}

function restoreScrollPosition(view) {
  const y = state.viewScrollPositions.get(view);
  if (y !== undefined) {
    window.scrollTo(0, y);
  }
}

function setAppView(view) {
  if (view === state.currentView || state.transitioning) return;

  const prevView = state.currentView;
  saveScrollPosition(prevView);

  document.querySelectorAll(".app-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });

  const prevSection = document.querySelector(`.app-section[data-view="${prevView}"]`);
  const nextSection = document.querySelector(`.app-section[data-view="${view}"]`);

  if (!prevSection || !nextSection) {
    state.currentView = view;
    document.querySelectorAll(".app-section").forEach((section) => {
      section.hidden = section.dataset.view !== view;
    });
    restoreScrollPosition(view);
    return;
  }

  state.transitioning = true;

  prevSection.removeAttribute("hidden");
  prevSection.classList.add("transitioning-out");

  nextSection.removeAttribute("hidden");
  nextSection.classList.add("transitioning-in");

  const duration = reducedMotion ? 0 : VIEW_TRANSITION_DURATION;

  const cleanup = () => {
    prevSection.classList.remove("transitioning-out");
    prevSection.hidden = true;
    nextSection.classList.remove("transitioning-in");
    state.transitioning = false;
    state.currentView = view;
    restoreScrollPosition(view);
  };

  if (duration === 0) {
    cleanup();
    return;
  }

  prevSection.addEventListener("animationend", cleanup, { once: true });
  setTimeout(cleanup, duration + 50);
}

document.querySelector(".app-nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".app-nav-btn");
  if (!btn) return;
  setAppView(btn.dataset.view);
});

// ── Init ──

async function init() {
  bindDeferredEvents();
  refreshStatus();
  setInterval(refreshStatus, 5000);
  updateScanTimestamp();
  setInterval(updateScanTimestamp, 10000);

  if (isOnboardingDismissed()) {
    scan({ showLoading: true });
    return;
  }

  let checks = null;
  try {
    const { data } = await api.request("/api/onboarding");
    checks = data;
    applyOnboardingResults(checks);
  } catch {}

  if (checks?.all_passed) {
    persistOnboardingDismissal();
    scan({ showLoading: true });
  } else {
    showOnboarding();
    if (!checks) runOnboarding();
  }
}

const scheduleInit = typeof requestIdleCallback === "function"
  ? (cb) => requestIdleCallback(cb, { timeout: 1000 })
  : (cb) => setTimeout(cb, 1);

scheduleInit(() => init());
