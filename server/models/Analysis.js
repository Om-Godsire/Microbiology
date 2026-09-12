const mongoose = require('mongoose');

const DiscSchema = new mongoose.Schema({
  id: Number,
  antibiotic: { type: String, default: 'UNKNOWN' },
  centerX: Number,
  centerY: Number,
  discRadiusPx: Number,
  discDiameterMm: Number,
  zoneRadiusPx: Number,
  zoneDiameterPx: Number,
  zoneRadiusMm: Number,
  zoneDiameterMm: Number,
  confidence: Number,
  reviewRequired: Boolean,
  manuallyCorrected: { type: Boolean, default: false },
  detectionMethod: String,
}, { _id: false });

const AnalysisSchema = new mongoose.Schema({
  analysisId: { type: String, unique: true, required: true },
  patientSampleId: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  scannerDeviceId: { type: String, default: 'WEB_SCANNER' },
  camera: {
    platform: String,
    resolution: String,
    label: String,
  },
  plate: {
    centerX: Number,
    centerY: Number,
    radiusPx: Number,
    diameterMm: Number,
  },
  calibration: {
    method: String,
    knownDiameterMm: Number,
    pixelsPerMm: Number,
    resolution: String,
  },
  measurementMode: {
    type: String,
    enum: ['full_zone_diameter', 'clear_zone_outside_disc'],
    default: 'full_zone_diameter',
  },
  discs: [DiscSchema],
  durationMs: Number,
  imageBase64: String,         // original captured frame (JPEG base64)
  overlayImageBase64: String,  // OpenCV-annotated overlay
  status: {
    type: String,
    enum: ['NEW', 'RECEIVED', 'UNDER_REVIEW', 'REVIEWED', 'FINALIZED'],
    default: 'NEW',
  },
  syncStatus: {
    type: String,
    enum: ['local', 'synced'],
    default: 'synced',
  },
  doctorNotes: { type: String, default: '' },
  reviewedBy: String,
  reviewedAt: Date,
  valid: Boolean,
  source: String,
  softwareVersion: { type: String, default: '1.0.0' },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Analysis', AnalysisSchema);
