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

    assert parser.scripts[-3:] == ["/api.js", "/components.js", "/app.js"]


def test_static_ui_keeps_actions_delegated():
    parser = _parse_index()

    assert parser.inline_clicks == []


def test_app_dom_bindings_exist_in_html():
    parser = _parse_index()
    required_ids = set(re.findall(r'\$\("([^"]+)"\)', APP_JS.read_text()))

    assert required_ids <= parser.ids
