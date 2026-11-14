import {useEffect, useState} from 'react';
import {Link, useNavigate} from 'react-router-dom';

import {api} from './api';
import {Shell} from './Shell';

import './wikiwormhole.css';

interface Saved {
  id: string;
  source: {title: string; id: number};
  target: {title: string; id: number};
  updatedAt: string;
  runStatus: string;
  finding?: any;
  path?: {found: boolean; hops?: number; routes: {id: number; title: string; url: string}[][]};
}
export function SavedPage() {
  const [items, setItems] = useState<Saved[]>([]);
  const [message, setMessage] = useState('Loading saved investigations…');
  const [selected, setSelected] = useState<any>(null);
  const navigate = useNavigate();
  useEffect(() => {
    void api<{investigations: Saved[]}>('/investigations')
      .then((result) => {
        setItems(result.investigations);
        setMessage(
          result.investigations.length ? '' : 'No saved investigations in this browser session yet.'
        );
      })
      .catch((error) => setMessage(error.message));
  }, []);
  async function open(id: string) {
    try {
      const item = await api<any>(`/investigations/${id}`);
      setSelected(item);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open investigation.');
    }
  }
  async function remove(id: string) {
    try {
      await api(`/investigations/${id}`, {method: 'DELETE'});
      setItems((value) => value.filter((item) => item.id !== id));
      if (selected?.id === id) setSelected(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete investigation.');
    }
  }
  return (
    <Shell active="saved">
      <main className="ww-main">
        <div className="ww-hero ww-hero--saved">
          <span className="ww-kicker">YOUR COLLECTION</span>
          <h1>Saved investigations</h1>
          <p>Only this anonymous browser session can see these investigations.</p>
        </div>
        {message && (
          <p className="ww-notice" role="status">
            {message}
          </p>
        )}
        <div className="ww-saved-list">
          {items.map((item) => (
            <article className="ww-saved-item" key={item.id}>
              <div>
                <span className="ww-kicker">{new Date(item.updatedAt).toLocaleDateString()}</span>
                <h2>
                  {item.source.title} <i>↔</i> {item.target.title}
                </h2>
                <p>
                  {item.finding?.finding ||
                    (item.path?.found
                      ? `Shortest path · ${item.path.hops} ${item.path.hops === 1 ? 'step' : 'steps'}`
                      : 'Shared topic investigation')}
                </p>
              </div>
              <div className="ww-saved-actions">
                <button onClick={() => void open(item.id)}>Open</button>
                <button
                  className="ww-delete"
                  onClick={() => void remove(item.id)}
                  aria-label={`Delete ${item.source.title} and ${item.target.title}`}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
        {selected && (
          <section className="ww-saved-detail">
            <button className="ww-text-button" onClick={() => setSelected(null)}>
              Close
            </button>
            <span className="ww-kicker">
              VERSION {selected.summary?.version || selected.version || 1}
            </span>
            <h2>
              {selected.summary?.source?.title} and {selected.summary?.target?.title}
            </h2>
            <p>{selected.findings?.[0]?.finding?.finding || 'No deeper finding saved yet.'}</p>
            {(selected.summary?.path ?? selected.path)?.routes?.[0] && (
              <ol className="ww-path-steps" aria-label="Shortest path">
                {((selected.summary?.path ?? selected.path).routes[0] as any[]).map(
                  (node, index) => (
                    <li key={node.id}>
                      {index > 0 && (
                        <span className="ww-path-arrow" aria-hidden="true">
                          →
                        </span>
                      )}
                      <a href={node.url} target="_blank" rel="noreferrer">
                        {node.title}
                      </a>
                    </li>
                  )
                )}
              </ol>
            )}
            {(selected.evidence || []).map((item: any) => (
              <a
                className="ww-source-row"
                key={item.id}
                href={item.url}
                target="_blank"
                rel="noreferrer"
              >
                {item.sourceArticle} ↗
              </a>
            ))}
          </section>
        )}
        <div className="ww-result-footer">
          <button className="ww-button ww-button--coral" onClick={() => navigate('/')}>
            Start a new scan
          </button>
          <Link to="/">Back to scan</Link>
        </div>
      </main>
    </Shell>
  );
}
