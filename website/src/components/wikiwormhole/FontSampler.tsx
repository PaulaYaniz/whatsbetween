import './wikiwormhole.css';
import './fontSampler.css';

const samples = [
  {name: 'Technical Sans', style: "Arial, Helvetica, sans-serif", note: 'Clear, compact, familiar'},
  {name: 'Mechanical Serif', style: "'Courier New', Courier, monospace", note: 'Geometric, sturdy, engineered'},
  {name: 'Editorial Serif', style: "'Crimson Text', Georgia, serif", note: 'Warm, precise, bookish'},
  {name: 'Monospaced', style: "monospace", note: 'Instrument panel, distinctly technical'},
  {name: 'Humanist Sans', style: "'Quicksand', sans-serif", note: 'Open, readable, quietly modern'},
];

export function FontSampler() {
  return <main className="ww-font-sampler">
    <header><span>TYPE STUDY / 01</span><h1>What's Between...?</h1><p>Pick the voice that feels right for the project.</p></header>
    <section>{samples.map((sample) => <article key={sample.name} style={{fontFamily: sample.style}}>
      <div className="ww-font-meta"><strong>{sample.name}</strong><span>{sample.note}</span></div>
      <h2>Fork <i>↔</i> Headphones</h2>
      <p>Follow the links between everyday objects. A fork carries food; headphones carry sound. Their paths through history reveal surprising places where design, materials, and culture meet.</p>
      <small>0123456789 · Aa Bb Cc · Sources [1] [2]</small>
    </article>)}</section>
  </main>;
}
