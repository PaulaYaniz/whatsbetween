// Offline checks for the box tracker on synthetic frames: a textured object moving over a
// textured background. Run with: node --test scripts/test-object-tracker.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import {ObjectTracker, smooth, trackBox} from '../src/components/wikiwormhole/objectTracker.ts';

const WIDTH = 160;
const HEIGHT = 120;

// Random texture with features a few pixels across, like a downscaled camera picture.
function texture(seed, width, height) {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const coarse = Array.from({length: 40 * 40}, () => random() * 255);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const gx = Math.min(39, x / 4);
      const gy = Math.min(39, y / 4);
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      const at = (i, j) => coarse[Math.min(39, j) * 40 + Math.min(39, i)];
      data[y * width + x] =
        (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
        (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    }
  return data;
}

const background = texture(7, WIDTH, HEIGHT);
const object = texture(99, 40, 30);

// The object's top-left corner at (x, y) in frame pixels.
function frameWithObject(x, y, time) {
  const data = background.slice();
  for (let j = 0; j < 30; j++)
    for (let i = 0; i < 40; i++) {
      const fx = x + i;
      const fy = y + j;
      if (fx >= 0 && fx < WIDTH && fy >= 0 && fy < HEIGHT)
        data[fy * WIDTH + fx] = object[j * 40 + i];
    }
  return {data, width: WIDTH, height: HEIGHT, time};
}

function boxAt(x, y) {
  return [
    Math.round((y / HEIGHT) * 1000),
    Math.round((x / WIDTH) * 1000),
    Math.round(((y + 30) / HEIGHT) * 1000),
    Math.round(((x + 40) / WIDTH) * 1000),
  ];
}

function assertNear(actual, expected, tolerance, message) {
  actual.forEach((value, index) =>
    assert.ok(
      Math.abs(value - expected[index]) <= tolerance,
      `${message}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`
    )
  );
}

test('a box follows its object to the next frame', () => {
  const result = trackBox(
    smooth(frameWithObject(50, 40, 0)),
    smooth(frameWithObject(55, 43, 50)),
    boxAt(50, 40)
  );
  assert.ok(result.score > 0.9, `score ${result.score}`);
  // 1 px is 6.25 units across and 8.3 down; allow about 1.5 px.
  assertNear(result.box, boxAt(55, 43), 14, 'moved box');
});

test('a late detection is replayed through the frames seen since it was taken', () => {
  const tracker = new ObjectTracker();
  // The object drifts right and down by 3 px per frame for 20 frames.
  for (let step = 0; step <= 20; step++)
    tracker.push(frameWithObject(30 + step * 3, 20 + step * 2, step));
  // Gemini answers about frame 0 only now.
  tracker.detect([{label: 'cube', box_2d: boxAt(30, 20)}], 0);
  assert.equal(tracker.tracks.length, 1);
  assertNear(tracker.tracks[0].box, boxAt(90, 60), 20, 'replayed box');
  // And it keeps following live frames.
  tracker.push(frameWithObject(93, 62, 21));
  assertNear(tracker.tracks[0].box, boxAt(93, 62), 20, 'live box');
});

test('a box whose object disappears is dropped instead of left behind', () => {
  const tracker = new ObjectTracker();
  tracker.push(frameWithObject(50, 40, 0));
  tracker.detect([{label: 'cube', box_2d: boxAt(50, 40)}], 0);
  // The object is gone: only background, shifted texture would match poorly.
  for (let step = 1; step <= 12; step++)
    tracker.push({
      data: texture(1000 + step, WIDTH, HEIGHT),
      width: WIDTH,
      height: HEIGHT,
      time: step,
    });
  assert.equal(tracker.tracks.length, 0);
});

test('a new detection overlapping an old box keeps its id', () => {
  const tracker = new ObjectTracker();
  tracker.push(frameWithObject(50, 40, 0));
  tracker.detect([{label: 'cube', box_2d: boxAt(50, 40)}], 0);
  const id = tracker.tracks[0].id;
  tracker.detect([{label: 'block', box_2d: boxAt(52, 41)}], 0);
  assert.equal(tracker.tracks[0].id, id);
  assert.equal(tracker.tracks[0].label, 'block');
});
