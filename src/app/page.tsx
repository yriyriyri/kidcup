"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

const VIDEO_COUNT = 5;
const SWIPE_DISTANCE = 0.04;
const SWIPE_TIME_MS = 160;
const COOLDOWN_MS = 30;

const BASE_IMPULSE = 2;
const DISTANCE_IMPULSE_MULTIPLIER = 55;
const VELOCITY_IMPULSE_MULTIPLIER = 420;
const MAX_SPIN_VELOCITY = 15;
const SPIN_DAMPING_PER_SECOND = 0.18;
const MIN_SPIN_VELOCITY = 0.03;

type Point = {
  x: number;
  t: number;
};

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

type DebugValues = {
  spinVelocity: number;
  spinPosition: number;
  deltaX: number;
  swipeVelocity: number;
  impulse: number;
};

export default function Home() {
  const webcamRef = useRef<HTMLVideoElement | null>(null);
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);
  const spinRafRef = useRef<number | null>(null);
  const videoFrameCallbackIdRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [showDebug, setShowDebug] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const historyRef = useRef<Point[]>([]);
  const lastSwipeAtRef = useRef(0);
  const lastDetectTimestampRef = useRef(0);
  const reinitializingRef = useRef(false);
  const startedLoopRef = useRef(false);
  const mountedRef = useRef(true);
  const warnedDetectErrorRef = useRef(false);

  const spinVelocityRef = useRef(0);
  const spinPositionRef = useRef(0);
  const lastSpinFrameAtRef = useRef(0);

  const preloadedVideosRef = useRef<Map<number, HTMLVideoElement>>(new Map());

  const debugRef = useRef<DebugValues>({
    spinVelocity: 0,
    spinPosition: 0,
    deltaX: 0,
    swipeVelocity: 0,
    impulse: 0,
  });

  const [currentIndex, setCurrentIndex] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [trackerReady, setTrackerReady] = useState(false);
  const [videosReadyCount, setVideosReadyCount] = useState(0);
  const [videosReady, setVideosReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [debugSpinVelocity, setDebugSpinVelocity] = useState(0);
  const [debugSpinPosition, setDebugSpinPosition] = useState(0);
  const [debugDeltaX, setDebugDeltaX] = useState(0);
  const [debugSwipeVelocity, setDebugSwipeVelocity] = useState(0);
  const [debugImpulse, setDebugImpulse] = useState(0);

  const videoSources = useMemo(
    () => Array.from({ length: VIDEO_COUNT }, (_, i) => `/videos/${i + 1}.mp4`),
    []
  );

  const appReady = cameraReady && trackerReady && videosReady;

  function describeUnknownError(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    if (typeof err === "string") return err;

    if (err && typeof err === "object") {
      const maybeEvent = err as Event & {
        type?: string;
        target?: EventTarget | null;
      };

      const parts = [
        "Non-Error thrown",
        "isTrusted" in maybeEvent
          ? `isTrusted=${String((maybeEvent as Event).isTrusted)}`
          : null,
        "type" in maybeEvent ? `type=${String(maybeEvent.type)}` : null,
        maybeEvent.target instanceof HTMLVideoElement
          ? `target=<video> readyState=${maybeEvent.target.readyState} networkState=${maybeEvent.target.networkState} currentSrc=${maybeEvent.target.currentSrc}`
          : null,
      ].filter(Boolean);

      return parts.join(" | ");
    }

    return String(err);
  }

  function resetDetectionState() {
    historyRef.current = [];
    lastSwipeAtRef.current = 0;
    lastDetectTimestampRef.current = 0;
    warnedDetectErrorRef.current = false;
  }

  function stopLoop() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const video = webcamRef.current as VideoWithFrameCallback | null;
    if (
      video &&
      videoFrameCallbackIdRef.current !== null &&
      typeof video.cancelVideoFrameCallback === "function"
    ) {
      video.cancelVideoFrameCallback(videoFrameCallbackIdRef.current);
      videoFrameCallbackIdRef.current = null;
    }

    startedLoopRef.current = false;
  }

  function stopSpinLoop() {
    if (spinRafRef.current !== null) {
      cancelAnimationFrame(spinRafRef.current);
      spinRafRef.current = null;
    }
    lastSpinFrameAtRef.current = 0;
    spinPositionRef.current = 0;
    debugRef.current.spinVelocity = 0;
    debugRef.current.spinPosition = 0;
  }

  function addMomentum(amount: number) {
    spinVelocityRef.current = Math.min(
      MAX_SPIN_VELOCITY,
      spinVelocityRef.current + amount
    );
    debugRef.current.spinVelocity = spinVelocityRef.current;

    if (spinRafRef.current === null) {
      startSpinLoop();
    }
  }

  function startSpinLoop() {
    const tick = (now: number) => {
      if (!mountedRef.current) return;

      if (lastSpinFrameAtRef.current === 0) {
        lastSpinFrameAtRef.current = now;
      }

      const dtSec = (now - lastSpinFrameAtRef.current) / 1000;
      lastSpinFrameAtRef.current = now;

      let velocity = spinVelocityRef.current;

      if (velocity <= MIN_SPIN_VELOCITY) {
        spinVelocityRef.current = 0;
        stopSpinLoop();
        return;
      }

      spinPositionRef.current += velocity * dtSec;

      const wholeSteps = Math.floor(spinPositionRef.current);
      if (wholeSteps > 0) {
        spinPositionRef.current -= wholeSteps;
        setCurrentIndex((prev) => (prev + wholeSteps) % VIDEO_COUNT);
      }

      velocity *= Math.pow(SPIN_DAMPING_PER_SECOND, dtSec);
      spinVelocityRef.current = velocity;

      debugRef.current.spinVelocity = velocity;
      debugRef.current.spinPosition = spinPositionRef.current;

      spinRafRef.current = requestAnimationFrame(tick);
    };

    spinRafRef.current = requestAnimationFrame(tick);
  }

  function waitForIdle(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        (
          window as Window & {
            requestIdleCallback?: (
              cb: (deadline: IdleDeadline) => void
            ) => number;
          }
        ).requestIdleCallback?.(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error("Fullscreen toggle failed:", err);
    }
  }

  useEffect(() => {
    const id = window.setInterval(() => {
      setDebugSpinVelocity(debugRef.current.spinVelocity);
      setDebugSpinPosition(debugRef.current.spinPosition);
      setDebugDeltaX(debugRef.current.deltaX);
      setDebugSwipeVelocity(debugRef.current.swipeVelocity);
      setDebugImpulse(debugRef.current.impulse);
    }, 100);

    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
  
      const key = event.key.toLowerCase();
  
      if (key === "d") {
        setShowDebug((prev) => !prev);
      }
  
      if (key === "f") {
        void toggleFullscreen();
      }
    };
  
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
  
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("fullscreenchange", onFullscreenChange);
  
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function init() {
      try {
        await setupCamera();
        if (cancelled) return;
      } catch (err) {
        const msg = `[setupCamera] ${describeUnknownError(err)}`;
        console.error(msg, err);
        if (!cancelled && mountedRef.current) setError(msg);
        return;
      }

      try {
        await setupHandTracking();
        if (cancelled) return;
      } catch (err) {
        const msg = `[setupHandTracking] ${describeUnknownError(err)}`;
        console.error(msg, err);
        if (!cancelled && mountedRef.current) setError(msg);
        return;
      }

      try {
        await preloadVideosSequentially();
        if (cancelled) return;
      } catch (err) {
        const msg = `[preloadVideos] ${describeUnknownError(err)}`;
        console.error(msg, err);
        if (!cancelled && mountedRef.current) setError(msg);
      }
    }

    void init();

    return () => {
      cancelled = true;
      mountedRef.current = false;

      stopLoop();
      stopSpinLoop();

      handLandmarkerRef.current?.close();
      handLandmarkerRef.current = null;

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      for (const video of preloadedVideosRef.current.values()) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      preloadedVideosRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!appReady) return;
    if (startedLoopRef.current) return;
    startLoop();
    return () => stopLoop();
  }, [appReady]);

  useEffect(() => {
    if (!videosReady) return;
    void showVideo(currentIndex);
  }, [currentIndex, videosReady]);

  async function setupCamera() {
    const webcam = webcamRef.current;
    if (!webcam) throw new Error("Webcam element not found.");

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    streamRef.current = stream;
    webcam.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      webcam.onloadedmetadata = () => resolve();
      webcam.onerror = (ev) => reject(ev);
    });

    await webcam.play();

    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (
          webcam.readyState >= 2 &&
          webcam.videoWidth > 0 &&
          webcam.videoHeight > 0
        ) {
          resolve();
          return;
        }
        requestAnimationFrame(check);
      };

      webcam.onerror = (ev) => reject(ev);
      check();
    });

    if (!mountedRef.current) return;
    setCameraReady(true);
  }

  async function createHandTracker() {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );

    return HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  async function setupHandTracking() {
    const handLandmarker = await createHandTracker();
    handLandmarkerRef.current = handLandmarker;
    resetDetectionState();

    if (!mountedRef.current) return;
    setTrackerReady(true);
  }

  async function reinitHandTrackingSilently() {
    if (reinitializingRef.current) return;

    reinitializingRef.current = true;

    try {
      handLandmarkerRef.current?.close();
      handLandmarkerRef.current = null;

      if (mountedRef.current) setTrackerReady(false);

      const handLandmarker = await createHandTracker();
      handLandmarkerRef.current = handLandmarker;
      resetDetectionState();

      if (mountedRef.current) {
        setTrackerReady(true);
      }
    } catch (err) {
      const msg = `[reinitHandTracking] ${describeUnknownError(err)}`;
      console.error(msg, err);
      if (mountedRef.current) setError(msg);
    } finally {
      reinitializingRef.current = false;
    }
  }

  async function preloadSingleVideo(src: string, index: number) {
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (ev: Event) => {
        cleanup();
        reject(ev);
      };
      const cleanup = () => {
        video.removeEventListener("canplaythrough", onReady);
        video.removeEventListener("error", onError);
      };

      video.addEventListener("canplaythrough", onReady, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.load();
    });

    preloadedVideosRef.current.set(index, video);

    if (mountedRef.current) {
      setVideosReadyCount(index + 1);
    }
  }

  async function preloadVideosSequentially() {
    preloadedVideosRef.current.clear();
    setVideosReadyCount(0);

    for (let i = 0; i < videoSources.length; i += 1) {
      await preloadSingleVideo(videoSources[i], i);
      await waitForIdle();
    }

    if (!mountedRef.current) return;

    setVideosReady(true);
  }

  async function showVideo(index: number) {
    const activeVideo = activeVideoRef.current;
    const preloaded = preloadedVideosRef.current.get(index);

    if (!activeVideo || !preloaded) return;

    const nextSrc = preloaded.currentSrc || preloaded.src;

    if (activeVideo.currentSrc !== nextSrc && activeVideo.src !== nextSrc) {
      activeVideo.pause();
      activeVideo.src = nextSrc;
    }

    activeVideo.currentTime = 0;

    try {
      await activeVideo.play();
    } catch (err) {
      console.error("activeVideo.play failed:", err);
    }
  }

  function startLoop() {
    const video = webcamRef.current as VideoWithFrameCallback | null;
    if (!video) return;

    startedLoopRef.current = true;

    const tick: VideoFrameRequestCallback | FrameRequestCallback = (
      _now?: number,
      metadata?: VideoFrameCallbackMetadata
    ) => {
      processFrame(metadata);

      const currentVideo = webcamRef.current as VideoWithFrameCallback | null;
      if (!currentVideo || !mountedRef.current || !startedLoopRef.current) return;

      if (typeof currentVideo.requestVideoFrameCallback === "function") {
        videoFrameCallbackIdRef.current =
          currentVideo.requestVideoFrameCallback(tick as VideoFrameRequestCallback);
      } else {
        rafRef.current = requestAnimationFrame(tick as FrameRequestCallback);
      }
    };

    if (typeof video.requestVideoFrameCallback === "function") {
      videoFrameCallbackIdRef.current =
        video.requestVideoFrameCallback(tick as VideoFrameRequestCallback);
    } else {
      rafRef.current = requestAnimationFrame(tick as FrameRequestCallback);
    }
  }

  function processFrame(metadata?: VideoFrameCallbackMetadata) {
    const detector = handLandmarkerRef.current;
    const video = webcamRef.current;

    if (!detector || !video) return;
    if (!appReady) return;
    if (reinitializingRef.current) return;

    if (
      video.readyState < 2 ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return;
    }

    let candidateTimestamp = 0;

    if (metadata && typeof metadata.mediaTime === "number") {
      candidateTimestamp = Math.round(metadata.mediaTime * 1000);
    } else {
      candidateTimestamp = Math.round(video.currentTime * 1000);
    }

    if (candidateTimestamp <= 0) return;

    const timestamp = Math.max(
      candidateTimestamp,
      lastDetectTimestampRef.current + 1
    );
    lastDetectTimestampRef.current = timestamp;

    let result;
    try {
      result = detector.detectForVideo(video, timestamp);
    } catch (err) {
      const msg = `detectForVideo failed: ${describeUnknownError(err)}`;

      if (!warnedDetectErrorRef.current) {
        console.warn(msg, err);
        warnedDetectErrorRef.current = true;
      }

      historyRef.current = [];
      void reinitHandTrackingSilently();
      return;
    }

    const hand = result.landmarks?.[0];
    if (!hand) {
      historyRef.current = [];
      return;
    }

    const x =
      (hand[0].x + hand[5].x + hand[9].x + hand[13].x + hand[17].x) / 5;

    const now = performance.now();
    const history = historyRef.current;
    history.push({ x, t: now });

    while (history.length > 0 && now - history[0].t > SWIPE_TIME_MS) {
      history.shift();
    }

    if (now - lastSwipeAtRef.current < COOLDOWN_MS) return;
    if (history.length < 2) return;

    const first = history[0];
    const last = history[history.length - 1];
    const deltaX = last.x - first.x;
    const deltaT = Math.max(1, last.t - first.t);
    const velocity = deltaX / deltaT;

    debugRef.current.deltaX = deltaX;
    debugRef.current.swipeVelocity = velocity;

    if (deltaX >= SWIPE_DISTANCE) {
      lastSwipeAtRef.current = now;
      historyRef.current = [];

      const impulse =
        BASE_IMPULSE +
        deltaX * DISTANCE_IMPULSE_MULTIPLIER +
        velocity * VELOCITY_IMPULSE_MULTIPLIER;

      debugRef.current.impulse = impulse;
      addMomentum(Math.max(2, impulse));
    }
  }

  return (
    <main
      style={{
        width: "100vw",
        height: "100vh",
        background: "#000",
        color: "#fff",
        overflow: "hidden",
        position: "relative",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#000",
        }}
      >
        <video
          ref={activeVideoRef}
          src="/videos/1.mp4"
          muted
          loop
          playsInline
          preload="auto"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "fill",
            opacity: appReady ? 1 : 0,
            transition: "opacity 0ms linear",
            pointerEvents: "none",
            background: "#000",
          }}
        />
      </div>

      {(!appReady || error) && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "grid",
            placeItems: "center",
            background: "rgba(0,0,0,0.78)",
            zIndex: 20,
            padding: 24,
          }}
        >
          <div
            style={{
              width: "min(560px, 100%)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 24,
              padding: 24,
              background: "rgba(255,255,255,0.04)",
              backdropFilter: "blur(10px)",
            }}
          >
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                marginBottom: 14,
              }}
            >
              kidcup-demo
            </div>

            {error ? (
              <div
                style={{
                  opacity: 0.9,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                }}
              >
                {error}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8, opacity: 0.88 }}>
                <div>Camera: {cameraReady ? "ready" : "loading..."}</div>
                <div>Hand tracking: {trackerReady ? "ready" : "loading..."}</div>
                <div>Videos: {videosReadyCount} / {VIDEO_COUNT} preloaded</div>
              </div>
            )}
          </div>
        </div>
      )}

      <div
        style={{
          position: "fixed",
          left: 20,
          bottom: 20,
          zIndex: 10,
          padding: "10px 14px",
          borderRadius: 999,
          background: "rgba(0,0,0,0.45)",
          border: "1px solid rgba(255,255,255,0.12)",
          backdropFilter: "blur(10px)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: 0.2,
        }}
      >
        Video {currentIndex + 1} / {VIDEO_COUNT}
      </div>

      {showDebug && (
        <div
          style={{
            position: "fixed",
            left: 20,
            top: 20,
            zIndex: 10,
            minWidth: 260,
            padding: 14,
            borderRadius: 16,
            background: "rgba(0,0,0,0.55)",
            border: "1px solid rgba(255,255,255,0.12)",
            backdropFilter: "blur(10px)",
            fontSize: 12,
            lineHeight: 1.6,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Momentum Debug</div>
          <div>spinVelocity: {debugSpinVelocity.toFixed(3)}</div>
          <div>spinPosition: {debugSpinPosition.toFixed(3)}</div>
          <div>deltaX: {debugDeltaX.toFixed(4)}</div>
          <div>swipeVelocity: {debugSwipeVelocity.toFixed(5)}</div>
          <div>impulse: {debugImpulse.toFixed(3)}</div>
          <div>maxSpinVelocity: {MAX_SPIN_VELOCITY}</div>
          <div>damping: {SPIN_DAMPING_PER_SECOND}</div>
        </div>
      )}

      <div
        style={{
          position: "fixed",
          right: 20,
          bottom: 20,
          zIndex: 10,
          width: 220,
          aspectRatio: "4 / 3",
          borderRadius: 18,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.12)",
          background: "#111",
          boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
        }}
      >
        <video
          ref={webcamRef}
          muted
          playsInline
          autoPlay
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: "scaleX(-1)",
          }}
        />
      </div>
    </main>
  );
}