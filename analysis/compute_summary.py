#!/usr/bin/env python3

import argparse
import csv
from statistics import mean


def parse_bool(value):
    if value is None:
        return False
    v = str(value).strip().lower()
    return v in {"1", "true", "yes", "y"}


def parse_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def compute_summary(rows):
    wpm_vals = []
    ed_vals = []
    err_rate_vals = []
    elapsed_vals = []
    outliers = 0

    for row in rows:
        if parse_bool(row.get("isPractice")):
            continue

        wpm = parse_float(row.get("wpm"))
        ed = parse_float(row.get("editDistance"))
        char_count = parse_float(row.get("charCount"))
        elapsed_ms = parse_float(row.get("elapsedMs"))

        if wpm is not None:
            wpm_vals.append(wpm)
        if ed is not None:
            ed_vals.append(ed)
        if char_count and ed is not None and char_count > 0:
            err_rate_vals.append(ed / char_count)
        if elapsed_ms is not None:
            elapsed_vals.append(elapsed_ms / 1000.0)
            if elapsed_ms < 2000:
                outliers += 1

    summary = {
        "mean_wpm": mean(wpm_vals) if wpm_vals else 0,
        "mean_edit_distance": mean(ed_vals) if ed_vals else 0,
        "mean_error_rate": mean(err_rate_vals) if err_rate_vals else 0,
        "mean_elapsed_seconds": mean(elapsed_vals) if elapsed_vals else 0,
        "outlier_trials": outliers,
        "n_trials": len(wpm_vals),
    }
    return summary


def write_summary(path, summary):
    rows = [
        ("mean_wpm", summary["mean_wpm"], "Average WPM (practice excluded)"),
        ("mean_edit_distance", summary["mean_edit_distance"], "Average edit distance"),
        ("mean_error_rate", summary["mean_error_rate"], "Average editDistance / charCount"),
        ("mean_elapsed_seconds", summary["mean_elapsed_seconds"], "Average elapsed time (s)"),
        ("outlier_trials", summary["outlier_trials"], "Trials with elapsedMs < 2000"),
        ("n_trials", summary["n_trials"], "Number of non-practice trials"),
    ]

    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["metric", "value", "note"])
        for metric, value, note in rows:
            writer.writerow([metric, value, note])


def main():
    parser = argparse.ArgumentParser(description="Compute summary metrics from exported CSV.")
    parser.add_argument("csv_path", help="Path to exported CSV file")
    parser.add_argument("--output", default="summary_out.csv", help="Output CSV path")
    args = parser.parse_args()

    with open(args.csv_path, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    summary = compute_summary(rows)
    write_summary(args.output, summary)
    print(f"Wrote summary to {args.output}")


if __name__ == "__main__":
    main()
