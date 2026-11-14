import {useId, useState} from 'react';
import type {Article, PathInfo} from '../../worker/types';

const REASONS: Record<string, string> = {
  graph_not_configured: 'The local graph service is not connected.',
  graph_unreachable: 'The local graph service is not running.',
  graph_unavailable: 'The graph is not ready yet.',
  no_path_within_limit: 'No route of six steps or fewer was found in this snapshot.',
};

export function PathStrip({path, onExplain}: {path?: PathInfo; onExplain?: (question: string) => void}) {
  const [selected, setSelected] = useState(0);
  const [article, setArticle] = useState<Article | null>(null);
  const marker = useId().replace(/:/g, '');
  if (!path?.found || !path.routes.length) return <div className="ww-map-empty"><h2>Route unavailable</h2><p>{REASONS[path?.reason || ''] || 'The path search did not return a route.'}</p><p>You can still explore shared topics and ask questions.</p></div>;
  const route = path.routes[selected] || path.routes[0];
  const columns = Math.max(...path.routes.map(items => items.length));
  const width = Math.max(600, columns * 160);
  const ask = () => onExplain?.(`Explain how ${route[0].title} connects to ${route.at(-1)!.title} through this Wikipedia link path: ${route.map(node => node.title).join(' → ')}. For each step, explain what the link means using sources. Distinguish the historical graph snapshot from current article evidence.`);
  return <section className="ww-route-map" aria-label="Shortest routes">
    <div className="ww-map-heading"><h2>{path.hops} {path.hops === 1 ? 'step' : 'steps'} apart</h2><p>{path.routes.length} {path.routes.length === 1 ? 'route' : 'routes'} found · Select a route or an article to explore.</p></div>
    <div className="ww-map-scroll" tabIndex={0} aria-label="Scrollable route map">
      <div style={{minWidth: width}}>
        {path.routes.map((items, index) => <div className={`ww-route-lane ${selected === index ? 'is-selected' : ''}`} key={index}>
          <button className="ww-route-selector" aria-pressed={selected === index} onClick={() => {setSelected(index); setArticle(null);}}>Route {index + 1}</button>
          <div className="ww-route-stops">
            <svg className="ww-route-line" viewBox={`0 0 ${width} 30`} preserveAspectRatio="none" aria-hidden="true"><defs><marker id={`${marker}-${index}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>{items.slice(1).map((_, i) => <path key={i} d={`M ${(i + .5) * width / items.length + 12} 15 H ${(i + 1.5) * width / items.length - 16}`} stroke="currentColor" strokeWidth="2" markerEnd={`url(#${marker}-${index})`} />)}</svg>
            {items.map((node, i) => <button key={`${node.id}-${i}`} className={`ww-route-stop ${i === 0 || i === items.length - 1 ? 'is-endpoint' : ''}`} aria-pressed={selected === index && article?.id === node.id} onClick={() => {setSelected(index); setArticle(node);}}><span className="ww-stop-dot" aria-hidden="true" /><span>{node.title}</span></button>)}
          </div>
        </div>)}
      </div>
    </div>
    <div className="ww-map-meta"><span>Shortest routes in the SDOW snapshot{path.snapshot ? ` · ${path.snapshot}` : ''}</span><button className="ww-button ww-button--dark" onClick={ask}>Ask about this route</button></div>
    <div className="ww-node-detail" aria-live="polite">{article ? <><h3>{article.title}</h3>{article.description && <p>{article.description}</p>}<a href={article.url} target="_blank" rel="noreferrer">Read on Wikipedia ↗</a></> : <p>Each arrow is a Wikipedia link. Select a stop to open its article details.</p>}</div>
  </section>;
}
