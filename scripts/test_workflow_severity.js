const fs = require("fs");
const path = require("path");
const vm = require("vm");

function createStubElement() {
  return {
    hidden: false,
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    style: {},
    dataset: {},
    className: "",
    children: [],
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    focus() {},
    click() {},
    contains() { return false; },
    closest() { return null; },
    querySelector() { return createStubElement(); },
    querySelectorAll() { return []; },
    insertAdjacentHTML() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    classList: {
      add() {},
      remove() {},
      toggle() { return false; },
      contains() { return false; },
    },
  };
}

function loadApp() {
  const appPath = path.join(__dirname, "..", "static", "app.js");
  const source = fs.readFileSync(appPath, "utf8");
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, createStubElement());
    return elements.get(id);
  };

  const documentStub = {
    hidden: false,
    body: createStubElement(),
    documentElement: createStubElement(),
    createElement() { return createStubElement(); },
    createDocumentFragment() { return createStubElement(); },
    getElementById(id) { return getElement(id); },
    querySelector() { return createStubElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };

  const storage = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: clearTimeout,
    requestIdleCallback: (cb) => setTimeout(cb, 0),
    cancelIdleCallback: clearTimeout,
    performance: { now: () => 0 },
    Blob: function Blob() {},
    URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
    fetch: async () => ({ ok: true, json: async () => ({ report: null }) }),
    CSS: { escape: (value) => String(value) },
    HTMLElement: function HTMLElement() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    document: documentStub,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
  };

  context.window = context;
  context.location = { search: "?test=1" };
  context.navigator = { userAgent: "node" };
  context.LatencyApi = {
    request: async () => ({ data: {} }),
    localPost: async () => ({ res: { ok: true }, data: {} }),
  };
  context.LatencyComponents = {
    pluginRowShell: () => "",
    actionButton: () => "",
    stateCard: () => "",
    loadingRows: () => "",
    trackDetails: () => "",
    escapeHtml: (value) => String(value),
  };

  vm.createContext(context);
  vm.runInContext(`${source}
window.__workflowSeverityTest = {
  state,
  getLatencyClass,
  getLatencyLabel
};`, context, { filename: "app.js" });
  return context.__workflowSeverityTest;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function run() {
  const hooks = loadApp();
  const { state, getLatencyClass, getLatencyLabel } = hooks;

  state.workflowMode = "recording";
  assertEqual(getLatencyClass(0, 4.9, "pdc"), "low", "recording pdc below low threshold");
  assertEqual(getLatencyClass(0, 5.0, "pdc"), "low", "recording pdc at low threshold");
  assertEqual(getLatencyClass(0, 5.1, "pdc"), "medium", "recording pdc above low threshold");
  assertEqual(getLatencyClass(0, 12.1, "pdc"), "high", "recording pdc above medium threshold");
  assertEqual(getLatencyLabel(0, 4.9, "pdc"), "Tight", "recording pdc label");
  assertEqual(getLatencyClass(128, 0, "buffer"), "low", "recording buffer low");
  assertEqual(getLatencyClass(256, 0, "buffer"), "medium", "recording buffer medium");
  assertEqual(getLatencyClass(257, 0, "buffer"), "high", "recording buffer high");

  state.workflowMode = "performing";
  assertEqual(getLatencyClass(0, 8.0, "pdc"), "low", "performing pdc at low threshold");
  assertEqual(getLatencyClass(0, 8.1, "pdc"), "medium", "performing pdc above low threshold");
  assertEqual(getLatencyClass(0, 15.1, "pdc"), "high", "performing pdc above medium threshold");
  assertEqual(getLatencyLabel(0, 7.0, "pdc"), "Tight", "performing pdc label");
  assertEqual(getLatencyClass(3, null, "device", 1000), "low", "performing device low");
  assertEqual(getLatencyClass(4, null, "device", 1000), "medium", "performing device medium");
  assertEqual(getLatencyClass(9, null, "device", 1000), "high", "performing device high");

  state.workflowMode = "mixing";
  assertEqual(getLatencyClass(0, 40, "pdc"), "low", "mixing pdc at low threshold");
  assertEqual(getLatencyClass(0, 40.1, "pdc"), "medium", "mixing pdc above low threshold");
  assertEqual(getLatencyClass(0, 100.1, "pdc"), "high", "mixing pdc above medium threshold");
  assertEqual(getLatencyLabel(0, 10, "device"), "Low", "mixing device low label");
  assertEqual(getLatencyLabel(0, 20, "device"), "Moderate", "mixing device medium label");
  assertEqual(getLatencyLabel(0, 60, "device"), "High", "mixing device high label");
  assertEqual(getLatencyClass(512, 0, "buffer"), "low", "mixing buffer low");
  assertEqual(getLatencyClass(768, 0, "buffer"), "medium", "mixing buffer medium");
  assertEqual(getLatencyClass(1025, 0, "buffer"), "high", "mixing buffer high");

  console.log("workflow severity tests passed");
}

run();
