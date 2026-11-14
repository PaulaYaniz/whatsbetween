import {useEffect, useRef, useState} from 'react';

import {
  cleanResearchText,
  normalizeResearchAnswer,
  researchQuestions,
} from '../../worker/researchSupport';
import type {Finding} from './api';

import './researchPanel.css';

type Turn = {question: string; context: string; result?: Finding; error?: string};
type Props = {
  draft?: {text: string} | null;
  source: string;
  target: string;
  topic: string;
  candidateId?: string;
  suggestedQuestions?: string[];
  resultToken: string;
  investigationId?: string;
  onResult: (result: Finding, question: string) => void;
};

export function ResearchPanel({
  draft,
  source,
  target,
  topic,
  candidateId,
  suggestedQuestions,
  resultToken,
  investigationId,
  onResult,
}: Props) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (draft) {
      setQuestion(draft.text);
      input.current?.focus();
    }
  }, [draft]);
  const suggestions = researchQuestions(source, target, topic, suggestedQuestions);
  async function ask(event: React.FormEvent) {
    event.preventDefault();
    const value = question.trim();
    if (busy || value.length < 2 || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setEvents([]);
    setQuestion('');
    const index = turns.length;
    setTurns((items) => [...items, {question: value, context: topic}]);
    let received = false;
    let serviceError = '';
    const update = (turn: Partial<Turn>) =>
      setTurns((items) => items.map((item, i) => (i === index ? {...item, ...turn} : item)));
    try {
      const history = turns
        .flatMap((turn) => [
          {role: 'user' as const, content: turn.question.slice(0, 1600)},
          ...(turn.result?.finding
            ? [{role: 'assistant' as const, content: turn.result.finding.slice(0, 1600)}]
            : []),
        ])
        .slice(-6);
      const response = await fetch('/api/research', {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          resultToken,
          candidateId,
          question: value,
          history,
          ...(investigationId ? {investigationId} : {}),
        }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error?.message || 'Research is unavailable. Try again.');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consume = (chunk: string) => {
        const line = chunk.split('\n').find((item) => item.startsWith('data: '));
        if (!line) return;
        const message = JSON.parse(line.slice(6));
        if (message.type === 'activity')
          setEvents((items) => [...items.slice(-3), message.message]);
        if (message.type === 'error') serviceError = message.message;
        if (message.type === 'result') {
          received = true;
          const fallback = suggestions.find((item) => item !== value) || suggestions[0];
          message.data = normalizeResearchAnswer(message.data, fallback);
          update({result: message.data, ...(serviceError ? {error: serviceError} : {})});
          onResult(message.data, value);
        }
      };
      while (true) {
        const {value, done} = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, {stream: true});
        buffer = buffer.replace(/\r\n/g, '\n');
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        chunks.forEach(consume);
        if (done) {
          if (buffer.trim()) consume(buffer);
          break;
        }
      }
      if (!received)
        throw new Error(
          serviceError ||
            'The response was interrupted. Your question is kept in this conversation; try sending it again.'
        );
    } catch (error) {
      if (!controller.signal.aborted)
        update({error: error instanceof Error ? error.message : 'Research is unavailable.'});
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="ww-research">
      <header className="ww-research-heading"><h2>Explore further</h2><p>Ask a question. Follow the evidence.</p><span>Context: {topic}</span></header>
        <div className="ww-research-body">
          <div className="ww-question-suggestions" aria-label="Suggested questions">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                disabled={busy}
                onClick={() => {
                  setQuestion(suggestion);
                  input.current?.focus();
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
          <div
            className="ww-research-conversation"
            role="log"
            aria-label="Research conversation"
            aria-live="polite"
          >
            {turns.map((turn, index) => (
              <article className="ww-research-turn" key={index}>
                <p className="ww-research-question">
                  <span>You asked · {turn.context}</span>
                  {turn.question}
                </p>
                {turn.result && (
                  <div className="ww-finding">
                    <span className="ww-answer-status">
                      {{
                        supported: 'Supported by sources',
                        hypothesis: 'Possible explanation',
                        insufficient: 'More evidence needed',
                        partial: 'Research incomplete',
                        unavailable: 'Research unavailable',
                      }[turn.result.status] || turn.result.status}
                    </span>
                    {turn.result.finding && <p>{turn.result.finding}</p>}
                    {turn.result.claims.map((claim, i) => (
                      <p key={i}>
                        {claim.claim}{' '}
                        {claim.evidenceIds.map((id) => {
                          const evidence = turn.result!.evidence.find((item) => item.id === id);
                          return evidence ? (
                            <a
                              className="ww-inline-source"
                              key={id}
                              href={evidence.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              [{turn.result!.evidence.indexOf(evidence) + 1}]
                            </a>
                          ) : null;
                        })}
                      </p>
                    ))}
                    {cleanResearchText(turn.result.uncertainty) && (
                      <p className="ww-research-detail">
                        {cleanResearchText(turn.result.uncertainty)}
                      </p>
                    )}
                    {turn.result.followUp && (
                      <p className="ww-research-detail">Explore next: {turn.result.followUp}</p>
                    )}
                    {turn.result.evidence.map((item, i) => (
                      <a
                        className="ww-source-row"
                        key={item.id}
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        [{i + 1}] {item.sourceArticle} · {item.section} ↗
                      </a>
                    ))}
                  </div>
                )}
                {turn.error && turn.error !== turn.result?.uncertainty && (
                  <p className="ww-research-error">{turn.error}</p>
                )}
                {!busy && (turn.error || (turn.result && !turn.result.finding)) && (
                  <button
                    className="ww-text-button"
                    onClick={() => {
                      setQuestion(turn.question);
                      input.current?.focus();
                    }}
                  >
                    Try this question again
                  </button>
                )}
                {busy && index === turns.length - 1 && (
                  <div role="status"><p>{events.at(-1) || "Starting research…"}</p><details><summary>Research steps</summary><ol className="ww-activity">
                    {events.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ol></details></div>
                )}
              </article>
            ))}
          </div>
          <form onSubmit={ask}>
            <label htmlFor="ww-question">
              {turns.length
                ? 'Ask a follow-up or a new question'
                : 'What would you like to understand?'}
            </label>
            <textarea
              ref={input}
              id="ww-question"
              value={question}
              maxLength={1200}
              minLength={2}
              required
              disabled={busy}
              placeholder="Ask about these objects or the shared topic…"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <button
              className="ww-button ww-button--dark"
              type="submit"
              disabled={busy || question.trim().length < 2}
            >
              {busy ? 'Researching…' : turns.length ? 'Send follow-up' : 'Research this question'}
            </button>
          </form>
        </div>
    </section>
  );
}
