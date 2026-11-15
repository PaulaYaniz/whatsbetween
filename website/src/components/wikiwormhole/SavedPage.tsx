import {useEffect, useState} from 'react';
import {Link} from 'react-router-dom';

import {api} from './api';
import {Shell} from './Shell';

import './wikiwormhole.css';

interface Saved {
  id: string;
  source: {title: string; id: number};
  target: {title: string; id: number};
}
export function SavedPage() {
  const [items, setItems] = useState<Saved[]>([]);
  const [message, setMessage] = useState('Loading saved pairs…');
  useEffect(() => {
    void api<{investigations: Saved[]}>('/investigations')
      .then((result) => {
        setItems(result.investigations);
        setMessage(
          result.investigations.length ? '' : 'No saved pairs yet.'
        );
      })
      .catch((error) => setMessage(error.message));
  }, []);
  async function remove(id: string) {
    try {
      await api(`/investigations/${id}`, {method: 'DELETE'});
      setItems((value) => value.filter((item) => item.id !== id));
      if (items.length === 1) setMessage('No saved pairs yet.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete saved pair.');
    }
  }
  return (
    <Shell active="saved">
      <main className="ww-main">
        <div className="ww-hero ww-hero--saved">
          <h1>Research log</h1>
        </div>
        {message && (
          <p className="ww-notice" role="status">
            {message}
          </p>
        )}
        <div className="ww-saved-list">
          {items.map((item) => (
            <article className="ww-saved-item" key={item.id}>
              <Link
                className="ww-saved-pair"
                to={`/discover/${item.source.id}/${item.target.id}`}
              >
                <h2>
                  {item.source.title} <i>↔</i> {item.target.title}
                </h2>
              </Link>
              <div className="ww-saved-actions">

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
      </main>
    </Shell>
  );
}
