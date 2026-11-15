import {useEffect, useMemo, useRef, useState} from 'react';

import type {Article, Connection, PathInfo, PathStop} from './api';

import './loom.css';

// The loom: object A on the left, object B on the right. Every line is one real Wikipedia link.
// Shared articles sit between them with one line from each object; when there are none, the
// busiest stops on the shortest paths are laid out in columns, one per step.

export interface LoomSelection {
  kind: 'shared' | 'stop';
  article: Article;
  // For stops: position along the path (1 = first stop after A) and how many shortest paths pass
  // through it.
  step?: number;
  through?: number;
}

type Tone = 'a' | 'b' | 'between' | 'direct';
interface Point {
  x: number;
  y: number;
}
interface Knot {
  key: string;
  article: Article;
  kind: 'shared' | 'stop';
  at: Point;
  step?: number;
  through?: number;
  delay: number;
}
interface Thread {
  key: string;
  d: string;
  tone: Tone;
  ends: [number, number];
  delay: number;
}
interface Layout {
  height: number;
  anchorY: number;
  // Centres of the two object portraits.
  portraitA: Point;
  portraitB: Point;
  // Narrow screens lay path maps out top to bottom: object A above, object B below.
  vertical: boolean;
  portrait: number;
  knots: Knot[];
  threads: Thread[];
  directLabel?: Point;
  unitsPerPx: number;
  // Widest a knot label may be, as a share of the loom width.
  knotMax: string;
  // Rows were squeezed to fit the screen; knots use a smaller style.
  compact: boolean;
  // Shared articles left off the map because they do not fit (shown with "Show more").
  hidden: number;
}

const WIDTH = 1000;

// Top-to-bottom version of curve(), for the vertical layout.
function curveDown(from: Point, to: Point, bend = 0.5) {
  const dy = to.y - from.y;
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + dy * bend}, ${to.x} ${to.y - dy * bend}, ${to.x} ${to.y}`;
}

function curve(from: Point, to: Point, bend = 0.5) {
  const dx = to.x - from.x;
  return `M ${from.x} ${from.y} C ${from.x + dx * bend} ${from.y}, ${to.x - dx * bend} ${to.y}, ${to.x} ${to.y}`;
}

// Steps and links for a path. Uses the server summary when present; otherwise derives them from
// example routes so older results still draw.
export function pathSteps(path: PathInfo | undefined) {
  if (!path?.found) return {steps: [] as PathStop[][], links: [] as [number, number][]};
  if (path.steps?.length) return {steps: path.steps, links: path.links ?? []};
  const steps: PathStop[][] = [];
  const links = new Set<string>();
  for (let step = 1; step < (path.hops ?? 0); step++) {
    const seen = new Map<number, PathStop>();
    for (const route of path.routes)
      if (route[step]) seen.set(route[step].id, {...route[step], through: 0});
    steps.push([...seen.values()]);
  }
  for (const route of path.routes)
    for (let index = 0; index < route.length - 1; index++)
      links.add(`${route[index].id}>${route[index + 1].id}`);
  return {steps, links: [...links].map((key) => key.split('>').map(Number) as [number, number])};
}

// Keep only stops that still lie on a complete visible route after truncation.
function connectedSteps(
  steps: PathStop[][],
  links: [number, number][],
  sourceId: number,
  targetId: number
): PathStop[][] {
  const forward = new Set([sourceId]);
  const reachable = steps.map((column) => {
    const next = column.filter((stop) =>
      links.some(([from, to]) => to === stop.id && forward.has(from))
    );
    next.forEach((stop) => forward.add(stop.id));
    return next;
  });
  const backward = new Set([targetId]);
  for (const column of reachable.slice().reverse()) {
    column
      .filter((stop) => links.some(([from, to]) => from === stop.id && backward.has(to)))
      .forEach((stop) => backward.add(stop.id));
  }
  return reachable.map((column) => column.filter((stop) => backward.has(stop.id)));
}

// Draw a sparse, representative set of real links between visible stops.
function visibleLinks(
  links: [number, number][],
  steps: PathStop[][],
  sourceId: number,
  targetId: number
): [number, number][] {
  const columns = [[sourceId], ...steps.map((column) => column.map((stop) => stop.id)), [targetId]];
  const chosen: [number, number][] = [];
  for (let index = 0; index < columns.length - 1; index++) {
    const left = columns[index];
    const right = columns[index + 1];
    const possible = links.filter(([from, to]) => left.includes(from) && right.includes(to));
    const distance = ([from, to]: [number, number]) =>
      Math.abs((left.indexOf(from) + 0.5) / left.length - (right.indexOf(to) + 0.5) / right.length);
    for (const from of left) {
      const best = possible
        .filter((edge) => edge[0] === from)
        .sort((a, b) => distance(a) - distance(b))[0];
      if (best) chosen.push(best);
    }
    for (const to of right) {
      if (chosen.some((edge) => edge[1] === to)) continue;
      const best = possible
        .filter((edge) => edge[1] === to)
        .sort((a, b) => distance(a) - distance(b))[0];
      if (best) chosen.push(best);
    }
    // A few additional real links show that some stops branch more than others.
    // Keep each middle stop below five links in either direction.
    if (index > 0 && index < columns.length - 2) {
      for (const from of left) {
        const available = possible.filter((edge) => edge[0] === from);
        const desired = Math.min(5, available.length, 1 + (Math.abs(from) % 5));
        for (const edge of available.sort((a, b) => distance(a) - distance(b))) {
          if (chosen.filter((item) => item[0] === from).length >= desired) break;
          if (chosen.some((item) => item[0] === edge[0] && item[1] === edge[1])) continue;
          if (chosen.filter((item) => item[1] === edge[1]).length >= 5) continue;
          chosen.push(edge);
        }
      }
    }
  }
  return [...new Map(chosen.map((edge) => [edge.join('>'), edge])).values()];
}

// The busiest full route through a stop, following the links shown on the map.
export function busiestRoute(connection: Connection, stopId: number): Article[] {
  const {steps, links} = pathSteps(connection.path);
  const byId = new Map<number, Article & {through?: number}>(
    steps.flat().map((stop) => [stop.id, stop])
  );
  byId.set(connection.source.id, connection.source);
  byId.set(connection.target.id, connection.target);
  const score = (id: number) => byId.get(id)?.through ?? 0;
  const route = [stopId];
  for (let current = stopId; current !== connection.source.id;) {
    const parents = links.filter(([, to]) => to === current).map(([from]) => from);
    if (!parents.length) break;
    current = parents.sort((a, b) => score(b) - score(a))[0];
    route.unshift(current);
  }
  for (let current = stopId; current !== connection.target.id;) {
    const children = links.filter(([from]) => from === current).map(([, to]) => to);
    if (!children.length) break;
    current = children.sort((a, b) => score(b) - score(a))[0];
    route.push(current);
  }
  return route.map((id) => byId.get(id)).filter((item): item is Article => Boolean(item));
}

function buildLayout(
  connection: Connection,
  width: number,
  availableHeight = 0,
  expanded = false
): Layout {
  const unitsPerPx = WIDTH / width;
  const narrow = width < 640;
  const portrait = narrow ? 56 : availableHeight && availableHeight < 380 ? 64 : 88;
  const ax = (portrait + 6) * unitsPerPx;
  const bx = WIDTH - ax;
  const mid = WIDTH / 2;
  const maxRow = narrow ? 54 : 48;
  // Rows shrink to fit the height available (down to 30 px) so the whole map stays on screen.
  const fitRow = (count: number, reservedPx = 0) => {
    if (!availableHeight || !count) return maxRow * unitsPerPx;
    const px = (availableHeight - 64 - reservedPx) / count;
    return Math.max(narrow ? 28 : 30, Math.min(maxRow, px)) * unitsPerPx;
  };
  let row = maxRow * unitsPerPx;
  const pad = 30 * unitsPerPx;
  const minHeight = (portrait + 90) * unitsPerPx;
  const path = connection.path;
  const shared = connection.sharedTopics;
  const direct = expanded && Boolean(path?.found && path.hops === 1);
  const sourceId = connection.source.id;
  const targetId = connection.target.id;
  const knots: Knot[] = [];
  const threads: Thread[] = [];
  let height = minHeight;
  let anchorY = minHeight / 2;
  let directLabel: Point | undefined;
  let knotMax = '36%';
  // Columns are narrow (many steps or a small screen): use the compact knot style.
  let tight = false;
  let vertical = false;
  let portraitA: Point | undefined;
  let portraitB: Point | undefined;

  let hidden = 0;
  if (shared.length) {
    // Keep the regular map small; expansion adds only as many articles as fit.
    const band = direct ? 48 : 0;
    const capacity = availableHeight
      ? Math.max(4, Math.floor((availableHeight - 50 - band) / (narrow ? 28 : 30)))
      : shared.length;
    const visible = shared.slice(0, Math.min(expanded ? 24 : 8, capacity));
    hidden = shared.length - visible.length;
    const topBand = band * unitsPerPx;
    row = fitRow(visible.length, band);
    const top = pad + topBand;
    height = Math.max(minHeight + topBand, top + row * visible.length + pad);
    anchorY = top + (row * visible.length) / 2;
    visible.forEach((article, index) => {
      const at = {x: mid, y: top + row * (index + 0.5)};
      const key = `shared-${article.id}`;
      knots.push({key, article, kind: 'shared', at, delay: 380 + index * 45});
      threads.push(
        {
          key: `${key}-a`,
          d: curve({x: ax, y: anchorY}, at),
          tone: 'a',
          ends: [sourceId, article.id],
          delay: index * 45,
        },
        {
          key: `${key}-b`,
          d: curve({x: bx, y: anchorY}, at),
          tone: 'b',
          ends: [article.id, targetId],
          delay: index * 45,
        }
      );
    });
  } else if (path?.found && (path.hops ?? 0) >= 2 && narrow) {
    // Phones: object A on top, each step a row of up to three stops, object B at the bottom, so
    // the whole map fits the width without sideways scrolling.
    vertical = true;
    tight = true;
    knotMax = '31%';
    const raw = pathSteps(path);
    const limit = expanded ? 24 : 8;
    const steps = connectedSteps(
      raw.steps.map((column, index) =>
        column.slice(
          0,
          Math.floor(limit / raw.steps.length) + (index < limit % raw.steps.length ? 1 : 0)
        )
      ),
      raw.links,
      sourceId,
      targetId
    );
    const links = visibleLinks(raw.links, steps, sourceId, targetId);
    const perLine = 3;
    const line = 46 * unitsPerPx;
    const gap = 34 * unitsPerPx;
    const radius = (portrait / 2) * unitsPerPx;
    const bands = steps.map((column) => Math.max(1, Math.ceil(column.length / perLine)) * line);
    height =
      pad * 2 + radius * 4 + bands.reduce((sum, band) => sum + band, 0) + gap * (steps.length + 1);
    portraitA = {x: mid, y: pad + radius};
    portraitB = {x: mid, y: height - pad - radius};
    anchorY = height / 2;
    const position = new Map<number, Point>([
      [sourceId, {x: mid, y: portraitA.y + radius}],
      [targetId, {x: mid, y: portraitB.y - radius}],
    ]);
    const stepOf = new Map<number, number>([[sourceId, 0]]);
    let y = pad + radius * 2 + gap;
    steps.forEach((column, index) => {
      const step = index + 1;
      column.forEach((stop, i) => {
        const lineIndex = Math.floor(i / perLine);
        const inLine = Math.min(perLine, column.length - lineIndex * perLine);
        const at = {x: (WIDTH * ((i % perLine) + 0.5)) / inLine, y: y + line * (lineIndex + 0.5)};
        position.set(stop.id, at);
        stepOf.set(stop.id, step);
        knots.push({
          key: `stop-${stop.id}`,
          article: stop,
          kind: 'stop',
          at,
          step,
          through: stop.through,
          delay: 300 + step * 260,
        });
      });
      y += bands[index] + gap;
    });
    for (const [from, to] of links) {
      const start = position.get(from);
      const end = position.get(to);
      if (!start || !end) continue;
      threads.push({
        key: `${from}>${to}`,
        d: curveDown(start, end),
        tone: from === sourceId ? 'a' : to === targetId ? 'b' : 'between',
        ends: [from, to],
        delay: (stepOf.get(from) ?? 0) * 260,
      });
    }
  } else if (path?.found && (path.hops ?? 0) >= 2) {
    const hops = path.hops ?? 2;
    const raw = pathSteps(path);
    const limit = expanded ? 24 : 8;
    const steps = connectedSteps(
      raw.steps.map((column, index) =>
        column.slice(
          0,
          Math.floor(limit / raw.steps.length) + (index < limit % raw.steps.length ? 1 : 0)
        )
      ),
      raw.links,
      sourceId,
      targetId
    );
    const links = visibleLinks(raw.links, steps, sourceId, targetId);
    knotMax = `${Math.max(14, Math.round(80 / hops))}%`;
    tight = width / hops < 230;
    const tallest = Math.max(1, ...steps.map((column) => column.length));
    row = fitRow(tallest);
    height = Math.max(minHeight, pad * 2 + tallest * row);
    anchorY = height / 2;
    const position = new Map<number, Point>([
      [sourceId, {x: ax, y: anchorY}],
      [targetId, {x: bx, y: anchorY}],
    ]);
    const stepOf = new Map<number, number>([[sourceId, 0]]);
    steps.forEach((column, index) => {
      const step = index + 1;
      const x = ax + ((bx - ax) * step) / hops;
      column.forEach((stop, rowIndex) => {
        const at = {x, y: anchorY + (rowIndex - (column.length - 1) / 2) * row};
        position.set(stop.id, at);
        stepOf.set(stop.id, step);
        knots.push({
          key: `stop-${stop.id}`,
          article: stop,
          kind: 'stop',
          at,
          step,
          through: stop.through,
          delay: 300 + step * 260,
        });
      });
    });
    for (const [from, to] of links) {
      const start = position.get(from);
      const end = position.get(to);
      if (!start || !end) continue;
      threads.push({
        key: `${from}>${to}`,
        d: curve(start, end),
        tone: from === sourceId ? 'a' : to === targetId ? 'b' : 'between',
        ends: [from, to],
        delay: (stepOf.get(from) ?? 0) * 260,
      });
    }
  }

  if (direct) {
    // The direct link rises from both objects to a crest above the knots, where its label sits.
    const crestY = shared.length ? pad + 18 * unitsPerPx : anchorY - 44 * unitsPerPx;
    const left = mid - ax;
    threads.push({
      key: 'direct',
      d: `M ${ax} ${anchorY} C ${ax + left * 0.55} ${anchorY}, ${mid - left * 0.45} ${crestY}, ${mid} ${crestY} C ${mid + left * 0.45} ${crestY}, ${bx - left * 0.55} ${anchorY}, ${bx} ${anchorY}`,
      tone: 'direct',
      ends: [sourceId, targetId],
      delay: 0,
    });
    directLabel = {x: mid, y: crestY};
  }

  const radius = (portrait / 2) * unitsPerPx;
  return {
    height,
    anchorY,
    portraitA: portraitA ?? {x: radius, y: anchorY},
    portraitB: portraitB ?? {x: WIDTH - radius, y: anchorY},
    vertical,
    portrait,
    knots,
    threads,
    directLabel,
    unitsPerPx,
    knotMax,
    compact: row / unitsPerPx < 40 || tight,
    hidden,
  };
}

// Every page connected to the selected one through the drawn links, in both directions.
function connectedTo(selected: number, threads: Thread[]) {
  const reached = new Set([selected]);
  for (const direction of [0, 1] as const) {
    const queue = [selected];
    while (queue.length) {
      const current = queue.shift()!;
      for (const thread of threads) {
        if (thread.tone === 'direct' || thread.ends[direction] !== current) continue;
        const next = thread.ends[1 - direction];
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
  }
  return reached;
}

function Portrait({
  article,
  image,
  side,
  size,
}: {
  article: Article;
  image?: string;
  side: 'a' | 'b';
  size: number;
}) {
  // Only the user's own camera crop; never a stock Wikipedia picture.
  const src = image;
  return (
    <figure className={`ww-loom-object ww-loom-object--${side}`} style={{width: size}}>
      <div
        className={`ww-loom-portrait${src ? (image ? '' : ' ww-loom-portrait--wiki') : ' ww-loom-portrait--plain'}`}
        style={{width: size, height: size}}
      >
        {src && <img src={src} alt="" />}
      </div>
      <figcaption>{article.title}</figcaption>
    </figure>
  );
}

export function ConnectionLoom({
  connection,
  portraits,
  selectedKey,
  expanded = false,
  onSelect,
}: {
  connection: Connection;
  portraits?: {A?: string; B?: string};
  selectedKey?: string;
  expanded?: boolean;
  onSelect: (selection: LoomSelection, key: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({width: 960, height: 0});
  const width = size.width;
  const [hot, setHot] = useState<string | null>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: Math.max(280, Math.round(entry.contentRect.width)),
        height: Math.round(entry.contentRect.height),
      })
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The whole map always fits the available width: no sideways scrolling.
  const layoutWidth = width;
  const layout = useMemo(
    () => buildLayout(connection, layoutWidth, size.height, expanded),
    [connection, layoutWidth, size.height, expanded]
  );
  const lit = layout.knots.find((knot) => knot.key === (hot ?? selectedKey));
  const reached = useMemo(
    () => (lit ? connectedTo(lit.article.id, layout.threads) : null),
    [lit, layout]
  );
  // A line lights up when both of its ends are connected to the selected knot. The direct link is a
  // fact about the pair, so it never dims.
  const threadClass = (thread: Thread) =>
    `ww-thread ww-thread--${thread.tone}${
      reached && thread.tone !== 'direct'
        ? reached.has(thread.ends[0]) && reached.has(thread.ends[1])
          ? ' is-lit'
          : ' is-dim'
        : ''
    }`;
  const stroke = layout.unitsPerPx;
  const a = connection.source.title;
  const b = connection.target.title;
  const percent = (point: Point) => ({
    left: `${(point.x / WIDTH) * 100}%`,
    top: `${(point.y / layout.height) * 100}%`,
  });
  const total = connection.path?.totalPaths;

  return (
    <div
      className={`ww-loom${layout.compact ? ' ww-loom--compact' : ''}${layout.vertical ? ' ww-loom--vertical' : ''}${selectedKey ? '' : ' ww-loom--inviting'}`}
      ref={frame}
    >
      <div className="ww-loom-scroll">
        <div className="ww-loom-frame" style={{aspectRatio: `${WIDTH} / ${layout.height}`}}>
          <svg
            className="ww-loom-threads"
            viewBox={`0 0 ${WIDTH} ${layout.height}`}
            aria-hidden="true"
            focusable="false"
          >
            {layout.threads.map((thread) => (
              <path
                key={thread.key}
                d={thread.d}
                pathLength={1}
                className={threadClass(thread)}
                strokeWidth={(thread.tone === 'direct' ? 2.6 : 1.8) * stroke}
                style={{animationDelay: `${thread.delay}ms`}}
              />
            ))}
          </svg>

          <div className="ww-loom-anchor ww-loom-anchor--a" style={percent(layout.portraitA)}>
            <Portrait
              article={connection.source}
              image={portraits?.A}
              side="a"
              size={layout.portrait}
            />
          </div>
          <div className="ww-loom-anchor ww-loom-anchor--b" style={percent(layout.portraitB)}>
            <Portrait
              article={connection.target}
              image={portraits?.B}
              side="b"
              size={layout.portrait}
            />
          </div>

          {layout.directLabel && (
            <p className="ww-loom-direct" style={percent(layout.directLabel)}>
              {a} links directly to {b}
            </p>
          )}

          <div
            className="ww-loom-knots"
            role="group"
            aria-label={`Connections between ${a} and ${b}`}
          >
            {layout.knots.map((knot) => {
              const description =
                knot.kind === 'shared'
                  ? `${knot.article.title}: both ${a} and ${b} link here`
                  : `${knot.article.title}: step ${knot.step} of ${connection.path?.hops}${
                      total
                        ? `, on ${knot.through?.toLocaleString()} of ${total.toLocaleString()} connecting paths`
                        : ''
                    }`;
              return (
                <button
                  key={knot.key}
                  type="button"
                  className={`ww-knot ww-knot--${knot.kind}`}
                  style={{
                    ...percent(knot.at),
                    maxWidth: layout.knotMax,
                    animationDelay: `${knot.delay}ms`,
                  }}
                  aria-pressed={selectedKey === knot.key}
                  aria-label={description}
                  title={knot.article.title}
                  onClick={() =>
                    onSelect(
                      {
                        kind: knot.kind,
                        article: knot.article,
                        step: knot.step,
                        through: knot.through,
                      },
                      knot.key
                    )
                  }
                  onMouseEnter={() => setHot(knot.key)}
                  onMouseLeave={() => setHot(null)}
                  onFocus={() => setHot(knot.key)}
                  onBlur={() => setHot(null)}
                >
                  <span>{knot.article.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
