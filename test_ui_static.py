import re
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
INDEX_HTML = ROOT / "static" / "index.html"
APP_JS = ROOT / "static" / "app.js"


class StaticHtmlParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.scripts = []
        self.inline_clicks = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
        if tag == "script" and attrs.get("src"):
            self.scripts.append(attrs["src"])
        if "onclick" in attrs:
            self.inline_clicks.append((tag, attrs["onclick"]))


def _parse_index():
    parser = StaticHtmlParser()
    parser.feed(INDEX_HTML.read_text())
    return parser


def test_static_scripts_load_architecture_helpers_before_app():
    parser = _parse_index()

    assert parser.scripts[-4:] == ["/api.js", "/components.js", "/app.js", "/test_onboarding.js"]


def test_static_ui_keeps_actions_delegated():
    parser = _parse_index()

    assert parser.inline_clicks == []


def test_app_dom_bindings_exist_in_html():
    parser = _parse_index()
    required_ids = set(re.findall(r'\$\("([^"]+)"\)', APP_JS.read_text()))

    assert required_ids <= parser.ids


class WorkflowHtmlParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.workflow_selector_present = False
        self.workflow_modes = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "div" and attrs.get("id") == "workflowSelector":
            self.workflow_selector_present = True
        if "data-mode" in attrs:
            self.workflow_modes.append(attrs["data-mode"])


def test_workflow_selector_markup_exists():
    parser = WorkflowHtmlParser()
    parser.feed(INDEX_HTML.read_text())

    assert parser.workflow_selector_present, "workflowSelector container div is missing"
    assert "recording" in parser.workflow_modes, "recording workflow mode button is missing"
    assert "performing" in parser.workflow_modes, "performing workflow mode button is missing"
    assert "mixing" in parser.workflow_modes, "mixing workflow mode button is missing"


def test_workflow_selector_persistence_and_rendering_in_js():
    js_content = APP_JS.read_text()

    # Verify local storage persistence is used
    assert "latency_workflow_mode" in js_content, "localStorage key 'latency_workflow_mode' is not referenced in app.js"
    assert "localStorage.getItem" in js_content or "localStorage.setItem" in js_content, "localStorage storage calls are missing in app.js"

    # Verify recommendation rendering/adaptation logic is present for the three modes
    assert "recording" in js_content
    assert "performing" in js_content
    assert "mixing" in js_content
    assert "WORKFLOW_MODES.includes" in js_content
    assert "setWorkflowMode(" in js_content
    assert "updateWorkflowSelectorUI()" in js_content
    assert "PDC Bottleneck (Impacts Recording)" in js_content or "PDC Bottleneck" in js_content
    assert "PDC Bottleneck (Impacts Performance)" in js_content or "PDC Bottleneck" in js_content
    assert "PDC Bottleneck (Primary Mixing Target)" in js_content or "PDC Bottleneck" in js_content



def test_styles_contains_highlight_definitions():
    styles_css = (ROOT / "static" / "styles.css").read_text()
    assert ".highlight-action-link" in styles_css
    assert "highlight-flash" in styles_css
    assert "@keyframes highlight-flash" in styles_css


def test_app_js_defines_highlight_row_in_report():
    app_js = APP_JS.read_text()
    assert "function highlightRowInReport" in app_js


def test_app_js_renders_quantified_recommendations_with_br():
    app_js = APP_JS.read_text()
    assert ".replace(/\\n/g, \"<br>\")" in app_js, "app.js should convert newlines in recommendations to <br>"


def test_app_js_renders_highlight_link_with_attributes():
    app_js = APP_JS.read_text()
    assert "data-track-index" in app_js
    assert "data-track-name" in app_js
    assert "data-plugin-names" in app_js
    assert "class=\"highlight-action-link\"" in app_js


def test_troubleshooting_markup_exists():
    parser = _parse_index()
    assert "troubleshootingDetails" in parser.ids
    assert "troubleshootingWelcome" in parser.ids
    assert "troubleshootingPath" in parser.ids
    assert "troubleshootingContent" in parser.ids
    assert "symptomBackBtn" in parser.ids
    assert "symptom-delay" in parser.ids
    assert "symptom-late" in parser.ids
    assert "symptom-sluggish" in parser.ids
    assert "symptom-crackles" in parser.ids


def test_troubleshooting_js_paths_and_links():
    app_js = APP_JS.read_text()
    assert "function updateTroubleshooting()" in app_js
    assert '"delay"' in app_js
    assert '"late"' in app_js
    assert '"sluggish"' in app_js
    assert '"crackles"' in app_js

    # Verify official Ableton documentation links are present
    assert "https://help.ableton.com/hc/en-us/articles/360000843400-How-to-use-Direct-monitoring" in app_js
    assert "https://help.ableton.com/hc/en-us/articles/209072289-How-to-reduce-latency-in-Live" in app_js
    assert "https://help.ableton.com/hc/en-us/articles/360001820360-Plugin-Delay-Compensation-FAQ" in app_js
    assert "https://help.ableton.com/hc/en-us/articles/209072329-How-to-use-Driver-Error-Compensation" in app_js
    assert "https://help.ableton.com/hc/en-us/articles/209071469-Optimizing-Live-s-CPU-performance" in app_js
    assert "https://help.ableton.com/hc/en-us/articles/209771385-How-to-use-Freeze-and-Flatten" in app_js

    # Verify warnings and explanations are in the diagnostic flows
    assert "Driver Error Compensation specifically corrects the timeline placement of recorded audio. It does not affect general playback latency" in app_js or "Driver Error Compensation affects recorded placement, not general playback latency" in app_js or "Driver Error Compensation (DEC)" in app_js
    assert "Lowering the buffer size increases CPU load" in app_js
    assert "audio crackles" in app_js or "dropouts" in app_js
