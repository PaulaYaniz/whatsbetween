# Dependency review — November 15, 2026

Production npm audit: **0 vulnerabilities**.
Full npm audit: **7 moderate, 0 high, 0 critical**, down from 16 total (4 high).
Audit results describe this lockfile at review time; rerun before releases.

Removed the inactive SDOW home/blog routes and archived their source under
`website/legacy-src/` outside the TypeScript/build inputs. Legacy blog URLs
redirect to About. Removed D3, lodash, styled-components, react-autosuggest,
react-modal, their typings and source-map-explorer (146 packages removed in
the initial removal). The SDOW MIT notice and attribution remain.

Patched Vite to 8.3.8 and ESLint to 10.15.0. Updated TypeScript ESLint to 8.72.2.
React Router 6.30.6 still had router advisories; migrated the declarative router
to 7.18.5. Build and all 46 tests pass. The main client JavaScript bundle is
278.78 kB (89.86 kB gzip), versus about 439.65 kB before cleanup; legacy blog
chunks are gone.

Seven remaining findings come from minimatch and the development-only
TypeScript ESLint chain. The upstream fix requires minimatch 11, which removes
APIs from older versions; forcing a global override is not a safe patch.
npm also suggests an older TypeScript ESLint release rather than a compatible
forward fix. No forced downgrade or cross-major override was applied.
Track [the upstream advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
and update tooling when its dependency constraints support the patched version.

The project normally requires packages to age two days before installation.
The targeted security update used a one-command exception for freshly released
patches; the project's release-age policy remains in .npmrc.
Use the bundled Node 24.16 runtime when installing (engine-strict is enabled).

ESLint currently reports 64 errors and 4 warnings in the active codebase,
including explicit any types and console statements. Those are a separate
code-quality cleanup; this review does not claim the full lint task passes.
