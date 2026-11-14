import React, {FormEvent, useEffect, useRef, useState} from 'react';
import {Link} from 'react-router-dom';

import {SDOW_API_URL} from '../resources/constants';
import './research.css';

interface Message {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

interface Status {
  readonly available: boolean;
  readonly model: string;
  readonly persistence: string;
}

const THREAD_KEY = 'wikiwormhole.research.thread';

function renderText(text: string) {
  const parts = text.split(/(\[[^\]]+\]\(https:\/\/[^)]+\)|https:\/\/[^\s)\]]+)/g);
  return parts.map((part, index) =>
    part.startsWith('https://') || part.startsWith('[') ? (
      <a
        key={`${part}-${index}`}
        href={part.startsWith('[') ? part.slice(part.indexOf('](https://') + 2, -1) : part}
        target="_blank"
        rel="noreferrer"
      >
        {part.startsWith('[') ? part.slice(1, part.indexOf('](')) : part}
      </a>
    ) : (
      <React.Fragment key={index}>{part}</React.Fragment>
    )
  );
}

async function request(path: string, body?: object) {
  const response = await fetch(`${SDOW_API_URL}/research${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? {'Content-Type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(String(data.error || 'Research request failed.'));
  return data;
}

export const Research: React.FC = () => {
  const [threadId, setThreadId] = useState(() => localStorage.getItem(THREAD_KEY) || '');
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const transcript = useRef<HTMLElement>(null);

  useEffect(() => {
    request('/status')
      .then(setStatus)
      .catch(() => setError('The research service is unavailable. Start the local backend.'));
  }, []);

  useEffect(() => {
    if (!threadId) return;
    request(`/threads/${threadId}`)
      .then((data) => setMessages(data.messages))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load this thread.'));
  }, [threadId]);

  useEffect(() => {
    transcript.current?.scrollTo({top: transcript.current.scrollHeight, behavior: 'smooth'});
  }, [messages, busy]);

  const newThread = async () => {
    try {
      const data = await request('/threads', {});
      setThreadId(data.threadId);
      localStorage.setItem(THREAD_KEY, data.threadId);
      setMessages([]);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a research thread.');
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    setDraft('');
    setMessages((previous) => [...previous, {role: 'user', text}]);
    try {
      let activeThread = threadId;
      if (!activeThread) {
        const created = await request('/threads', {});
        activeThread = created.threadId;
        setThreadId(activeThread);
        localStorage.setItem(THREAD_KEY, activeThread);
      }
      const data = await request('/chat', {threadId: activeThread, message: text});
      setMessages((previous) => [...previous, {role: 'assistant', text: data.answer}]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Research failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="ww ww-research">
      <header className="ww-research-header">
        <Link className="ww-research-home" to="/">What's Between</Link>
        <button className="ww-research-new" type="button" onClick={newThread} disabled={busy}>
          New conversation
        </button>
      </header>

      <section className="ww-research-main" aria-labelledby="research-title">
        <h1 id="research-title">Explore a connection</h1>
        <p className="ww-research-intro">
          Ask about Wikipedia topics, links, and shared ideas. The research agent checks live
          Wikipedia results and keeps this conversation in your Atlas database.
        </p>

        <div className="ww-research-status" role="status">
          <span className={status?.available ? 'ww-status-dot is-ready' : 'ww-status-dot'} />
          {status?.available
            ? `Configured · ${status.model} · saved in ${status.persistence}`
            : 'Set GEMINI_API_KEY and MONGODB_URI in the backend .env.local to enable research.'}
        </div>

        <section className="ww-research-transcript" ref={transcript} aria-live="polite">
          {messages.length === 0 ? (
            <div className="ww-research-empty">
              <p>Try a question</p>
              <button type="button" onClick={() => setDraft('How are tea and porcelain connected on Wikipedia?')}>
                How are tea and porcelain connected?
              </button>
              <button type="button" onClick={() => setDraft('Find the Wikipedia article for the James Webb Space Telescope and explain its link to astronomy.')}>
                Explore an article and its links
              </button>
            </div>
          ) : (
            messages.map((message, index) => (
              <article className={`ww-message is-${message.role}`} key={`${index}-${message.role}`}>
                <h2>{message.role === 'user' ? 'You' : 'Research assistant'}</h2>
                <p>{renderText(message.text)}</p>
              </article>
            ))
          )}
          {busy && <p className="ww-research-thinking">Checking Wikipedia and preparing an answer…</p>}
        </section>

        {error && <p className="ww-research-error" role="alert">{error}</p>}

        <form className="ww-research-form" onSubmit={send}>
          <label className="ww-visually-hidden" htmlFor="research-prompt">Your question</label>
          <textarea
            id="research-prompt"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Ask about two Wikipedia topics…"
            disabled={busy}
          />
          <div className="ww-research-controls">
            <span>Questions up to 2,000 characters</span>
            <button type="submit" disabled={busy || !draft.trim()}>
              {busy ? 'Researching' : 'Ask'}
            </button>
          </div>
        </form>
        <p className="ww-research-privacy">
          Conversation messages and agent checkpoints are stored in the configured MongoDB Atlas
          database. Don’t include secrets or personal information.
        </p>
      </section>
    </main>
  );
};
