#!/usr/bin/env python3
import argparse
import csv
import math
import random
from pathlib import Path


LAYOUTS = ["qwerty", "very_good", "pretty_good", "sp_identity", "sp_reverse_b"]
LAYOUT_EFFECTS = {
    "qwerty": 2.0,
    "very_good": 4.0,
    "pretty_good": 1.0,
    "sp_identity": -1.0,
    "sp_reverse_b": -3.0,
}
LAYOUT_ERROR_BASE = {
    "qwerty": 1,
    "very_good": 1,
    "pretty_good": 2,
    "sp_identity": 3,
    "sp_reverse_b": 4,
}
PHRASES = [
    "the quick brown fox",
    "human computer interaction",
    "a simple keyboard prototype",
    "typing on a screen keyboard",
    "we measure speed and errors",
    "practice makes perfect",
]
TRIAL_EFFECTS = [-5.0, -1.5, -0.5, 0.5, 1.5, 2.5]
ORDER_EFFECTS = {1: -1.0, 2: 0.4, 3: 0.8, 4: 0.4, 5: 0.0}


def seeded_order(layouts, seed_text):
    rng = random.Random(seed_text)
    order = list(layouts)
    rng.shuffle(order)
    return order


def compute_elapsed_ms(char_count, wpm):
    minutes = (char_count / 5.0) / max(wpm, 0.1)
    return int(round(minutes * 60000))


def main():
    parser = argparse.ArgumentParser(description="Generate a fake typing study dataset.")
    parser.add_argument("--output", default="analysis/fake_dataset_20_participants.csv")
    parser.add_argument("--participants", type=int, default=20)
    parser.add_argument("--seed", default="kbdstudy-demo")
    parser.add_argument("--practice", type=int, default=1)
    parser.add_argument("--trials-per-layout", type=int, default=5)
    args = parser.parse_args()

    total_trials = args.practice + args.trials_per_layout
    header = [
        "sessionId",
        "participantId",
        "trialId",
        "layoutId",
        "trialType",
        "learningKind",
        "target",
        "typed",
        "startTimeMs",
        "endTimeMs",
        "elapsedMs",
        "backspaceCount",
        "keypressCount",
    ]

    rows = []
    for p in range(1, args.participants + 1):
        pid = f"P{p:03d}"
        session_id = f"session_{pid}"
        base_skill = 30 + p * 0.7
        order = seeded_order(LAYOUTS, f"{args.seed}-{pid}")
        trial_id = 1
        base_time = 1700000000000 + (p - 1) * 1000000
        time_cursor = base_time
        prev_layout = None
        rng = random.Random(f"{args.seed}:{pid}")

        for layout_index, layout_id in enumerate(order, start=1):
            for trial_index in range(total_trials):
                phrase_id = trial_index % len(PHRASES)
                target = PHRASES[phrase_id]
                is_practice = trial_index < args.practice
                trial_type = "practice" if is_practice else "main"
                edit_distance = LAYOUT_ERROR_BASE[layout_id] + (1 if is_practice else 0) + rng.randint(0, 1)
                if p == 6 and layout_id == "sp_reverse_b" and trial_index == 4:
                    edit_distance = 8
                if p == 12 and layout_id == "sp_identity" and trial_index == 3:
                    edit_distance = 7
                if p == 18 and layout_id == "pretty_good" and trial_index == 2:
                    edit_distance = 6

                typed_chars = list(target)
                if edit_distance > 0:
                    indices = [i for i, ch in enumerate(typed_chars) if ch != " "]
                    rng.shuffle(indices)
                    for pos in indices[:edit_distance]:
                        typed_chars[pos] = "x" if typed_chars[pos] != "x" else "y"
                typed = "".join(typed_chars)
                char_count = len(typed)

                carryover = 0.0
                if prev_layout == "qwerty":
                    carryover = 0.6
                elif prev_layout == "sp_reverse_b":
                    carryover = -0.6

                order_effect = ORDER_EFFECTS.get(layout_index, 0.0)
                trial_effect = TRIAL_EFFECTS[min(trial_index, len(TRIAL_EFFECTS) - 1)]
                noise = rng.uniform(-1.2, 1.2)
                wpm = base_skill + LAYOUT_EFFECTS[layout_id] + order_effect + trial_effect + carryover + noise
                wpm = max(18, wpm)
                wpm = round(wpm, 1)

                backspace = edit_distance + (1 if is_practice else 0) + (p % 2)
                keypress = char_count + backspace + (1 if edit_distance > 0 else 0)

                elapsed_ms = compute_elapsed_ms(char_count, wpm)
                if p == 3 and layout_id == "qwerty" and trial_index == total_trials - 1:
                    elapsed_ms = 1500

                start_ms = time_cursor
                end_ms = start_ms + elapsed_ms
                time_cursor = end_ms + 400

                rows.append(
                    [
                        session_id,
                        pid,
                        str(trial_id),
                        layout_id,
                        trial_type,
                        "",
                        target,
                        typed,
                        str(start_ms),
                        str(end_ms),
                        str(elapsed_ms),
                        str(backspace),
                        str(keypress),
                    ]
                )
                trial_id += 1
            prev_layout = layout_id

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


if __name__ == "__main__":
    main()
