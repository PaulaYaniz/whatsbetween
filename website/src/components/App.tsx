import React from 'react';
import {BrowserRouter, Navigate, Route, Routes} from 'react-router-dom';

import {Camera} from './Camera';
import {Research} from './Research';
import {AboutPage} from './wikiwormhole/AboutPage';
import {DiscoverPage} from './wikiwormhole/DiscoverPage';
import {FontSampler} from './wikiwormhole/FontSampler';
import {SavedPage} from './wikiwormhole/SavedPage';
import {ScanPage} from './wikiwormhole/ScanPage';

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ScanPage />} />
        <Route path="/fonts" element={<FontSampler />} />
        <Route path="/discover" element={<DiscoverPage />} />
        <Route path="/discover/:sourceId/:targetId" element={<DiscoverPage />} />
        <Route path="/saved" element={<SavedPage />} />
        {import.meta.env.DEV && <Route path="/scan" element={<Camera />} />}
        {import.meta.env.DEV && <Route path="/camera" element={<Camera />} />}
        {import.meta.env.DEV && <Route path="/research" element={<Research />} />}
        <Route path="/about" element={<AboutPage />} />
        <Route path="/blog" element={<Navigate to="/about" replace />} />
        <Route path="/blog/:postId" element={<Navigate to="/about" replace />} />
        {/* Redirect unmatched routes to home page, replacing history stack. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
};
