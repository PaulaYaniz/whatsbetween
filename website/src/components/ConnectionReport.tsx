import React, {useState} from 'react';

import type {ConnectResponse, WikiArticle} from '../vision/wiki';

export interface SpecimenThumb {
  readonly label: string;
  readonly thumb?: string;
}

type View =
  {readonly kind: 'path'; readonly index: number} | {readonly kind: 'shared'; readonly id: number};

const fallbackPage = (id: number, result: ConnectResponse): WikiArticle =>
  result.pages[String(id)] ?? {
    id,
    title: `Page ${id}`,
    url: `https://en.wikipedia.org/?curid=${id}`,
  };

function methodNote(result: ConnectResponse) {
  const count = result.pathCount ?? result.paths.length;
  const plural = count === 1 ? '' : 's';
  switch (result.method) {
    case 'direct':
      return 'The source article links directly to the target. This is the shortest possible path.';
    case 'two_hop_exhaustive':
      return `All ${count} two-step path${plural} were found. Every outgoing link of the source was checked, so no shorter or missing two-step path exists.`;
    case 'two_hop_partial':
      return `${count} two-step path${plural} found. Some link lists were truncated by the request budget, so other paths may exist.`;
    case 'three_hop_bounded':
      if (result.status !== 'found')
        return `No path of up to three steps was found within this search limit (${result.stats.requests} requests). This does not prove that no path exists; longer paths were not searched.`;
      return result.shortest
        ? `No path of two steps or fewer exists, so these three-step paths are shortest. They were found among the ${result.hubsChecked ?? 0} most prominent articles linking to the target; other three-step paths likely exist.`
        : `Three-step paths found by a bounded search. Shorter paths were not fully ruled out because some link lists were truncated.`;
    default:
      return '';
  }
}

const Arrow: React.FC<{readonly reverse?: boolean}> = ({reverse}) => (
  <svg className="ww-arrow" viewBox="0 0 48 16" aria-hidden="true" focusable="false">
    <line x1={reverse ? 10 : 2} y1="8" x2={reverse ? 46 : 38} y2="8" />
    <polyline points={reverse ? '12,2 4,8 12,14' : '36,2 44,8 36,14'} />
  </svg>
);

const Node: React.FC<{
  readonly page: WikiArticle;
  readonly role: string;
  readonly tone: 'a' | 'b' | 'mid';
  readonly specimen?: SpecimenThumb;
  readonly index: number;
}> = ({page, role, tone, specimen, index}) => {
  const image = specimen?.thumb ?? page.thumbnailUrl;
  return (
    <a
      className={`ww-node ww-node-${tone}`}
      href={page.url}
      target="_blank"
      rel="noreferrer"
      style={{'--i': index} as React.CSSProperties}
    >
      <span className="ww-node-role">{role}</span>
      <span className="ww-node-media">
        {image ? (
          <img src={image} alt="" />
        ) : (
          <span className="ww-node-initial" aria-hidden="true">
            {page.title.slice(0, 1)}
          </span>
        )}
      </span>
      <span className="ww-node-title">{page.title}</span>
      {specimen && specimen.label.toLowerCase() !== page.title.toLowerCase() && (
        <span className="ww-node-observed">Observed as “{specimen.label}”</span>
      )}
      {page.description && <span className="ww-node-desc">{page.description}</span>}
      <span className="ww-visually-hidden"> (opens Wikipedia in a new tab)</span>
    </a>
  );
};

export const ConnectionReport: React.FC<{
  readonly result: ConnectResponse;
  readonly specimens: readonly [SpecimenThumb, SpecimenThumb];
  readonly onReverse: () => void;
  readonly onRescan: () => void;
}> = ({result, specimens, onReverse, onRescan}) => {
  const [view, setView] = useState<View>(() =>
    result.paths.length || !result.sharedTopics.length
      ? {kind: 'path', index: 0}
      : {kind: 'shared', id: result.sharedTopics[0]}
  );
  const [showAllPaths, setShowAllPaths] = useState(false);
  const [showAllShared, setShowAllShared] = useState(false);
  const page = (id: number) => fallbackPage(id, result);
  const a = result.source;
  const b = result.target;
  const generic = new Set(result.genericTopics ?? []);
  const retrieved = new Date(result.retrievedAt).toLocaleTimeString();

  const pathNodes = (path: readonly number[]) =>
    path.map((id, index) => {
      const last = index === path.length - 1;
      return (
        <li key={`${id}-${index}`} className="ww-chain-item">
          {index > 0 && (
            <span className="ww-edge">
              <Arrow />
              <span className="ww-visually-hidden">links to</span>
            </span>
          )}
          <Node
            page={page(id)}
            index={index}
            tone={index === 0 ? 'a' : last ? 'b' : 'mid'}
            role={index === 0 ? 'A · Source' : last ? 'B · Target' : `Step ${index}`}
            specimen={index === 0 ? specimens[0] : last ? specimens[1] : undefined}
          />
        </li>
      );
    });

  let figure: React.ReactNode;
  let figureLabel: string;
  if (result.status === 'same_article') {
    figureLabel = 'Same article';
    figure = (
      <p className="ww-empty">
        Both objects resolve to the same article, <strong>{a.title}</strong>. Choose a different
        article for one specimen to trace a connection.
      </p>
    );
  } else if (view.kind === 'shared') {
    figureLabel = 'Shared topic: A → X ← B (not a directed path)';
    figure = (
      <ol
        className="ww-chain"
        aria-label={`${a.title} and ${b.title} both link to ${page(view.id).title}`}
      >
        <li className="ww-chain-item">
          <Node page={page(a.id)} index={0} tone="a" role="A · Source" specimen={specimens[0]} />
        </li>
        <li className="ww-chain-item">
          <span className="ww-edge">
            <Arrow />
            <span className="ww-visually-hidden">links to</span>
          </span>
          <Node page={page(view.id)} index={1} tone="mid" role="Shared topic" />
        </li>
        <li className="ww-chain-item">
          <span className="ww-edge">
            <Arrow reverse />
            <span className="ww-visually-hidden">is also linked from</span>
          </span>
          <Node page={page(b.id)} index={2} tone="b" role="B · Target" specimen={specimens[1]} />
        </li>
      </ol>
    );
  } else if (result.paths.length) {
    const path = result.paths[Math.min(view.index, result.paths.length - 1)];
    figureLabel = `Directed hyperlink path ${view.index + 1} of ${result.paths.length}`;
    figure = (
      <ol
        className="ww-chain"
        key={view.index}
        aria-label={path.map((id) => page(id).title).join(' links to ')}
      >
        {pathNodes(path)}
      </ol>
    );
  } else {
    figureLabel = 'No directed path within the search limit';
    figure = (
      <p className="ww-empty">
        No hyperlink path from <strong>{a.title}</strong> to <strong>{b.title}</strong> was found
        within this search limit.{' '}
        {result.sharedTopics.length
          ? 'Their shared topics are listed below.'
          : 'Try reversing the direction, or choose a broader article.'}
      </p>
    );
  }

  const badge =
    result.status === 'found'
      ? result.shortest
        ? 'Shortest path · verified'
        : 'Verified path · bounded search'
      : result.status === 'same_article'
        ? 'Same article'
        : 'Not found within limit';
  const paths = showAllPaths ? result.paths : result.paths.slice(0, 8);
  const shared = showAllShared ? result.sharedTopics : result.sharedTopics.slice(0, 18);

  return (
    <section className="ww-report" aria-labelledby="ww-report-heading">
      <header className="ww-report-head">
        <div>
          <p className="ww-kicker">Result</p>
          <h2 id="ww-report-heading" className="ww-report-title">
            <span className="ww-tag ww-tag-a">A</span> {a.title}
            <span className="ww-report-to" aria-label="to">
              {' '}
              →{' '}
            </span>
            <span className="ww-tag ww-tag-b">B</span> {b.title}
          </h2>
        </div>
        <span className={`ww-badge ww-badge-${result.status}`}>{badge}</span>
      </header>

      <figure className="ww-figure">
        <figcaption className="ww-figcaption">
          <span className="ww-fig-num">Fig. 2</span> {figureLabel}
        </figcaption>
        <div className="ww-figure-body">{figure}</div>
        <p className="ww-caption-note">
          {view.kind === 'shared'
            ? 'Both articles link to this topic. Arrows show link direction; this is a shared reference, not a route from A to B.'
            : 'Each arrow is a hyperlink verified on live English Wikipedia. Links through redirects count, as they would when clicking.'}{' '}
          Retrieved {retrieved}.
        </p>
      </figure>

      <div className="ww-report-grid">
        <section aria-labelledby="ww-metrics">
          <h3 id="ww-metrics" className="ww-table-title">
            <span className="ww-fig-num">Table 2</span> Search summary
          </h3>
          <dl className="ww-metrics">
            <div>
              <dt>Degrees of separation</dt>
              <dd>{result.degrees ?? '—'}</dd>
            </div>
            <div>
              <dt>Directed paths found</dt>
              <dd>{result.pathCount ?? result.paths.length}</dd>
            </div>
            <div>
              <dt>Shared topics</dt>
              <dd>
                {result.sharedTopics.length - generic.size}
                {generic.size > 0 && <small> +{generic.size} citation</small>}
              </dd>
            </div>
            <div>
              <dt>Links from A</dt>
              <dd>
                {result.linkCounts?.sourceOutgoing ?? '—'}
                {result.linkCounts && !result.linkCounts.sourceOutgoingComplete && (
                  <small> partial</small>
                )}
              </dd>
            </div>
            <div>
              <dt>API requests</dt>
              <dd>
                {result.stats.requests}
                {result.stats.cachedResponses > 0 && (
                  <small> +{result.stats.cachedResponses} cached</small>
                )}
              </dd>
            </div>
            <div>
              <dt>Search time</dt>
              <dd>{(result.stats.elapsedMs / 1000).toFixed(1)} s</dd>
            </div>
          </dl>
          <p className="ww-method">
            <strong>Method.</strong> {methodNote(result)}
          </p>
        </section>

        {result.paths.length > 0 && (
          <section aria-labelledby="ww-paths">
            <h3 id="ww-paths" className="ww-table-title">
              <span className="ww-fig-num">Table 3</span> Directed paths
            </h3>
            <ol className="ww-path-list">
              {paths.map((path, index) => {
                const current = view.kind === 'path' && view.index === index;
                return (
                  <li key={path.join('-')}>
                    <button
                      type="button"
                      className="ww-path-row"
                      aria-current={current ? 'true' : undefined}
                      onClick={() => setView({kind: 'path', index})}
                    >
                      <span className="ww-path-num">{String(index + 1).padStart(2, '0')}</span>
                      <span className="ww-path-text">
                        {path.map((id, i) => (
                          <React.Fragment key={`${id}-${i}`}>
                            {i > 0 && <span className="ww-path-sep"> → </span>}
                            <span className={i === 0 || i === path.length - 1 ? 'ww-path-end' : ''}>
                              {page(id).title}
                            </span>
                          </React.Fragment>
                        ))}
                      </span>
                      {current && <span className="ww-path-current">Shown</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
            {result.paths.length > 8 && (
              <button
                type="button"
                className="ww-link-button"
                onClick={() => setShowAllPaths((value) => !value)}
              >
                {showAllPaths ? 'Show fewer' : `Show all ${result.paths.length}`}
              </button>
            )}
          </section>
        )}

        <section aria-labelledby="ww-shared">
          <h3 id="ww-shared" className="ww-table-title">
            <span className="ww-fig-num">Table 4</span> Shared topics (A → X ← B)
          </h3>
          {result.sharedTopics.length ? (
            <>
              <ul className="ww-topics">
                {shared.map((id) => {
                  const topic = page(id);
                  const current = view.kind === 'shared' && view.id === id;
                  return (
                    <li key={id} className={generic.has(id) ? 'ww-topic-generic' : undefined}>
                      <button
                        type="button"
                        aria-pressed={current}
                        onClick={() => setView({kind: 'shared', id})}
                      >
                        {topic.title}
                        {generic.has(id) && <span className="ww-topic-flag">citation</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {result.sharedTopics.length > 18 && (
                <button
                  type="button"
                  className="ww-link-button"
                  onClick={() => setShowAllShared((value) => !value)}
                >
                  {showAllShared ? 'Show fewer' : `Show all ${result.sharedTopics.length}`}
                </button>
              )}
              <p className="ww-method">
                {result.sharedComplete
                  ? 'Complete: both outgoing link lists were fully retrieved.'
                  : 'Partial: a link list was truncated, so some shared topics may be missing.'}{' '}
                Citation-only links (identifiers, publishers) are listed last.
              </p>
            </>
          ) : (
            <p className="ww-method">
              {result.sharedComplete === false
                ? 'None found in the retrieved (partial) link lists.'
                : 'The two articles link to no common article.'}
            </p>
          )}
        </section>
      </div>

      <div className="ww-report-actions">
        <button type="button" className="ww-button" onClick={onReverse}>
          Reverse direction (B → A)
        </button>
        <button type="button" className="ww-button" onClick={onRescan}>
          Scan again
        </button>
        <span className="ww-attribution">
          Data: English Wikipedia via the MediaWiki Action API, CC BY-SA 4.0.
        </span>
      </div>
    </section>
  );
};
