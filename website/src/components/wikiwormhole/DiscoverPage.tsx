import {useEffect, useState} from 'react';
import {Link, useLocation, useNavigate} from 'react-router-dom';

import {api, connect, type Card, type Connection, type Finding} from './api';
import {PathStrip} from './PathStrip';
import {ResearchPanel} from './ResearchPanel';
import {Shell} from './Shell';

import './wikiwormhole.css';
import './discoveryWorkspace.css';

interface State {
  connection: Connection;
  resultToken: string;
  card?: Card;
  investigationId?: string;
  saved?: boolean;
}
export function DiscoverPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const initial = location.state as State | null;
  const [state, setState] = useState<State | null>(initial);
  const [card, setCard] = useState<Card | null>(initial?.card || null);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [researchDraft, setResearchDraft] = useState<{text: string} | null>(null);
  const [question, setQuestion] = useState('How are these two things related?');
  const [finding, setFinding] = useState<Finding | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [view, setView] = useState<'routes' | 'topics'>('routes');
  const [explanationBusy, setExplanationBusy] = useState(false);
  const [explanationError, setExplanationError] = useState('');
  const [retry, setRetry] = useState(0);
  const [prior, setPrior] = useState<State | null>(null);
  useEffect(() => {
    if (!state) navigate('/', {replace: true});
  }, [state, navigate]);

  function selectTopic(topicId: string) {
    if (!state || busy || topicId === (selected || String(state.connection.sharedTopics[0]?.id)))
      return;
    setSelected(topicId);
    setCard(null);
    setNotice('');
  }
  async function exploreTopic() {
    if (!state) return;
    const exploreId = selected || String(state.connection.sharedTopics[0]?.id || '');
    const replacement = connection.sharedTopics.find((item) => String(item.id) === exploreId);
    const target = connection.source.id === replacement?.id ? connection.target : connection.source;
    if (!replacement) return;
    setBusy(true);
    setNotice('Checking the new pair…');
    try {
      const next = await connect(replacement, target);
      setPrior(state);
      const value: State = {connection: next.connection, resultToken: next.resultToken};
      setState(value);
      setCard(null);
      setSelected('');
      setFinding(null);
      setView('routes');
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not explore this topic.');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!state) return;
    setBusy(true);
    setNotice('Saving this investigation…');
    try {
      const response = await api<{investigation: {id: string}}>('/investigations', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          resultToken: state.resultToken,
          candidateId: selected || String(state.connection.sharedTopics[0]?.id || ''),
          question,
        }),
      });
      const updated = {...state, investigationId: response.investigation.id, saved: true};
      setState(updated);
      if (card) {
        const claims = [
          {claim: card.explanationSource, evidenceIds: card.evidenceIds},
          {claim: card.explanationTarget, evidenceIds: card.evidenceIds},
          {claim: card.whyInteresting, evidenceIds: card.evidenceIds},
        ];
        await api('/investigations/finding', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            resultToken: state.resultToken,
            investigationId: response.investigation.id,
            finding: {
              status: 'Supported finding',
              finding: card.headline,
              claims,
              uncertainty:
                'This card summarizes the passages shown; a shared link does not establish causation.',
              followUp: 'Dig deeper with a specific question.',
            },
          }),
        });
      }
      if (finding) await persistFinding(finding);
      setNotice('Investigation saved to this browser session.');
    } catch (error) {
      setNotice(
        `${error instanceof Error ? error.message : 'Atlas saving is unavailable.'} Your current result is still here; try saving again when Atlas is available.`
      );
    } finally {
      setBusy(false);
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
          resultToken: state.resultToken,
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
        `The research result is available, but this version could not be saved: ${error instanceof Error ? error.message : 'Atlas unavailable.'}`
      );
    }
  }
  useEffect(() => {
    if (!state || !state.connection.sharedTopics.length) return;
    const current = selected || String(state.connection.sharedTopics[0]?.id || '');
    let cancelled = false;
    setExplanationBusy(true);
    setExplanationError('');
    void api<{status: string; card?: Card; reason?: string; topic?: {title: string}}>('/discover', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({resultToken: state.resultToken, candidateId: current}),
    })
      .then((response) => {
        if (!cancelled && response.card) setCard(response.card);
        else if (!cancelled)
          setExplanationError(
            response.reason === 'gemini_not_configured'
              ? `Gemini is not configured. Shared topic: ${response.topic?.title || 'Wikipedia link'}.`
              : 'The link is shared, but current article passages do not support a stronger explanation.'
          );
      })
      .catch((error) => {
        if (!cancelled)
          setExplanationError(error instanceof Error ? error.message : 'Could not load an explanation.');
      })
      .finally(() => {
        if (!cancelled) setExplanationBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state?.resultToken, selected, retry]);
  if (!state) return null;
  const connection = state.connection;
  const current = selected || String(connection.sharedTopics[0]?.id || '');
  const topic = connection.sharedTopics.find((item) => String(item.id) === current);

  return (
    <Shell active="scan">
      <main className="ww-main ww-discover">
        <div className="ww-result-top">
          <div className="ww-back-group">
            {prior && (
              <button
                className="ww-back"
                onClick={() => {
                  setState(prior);
                  setPrior(null);
                  setCard(null);
                  setFinding(null);
                }}
              >
                ← Previous result
              </button>
            )}
            <Link to="/" state={{}} className="ww-back">
              ← Scan again
            </Link>
          </div>
          <button className="ww-text-button" onClick={save} disabled={busy || state.saved}>
            {state.saved ? '✓ Saved' : 'Save investigation'}
          </button>
        </div>
        <header className="ww-discovery-heading"><h1>{connection.source.title} <span>and</span> {connection.target.title}</h1><p>Follow the links. Find the unexpected.</p></header>
        <div className="ww-workspace">
        <section className="ww-exploration" aria-label="Connection explorer">
          <div className="ww-view-tabs" role="tablist" aria-label="Connection views" onKeyDown={(event) => {if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {event.preventDefault(); const next = event.key === 'Home' ? 'routes' : event.key === 'End' ? 'topics' : view === 'routes' ? 'topics' : 'routes'; setView(next); document.getElementById(next === 'routes' ? 'route-tab' : 'topic-tab')?.focus();}}}>
            <button role="tab" id="route-tab" tabIndex={view === 'routes' ? 0 : -1} aria-controls="route-view" aria-selected={view === 'routes'} onClick={() => setView('routes')}>Shortest routes</button>
            <button role="tab" id="topic-tab" tabIndex={view === 'topics' ? 0 : -1} aria-controls="topic-view" aria-selected={view === 'topics'} onClick={() => setView('topics')}>What they share <span>{connection.sharedTopics.length}</span></button>
          </div>
          <div id="route-view" role="tabpanel" aria-labelledby="route-tab" hidden={view !== 'routes'}>
          <PathStrip key={state.resultToken} path={connection.path} onExplain={(text) => {setQuestion(text); setResearchDraft({text});}} />
          </div>
          <div id="topic-view" role="tabpanel" aria-labelledby="topic-tab" hidden={view !== 'topics'}>
        {connection.status === 'partial' && (
          <div className="ww-callout">
            Wikipedia returned a partial link scan. These are the shared topics found so far.
          </div>
        )}
        {connection.status === 'same_article' && (
          <div className="ww-callout">Choose two different articles to find a shared topic.</div>
        )}
        {!connection.sharedTopics.length && connection.status !== 'same_article' && (
          <div className="ww-callout">
            No shared topic links these two articles.{' '}
            {connection.path?.found
              ? 'The shortest path between them is shown above.'
              : 'Try two different articles.'}
          </div>
        )}
        {topic && (
          <section className="ww-connection-card">
            <div className="ww-topic-browser">
              <div className="ww-topic-list" aria-label="Shared topics">
                {connection.sharedTopics.map(candidate => <button key={candidate.id} aria-pressed={String(candidate.id) === current} onClick={() => selectTopic(String(candidate.id))}>{candidate.title}</button>)}
              </div>
              <div className="ww-topic-detail">
              <div className="ww-shared-map" aria-label={`${connection.source.title} and ${connection.target.title} both link to ${topic.title}`}>
                <span>{connection.source.title}</span><span>{connection.target.title}</span>
                <svg viewBox="0 0 400 60" aria-hidden="true"><defs><marker id="shared-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs><path d="M 90 0 Q 90 35 185 53" fill="none" stroke="currentColor" strokeWidth="2" markerEnd="url(#shared-arrow)" /><path d="M 310 0 Q 310 35 215 53" fill="none" stroke="currentColor" strokeWidth="2" markerEnd="url(#shared-arrow)" /></svg>
                <h2>{topic.title}</h2>
              </div>
              <p className="ww-map-caption">Both articles link here. A shared topic is different from a directed route.</p>
              {explanationBusy && <p role="status">Reading the supporting passages…</p>}
              {explanationError && <div className="ww-inline-error" role="status"><p>{explanationError}</p><button className="ww-text-button" onClick={() => setRetry(value => value + 1)}>Retry explanation</button></div>}
            {card && (
              <article className="ww-card-copy">
                <h2>{card.headline}</h2>
                <p>{card.explanationSource}</p>
                <p>{card.explanationTarget}</p>
                <p className="ww-why">{card.whyInteresting}</p>
                <button
                  className="ww-evidence-toggle"
                  onClick={() => setEvidenceOpen((value) => !value)}
                  aria-expanded={evidenceOpen}
                >
                  {evidenceOpen ? 'Hide evidence' : 'Show evidence'}{' '}
                  <span>({card.evidence?.length || 0} sources)</span>
                </button>
                {evidenceOpen && (
                  <div className="ww-evidence-list">
                    {card.evidence?.map((source) => (
                      <article key={source.id}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.sourceArticle} · {source.section} ↗
                        </a>
                        <p>{source.excerpt}</p>
                        <small>
                          Revision {source.revisionId} · retrieved{' '}
                          {new Date(source.retrievedAt).toLocaleString()}
                        </small>
                      </article>
                    ))}
                  </div>
                )}
                <div className="ww-sources">
                  <strong>Sources</strong>
                  {(card.evidence || []).map((source) => (
                    <a key={source.id} href={source.url} target="_blank" rel="noreferrer">
                      {source.sourceArticle} ↗
                    </a>
                  ))}
                </div>
              </article>
            )}
              <button className="ww-button ww-button--light" disabled={busy} onClick={() => void exploreTopic()}>Explore {topic.title}</button>
              </div>
            </div>
          </section>
        )}
          </div>
        </section>
          <ResearchPanel
            key={state.resultToken}
            source={connection.source.title}
            target={connection.target.title}
            topic={topic?.title || 'their connection'}
            candidateId={topic ? current : undefined}
            suggestedQuestions={card?.candidateId === current ? card.suggestedQuestions : undefined}
            draft={researchDraft}
            resultToken={state.resultToken}
            investigationId={state.investigationId}
            onResult={(result, askedQuestion) => {
              setQuestion(askedQuestion);
              setFinding(result);
              if (result.saved?.id)
                setState((value) => (value ? {...value, investigationId: result.saved.id} : value));
              else void persistFinding(result);
            }}
          />
        </div>
        {notice && (
          <p className="ww-notice" role="status">
            {notice}
          </p>
        )}
        <div className="ww-result-footer">
          <button className="ww-text-button" onClick={() => navigate('/')}>
            Scan again
          </button>
          <span>Every explanation is checked against its sources.</span>
        </div>
      </main>
    </Shell>
  );
}
