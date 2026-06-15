#!/usr/bin/env python3
"""
ROLE: DEPRECATED — do not use. Kept for reference only.

DEPRECATED — replaced by collect-input.py

This script no longer ships with the experiment workspace.
Use collect-input.py instead — it produces input.json directly without
requiring raw CSV exports.

    python .featbit-release-decision/scripts/collect-input.py <experiment-slug>

See references/data-source-guide.md for §FeatBit / §Database / §Custom patterns.
"""

print(__doc__)
raise SystemExit(1)


# ── ORIGINAL (kept for reference only, not executed) ──────────────────────────
"""
Data export script — populate experiment CSV files from your data source.

Usage:
    python .featbit-release-decision/scripts/export-data.py <experiment-slug>

Writes:
    .featbit-release-decision/experiments/<slug>/exposure-log.csv
    .featbit-release-decision/experiments/<slug>/events-log.csv

---
CUSTOMIZATION GUIDE

This script is a placeholder. Replace the `fetch_exposures()` and `fetch_events()`
functions with your own data source — FeatBit REST API, a database query, a log
file parser, or any combination.

The only contract: output the correct column schema into each CSV file.

  exposure-log.csv columns:  user_key, variant, timestamp
  events-log.csv columns:    user_key, event_name, timestamp

See references/data-export-guide.md for copy-paste FeatBit API examples and
SQL query templates.
---
"""

import csv
import re
import sys
from pathlib import Path


# ── Configuration ─────────────────────────────────────────────────────────────
# Replace these with your actual values, or load from environment variables:
#
#   import os
#   FEATBIT_API_TOKEN = os.environ["FEATBIT_TOKEN"]

FEATBIT_API_BASE  = "https://your-featbit.example.com"
FEATBIT_API_TOKEN = "your-api-token-here"
ENV_ID            = "your-environment-id"


# ── Data Fetching — REPLACE THESE ─────────────────────────────────────────────

def fetch_exposures(flag_key: str, observation_start: str) -> list[dict]:
    """
    Return a list of exposure records for the given flag within the window.

    Each record must be a dict with keys: user_key, variant, timestamp
    Example:
        [
            {"user_key": "user-001", "variant": "control",   "timestamp": "2026-03-01T10:22:31Z"},
            {"user_key": "user-002", "variant": "treatment",  "timestamp": "2026-03-01T10:22:45Z"},
        ]

    REPLACE THIS with your actual data source. Options:
    - FeatBit REST API  → see references/data-export-guide.md Option A
    - Application DB    → see references/data-export-guide.md Option B
    - JSON log files    → see references/data-export-guide.md Option C
    """
    raise NotImplementedError(
        "Replace fetch_exposures() with your actual data source.\n"
        "See .featbit-release-decision/scripts/README-customize.md or "
        "skills/experiment-workspace/references/data-export-guide.md for examples."
    )


def fetch_events(event_names: list[str], observation_start: str) -> list[dict]:
    """
    Return a list of metric event records for the given events within the window.

    Each record must be a dict with keys: user_key, event_name, timestamp
    Example:
        [
            {"user_key": "user-001", "event_name": "cta_clicked", "timestamp": "2026-03-01T11:05:00Z"},
            {"user_key": "user-002", "event_name": "cta_clicked", "timestamp": "2026-03-01T11:12:45Z"},
        ]

    REPLACE THIS with your actual data source. Options:
    - FeatBit REST API  → see references/data-export-guide.md Option A
    - Application DB    → see references/data-export-guide.md Option B
    - JSON log files    → see references/data-export-guide.md Option C
    """
    raise NotImplementedError(
        "Replace fetch_events() with your actual data source.\n"
        "See .featbit-release-decision/scripts/README-customize.md or "
        "skills/experiment-workspace/references/data-export-guide.md for examples."
    )


# ── Write Output ──────────────────────────────────────────────────────────────

def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    print(f"Written {len(rows)} rows → {path}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main(slug: str) -> None:
    base      = Path(".featbit-release-decision") / "experiments" / slug
    defn_path = base / "definition.md"

    if not defn_path.exists():
        print(f"ERROR: {defn_path} not found.")
        print("Start the experiment first — ask the agent to create the experiment folder.")
        sys.exit(1)

    text = defn_path.read_text()

    flag_key_m = re.search(r"^flag_key:\s*(.+)$", text, re.MULTILINE)
    start_m    = re.search(r"start:\s*(\S+)", text)

    if not flag_key_m or not start_m:
        print("ERROR: could not parse flag_key or observation_window.start from definition.md")
        sys.exit(1)

    flag_key          = flag_key_m.group(1).strip()
    observation_start = start_m.group(1).strip()

    # Collect all metric event names from definition.md
    primary_m    = re.search(r"^primary_metric_event:\s*(.+)$", text, re.MULTILINE)
    list_items_m = re.findall(r"^\s+-\s+(.+)$", text, re.MULTILINE)
    all_events   = (
        ([primary_m.group(1).strip()] if primary_m else []) + list_items_m
    )
    all_events = list(dict.fromkeys(filter(None, all_events)))  # deduplicate, preserve order

    # Export exposure log
    exposures = fetch_exposures(flag_key, observation_start)
    write_csv(
        base / "exposure-log.csv",
        exposures,
        fieldnames=["user_key", "variant", "timestamp"],
    )

    # Export events log
    events = fetch_events(all_events, observation_start)
    write_csv(
        base / "events-log.csv",
        events,
        fieldnames=["user_key", "event_name", "timestamp"],
    )

    print(f"\nNext: run the analysis →")
    print(f"  python .featbit-release-decision/scripts/analyze-bayesian.py {slug}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python export-data.py <experiment-slug>")
        sys.exit(1)
    main(sys.argv[1])
