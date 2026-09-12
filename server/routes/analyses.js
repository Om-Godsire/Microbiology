const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Analysis = require('../models/Analysis');

const router = express.Router();

/* ─── helpers ─── */
function generateAnalysisId() {
  const year = new Date().getFullYear();
  const rand = Math.floor(Math.random() * 900000) + 100000;
  return `AST-${year}-${rand}`;
}

function runPythonCV(payload) {
  return new Promise((resolve, reject) => {
    // Use the ML pipeline (MobileSAM + GMM) — falls back to Hough disc detection
    // if torch/mobile_sam are not yet installed.
    const scriptPath = path.join(__dirname, '../cv/ml_pipeline.py');
    const proc = spawn('python', [scriptPath], { timeout: 120000 }); // 2 min for SAM inference

    let stdout = '';
    let stderr = '';

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();

    proc.stdout.on('data', d => (stdout += d));
    proc.stderr.on('data', d => (stderr += d));

    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`Python ML exited ${code}: ${stderr.slice(0, 400)}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`ML output parse error: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', err => reject(new Error(`Python spawn failed: ${err.message}`)));
  });
}

/* ─── POST /api/scan ─── */
/* Accepts base64 image, runs Python OpenCV, returns measurements (no DB save yet) */
router.post('/scan', async (req, res) => {
  const { imageBase64, measurementMode = 'full_zone_diameter' } = req.body;
  if (!imageBase64) return res.status(400).json({ ok: false, error: 'imageBase64 required' });

  try {
    const cvResult = await runPythonCV({ imageBase64, measurementMode });
    res.json(cvResult);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─── POST /api/analyses ─── */
/* Save completed analysis to MongoDB, emits socket event */
router.post('/', async (req, res) => {
  const { patientSampleId, cvResult, imageBase64, camera, measurementMode } = req.body;

  if (!patientSampleId || !cvResult) {
    return res.status(400).json({ error: 'patientSampleId and cvResult required' });
  }

  const analysisId = generateAnalysisId();

  const doc = new Analysis({
    analysisId,
    patientSampleId: patientSampleId.trim(),
    camera: camera || {},
    plate: cvResult.plate,
    calibration: cvResult.calibration,
    measurementMode: measurementMode || 'full_zone_diameter',
    discs: cvResult.discs || [],
    durationMs: cvResult.durationMs,
    imageBase64: imageBase64 || '',
    overlayImageBase64: cvResult.overlayImage || '',
    valid: cvResult.valid ?? false,
    source: cvResult.source || 'opencv',
    status: 'NEW',
    syncStatus: 'synced',
  });

  try {
    await doc.save();

    // Emit real-time event via socket (attached to req.app)
    const io = req.app.get('io');
    if (io) {
      io.emit('NEW_ANALYSIS', {
        analysisId: doc.analysisId,
        patientSampleId: doc.patientSampleId,
        timestamp: doc.timestamp,
        discCount: doc.discs.length,
        discs: doc.discs.map(d => ({
          id: d.id,
          antibiotic: d.antibiotic,
          zoneDiameterMm: d.zoneDiameterMm,
          confidence: d.confidence,
        })),
        status: doc.status,
        overlayImageBase64: doc.overlayImageBase64,
      });
    }

    res.status(201).json({ ok: true, analysisId: doc.analysisId });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Duplicate analysis ID, retry' });
    }
    res.status(500).json({ error: err.message });
  }
});

/* ─── GET /api/analyses ─── */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = parseInt(req.query.skip) || 0;
    const status = req.query.status;

    const filter = status ? { status } : {};
    const docs = await Analysis.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .select('-imageBase64 -overlayImageBase64'); // don't send large blobs in list

    const total = await Analysis.countDocuments(filter);
    res.json({ ok: true, total, docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── GET /api/analyses/:id ─── */
router.get('/:id', async (req, res) => {
  try {
    const doc = await Analysis.findOne({ analysisId: req.params.id });
    if (!doc) return res.status(404).json({ error: 'Analysis not found' });
    res.json({ ok: true, doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── PATCH /api/analyses/:id ─── */
/* Doctor: update status, notes, disc antibiotic names */
router.patch('/:id', async (req, res) => {
  const allowed = ['status', 'doctorNotes', 'reviewedBy', 'reviewedAt', 'discs'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  try {
    const doc = await Analysis.findOneAndUpdate(
      { analysisId: req.params.id },
      { $set: updates },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const io = req.app.get('io');
    if (io) io.emit('ANALYSIS_UPDATED', { analysisId: doc.analysisId, status: doc.status });

    res.json({ ok: true, doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── DELETE /api/analyses/:id ─── */
router.delete('/:id', async (req, res) => {
  try {
    await Analysis.deleteOne({ analysisId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
