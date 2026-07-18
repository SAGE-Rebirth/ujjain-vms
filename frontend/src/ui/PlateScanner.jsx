import React, { useEffect, useRef, useState } from 'react'
import { createWorker } from 'tesseract.js'

// Live-camera number-plate reader (ANPR) for the gate console. Streams the rear
// camera, OCRs a cropped band each cycle, and fires `onPlate(plate)` when a read
// looks like an Indian plate. The parent submits that plate to the offline
// verifier — the plate → booking lookup is fully local, so the gate decides even
// with zero internet. OCR itself is a CONVENIENCE layer: if it can't read a plate,
// the parent falls back to QR + manual entry (which never need the model at all).
//
// Notes:
//  * Tesseract's worker + English model download ONCE (first use) and are then
//    browser-cached, so subsequent reads work offline. The gate's guaranteed
//    offline paths remain QR (self-contained crypto) and the typed code.
//  * We OCR a centre band (where a driver lines the plate up) at a throttled
//    cadence — full-frame OCR every frame would peg the CPU on a Pi.
//  * A per-plate cooldown stops the same plate re-firing while it sits in frame.

// Indian plate, spacing-agnostic: MP09AB1234 / MP 09 AB 1234 / DL1CAB1234, and
// the older/ BH-series-ish shapes. We normalize to alnum then pattern-match.
const PLATE_RE = /\b([A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{3,4})\b/

function normalize(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}
function extractPlate(text) {
  // Try each OCR line: strip to alnum, then match a plate shape inside it.
  for (const line of (text || '').split('\n')) {
    const m = normalize(line).match(PLATE_RE)
    if (m) return m[1]
  }
  const m = normalize(text).match(PLATE_RE)
  return m ? m[1] : null
}

export default function PlateScanner({ onPlate, cooldownMs = 4000, paused = false }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const workerRef = useRef(null)
  const timerRef = useRef(0)
  const busyRef = useRef(false)
  const lastRef = useRef({ plate: '', t: -1e9 })
  const onPlateRef = useRef(onPlate)
  const pausedRef = useRef(paused)
  const [err, setErr] = useState('')
  const [ready, setReady] = useState(false)
  const [live, setLive] = useState('')     // last raw OCR guess (operator feedback)
  const [flash, setFlash] = useState(false)

  useEffect(() => { onPlateRef.current = onPlate }, [onPlate])
  useEffect(() => { pausedRef.current = paused }, [paused])

  useEffect(() => {
    let cancelled = false

    // Grab the centre band of the frame, upscale + grayscale it, and OCR that.
    const readOnce = async () => {
      const v = videoRef.current, c = canvasRef.current, w = workerRef.current
      if (!v || !c || !w || busyRef.current || pausedRef.current) return
      if (v.readyState !== v.HAVE_ENOUGH_DATA) return
      const vw = v.videoWidth, vh = v.videoHeight
      if (!vw || !vh) return
      busyRef.current = true
      try {
        // Centre band ≈ where the driver frames the plate; 2× upscale aids OCR.
        const bw = Math.round(vw * 0.8), bh = Math.round(vh * 0.32)
        const sx = Math.round((vw - bw) / 2), sy = Math.round((vh - bh) / 2)
        const scale = 2
        c.width = bw * scale; c.height = bh * scale
        const ctx = c.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(v, sx, sy, bw, bh, 0, 0, c.width, c.height)
        // Grayscale + hard threshold — plates are high-contrast, this kills noise.
        const img = ctx.getImageData(0, 0, c.width, c.height)
        const d = img.data
        for (let i = 0; i < d.length; i += 4) {
          const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
          const v2 = g > 110 ? 255 : 0
          d[i] = d[i + 1] = d[i + 2] = v2
        }
        ctx.putImageData(img, 0, 0)
        const { data } = await w.recognize(c)
        if (cancelled) return
        const plate = extractPlate(data.text)
        setLive(plate || normalize(data.text).slice(0, 12))
        if (plate) {
          const now = performance.now()
          const fresh = plate !== lastRef.current.plate || now - lastRef.current.t > cooldownMs
          if (fresh) {
            lastRef.current = { plate, t: now }
            setFlash(true); setTimeout(() => setFlash(false), 400)
            onPlateRef.current?.(plate)
          }
        }
      } catch { /* transient OCR/frame error — next tick retries */ }
      finally { busyRef.current = false }
    }

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErr('camera not supported on this device/browser'); return
      }
      try {
        const worker = await createWorker('eng')
        // Restrict to plate characters — big accuracy win over free-form OCR.
        await worker.setParameters({
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        })
        if (cancelled) { await worker.terminate(); return }
        workerRef.current = worker

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }, audio: false,
        })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        const v = videoRef.current
        v.srcObject = stream
        v.setAttribute('playsinline', 'true')
        await v.play()
        setReady(true)
        // Throttled OCR loop — recognize is async and self-gated by busyRef.
        timerRef.current = setInterval(readOnce, 1200)
      } catch (e) {
        setErr(e?.name === 'NotAllowedError'
          ? 'camera permission denied — allow it in the browser, then reopen'
          : (e?.message || 'could not start camera / OCR'))
      }
    }

    start()
    return () => {
      cancelled = true
      clearInterval(timerRef.current)
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null }
    }
  }, [cooldownMs])

  return (
    <div className="relative rounded-2xl overflow-hidden bg-black aspect-[4/3] max-h-80">
      <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
      <canvas ref={canvasRef} className="hidden" />

      {/* plate-shaped reticle — line the number plate inside the box */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className={`w-[78%] h-[30%] rounded-lg border-4 transition-colors
          ${flash ? 'border-emerald-400' : 'border-white/70'}`}>
          <div className="w-full h-full rounded-md shadow-[0_0_0_2000px_rgba(0,0,0,0.4)]" />
        </div>
      </div>

      {paused && (
        <div className="absolute inset-0 bg-black/55 flex items-center justify-center text-white text-sm font-semibold">
          ⏸ reading paused
        </div>
      )}

      <div className="absolute bottom-0 inset-x-0 p-3 text-center">
        {err
          ? <span className="inline-block bg-rose-600 text-white text-sm rounded-full px-3 py-1">{err}</span>
          : <span className="inline-block bg-black/50 text-white text-xs rounded-full px-3 py-1 font-mono">
              {ready ? (live ? `reading… ${live}` : '🔎 line the number plate in the box') : 'starting camera + OCR…'}
            </span>}
      </div>
    </div>
  )
}
