# MicroScan Lab

A camera-first microbiology laboratory workflow prototype for measuring antibiotic inhibition zones on Petri dishes.

## Current MVP

- Continuous scanner state machine with automatic detection simulation
- Optional live browser camera permission and preview
- Dynamic multi-disc plate analysis model
- Pixel-to-mm calibration using known disc diameter
- Configurable measurement mode: full zone diameter or clear width outside disc
- Confidence-driven review flagging
- Local-first save to browser storage
- Lightweight operator flow: scan → measurement → Patient/Sample ID → save → ready
- Recent local results list and synchronization status placeholder
- Explicitly measurement-only: it does not diagnose, prescribe, or classify susceptibility
- Supplied reference-plate ground truth fixture in `data/reference-plate-001.measurements.json`
- Supplied reference image and spatial annotation fixture in `data/images/` and `data/annotations/`
- Standard Petri-dish calibration is configured as 100 mm / 10 cm; antibiotic identity remains a separate OCR or laboratory-layout task

## Run locally

```bash
npm install
npm run dev
```

Then open the Vite URL shown in the terminal. For a production build:

```bash
npm run build
npm run preview
```

## Architecture

The current prototype keeps the shared analysis model separate from the UI so the same engine can later be moved into a native mobile/desktop shell or a service worker. The browser camera adapter is intentionally isolated from the scanner workflow.

## Next production milestones

1. Replace the simulated analysis adapter with a validated CV/ML pipeline and benchmark it on a representative dataset.
2. Add a durable backend with authenticated scanner/reviewer roles, audit trail, encrypted image storage, and conflict-safe synchronization.
3. Add a focused manual review canvas for low-confidence zones.
4. Add native camera adapters for Android/iOS/desktop UVC cameras.
5. Validate calibration, accuracy, repeatability, and performance under laboratory conditions before operational use.

## Measurement evaluation

The supplied reference plate has operator-provided full patch diameters and approximate disc-center annotations. Score a prediction JSON against it with:

```bash
python3 scripts/evaluate_measurements.py data/reference-plate-001.measurements.json predictions.json
```

The first acceptance threshold is an initial absolute tolerance of ±2 mm. The spatial annotation explicitly marks the patch boundaries as pending precise manual annotation; approximate disc centers must not be treated as pixel-perfect ground truth.

## Safety boundary

This is laboratory workflow support software. It reports physical measurements only and is not a diagnostic or treatment recommendation system.
