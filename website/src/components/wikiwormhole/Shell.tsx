import {Link} from 'react-router-dom';

export function Shell({
  active,
  children,
}: {
  active: 'scan' | 'saved' | 'about';
  children: React.ReactNode;
}) {
  return (
    <div className="ww-app">
      <header className="ww-header">
        <Link className="ww-brand" to="/">
          <svg className="ww-brand-mark" viewBox="0 0 44 18" aria-hidden="true" focusable="false">
            <path d="M5 9 C 14 1, 18 1, 22 9" />
            <path d="M39 9 C 30 17, 26 17, 22 9" />
            <circle cx="5" cy="9" r="4" className="ww-brand-a" />
            <circle cx="39" cy="9" r="4" className="ww-brand-b" />
            <circle cx="22" cy="9" r="3.2" className="ww-brand-knot" />
          </svg>
          <span>What&rsquo;s Between</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link className={active === 'scan' ? 'active' : ''} to="/">
            Scan
          </Link>
          <Link className={active === 'saved' ? 'active' : ''} to="/saved">
            Saved
          </Link>
          <Link
            className={active === 'about' ? 'active' : ''}
            aria-current={active === 'about' ? 'page' : undefined}
            to="/about"
          >
            About
          </Link>
        </nav>
      </header>
      {children}
      <footer className="ww-footer">
        Links from a December 2023 snapshot of Wikipedia. Explanations quote today&rsquo;s articles.
      </footer>
    </div>
  );
}
