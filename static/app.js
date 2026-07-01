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
  statusBanner: $("statusBanner"),
};

let _domDeferred = null;
function getDom() {
  if (_domDeferred) return _domDeferred;
  _domDeferred = {
    ...dom,
    totalLatencyMs: $("totalLatencyMs"),
    cumulativeLatencyMs: $("cumulativeLatencyMs"),
    bottleneckTrack: $("bottleneckTrack"),
    latencySkeleton: $("latencySkeleton"),
    bufferSkeleton: $("bufferSkeleton"),
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
    recommendations: $("recommendations"),
    workflowSelector: $("workflowSelector"),
    troubleshootingDetails: $("troubleshootingDetails"),
    troubleshootingWelcome: $("troubleshootingWelcome"),
    troubleshootingPath: $("troubleshootingPath"),
    troubleshootingContent: $("troubleshootingContent"),
    symptomBackBtn: $("symptomBackBtn"),
    comparisonPanel: $("comparisonPanel"),
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
  liveRunning: false,
  isLiveScan: false,
  workflowMode: "recording",
  activeSymptom: null,
};

const WORKFLOW_RULES = {
  recording: {
    name: "Recording",
    description: "For tracking instruments or vocals. Low monitoring latency is critical.",
    pdc: {
      lowLimit: 5,
      mediumLimit: 12,
      labels: { low: "Tight", medium: "Acceptable", high: "Noticeable" }
    },
    device: {
      lowLimit: 2,
      mediumLimit: 6,
      labels: { low: "Low", medium: "Moderate", high: "High" }
    },
    buffer: {
      lowLimit: 128,
      mediumLimit: 256,
      labels: { low: "Optimal", medium: "Acceptable", high: "High" }
    }
  },
  performing: {
    name: "Performing",
    description: "For live stage performance. Tight, consistent timing is essential.",
    pdc: {
      lowLimit: 8,
      mediumLimit: 15,
      labels: { low: "Tight", medium: "Acceptable", high: "Noticeable" }
    },
    device: {
      lowLimit: 3,
      mediumLimit: 8,
      labels: { low: "Low", medium: "Moderate", high: "High" }
    },
    buffer: {
      lowLimit: 128,
      mediumLimit: 256,
      labels: { low: "Optimal", medium: "Acceptable", high: "High" }
    }
  },
  mixing: {
    name: "Mixing",
    description: "For editing and blending. Higher latency is fine as PDC keeps tracks aligned.",
    pdc: {
      lowLimit: 40,
      mediumLimit: 100,
      labels: { low: "Responsive", medium: "Acceptable", high: "Sluggish" }
    },
    device: {
      lowLimit: 15,
      mediumLimit: 50,
      labels: { low: "Low", medium: "Moderate", high: "High" }
    },
    buffer: {
      lowLimit: 512,
      mediumLimit: 1024,
      labels: { low: "Standard", medium: "Large", high: "Very Large" }
    }
  }
};

const WORKFLOW_MODES = Object.keys(WORKFLOW_RULES);

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
  prefixY: new Float64Array(1),
};

function rebuildPrefixSums() {
  virtual.prefixY = new Float64Array(virtual.rows.length + 1);
  for (let i = 0; i < virtual.rows.length; i++) {
    virtual.prefixY[i + 1] = virtual.prefixY[i]
      + (virtual.heightCache.get(i) || VIRTUAL_ROW_HEIGHT) + VIRTUAL_ROW_GAP;
  }
}

function rowY(index) {
  return virtual.prefixY[index] || 0;
}

function totalHeight() {
  return virtual.rows.length ? Math.max(0, virtual.prefixY[virtual.rows.length] - VIRTUAL_ROW_GAP) : 0;
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
  rebuildPrefixSums();
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
  rebuildPrefixSums();
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

const escapeHtml = components.escapeHtml;

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.disabled && el.offsetParent !== null);
}

// SYNC: Keep aliases and pluginKey() aligned with app.py normalize_plugin_name().
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
    } else if (state.latestReport) {
      updateStatusBanner();
      setTotalLatencySeverity(state.latestReport.pdc_latency_ms, !state.isLiveScan || !state.liveRunning);
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

function renderError(message, title = "Scan failed") {
  renderStateCard("error", {
    title,
    errorMessage: message,
    actionsHtml: `${components.actionButton("scan", "Retry scan")}
      ${components.actionButton("reload-osc", "Reload AbletonOSC", "secondary")}`,
  });
}

function getLatencyClass(samples, ms, type = "device", sampleRate = null) {
  const rate = Number(sampleRate || state.latestReport?.sample_rate || 48000);
  const rules = WORKFLOW_RULES[state.workflowMode || "recording"];
  const thresholds = rules[type] || rules.device;

  if (type === "buffer") {
    const bufferVal = Number(samples || 0);
    if (bufferVal <= thresholds.lowLimit) return "low";
    if (bufferVal <= thresholds.mediumLimit) return "medium";
    return "high";
  }

  const latencyMs = hasNumericValue(ms) ? Number(ms) : (Number(samples || 0) / rate * 1000);
  if (latencyMs <= thresholds.lowLimit) return "low";
  if (latencyMs <= thresholds.mediumLimit) return "medium";
  return "high";
}

function getLatencyLabel(samples, ms, type = "device", sampleRate = null) {
  const cls = getLatencyClass(samples, ms, type, sampleRate);
  const rules = WORKFLOW_RULES[state.workflowMode || "recording"];
  const thresholds = rules[type] || rules.device;
  return thresholds.labels[cls];
}

function updateLegend() {
  const container = $("legendContainer");
  if (!container) return;

  const metricType = state.groupMode === "channel" ? "pdc" : "device";
  const metricRules = WORKFLOW_RULES[state.workflowMode || "recording"][metricType];
  const lowRangeStart = typeof metricRules.lowLimit === "number" ? metricRules.lowLimit.toFixed(metricRules.lowLimit % 1 ? 1 : 0) : metricRules.lowLimit;
  const mediumRangeEnd = typeof metricRules.mediumLimit === "number" ? metricRules.mediumLimit.toFixed(metricRules.mediumLimit % 1 ? 1 : 0) : metricRules.mediumLimit;

  container.innerHTML = `
    <span class="legend-item"><span class="dot green"></span>${escapeHtml(metricRules.labels.low)} · &le; ${lowRangeStart} ms</span>
    <span class="legend-item"><span class="dot yellow"></span>${escapeHtml(metricRules.labels.medium)} · &gt; ${lowRangeStart} to ${mediumRangeEnd} ms</span>
    <span class="legend-item"><span class="dot red"></span>${escapeHtml(metricRules.labels.high)} · &gt; ${mediumRangeEnd} ms</span>
  `;
}

function getRelativeAge(timestamp) {
  if (!timestamp) return "";
  const date = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  if (isNaN(date.getTime())) return "";
  const now = Date.now();
  const diffSec = Math.floor((now - date.getTime()) / 1000);
  if (diffSec < 0) return "Just now";
  if (diffSec < 5) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function updateStatusBanner() {
  const banner = dom.statusBanner;
  if (!banner) return;

  const isStale = state.latestReport && (!state.isLiveScan || !state.liveRunning);
  if (!isStale) {
    banner.hidden = true;
    return;
  }

  let projectName = "";
  if (state.latestReport && state.latestReport.project) {
    projectName = state.latestReport.project.name || "";
  } else if (state.latestReport && state.latestReport.project_name) {
    projectName = state.latestReport.project_name || "";
  } else if (state.latestReport && state.latestReport.current_project) {
    projectName = state.latestReport.current_project.name || "";
  }

  let relativeAge = "";
  const timestamp = state.latestReport?.timestamp || state.lastScanTime;
  if (timestamp) {
    relativeAge = getRelativeAge(timestamp);
  }

  const parts = ["Cached scan"];
  if (projectName) {
    parts.push(projectName);
  }
  if (relativeAge) {
    parts.push(relativeAge);
  }
  if (!state.liveRunning) {
    parts.push("Live is closed");
  }

  banner.innerHTML = `<span class="dot"></span><span>${parts.join(" · ")}</span>`;
  banner.hidden = false;
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

function setTotalLatencySeverity(totalLatencyMs, isStale = false) {
  const badge = $("latencySeverityBadge");
  if (!hasNumericValue(totalLatencyMs)) {
    getDom().totalLatencyMs.style.color = "";
    if (badge) {
      badge.hidden = true;
      badge.textContent = "";
    }
    return false;
  }

  if (isStale) {
    getDom().totalLatencyMs.style.color = "var(--muted)";
    if (badge) {
      badge.hidden = true;
      badge.textContent = "";
    }
    return true;
  }

  const latencyClass = getLatencyClass(0, Number(totalLatencyMs), "pdc");
  const latencyLabel = getLatencyLabel(0, Number(totalLatencyMs), "pdc");

  getDom().totalLatencyMs.style.color = latencyClass === "high"
    ? "var(--red)"
    : latencyClass === "medium"
      ? "var(--amber)"
      : "var(--green)";

  if (badge) {
    badge.hidden = false;
    badge.className = `severity-badge ${latencyClass}`;
    badge.textContent = latencyClass === "high"
      ? `${latencyLabel} Delay`
      : latencyClass === "medium"
        ? `${latencyLabel} Delay`
        : `${latencyLabel} Delay`;
  }
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
  const isStale = !state.isLiveScan || !state.liveRunning;
  const hasLatency = setTotalLatencySeverity(report.pdc_latency_ms, isStale);
  if (hasLatency) {
    tweenText(d.totalLatencyMs, Number(report.pdc_latency_ms), fmtMs);
  } else {
    stopTween(d.totalLatencyMs);
    d.totalLatencyMs.textContent = "--";
    delete d.totalLatencyMs.dataset.value;
  }
  d.cumulativeLatencyMs.textContent = hasNumericValue(report.cumulative_latency_ms)
    ? `${fmtMs(report.cumulative_latency_ms)} ms cumulative`
    : "Cumulative latency unavailable";
  const bottleneck = report.bottleneck_track;
  if (bottleneck) {
    const trackIndexStr = bottleneck.track_index !== undefined && bottleneck.track_index !== null ? ` data-track-index="${bottleneck.track_index}"` : "";
    d.bottleneckTrack.innerHTML = `${escapeHtml(bottleneck.track_name)} · ${bottleneck.device_count} device${bottleneck.device_count === 1 ? "" : "s"} <button class="highlight-action-link" ${trackIndexStr} data-track-name="${escapeHtml(bottleneck.track_name)}" aria-label="Highlight bottleneck track in report">Highlight in report</button>`;
  } else {
    d.bottleneckTrack.textContent = "No PDC bottleneck";
  }
  const bufferBadge = $("bufferSeverityBadge");
  if (hasNumericValue(report.buffer_size)) {
    tweenText(d.bufferSize, Number(report.buffer_size), (n) => String(Math.round(n)));
    if (isStale) {
      d.bufferSize.style.color = "var(--muted)";
      if (bufferBadge) {
        bufferBadge.hidden = true;
        bufferBadge.textContent = "";
      }
    } else {
      const bufferVal = Number(report.buffer_size);
      const bufferClass = getLatencyClass(bufferVal, 0, "buffer");
      const bufferLabel = getLatencyLabel(bufferVal, 0, "buffer");

      d.bufferSize.style.color = bufferClass === "high"
        ? "var(--red)"
        : bufferClass === "medium"
          ? "var(--amber)"
          : "var(--green)";

      if (bufferBadge) {
        bufferBadge.hidden = false;
        bufferBadge.className = `severity-badge ${bufferClass}`;
        bufferBadge.textContent = bufferLabel;
      }
    }
  } else {
    d.bufferSize.textContent = "--";
    d.bufferSize.style.color = "";
    if (bufferBadge) {
      bufferBadge.hidden = true;
      bufferBadge.textContent = "";
    }
  }
  if (hasNumericValue(report.sample_rate)) {
    tweenText(d.sampleRate, Number(report.sample_rate) / 1000, (n) => (n ? `${n.toFixed(1)}k` : "--"));
  } else {
    d.sampleRate.textContent = "--";
  }
  tweenText(d.trackCount, Number(report.track_count || 0), (n) => pluralize(Math.round(n), "track"));
  tweenText(d.totalDevices, Number(report.device_count || 0), (n) => pluralize(Math.round(n), "device"));

  const anyValueVisible = hasLatency || hasNumericValue(report.buffer_size) || hasNumericValue(report.sample_rate);
  if (anyValueVisible) {
    revealContent(
      [d.totalLatencyMs, d.bufferSize, d.sampleRate, d.trackCount, d.totalDevices],
      [d.latencySkeleton, d.bufferSkeleton]
    );
  }
}

function getRecommendationIconSvg(type) {
  if (type === "recording") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>`;
  }
  if (type === "performing") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }
  if (type === "mixing") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/></svg>`;
  }
  if (type === "bottleneck") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
}

function renderRecommendations(report) {
  const panel = getDom().recommendations;
  const list = panel.querySelector(".recommendations-list");

  const mode = state.workflowMode || "recording";
  const adapted = [];

  // Prepend Mode-specific guidance card
  if (mode === "recording") {
    adapted.push({
      type: "recording",
      title: "Recording Guidance",
      iconClass: "bump",
      message: `
        <div class="guidance-assumption"><strong>Assumed Context:</strong> Tracking live audio or MIDI inputs. <em>(Note: LatencyManager cannot read track monitoring or arm states.)</em></div>
        <ul class="guidance-list">
          <li><strong>Buffer Size:</strong> Set your audio buffer size low (e.g. 64 or 128 samples) to minimize roundtrip monitoring latency. Increase it only if you hear CPU dropouts or crackles.</li>
          <li><strong>Direct Monitoring:</strong> Use your audio interface's 'Direct Monitoring' feature if possible to hear inputs with zero latency, bypassing Live's routing entirely.</li>
          <li><strong>Reduced Latency When Monitoring:</strong> Ensure Options &rarr; 'Reduced Latency When Monitoring' is enabled to bypass latency-inducing plugins on monitored/armed tracks.</li>
          <li><strong>Live 12 Keep Latency:</strong> In Live 12, check 'Keep Latency' in the track's context menu: disable it to align recorded clips with the grid, or enable it to preserve the physical timing of your performance.</li>
        </ul>
      `,
      isHtml: true
    });
  } else if (mode === "performing") {
    adapted.push({
      type: "performing",
      title: "Performing Guidance",
      iconClass: "warn",
      message: `
        <div class="guidance-assumption"><strong>Assumed Context:</strong> Playing live instruments or triggering software instruments. <em>(Note: LatencyManager cannot read track routing or monitor states.)</em></div>
        <ul class="guidance-list">
          <li><strong>Monitored Signal Path:</strong> Prioritize minimizing latency on your active monitored signal path. Avoid using high-latency devices (e.g., lookahead limiters, linear phase EQs) on any track in your live performance routing.</li>
          <li><strong>Return/Main Timing:</strong> Return tracks and the Main (Master) track are not latency-compensated in real-time for monitored signal paths. Keep the Main track and Return tracks free of latency-inducing plugins during your performance to prevent timing drift.</li>
        </ul>
      `,
      isHtml: true
    });
  } else if (mode === "mixing") {
    adapted.push({
      type: "mixing",
      title: "Mixing Guidance",
      iconClass: "alert",
      message: `
        <div class="guidance-assumption"><strong>Assumed Context:</strong> Mixing, arranging, or mastering where real-time monitoring is not active. <em>(Note: LatencyManager cannot read track routing or monitor states.)</em></div>
        <ul class="guidance-list">
          <li><strong>PDC Bottlenecks:</strong> Prioritize resolving PDC bottlenecks. Heavy or high-latency plugins on any group or the Master track will delay the entire set to maintain sync.</li>
          <li><strong>High-Latency Processing:</strong> Increase your audio buffer size (e.g., 512 or 1024 samples) to give your CPU maximum headroom for heavy plugins.</li>
          <li><strong>Freeze and Flatten:</strong> Freeze and flatten tracks with high-latency plugins to print their audio and reduce the overall PDC bottleneck.</li>
        </ul>
      `,
      isHtml: true
    });
  }

  // Map and adapt backend recommendations
  const backendRecs = report.recommendations || [];
  backendRecs.forEach((item) => {
    let title = item.title;
    let message = item.message;

    if (item.type === "bottleneck") {
      if (mode === "recording") {
        title = "PDC Bottleneck (Impacts Recording)";
        message = item.message + " (Note: If this bottleneck track is not in your monitored recording path, enable 'Reduced Latency When Monitoring' so it doesn't affect your recording latency.)";
      } else if (mode === "performing") {
        title = "PDC Bottleneck (Impacts Performance)";
        message = item.message + " (Note: High-latency plugins on Return/Main tracks will delay all tracks. If this bottleneck is on a Return or Main track, remove it to restore responsiveness.)";
      } else if (mode === "mixing") {
        title = "PDC Bottleneck (Primary Mixing Target)";
        message = item.message + " (Use Freeze and Flatten on this track to free up CPU and align timing.)";
      }
    }

    adapted.push({
      type: item.type,
      title: title,
      message: message,
      iconClass: item.type === "bottleneck" ? "alert" : "warn",
      track_index: item.track_index,
      track_name: item.track_name,
      plugin_names: item.plugin_names,
      isHtml: false
    });
  });

  panel.hidden = adapted.length === 0;

  list.innerHTML = adapted.map((item) => {
    let actionBtn = "";
    if (item.track_index !== undefined || item.track_name || (item.plugin_names && item.plugin_names.length)) {
      const targetAttrs = [];
      if (item.track_index !== undefined && item.track_index !== null) {
        targetAttrs.push(`data-track-index="${item.track_index}"`);
      }
      if (item.track_name) {
        targetAttrs.push(`data-track-name="${escapeHtml(item.track_name)}"`);
      }
      if (item.plugin_names) {
        targetAttrs.push(`data-plugin-names="${escapeHtml(JSON.stringify(item.plugin_names))}"`);
      }
      actionBtn = `<button class="highlight-action-link" ${targetAttrs.join(" ")} type="button">Highlight in report</button>`;
    }

    const messageContent = item.isHtml ? item.message : escapeHtml(item.message).replace(/\n/g, "<br>");

    return `
    <article class="recommendation-card" data-type="${escapeHtml(item.type)}">
      <div class="recommendation-card-header">
        <div class="recommendation-icon ${item.iconClass || 'bump'}">
          ${getRecommendationIconSvg(item.type)}
        </div>
        <h3>${escapeHtml(item.title)}</h3>
      </div>
      <div class="recommendation-text">${messageContent}</div>
      ${actionBtn ? `<div class="recommendation-actions">${actionBtn}</div>` : ""}
    </article>`;
  }).join("");
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
  const type = state.groupMode === "channel" ? "pdc" : "device";
  const latencyClass = getLatencyClass(item.latency_samples, item.latency_ms, type);
  const latencyLabel = getLatencyLabel(item.latency_samples, item.latency_ms, type);
  const widthPercent = Math.max((item.latency_samples / maxSessionSamples) * 100, 2);
  const nameEl = row.querySelector(".plugin-name");
  const tracksEl = row.querySelector(".plugin-tracks");
  const barEl = row.querySelector(".latency-bar");
  const latencyEl = row.querySelector(".plugin-latency-val");
  const latencyNumberEl = row.querySelector(".latency-number");
  const severityLabelEl = row.querySelector(".row-severity-label");
  const deltaEl = row.querySelector(".delta-badge");
  const detailsEl = row.querySelector(".track-details");
  const name = item.title || "Unnamed";
  const subtitle = item.subtitle || "";
  const subtitleKind = item.subtitle_kind || "";
  row.classList.toggle("bottleneck", Boolean(item.is_bottleneck));

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
  if (severityLabelEl) {
    severityLabelEl.textContent = latencyLabel;
    severityLabelEl.className = `row-severity-label ${latencyClass}`;
  }
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
      track_index: device.track_index,
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

  const bottleneck = report.bottleneck_track;
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
    is_bottleneck: Boolean(bottleneck && String(bottleneck.track_index) === String(group.track_index)),
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

function renderComparison(report) {
  const comp = report?.comparison;
  const panel = getDom().comparisonPanel;
  if (!panel) return;

  if (!state.compare || !comp) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  panel.hidden = false;

  // Build HTML
  let html = `
    <div class="comparison-summary-header">
      <div>
        <h3>Before / After Verification</h3>
        <p class="comparison-item-meta" style="margin-top: 2px;">Comparison since last scan in this project</p>
      </div>
      <div class="comparison-badges">
        <span class="comparison-badge ${comp.pdc_change_status}">
          PDC: ${comp.pdc_change_label}
        </span>
        <span class="comparison-badge ${comp.bottleneck_status}">
          Bottleneck: ${comp.bottleneck_message}
        </span>
      </div>
    </div>
    <div class="comparison-grid">
  `;

  // Added devices card
  html += `
    <div class="comparison-card-sub">
      <h4>Added Devices</h4>
  `;
  if (comp.added_devices && comp.added_devices.length > 0) {
    html += `<ul class="comparison-list">`;
    comp.added_devices.forEach(d => {
      html += `
        <li class="comparison-item">
          <span class="comparison-item-name" title="${escapeHtml(d.device_name)} on ${escapeHtml(d.track_name)}">
            ${escapeHtml(d.device_name)} <span class="comparison-item-meta">(${escapeHtml(d.track_name)})</span>
          </span>
          <span class="comparison-item-delta plus">+${d.latency_ms.toFixed(1)} ms</span>
        </li>
      `;
    });
    html += `</ul>`;
  } else {
    html += `<p class="comparison-item-meta">None</p>`;
  }
  html += `</div>`;

  // Removed devices card
  html += `
    <div class="comparison-card-sub">
      <h4>Removed Devices</h4>
  `;
  if (comp.removed_devices && comp.removed_devices.length > 0) {
    html += `<ul class="comparison-list">`;
    comp.removed_devices.forEach(d => {
      html += `
        <li class="comparison-item">
          <span class="comparison-item-name" title="${escapeHtml(d.device_name)} from ${escapeHtml(d.track_name)}">
            ${escapeHtml(d.device_name)} <span class="comparison-item-meta">(${escapeHtml(d.track_name)})</span>
          </span>
          <span class="comparison-item-delta minus">-${d.latency_ms.toFixed(1)} ms</span>
        </li>
      `;
    });
    html += `</ul>`;
  } else {
    html += `<p class="comparison-item-meta">None</p>`;
  }
  html += `</div>`;

  // Changed tracks & plugins card
  html += `
    <div class="comparison-card-sub">
      <h4>Changed Tracks & Plugins</h4>
  `;
  const hasChanges = (comp.changed_tracks && comp.changed_tracks.length > 0) ||
                      (comp.changed_plugins && comp.changed_plugins.length > 0);

  if (hasChanges) {
    html += `<ul class="comparison-list">`;
    if (comp.changed_tracks) {
      comp.changed_tracks.forEach(t => {
        const delta = t.new_latency_ms - t.old_latency_ms;
        const sign = delta > 0 ? "+" : "";
        const cls = delta > 0 ? "plus" : "minus";
        html += `
          <li class="comparison-item">
            <span class="comparison-item-name" title="Track: ${escapeHtml(t.track_name)}">
              Track: ${escapeHtml(t.track_name)}
            </span>
            <span class="comparison-item-delta ${cls}">${sign}${delta.toFixed(1)} ms</span>
          </li>
        `;
      });
    }
    if (comp.changed_plugins) {
      comp.changed_plugins.forEach(p => {
        const delta = p.new_max_latency_ms - p.old_max_latency_ms;
        const sign = delta > 0 ? "+" : "";
        const cls = delta > 0 ? "plus" : "minus";
        if (Math.abs(delta) > 0.05) {
          html += `
            <li class="comparison-item">
              <span class="comparison-item-name" title="Plugin: ${escapeHtml(p.device_name)}">
                Plugin: ${escapeHtml(p.device_name)}
              </span>
              <span class="comparison-item-delta ${cls}">${sign}${delta.toFixed(1)} ms</span>
            </li>
          `;
        }
      });
    }
    html += `</ul>`;
  } else {
    html += `<p class="comparison-item-meta">None</p>`;
  }
  html += `</div>`;

  html += `</div>`;
  panel.innerHTML = html;
}

// ── Results rendering ──

function updateResults(report) {
  renderComparison(report);
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
    rebuildPrefixSums();
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
  renderRecommendations(report);
  updateResults(report);
  state.hasReport = true;
  getDom().reportToolbar.hidden = false;
  updateStatusBanner();
  updateTroubleshooting();
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
  updateLegend();
  if (state.latestReport) {
    updateDashboardStats(state.latestReport);
    updateResults(state.latestReport);
  }
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
    const previousController = new AbortController();
    const previousTimeout = setTimeout(() => previousController.abort(), 2000);
    controller.signal.addEventListener("abort", () => previousController.abort(), { once: true });
    const prevRes = await fetch("/api/last-scan", { signal: previousController.signal });
    const prevData = await prevRes.json();
    state.previousReport = prevData.report || null;
    clearTimeout(previousTimeout);
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
    state.isLiveScan = true;
    renderReport(data);
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    const payload = err.payload || {};
    if (payload.diagnostics) renderDiagnostics(payload.diagnostics);
    if (payload.cached_report) {
      state.isLiveScan = false;
      renderReport(payload.cached_report);
    }
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

function highlightRowInReport(target) {
  if (!state.latestReport) return;

  // 1. Switch to Scan view if necessary
  if (state.currentView !== "scan") {
    setAppView("scan");
  }

  const hasTrack = target.trackIndex !== undefined || target.trackName;
  const hasPlugins = target.pluginNames && target.pluginNames.length > 0;

  let keyToHighlight = null;

  if (hasTrack) {
    // Ensure we are in "channel" view.
    setGroupMode("channel");

    const report = state.latestReport;
    const rows = channelRows(report);

    let targetRow = null;
    if (target.trackIndex !== undefined) {
      targetRow = rows.find(r => String(r.instances?.[0]?.track_index) === String(target.trackIndex));
    }
    if (!targetRow && target.trackName) {
      targetRow = rows.find(r => r.title && r.title.toLowerCase().includes(target.trackName.toLowerCase()));
    }

    if (targetRow) {
      keyToHighlight = targetRow.key;
    }
  } else if (hasPlugins) {
    // Ensure we are in "plugin" view.
    setGroupMode("plugin");

    const report = state.latestReport;
    const rows = pluginRows(report);

    let targetRow = null;
    for (const pName of target.pluginNames) {
      const targetKey = pluginKey({ device_name: pName });
      targetRow = rows.find(r => r.key === `plugin:${targetKey}`);
      if (targetRow) break;
    }

    if (targetRow) {
      keyToHighlight = targetRow.key;
    }
  }

  if (!keyToHighlight) return;

  // 2. Reveal hidden rows if target is outside top-10 view or filtered out.
  let activeRows = currentRows(state.latestReport);
  let isPresent = activeRows.some(r => r.key === keyToHighlight);

  let changed = false;
  if (!isPresent) {
    const d = getDom();
    if (state.searchQuery) {
      state.searchQuery = "";
      d.searchInput.value = "";
      changed = true;
    }

    if (!state.showAll) {
      state.showAll = true;
      d.showAllToggle.checked = true;
      changed = true;
    }

    if (changed) {
      updateResults(state.latestReport);
      activeRows = currentRows(state.latestReport);
    }
  }

  const targetIndex = activeRows.findIndex(r => r.key === keyToHighlight);
  if (targetIndex < 0) return;

  // 3. Scroll the matching track or plugin row into view.
  if (virtual.active) {
    const y = rowY(targetIndex);
    const rowHeight = (virtual.heightCache.get(targetIndex) || VIRTUAL_ROW_HEIGHT);
    const clientHeight = dom.results.clientHeight;
    dom.results.scrollTop = Math.max(0, y - (clientHeight - rowHeight) / 2);
    renderVisibleRows();
  }

  const rowEl = dom.results.querySelector(`.plugin-row[data-key="${CSS.escape(keyToHighlight)}"]`);
  if (!rowEl) return;

  if (!virtual.active) {
    rowEl.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // 4. Apply a brief accessible highlight
  rowEl.classList.remove("highlight-flash");
  rowEl.offsetHeight; // force reflow
  rowEl.classList.add("highlight-flash");

  setTimeout(() => {
    rowEl.classList.remove("highlight-flash");
  }, 1500);

  // 5. Move keyboard focus to the row
  const focusable = rowEl.querySelector(".plugin-toggle") || rowEl;
  if (focusable) {
    focusable.focus();
  }
}

function updateTroubleshooting() {
  const d = getDom();
  if (!d.troubleshootingContent) return;

  const report = state.latestReport;
  const symptom = state.activeSymptom;

  if (!symptom) {
    d.troubleshootingWelcome.hidden = false;
    d.troubleshootingPath.hidden = true;
    return;
  }

  d.troubleshootingWelcome.hidden = true;
  d.troubleshootingPath.hidden = false;

  let html = "";
  const formatLink = (text, url) => `<a href="${url}" target="_blank" rel="noopener" class="step-link">${text}</a>`;

  if (symptom === "delay") {
    const hasBuffer = report && hasNumericValue(report.buffer_size) && Number(report.buffer_size) > 0;
    const hasPdc = report && hasNumericValue(report.pdc_latency_ms);
    const bottleneck = report?.bottleneck_track;

    html = `
      <h3 class="symptom-title">Troubleshooting: Delay while playing or singing</h3>
      <div class="symptom-steps">
        <div class="symptom-step">
          <div class="step-number-bubble">1</div>
          <div class="step-content">
            <h4 class="step-title">Configure Live's Monitor settings (Monitoring Latency)</h4>
            <p class="step-desc">For the lowest latency when recording vocals or instruments, turn the track's Monitor setting to <strong>Off</strong> and use your audio interface's direct hardware monitoring. If you must monitor through Live to hear software effects, set the Monitor to <strong>Auto</strong> or <strong>In</strong>, but keep your plugin latency minimal.</p>
            <div class="step-links">${formatLink("How to use Direct Monitoring", "https://help.ableton.com/hc/en-us/articles/360000843400-How-to-use-Direct-monitoring")}</div>
          </div>
        </div>

        <div class="symptom-step">
          <div class="step-number-bubble">2</div>
          <div class="step-content">
            <h4 class="step-title">Reduce interface audio buffer size (Interface Latency)</h4>
            <p class="step-desc">Lowering the buffer size in Live's Audio Settings reduces the time it takes for audio to pass through the computer.</p>
            ${hasBuffer ? `<div class="step-info">Detected current buffer size: <strong>${Math.round(report.buffer_size)} samples</strong>.</div>` : ""}
            <div class="step-warning"><strong>Caution:</strong> Lowering the buffer size increases CPU load. If the buffer is set too low for your CPU, it may cause audio crackles, pops, or dropouts.</div>
            <div class="step-links">${formatLink("How to reduce latency in Live", "https://help.ableton.com/hc/en-us/articles/209072289-How-to-reduce-latency-in-Live")}</div>
          </div>
        </div>

        <div class="symptom-step">
          <div class="step-number-bubble">3</div>
          <div class="step-content">
            <h4 class="step-title">Minimize Plugin Delay Compensation (PDC Latency)</h4>
            <p class="step-desc">Live delays tracks to align them. Look-ahead or oversampling plugins on the monitoring track or Master track add to the monitoring delay.</p>
            ${hasPdc ? `
              <div class="step-info">
                Detected PDC Latency: <strong>${fmtMs(report.pdc_latency_ms)} ms</strong>
                ${bottleneck ? ` · Bottleneck Track: <strong>${escapeHtml(bottleneck.track_name)}</strong>` : ""}
              </div>
            ` : ""}
            <div class="step-links">${formatLink("Read Plugin Delay Compensation (PDC) FAQ", "https://help.ableton.com/hc/en-us/articles/360001820360-Plugin-Delay-Compensation-FAQ")}</div>
          </div>
        </div>
      </div>
    `;
  } else if (symptom === "late") {
    const hasPdc = report && hasNumericValue(report.pdc_latency_ms);

    html = `
      <h3 class="symptom-title">Troubleshooting: Recorded audio lands late</h3>
      <div class="symptom-steps">
        <div class="symptom-step">
          <div class="step-number-bubble">1</div>
          <div class="step-content">
            <h4 class="step-title">Configure Driver Error Compensation (DEC) (Recording Placement)</h4>
            <p class="step-desc">If newly recorded audio is consistently offset from the grid relative to MIDI or other tracks, adjust the <strong>Driver Error Compensation (DEC)</strong> slider in Live's Audio Settings.</p>
            <div class="step-warning"><strong>Important:</strong> Driver Error Compensation specifically corrects the timeline placement of recorded audio. It does <strong>not</strong> affect general playback latency or real-time monitoring delay.</div>
            <p class="step-desc">To configure DEC: Open Help &rarr; Help View &rarr; Audio I/O inside Live, and complete the Driver Error Compensation lesson.</p>
            <div class="step-links">${formatLink("How to use Driver Error Compensation", "https://help.ableton.com/hc/en-us/articles/209072329-How-to-use-Driver-Error-Compensation")}</div>
          </div>
        </div>

        <div class="symptom-step">
          <div class="step-number-bubble">2</div>
          <div class="step-content">
            <h4 class="step-title">Minimize Plugin Delay Compensation (PDC Latency)</h4>
            <p class="step-desc">High-latency plugins in your project can offset the timeline sync. Freeze or deactivate high-latency plugins while recording to ensure tighter recorded placement.</p>
            ${hasPdc ? `<div class="step-info">Detected PDC Latency: <strong>${fmtMs(report.pdc_latency_ms)} ms</strong>.</div>` : ""}
            <div class="step-links">${formatLink("Read Plugin Delay Compensation (PDC) FAQ", "https://help.ableton.com/hc/en-us/articles/360001820360-Plugin-Delay-Compensation-FAQ")}</div>
          </div>
        </div>
      </div>
    `;
  } else if (symptom === "sluggish") {
    const hasBuffer = report && hasNumericValue(report.buffer_size) && Number(report.buffer_size) > 0;
    const hasPdc = report && hasNumericValue(report.pdc_latency_ms);
    const bottleneck = report?.bottleneck_track;

    html = `
      <h3 class="symptom-title">Troubleshooting: Playback feels sluggish</h3>
      <div class="symptom-steps">
        <div class="symptom-step">
          <div class="step-number-bubble">1</div>
          <div class="step-content">
            <h4 class="step-title">Identify and remove Plugin Delay Compensation (PDC) bottlenecks</h4>
            <p class="step-desc">Sluggish playback start/stop response and MIDI key trigger lag are caused by high-latency plugins. Live delays all tracks to synchronize them with the highest-latency path.</p>
            ${hasPdc ? `
              <div class="step-info">
                Detected PDC Latency: <strong>${fmtMs(report.pdc_latency_ms)} ms</strong>
                ${bottleneck ? ` · Driven by track: <strong>${escapeHtml(bottleneck.track_name)}</strong>` : ""}
              </div>
            ` : ""}
            <p class="step-desc">Action: Freeze the bottleneck tracks, or deactivate/remove the offending plugins.</p>
            <div class="step-links">${formatLink("Read Plugin Delay Compensation (PDC) FAQ", "https://help.ableton.com/hc/en-us/articles/360001820360-Plugin-Delay-Compensation-FAQ")}</div>
          </div>
        </div>

        <div class="symptom-step">
          <div class="step-number-bubble">2</div>
          <div class="step-content">
            <h4 class="step-title">Adjust interface audio buffer size (Interface Latency)</h4>
            <p class="step-desc">A higher buffer size adds latency to general playback, note triggering, and transport controls.</p>
            ${hasBuffer ? `<div class="step-info">Detected current buffer size: <strong>${Math.round(report.buffer_size)} samples</strong>.</div>` : ""}
            <div class="step-warning"><strong>Caution:</strong> Lowering the buffer size reduces sluggishness but increases CPU load, risking audio crackles or dropouts.</div>
            <div class="step-links">${formatLink("Audio buffer size settings", "https://help.ableton.com/hc/en-us/articles/209072289-How-to-reduce-latency-in-Live")}</div>
          </div>
        </div>
      </div>
    `;
  } else if (symptom === "crackles") {
    const hasBuffer = report && hasNumericValue(report.buffer_size) && Number(report.buffer_size) > 0;
    const hasDevices = report && (hasNumericValue(report.device_count) || hasNumericValue(report.track_count));

    html = `
      <h3 class="symptom-title">Troubleshooting: Crackles or dropouts</h3>
      <div class="symptom-steps">
        <div class="symptom-step">
          <div class="step-number-bubble">1</div>
          <div class="step-content">
            <h4 class="step-title">Increase interface audio buffer size (CPU Buffer)</h4>
            <p class="step-desc">Pops, clicks, and dropouts occur when the CPU cannot process the audio buffer fast enough. Increasing the buffer size gives the CPU more time to process audio.</p>
            ${hasBuffer ? `<div class="step-info">Detected current buffer size: <strong>${Math.round(report.buffer_size)} samples</strong>.</div>` : ""}
            <p class="step-desc">Action: Raise the buffer size (e.g., to 256, 512, or 1024 samples) during mixing or when using resource-intensive plugins.</p>
            <div class="step-links">${formatLink("Optimizing CPU load in Live", "https://help.ableton.com/hc/en-us/articles/209071469-Optimizing-Live-s-CPU-performance")}</div>
          </div>
        </div>

        <div class="symptom-step">
          <div class="step-number-bubble">2</div>
          <div class="step-content">
            <h4 class="step-title">Freeze and Flatten heavy tracks</h4>
            <p class="step-desc">Freezing converts MIDI and plugin tracks into pre-rendered audio, disabling CPU-heavy plugins and freeing resources.</p>
            ${hasDevices ? `<div class="step-info">Detected: <strong>${report.device_count || 0} devices</strong> across <strong>${report.track_count || 0} tracks</strong>.</div>` : ""}
            <div class="step-links">${formatLink("How to use Freeze and Flatten", "https://help.ableton.com/hc/en-us/articles/209771385-How-to-use-Freeze-and-Flatten")}</div>
          </div>
        </div>
      </div>
    `;
  }

  d.troubleshootingContent.innerHTML = html;
}

function bindDeferredEvents() {
  const d = getDom();

  const handleHighlightClick = (e) => {
    const btn = e.target.closest(".highlight-action-link");
    if (!btn) return;

    e.preventDefault();
    const trackIndex = btn.dataset.trackIndex !== undefined && btn.dataset.trackIndex !== "" ? parseInt(btn.dataset.trackIndex, 10) : undefined;
    const trackName = btn.dataset.trackName || undefined;

    let pluginNames = undefined;
    if (btn.dataset.pluginNames) {
      try {
        pluginNames = JSON.parse(btn.dataset.pluginNames);
      } catch (err) {
        console.error("Failed to parse plugin names", err);
      }
    }

    highlightRowInReport({ trackIndex, trackName, pluginNames });
  };

  if (d.recommendations) {
    d.recommendations.addEventListener("click", handleHighlightClick);
  }

  if (d.bottleneckTrack) {
    d.bottleneckTrack.addEventListener("click", handleHighlightClick);
  }

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

  d.workflowSelector.addEventListener("click", (e) => {
    const btn = e.target.closest(".workflow-btn");
    if (!btn) return;
    setWorkflowMode(btn.dataset.mode);
  });

  d.workflowSelector.addEventListener("keydown", (event) => {
    const buttons = [...d.workflowSelector.querySelectorAll(".workflow-btn")];
    const currentIndex = buttons.findIndex((btn) => btn.dataset.mode === state.workflowMode);
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1 + buttons.length) % buttons.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = buttons.length - 1;
    } else if (event.key === " " || event.key === "Enter") {
      const btn = event.target.closest(".workflow-btn");
      if (!btn) return;
      event.preventDefault();
      setWorkflowMode(btn.dataset.mode);
      return;
    } else {
      return;
    }

    event.preventDefault();
    const nextBtn = buttons[nextIndex];
    nextBtn?.focus();
    setWorkflowMode(nextBtn?.dataset.mode);
  });

  const bindSymptom = (id, symptom) => {
    const btn = $(id);
    if (btn) {
      btn.addEventListener("click", () => {
        state.activeSymptom = symptom;
        updateTroubleshooting();
      });
    }
  };
  bindSymptom("symptom-delay", "delay");
  bindSymptom("symptom-late", "late");
  bindSymptom("symptom-sluggish", "sluggish");
  bindSymptom("symptom-crackles", "crackles");

  if (d.symptomBackBtn) {
    d.symptomBackBtn.addEventListener("click", () => {
      state.activeSymptom = null;
      updateTroubleshooting();
    });
  }
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
const ONBOARDING_COMPLETED_KEY = "latency-onboarding-completed";

let onboardingTriggerElement = null;

function showOnboarding(triggerElement = null) {
  onboardingTriggerElement = triggerElement;
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
  const target = returnFocusTo || onboardingTriggerElement || dom.scanButton || getFocusableElements(d.shell)[0];
  target?.focus();
  onboardingTriggerElement = null;
}

function isOnboardingDismissed() {
  return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1" || sessionStorage.getItem(ONBOARDING_SESSION_DISMISSED_KEY) === "1";
}

function isOnboardingCompleted() {
  return localStorage.getItem(ONBOARDING_COMPLETED_KEY) === "1";
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
      localStorage.setItem(ONBOARDING_COMPLETED_KEY, "1");
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

const resetBtn = $("resetOnboardingBtn");
if (resetBtn) {
  resetBtn.addEventListener("click", () => {
    localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
    sessionStorage.removeItem(ONBOARDING_SESSION_DISMISSED_KEY);
    localStorage.removeItem(ONBOARDING_COMPLETED_KEY);
    onboarding.doNotShow.checked = false;
    showOnboarding(resetBtn);
    runOnboarding();
  });
}

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
    const selected = btn.dataset.view === view;
    btn.classList.toggle("active", selected);
    btn.setAttribute("aria-selected", String(selected));
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

document.querySelector(".app-nav").addEventListener("keydown", (event) => {
  const tabs = [...document.querySelectorAll(".app-nav-btn")];
  const current = tabs.indexOf(event.target);
  if (current < 0) return;
  let next = current;
  if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
  else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else return;
  event.preventDefault();
  tabs[next].focus();
  setAppView(tabs[next].dataset.view);
});

function updateWorkflowSelectorUI() {
  const selector = getDom().workflowSelector;
  if (!selector) return;
  const buttons = selector.querySelectorAll(".workflow-btn");
  buttons.forEach((btn) => {
    const isCurrent = btn.dataset.mode === state.workflowMode;
    btn.classList.toggle("active", isCurrent);
    btn.setAttribute("aria-checked", isCurrent ? "true" : "false");
    btn.tabIndex = isCurrent ? 0 : -1;
  });
}

function setWorkflowMode(mode) {
  if (!WORKFLOW_MODES.includes(mode) || mode === state.workflowMode) return;
  state.workflowMode = mode;
  localStorage.setItem("latency_workflow_mode", mode);
  updateWorkflowSelectorUI();
  updateLegend();
  if (state.latestReport) {
    updateDashboardStats(state.latestReport);
    renderRecommendations(state.latestReport);
    updateResults(state.latestReport);
  }
}

// ── Init ──

async function init() {
  const storedWorkflowMode = localStorage.getItem("latency_workflow_mode");
  state.workflowMode = WORKFLOW_MODES.includes(storedWorkflowMode) ? storedWorkflowMode : "recording";
  bindDeferredEvents();
  updateWorkflowSelectorUI();
  updateLegend();
  updateTroubleshooting();
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      virtual.viewportHeight = -1;
      scheduleRenderVisible();
    }).observe(dom.results);
  }
  refreshStatus();
  setInterval(refreshStatus, 5000);
  updateScanTimestamp();
  setInterval(updateScanTimestamp, 10000);

  if (isOnboardingDismissed() || isOnboardingCompleted()) {
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
    localStorage.setItem(ONBOARDING_COMPLETED_KEY, "1");
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

// Always expose test hooks so test_onboarding.js can access module-level
// identifiers. In production test_onboarding.js bails immediately via its own
// window.location.search guard, so this object is never exercised.
window.__onboardingTest = {
  onboarding,
  init,
  scan,
  getFocusableElements,
  isOnboardingCompleted,
  ONBOARDING_DISMISSED_KEY,
  ONBOARDING_SESSION_DISMISSED_KEY,
  ONBOARDING_COMPLETED_KEY,
};

if (!window.location.search.includes("test=1")) {
  scheduleInit(() => init());
}
