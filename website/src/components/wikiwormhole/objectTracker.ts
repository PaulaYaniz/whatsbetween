// Follows detected objects between Gemini answers by matching each box's picture from one camera
// frame to the next (normalized cross-correlation on small grayscale frames). Gemini answers take
// seconds, so its boxes are replayed through the frames captured while it was thinking and land
// where the object is now, not where it was.

// [ymin, xmin, ymax, xmax] on a 0–1000 scale, as Gemini returns them.
export type Box = [number, number, number, number];

export interface GrayFrame {
  data: Uint8Array;
  width: number;
  height: number;
  time: number;
}

export interface Track {
  id: number;
  label: string;
  box: Box;
  misses: number;
}

// Width of the grayscale frames used for tracking.
export const TRACK_WIDTH = 160;
// Frames kept for replaying late Gemini answers, and the most matching steps a replay may take
// (longer backlogs skip frames so the page does not stall).
const BUFFER_MS = 25_000;
const MAX_REPLAY_STEPS = 40;
// Samples per side of the grid compared inside each box.
const GRID = 12;
// Below this correlation a frame counts as a miss; after MAX_MISSES misses in a row the box is
// dropped rather than left where the object used to be. Real moves score above 0.9; unrelated
// textures score up to about 0.6.
const MIN_SCORE = 0.7;
const MAX_MISSES = 8;
// Boxes with almost no texture (a plain wall) cannot be matched; they stay put instead.
const MIN_CONTRAST = 6;
const SCALES = [0.93, 1, 1.07];
// A size change must match this much better than keeping the size, or boxes slowly shrink or grow.
const SCALE_PENALTY = 0.03;

// 3×3 box blur, so matching compares small areas rather than single noisy pixels.
export function smooth(frame: GrayFrame): GrayFrame {
  const {width, height, data} = frame;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width;
    const row = y * width;
    const down = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - 1);
      const right = Math.min(width - 1, x + 1);
      out[row + x] =
        (data[up + left] +
          data[up + x] +
          data[up + right] +
          data[row + left] +
          data[row + x] +
          data[row + right] +
          data[down + left] +
          data[down + x] +
          data[down + right]) /
        9;
    }
  }
  return {...frame, data: out};
}

function sampleNearest(frame: GrayFrame, x: number, y: number) {
  const xi = Math.min(frame.width - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(frame.height - 1, Math.max(0, Math.round(y)));
  return frame.data[yi * frame.width + xi];
}

function sampleBilinear(frame: GrayFrame, x: number, y: number) {
  const cx = Math.min(frame.width - 1.001, Math.max(0, x));
  const cy = Math.min(frame.height - 1.001, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const row = y0 * frame.width;
  const top = frame.data[row + x0] * (1 - fx) + frame.data[row + x0 + 1] * fx;
  const bottom =
    frame.data[row + frame.width + x0] * (1 - fx) + frame.data[row + frame.width + x0 + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

// The box in frame pixels: centre and half-size of the inner 80%, which is mostly the object
// rather than the background around it.
function region(frame: GrayFrame, box: Box) {
  const [ymin, xmin, ymax, xmax] = box;
  const cx = ((xmin + xmax) / 2000) * frame.width;
  const cy = ((ymin + ymax) / 2000) * frame.height;
  const hw = ((xmax - xmin) / 2000) * frame.width * 0.8;
  const hh = ((ymax - ymin) / 2000) * frame.height * 0.8;
  return {cx, cy, hw, hh};
}

function patch(
  frame: GrayFrame,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  sample: (frame: GrayFrame, x: number, y: number) => number,
  out: Float32Array
) {
  let sum = 0;
  let index = 0;
  for (let j = 0; j < GRID; j++) {
    const y = cy - hh + ((j + 0.5) / GRID) * 2 * hh;
    for (let i = 0; i < GRID; i++) {
      const value = sample(frame, cx - hw + ((i + 0.5) / GRID) * 2 * hw, y);
      out[index++] = value;
      sum += value;
    }
  }
  return sum / out.length;
}

// Template values with the mean removed, and their spread.
function normalized(values: Float32Array, mean: number) {
  let squares = 0;
  for (let k = 0; k < values.length; k++) {
    values[k] -= mean;
    squares += values[k] * values[k];
  }
  return Math.sqrt(squares / values.length);
}

function correlation(template: Float32Array, spread: number, values: Float32Array, mean: number) {
  let cross = 0;
  let squares = 0;
  for (let k = 0; k < values.length; k++) {
    const value = values[k] - mean;
    cross += template[k] * value;
    squares += value * value;
  }
  const candidateSpread = Math.sqrt(squares / values.length);
  if (candidateSpread < 1e-3) return -1;
  return cross / values.length / (spread * candidateSpread);
}

function toBox(frame: GrayFrame, cx: number, cy: number, hw: number, hh: number): Box {
  // Undo the 80% inset used for matching.
  const w = hw / 0.8;
  const h = hh / 0.8;
  const clamp = (value: number) => Math.min(1000, Math.max(0, Math.round(value)));
  return [
    clamp(((cy - h) / frame.height) * 1000),
    clamp(((cx - w) / frame.width) * 1000),
    clamp(((cy + h) / frame.height) * 1000),
    clamp(((cx + w) / frame.width) * 1000),
  ];
}

// Where the box from `previous` is in `next`. score is the match quality (-1 to 1).
export function trackBox(previous: GrayFrame, next: GrayFrame, box: Box) {
  const {cx, cy, hw, hh} = region(previous, box);
  if (hw < 1.5 || hh < 1.5) return {box, score: 1};
  const template = new Float32Array(GRID * GRID);
  const spread = normalized(template, patch(previous, cx, cy, hw, hh, sampleBilinear, template));
  if (spread < MIN_CONTRAST) return {box, score: 1};
  const values = new Float32Array(GRID * GRID);
  // Search up to half the matched area's size (at least 4 px, at most 14 px) in each direction.
  const reach = Math.min(14, Math.max(4, Math.round(Math.max(hw, hh) * 0.5)));
  let best = {score: -2, dx: 0, dy: 0, scale: 1};
  // Coarse pass: every second pixel, nearest-pixel sampling.
  for (const scale of SCALES) {
    for (let dy = -reach; dy <= reach; dy += 2) {
      for (let dx = -reach; dx <= reach; dx += 2) {
        const mean = patch(next, cx + dx, cy + dy, hw * scale, hh * scale, sampleNearest, values);
        const score =
          correlation(template, spread, values, mean) - (scale === 1 ? 0 : SCALE_PENALTY);
        if (score > best.score) best = {score, dx, dy, scale};
      }
    }
  }
  // Fine pass around the best: half-pixel steps, smooth sampling.
  const coarse = best;
  best = {...best, score: -2};
  for (let dy = coarse.dy - 1; dy <= coarse.dy + 1; dy += 0.5) {
    for (let dx = coarse.dx - 1; dx <= coarse.dx + 1; dx += 0.5) {
      const mean = patch(
        next,
        cx + dx,
        cy + dy,
        hw * coarse.scale,
        hh * coarse.scale,
        sampleBilinear,
        values
      );
      const score = correlation(template, spread, values, mean);
      if (score > best.score) best = {score, dx, dy, scale: coarse.scale};
    }
  }
  return {
    box: toBox(next, cx + best.dx, cy + best.dy, hw * best.scale, hh * best.scale),
    score: best.score,
  };
}

function overlap(a: Box, b: Box) {
  const height = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const width = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (height <= 0 || width <= 0) return 0;
  const shared = height * width;
  const area = (box: Box) => (box[2] - box[0]) * (box[3] - box[1]);
  return shared / (area(a) + area(b) - shared);
}

export class ObjectTracker {
  private frames: GrayFrame[] = [];
  private listeners = new Set<(tracks: Track[]) => void>();
  private nextId = 1;
  tracks: Track[] = [];

  subscribe(listener: (tracks: Track[]) => void) {
    this.listeners.add(listener);
    listener(this.tracks);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of this.listeners) listener(this.tracks);
  }

  // Move every box from the previous live frame to this one. Returns the number of boxes lost.
  push(raw: GrayFrame) {
    const frame = smooth(raw);
    const previous = this.frames[this.frames.length - 1];
    this.frames.push(frame);
    while (this.frames.length > 2 && frame.time - this.frames[0].time > BUFFER_MS)
      this.frames.shift();
    if (!previous || previous.width !== frame.width || previous.height !== frame.height) return 0;
    const before = this.tracks.length;
    this.tracks = ObjectTracker.step(this.tracks, previous, frame);
    if (before) this.emit();
    return before - this.tracks.length;
  }

  private static step(tracks: Track[], previous: GrayFrame, next: GrayFrame) {
    return tracks.flatMap((track) => {
      const result = trackBox(previous, next, track.box);
      const moved =
        result.score >= MIN_SCORE
          ? {...track, box: result.box, misses: 0}
          : {...track, misses: track.misses + 1};
      const [ymin, xmin, ymax, xmax] = moved.box;
      const centreInside = (ymin + ymax) / 2 > 0 && (ymin + ymax) / 2 < 1000;
      const centreInsideX = (xmin + xmax) / 2 > 0 && (xmin + xmax) / 2 < 1000;
      return moved.misses > MAX_MISSES || !centreInside || !centreInsideX ? [] : [moved];
    });
  }

  // New detections for the frame captured at `time` (or a still photo when time is null). The
  // boxes are replayed through the frames seen since then. A detection that overlaps an existing
  // box keeps that box's id, so it moves rather than blinking out and back.
  detect(detections: {label: string; box_2d: Box}[], time: number | null) {
    let tracks: Track[] = detections.map((item) => {
      const match = this.tracks
        .map((track) => ({track, score: overlap(track.box, item.box_2d)}))
        .filter((candidate) => candidate.score > 0.3)
        .sort((a, b) => b.score - a.score)[0];
      return {id: match?.track.id ?? this.nextId++, label: item.label, box: item.box_2d, misses: 0};
    });
    // Two detections can claim the same old box; the second gets a new id.
    const used = new Set<number>();
    tracks = tracks.map((track) => {
      if (!used.has(track.id)) {
        used.add(track.id);
        return track;
      }
      return {...track, id: this.nextId++};
    });
    if (time !== null) {
      const start = this.frames.findIndex((frame) => frame.time === time);
      if (start >= 0) {
        const last = this.frames.length - 1;
        const stride = Math.max(1, Math.ceil((last - start) / MAX_REPLAY_STEPS));
        for (let index = start; index < last;) {
          const following = Math.min(last, index + stride);
          const previous = this.frames[index];
          const next = this.frames[following];
          if (previous.width === next.width && previous.height === next.height)
            tracks = ObjectTracker.step(tracks, previous, next);
          index = following;
        }
      }
    }
    this.tracks = tracks;
    this.emit();
  }

  clear() {
    this.tracks = [];
    this.frames = [];
    this.emit();
  }
}

// Reads small grayscale frames from the camera preview.
export class FrameReader {
  private canvas = document.createElement('canvas');
  private context = this.canvas.getContext('2d', {willReadFrequently: true});

  read(video: HTMLVideoElement, time: number): GrayFrame | null {
    if (!this.context || !video.videoWidth || !video.videoHeight) return null;
    const width = TRACK_WIDTH;
    const height = Math.max(1, Math.round((TRACK_WIDTH * video.videoHeight) / video.videoWidth));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.context.drawImage(video, 0, 0, width, height);
    const rgba = this.context.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let p = 0, q = 0; p < data.length; p++, q += 4)
      data[p] = (rgba[q] * 77 + rgba[q + 1] * 150 + rgba[q + 2] * 29) >> 8;
    return {data, width, height, time};
  }
}
