import {useEffect, useRef, useState} from 'react';
import {Link, useLocation, useNavigate, useParams} from 'react-router-dom';

import {
  api,
  ApiError,
  connect,
  type Article,
  type Card,
  type Connection,
  type Finding,
  type PathInfo,
} from './api';
import {busiestRoute, ConnectionLoom, pathSteps, type LoomSelection} from './ConnectionLoom';
import {ResearchPanel} from './ResearchPanel';
import {Shell} from './Shell';

import './wikiwormhole.css';
import './discoveryWorkspace.css';

interface State {
  connection: Connection;
  resultToken: string;
  // Small crops of the scanned objects, passed from the scan page when available.
  portraits?: {A?: string; B?: string};
  investigationId?: string;
  saved?: boolean;
}

interface Selected extends LoomSelection {
  key: string;
}

const REASONS: Record<string, string> = {
  graph_not_configured: 'The link graph is not connected, so routes cannot be searched right now.',
  graph_unreachable: 'The link graph is offline, so routes cannot be searched right now.',
  graph_unavailable: 'The link graph is still being prepared.',
  no_path_within_limit: 'No route of six steps or fewer exists in the link graph.',
};

const number = (value: number) => value.toLocaleString();

function summary(connection: Connection) {
  const a = connection.source.title;
  const b = connection.target.title;
  const shared = connection.linkCounts?.shared ?? connection.sharedTopics.length;
  const hops = connection.path?.found ? connection.path.hops : undefined;
  if (connection.status === 'same_article')
    return 'Both picks point to the same article. Scan two different objects.';
  if (hops === 1 && shared)
    return `${a} links straight to ${b}, and they share ${number(shared)} linked articles.`;
  if (hops === 1) return `${a} links straight to ${b}.`;
  if (shared)
    return `${a} and ${b} don't link to each other, but they share ${number(shared)} linked articles.`;
  if (hops)
    return `${a} and ${b} share no linked articles. The shortest way across takes ${hops} steps.`;
  return REASONS[connection.path?.reason ?? ''] ?? `No connection between ${a} and ${b} was found.`;
}

function defaultSelection(connection: Connection): Selected | null {
  const topic = connection.sharedTopics[0];
  if (topic) return {kind: 'shared', article: topic, key: `shared-${topic.id}`};
  // Otherwise start on the busiest first stop.
  const first = pathSteps(connection.path).steps[0]?.[0];
  if (first)
    return {kind: 'stop', article: first, step: 1, through: first.through, key: `stop-${first.id}`};
  return null;
}

function routeQuestion(route: Article[]) {
  return `Explain how ${route[0].title} connects to ${route[route.length - 1].title} through this Wikipedia link path: ${route.map((node) => node.title).join(' → ')}. For each step, explain what the link means using sources.`;
}

export function DiscoverPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<Selected | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [explanationBusy, setExplanationBusy] = useState(false);
  const [explanationError, setExplanationError] = useState('');
  const [retry, setRetry] = useState(0);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [question, setQuestion] = useState('How are these two things related?');
  const [researchDraft, setResearchDraft] = useState<{text: string} | null>(null);
  const [finding, setFinding] = useState<Finding | null>(null);
  const [perStep, setPerStep] = useState(6);
  const [stopsBusy, setStopsBusy] = useState(false);

  // Load the result for this URL: use the state handed over by the previous page when it matches,
  // otherwise fetch it again so a refresh or a shared link still works.
  useEffect(() => {
    const incoming = location.state as State | null;
    const sourceId = Number(params.sourceId);
    const targetId = Number(params.targetId);
    const matches =
      incoming?.connection &&
      (!sourceId ||
        (incoming.connection.source.id === sourceId && incoming.connection.target.id === targetId));
    const show = (value: State) => {
      setState(value);
      token.current = value.resultToken;
      renewed.current = false;
      setPerStep(6);
      setSelected(defaultSelection(value.connection));
      setCard(null);
      setFinding(null);
      setNotice('');
      setLoadError('');
      setEvidenceOpen(false);
    };
    if (matches && incoming) return show(incoming);
    if (sourceId > 0 && targetId > 0) {
      let cancelled = false;
      setState(null);
      setLoadError('');
      connect({id: sourceId} as Article, {id: targetId} as Article)
        .then((result) => {
          if (!cancelled) show({connection: result.connection, resultToken: result.resultToken});
        })
        .catch((error) => {
          if (!cancelled)
            setLoadError(
              error instanceof Error ? error.message : 'This connection could not be loaded.'
            );
        });
      return () => {
        cancelled = true;
      };
    }
    navigate('/', {replace: true});
  }, [location.key, params.sourceId, params.targetId]);

  // Explanation card for the selected shared topic.
  const sharedId = selected?.kind === 'shared' ? String(selected.article.id) : '';
  useEffect(() => {
    if (!state || !sharedId) return;
    let cancelled = false;
    setCard(null);
    setEvidenceOpen(false);
    setExplanationBusy(true);
    setExplanationError('');
    void api<{status: string; card?: Card; reason?: string}>('/discover', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({resultToken: token.current, candidateId: sharedId}),
    })
      .then((response) => {
        if (cancelled) return;
        if (response.card) setCard(response.card);
        else
          setExplanationError(
            response.reason === 'gemini_not_configured'
              ? 'Explanations are not set up on this server.'
              : 'Both articles link here, but their current text does not say enough to explain why.'
          );
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'result_expired' && !renewed.current) {
          // The result token aged out or the session changed: get a new one; this effect then
          // runs again with it.
          renewed.current = true;
          void renewToken().catch(() =>
            setExplanationError('This result could not be refreshed. Reload the page.')
          );
          return;
        }
        const message = error instanceof Error ? error.message : '';
        setExplanationError(
          /timeout|aborted/i.test(message)
            ? 'The explanation is taking longer than usual. Try again in a moment.'
            : message || 'The explanation could not be loaded.'
        );
      })
      .finally(() => {
        if (!cancelled) setExplanationBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state?.resultToken, sharedId, retry]);

  // Result tokens expire after an hour and belong to one browser session. When one is rejected,
  // fetch the same connection again for a fresh token, keeping the map exactly as it is.
  const renewing = useRef<Promise<string> | null>(null);
  const renewed = useRef(false);
  // The newest token, so calls made right after a renewal never send the old one.
  const token = useRef('');
  function renewToken(): Promise<string> {
    if (!state) return Promise.reject(new Error('Nothing to refresh.'));
    if (!renewing.current) {
      const {source, target} = state.connection;
      renewing.current = connect(source, target)
        .then((next) => {
          token.current = next.resultToken;
          setState((value) => (value ? {...value, resultToken: next.resultToken} : value));
          return next.resultToken;
        })
        .finally(() => {
          renewing.current = null;
        });
    }
    return renewing.current;
  }
  async function withFreshToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    try {
      return await call(token.current);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'result_expired') throw error;
      return call(await renewToken());
    }
  }

  async function persistFinding(result: Finding) {
    if (!state?.investigationId) return;
    const status =
      result.status === 'supported'
        ? 'Supported finding'
        : result.status === 'hypothesis'
          ? 'Hypothesis'
          : 'Insufficient evidence';
    try {
      await api('/investigations/finding', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          resultToken: token.current,
          investigationId: state.investigationId,
          finding: {
            status,
            finding: result.finding,
            claims: result.claims,
            uncertainty: result.uncertainty,
            followUp: result.followUp,
          },
        }),
      });
    } catch (error) {
      setNotice(
        `The answer is here, but it could not be saved: ${error instanceof Error ? error.message : 'saving is unavailable.'}`
      );
    }
  }

  async function save() {
    if (!state) return;
    setBusy(true);
    setNotice('Saving…');
    try {
      const response = await withFreshToken((token) =>
        api<{investigation: {id: string}}>('/investigations', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({resultToken: token, candidateId: sharedId, question}),
        })
      );
      setState({...state, investigationId: response.investigation.id, saved: true});
      if (card) {
        await api('/investigations/finding', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            resultToken: token.current,
            investigationId: response.investigation.id,
            finding: {
              status: 'Supported finding',
              finding: card.headline,
              claims: [card.explanationSource, card.explanationTarget, card.whyInteresting].map(
                (claim) => ({claim, evidenceIds: card.evidenceIds})
              ),
              uncertainty:
                'This summarizes the passages shown; a shared link does not mean one causes the other.',
              followUp: 'Ask a more specific question.',
            },
          }),
        });
      }
      if (finding) await persistFinding(finding);
      setNotice('Saved. Find it under Saved investigations.');
    } catch (error) {
      setNotice(
        `${error instanceof Error ? error.message : 'Saving is unavailable.'} The result is still here, so you can try again.`
      );
    } finally {
      setBusy(false);
    }
  }

  // Show more or fewer of the busiest stops. Only the map changes; the result token stays the same.
  async function loadStops(count: number) {
    if (!state) return;
    const {source, target, path: current} = state.connection;
    setStopsBusy(true);
    try {
      const response = await api<{path: PathInfo}>(
        `/path?source=${source.id}&target=${target.id}&perStep=${Math.min(40, count)}`
      );
      // Keep descriptions already loaded for stops that stay on the map.
      const known = new Map((current?.steps ?? []).flat().map((stop) => [stop.id, stop]));
      const steps = response.path.steps?.map((column) =>
        column.map((stop) => ({...known.get(stop.id), ...stop}))
      );
      setState({...state, connection: {...state.connection, path: {...response.path, steps}}});
      setPerStep(Math.min(40, count));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'More stops could not be loaded.');
    } finally {
      setStopsBusy(false);
    }
  }

  function ask(text: string) {
    setQuestion(text);
    setResearchDraft({text});
  }

  if (!state) {
    return (
      <Shell active="scan">
        <main className="ww-main ww-discover">
          {loadError ? (
            <div className="ww-discover-empty" role="alert">
              <h1>This connection could not be loaded</h1>
              <p>{loadError}</p>
              <Link className="ww-button ww-button--coral" to="/">
                Scan two objects
              </Link>
            </div>
          ) : (
            <p className="ww-discover-loading" role="status">
              Finding what's between them…
            </p>
          )}
        </main>
      </Shell>
    );
  }

  const connection = state.connection;
  const a = connection.source.title;
  const b = connection.target.title;
  const counts = connection.linkCounts;
  const shownShared = connection.sharedTopics.length;
  const snapshot = connection.path?.snapshot ?? connection.graphSnapshot;
  const snapshotLabel = snapshot
    ? new Date(`${snapshot}T00:00:00Z`).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';
  const route =
    selected?.kind === 'stop' ? busiestRoute(connection, selected.article.id) : undefined;
  const totalPaths = connection.path?.totalPaths ?? 0;
  const shownPaths = connection.path?.shownPaths ?? 0;
  const pathMode =
    !shownShared && Boolean(connection.path?.found && (connection.path.hops ?? 0) >= 2);

  return (
    <Shell active="scan">
      <main className="ww-main ww-discover">
        <div className="ww-discover-bar">
          <Link to="/" className="ww-back">
            Scan two new objects
          </Link>
          <button className="ww-text-button" onClick={save} disabled={busy || state.saved}>
            {state.saved ? 'Saved' : 'Save this connection'}
          </button>
        </div>

        <header className="ww-discover-title">
          <h1>
            What's between {a} and {b}?
          </h1>
          <p>{summary(connection)}</p>
        </header>

        <section className="ww-loom-stage" aria-label="Connection map">
          <ConnectionLoom
            key={connection.id}
            connection={connection}
            portraits={state.portraits}
            selectedKey={selected?.key}
            onSelect={(selection, key) => {
              setSelected({...selection, key});
              setNotice('');
            }}
          />
          <ul className="ww-loom-legend">
            <li>
              <span className="ww-swatch ww-swatch--a" aria-hidden="true" />
              Links from {a}
            </li>
            <li>
              <span className="ww-swatch ww-swatch--b" aria-hidden="true" />
              Links from {b}
            </li>
            <li>
              <span
                className={`ww-swatch ${shownShared ? 'ww-swatch--knot' : 'ww-swatch--stop'}`}
                aria-hidden="true"
              />
              {shownShared ? 'Articles both of them link to' : 'Stops on the shortest routes'}
            </li>
          </ul>
          {(pathMode || Boolean(counts?.shared)) && (
            <div className="ww-loom-caption">
              <p>
                {pathMode
                  ? `There are ${number(totalPaths)} shortest paths, each ${connection.path?.hops} steps long. The stops shown cover ${number(shownPaths)} of them.`
                  : counts && counts.shared > shownShared
                    ? `Showing ${shownShared} of the ${number(counts.shared)} articles they share: the most specific ones. Articles that almost everything links to, like ISBN, are left out.`
                    : `Showing all ${shownShared} articles they share.`}
              </p>
              {pathMode && (
                <div className="ww-loom-more">
                  {shownPaths < totalPaths && perStep < 40 && (
                    <button
                      className="ww-text-button"
                      disabled={stopsBusy}
                      onClick={() => void loadStops(perStep * 2)}
                    >
                      Show more stops
                    </button>
                  )}
                  {perStep > 6 && (
                    <button
                      className="ww-text-button"
                      disabled={stopsBusy}
                      onClick={() => void loadStops(6)}
                    >
                      Show fewer stops
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {counts && (
            <p className="ww-loom-counts">
              {a} links to {number(counts.source)} articles and {b} to {number(counts.target)}.{' '}
              {snapshotLabel && `Links come from a ${snapshotLabel} snapshot of Wikipedia.`}
            </p>
          )}
        </section>

        <div className="ww-discover-columns">
          <section
            className={`ww-knot-detail ww-knot-detail--${selected?.kind ?? 'none'}`}
            aria-live="polite"
          >
            {!selected && (
              <p className="ww-knot-hint">
                {connection.status === 'same_article'
                  ? 'Go back and pick two different objects.'
                  : 'There is nothing in between to explore for this pair. Try scanning another object.'}
              </p>
            )}

            {selected?.kind === 'shared' && (
              <>
                <h2>{selected.article.title}</h2>
                {selected.article.description && (
                  <p className="ww-knot-description">{selected.article.description}</p>
                )}
                {explanationBusy && (
                  <p className="ww-knot-status" role="status">
                    Reading what the articles say…
                  </p>
                )}
                {explanationError && (
                  <div className="ww-knot-status" role="status">
                    <p>{explanationError}</p>
                    <button
                      className="ww-text-button"
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      Try the explanation again
                    </button>
                  </div>
                )}
                {card && card.candidateId === sharedId && (
                  <article className="ww-explanation">
                    <h3>{card.headline}</h3>
                    <dl>
                      <dt>{a}</dt>
                      <dd>{card.explanationSource}</dd>
                      <dt>{b}</dt>
                      <dd>{card.explanationTarget}</dd>
                    </dl>
                    <p className="ww-explanation-why">{card.whyInteresting}</p>
                    <button
                      className="ww-text-button"
                      onClick={() => setEvidenceOpen((value) => !value)}
                      aria-expanded={evidenceOpen}
                    >
                      {evidenceOpen
                        ? 'Hide the passages'
                        : `Show the ${card.evidence?.length ?? 0} passages this is based on`}
                    </button>
                    {evidenceOpen && (
                      <ol className="ww-evidence">
                        {card.evidence?.map((source) => (
                          <li key={source.id}>
                            <a href={source.url} target="_blank" rel="noreferrer">
                              {source.sourceArticle}
                            </a>
                            <p>{source.excerpt}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </article>
                )}
                <div className="ww-knot-actions">
                  <button
                    className="ww-button ww-button--coral"
                    onClick={() => ask(`How does ${selected.article.title} connect ${a} and ${b}?`)}
                  >
                    Ask about {selected.article.title}
                  </button>
                </div>
              </>
            )}

            {selected?.kind === 'stop' && (
              <>
                <h2>{selected.article.title}</h2>
                {selected.article.description && (
                  <p className="ww-knot-description">{selected.article.description}</p>
                )}
                <p className="ww-knot-relation">
                  Step {selected.step} of {connection.path?.hops}.
                  {totalPaths && selected.through
                    ? ` ${number(selected.through)} of the ${number(totalPaths)} shortest paths pass through it.`
                    : ''}
                </p>
                {route && (
                  <p className="ww-knot-route">{route.map((node) => node.title).join(' → ')}</p>
                )}
                <div className="ww-knot-actions">
                  {route && (
                    <button
                      className="ww-button ww-button--coral"
                      onClick={() => ask(routeQuestion(route))}
                    >
                      Explain this route
                    </button>
                  )}
                  <a
                    className="ww-button ww-button--light"
                    href={selected.article.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Read {selected.article.title} on Wikipedia
                  </a>
                </div>
              </>
            )}
          </section>

          <ResearchPanel
            key={`${connection.source.id}-${connection.target.id}`}
            source={a}
            target={b}
            topic={selected?.article.title || 'their connection'}
            candidateId={selected?.kind === 'shared' ? sharedId : undefined}
            suggestedQuestions={
              card?.candidateId === sharedId ? card.suggestedQuestions : undefined
            }
            draft={researchDraft}
            resultToken={state.resultToken}
            renewToken={renewToken}
            investigationId={state.investigationId}
            onResult={(result, askedQuestion) => {
              setQuestion(askedQuestion);
              setFinding(result);
              if (result.saved?.id)
                setState((value) =>
                  value ? {...value, investigationId: result.saved?.id} : value
                );
              else void persistFinding(result);
            }}
          />
        </div>

        {notice && (
          <p className="ww-notice" role="status">
            {notice}
          </p>
        )}
      </main>
    </Shell>
  );
}
