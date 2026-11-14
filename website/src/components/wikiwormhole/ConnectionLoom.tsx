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
  portrait: number;
  knots: Knot[];
  threads: Thread[];
  directLabel?: Point;
  unitsPerPx: number;
  // Widest a knot label may be, as a share of the loom width.
  knotMax: string;
}

const WIDTH = 1000;

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

function buildLayout(connection: Connection, width: number): Layout {
  const unitsPerPx = WIDTH / width;
  const narrow = width < 640;
  const portrait = narrow ? 56 : 88;
  const ax = (portrait + 6) * unitsPerPx;
  const bx = WIDTH - ax;
  const mid = WIDTH / 2;
  const row = (narrow ? 54 : 48) * unitsPerPx;
  const pad = 30 * unitsPerPx;
  const minHeight = (portrait + 90) * unitsPerPx;
  const path = connection.path;
  const shared = connection.sharedTopics;
  const direct = Boolean(path?.found && path.hops === 1);
  const sourceId = connection.source.id;
  const targetId = connection.target.id;
  const knots: Knot[] = [];
  const threads: Thread[] = [];
  let height = minHeight;
  let anchorY = minHeight / 2;
  let directLabel: Point | undefined;
  let knotMax = '36%';

  if (shared.length) {
    const topBand = direct ? 64 * unitsPerPx : 0;
    const top = pad + topBand;
    height = Math.max(minHeight + topBand, top + row * shared.length + pad);
    anchorY = top + (row * shared.length) / 2;
    shared.forEach((article, index) => {
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
  } else if (path?.found && (path.hops ?? 0) >= 2) {
    const hops = path.hops ?? 2;
    const {steps, links} = pathSteps(path);
    knotMax = `${Math.max(14, Math.round(80 / hops))}%`;
    const tallest = Math.max(1, ...steps.map((column) => column.length));
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

  return {height, anchorY, portrait, knots, threads, directLabel, unitsPerPx, knotMax};
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
  const src = image || article.thumbnailUrl;
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
  onSelect,
}: {
  connection: Connection;
  portraits?: {A?: string; B?: string};
  selectedKey?: string;
  onSelect: (selection: LoomSelection, key: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [hot, setHot] = useState<string | null>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(280, Math.round(entry.contentRect.width)))
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Path maps need room for their columns: on narrow screens they keep a minimum width and scroll
  // sideways instead of squeezing labels together.
  const pathMode =
    !connection.sharedTopics.length &&
    Boolean(connection.path?.found && (connection.path.hops ?? 0) >= 2);
  const minimum = pathMode ? 640 + Math.max(0, (connection.path?.hops ?? 2) - 3) * 180 : 0;
  const layoutWidth = Math.max(width, minimum);
  const scrolls = layoutWidth > width;
  const layout = useMemo(() => buildLayout(connection, layoutWidth), [connection, layoutWidth]);
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
    <div className="ww-loom" ref={frame}>
      <div
        className="ww-loom-scroll"
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? 'region' : undefined}
        aria-label={scrolls ? 'Connection map, scroll sideways to see all of it' : undefined}
      >
        <div
          className="ww-loom-frame"
          style={{
            aspectRatio: `${WIDTH} / ${layout.height}`,
            width: scrolls ? layoutWidth : undefined,
          }}
        >
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

          <div
            className="ww-loom-anchor ww-loom-anchor--a"
            style={{top: `${(layout.anchorY / layout.height) * 100}%`}}
          >
            <Portrait
              article={connection.source}
              image={portraits?.A}
              side="a"
              size={layout.portrait}
            />
          </div>
          <div
            className="ww-loom-anchor ww-loom-anchor--b"
            style={{top: `${(layout.anchorY / layout.height) * 100}%`}}
          >
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
                        ? `, on ${knot.through?.toLocaleString()} of ${total.toLocaleString()} shortest paths`
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
      {scrolls && <p className="ww-loom-swipe">Swipe sideways to see the whole map.</p>}
    </div>
  );
}
