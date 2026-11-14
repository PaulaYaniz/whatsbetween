import React, {lazy, Suspense} from 'react';
import {BrowserRouter, Navigate, Route, Routes} from 'react-router-dom';
import {ThemeProvider} from 'styled-components';

import theme from '../resources/theme.json';
import {Camera} from './Camera';
import {Home} from './Home';
import {Research} from './Research';
import {AboutPage} from './wikiwormhole/AboutPage';
import {DiscoverPage} from './wikiwormhole/DiscoverPage';
import {SavedPage} from './wikiwormhole/SavedPage';
import {ScanPage} from './wikiwormhole/ScanPage';

const AsyncBlogPost = lazy(() =>
  import('./blog/BlogPost').then((module) => ({default: module.BlogPost}))
);

export const App: React.FC = () => {
  return (
    <ThemeProvider theme={theme}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<ScanPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/saved" element={<SavedPage />} />
          {import.meta.env.DEV && <Route path="/legacy" element={<Home />} />}
          {import.meta.env.DEV && <Route path="/scan" element={<Camera />} />}
          {import.meta.env.DEV && <Route path="/camera" element={<Camera />} />}
          {import.meta.env.DEV && <Route path="/research" element={<Research />} />}
          <Route path="/about" element={<AboutPage />} />
          <Route path="/blog" element={<Navigate to="/about" replace />} />
          <Route
            path="/blog/:postId"
            element={
              <Suspense fallback={null}>
                <AsyncBlogPost />
              </Suspense>
            }
          />
          {/* Redirect unmatched routes to home page, replacing history stack. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
};
