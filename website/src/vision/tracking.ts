// Local appearance tracking only. Gemini supplies identities and fresh boxes.
// Small grayscale frames and sparse normalized correlation keep work bounded.
export type Box = [number, number, number, number];
export interface Detection {
  label: string;
  box_2d: Box;
}
export interface Frame {
  width: number;
  height: number;
  time: number;
  pixels: Uint8Array;
}
export interface TrackedObject extends Detection {
  id: string;
  tracking: boolean;
}
interface Track extends TrackedObject {
  template: Float32Array;
  norm: number;
  mean: number;
}
const GRID = 10;
const MAX_AGE = 10000;

function patch(frame: Frame, box: Box) {
  const [y0, x0, y1, x1] = box;
  const values = new Float32Array(GRID * GRID);
  let sum = 0;
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      // Stay inside the object to reduce background influence.
      const px = Math.round(
        ((x0 + (x1 - x0) * (0.1 + (0.8 * x) / (GRID - 1))) * frame.width) / 1000
      );
      const py = Math.round(
        ((y0 + (y1 - y0) * (0.1 + (0.8 * y) / (GRID - 1))) * frame.height) / 1000
      );
      const value =
        frame.pixels[
          Math.min(frame.height - 1, Math.max(0, py)) * frame.width +
            Math.min(frame.width - 1, Math.max(0, px))
        ];
      values[y * GRID + x] = value;
      sum += value;
    }
  const mean = sum / values.length;
  let norm = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] -= mean;
    norm += values[i] * values[i];
  }
  return {values, mean, norm: Math.sqrt(norm)};
}
function similarity(template: Track, frame: Frame, box: Box) {
  const candidate = patch(frame, box);
  if (candidate.norm < 80 || Math.abs(template.mean - candidate.mean) > 45) return -1;
  let dot = 0;
  for (let i = 0; i < candidate.values.length; i++)
    dot += candidate.values[i] * template.template[i];
  return dot / (template.norm * candidate.norm);
}
function moved(box: Box, dx: number, dy: number, scale = 1): Box {
  const [y0, x0, y1, x1] = box;
  const cx = (x0 + x1) / 2 + dx,
    cy = (y0 + y1) / 2 + dy;
  const w = ((x1 - x0) * scale) / 2,
    h = ((y1 - y0) * scale) / 2;
  return [cy - h, cx - w, cy + h, cx + w];
}
function inside(box: Box) {
  return box[0] >= 0 && box[1] >= 0 && box[2] <= 1000 && box[3] <= 1000;
}

export class MotionTracker {
  private tracks: Track[] = [];
  private history: Frame[] = [];
  private seeded = 0;
  private last: Frame | null = null;

  reset() {
    this.tracks = [];
    this.history = [];
    this.last = null;
    this.seeded = 0;
  }

  seed(objects: Detection[], frame: Frame): TrackedObject[] {
    const latest = this.last;
    if (
      latest &&
      (latest.time - frame.time >= MAX_AGE ||
        latest.width !== frame.width ||
        latest.height !== frame.height)
    ) {
      this.tracks = [];
      return [];
    }
    this.seeded = frame.time;
    const seen = new Map<string, number>();
    this.tracks = objects.map((item) => {
      const index = seen.get(item.label) || 0;
      seen.set(item.label, index + 1);
      const sample = patch(frame, item.box_2d);
      const [y0, x0, y1, x1] = item.box_2d;
      return {
        ...item,
        id: `${frame.time}:${item.label}:${index}`,
        template: sample.values,
        norm: sample.norm,
        mean: sample.mean,
        tracking:
          sample.norm >= 80 &&
          ((x1 - x0) * frame.width) / 1000 >= 10 &&
          ((y1 - y0) * frame.height) / 1000 >= 10,
      };
    });
    // The response describes an older frame. Replay intervening local frames instead
    // of attaching its boxes directly to today's pixels.
    let previous = frame;
    for (const next of this.history.filter((item) => item.time > frame.time)) {
      if (next.time - previous.time > 500) {
        this.tracks.forEach((track) => {
          track.tracking = false;
        });
        break;
      }
      this.advance(next);
      previous = next;
    }
    return this.result();
  }

  push(frame: Frame): TrackedObject[] {
    if (
      this.last &&
      (this.last.width !== frame.width ||
        this.last.height !== frame.height ||
        frame.time - this.last.time > 500)
    )
      this.tracks.forEach((track) => {
        track.tracking = false;
      });
    this.history.push(frame);
    this.history = this.history.filter((item) => frame.time - item.time < MAX_AGE).slice(-110);
    this.last = frame;
    if (frame.time - this.seeded >= MAX_AGE) this.tracks = [];
    else this.advance(frame);
    return this.result();
  }

  private advance(frame: Frame) {
    for (const track of this.tracks) {
      if (!track.tracking) continue;
      const original = track.box_2d;
      let best = original,
        score = -1;
      // Pixel translation search, then small scale changes.
      for (let dy = -12; dy <= 12; dy++)
        for (let dx = -12; dx <= 12; dx++) {
          const box = moved(original, (dx * 1000) / frame.width, (dy * 1000) / frame.height);
          if (!inside(box)) continue;
          const value = similarity(track, frame, box);
          if (value > score) {
            best = box;
            score = value;
          }
        }
      const coarse = best;
      for (const scale of [0.96, 1, 1.04])
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const box = moved(coarse, (dx * 1000) / frame.width, (dy * 1000) / frame.height, scale);
            if (!inside(box)) continue;
            const value = similarity(track, frame, box);
            if (value > score) {
              best = box;
              score = value;
            }
          }
      // Never display a guessed continuation after appearance is lost. Keep the
      // original template until a fresh Gemini response to limit gradual drift.
      if (score < 0.78) track.tracking = false;
      else track.box_2d = best;
    }
  }
  private result(): TrackedObject[] {
    return this.tracks.map(({id, label, box_2d, tracking}) => ({id, label, box_2d, tracking}));
  }
}

export type TrackerMessage =
  {type: 'frame'; frame: Frame} | {type: 'seed'; objects: Detection[]; frame: Frame};
