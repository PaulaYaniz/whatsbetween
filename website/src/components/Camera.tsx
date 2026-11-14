import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Link} from 'react-router-dom';

import {SDOW_API_URL} from '../resources/constants';
import type {Frame, TrackedObject} from '../vision/tracking';
import {connectArticles, resolveArticle} from '../vision/wiki';
import type {ConnectResponse, WikiArticle} from '../vision/wiki';
import {ConnectionReport} from './ConnectionReport';

import './camera.css';

interface Usage {
  configured: boolean;
  verified: boolean;
  model: string;
  appDailyAttempts: number;
  intervalSeconds: number;
}
interface Detection {
  label: string;
  box_2d: [number, number, number, number];
}
type Candidate = TrackedObject;
type SlotKey = 'A' | 'B';
const SLOTS: readonly SlotKey[] = ['A', 'B'];

interface Specimen {
  readonly label: string;
  readonly origin: 'camera' | 'manual';
  /** Tracked candidate currently representing this specimen (camera only). */
  readonly sourceId?: string;
  readonly rawLabel?: string;
  readonly box?: Detection['box_2d'];
  /** In-memory crop of the object at selection time. Never uploaded or stored. */
  readonly thumb?: string;
  readonly article: WikiArticle | null;
  readonly candidates: readonly WikiArticle[];
  readonly resolving: boolean;
  readonly error?: string;
}
type Specimens = Readonly<Record<SlotKey, Specimen>>;
const EMPTY: Specimen = {
  label: '',
  origin: 'manual',
  article: null,
  candidates: [],
  resolving: false,
};

type Trace =
  | {readonly phase: 'idle'}
  | {readonly phase: 'loading'; readonly startedAt: number}
  | {
      readonly phase: 'done';
      readonly result: ConnectResponse;
      readonly thumbs: [Specimen, Specimen];
    }
  | {readonly phase: 'error'; readonly message: string};

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${SDOW_API_URL}/vision${path}`, {
    ...init,
    signal: AbortSignal.timeout(40000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(String(data.error || 'Recognition request failed.'));
  return data;
}

// Boxes use the same full-frame aspect ratio as the video. Mirror coordinates only;
// labels stay readable. Percentages automatically follow responsive video resizing.
export function boxStyle(box: Detection['box_2d'], mirrored: boolean) {
  const [top, left, bottom, right] = box;
  return {
    top: `${top / 10}%`,
    left: `${(mirrored ? 1000 - right : left) / 10}%`,
    width: `${(right - left) / 10}%`,
    height: `${(bottom - top) / 10}%`,
  };
}

function overlap(a: Detection['box_2d'], b: Detection['box_2d']) {
  const h = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const w = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (box: Detection['box_2d']) => (box[2] - box[0]) * (box[3] - box[1]);
  return (h * w) / (area(a) + area(b) - h * w || 1);
}

export const Camera: React.FC = () => {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [backendReachable, setBackendReachable] = useState(true);
  const [status, setStatus] = useState('Checking backend configuration…');
  const [preview, setPreview] = useState(false);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('');
  const [mirrored, setMirrored] = useState(false);
  const [ratio, setRatio] = useState(16 / 9);
  const [count, setCount] = useState(0);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [sampleTime, setSampleTime] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [specimens, setSpecimens] = useState<Specimens>({A: EMPTY, B: EMPTY});
  const [trace, setTrace] = useState<Trace>({phase: 'idle'});
  const [clock, setClock] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const session = useRef<string | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const visibilityVersion = useRef(0);
  const due = useRef(0);
  const sent = useRef(0);
  const tracker = useRef<Worker | null>(null);
  const specimensRef = useRef<Specimens>({A: EMPTY, B: EMPTY});
  const correctionsRef = useRef<Record<string, string>>({});
  const touched = useRef(false);
  const resolveSeq = useRef<Record<SlotKey, number>>({A: 0, B: 0});
  const resolveTimers = useRef<Partial<Record<SlotKey, number>>>({});
  const traceAbort = useRef<AbortController | null>(null);
  const report = useRef<HTMLDivElement>(null);

  // All specimen updates go through the ref so async callbacks see the latest value.
  const commit = useCallback((update: (previous: Specimens) => Specimens) => {
    const next = update(specimensRef.current);
    if (next === specimensRef.current) return;
    specimensRef.current = next;
    setSpecimens(next);
  }, []);
  const patch = useCallback(
    (key: SlotKey, change: Partial<Specimen>) =>
      commit((previous) => ({...previous, [key]: {...previous[key], ...change}})),
    [commit]
  );

  const resolveNow = useCallback(
    (key: SlotKey, label: string) => {
      const query = label.trim();
      const seq = ++resolveSeq.current[key];
      if (!query) {
        patch(key, {article: null, candidates: [], resolving: false, error: undefined});
        return;
      }
      patch(key, {resolving: true, error: undefined});
      resolveArticle(query)
        .then((data) => {
          if (resolveSeq.current[key] !== seq) return;
          patch(key, {
            article: data.best,
            candidates: data.candidates,
            resolving: false,
            error: data.best ? undefined : 'No matching Wikipedia article. Edit the name.',
          });
        })
        .catch((error: unknown) => {
          if (resolveSeq.current[key] !== seq) return;
          patch(key, {
            article: null,
            candidates: [],
            resolving: false,
            error: error instanceof Error ? error.message : 'Article lookup failed.',
          });
        });
    },
    [patch]
  );
  const resolveLater = useCallback(
    (key: SlotKey, label: string) => {
      window.clearTimeout(resolveTimers.current[key]);
      resolveSeq.current[key]++;
      resolveTimers.current[key] = window.setTimeout(() => resolveNow(key, label), 450);
    },
    [resolveNow]
  );

  const crop = useCallback((box: Detection['box_2d']) => {
    const element = video.current;
    if (!element?.videoWidth || element.readyState < 2) return undefined;
    const [top, left, bottom, right] = box;
    const pad = 0.06;
    const x0 = Math.max(0, left / 1000 - pad) * element.videoWidth;
    const y0 = Math.max(0, top / 1000 - pad) * element.videoHeight;
    const x1 = Math.min(1, right / 1000 + pad) * element.videoWidth;
    const y1 = Math.min(1, bottom / 1000 + pad) * element.videoHeight;
    const scale = Math.min(1, 200 / Math.max(x1 - x0, y1 - y0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((x1 - x0) * scale));
    canvas.height = Math.max(1, Math.round((y1 - y0) * scale));
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(element, x0, y0, x1 - x0, y1 - y0, 0, 0, canvas.width, canvas.height);
    try {
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch {
      return undefined;
    }
  }, []);

  const labelOf = useCallback(
    (item: Candidate) => correctionsRef.current[item.label] ?? item.label,
    []
  );

  const assign = useCallback(
    (key: SlotKey, item: Candidate) => {
      const label = labelOf(item).trim();
      if (!label) return;
      commit((previous) => {
        const other: SlotKey = key === 'A' ? 'B' : 'A';
        const next = {
          ...previous,
          [key]: {
            ...EMPTY,
            label,
            origin: 'camera' as const,
            sourceId: item.id,
            rawLabel: item.label,
            box: item.box_2d,
            thumb: crop(item.box_2d),
          },
        };
        // One physical object cannot be both endpoints.
        if (previous[other].sourceId === item.id) next[other] = EMPTY;
        return next;
      });
      resolveNow(key, label);
    },
    [commit, crop, labelOf, resolveNow]
  );

  const clearSlot = useCallback(
    (key: SlotKey) => {
      touched.current = true;
      window.clearTimeout(resolveTimers.current[key]);
      resolveSeq.current[key]++;
      commit((previous) => ({...previous, [key]: EMPTY}));
    },
    [commit]
  );

  // Clicking a box toggles it: assigned boxes are released, others fill the next free slot.
  const toggleCandidate = (item: Candidate) => {
    touched.current = true;
    const current = SLOTS.find((key) => specimensRef.current[key].sourceId === item.id);
    if (current) {
      clearSlot(current);
      setStatus(`Removed ${labelOf(item)} from specimen ${current}.`);
      return;
    }
    const free = SLOTS.find((key) => !specimensRef.current[key].label.trim());
    if (!free) {
      setStatus('Both specimens are set. Clear one, or use Set A / Set B in Table 1 to replace.');
      return;
    }
    assign(free, item);
    setStatus(`${labelOf(item)} set as specimen ${free}.`);
  };

  // Keep specimen markers attached when a new recognition sample renames the boxes, and
  // suggest a pair when exactly two objects are visible and the user has not chosen yet.
  const onTracked = useCallback(
    (objects: Candidate[]) => {
      setCandidates(objects);
      const live = objects.filter((item) => item.tracking);
      commit((previous) => {
        let changed = false;
        const next = {...previous};
        for (const key of SLOTS) {
          const slot = previous[key];
          const box = slot.box;
          if (slot.origin !== 'camera' || !box) continue;
          const same = live.find((item) => item.id === slot.sourceId);
          if (same) {
            if (same.box_2d !== slot.box) {
              next[key] = {...slot, box: same.box_2d};
              changed = true;
            }
            continue;
          }
          const match = live
            .filter((item) => item.label === slot.rawLabel)
            .map((item) => ({item, score: overlap(item.box_2d, box)}))
            .sort((x, y) => y.score - x.score)[0];
          if (match && match.score > 0.2) {
            next[key] = {...slot, sourceId: match.item.id, box: match.item.box_2d};
            changed = true;
          }
        }
        return changed ? next : previous;
      });
      const current = specimensRef.current;
      if (
        !touched.current &&
        live.length === 2 &&
        !current.A.label.trim() &&
        !current.B.label.trim()
      ) {
        touched.current = true;
        assign('A', live[0]);
        assign('B', live[1]);
        setStatus(
          `Suggested pair: ${labelOf(live[0])} → ${labelOf(live[1])}. Click a box or Swap to change.`
        );
      }
    },
    [assign, commit, labelOf]
  );

  const refresh = useCallback(async () => {
    const data: Usage = await api('/status');
    setUsage(data);
    return data;
  }, []);
  const enumerate = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter((item) => item.kind === 'videoinput'));
  }, []);

  // Ends Gemini recognition but leaves the camera preview running.
  const pauseRecognition = useCallback((message?: string) => {
    generation.current++;
    tracker.current?.terminate();
    tracker.current = null;
    const token = session.current;
    session.current = null;
    if (token) void api(`/sessions/${token}/stop`, {method: 'POST'}).catch(() => undefined);
    setActive(false);
    setStarting(false);
    setCandidates([]);
    setSampleTime(null);
    if (message) setStatus(message);
  }, []);
  const stop = useCallback(
    (message = 'Stopped. Camera released; no more frames will be sent.') => {
      pauseRecognition();
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      if (video.current) video.current.srcObject = null;
      setPreview(false);
      setStatus(message);
    },
    [pauseRecognition]
  );

  useEffect(() => {
    let mounted = true;
    const timers = resolveTimers.current;
    void api('/status')
      .then((data: Usage) => {
        if (!mounted) return;
        setUsage(data);
        setStatus(
          data.configured
            ? 'Open the camera to begin. Recognition starts only when you choose Start scanning.'
            : 'Camera preview is available. Add GEMINI_API_KEY to backend sdow/.env.local for recognition. You can still type object names.'
        );
      })
      .catch(() => {
        if (!mounted) return;
        setBackendReachable(false);
        setStatus('Camera preview is available. Start Flask on port 5001 for recognition.');
      });
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => {
        if (mounted) setDevices(list.filter((item) => item.kind === 'videoinput'));
      })
      .catch(() => undefined);
    const media = navigator.mediaDevices;
    const changed = () => {
      void enumerate().catch(() => undefined);
    };
    media?.addEventListener('devicechange', changed);
    return () => {
      mounted = false;
      media?.removeEventListener('devicechange', changed);
      Object.values(timers).forEach((timer) => window.clearTimeout(timer));
      traceAbort.current?.abort();
      stop();
    };
  }, [enumerate, refresh, stop]);

  const submit = async (blob: Blob, token: string) => {
    const form = new FormData();
    form.append('image', blob, 'scan.jpg');
    form.append('session', token);
    return api('/recognize', {method: 'POST', body: form});
  };
  const singleCheck = async () => {
    if (!file || busy.current) return;
    busy.current = true;
    setChecking(true);
    setStatus('Checking one image and its bounding-box response with Gemini…');
    const version = generation.current;
    let token: string | undefined;
    try {
      const data = await api('/sessions', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({kind: 'check'}),
      });
      token = data.session;
      const result = await submit(file, data.session);
      if (generation.current !== version) return;
      setUsage(result.usage);
      setStatus(
        `Single-image check passed: ${result.objects.map((item: Detection) => item.label).join(', ') || 'no objects'}. Camera recognition is ready.`
      );
    } catch (error) {
      if (generation.current === version)
        setStatus(error instanceof Error ? error.message : 'Image check failed.');
    } finally {
      if (token) void api(`/sessions/${token}/stop`, {method: 'POST'}).catch(() => undefined);
      due.current = Date.now() + (usage?.intervalSeconds ?? 6) * 1000;
      busy.current = false;
      setChecking(false);
    }
  };

  const openCamera = async () => {
    if (stream.current || starting) return;
    const version = ++generation.current;
    setStarting(true);
    setStatus('Requesting camera permission…');
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('Use localhost in a browser that supports camera access.');
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: {ideal: 1280},
          height: {ideal: 720},
          ...(device ? {deviceId: {exact: device}} : {}),
        },
      });
      if (generation.current !== version) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      if (!video.current) throw new Error('Camera preview is unavailable.');
      video.current.srcObject = media;
      await video.current.play();
      if (generation.current !== version) return;
      setDevice(media.getVideoTracks()[0].getSettings().deviceId || device);
      setPreview(true);
      setStarting(false);
      setStatus('Live preview only. No frames are being sent.');
      await enumerate();
      media.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (generation.current === version)
            stop('Camera disconnected. Choose an available camera and open it again.');
        });
      });
    } catch (error) {
      if (generation.current !== version) return;
      const name = error instanceof DOMException ? error.name : '';
      stop(
        name === 'NotAllowedError'
          ? 'Camera permission denied. Allow camera access in browser and macOS Privacy & Security settings, then Open camera. You can still type object names.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'Selected camera is unavailable. Refresh cameras and choose another device.'
            : name === 'NotReadableError'
              ? 'Camera is busy or disconnected. Close other camera apps and try again.'
              : error instanceof Error
                ? error.message
                : 'Could not open camera.'
      );
    }
  };

  const start = async () => {
    if (!preview || busy.current || starting || active || document.hidden) return;
    const version = generation.current;
    setStarting(true);
    try {
      const config = await refresh();
      if (!config.verified) throw new Error('Run the single-image check for this key/model first.');
      const data = await api('/sessions', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({kind: 'camera'}),
      });
      if (generation.current !== version) {
        void api(`/sessions/${data.session}/stop`, {method: 'POST'}).catch(() => undefined);
        return;
      }
      session.current = data.session;
      correctionsRef.current = {};
      setCorrections({});
      sent.current = 0;
      setCount(0);
      setActive(true);
      setLatency(null);
      setStatus('Looking for objects. Hold them still briefly in good light.');
    } catch (error) {
      if (generation.current === version)
        setStatus(error instanceof Error ? error.message : 'Could not start recognition.');
    } finally {
      if (generation.current === version) setStarting(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    const grayCanvas = document.createElement('canvas');
    const grayContext = grayCanvas.getContext('2d', {willReadFrequently: true});
    let trackingBusy = false;
    let lastVideoTime = -1;
    let lastFrameTime = 0;
    const createTracker = () => {
      tracker.current?.terminate();
      const worker = new Worker(new URL('../vision/tracking.worker.ts', import.meta.url), {
        type: 'module',
      });
      tracker.current = worker;
      trackingBusy = false;
      worker.onmessage = (event: MessageEvent<{objects: Candidate[]}>) => {
        if (tracker.current !== worker || document.hidden) return;
        trackingBusy = false;
        onTracked(event.data.objects);
      };
      worker.onerror = () => {
        if (tracker.current !== worker) return;
        stop('Local motion tracking failed. Reload the page and restart scanning.');
      };
    };
    const grayFrame = (
      source: CanvasImageSource,
      width: number,
      height: number,
      time: number
    ): Frame => {
      if (!grayContext) throw new Error('Local motion tracking is unavailable in this browser.');
      const scale = Math.min(1, 320 / Math.max(width, height));
      grayCanvas.width = Math.round(width * scale);
      grayCanvas.height = Math.round(height * scale);
      grayContext.drawImage(source, 0, 0, grayCanvas.width, grayCanvas.height);
      const rgba = grayContext.getImageData(0, 0, grayCanvas.width, grayCanvas.height).data;
      const pixels = new Uint8Array(grayCanvas.width * grayCanvas.height);
      for (let i = 0; i < pixels.length; i++)
        pixels[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
      return {width: grayCanvas.width, height: grayCanvas.height, pixels, time};
    };
    if (!document.hidden) createTracker();
    const follow = () => {
      const element = video.current;
      if (
        document.hidden ||
        !tracker.current ||
        trackingBusy ||
        !element?.videoWidth ||
        element.readyState < 2
      )
        return;
      if (element.currentTime === lastVideoTime) {
        if (lastFrameTime && Date.now() - lastFrameTime > 500) setCandidates([]);
        return;
      }
      lastVideoTime = element.currentTime;
      lastFrameTime = Date.now();
      const frame = grayFrame(element, element.videoWidth, element.videoHeight, lastFrameTime);
      trackingBusy = true;
      tracker.current.postMessage({type: 'frame', frame}, [frame.pixels.buffer]);
    };
    const motionTimer = window.setInterval(follow, 100);
    const sample = async () => {
      const element = video.current;
      const token = session.current;
      if (
        document.hidden ||
        busy.current ||
        !token ||
        !element?.videoWidth ||
        element.readyState < 2 ||
        Date.now() < due.current
      )
        return;
      if (sent.current >= 50) {
        stop('50-request session limit reached. Camera stopped.');
        return;
      }
      busy.current = true;
      const version = generation.current;
      const visible = visibilityVersion.current;
      const captured = Date.now();
      const dimensions = `${element.videoWidth}:${element.videoHeight}`;
      let cooldown = 0;
      try {
        const scale = Math.min(1, 960 / Math.max(element.videoWidth, element.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(element.videoWidth * scale);
        canvas.height = Math.round(element.videoHeight * scale);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not capture a camera frame.');
        context.drawImage(element, 0, 0, canvas.width, canvas.height);
        const sourceFrame = grayFrame(element, element.videoWidth, element.videoHeight, captured);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.8)
        );
        if (
          generation.current !== version ||
          document.hidden ||
          visibilityVersion.current !== visible
        )
          return;
        if (!blob || blob.size > 2_000_000)
          throw new Error('Frame could not be compressed under 2 MB.');
        sent.current++;
        setCount(sent.current);
        const result = await submit(blob, token);
        if (generation.current !== version) return;
        cooldown =
          result.nextRequestAfterMs ??
          Math.max(0, captured + (usage?.intervalSeconds ?? 6) * 1000 - Date.now());
        setUsage(result.usage);
        setLatency(result.latencyMs ?? Date.now() - captured);
        if (
          document.hidden ||
          visibilityVersion.current !== visible ||
          dimensions !== `${element.videoWidth}:${element.videoHeight}`
        )
          return;
        if (Date.now() - captured >= 10000) {
          setStatus('Result arrived too late; stale boxes discarded. Waiting for the next sample.');
          return;
        }
        tracker.current?.postMessage({type: 'seed', objects: result.objects, frame: sourceFrame}, [
          sourceFrame.pixels.buffer,
        ]);
        setSampleTime(captured);
        if (!result.objects.length)
          setStatus('Looking for objects. None prominent in this sample.');
        else
          setStatus((previous) =>
            previous.startsWith('Suggested pair') ||
            previous.includes('set as specimen') ||
            previous.startsWith('Removed')
              ? previous
              : 'Objects identified. Click a box, or use Table 1, to choose specimens A and B.'
          );
        if (sent.current >= 50)
          stop('50-request session limit reached. Camera stopped. Chosen specimens remain.');
      } catch (error) {
        if (generation.current === version)
          stop(
            `${error instanceof Error ? error.message : 'Recognition failed.'} Restart manually to retry.`
          );
      } finally {
        // Backend reports remaining global spacing after inference. A small margin
        // avoids racing its reservation clock; never add a full interval again.
        due.current = Date.now() + cooldown + 100;
        busy.current = false;
      }
    };
    const timer = window.setInterval(() => {
      void sample();
    }, 250);
    const visibility = () => {
      visibilityVersion.current++;
      tracker.current?.terminate();
      tracker.current = null;
      lastVideoTime = -1;
      if (!document.hidden) createTracker();
      setCandidates([]);
      setSampleTime(null);
      setStatus(
        document.hidden
          ? 'Recognition paused while this tab is hidden.'
          : 'Tab visible. Waiting for the next sample.'
      );
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(motionTimer);
      tracker.current?.terminate();
      tracker.current = null;
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [active, usage?.intervalSeconds, stop, onTracked]);

  // One-second clock for elapsed tracing time and sample age. Display only.
  useEffect(() => {
    if (trace.phase !== 'loading' && !active) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [trace.phase, active]);

  const runTrace = (pair: Specimens) => {
    const a = pair.A.article;
    const b = pair.B.article;
    if (!a || !b) return;
    if (active)
      pauseRecognition('Recognition paused while the path is traced. The preview stays on.');
    traceAbort.current?.abort();
    const controller = new AbortController();
    traceAbort.current = controller;
    const startedAt = Date.now();
    setClock(startedAt);
    setTrace({phase: 'loading', startedAt});
    connectArticles(
      a.title,
      b.title,
      AbortSignal.any([controller.signal, AbortSignal.timeout(35000)])
    )
      .then((result) => {
        if (traceAbort.current !== controller) return;
        setTrace({phase: 'done', result, thumbs: [pair.A, pair.B]});
        window.requestAnimationFrame(() =>
          report.current?.scrollIntoView({
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
              ? 'auto'
              : 'smooth',
            block: 'start',
          })
        );
      })
      .catch((error: unknown) => {
        if (traceAbort.current !== controller) return;
        setTrace({
          phase: 'error',
          message:
            error instanceof DOMException && error.name === 'TimeoutError'
              ? 'The Wikipedia search timed out. Your specimens are kept; try again.'
              : error instanceof Error
                ? error.message
                : 'Wikipedia search failed.',
        });
      });
  };
  const swap = () => {
    touched.current = true;
    commit((previous) => ({A: previous.B, B: previous.A}));
  };
  const reverse = () => {
    swap();
    runTrace(specimensRef.current);
  };
  const scanAgain = () => {
    traceAbort.current?.abort();
    traceAbort.current = null;
    setTrace({phase: 'idle'});
    window.scrollTo({top: 0, behavior: 'auto'});
    if (preview && !active) void start();
  };

  const displayLabel = (item: Candidate) => corrections[item.label] ?? item.label;
  const slotFor = (item: Candidate) => SLOTS.find((key) => specimens[key].sourceId === item.id);
  const tracked = candidates.filter((item) => item.tracking);
  const articleA = specimens.A.article;
  const articleB = specimens.B.article;
  const ready = !!articleA && !!articleB && !specimens.A.resolving && !specimens.B.resolving;
  const phase =
    trace.phase === 'loading'
      ? 'Tracing path'
      : trace.phase === 'done'
        ? trace.result.status === 'found'
          ? 'Path found'
          : trace.result.status === 'same_article'
            ? 'Same article'
            : 'No path within limit'
        : ready
          ? 'Ready to trace'
          : active
            ? tracked.length
              ? 'Choose two objects'
              : 'Looking for objects'
            : preview
              ? 'Preview only'
              : 'Camera off';
  const sampleAge =
    sampleTime && clock ? Math.max(0, Math.round((clock - sampleTime) / 1000)) : null;

  const slotPanel = (key: SlotKey) => {
    const slot = specimens[key];
    const role = key === 'A' ? 'Source' : 'Target';
    return (
      <section
        className={`ww-slot ww-slot-${key.toLowerCase()}`}
        aria-labelledby={`ww-slot-${key}`}
      >
        <header className="ww-slot-head">
          <span className={`ww-tag ww-tag-${key.toLowerCase()}`} aria-hidden="true">
            {key}
          </span>
          <h3 id={`ww-slot-${key}`}>
            Specimen {key} <span className="ww-slot-role">{role}</span>
          </h3>
          {slot.label && (
            <button
              type="button"
              className="ww-link-button"
              aria-label={`Clear specimen ${key}`}
              onClick={() => clearSlot(key)}
            >
              Clear
            </button>
          )}
        </header>
        <div className="ww-slot-body">
          <div className="ww-slot-thumb">
            {slot.thumb ? (
              <img src={slot.thumb} alt={`Camera crop of ${slot.label}`} />
            ) : slot.article?.thumbnailUrl ? (
              <img src={slot.article.thumbnailUrl} alt="" />
            ) : (
              <span aria-hidden="true">{key}</span>
            )}
          </div>
          <div className="ww-slot-fields">
            <label className="ww-field">
              <span>Object name</span>
              <input
                className="ww-slot-input"
                value={slot.label}
                maxLength={80}
                placeholder={key === 'A' ? 'Click a box, or type e.g. pencil' : 'e.g. lithium'}
                onChange={(event) => {
                  touched.current = true;
                  const label = event.target.value;
                  patch(key, {label, ...(slot.label ? {} : {origin: 'manual'})});
                  resolveLater(key, label);
                }}
              />
            </label>
            <label className="ww-field">
              <span>Wikipedia article</span>
              <select
                className="ww-slot-article"
                value={slot.article?.id ?? ''}
                disabled={!slot.candidates.length}
                onChange={(event) =>
                  patch(key, {
                    article:
                      slot.candidates.find((item) => item.id === Number(event.target.value)) ??
                      null,
                  })
                }
              >
                {!slot.candidates.length && (
                  <option value="">{slot.resolving ? 'Looking up…' : '—'}</option>
                )}
                {slot.candidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                    {item.disambiguation ? ' (disambiguation)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <p className="ww-slot-meta" aria-live="polite">
              {slot.resolving
                ? 'Resolving article…'
                : slot.error
                  ? slot.error
                  : slot.article
                    ? slot.article.description || 'Article found.'
                    : 'No article chosen.'}
              {slot.article && !slot.resolving && (
                <>
                  {' '}
                  <a href={slot.article.url} target="_blank" rel="noreferrer">
                    Open article
                  </a>
                </>
              )}
            </p>
            {slot.article?.disambiguation && (
              <p className="ww-slot-warn">
                This is a disambiguation page. Choose a specific article above.
              </p>
            )}
          </div>
        </div>
      </section>
    );
  };

  return (
    <main className="ww">
      <header className="ww-topbar">
        <div className="ww-brand">
          <Link to="/" className="ww-home">
            What's Between
          </Link>
          <span className="ww-brand-sub">Object linkage study</span>
        </div>
        <div className="ww-phase" role="status" aria-live="polite">
          <span
            className={`ww-dot ${active ? 'ww-dot-live' : trace.phase === 'loading' ? 'ww-dot-busy' : ''}`}
            aria-hidden="true"
          />
          {phase}
        </div>
      </header>

      <div className="ww-layout">
        <section className="ww-field-panel" aria-labelledby="ww-field-heading">
          <div className="ww-section-head">
            <h2 id="ww-field-heading" className="ww-figcaption">
              <span className="ww-fig-num">Fig. 1</span> Field of view
            </h2>
            <div className="ww-toolbar">
              <label className="ww-inline">
                <span className="ww-visually-hidden">Camera</span>
                <select
                  aria-label="Camera"
                  value={device}
                  disabled={starting || checking}
                  onChange={(event) => {
                    stop('Camera changed. Open camera to preview this device.');
                    setDevice(event.target.value);
                  }}
                >
                  <option value="">System default camera</option>
                  {devices.map((item, index) => (
                    <option key={item.deviceId || index} value={item.deviceId}>
                      {item.label || `Camera ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ww-icon-button"
                title="Refresh camera list"
                aria-label="Refresh cameras"
                onClick={() => {
                  void enumerate().catch(() =>
                    setStatus('Cannot list cameras. Allow camera permission and try again.')
                  );
                }}
              >
                ↻
              </button>
              <label className="ww-inline ww-check">
                <input
                  type="checkbox"
                  checked={mirrored}
                  onChange={(event) => setMirrored(event.target.checked)}
                />
                Mirror
              </label>
            </div>
          </div>

          <div className="ww-stage" style={{aspectRatio: ratio}}>
            <video
              ref={video}
              muted
              playsInline
              aria-label="Live camera preview"
              style={{transform: mirrored ? 'scaleX(-1)' : undefined}}
              onResize={() => {
                const element = video.current;
                if (element?.videoWidth && element.videoHeight)
                  setRatio(element.videoWidth / element.videoHeight);
                setCandidates([]);
                setSampleTime(null);
              }}
            />
            <div className="ww-reticle" aria-hidden="true" />
            {!preview && (
              <div className="ww-stage-empty">
                <p>Camera off</p>
                <button
                  type="button"
                  className="ww-button ww-button-light"
                  disabled={starting || checking}
                  onClick={() => {
                    void openCamera();
                  }}
                >
                  Open camera
                </button>
              </div>
            )}
            {preview &&
              tracked.map((item) => {
                const slot = slotFor(item);
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`object-box${slot ? ` object-box-${slot.toLowerCase()}` : ''}`}
                    style={boxStyle(item.box_2d, mirrored)}
                    aria-pressed={!!slot}
                    aria-label={
                      slot
                        ? `${displayLabel(item)}, specimen ${slot}. Activate to remove.`
                        : `Select ${displayLabel(item)} as a specimen`
                    }
                    onClick={() => toggleCandidate(item)}
                  >
                    <span>
                      {slot && <b>{slot}</b>}
                      {displayLabel(item)}
                    </span>
                  </button>
                );
              })}
          </div>

          <div className="ww-controls">
            {preview ? (
              active ? (
                <button
                  type="button"
                  className="ww-button"
                  onClick={() => pauseRecognition('Recognition paused. The preview stays on.')}
                >
                  Pause scanning
                </button>
              ) : (
                <button
                  type="button"
                  className="ww-button ww-button-primary"
                  disabled={!usage?.verified || starting || checking}
                  onClick={() => {
                    void start();
                  }}
                >
                  Start scanning
                </button>
              )
            ) : (
              <button
                type="button"
                className="ww-button ww-button-primary"
                disabled={starting || checking}
                onClick={() => {
                  void openCamera();
                }}
              >
                Open camera
              </button>
            )}
            <button
              type="button"
              className="ww-button"
              disabled={!preview && !starting}
              onClick={() => stop()}
            >
              Stop
            </button>
            <p className="ww-privacy">
              Scanning sends sampled still frames to Google Gemini for labels. No audio. People,
              hands and worn clothing are ignored.
            </p>
          </div>

          <dl className="ww-telemetry" aria-label="Recognition telemetry">
            <div>
              <dt>Last sample</dt>
              <dd>
                {sampleTime ? new Date(sampleTime).toLocaleTimeString() : '—'}
                {sampleAge !== null && active && <small> {sampleAge}s ago</small>}
              </dd>
            </div>
            <div>
              <dt>Response</dt>
              <dd>{latency !== null ? `${(latency / 1000).toFixed(1)} s` : '—'}</dd>
            </div>
            <div>
              <dt>Tracking</dt>
              <dd>{tracked.length}</dd>
            </div>
            <div>
              <dt>Frames</dt>
              <dd>{count} / 50</dd>
            </div>
          </dl>

          <section className="ww-detections" aria-labelledby="ww-detections-heading">
            <h2 id="ww-detections-heading" className="ww-table-title">
              <span className="ww-fig-num">Table 1</span> Detected objects
            </h2>
            {candidates.length ? (
              <table className="ww-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Label (editable)</th>
                    <th scope="col">State</th>
                    <th scope="col">Assign</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((item, index) => {
                    const slot = slotFor(item);
                    return (
                      <tr key={item.id} className={slot ? `ww-row-${slot.toLowerCase()}` : ''}>
                        <td className="ww-mono">{String(index + 1).padStart(2, '0')}</td>
                        <td>
                          <input
                            className="ww-label-input"
                            aria-label={`Object ${index + 1} name`}
                            value={displayLabel(item)}
                            maxLength={60}
                            onChange={(event) => {
                              const value = event.target.value;
                              correctionsRef.current = {
                                ...correctionsRef.current,
                                [item.label]: value,
                              };
                              setCorrections(correctionsRef.current);
                              if (slot && value.trim()) {
                                patch(slot, {label: value});
                                resolveLater(slot, value);
                              }
                            }}
                          />
                        </td>
                        <td className="ww-mono ww-state">
                          {slot ? `Specimen ${slot}` : item.tracking ? 'Tracking' : 'Lost'}
                        </td>
                        <td className="ww-assign">
                          {SLOTS.map((key) => (
                            <button
                              type="button"
                              key={key}
                              className={`ww-assign-button ww-assign-${key.toLowerCase()}`}
                              aria-pressed={slot === key}
                              disabled={!displayLabel(item).trim()}
                              aria-label={`Set ${displayLabel(item)} as specimen ${key}`}
                              onClick={() => {
                                touched.current = true;
                                if (slot === key) clearSlot(key);
                                else assign(key, item);
                              }}
                            >
                              {key}
                            </button>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="ww-muted">
                {active
                  ? 'Waiting for recognition. Hold objects still in good light.'
                  : 'No current detections. Start scanning, or type object names into the specimen slots.'}
              </p>
            )}
          </section>
        </section>

        <aside className="ww-side" aria-label="Specimens and search">
          <h2 className="ww-side-title">Specimens</h2>
          <p className="ww-muted ww-side-intro">
            Paths follow hyperlinks from A to B, so direction matters.
          </p>
          {slotPanel('A')}
          <div className="ww-swap">
            <button
              type="button"
              className="ww-link-button"
              onClick={swap}
              disabled={!specimens.A.label && !specimens.B.label}
            >
              ⇅ Swap A and B
            </button>
          </div>
          {slotPanel('B')}
          <button
            type="button"
            className="ww-button ww-button-primary ww-trace"
            disabled={!ready || trace.phase === 'loading'}
            onClick={() => runTrace(specimensRef.current)}
          >
            {trace.phase === 'loading'
              ? `Tracing… ${Math.max(0, Math.round((clock - trace.startedAt) / 1000))} s`
              : 'Trace Wikipedia path'}
          </button>
          <p className="ww-muted ww-trace-note">
            {ready && articleA && articleB
              ? `${articleA.title} → ${articleB.title}. Searches live English Wikipedia, up to three steps, within 20 s.`
              : 'Choose two specimens with Wikipedia articles to enable tracing.'}
          </p>
          {trace.phase === 'error' && (
            <p className="ww-error" role="alert">
              {trace.message}
            </p>
          )}

          <p className="ww-log" role="status" aria-live="polite">
            <span className="ww-log-label">Log</span> {status}
          </p>

          <details className="ww-details">
            <summary>Instrument settings &amp; quota</summary>
            <dl className="ww-kv">
              <div>
                <dt>Backend</dt>
                <dd>
                  {!backendReachable
                    ? 'Unreachable'
                    : usage
                      ? usage.configured
                        ? 'Configured'
                        : 'No API key'
                      : '—'}
                </dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{usage?.model ?? '—'}</dd>
              </div>
              <div>
                <dt>Interval</dt>
                <dd>≥ {usage?.intervalSeconds ?? '—'} s, one request at a time</dd>
              </div>
              <div>
                <dt>App attempts today</dt>
                <dd>{usage?.appDailyAttempts ?? '—'} / 500 (Pacific time)</dd>
              </div>
            </dl>
            <p>
              Boxes follow motion locally between samples and hide when appearance is lost, video
              stalls, or recognition is over 10 seconds old. Hiding this tab pauses sampling.
            </p>
            <p>
              Add GEMINI_API_KEY and GEMINI_MODEL to backend sdow/.env.local. Never use a VITE_ key.
              Before scanning with a new key/model, check one JPEG or PNG under 2 MB.
            </p>
            <label className="ww-field">
              <span>Image to check</span>
              <input
                type="file"
                accept="image/jpeg,image/png"
                disabled={active || starting || checking}
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
            </label>
            <button
              type="button"
              className="ww-button"
              disabled={!file || active || starting || checking}
              onClick={() => {
                void singleCheck();
              }}
            >
              {checking ? 'Checking image…' : 'Check one image'}
            </button>
          </details>
        </aside>
      </div>

      <div ref={report} className="ww-report-anchor">
        {trace.phase === 'loading' && (
          <section className="ww-report ww-report-loading" aria-busy="true">
            <p className="ww-kicker">Result</p>
            <p className="ww-loading-text">
              Searching live Wikipedia links from <strong>{specimens.A.article?.title}</strong> to{' '}
              <strong>{specimens.B.article?.title}</strong>…
            </p>
            <div className="ww-progress" aria-hidden="true" />
          </section>
        )}
        {trace.phase === 'done' && (
          <ConnectionReport
            key={`${trace.result.retrievedAt}:${trace.result.source.id}:${trace.result.target.id}`}
            result={trace.result}
            specimens={[
              {label: trace.thumbs[0].label, thumb: trace.thumbs[0].thumb},
              {label: trace.thumbs[1].label, thumb: trace.thumbs[1].thumb},
            ]}
            onReverse={reverse}
            onRescan={scanAgain}
          />
        )}
      </div>
    </main>
  );
};
