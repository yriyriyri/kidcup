"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

const VIDEO_COUNT = 5;
const SWIPE_DISTANCE = 0.02;
const SWIPE_TIME_MS = 250;
const COOLDOWN_MS = 1000;

type Point = {
  x: number;
  t: number;
};

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

type DebugValues = {
  deltaX: number;
  swipeVelocity: number;
};

export default function Home() {
  const webcamRef = useRef<HTMLVideoElement | null>(null);
  const frontVideoRef = useRef<HTMLVideoElement | null>(null);
  const backVideoRef = useRef<HTMLVideoElement | null>(null);
  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);
  const videoFrameCallbackIdRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(true);

  const historyRef = useRef<Point[]>([]);
  const lastSwipeAtRef = useRef(0);
  const lastDetectTimestampRef = useRef(0);
  const reinitializingRef = useRef(false);
  const startedLoopRef = useRef(false);
  const mountedRef = useRef(true);
  const warnedDetectErrorRef = useRef(false);

  const preloadedVideosRef = useRef<Map<number, HTMLVideoElement>>(new Map());

  const debugRef = useRef<DebugValues>({
    deltaX: 0,
    swipeVelocity: 0,
  });

  const visibleLayerRef = useRef<0 | 1>(0);
  const switchTokenRef = useRef(0);
  const currentVisibleIndexRef = useRef(0);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [trackerReady, setTrackerReady] = useState(false);
  const [videosReadyCount, setVideosReadyCount] = useState(0);
  const [videosReady, setVideosReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [debugDeltaX, setDebugDeltaX] = useState(0);
  const [debugSwipeVelocity, setDebugSwipeVelocity] = useState(0);

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

  async function waitForReadyFrame(video: HTMLVideoElement) {
    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        resolve();
        return;
      }

      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = (ev: Event) => {
        cleanup();
        reject(ev);
      };
      const cleanup = () => {
        video.removeEventListener("loadeddata", onLoaded);
        video.removeEventListener("error", onError);
      };

      video.addEventListener("loadeddata", onLoaded, { once: true });
      video.addEventListener("error", onError, { once: true });
    });

    if (
      "requestVideoFrameCallback" in video &&
      typeof video.requestVideoFrameCallback === "function"
    ) {
      await new Promise<void>((resolve) => {
        video.requestVideoFrameCallback?.(() => resolve());
      });
    } else {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    }
  }

  async function switchToVideo(index: number) {
    const token = ++switchTokenRef.current;

    const front = frontVideoRef.current;
    const back = backVideoRef.current;
    const preloaded = preloadedVideosRef.current.get(index);

    if (!front || !back || !preloaded) return;

    const visible = visibleLayerRef.current === 0 ? front : back;
    const hidden = visibleLayerRef.current === 0 ? back : front;
    const nextSrc = preloaded.currentSrc || preloaded.src;

    if (
      currentVisibleIndexRef.current === index &&
      hidden.style.opacity === "0"
    ) {
      return;
    }

    if (hidden.currentSrc !== nextSrc && hidden.src !== nextSrc) {
      hidden.pause();
      hidden.src = nextSrc;
    }

    hidden.currentTime = 0;

    try {
      await hidden.play();
      await waitForReadyFrame(hidden);
    } catch (err) {
      console.error("Hidden layer prime failed:", err);
      return;
    }

    if (!mountedRef.current || token !== switchTokenRef.current) {
      return;
    }

    hidden.style.opacity = "1";
    visible.style.opacity = "0";

    currentVisibleIndexRef.current = index;
    visibleLayerRef.current = visibleLayerRef.current === 0 ? 1 : 0;

    const oldVisible = visible;
    window.setTimeout(() => {
      oldVisible.pause();
    }, 140);
  }

  useEffect(() => {
    const id = window.setInterval(() => {
      setDebugDeltaX(debugRef.current.deltaX);
      setDebugSwipeVelocity(debugRef.current.swipeVelocity);
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

      frontVideoRef.current?.pause();
      backVideoRef.current?.pause();
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
    void switchToVideo(currentIndex);
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

    const front = frontVideoRef.current;
    const back = backVideoRef.current;
    const firstPreloaded = preloadedVideosRef.current.get(0);

    if (front && back && firstPreloaded) {
      const initialSrc = firstPreloaded.currentSrc || firstPreloaded.src;
      front.src = initialSrc;
      front.currentTime = 0;
      front.style.opacity = "1";
      back.style.opacity = "0";

      try {
        await front.play();
        await waitForReadyFrame(front);
      } catch (err) {
        console.error("Initial front layer play failed:", err);
      }
    }

    currentVisibleIndexRef.current = 0;
    visibleLayerRef.current = 0;
    setVideosReady(true);
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
      if (
        !currentVideo ||
        !mountedRef.current ||
        !startedLoopRef.current
      )
        return;

      if (typeof currentVideo.requestVideoFrameCallback === "function") {
        videoFrameCallbackIdRef.current = currentVideo.requestVideoFrameCallback(
          tick as VideoFrameRequestCallback
        );
      } else {
        rafRef.current = requestAnimationFrame(tick as FrameRequestCallback);
      }
    };

    if (typeof video.requestVideoFrameCallback === "function") {
      videoFrameCallbackIdRef.current = video.requestVideoFrameCallback(
        tick as VideoFrameRequestCallback
      );
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
    if (history.length < 4) return;

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
      setCurrentIndex((prev) => (prev + 1) % VIDEO_COUNT);
    }
  }

  const fullscreenVideoStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "fill",
    pointerEvents: "none",
    background: "#000",
    transition: "opacity 120ms ease-out",
    willChange: "opacity",
  };

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
          ref={frontVideoRef}
          muted
          loop
          playsInline
          preload="auto"
          style={{
            ...fullscreenVideoStyle,
            opacity: appReady ? 1 : 0,
            zIndex: 0,
          }}
        />
        <video
          ref={backVideoRef}
          muted
          loop
          playsInline
          preload="auto"
          style={{
            ...fullscreenVideoStyle,
            opacity: 0,
            zIndex: 1,
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

      {showDebug && (
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
      )}

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
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Swipe Debug</div>
          <div>deltaX: {debugDeltaX.toFixed(4)}</div>
          <div>swipeVelocity: {debugSwipeVelocity.toFixed(5)}</div>
          <div>threshold: {SWIPE_DISTANCE.toFixed(3)}</div>
          <div>cooldownMs: {COOLDOWN_MS}</div>
          <div>fullscreen: {isFullscreen ? "on" : "off"}</div>
        </div>
      )}

      <div
        style={{
          position: "fixed",
          left: 20,
          top: 20,
          transformOrigin: "top left",
          zIndex: 10,
          width: 220,
          aspectRatio: "4 / 3",
          borderRadius: 18,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.12)",
          background: "#111",
          boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
          transform: "scaleX(1.7777)",
          pointerEvents: "none",
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
            transformOrigin: "center center",
          }}
        />
      </div>
    </main>
  );
}