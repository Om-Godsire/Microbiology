import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, Camera, Check, ChevronDown, CircleHelp, Clock3, Cloud, Cpu, Database, Eye, FlaskConical, Gauge, LockKeyhole, Maximize2, RefreshCw, Settings2, ShieldCheck, Wifi, X } from 'lucide-react'
import './styles.css'

const STATES = { READY:'READY', DETECTED:'PLATE_DETECTED', STABILIZING:'STABILIZING', ANALYZING:'ANALYZING', RESULT:'RESULT_READY', ID:'WAITING_FOR_ID', SAVING:'SAVING' }
const demoDiscs = [
  { antibiotic:'CIP', zone:28.4, confidence:.98, x:31, y:34, r:8 },
  { antibiotic:'GEN', zone:17.8, confidence:.94, x:60, y:28, r:7 },
  { antibiotic:'AMX', zone:21.2, confidence:.91, x:70, y:54, r:7 },
  { antibiotic:'TET', zone:12.0, confidence:.72, x:48, y:69, r:7 },
  { antibiotic:'CRO', zone:31.4, confidence:.97, x:28, y:62, r:8 },
  { antibiotic:'AMP', zone:8.6, confidence:.86, x:54, y:46, r:6 },
]

function analyzePlate({ measurementMode='full_zone_diameter', pixelsPerMm=4.8 }={}) {
  const discs = demoDiscs.map((d, index) => {
    const discDiameterPx = d.r * 2 * pixelsPerMm / 3.3
    const zoneDiameterPx = d.zone * pixelsPerMm
    const zoneRadiusPx = zoneDiameterPx / 2
    const reported = measurementMode === 'clear_zone_outside_disc' ? Math.max(0, d.zone - 6) : d.zone
    return { id:index+1, ...d, discCenter:[Math.round(d.x*10),Math.round(d.y*10)], discRadiusPx:Number(discDiameterPx.toFixed(1)), zoneRadiusPx:Number(zoneRadiusPx.toFixed(1)), zoneDiameterMm:Number(reported.toFixed(1)), zoneRadiusMm:Number((reported/2).toFixed(1)), corrected:false, reviewRequired:d.confidence < .8 }
  })
  return { id:`plate-${Date.now()}`, capturedAt:new Date().toISOString(), plate:{ center:[500,500], radiusPx:430, confidence:.97 }, discs, calibration:{ method:'known_disc_diameter', knownDiscDiameterMm:6, pixelsPerMm, resolution:'1280 × 720' }, measurementMode, durationMs:842, valid:discs.every(d=>!d.reviewRequired) }
}

function getSaved() { try { return JSON.parse(localStorage.getItem('microscan-results') || '[]') } catch { return [] } }
function getCaptureCount() { try { return Number(localStorage.getItem('microscan-capture-count') || 0) } catch { return 0 } }
function pct(value) { return `${Math.round(value*100)}%` }

function inspectLiveFrame(video, canvas) {
  if (!video || video.readyState < 2 || !video.videoWidth) return { present:false, quality:'Waiting for camera…', brightness:0, stability:0 }
  canvas.width = 160; canvas.height = 90
  const ctx = canvas.getContext('2d', { willReadFrequently:true })
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const pixels = ctx.getImageData(24, 10, 112, 70).data
  let sum = 0, variance = 0
  for (let i=0; i<pixels.length; i+=4) sum += (pixels[i]*.299 + pixels[i+1]*.587 + pixels[i+2]*.114)
  const count = pixels.length / 4; const brightness = sum / count
  for (let i=0; i<pixels.length; i+=4) { const l=pixels[i]*.299 + pixels[i+1]*.587 + pixels[i+2]*.114; variance += (l-brightness)**2 }
  const texture = Math.sqrt(variance / count)
  const present = brightness > 28 && brightness < 235 && texture > 8
  return { present, quality:present?'Plate region detected':'Center the plate in the guide', brightness:Math.round(brightness), stability:Math.min(100, Math.round(texture*2.2)) }
}

function analyzeCapturedFrame(video, { measurementMode='full_zone_diameter', knownDiscDiameterMm=6 }={}) {
  if (!video || video.readyState < 2 || !video.videoWidth) return { ok:false, message:'No captured frame is available.' }
  const canvas=document.createElement('canvas'); const width=320; const height=Math.max(180, Math.round(video.videoHeight/video.videoWidth*width)); canvas.width=width; canvas.height=height
  const ctx=canvas.getContext('2d', { willReadFrequently:true }); ctx.drawImage(video,0,0,width,height)
  const data=ctx.getImageData(0,0,width,height).data; const gray=new Float32Array(width*height)
  let mean=0
  for(let y=0;y<height;y++) for(let x=0;x<width;x++){ const i=(y*width+x)*4; const l=data[i]*.299+data[i+1]*.587+data[i+2]*.114; gray[y*width+x]=l; mean+=l }
  mean/=gray.length
  // Candidate plate: choose the strongest local contrast circle around the image center.
  const cx=width/2, cy=height/2; const maxR=Math.min(width,height)*.46; let edgeScore=0, edgeRadius=maxR
  for(let r=maxR*.55;r<=maxR;r+=4){ let inner=0,outer=0,count=0; for(let a=0;a<Math.PI*2;a+=Math.PI/24){ const x=Math.round(cx+Math.cos(a)*r), y=Math.round(cy+Math.sin(a)*r); const ix=Math.max(0,Math.min(width-1,x)), iy=Math.max(0,Math.min(height-1,y)); const ox=Math.max(0,Math.min(width-1,Math.round(cx+Math.cos(a)*(r-7)))), oy=Math.max(0,Math.min(height-1,Math.round(cy+Math.sin(a)*(r-7)))); inner+=gray[iy*width+ix]; outer+=gray[oy*width+ox]; count++ } const score=Math.abs(inner/count-outer/count); if(score>edgeScore){edgeScore=score;edgeRadius=r} }
  if(edgeScore<3) return { ok:false, message:'No clear Petri dish boundary detected. Improve lighting and center the plate.' }
  const candidates=[]
  for(let y=12;y<height-12;y+=3) for(let x=12;x<width-12;x+=3){ const dx=x-cx,dy=y-cy; if(Math.hypot(dx,dy)>edgeRadius*.84) continue; const center=gray[y*width+x]; let ring=0,n=0; for(let a=0;a<Math.PI*2;a+=Math.PI/6){ring+=gray[Math.round(y+Math.sin(a)*7)*width+Math.round(x+Math.cos(a)*7)];n++} const contrast=ring/n-center; if(contrast>18) candidates.push({x,y,contrast}) }
  candidates.sort((a,b)=>b.contrast-a.contrast); const discs=[]
  for(const c of candidates){ if(discs.some(d=>Math.hypot(d.x-c.x,d.y-c.y)<18)) continue; discs.push(c); if(discs.length>=12) break }
  if(discs.length===0) return { ok:false, message:'Petri dish detected, but no antibiotic discs were confidently detected.' }
  const discPx=12; const pixelsPerMm=discPx/knownDiscDiameterMm
  const measured=discs.map((d,index)=>{ let bestR=discPx*1.4; let bestDrop=0; for(let r=discPx*1.4;r<Math.min(edgeRadius*.32,discPx*5);r+=2){ let ring=0,n=0; for(let a=0;a<Math.PI*2;a+=Math.PI/18){ const x=Math.max(0,Math.min(width-1,Math.round(d.x+Math.cos(a)*r))),y=Math.max(0,Math.min(height-1,Math.round(d.y+Math.sin(a)*r))); ring+=gray[y*width+x];n++ } const next=ring/n; if(next>bestDrop){bestDrop=next;bestR=r} } const diameterMm=(measurementMode==='clear_zone_outside_disc' ? Math.max(0,(bestR*2-discPx)/pixelsPerMm) : bestR*2/pixelsPerMm); const confidence=Math.max(.35,Math.min(.9,d.contrast/80)); return {id:index+1,antibiotic:'UNKNOWN',zoneDiameterMm:Number(diameterMm.toFixed(1)),zoneRadiusMm:Number((diameterMm/2).toFixed(1)),discRadiusPx:discPx/2,zoneRadiusPx:bestR,discCenter:[d.x,d.y],x:d.x/width*100,y:d.y/height*100,confidence,reviewRequired:true,corrected:false} })
  return { ok:true, id:`plate-${Date.now()}`, capturedAt:new Date().toISOString(), plate:{center:[cx,cy],radiusPx:edgeRadius,confidence:Math.min(.9,.45+edgeScore/40)}, discs:measured, calibration:{method:'configured_reference_disc',knownDiscDiameterMm,pixelsPerMm:Number(pixelsPerMm.toFixed(2)),resolution:`${video.videoWidth} × ${video.videoHeight}`}, measurementMode,durationMs:0,valid:false,source:'classical_cv_baseline' }
}

function App() {
  const [state, setState] = useState(STATES.READY)
  const [result, setResult] = useState(null)
  const [sampleId, setSampleId] = useState('')
  const [results, setResults] = useState(getSaved)
  const [cameraOn, setCameraOn] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [measurementMode, setMeasurementMode] = useState('full_zone_diameter')
  const [showSettings, setShowSettings] = useState(false)
  const [liveMetrics, setLiveMetrics] = useState({ present:false, quality:'Waiting for camera…', brightness:0, stability:0 })
  const [captureCount, setCaptureCount] = useState(getCaptureCount)
  const [captureNotice, setCaptureNotice] = useState('')
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const frameLoopRef = useRef(null)
  const stableFramesRef = useRef(0)

  const isBusy = [STATES.DETECTED,STATES.STABILIZING,STATES.ANALYZING,STATES.SAVING].includes(state)
  const status = useMemo(() => ({ [STATES.READY]:'Looking for plate…', [STATES.DETECTED]:'Plate detected', [STATES.STABILIZING]:'Hold steady…', [STATES.ANALYZING]:'Measuring all zones…', [STATES.RESULT]:'Measurement complete', [STATES.ID]:'Patient / Sample ID required', [STATES.SAVING]:'Saved · syncing in background' }[state]), [state])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); if (frameLoopRef.current) cancelAnimationFrame(frameLoopRef.current); streamRef.current?.getTracks().forEach(t=>t.stop()) }, [])

  useEffect(() => {
    if (!cameraOn) { setLiveMetrics({ present:false, quality:'Demo mode ready', brightness:0, stability:0 }); return }
    const sample = () => {
      const metrics = inspectLiveFrame(videoRef.current, canvasRef.current)
      setLiveMetrics(metrics)
      if (metrics.present && state === STATES.READY) {
        stableFramesRef.current += 1
        if (stableFramesRef.current >= 18) { stableFramesRef.current = 0; runScan(true) }
      } else if (!metrics.present) stableFramesRef.current = 0
      frameLoopRef.current = requestAnimationFrame(sample)
    }
    frameLoopRef.current = requestAnimationFrame(sample)
    return () => { if (frameLoopRef.current) cancelAnimationFrame(frameLoopRef.current) }
  }, [cameraOn, state])

  const startCamera = async () => {
    setCameraError('')
    if (!navigator.mediaDevices?.getUserMedia) { setCameraError('Live camera is not available in this browser. Demo mode remains active.'); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 } }, audio:false })
      streamRef.current = stream; setCameraOn(true); if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(()=>{}) }
    } catch { setCameraError('Camera permission unavailable. Reconnect the camera or use demo mode.') }
  }
  const stopCamera = () => { streamRef.current?.getTracks().forEach(t=>t.stop()); streamRef.current=null; setCameraOn(false) }

  const captureReferenceFrame = () => {
    const video = videoRef.current
    if (!video || video.readyState < 2 || !video.videoWidth) { setCameraError('No live frame is available yet. Keep the camera active and try again.'); return false }
    const canvas = document.createElement('canvas'); canvas.width=video.videoWidth; canvas.height=video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    const nextCount = captureCount + 1
    try {
      localStorage.setItem('microscan-last-frame', JSON.stringify({ capturedAt:new Date().toISOString(), width:canvas.width, height:canvas.height, image:canvas.toDataURL('image/jpeg', .82), metrics:liveMetrics }))
      localStorage.setItem('microscan-capture-count', String(nextCount))
    } catch { setCameraError('Frame captured but local storage is full. Export or clear saved captures before continuing.'); return false }
    setCaptureCount(nextCount); setCaptureNotice(`Reference frame ${nextCount} captured locally. Actual CV measurement is the next pipeline milestone.`); setState(STATES.READY)
    return true
  }

  const runScan = (automatic=false) => {
    if (isBusy || state===STATES.ID) return
    if (cameraOn) { captureReferenceFrame(); return }
    setResult(null); setState(STATES.DETECTED)
    timerRef.current=setTimeout(()=>{ setState(STATES.STABILIZING); timerRef.current=setTimeout(()=>{ setState(STATES.ANALYZING); timerRef.current=setTimeout(()=>{ const analysis=analyzeCapturedFrame(videoRef.current,{measurementMode}); if(analysis.ok){setResult(analysis);setState(STATES.RESULT)} else {setCaptureNotice(analysis.message);setState(STATES.READY)} }, 900) }, 750) }, 500)
  }
  const saveResult = () => {
    const clean = sampleId.trim()
    if (!clean || !/^[a-zA-Z0-9_-]+$/.test(clean)) return
    setState(STATES.SAVING)
    const record={...result, sampleId:clean, savedAt:new Date().toISOString(), syncStatus:'queued'}
    const next=[record,...results].slice(0,20); localStorage.setItem('microscan-results',JSON.stringify(next)); setResults(next)
    setTimeout(()=>{ setSampleId(''); setResult(null); setState(STATES.READY) }, 900)
  }
  const reset = () => { setResult(null); setSampleId(''); setState(STATES.READY) }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><FlaskConical size={19}/></div><div><strong>MICROSCAN</strong><span>LAB OPERATIONS</span></div></div>
      <div className="topbar-right"><div className="online"><span className="pulse"/> SYSTEM ONLINE</div><div className="top-divider"/><button className="icon-btn" title="Help"><CircleHelp size={19}/></button><button className="icon-btn" onClick={()=>setShowSettings(v=>!v)} title="Settings"><Settings2 size={19}/></button><div className="avatar">OL</div></div>
    </header>
    <main className="workspace">
      <section className="hero-row"><div><div className="eyebrow"><span className="live-dot"/> CONTINUOUS SCANNER</div><h1>Plate analysis <em>station</em></h1><p className="subtitle">Place a Petri dish in view. Measurement begins automatically.</p></div><div className="session-card"><div className="session-label">CURRENT SESSION</div><div className="session-value"><span className="session-dot"/> Operator / Lab 01</div></div></section>
      {captureNotice && <div className="notice capture-notice"><Check size={15}/>{captureNotice}<button onClick={()=>setCaptureNotice('')}><X size={14}/></button></div>}
      <section className="main-grid">
        <div className="scanner-panel">
          <div className="panel-heading"><div><span className="panel-kicker">LIVE FEED</span><h2>Camera preview</h2></div><div className="camera-actions"><span className={`camera-state ${cameraOn?'active':''}`}><span/> {cameraOn?'CAMERA ACTIVE':'DEMO MODE'}</span><button className="small-btn" onClick={cameraOn?stopCamera:startCamera}><Camera size={15}/>{cameraOn?'Stop camera':'Enable camera'}</button></div></div>
          <div className="viewfinder" onClick={runScan}>
            <video ref={videoRef} autoPlay muted playsInline className={cameraOn?'video-visible':''}/><div className="feed-placeholder"><div className="grid-lines"/><div className="dish-guide"><div className="guide-ring"/><span>PLACE PETRI DISH<br/><small>inside the guide</small></span></div></div>
            <div className="corner tl"/><div className="corner tr"/><div className="corner bl"/><div className="corner br"/>
            {result && <div className="overlay-plate"><div className="overlay-circle"/>{result.discs.map(d=><div key={d.id} className="disc-overlay" style={{left:`${d.x}%`,top:`${d.y}%`}}><span>{d.zoneDiameterMm} mm</span></div>)}</div>}
            <canvas ref={canvasRef} className="analysis-canvas"/><div className="feed-caption"><span><Maximize2 size={13}/> 1280 × 720</span><span><Activity size={13}/> 24 FPS</span></div>
          </div>
          {cameraError && <div className="notice warning"><X size={15}/>{cameraError}</div>}
          <div className="status-strip"><div className="status-icon"><Activity size={18}/></div><div><span className="status-label">SCANNER STATUS</span><strong>{status}</strong><small className="live-quality">{cameraOn ? `${liveMetrics.quality} · stability ${liveMetrics.stability}%` : 'Demo mode · manual trigger available'}</small></div><div className="status-time">{isBusy ? 'PROCESSING' : state===STATES.READY?'READY':'ACTION REQUIRED'}</div></div>
          <div className="scan-actions"><button className="primary-btn" disabled={isBusy || state===STATES.ID} onClick={()=>runScan(false)}>{isBusy?<><RefreshCw className="spin" size={17}/> Processing…</>:<><Eye size={17}/> {cameraOn?'Capture reference frame':'Run demo measurement'}</>}</button>{state!==STATES.READY && <button className="ghost-btn" onClick={reset}>Reset</button>}</div>
        </div>
        <aside className="side-panel">
          <div className="side-heading"><div><span className="panel-kicker">ANALYSIS OUTPUT</span><h2>Latest result</h2></div><span className={`confidence-badge ${result?.valid?'good':''}`}>{result ? `${result.discs.length} ZONES` : 'WAITING'}</span></div>
          {!result ? <div className="empty-state"><div className="empty-icon"><Gauge size={23}/></div><strong>Ready for a plate</strong><p>Keep the camera active. A stable plate is measured automatically in one pass.</p><div className="empty-specs"><span><Check size={14}/> Multi-disc detection</span><span><Check size={14}/> Local-first save</span><span><Check size={14}/> Confidence validation</span></div></div> : <>
            <div className="result-summary"><div><span>MEASUREMENT TIME</span><strong>{(result.durationMs/1000).toFixed(2)}s</strong></div><div><span>CALIBRATION</span><strong>{result.calibration.pixelsPerMm} px/mm</strong></div><div><span>QUALITY</span><strong className="quality">{result.valid?'HIGH':'REVIEW'}</strong></div></div>
            <div className="table-wrap"><table><thead><tr><th>DISC</th><th>ZONE DIAMETER</th><th>CONFIDENCE</th></tr></thead><tbody>{result.discs.map(d=><tr key={d.id}><td><span className="disc-id">{d.antibiotic}</span></td><td><strong>{d.zoneDiameterMm.toFixed(1)} <small>mm</small></strong><span className="radius">r {d.zoneRadiusMm.toFixed(1)} mm</span></td><td><span className={`confidence ${d.reviewRequired?'review':''}`}><span/>{pct(d.confidence)}</span></td></tr>)}</tbody></table></div>
            {!result.valid && <div className="notice warning"><Eye size={15}/> One zone needs focused review before saving.</div>}
            <div className="id-card"><label htmlFor="sample-id">PATIENT / SAMPLE ID <span>REQUIRED</span></label><div className="input-row"><input id="sample-id" autoFocus value={sampleId} onChange={e=>setSampleId(e.target.value.replace(/[^a-zA-Z0-9_-]/g,''))} onKeyDown={e=>e.key==='Enter'&&saveResult()} placeholder="e.g. PT-2026-00142"/><button className="save-btn" onClick={saveResult} disabled={!sampleId.trim()}><Check size={17}/> Save</button></div><small>Use letters, numbers, hyphens, or underscores.</small></div>
          </>}
        </aside>
      </section>
      <section className="lower-grid">
        <div className="info-card"><div className="card-title"><span className="panel-kicker">WORKFLOW</span><h3>Hands-free scanning</h3></div><div className="workflow"><span className="step done"><i>01</i><b>DETECT</b><small>Plate in view</small></span><span className="line done"/><span className={`step ${state===STATES.STABILIZING?'current':result?'done':''}`}><i>02</i><b>MEASURE</b><small>All zones at once</small></span><span className="line"/><span className={`step ${state===STATES.ID||state===STATES.SAVING?'current':state===STATES.READY&&results.length?'done':''}`}><i>03</i><b>SAVE</b><small>ID then continue</small></span></div></div>
        <div className="info-card system-card"><div className="card-title"><span className="panel-kicker">LOCAL-FIRST SYSTEM</span><h3>Sync health</h3></div><div className="health-row"><div className="health-item"><Database size={17}/><span>Local storage<strong>Ready</strong></span></div><div className="health-item"><Cloud size={17}/><span>Background sync<strong>Standby</strong></span></div><div className="health-item"><ShieldCheck size={17}/><span>Reference frames<strong>{captureCount} captured</strong></span></div></div></div>
      </section>
      <section className="history-section"><div className="history-heading"><div><span className="panel-kicker">LOCAL HISTORY</span><h2>Recent measurements</h2></div><span className="muted">{results.length} saved locally</span></div>{results.length===0?<div className="history-empty"><Clock3 size={17}/> Saved plates will appear here after the first scan.</div>:<div className="history-list">{results.slice(0,4).map(r=><div className="history-row" key={r.id}><span className="history-check"><Check size={15}/></span><strong>{r.sampleId}</strong><span>{r.discs.length} zones</span><span>{new Date(r.savedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span><em>Saved locally</em></div>)}</div>}</section>
      <footer><span><LockKeyhole size={13}/> Measurement support tool · Not a diagnostic system</span><span>v0.1 MVP · <a href="https://github.com/Om-Godsire/Microbiology" target="_blank">Repository</a></span></footer>
    </main>
    {showSettings && <div className="settings-pop"><div className="settings-title"><Settings2 size={16}/> Scanner settings <button onClick={()=>setShowSettings(false)}><X size={15}/></button></div><label>Measurement convention<select value={measurementMode} onChange={e=>setMeasurementMode(e.target.value)}><option value="full_zone_diameter">Full inhibition-zone diameter</option><option value="clear_zone_outside_disc">Clear width outside disc</option></select></label><div className="setting-note"><Wifi size={14}/> Live sync backend will be connected in the next milestone.</div></div>}
  </div>
}

createRoot(document.getElementById('root')).render(<App />)
