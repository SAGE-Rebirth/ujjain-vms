import React, { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

// Live-camera QR scanner for the gate console. Streams the rear camera, decodes
// every frame with jsQR, and fires `onDetect(text)` the moment a QR resolves.
// Stateless about WHAT the QR means — the parent feeds the decoded token straight
// into the offline verifier, so a scan auto-verifies with no typing.
//
// Notes:
//  * facingMode 'environment' picks the back camera on phones; falls back to any.
//  * A short per-code cooldown stops the same QR re-firing 30×/sec while it sits in
//    frame — one decode → one verify, then it waits before accepting that code again.
//  * Uses the rAF timestamp for the cooldown clock (no Date.now), matching the rest
//    of the app and keeping it deterministic/SSR-safe.
export default function QrScanner({ onDetect, cooldownMs = 3500, paused = false }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const rafRef = useRef(0)
  const streamRef = useRef(null)
  const lastRef = useRef({ text: '', t: -1e9 })
  const detectRef = useRef(onDetect)
  const pausedRef = useRef(paused)
  const [err, setErr] = useState('')
  const [ready, setReady] = useState(false)
  const [flash, setFlash] = useState(false)   // brief green pulse on a successful read

  // Keep the latest props in refs so the camera effect runs ONCE (no restart on
  // every parent re-render, which would thrash the camera permission/stream).
  useEffect(() => { detectRef.current = onDetect }, [onDetect])
  useEffect(() => { pausedRef.current = paused }, [paused])

  useEffect(() => {
    let cancelled = false

    const tick = (ts) => {
      const v = videoRef.current, c = canvasRef.current
      if (v && c && v.readyState === v.HAVE_ENOUGH_DATA && !pausedRef.current) {
        const w = v.videoWidth, h = v.videoHeight
        if (w && h) {
          c.width = w; c.height = h
          const ctx = c.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(v, 0, 0, w, h)
          const { data } = ctx.getImageData(0, 0, w, h)
          const qr = jsQR(data, w, h, { inversionAttempts: 'dontInvert' })
          if (qr && qr.data) {
            const fresh = qr.data !== lastRef.current.text || ts - lastRef.current.t > cooldownMs
            if (fresh) {
              lastRef.current = { text: qr.data, t: ts }
              setFlash(true); setTimeout(() => setFlash(false), 350)
              detectRef.current?.(qr.data)
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErr('camera not supported on this device/browser'); return
      }
      try {
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
        rafRef.current = requestAnimationFrame(tick)
      } catch (e) {
        setErr(e?.name === 'NotAllowedError'
          ? 'camera permission denied — allow it in the browser, then reopen'
          : (e?.message || 'could not start camera'))
      }
    }

    start()
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [cooldownMs])

  return (
    <div className="relative rounded-2xl overflow-hidden bg-black aspect-[4/3] max-h-80">
      <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
      <canvas ref={canvasRef} className="hidden" />

      {/* reticle */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className={`w-44 h-44 rounded-2xl border-4 transition-colors
          ${flash ? 'border-emerald-400' : 'border-white/70'}`}>
          <div className="w-full h-full rounded-xl shadow-[0_0_0_2000px_rgba(0,0,0,0.35)]" />
        </div>
      </div>

      {paused && (
        <div className="absolute inset-0 bg-black/55 flex items-center justify-center text-white text-sm font-semibold">
          ⏸ scanning paused
        </div>
      )}

      <div className="absolute bottom-0 inset-x-0 p-3 text-center">
        {err
          ? <span className="inline-block bg-rose-600 text-white text-sm rounded-full px-3 py-1">{err}</span>
          : <span className="inline-block bg-black/50 text-white text-xs rounded-full px-3 py-1">
              {ready ? '📷 point the QR at the box — auto-verifies on read' : 'starting camera…'}
            </span>}
      </div>
    </div>
  )
}
