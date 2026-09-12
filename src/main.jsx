import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { io } from 'socket.io-client'
import {
  Activity, AlertTriangle, Camera, Check, CheckCircle2, ChevronRight,
  Circle, Clock, Database, Edit2, Eye, EyeOff, FileText, FlaskConical,
  Layers, Loader2, LogOut, Maximize2, RefreshCw, RotateCcw, Save,
  Settings, Shield, Stethoscope, Trash2, Upload, User, Wifi, WifiOff, X,
  ZoomIn, ZoomOut,
} from 'lucide-react'
import { format } from 'date-fns'
import './styles.css'

/* ══════════════════════════════════════════════════
   SOCKET + API
══════════════════════════════════════════════════ */
const socket = io({ path: '/socket.io', autoConnect: false })

const api = {
  scan: (imageBase64, measurementMode) =>
    fetch('/api/analyses/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, measurementMode }),
    }).then(r => r.json()),

  saveAnalysis: body =>
    fetch('/api/analyses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()),

  listAnalyses: (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return fetch(`/api/analyses${q ? `?${q}` : ''}`).then(r => r.json())
  },

  getAnalysis: id => fetch(`/api/analyses/${id}`).then(r => r.json()),

  patchAnalysis: (id, body) =>
    fetch(`/api/analyses/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()),

  deleteAnalysis: id =>
    fetch(`/api/analyses/${id}`, { method: 'DELETE' }).then(r => r.json()),
}

/* ══════════════════════════════════════════════════
   SCANNER STATES
══════════════════════════════════════════════════ */
const S = {
  READY: 'READY',
  STABILIZING: 'STABILIZING',
  CAPTURING: 'CAPTURING',
  ANALYZING: 'ANALYZING',
  RESULT_READY: 'RESULT_READY',
  WAITING_FOR_ID: 'WAITING_FOR_ID',
  SAVING: 'SAVING',
  ERROR: 'ERROR',
}

/* ══════════════════════════════════════════════════
   LIGHTWEIGHT LIVE-FRAME INSPECTOR (browser-side)
══════════════════════════════════════════════════ */
function inspectFrame(video, canvas) {
  if (!video || video.readyState < 2 || !video.videoWidth) {
    return { present: false, message: 'Waiting for camera…', stability: 0 }
  }
  const W = 160, H = 90
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(video, 0, 0, W, H)
  const px = ctx.getImageData(16, 8, W - 32, H - 16).data
  let sum = 0, varSum = 0
  const n = px.length / 4
  for (let i = 0; i < px.length; i += 4)
    sum += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114
  const mean = sum / n
  for (let i = 0; i < px.length; i += 4) {
    const l = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114
    varSum += (l - mean) ** 2
  }
  const texture = Math.sqrt(varSum / n)
  const present = mean > 30 && mean < 230 && texture > 9
  return {
    present,
    message: present ? 'Plate region detected — hold steady' : 'Place Petri dish in the guide',
    stability: Math.min(100, Math.round(texture * 2.4)),
  }
}

function captureFrameBase64(video) {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  canvas.getContext('2d').drawImage(video, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.90)
}

/* ══════════════════════════════════════════════════
   AUTH CONTEXT (simple role-based, no real backend auth yet)
══════════════════════════════════════════════════ */
const AuthCtx = React.createContext(null)
function useAuth() { return React.useContext(AuthCtx) }
function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('ms-user')) } catch { return null }
  })
  const login = useCallback((u) => {
    setUser(u); sessionStorage.setItem('ms-user', JSON.stringify(u))
    socket.connect()
  }, [])
  const logout = useCallback(() => {
    setUser(null); sessionStorage.removeItem('ms-user'); socket.disconnect()
  }, [])
  return <AuthCtx.Provider value={{ user, login, logout }}>{children}</AuthCtx.Provider>
}

/* ══════════════════════════════════════════════════
   TOPBAR
══════════════════════════════════════════════════ */
function Topbar({ title, actions }) {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand-icon"><FlaskConical size={18} /></div>
        <span className="brand-name">MicroScan</span>
        {title && <><span className="topbar-sep">/</span><span className="topbar-title">{title}</span></>}
      </div>
      <div className="topbar-right">
        {actions}
        {user && (
          <>
            <span className={`role-badge role-${user.role}`}>{user.role}</span>
            {user.role === 'operator' && (
              <button className="tb-btn" onClick={() => nav('/dashboard')} title="Doctor Dashboard">
                <Stethoscope size={16} />
              </button>
            )}
            {user.role === 'doctor' && (
              <button className="tb-btn" onClick={() => nav('/scan')} title="Scanner">
                <Camera size={16} />
              </button>
            )}
            <button className="tb-btn" onClick={logout} title="Sign out"><LogOut size={16} /></button>
          </>
        )}
      </div>
    </header>
  )
}

/* ══════════════════════════════════════════════════
   LOGIN PAGE
══════════════════════════════════════════════════ */
function LoginPage() {
  const { login, user } = useAuth()
  const nav = useNavigate()
  if (user) return <Navigate to={user.role === 'doctor' ? '/dashboard' : '/scan'} replace />
  const choose = (role) => {
    login({ id: `user-${role}`, name: role === 'doctor' ? 'Dr. Reviewer' : 'Lab Operator', role })
    nav(role === 'doctor' ? '/dashboard' : '/scan', { replace: true })
  }
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo"><FlaskConical size={32} /></div>
        <h1>MicroScan Lab</h1>
        <p className="login-sub">Antibiotic sensitivity measurement system</p>
        <div className="login-roles">
          <button className="role-btn operator" onClick={() => choose('operator')}>
            <Camera size={24} />
            <strong>Lab Operator</strong>
            <span>Scan plates · Enter patient IDs · Save results</span>
          </button>
          <button className="role-btn doctor" onClick={() => choose('doctor')}>
            <Stethoscope size={24} />
            <strong>Doctor / Reviewer</strong>
            <span>Review results · Add notes · Finalize reports</span>
          </button>
        </div>
        <p className="login-note">
          <Shield size={12} /> Measurement tool only — not a diagnostic system
        </p>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════
   SVG DISC OVERLAY
══════════════════════════════════════════════════ */
function DiscOverlay({ result, imgW, imgH, containerW, containerH }) {
  if (!result?.discs?.length) return null

  const scaleX = containerW / imgW
  const scaleY = containerH / imgH
  const scale = Math.min(scaleX, scaleY)
  const offsetX = (containerW - imgW * scale) / 2
  const offsetY = (containerH - imgH * scale) / 2

  const tx = x => x * scale + offsetX
  const ty = y => y * scale + offsetY
  const tr = r => r * scale

  const plate = result.plate
  return (
    <svg
      className="disc-svg"
      viewBox={`0 0 ${containerW} ${containerH}`}
      width={containerW}
      height={containerH}
    >
      {plate && (
        <circle
          cx={tx(plate.centerX)} cy={ty(plate.centerY)} r={tr(plate.radiusPx)}
          fill="none" stroke="#22c55e" strokeWidth="2" strokeDasharray="6 4" opacity="0.7"
        />
      )}
      {result.discs.map(d => {
        const cx = tx(d.centerX), cy = ty(d.centerY)
        const dr = tr(d.discRadiusPx)
        const zr = tr(d.zoneRadiusPx)
        const color = d.reviewRequired ? '#f59e0b' : d.confidence >= 0.80 ? '#22c55e' : '#60a5fa'
        return (
          <g key={d.id}>
            {zr > 0 && (
              <circle cx={cx} cy={cy} r={zr} fill="none"
                stroke={color} strokeWidth="2" opacity="0.85" />
            )}
            <circle cx={cx} cy={cy} r={dr} fill="none" stroke="#fff" strokeWidth="1.5" />
            <circle cx={cx} cy={cy} r="3" fill={color} />
            <text x={cx} y={Math.max(cy - zr - 6, 12)}
              textAnchor="middle" fontSize="11" fontFamily="DM Mono,monospace"
              fill={color} fontWeight="600"
            >
              {d.antibiotic !== 'UNKNOWN' ? `${d.antibiotic}  ` : ''}{d.zoneDiameterMm} mm
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/* ══════════════════════════════════════════════════
   SCANNER PAGE
══════════════════════════════════════════════════ */
function ScannerPage() {
  const nav = useNavigate()
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const viewRef = useRef(null)
  const fileRef = useRef(null)
  const idRef = useRef(null)
  const frameLoop = useRef(null)
  const stableCount = useRef(0)
  const streamRef = useRef(null)

  const [state, setState] = useState(S.READY)
  const [cameraOn, setCameraOn] = useState(false)
  const [cameraErr, setCameraErr] = useState('')
  const [liveInfo, setLiveInfo] = useState({ present: false, message: 'Camera off — upload or enable camera', stability: 0 })
  const [result, setResult] = useState(null)
  const [overlayImg, setOverlayImg] = useState('')
  const [sampleId, setSampleId] = useState('')
  const [saveErr, setSaveErr] = useState('')
  const [uploadImg, setUploadImg] = useState('')
  const [uploadSrc, setUploadSrc] = useState(null) // file for display
  const [measureMode, setMeasureMode] = useState('full_zone_diameter')
  const [viewDims, setViewDims] = useState({ w: 640, h: 400 })
  const [backendOnline, setBackendOnline] = useState(false)
  const [cameras, setCameras] = useState([])
  const [selCamera, setSelCamera] = useState('')
  const [serverMsg, setServerMsg] = useState('')

  /* Check backend health */
  useEffect(() => {
    fetch('/api/health').then(r => r.json())
      .then(() => setBackendOnline(true))
      .catch(() => setBackendOnline(false))
  }, [])

  /* List cameras on load */
  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    navigator.mediaDevices.enumerateDevices().then(devs => {
      const cams = devs.filter(d => d.kind === 'videoinput')
      setCameras(cams)
      if (cams.length > 0 && !selCamera) setSelCamera(cams[0].deviceId)
    })
  }, [cameraOn])

  /* Track viewfinder size */
  useEffect(() => {
    if (!viewRef.current) return
    const ro = new ResizeObserver(entries => {
      const e = entries[0]
      setViewDims({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) })
    })
    ro.observe(viewRef.current)
    return () => ro.disconnect()
  }, [])

  /* Live frame inspection loop */
  useEffect(() => {
    if (!cameraOn) return
    const loop = () => {
      const info = inspectFrame(videoRef.current, canvasRef.current)
      setLiveInfo(info)
      if (info.present && state === S.READY) {
        stableCount.current += 1
        if (stableCount.current >= 22) {
          stableCount.current = 0
          autoCapture()
        }
      } else {
        stableCount.current = 0
      }
      frameLoop.current = requestAnimationFrame(loop)
    }
    frameLoop.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frameLoop.current)
  }, [cameraOn, state])

  /* Cleanup on unmount */
  useEffect(() => () => {
    cancelAnimationFrame(frameLoop.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
  }, [])

  const startCamera = async () => {
    setCameraErr('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraErr('Camera API not available in this browser.')
      return
    }
    try {
      const constraints = {
        video: {
          ...(selCamera ? { deviceId: { exact: selCamera } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1280 }, height: { ideal: 720 },
        },
        audio: false,
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
      setCameraOn(true)
      setLiveInfo({ present: false, message: 'Camera active — place Petri dish in guide', stability: 0 })
    } catch (e) {
      setCameraErr(`Camera error: ${e.message}`)
    }
  }

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setCameraOn(false)
    cancelAnimationFrame(frameLoop.current)
    setLiveInfo({ present: false, message: 'Camera off', stability: 0 })
  }

  const autoCapture = async () => {
    if (state !== S.READY) return
    setState(S.CAPTURING)
    const base64 = captureFrameBase64(videoRef.current)
    await runAnalysis(base64)
  }

  const manualCapture = async () => {
    if (state !== S.READY || !cameraOn) return
    setState(S.CAPTURING)
    const base64 = captureFrameBase64(videoRef.current)
    await runAnalysis(base64)
  }

  const runAnalysis = async (base64) => {
    setResult(null); setOverlayImg(''); setServerMsg('')
    setState(S.ANALYZING)
    try {
      if (!backendOnline) throw new Error('Backend not reachable. Start the server with: npm run server')
      const cv = await api.scan(base64, measureMode)
      if (!cv.ok) throw new Error(cv.error || 'CV analysis failed')
      setResult({ ...cv, capturedImage: base64 })
      if (cv.overlayImage) setOverlayImg(cv.overlayImage)
      setState(S.RESULT_READY)
      setTimeout(() => setState(S.WAITING_FOR_ID), 300)
      setTimeout(() => idRef.current?.focus(), 500)
    } catch (e) {
      setServerMsg(e.message)
      setState(S.ERROR)
    }
  }

  const analyzeUpload = async () => {
    if (!uploadImg || state === S.ANALYZING) return
    await runAnalysis(uploadImg)
  }

  const onFileChange = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    stopCamera()
    const reader = new FileReader()
    reader.onload = ev => {
      setUploadImg(ev.target.result)
      setUploadSrc(ev.target.result)
      setResult(null); setOverlayImg('')
      setState(S.READY)
    }
    reader.readAsDataURL(f)
    e.target.value = ''
  }

  const saveResult = async () => {
    const id = sampleId.trim()
    if (!id || !/^[a-zA-Z0-9_\-/]+$/.test(id)) {
      setSaveErr('ID must use letters, numbers, hyphens, underscores.')
      return
    }
    setSaveErr('')
    setState(S.SAVING)
    try {
      const res = await api.saveAnalysis({
        patientSampleId: id,
        cvResult: result,
        imageBase64: result?.capturedImage || uploadImg || '',
        camera: { platform: 'web', resolution: `${result?.imageWidth}x${result?.imageHeight}` },
        measurementMode: measureMode,
      })
      if (!res.ok) throw new Error(res.error || 'Save failed')
      setSampleId('')
      setResult(null)
      setOverlayImg('')
      setUploadImg('')
      setUploadSrc(null)
      setState(S.READY)
      setServerMsg(`✓ Saved ${res.analysisId}`)
      setTimeout(() => setServerMsg(''), 3000)
    } catch (e) {
      setServerMsg(e.message)
      setState(S.RESULT_READY)
    }
  }

  const reset = () => {
    setResult(null); setOverlayImg(''); setSampleId('')
    setSaveErr(''); setServerMsg(''); setState(S.READY)
  }

  const statusLabel = {
    [S.READY]: cameraOn ? 'Watching for plate…' : uploadSrc ? 'Image loaded — ready to analyze' : 'Ready',
    [S.STABILIZING]: 'Stabilizing…',
    [S.CAPTURING]: 'Capturing frame…',
    [S.ANALYZING]: 'Running CV analysis…',
    [S.RESULT_READY]: 'Measurement complete',
    [S.WAITING_FOR_ID]: 'Enter Patient / Sample ID',
    [S.SAVING]: 'Saving…',
    [S.ERROR]: 'Analysis failed',
  }[state]

  const isBusy = [S.CAPTURING, S.ANALYZING, S.SAVING].includes(state)

  return (
    <div className="page-shell">
      <Topbar title="Scanner" actions={
        <div className="tb-status">
          {backendOnline
            ? <span className="online-badge"><span className="pulse" />Server online</span>
            : <span className="offline-badge"><WifiOff size={12} />Server offline</span>}
        </div>
      } />

      <div className="scanner-layout">
        {/* ── LEFT: VIEWFINDER ── */}
        <div className="scanner-left">
          <div className="viewfinder-wrap" ref={viewRef}>
            <video ref={videoRef} autoPlay muted playsInline
              className={cameraOn ? 'vf-video visible' : 'vf-video'} />

            {uploadSrc && !cameraOn && (
              <img src={overlayImg || uploadSrc} alt="plate" className="vf-upload" />
            )}

            {!cameraOn && !uploadSrc && (
              <div className="vf-placeholder">
                <div className="guide-ring" />
                <span>PLACE PETRI DISH<br /><small>enable camera or upload image</small></span>
              </div>
            )}

            {cameraOn && result && (
              <img src={overlayImg} alt="overlay" className="vf-overlay-img" />
            )}

            {result && (
              <DiscOverlay
                result={result}
                imgW={result.imageWidth}
                imgH={result.imageHeight}
                containerW={viewDims.w}
                containerH={viewDims.h}
              />
            )}

            {/* Corner markers */}
            <div className="corner tl" /><div className="corner tr" />
            <div className="corner bl" /><div className="corner br" />
            <canvas ref={canvasRef} className="hidden-canvas" />
          </div>

          {/* Live status bar */}
          <div className={`status-bar ${state === S.ERROR ? 'st-error' : isBusy ? 'st-busy' : ''}`}>
            <div className="st-icon">
              {isBusy ? <Loader2 size={16} className="spin" />
                : state === S.ERROR ? <AlertTriangle size={16} />
                  : <Activity size={16} />}
            </div>
            <div className="st-text">
              <span className="st-label">STATUS</span>
              <strong>{statusLabel}</strong>
              {cameraOn && state === S.READY && (
                <small>{liveInfo.message} · stability {liveInfo.stability}%</small>
              )}
              {serverMsg && <small className={state === S.ERROR ? 'err-msg' : 'ok-msg'}>{serverMsg}</small>}
            </div>
            {state === S.ERROR && (
              <button className="st-retry" onClick={reset}><RotateCcw size={14} /></button>
            )}
          </div>

          {cameraErr && <div className="notice-err"><AlertTriangle size={14} />{cameraErr}</div>}

          {/* Camera controls */}
          <div className="cam-controls">
            {!cameraOn ? (
              <button className="btn-primary" onClick={startCamera} disabled={isBusy}>
                <Camera size={15} /> Enable Camera
              </button>
            ) : (
              <button className="btn-ghost" onClick={stopCamera}><X size={14} /> Stop Camera</button>
            )}
            {cameraOn && state === S.READY && (
              <button className="btn-primary" onClick={manualCapture}>
                <Eye size={15} /> Capture & Analyze
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" onChange={onFileChange} hidden />
            <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={isBusy}>
              <Upload size={14} /> Upload Image
            </button>
            {uploadSrc && state === S.READY && !isBusy && (
              <button className="btn-primary" onClick={analyzeUpload}>
                <Activity size={15} /> Analyze
              </button>
            )}
            {cameras.length > 1 && (
              <select className="cam-select" value={selCamera}
                onChange={e => { setSelCamera(e.target.value); if (cameraOn) { stopCamera(); setTimeout(startCamera, 300) } }}>
                {cameras.map(c => <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${c.deviceId.slice(0, 8)}`}</option>)}
              </select>
            )}
            <select className="cam-select" value={measureMode} onChange={e => setMeasureMode(e.target.value)}>
              <option value="full_zone_diameter">Full zone diameter</option>
              <option value="clear_zone_outside_disc">Clear width outside disc</option>
            </select>
          </div>
        </div>

        {/* ── RIGHT: RESULTS + ID ── */}
        <div className="scanner-right">
          <div className="panel-head">
            <span className="panel-kicker">MEASUREMENTS</span>
            <h2>Analysis output</h2>
          </div>

          {!result ? (
            <div className="result-empty">
              <Circle size={40} strokeWidth={1} />
              <p>No measurement yet.<br />Enable camera or upload a plate image.</p>
              <ul>
                <li><Check size={12} /> All discs detected in one pass</li>
                <li><Check size={12} /> Calibrated to 100 mm dish</li>
                <li><Check size={12} /> Real-time sync to Doctor Dashboard</li>
              </ul>
            </div>
          ) : (
            <>
              <div className="result-meta">
                <div><span>ANALYSIS TIME</span><strong>{result.durationMs} ms</strong></div>
                <div><span>DISCS FOUND</span><strong>{result.discs?.length}</strong></div>
                <div><span>CALIBRATION</span><strong>{result.calibration?.pixelsPerMm?.toFixed(2)} px/mm</strong></div>
                <div><span>QUALITY</span><strong className={result.valid ? 'c-green' : 'c-amber'}>{result.valid ? 'HIGH' : 'REVIEW'}</strong></div>
              </div>

              <table className="disc-table">
                <thead>
                  <tr><th>DISC</th><th>ANTIBIOTIC</th><th>ZONE Ø</th><th>RADIUS</th><th>CONF.</th></tr>
                </thead>
                <tbody>
                  {result.discs.map(d => (
                    <tr key={d.id} className={d.reviewRequired ? 'row-warn' : ''}>
                      <td className="disc-num">#{d.id}</td>
                      <td>
                        <AntibioticCell disc={d} result={result} setResult={setResult} />
                      </td>
                      <td><strong>{d.zoneDiameterMm.toFixed(1)}<small> mm</small></strong></td>
                      <td><span className="muted">{d.zoneRadiusMm.toFixed(1)} mm</span></td>
                      <td>
                        <span className={`conf-chip ${d.reviewRequired ? 'warn' : 'ok'}`}>
                          {Math.round(d.confidence * 100)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {!result.valid && (
                <div className="notice-warn">
                  <AlertTriangle size={14} /> Some zones need review. You can still save.
                </div>
              )}

              {/* Patient / Sample ID */}
              <div className="id-section">
                <label htmlFor="pid">PATIENT / SAMPLE ID <span className="req">REQUIRED</span></label>
                <div className="id-row">
                  <input
                    ref={idRef}
                    id="pid"
                    value={sampleId}
                    onChange={e => setSampleId(e.target.value.replace(/[^a-zA-Z0-9_\-/]/g, ''))}
                    onKeyDown={e => e.key === 'Enter' && saveResult()}
                    placeholder="PT-2026-00142"
                    disabled={isBusy}
                    autoFocus
                  />
                  <button className="btn-save" onClick={saveResult} disabled={isBusy || !sampleId.trim()}>
                    {state === S.SAVING ? <Loader2 size={16} className="spin" /> : <><Save size={15} /> Save</>}
                  </button>
                </div>
                {saveErr && <small className="err-msg">{saveErr}</small>}
                <small className="id-hint">Letters, numbers, hyphens, underscores · Press Enter to save</small>
              </div>

              <button className="btn-ghost-sm" onClick={reset} style={{ marginTop: 12 }}>
                <RotateCcw size={13} /> Discard & scan again
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* Inline antibiotic name editor */
function AntibioticCell({ disc, result, setResult }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(disc.antibiotic)
  const commit = () => {
    setEditing(false)
    setResult(prev => ({
      ...prev,
      discs: prev.discs.map(d => d.id === disc.id ? { ...d, antibiotic: val || 'UNKNOWN', manuallyCorrected: true } : d),
    }))
  }
  if (editing) return (
    <input className="ab-input" value={val} autoFocus
      onChange={e => setVal(e.target.value.toUpperCase().slice(0, 12))}
      onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()} />
  )
  return (
    <span className="ab-cell" onClick={() => setEditing(true)}>
      <span className={disc.antibiotic === 'UNKNOWN' ? 'ab-unknown' : 'ab-known'}>{disc.antibiotic}</span>
      <Edit2 size={11} className="ab-edit" />
    </span>
  )
}

/* ══════════════════════════════════════════════════
   DOCTOR DASHBOARD
══════════════════════════════════════════════════ */
function DoctorDashboard() {
  const nav = useNavigate()
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />

  const [analyses, setAnalyses] = useState([])
  const [loading, setLoading] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const [wsStatus, setWsStatus] = useState('connecting')

  const load = useCallback(async () => {
    setLoading(true)
    const r = await api.listAnalyses({ limit: 100 })
    if (r.ok) setAnalyses(r.docs)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    socket.connect()
    socket.on('connect', () => setWsStatus('connected'))
    socket.on('disconnect', () => setWsStatus('disconnected'))
    socket.on('NEW_ANALYSIS', (data) => {
      setAnalyses(prev => [data, ...prev])
      setNewCount(n => n + 1)
    })
    socket.on('ANALYSIS_UPDATED', ({ analysisId, status }) => {
      setAnalyses(prev => prev.map(a =>
        (a.analysisId || a._id) === analysisId ? { ...a, status } : a
      ))
    })
    return () => {
      socket.off('NEW_ANALYSIS')
      socket.off('ANALYSIS_UPDATED')
      socket.off('connect')
      socket.off('disconnect')
    }
  }, [])

  const grouped = useMemo(() => {
    const g = { NEW: [], RECEIVED: [], UNDER_REVIEW: [], REVIEWED: [], FINALIZED: [] }
    for (const a of analyses) {
      const st = a.status || 'NEW'
      if (g[st]) g[st].push(a)
    }
    return g
  }, [analyses])

  const markRead = () => setNewCount(0)

  return (
    <div className="page-shell">
      <Topbar title="Doctor Dashboard" actions={
        <div className="tb-status">
          <span className={`ws-badge ws-${wsStatus}`}>
            {wsStatus === 'connected' ? <><span className="pulse" />Live</> : <><WifiOff size={12} />Offline</>}
          </span>
          {newCount > 0 && (
            <button className="new-badge" onClick={markRead}>
              {newCount} new result{newCount > 1 ? 's' : ''}
            </button>
          )}
        </div>
      } />

      <div className="dashboard-layout">
        {loading && (
          <div className="dash-loading"><Loader2 size={24} className="spin" /><span>Loading analyses…</span></div>
        )}

        {!loading && analyses.length === 0 && (
          <div className="dash-empty">
            <Stethoscope size={40} strokeWidth={1} />
            <p>No analyses yet. Scan a plate to see results appear here in real-time.</p>
          </div>
        )}

        {['NEW', 'UNDER_REVIEW', 'REVIEWED', 'FINALIZED'].map(status => (
          grouped[status].length > 0 && (
            <div key={status} className="status-group">
              <div className={`group-header gh-${status.toLowerCase()}`}>
                <span className="group-dot" />
                {status.replace('_', ' ')}
                <span className="group-count">{grouped[status].length}</span>
              </div>
              <div className="cards-grid">
                {grouped[status].map(a => (
                  <AnalysisCard key={a.analysisId || a._id} analysis={a}
                    onClick={() => nav(`/analysis/${a.analysisId}`)} />
                ))}
              </div>
            </div>
          )
        ))}
      </div>
    </div>
  )
}

function AnalysisCard({ analysis, onClick }) {
  const ts = analysis.timestamp ? format(new Date(analysis.timestamp), 'HH:mm · dd MMM') : ''
  const discs = analysis.discs || []
  return (
    <div className="analysis-card" onClick={onClick}>
      <div className="card-top">
        <span className="card-id">{analysis.patientSampleId || analysis.analysisId}</span>
        <span className={`status-chip sc-${(analysis.status || 'NEW').toLowerCase()}`}>
          {analysis.status || 'NEW'}
        </span>
      </div>
      {ts && <div className="card-time"><Clock size={11} />{ts}</div>}
      <div className="card-discs">
        {discs.slice(0, 6).map((d, i) => (
          <div key={i} className="card-disc-row">
            <span className={d.antibiotic === 'UNKNOWN' ? 'muted' : ''}>{d.antibiotic}</span>
            <span>{d.zoneDiameterMm?.toFixed(1)} mm</span>
          </div>
        ))}
        {discs.length > 6 && <div className="card-more">+{discs.length - 6} more</div>}
      </div>
      <div className="card-footer">
        <span>{discs.length} zone{discs.length !== 1 ? 's' : ''} measured</span>
        <ChevronRight size={14} />
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════
   ANALYSIS DETAIL
══════════════════════════════════════════════════ */
function AnalysisDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />

  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [showOverlay, setShowOverlay] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.getAnalysis(id).then(r => {
      if (r.ok) { setDoc(r.doc); setNotes(r.doc.doctorNotes || '') }
      setLoading(false)
    })
  }, [id])

  const setStatus = async (status) => {
    setSaving(true)
    const r = await api.patchAnalysis(id, {
      status, reviewedBy: user.name, reviewedAt: new Date().toISOString(),
    })
    if (r.ok) { setDoc(r.doc); setMsg(`Status → ${status}`) }
    setSaving(false)
    setTimeout(() => setMsg(''), 2500)
  }

  const saveNotes = async () => {
    setSaving(true)
    const r = await api.patchAnalysis(id, { doctorNotes: notes })
    if (r.ok) { setDoc(r.doc); setMsg('Notes saved') }
    setSaving(false)
    setTimeout(() => setMsg(''), 2000)
  }

  if (loading) return (
    <div className="page-shell">
      <Topbar title="Analysis Detail" />
      <div className="dash-loading"><Loader2 size={24} className="spin" /></div>
    </div>
  )
  if (!doc) return (
    <div className="page-shell">
      <Topbar title="Analysis Detail" />
      <div className="dash-empty"><p>Analysis not found.</p><button className="btn-ghost" onClick={() => nav(-1)}>Go back</button></div>
    </div>
  )

  const imgSrc = showOverlay ? (doc.overlayImageBase64 || doc.imageBase64) : doc.imageBase64

  return (
    <div className="page-shell">
      <Topbar title={`Analysis · ${doc.analysisId}`} actions={
        <button className="tb-btn" onClick={() => nav(-1)}><X size={16} /></button>
      } />
      <div className="detail-layout">
        {/* Left: image */}
        <div className="detail-left">
          {imgSrc ? (
            <>
              <img src={imgSrc} alt="plate" className="detail-img" />
              <div className="overlay-toggle">
                <button className={`ov-btn ${showOverlay ? 'active' : ''}`} onClick={() => setShowOverlay(true)}>
                  <Layers size={14} /> Overlay
                </button>
                <button className={`ov-btn ${!showOverlay ? 'active' : ''}`} onClick={() => setShowOverlay(false)}>
                  <Eye size={14} /> Original
                </button>
              </div>
            </>
          ) : <div className="no-image"><Eye size={32} /><p>No image stored</p></div>}
        </div>

        {/* Right: measurements + review */}
        <div className="detail-right">
          <div className="detail-meta">
            <div><span>PATIENT / SAMPLE ID</span><strong>{doc.patientSampleId}</strong></div>
            <div><span>ANALYSIS ID</span><strong>{doc.analysisId}</strong></div>
            <div><span>DATE</span><strong>{format(new Date(doc.timestamp), 'dd MMM yyyy HH:mm')}</strong></div>
            <div><span>STATUS</span><span className={`status-chip sc-${doc.status?.toLowerCase()}`}>{doc.status}</span></div>
          </div>

          <table className="disc-table">
            <thead>
              <tr><th>#</th><th>ANTIBIOTIC</th><th>ZONE Ø</th><th>RADIUS</th><th>CONF.</th></tr>
            </thead>
            <tbody>
              {(doc.discs || []).map(d => (
                <tr key={d.id} className={d.reviewRequired ? 'row-warn' : ''}>
                  <td className="disc-num">#{d.id}</td>
                  <td>{d.antibiotic === 'UNKNOWN'
                    ? <span className="ab-unknown">UNKNOWN</span>
                    : <span className="ab-known">{d.antibiotic}</span>}
                    {d.manuallyCorrected && <span className="corrected-badge">edited</span>}
                  </td>
                  <td><strong>{d.zoneDiameterMm?.toFixed(1)}<small> mm</small></strong></td>
                  <td><span className="muted">{d.zoneRadiusMm?.toFixed(1)} mm</span></td>
                  <td><span className={`conf-chip ${d.reviewRequired ? 'warn' : 'ok'}`}>{Math.round(d.confidence * 100)}%</span></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="calibration-info">
            <span>Calibration: {doc.calibration?.method} · {doc.calibration?.pixelsPerMm?.toFixed(2)} px/mm</span>
            <span>Mode: {doc.measurementMode}</span>
          </div>

          {/* Doctor notes */}
          <div className="notes-section">
            <label>DOCTOR NOTES</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4}
              placeholder="Add clinical notes, observations, corrections…" />
            <button className="btn-ghost-sm" onClick={saveNotes} disabled={saving}>
              {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Save notes
            </button>
          </div>

          {/* Status actions */}
          <div className="review-actions">
            {msg && <div className="ok-msg" style={{ marginBottom: 8 }}>{msg}</div>}
            {doc.status === 'NEW' && (
              <button className="btn-primary" onClick={() => setStatus('UNDER_REVIEW')}>
                <Eye size={15} /> Start Review
              </button>
            )}
            {doc.status === 'UNDER_REVIEW' && (
              <button className="btn-primary" onClick={() => setStatus('REVIEWED')}>
                <CheckCircle2 size={15} /> Mark Reviewed
              </button>
            )}
            {doc.status === 'REVIEWED' && (
              <button className="btn-save" onClick={() => setStatus('FINALIZED')}>
                <Shield size={15} /> Finalize
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* useParams hook for plain react-router */
function useParams() {
  const match = window.location.pathname.match(/\/analysis\/(.+)/)
  return { id: match?.[1] || '' }
}

/* ══════════════════════════════════════════════════
   APP ROOT
══════════════════════════════════════════════════ */
function RequireAuth({ role, children }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (role && user.role !== role && user.role !== 'admin') return <Navigate to="/login" replace />
  return children
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/scan" element={<RequireAuth><ScannerPage /></RequireAuth>} />
          <Route path="/dashboard" element={<RequireAuth><DoctorDashboard /></RequireAuth>} />
          <Route path="/analysis/:id" element={<RequireAuth><AnalysisDetail /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

createRoot(document.getElementById('root')).render(<App />)
