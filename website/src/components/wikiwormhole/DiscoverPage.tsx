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
import {ConnectionLoom, type LoomSelection} from './ConnectionLoom';
import {ResearchPanel} from './ResearchPanel';
import {Brand, Shell} from './Shell';

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


// Why an explanation could not be written, in the reader's terms.
const EXPLANATION_UNAVAILABLE: Record<string, string> = {
  gemini_not_configured: 'Explanations are not set up on this server.',
  gemini_busy: 'The AI service is busy right now. Try again in a moment.',
  gemini_quota: 'The AI service has reached its limit for now. Try again later.',
  insufficient_source_passages:
    'The current article text does not say enough to explain this connection.',
  invalid_model_response:
    'The explanation did not match its sources, so it is not shown. Try again.',
  default: 'The explanation could not be written this time. Try again.',
};

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
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false);
        expandButton.current?.focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [expanded]);
  const [perStep, setPerStep] = useState(6);
  // On narrow screens one section shows at a time: the map, the explanation, or the questions.
  const [view, setView] = useState<'map' | 'explanation' | 'ask'>('map');
  // Reading view for Deep research answers: the research panel takes over the page.
  const [reading, setReading] = useState(false);
  const narrow = () => window.matchMedia('(max-width: 900px)').matches;
  // Phones draw path maps top to bottom with up to three stops per row.
  const basePerStep = () => (window.matchMedia('(max-width: 640px)').matches ? 3 : 6);
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
    const show = (incoming: State) => {
      // Camera crops only exist in the scan page's state; keep them for this tab so a refresh or
      // a renewed result still shows the user's own photos.
      const key = `wb-portraits:${incoming.connection.source.id}-${incoming.connection.target.id}`;
      let value = incoming;
      try {
        if (incoming.portraits?.A || incoming.portraits?.B)
          sessionStorage.setItem(key, JSON.stringify(incoming.portraits));
        else {
          const stored = sessionStorage.getItem(key);
          if (stored) value = {...incoming, portraits: JSON.parse(stored)};
        }
      } catch {
        // Storage can be full or blocked; the map still works without photos.
      }
      setState(value);
      setView('map');
      setReading(false);
      setExpanded(false);
      token.current = value.resultToken;
      renewed.current = false;
      setPerStep(6);
      setSelected(null);
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

  useEffect(() => {
    if (!state || state.connection.sharedTopics.length) return;
    const steps = state.connection.path?.steps ?? [];
    if (basePerStep() === 3 && perStep === 6 && steps.some((column) => column.length > 3))
      void loadStops(3);
  }, [state?.connection.id]);

  // Explanation card for the selected shared topic.
  const sharedId = selected ? String(selected.article.id) : '';
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
            EXPLANATION_UNAVAILABLE[response.reason ?? ''] ?? EXPLANATION_UNAVAILABLE.default
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

  async function save() {
    if (!state) return;
    setBusy(true);
    setNotice('Saving…');
    try {
      const response = await withFreshToken((token) =>
        api<{investigation: {id: string}}>('/investigations', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({resultToken: token, candidateId: sharedId, question, discoveryToken: card?.saveToken}),
        })
      );
      setState({...state, investigationId: response.investigation.id, saved: true});
      setNotice('Saved to your Research log.');
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
    if (narrow()) setView('ask');
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
  const shownShared = connection.sharedTopics.length;
  const pathMode =
    !shownShared && Boolean(connection.path?.found && (connection.path.hops ?? 0) >= 2);

  return (
    <Shell active="scan" header={false}>
      <main className={`ww-main ww-discover${expanded ? ' is-map-expanded' : ''}`}>
        <div className="ww-discover-bar">
          <Brand />
          <nav className="ww-discover-nav" aria-label="Main navigation">
            <Link to="/saved">Research log</Link>
            <Link to="/about">About</Link>
          </nav>
        </div>

        <div className="ww-discover-tabs" role="tablist" aria-label="Sections">
          {(
            [
              ['map', 'Map'],
              ['explanation', 'Explanation'],
              ['ask', 'Ask'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={view === key} onClick={() => setView(key)}>
              {label}
            </button>
          ))}
        </div>

        <div className={`ww-discover-body${reading ? ' is-reading' : ''}`} data-view={view}>
          <section className="ww-loom-stage" aria-label="Connection map">
            {!connection.path?.found || connection.status === 'same_article' ? (
              <div className="ww-map-unavailable" role="status">
                <h2>
                  {connection.status === 'same_article'
                    ? 'Two objects, one Wikipedia article'
                    : connection.path?.source !== 'graph'
                      ? 'Connection map temporarily unavailable'
                      : 'No route found within the search limit'}
                </h2>
                <p>
                  {connection.status === 'same_article'
                    ? `Both picks lead to ${a}. Deep research can help explore how they differ.`
                    : connection.path?.source !== 'graph'
                      ? 'The link-search service could not complete this request. Please reload to try again.'
                      : `The link search did not find a route between ${a} and ${b} within its search limit. This does not mean they are unrelated.`}
                </p>
              </div>
            ) : (
              <ConnectionLoom
                key={connection.id}
                connection={connection}
                expanded={expanded}
                portraits={state.portraits}
                selectedKey={selected?.key}
                onSelect={(selection, key) => {
                  setExpanded(false);
                  setSelected({...selection, key});
                  setNotice('');
                  if (narrow()) setView('explanation');
                }}
              />
            )}
          </section>

          <div className="ww-discover-side">
            {connection.path?.found && connection.status !== 'same_article' && (
              <div className="ww-loom-more ww-discover-map-actions">
                <button
                  ref={expandButton}
                  className="ww-button ww-button--light"
                  aria-expanded={expanded}
                  onClick={() => {
                    setExpanded(!expanded);
                    if (!expanded && pathMode && perStep < 12) void loadStops(12);
                  }}
                >
                  {expanded ? 'Collapse map' : 'Expand map'}
                </button>
                <button className="ww-button ww-button--dark" onClick={save} disabled={busy || state.saved}>
                  {state.saved ? 'Saved' : busy ? 'Saving…' : 'Save'}
                </button>
                {stopsBusy && <span role="status">Loading connections…</span>}
              </div>
            )}
            <section
              className={`ww-knot-detail ww-panel-scroll ww-knot-detail--${selected?.kind ?? 'none'}`}
              aria-live="polite"
            >
              {!selected && (
                <p className="ww-knot-prompt">
                  {connection.status === 'same_article'
                    ? `Both objects resolve to ${a} on Wikipedia. You can explore their differences with Deep research, or choose another object.`
                    : shownShared
                      ? `Select one of the articles in the middle of the map to see how it connects ${a} and ${b}.`
                      : pathMode
                        ? `Select any stop on the map to see its route from ${a} to ${b} and have it explained.`
                        : connection.path?.found
                          ? 'These articles link directly. Ask Deep research to explore their relationship.'
                          : 'No route was found in the available Wikipedia snapshot. You can still explore these objects with Deep research.'}
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
                      onClick={() =>
                        ask(`How does ${selected.article.title} connect ${a} and ${b}?`)
                      }
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
                  {explanationBusy && <p role="status">Writing a short explanation…</p>}
                  {explanationError && (
                    <div role="status">
                      <p>{explanationError}</p>
                      <button className="ww-text-button" onClick={() => setRetry((value) => value + 1)}>
                        Try again
                      </button>
                    </div>
                  )}
                  {!explanationBusy && card?.candidateId === sharedId && (
                    <p className="ww-knot-description">
                      {card.explanationSource} {card.explanationTarget}
                    </p>
                  )}
                  <div className="ww-knot-actions">
                    <a
                      className="ww-button ww-button--light"
                      href={selected.article.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Read more
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
              selectedTitle={selected?.article.title}
              expanded={reading}
              onExpandedChange={(value) => {
                setReading(value);
                if (value && narrow()) setView('ask');
              }}
              candidateId={selected ? String(selected.article.id) : undefined}
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
                    value ? {...value, investigationId: result.saved?.id, saved: true} : value
                  );

              }}
            />
          </div>
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
