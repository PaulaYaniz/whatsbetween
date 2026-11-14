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
          Wiki<span>Wormhole</span>
          <i>✳</i>
        </Link>
        <nav aria-label="Main navigation">
          <Link className={active === 'scan' ? 'active' : ''} to="/">
            Scan
          </Link>
          <Link className={active === 'saved' ? 'active' : ''} to="/saved">
            Saved investigations
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
        Curiosity has a way of connecting things. <span>Evidence from Wikipedia</span>
      </footer>
    </div>
  );
}
