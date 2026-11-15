import {useEffect, useRef, useState, type ChangeEvent} from 'react';
import {useNavigate} from 'react-router-dom';

import {api, connect} from './api';
import {FrameReader, ObjectTracker, type Track} from './objectTracker';
import {Shell} from './Shell';
import {useArticleChoice} from './useArticleChoice';

import './wikiwormhole.css';
import './scan.css';

type Detection = {label: string; box_2d: [number, number, number, number]};
type Slot = 'A' | 'B';

// Frames sent to Gemini: longest side in pixels and JPEG quality. Smaller uploads answer sooner;
// boxes stay accurate at this size.
const SCAN_SIZE = 768;
const SCAN_QUALITY = 0.72;
// When to ask Gemini again: soon when nothing is on screen, rarely while boxes are being followed
// (the tracker keeps them current), and at most this often after a box is lost.
const RESCAN_EMPTY_MS = 3000;
const RESCAN_TRACKING_MS = 5000;
const RESCAN_AFTER_LOSS_MS = 2000;
// How often boxes are moved to follow the camera.
const TRACK_INTERVAL_MS = 50;

function jpegFrom(source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, SCAN_SIZE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', SCAN_QUALITY);
}

// The detection boxes. They update many times a second, so they re-render on their own instead of
// re-rendering the whole page.
function TrackedBoxes({
  tracker,
  scanning,
  onSelect,
}: {
  tracker: ObjectTracker;
  scanning: boolean;
  onSelect: (track: Track) => void;
}) {
  const [tracks, setTracks] = useState<Track[]>([]);
  useEffect(() => tracker.subscribe(setTracks), [tracker]);
  return (
    <>
      {tracks.map((item) => (
        <button
          key={item.id}
          className="ww-detection"
          style={{
            top: `${item.box[0] / 10}%`,
            left: `${item.box[1] / 10}%`,
            width: `${(item.box[3] - item.box[1]) / 10}%`,
            height: `${(item.box[2] - item.box[0]) / 10}%`,
          }}
          onClick={() => onSelect(item)}
          aria-label={`Select ${item.label}`}
        >
          <span>{item.label}</span>
        </button>
      ))}
      {/* Rescans while boxes are on screen happen quietly. */}
      {scanning && !tracks.length && (
        <span className="ww-scan-status" role="status">
          Looking for objects…
        </span>
      )}
    </>
  );
}

// Crops the detected object out of the scanned photo as a small square portrait.
// box_2d is [ymin, xmin, ymax, xmax] on a 0–1000 scale.
async function portraitFor(
  frame: string,
  boxes: Detection[],
  label: string
): Promise<string | undefined> {
  const box = label ? boxes.find((item) => item.label === label)?.box_2d : undefined;
  if (!frame || !box) return undefined;
  try {
    const image = new Image();
    image.src = frame;
    await image.decode();
    const [ymin, xmin, ymax, xmax] = box.map((value) => value / 1000);
    const cx = ((xmin + xmax) / 2) * image.naturalWidth;
    const cy = ((ymin + ymax) / 2) * image.naturalHeight;
    const side =
      Math.max((xmax - xmin) * image.naturalWidth, (ymax - ymin) * image.naturalHeight) * 1.1;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 240;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 240, 240);
    context.drawImage(image, cx - side / 2, cy - side / 2, side, side, 0, 0, 240, 240);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return undefined;
  }
}

export function ScanPage() {
  const navigate = useNavigate();
  const video = useRef<HTMLVideoElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef<AbortController | null>(null);
  // Which camera detection filled each slot, so its crop can become the object's portrait.
  const slotLabels = useRef<Record<Slot, string>>({A: '', B: ''});
  // Camera-filled slots keep following fresh detections until the user edits or picks one.
  const autoSelected = useRef<Record<Slot, boolean>>({A: false, B: false});
  // The crop of each chosen object, cut from the frame it was detected in at the moment it was
  // picked. Boxes disappear when objects leave view and the camera keeps re-scanning, so it cannot
  // wait until later. The latest frame and box seen for each detected label, kept after its box is
  // gone (used for photos and chips; live boxes crop the current camera picture instead).
  const seen = useRef(new Map<string, {frame: string; box: Detection['box_2d']}>());
  const slotPortraits = useRef<Record<Slot, Promise<string | undefined> | undefined>>({
    A: undefined,
    B: undefined,
  });
  const inFlight = useRef(false);
  const nextScanAt = useRef(0);
  const lastScanAt = useRef(0);
  const generation = useRef(0);
  const [tracker] = useState(() => new ObjectTracker());
  const scanNow = useRef<() => void>(() => undefined);
  const [camera, setCamera] = useState(false);
  const [starting, setStarting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [objects, setObjects] = useState<string[]>([]);
  const [frame, setFrame] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const [activeSlot, setActiveSlot] = useState<Slot | null>(null);
  const [focusedSlot, setFocusedSlot] = useState<Slot | null>(null);
  const first = useArticleChoice();
  const second = useArticleChoice();
  const choices = useRef({A: first, B: second});
  choices.current = {A: first, B: second};

  function cancelRecognition() {
    generation.current++;
    request.current?.abort();
    request.current = null;
    inFlight.current = false;
    setScanning(false);
  }
  function closeCamera() {
    cancelRecognition();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setCamera(false);
    tracker.clear();
  }
  function selectObject(label: string, track?: Track) {
    const slot = activeSlot || (!choices.current.A.query ? 'A' : 'B');
    autoSelected.current[slot] = false;
    choices.current[slot].setQuery(label);
    slotLabels.current[slot] = label;
    // Crop the portrait from what the camera shows right now, where the box currently is.
    const element = video.current;
    const current =
      track && element?.videoWidth
        ? {frame: jpegFrom(element, element.videoWidth, element.videoHeight), box: track.box}
        : seen.current.get(label);
    slotPortraits.current[slot] = current
      ? portraitFor(current.frame, [{label, box_2d: current.box}], label)
      : Promise.resolve(undefined);
    setActiveSlot(slot === 'A' ? 'B' : 'A');
  }
  // captureTime: the tracking frame taken with this picture, so boxes can be replayed to the
  // present when the answer arrives. null for a still photo.
  async function analyze(sourceFrame: string, captureTime: number | null) {
    if (inFlight.current) return;
    inFlight.current = true;
    lastScanAt.current = Date.now();
    nextScanAt.current = Number.POSITIVE_INFINITY;
    const controller = new AbortController();
    const version = generation.current;
    request.current = controller;
    setScanning(true);
    try {
      const result = await api<{objects: Detection[]}>('/recognize', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        body: JSON.stringify({imageBase64: sourceFrame.split(',')[1], mimeType: 'image/jpeg'}),
      });
      if (version !== generation.current || controller.signal.aborted) return;
      if (captureTime === null) setFrame(sourceFrame);
      tracker.detect(result.objects, captureTime);
      nextScanAt.current =
        Date.now() + (result.objects.length ? RESCAN_TRACKING_MS : RESCAN_EMPTY_MS);
      // Keep the first box of each label from this scan, for cropping portraits later.
      for (const label of new Set(result.objects.map((item) => item.label))) {
        const box = result.objects.find((item) => item.label === label)!.box_2d;
        seen.current.set(label, {frame: sourceFrame, box});
      }
      const labels = [...new Set(result.objects.map((item) => item.label))];
      setObjects(labels);
      if (labels.length >= 2) {
        (['A', 'B'] as const).forEach((slot, index) => {
          const label = labels[index];
          const choice = choices.current[slot];
          if (!autoSelected.current[slot] && choice.query) return;
          if (slotLabels.current[slot] !== label) {
            autoSelected.current[slot] = true;
            slotLabels.current[slot] = label;
            slotPortraits.current[slot] = portraitFor(sourceFrame, result.objects, label);
            choice.setQuery(label);
          }
        });
      }
      setNotice(
        labels.length ? '' : 'No clear objects found. Try a different view or type two names.'
      );
    } catch (error) {
      if (version === generation.current && !controller.signal.aborted) {
        const networkFailure =
          error instanceof TypeError && error.message.toLowerCase().includes('fetch');
        setNotice(
          error instanceof Error && error.name === 'TimeoutError'
            ? 'Recognition took too long. Try again or type two object names.'
            : networkFailure
              ? 'The scan connection dropped. The camera is still on; retrying shortly.'
              : error instanceof Error
                ? error.message
                : 'Recognition is unavailable. You can type object names.'
        );
        nextScanAt.current = Date.now() + (networkFailure ? RESCAN_TRACKING_MS : 15_000);
      }
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setScanning(false);
      }
      if (nextScanAt.current === Number.POSITIVE_INFINITY)
        nextScanAt.current = Date.now() + RESCAN_EMPTY_MS;
    }
  }
  useEffect(
    () => () => {
      generation.current++;
      request.current?.abort();
      stream.current?.getTracks().forEach((track) => track.stop());
    },
    []
  );
  useEffect(() => {
    if (!camera) return;
    if (video.current) video.current.srcObject = stream.current;
    let cancelled = false;
    const reader = new FrameReader();
    // Every TRACK_INTERVAL_MS: move the boxes with the picture, and ask Gemini when a scan is due.
    const tick = () => {
      const element = video.current;
      if (cancelled || !element?.videoWidth || document.hidden || !stream.current) return;
      const gray = reader.read(element, performance.now());
      if (!gray) return;
      const lost = tracker.push(gray);
      if (lost && !inFlight.current)
        nextScanAt.current = Math.min(
          nextScanAt.current,
          Math.max(Date.now(), lastScanAt.current + RESCAN_AFTER_LOSS_MS)
        );
      if (inFlight.current || Date.now() < nextScanAt.current) return;
      void analyze(jpegFrom(element, element.videoWidth, element.videoHeight), gray.time);
    };
    scanNow.current = tick;
    const visibility = () => {
      if (document.hidden) {
        cancelRecognition();
        tracker.clear();
        nextScanAt.current = 0;
      } else tick();
    };
    const timer = window.setInterval(tick, TRACK_INTERVAL_MS);
    document.addEventListener('visibilitychange', visibility);
    tick();
    return () => {
      cancelled = true;
      scanNow.current = () => undefined;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [camera]);

  async function openCamera() {
    setStarting(true);
    setNotice('');
    try {
      const media = await navigator.mediaDevices.getUserMedia({video: true, audio: false});
      stream.current = media;
      nextScanAt.current = 0;
      setFrame(null);
      tracker.clear();
      setCamera(true);
    } catch (error) {
      setNotice(
        error instanceof Error && error.name === 'NotAllowedError'
          ? 'Allow camera access for this site in Chrome, then try again.'
          : 'This camera is unavailable. Choose another camera, reconnect it, or choose a photo.'
      );
    } finally {
      setStarting(false);
    }
  }
  async function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    closeCamera();
    setNotice('');
    try {
      const image = await createImageBitmap(file);
      const photo = jpegFrom(image, image.width, image.height);
      image.close();
      setFrame(photo);
      await analyze(photo, null);
    } catch {
      setNotice('This photo could not be opened. Try a JPEG, PNG, or WebP image.');
    }
  }
  async function go() {
    if (!first.article || !second.article || working) return;
    const pair = [first.article, second.article] as const;
    closeCamera();
    setWorking(true);
    setNotice('Finding what your objects share…');
    try {
      const result = await connect(pair[0], pair[1]);
      const portraits = {A: await slotPortraits.current.A, B: await slotPortraits.current.B};
      navigate(`/discover/${result.connection.source.id}/${result.connection.target.id}`, {
        state: {connection: result.connection, resultToken: result.resultToken, portraits},
      });
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Could not connect these articles. Try again.'
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <Shell active="scan">
      <main className="ww-main ww-scan-page">
        <section className="ww-scan-layout" aria-label="Scan and select two objects">
          <div className="ww-camera-card">
            {/* Keeps the preview fitted to the inner camera-card frame. */}
            <div className="ww-camera-fit">
              <div className="ww-camera-stage">
                {camera || frame ? (
                  <div className="ww-video-wrap">
                    {camera ? (
                      <video
                        ref={video}
                        autoPlay
                        muted
                        playsInline
                        aria-label="Live camera preview"
                        onLoadedData={() => scanNow.current()}
                      />
                    ) : (
                      <img src={frame!} alt="Your selected photo" className="ww-scan-photo" />
                    )}
                    <TrackedBoxes
                      tracker={tracker}
                      scanning={scanning}
                      onSelect={(track) => selectObject(track.label, camera ? track : undefined)}
                    />
                  </div>
                ) : (
                  <div className="ww-camera-empty">
                    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                      <path
                        d="M6 15a3 3 0 0 1 3-3h8l3-5h8l3 5h8a3 3 0 0 1 3 3v23a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V15Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <circle cx="24" cy="26" r="9" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                    <p>Bring two objects into view.</p>
                  </div>
                )}
              </div>
            </div>
            <div className="ww-actions">
              <button
                className="ww-button ww-button--dark"
                onClick={camera ? closeCamera : openCamera}
                disabled={starting || working}
              >
                {starting ? 'Opening camera…' : camera ? 'Close camera' : 'Open camera'}
              </button>
              <button
                className="ww-button ww-button--light"
                onClick={() => upload.current?.click()}
                disabled={starting || working}
              >
                Choose a photo
              </button>
              <input
                ref={upload}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                aria-label="Choose a photo"
                hidden
                onChange={choosePhoto}
              />
            </div>
          </div>
          <div className="ww-picks" aria-label="Your two objects">
            {objects.length > 0 && (
              <div className="ww-detected-objects">
                <p>Detected objects</p>
                <div className="ww-chips">
                  {objects.map((label) => (
                    <button
                      key={label}
                      className="ww-chip"
                      onClick={() =>
                        selectObject(
                          label,
                          camera ? tracker.tracks.find((track) => track.label === label) : undefined
                        )
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(['A', 'B'] as Slot[]).map((slot) => {
              const choice = slot === 'A' ? first : second;
              const title = slot === 'A' ? 'First object' : 'Second object';
              return (
                <div
                  className="ww-object-slot"
                  key={slot}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setFocusedSlot(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setFocusedSlot(null);
                  }}
                >
                  <span className="ww-slot-letter" aria-hidden="true">
                    {slot}
                  </span>
                  <div className="ww-slot-content">
                    <label htmlFor={`ww-${slot}`}>{title}</label>
                    <input
                      id={`ww-${slot}`}
                      value={choice.query}
                      placeholder="Type an object name"
                      maxLength={100}
                      autoComplete="off"
                      onFocus={() => {
                        setActiveSlot(slot);
                        setFocusedSlot(slot);
                      }}
                      onClick={() => setFocusedSlot(slot)}
                      onChange={(event) => {
                        autoSelected.current[slot] = false;
                        slotLabels.current[slot] = '';
                        slotPortraits.current[slot] = undefined;
                        choice.setQuery(event.target.value);
                      }}
                    />
                    {choice.resolving && (
                      <p className="ww-article-state" role="status">
                        Finding the closest article…
                      </p>
                    )}
                    {choice.error && (
                      <p className="ww-article-error" role="status">
                        {choice.error}
                      </p>
                    )}
                    {focusedSlot === slot && choice.candidates.length > 0 && (
                      // Keep focus in the text box while clicking an option, so the list does not
                      // close before the click lands (labels cannot take focus; only the radio
                      // button could, which is why only the bullet used to work).
                      <fieldset
                        className="ww-article-options"
                        onMouseDown={(event) => event.preventDefault()}
                      >
                        <legend>Wikipedia article</legend>
                        <div className="ww-article-list">
                          {choice.candidates.map((article) => (
                            <label
                              key={article.id}
                              className={`ww-article-option${choice.article?.id === article.id ? ' is-selected' : ''}`}
                              // Clicking the option that is already chosen just closes the list.
                              onClick={() => {
                                if (choice.article?.id === article.id) setFocusedSlot(null);
                              }}
                            >
                              <input
                                type="radio"
                                name={`article-${slot}`}
                                value={article.id}
                                checked={choice.article?.id === article.id}
                                onChange={() => {
                                  choice.choose(article);
                                  setFocusedSlot(null);
                                }}
                              />
                              <span>
                                <b>{article.title}</b>
                                {article.description && <small>{article.description}</small>}
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="ww-connect-row">
              <button
                className="ww-button ww-button--coral ww-connect"
                onClick={go}
                disabled={
                  working ||
                  !first.article ||
                  !second.article ||
                  first.resolving ||
                  second.resolving
                }
              >
                {working ? 'Finding what’s between…' : 'Find what’s between'}
              </button>
            </div>
            {notice && (
              <p className="ww-notice" role="status">
                {notice}
              </p>
            )}
          </div>
        </section>
      </main>
    </Shell>
  );
}
