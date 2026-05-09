# LatencyManager

Local Ableton Live plugin latency dashboard.

## Setup

```bash
pip install -r requirements.txt
```

Requires [AbletonOSC](https://github.com/ideoforms/AbletonOSC) installed in Ableton Live.

## Run

1. Open Ableton Live with AbletonOSC enabled.
2. Reload AbletonOSC once after installing this tool:

   ```bash
   python3 app.py --reload-abletonosc
   ```

3. Start the dashboard:

   ```bash
   python3 app.py
   ```

4. Open `http://127.0.0.1:8799`.

## Features

- **Manual scan** — click Scan Now to export and analyze latency for the current Live set.
- **Auto-refresh** — toggle automatic scanning at 15s, 30s, or 60s intervals. Pauses when the browser tab is hidden and backs off after repeated failures.
- **Top 10 worst offenders** — ranked by max latency with instance details, track locations, and stacked latency totals.
- **Connection monitoring** — status polling every 5 seconds with online/offline indicators.

## Data

Scan reports are cached in `~/Library/Application Support/LatencyManager/`.
