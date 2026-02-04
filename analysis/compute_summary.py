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


def compute_wpm(char_count, elapsed_ms):
    if char_count is None or elapsed_ms is None or elapsed_ms <= 0:
        return None
    minutes = elapsed_ms / 1000.0 / 60.0
    return (char_count / 5.0) / minutes


def edit_distance(a, b):
    s = str(a or "")
    t = str(b or "")
    n = len(s)
    m = len(t)
    if n == 0:
        return m
    if m == 0:
        return n

    prev = list(range(m + 1))
    curr = [0] * (m + 1)
    for i in range(1, n + 1):
        curr[0] = i
        s_char = s[i - 1]
        for j in range(1, m + 1):
            cost = 0 if s_char == t[j - 1] else 1
            delete = prev[j] + 1
            insert = curr[j - 1] + 1
            sub = prev[j - 1] + cost
            curr[j] = min(delete, insert, sub)
        prev, curr = curr, prev

    return prev[m]


def compute_summary(rows):
    wpm_vals = []
    ed_vals = []
    err_rate_vals = []
    elapsed_vals = []
    outliers = 0

    for row in rows:
        trial_type = str(row.get("trialType") or "").strip().lower()
        if trial_type in {"practice", "learning", "free"}:
            continue

        typed = row.get("typed") or ""
        target = row.get("target") or ""
        char_count = len(typed)
        elapsed_ms = parse_float(row.get("elapsedMs"))
        ed = edit_distance(target, typed)
        wpm = compute_wpm(char_count, elapsed_ms)

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
