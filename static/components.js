(function () {
  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function loadingRows(count = 5) {
    return Array.from({ length: count }, () => `<div class="shimmer-row"></div>`).join("");
  }

  function actionButton(action, label, variant = "") {
    const classes = ["recovery-btn", variant].filter(Boolean).join(" ");
    return `<button class="${classes}" type="button" data-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`;
  }

  function stateCard(state, opts = {}) {
    const hasIcon = ["empty", "offline", "error", "success"].includes(state);
    let html = `<div class="state-card" data-state="${escapeHtml(state)}">`;
    if (hasIcon) html += `<div class="state-card__icon"></div>`;
    if (opts.title) html += `<h2 class="state-card__title">${escapeHtml(opts.title)}</h2>`;
    if (opts.description) html += `<p class="state-card__description">${escapeHtml(opts.description)}</p>`;
    if (opts.errorMessage) html += `<div class="state-card__error">${escapeHtml(opts.errorMessage)}</div>`;
    if (opts.actionsHtml) html += `<div class="state-card__actions">${opts.actionsHtml}</div>`;
    if (opts.childrenHtml) html += opts.childrenHtml;
    return `${html}</div>`;
  }

  function pluginRowShell() {
    return `
      <div class="plugin-main">
        <div class="plugin-info">
          <span class="plugin-name"></span>
          <div class="plugin-tracks"></div>
        </div>
        <div class="plugin-bar-container">
          <div class="latency-bar"></div>
        </div>
        <div class="plugin-latency-val">
          <div class="plugin-latency-num-row">
            <span class="latency-number"></span> <span class="latency-unit">ms</span>
          </div>
          <span class="row-severity-label"></span>
          <span class="delta-badge" hidden></span>
        </div>
        <button class="plugin-toggle" type="button" aria-label="Toggle details" aria-expanded="false">
          <span class="icon-chevron" aria-hidden="true"></span>
        </button>
      </div>
      <div class="track-details"></div>`;
  }

  function formatTypeLabel(value) {
    return /^audio units?$/i.test(String(value || "").trim()) ? "AU" : value;
  }

  function trackDetails(rows, { nameLabel = "Track name", numberLabel = "", formatLatency, showTrackKind = false } = {}) {
    const fmtMs = formatLatency || ((value) => String(value));
    const hasNumberCol = Boolean(numberLabel);
    const colClass = hasNumberCol ? "" : " three-col";
    const body = rows
      .slice()
      .sort((a, b) => Number(b.latency_samples || 0) - Number(a.latency_samples || 0))
      .map((inst) => {
        const activeClass = inst.active === true ? "active" : "";
        const activeText = inst.active === true ? "Active" : inst.active === false ? "Inactive" : "Unknown";
        const fmt = formatTypeLabel(inst.format || "");
        const clsName = inst.class_name || "";
        const typeTitle = clsName ? `class: ${escapeHtml(clsName)}` : "";
        const kindBadge = showTrackKind && inst.track_kind && inst.track_kind_label
          ? `<span class="track-kind ${escapeHtml(inst.track_kind)}">${escapeHtml(inst.track_kind_label)}</span>`
          : "";
        return `
          <div class="track-item${colClass}">
            <div class="track-name">
              <div class="track-name-main">
                <span class="track-name-text">${escapeHtml(inst.detail_name || inst.track_name || "Unnamed Track")}</span>
                <span class="track-status ${activeClass}">${activeText}</span>
              </div>
              ${kindBadge}
            </div>
            ${hasNumberCol ? `<div class="track-number">${escapeHtml(inst.detail_number ?? inst.track_number ?? "--")}</div>` : ""}
            <div class="track-type">
              <span class="track-type-badge" title="${typeTitle}">${escapeHtml(fmt || "--")}</span>
            </div>
            <div class="track-latency">
              ${escapeHtml(fmtMs(inst.latency_ms))} ms${inst._delta_html || ""}
            </div>
          </div>`;
      })
      .join("");

    return `
      <div class="track-details-header${colClass}">
        <span class="header-name">${escapeHtml(nameLabel)}</span>
        ${hasNumberCol ? `<span class="header-number">${escapeHtml(numberLabel)}</span>` : ""}
        <span class="header-type">Type</span>
        <span class="header-latency">Latency</span>
      </div>
      ${body}`;
  }

  window.LatencyComponents = {
    actionButton,
    escapeHtml,
    loadingRows,
    pluginRowShell,
    stateCard,
    trackDetails,
  };
})();
