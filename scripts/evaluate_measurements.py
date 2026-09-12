#!/usr/bin/env python3
"""Score predicted full patch diameters against a reference fixture.

Usage:
  python3 scripts/evaluate_measurements.py data/reference-plate-001.measurements.json predictions.json

Predictions may be either {"measurements": [{"label": "MRP", "diameterMm": 30}]} or a bare list.
"""
import json
import sys
from pathlib import Path


def load(path):
    with Path(path).open() as f:
        value = json.load(f)
    return value.get("measurements", value) if isinstance(value, dict) else value


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip())
        return 2
    truth = {row["label"]: float(row["diameterMm"]) for row in load(sys.argv[1])}
    predicted = {row["label"]: float(row["diameterMm"]) for row in load(sys.argv[2])}
    labels = sorted(set(truth) | set(predicted))
    errors = []
    print("label\ttruth_mm\tpredicted_mm\terror_mm\twithin_2mm")
    for label in labels:
        actual = truth.get(label)
        estimate = predicted.get(label)
        if actual is None or estimate is None:
            print(f"{label}\t{actual if actual is not None else '-'}\t{estimate if estimate is not None else '-'}\tmissing\tfalse")
            continue
        error = abs(actual - estimate)
        errors.append(error)
        print(f"{label}\t{actual:.1f}\t{estimate:.1f}\t{error:.1f}\t{str(error <= 2).lower()}")
    if not errors:
        print("No comparable labeled measurements.")
        return 1
    mae = sum(errors) / len(errors)
    within = sum(error <= 2 for error in errors)
    print(f"\nMAE: {mae:.2f} mm")
    print(f"Within ±2 mm: {within}/{len(errors)} ({within/len(errors):.0%})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
