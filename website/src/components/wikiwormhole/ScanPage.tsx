import {useEffect, useRef, useState, type ChangeEvent} from 'react';
import {useNavigate} from 'react-router-dom';

import {api, connect} from './api';
import {Shell} from './Shell';
import {useArticleChoice} from './useArticleChoice';

import './wikiwormhole.css';
import './scan.css';

type Detection = {label: string; box_2d: [number, number, number, number]};
type Slot = 'A' | 'B';

export function ScanPage() {
  const navigate = useNavigate();
  const video = useRef<HTMLVideoElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const nextScanAt = useRef(0);
  const generation = useRef(0);
  const expireBoxes = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanNow = useRef<() => void>(() => undefined);
  const [camera, setCamera] = useState(false);
  const [starting, setStarting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [boxes, setBoxes] = useState<Detection[]>([]);
  const [objects, setObjects] = useState<string[]>([]);
  const [frame, setFrame] = useState<string | null>(null);
  const [ratio, setRatio] = useState(4 / 3);
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const [activeSlot, setActiveSlot] = useState<Slot | null>(null);
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
    if (expireBoxes.current) clearTimeout(expireBoxes.current);
  }
  function closeCamera() {
    cancelRecognition();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setCamera(false);
    setBoxes([]);
  }
  function selectObject(label: string) {
    const slot = activeSlot || (!choices.current.A.query ? 'A' : 'B');
    choices.current[slot].setQuery(label);
    setActiveSlot(slot === 'A' ? 'B' : 'A');
  }
  async function analyze(sourceFrame: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    nextScanAt.current = Date.now() + 6000;
    const controller = new AbortController();
    const version = generation.current;
    request.current = controller;
    setScanning(true);
    try {
      const result = await api<{objects: Detection[]}>('/recognize', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: controller.signal,
        body: JSON.stringify({imageBase64: sourceFrame.split(',')[1], mimeType: 'image/jpeg'}),
      });
      if (version !== generation.current || controller.signal.aborted) return;
      setFrame(sourceFrame);
      setBoxes(result.objects);
      const labels = [...new Set(result.objects.map((item) => item.label))];
      setObjects(labels);
      if (labels.length === 2 && !choices.current.A.query && !choices.current.B.query) {
        choices.current.A.setQuery(labels[0]);
        choices.current.B.setQuery(labels[1]);
      }
      setNotice(
        labels.length ? '' : 'No clear objects found. Try a different view or type two names.'
      );
      if (expireBoxes.current) clearTimeout(expireBoxes.current);
      expireBoxes.current = setTimeout(() => setBoxes([]), 12_000);
    } catch (error) {
      if (version === generation.current && !controller.signal.aborted) {
        setNotice(
          error instanceof Error
            ? error.message
            : 'Recognition is unavailable. You can type object names.'
        );
        nextScanAt.current = Date.now() + 15_000;
      }
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setScanning(false);
      }
    }
  }
  useEffect(
    () => () => {
      generation.current++;
      request.current?.abort();
      stream.current?.getTracks().forEach((track) => track.stop());
      if (expireBoxes.current) clearTimeout(expireBoxes.current);
    },
    []
  );
  useEffect(() => {
    if (!camera) return;
    if (video.current) video.current.srcObject = stream.current;
    let cancelled = false;
    const sample = () => {
      const element = video.current;
      if (
        cancelled ||
        !element?.videoWidth ||
        document.hidden ||
        inFlight.current ||
        !stream.current ||
        Date.now() < nextScanAt.current
      )
        return;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1280 / element.videoWidth);
      canvas.width = Math.round(element.videoWidth * scale);
      canvas.height = Math.round(element.videoHeight * scale);
      canvas.getContext('2d')?.drawImage(element, 0, 0, canvas.width, canvas.height);
      void analyze(canvas.toDataURL('image/jpeg', 0.76));
    };
    scanNow.current = sample;
    const visibility = () => {
      if (document.hidden) {
        cancelRecognition();
        setBoxes([]);
      } else sample();
    };
    const timer = window.setInterval(sample, 1000);
    document.addEventListener('visibilitychange', visibility);
    sample();
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
      const media = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'environment'},
        audio: false,
      });
      stream.current = media;
      nextScanAt.current = 0;
      setFrame(null);
      setBoxes([]);
      setCamera(true);
    } catch {
      setNotice('Camera access is unavailable. Choose a photo or type two object names.');
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
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
      setRatio(image.width / image.height);
      image.close();
      const photo = canvas.toDataURL('image/jpeg', 0.78);
      setFrame(photo);
      await analyze(photo);
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
      navigate('/discover', {
        state: {
          connection: result.connection,
          resultToken: result.resultToken,
          crops: boxes.map((item) => ({label: item.label, box_2d: item.box_2d})),
          sampledFrame: frame,
        },
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
        <header className="ww-hero ww-scan-heading">
          <h1>What connects the things around you?</h1>
          <p>Scan two objects.</p>
        </header>
        <section className="ww-scan-layout" aria-label="Scan and select two objects">
          <div className="ww-camera-card">
            <div
              className="ww-camera-stage"
              style={{aspectRatio: camera || frame ? ratio : '4 / 3'}}
            >
              {camera || frame ? (
                <div className="ww-video-wrap">
                  {camera ? (
                    <video
                      ref={video}
                      autoPlay
                      muted
                      playsInline
                      aria-label="Live camera preview"
                      onLoadedMetadata={() => {
                        if (video.current?.videoWidth)
                          setRatio(video.current.videoWidth / video.current.videoHeight);
                      }}
                      onLoadedData={() => scanNow.current()}
                    />
                  ) : (
                    <img src={frame!} alt="Your selected photo" className="ww-scan-photo" />
                  )}
                  {boxes.map((item, index) => (
                    <button
                      key={`${item.label}-${index}`}
                      className="ww-detection"
                      style={{
                        top: `${item.box_2d[0] / 10}%`,
                        left: `${item.box_2d[1] / 10}%`,
                        width: `${(item.box_2d[3] - item.box_2d[1]) / 10}%`,
                        height: `${(item.box_2d[2] - item.box_2d[0]) / 10}%`,
                      }}
                      onClick={() => selectObject(item.label)}
                      aria-label={`Select ${item.label}`}
                    >
                      <span>{item.label}</span>
                    </button>
                  ))}
                  {scanning && (
                    <span className="ww-scan-status" role="status">
                      Looking for objects…
                    </span>
                  )}
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
            <p className="ww-camera-privacy">
              Selected frames are sent to Gemini to identify objects.
            </p>
          </div>
          <div className="ww-picks" aria-label="Your two objects">
            {objects.length > 0 && (
              <div className="ww-detected-objects">
                <p>Detected objects</p>
                <div className="ww-chips">
                  {objects.map((label) => (
                    <button key={label} className="ww-chip" onClick={() => selectObject(label)}>
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
                <div className="ww-object-slot" key={slot}>
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
                      onFocus={() => setActiveSlot(slot)}
                      onChange={(event) => choice.setQuery(event.target.value)}
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
                    {choice.candidates.length > 0 && (
                      <fieldset className="ww-article-options">
                        <legend>Wikipedia article</legend>
                        <div className="ww-article-list">
                          {choice.candidates.map((article) => (
                            <label
                              key={article.id}
                              className={`ww-article-option${choice.article?.id === article.id ? ' is-selected' : ''}`}
                            >
                              <input
                                type="radio"
                                name={`article-${slot}`}
                                value={article.id}
                                checked={choice.article?.id === article.id}
                                onChange={() => choice.choose(article)}
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
                {working ? 'Finding what they share…' : 'Find what they share'}
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
