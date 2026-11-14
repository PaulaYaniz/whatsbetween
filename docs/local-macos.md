# Local setup on Apple Silicon macOS

Verified on this M4 MacBook Air on 2026-11-06 with native ARM64 Python 3.14.2,
Node 24.16.0, and npm 11.19.1. Read alongside `.github/CONTRIBUTING.md`.

## One-time setup

The following commands were used from this checkout:

```sh
cd /Users/paula/Documents/WikiWormhole/sdow
python3 -m venv env
env/bin/python -m pip install -r requirements.txt
env/bin/python -m pip check
env/bin/python scripts/create_mock_databases.py

# Install the exact Node version required by website/.nvmrc and package.json,
# locally under the ignored env directory, without changing global Node.
npm install --prefix env/node --no-save --package-lock=false node@24.16.0
export PATH="$PWD/env/node/node_modules/node/bin:$PATH"
node --version
cd website
npm ci
printf '%s\n' 'VITE_SDOW_API_URL=http://127.0.0.1:5001' > .env.development.local
```

The mock generator creates 35 pages, 20 link records, and five redirects. Run it
only for initial setup or an intentional mock reset: it replaces the pages,
links, and redirects tables in `sdow/sdow.sqlite`. Do not run it over a full
Wikipedia database. No full database download is needed.

## Start the backend (terminal 1)

```sh
cd /Users/paula/Documents/WikiWormhole/sdow/sdow
../env/bin/python -m flask --app server run --debug --host 127.0.0.1 --port 5001
```

Keep this working directory: the backend resolves its SQLite paths relative to it.

## Start the frontend (terminal 2)

```sh
cd /Users/paula/Documents/WikiWormhole/sdow/website
export PATH="$PWD/../env/node/node_modules/node/bin:$PATH"
BROWSER=none npm start -- --host 127.0.0.1 --strictPort
```

Open http://127.0.0.1:3000/?source=1&target=6 and press **Go!**.
Stop each server with Ctrl+C in its terminal. Restart Vite after changing the env file.

## Compatibility adjustments

- macOS Control Center already listens on port 5000. Flask uses 5001, avoiding
  a change to macOS settings. The only application code change lets the development
  API URL read `VITE_SDOW_API_URL`, with the original port 5000 as its fallback.
  The ignored `website/.env.development.local` sets port 5001 for this checkout.
  Production still uses the existing production API URL. This follows Vite's
  [environment variable support](https://vite.dev/guide/env-and-mode).
- Global Node 26.10.0 was rejected by the repository's exact Node engine check.
  The local Node 24.16.0 installation satisfies that check. Dependency manifests,
  the lockfile, and engine checks were not changed.
- All pinned Python dependencies installed on ARM64 without source changes or
  Rosetta. The standard-library `venv` command replaces the documented standalone
  `virtualenv` command.

## Verification and useful commands

Backend smoke checks:

```sh
curl -sS --fail --max-time 30 http://127.0.0.1:5001/ok
curl -sS --fail --max-time 30 \
  -H 'Content-Type: application/json' \
  -d '{"source":"1","target":"6"}' http://127.0.0.1:5001/paths
```

Verified results:

- Health endpoint returns HTTP 200 with a timestamp.
- `1` to `6` returns `1 → 4 → 6` and `1 → 5 → 6`. The browser renders two
  paths, two degrees of separation, the graph, and the individual-results section.
- `6` to `1` returns HTTP 200 with no paths.
- `30 (number)` to `6` resolves the start-page redirect to `1` and returns both paths.
- A title absent from the mock database returns HTTP 400 with a readable error.
- Successful/no-path searches are recorded in `sdow/searches.sqlite`.

Frontend checks (both passed):

```sh
cd /Users/paula/Documents/WikiWormhole/sdow/website
export PATH="$PWD/../env/node/node_modules/node/bin:$PATH"
npm run build
npm run lint
```

The build includes TypeScript checking. Use the development server for local-backend
testing; the production build intentionally targets the production API.

The mock database contains numbered titles (`1` through `10`, then titles such
as `11 (number)`), not arbitrary Wikipedia articles. Random placeholders and
autocomplete may suggest articles outside the fixture. Enter the sample titles
explicitly. Page metadata and autocomplete still use live Wikipedia and require
internet access; the mock database is not an offline mode.

`npm ci` reported 18 vulnerabilities (13 moderate, five high) in the existing
dependency tree. No automatic dependency upgrades were applied in this minimal
local-setup task.

## Zero-cost real-data investigation (2026-11-06)

**Result: no trustworthy, freely downloadable copy of the prebuilt December 2023
SDOW database was found.** This is a search result, not proof that no copy exists.
No real database was downloaded or activated, so there are no real-article search
timings to report. The active database remains the 35-page mock and the development
API override remains `http://127.0.0.1:5001`.

Sources checked:

- [Upstream dataset documentation](https://github.com/jwngr/sdow/blob/main/docs/data-source.md):
  lists `20231220/sdow.sqlite.gz` at 4.3 GB compressed, distributed through
  Requester Pays. That route was deliberately not accessed.
- [Upstream releases](https://github.com/jwngr/sdow/releases): no releases or
  database release assets were listed.
- [Issue 71](https://github.com/jwngr/sdow/issues/71#issuecomment-1868602357):
  the maintainer confirmed the database update on December 24, 2023, but supplied
  no free mirror in the comments inspected.
- [Issue 8](https://github.com/jwngr/sdow/issues/8) and
  [issue 42](https://github.com/jwngr/sdow/issues/42): the historical download
  discussion concerns Requester Pays, including billing requirements. The old
  Google Storage URL in issue 8 is not evidence of a free December 2023 mirror.
- [Issue 149](https://github.com/jwngr/sdow/issues/149),
  [PR 314](https://github.com/jwngr/sdow/pull/314), and
  [issue 319](https://github.com/jwngr/sdow/issues/319): reports of changed
  MediaWiki schemas, old Python code, and parsing errors make an unattended
  build using current dumps inappropriate without further validation.
- Public web searches for `sdow.sqlite`, `sdow.sqlite.gz`, and `20231220`,
  including Archive.org and Hugging Face searches, plus GitHub issue searches,
  did not identify a verifiable free December 2023 artifact. Other projects
  mentioning the SQLite filename did not establish such a download.

No billing, payment details, paid services, or trials were enabled. The public
Six Degrees website/API was not used for searches or configured as a backend.

### Preservation and storage

`df -h .` reported about **143 GiB available**. This is not a verified capacity
estimate for building the full graph: raw dumps and intermediate files can need
far more space than the compressed final database. The upstream historical build
example uses a 256 GB disk and 52 GB RAM; its two-hour timing is not an M4 estimate.

Consistent SQLite backups were made using Python's SQLite backup API at:

```text
data/mock-backup-20261106/sdow.sqlite
data/mock-backup-20261106/searches.sqlite
```

Both backups and the active graph passed `PRAGMA integrity_check` (`ok`).
The active graph still contains 35 pages. `/data/`, `/scripts/dump/`, and
`*.sqlite.gz` are ignored by Git, in addition to the existing active database
exclusions. Keep any future download and extracted validation copy under `data/`.
Never run the mock generator against an activated full graph.

### Practical options without buying services

1. **Build a complete graph locally from official raw dumps.**
   [Wikimedia Downloads](https://dumps.wikimedia.org/) publishes SQL table dumps
   without a billing project. This can preserve full-graph search semantics after
   conversion to SDOW's `pages`, `links`, and `redirects` schema, including both
   directions of every edge and redirect handling. It requires fixing and testing
   the importer for the selected dump schema, checking checksums, and budgeting
   local storage, memory, bandwidth, and processing time. It produces the selected
   snapshot, not necessarily December 2023. It has not been started here.
2. **Obtain a voluntarily shared copy from the maintainer or a trusted contributor.**
   A free HTTPS mirror with a documented snapshot and publisher checksum would
   avoid rebuilding. No such copy was found; no messages were sent on your behalf.
   Before switching, validate gzip integrity, SQLite header/schema and integrity,
   redirect handling, counts, and real-article searches against a separate copy.
3. **Implement bounded live searches using Wikimedia's documented Action API.**
   The official [links](https://www.mediawiki.org/wiki/API:Links) and
   [backlinks](https://www.mediawiki.org/wiki/API:Backlinks) modules expose real
   edges. This would require backend changes and compliance with Wikimedia's
   [API usage guidelines](https://www.mediawiki.org/wiki/API:Etiquette), including
   an identifying User-Agent, caching, pagination, and conservative request rates.
   Broad searches can need many requests; a bounded search may time out or be
   incomplete. It must not claim global shortest paths or prove no path exists
   after stopping early. No live-search implementation or partial graph has been
   substituted for the mock.

The most faithful zero-service-cost route is a validated local build from official
dumps, but it is a separate data-engineering task rather than a download/configuration
step. Keep using the mock for development while deciding whether to undertake it.

## WikiWormhole Scan prototype

Open http://127.0.0.1:3000/scan with the backend and frontend running as above.
The development navigation includes **Scan**; `/camera` remains an alias. The
existing SDOW home, graph, databases, production API URL and searches are preserved.
Scan is intentionally local/development-only. Chosen specimens connect to live
Wikipedia paths; see [Specimen selection and Wikipedia paths](#specimen-selection-and-wikipedia-paths).

### Backend-only API setup

Use your existing free-tier Gemini Developer API project. This work does not enable
billing, create projects, activate trials, or add a paid service. The app cannot
inspect your billing plan; use a key from a project without billing enabled.

Run the hidden-input setup helper (no API request):

```sh
cd /Users/paula/Documents/WikiWormhole/sdow
env/bin/python scripts/configure-gemini.py
```

It saves your key privately in ignored `sdow/.env.local`. Alternatively copy
`sdow/.env.example` there and edit it locally:

```dotenv
GEMINI_API_KEY=your-existing-key
GEMINI_MODEL=gemini-3.1-flash-lite
GEMINI_INTERVAL_SECONDS=6
```

Never place the key in `website/`, a `VITE_` variable, Git, chat, or screenshots.
The backend rereads settings each request; shell environment variables take
precedence. No restart is needed for these settings. Install dependencies only if
needed with `env/bin/python -m pip install -r requirements.txt`.

The existing default model is retained and configurable. Google's
[model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite)
confirms image input and structured output. Google's
[object detection guidance](https://ai.google.dev/gemini-api/docs/image-understanding#object-detection)
documents bounding boxes as `[ymin, xmin, ymax, xmax]` on a 0–1000 scale. This
prototype uses that convention with the official Python SDK. Model documentation
is capability evidence, not a guarantee of localization accuracy on your objects.

Expand **Gemini setup & single-image check**, choose an object photo (JPEG/PNG,
under 2 MB and 12 megapixels), then **Check one image**. This sends the full image
once and verifies the new label-plus-box response schema for this key/model.
The prior label-only verification no longer unlocks scanning. Empty detections
validate structure only; use a clear object photo to assess actual boxes. This
check is also available through:

```sh
env/bin/python scripts/check-image.py data/gemini-smoke-scones.jpg
```

### Test the Mac webcam first

1. Open `/scan` in Chrome or Safari on the Mac. Choose the built-in webcam (or
   System default), click **Open camera**, and allow browser/macOS camera access.
   This previews only: no frames go to Gemini. Named devices appear after permission.
2. Check live motion and aspect ratio. If access fails, the status explains denied
   permission, unavailable devices, or a busy camera. Use browser site permissions
   and macOS System Settings → Privacy & Security → Camera to recover.
3. Complete the single-image check, then click **Start scanning**. Hold a cup and
   another object still, in good light. Expect labeled boxes after a sampled request.
   People, hands and worn clothing are excluded by prompt, with a common-label
   exclusion guard; semantic filtering remains imperfect.
4. Resize the window and toggle **Mirror preview**. Boxes should stay aligned and
   labels readable. Edit an object's label, save two different detections, and
   confirm a third cannot be selected until one saved selection is removed.
5. Move objects slowly: a browser worker follows their appearance between Gemini
   responses, up to 10 times/second. Remove or cover an object: its box should hide
   when the appearance match is lost. Very fast motion, rotation, occlusion, camera
   reframing, and plain/low-detail objects can lose tracking. A fresh Gemini result
   is needed to reacquire them; the tracker does not invent a continuation. Boxes
   expire at most 10 seconds after their last recognition frame. Responses already
   older than that are discarded. Saved selections are local snapshots after Stop. Corrections apply to matching labels until the
   next scan; same-label objects share a correction.
6. Hide the tab: sampling pauses, current boxes clear, and results from before the
   visibility change are ignored. Return to resume. **Stop** releases all tracks,
   closes the session and ignores late results. Already submitted calls can finish
   and count. Use Stop when the camera should be released, rather than hiding the tab.

### Then test iPhone via Continuity Camera

Keep the page open on the Mac; no phone app or LAN deployment is needed. Follow
[Apple's Continuity Camera setup](https://support.apple.com/en-us/102546): use
compatible devices on the same Apple Account with two-factor authentication,
Bluetooth and Wi-Fi on, and Continuity Camera enabled on the iPhone. Keep the phone
nearby, locked, and mounted with its rear cameras facing the scene. A trusted USB
connection can also be used. Avoid Center Stage or other reframing effects during
localization testing.

1. **Stop** the Mac camera. Make the iPhone available to macOS, then click
   **Refresh cameras** and select its named entry. The browser can only list devices
   exposed by macOS; it cannot force a missing iPhone to connect.
2. **Open camera** and confirm the preview comes from the iPhone (move an object
   in front of its rear camera). Then **Start scanning**.
3. Repeat the two-object, resize/mirror, hidden-tab, and Stop checks above. Changing
   cameras automatically stops recognition and clears boxes. Open and start again
   for the selected device. Disconnecting the phone should stop capture with a
   readable recovery message.

Physical device availability, permission and recognition quality must be checked
on these devices. Synthetic browser tests do not establish a physical-camera pass.

### Quota and privacy behavior

- One Gemini call at a time across local sessions/processes through a separate
  ignored `data/vision-usage.sqlite`; SDOW databases are untouched. SDK timeout is
  25 seconds, one attempt, no retry or fallback model.
- `GEMINI_INTERVAL_SECONDS` now sets minimum spacing between request starts
  (default/minimum 6, maximum 3600), with one request in flight. The backend returns
  remaining cooldown after inference, so its duration is not followed by another
  full interval. The browser adds a small scheduling margin. Backend enforces
  spacing globally too. This allows fewer than ten recognition requests/minute at
  the default, rather than the previous fewer than five; existing attempt caps
  remain in place. Set it conservatively
  for the selected model's **actual** RPM/TPM/RPD shown in AI Studio; other clients
  share project quotas. [Google's quota documentation](https://ai.google.dev/gemini-api/docs/rate-limits)
  explains the project-wide limits. The app cannot guarantee quota headroom.
- Existing ceilings remain: 50 attempts per session, 500 attempts per Pacific day,
  and five single-image checks per day. Errors after dispatch count. Quota errors
  stop capture, impose a backend pause of at least 60 seconds, and require manual
  restart. There is no automatic retry or billing change.
- Full video frames (not the previous central crop) are sampled, scaled to at most
  960 pixels, and compressed to JPEG (quality 80). No audio, frames, raw responses,
  or keys are written to disk by this app. Tracking keeps a bounded rolling buffer
  of up to 110 grayscale frames (maximum side 320 pixels) in local worker memory
  for at most ten seconds, then releases it on Stop, hidden tab, or navigation.
  This allows boxes detected in an older request frame to be moved through the
  intervening video frames before showing them. Only the sampled JPEG goes to
  Google; tracking frames remain local. Google processes submitted images under your project's terms.
- The configured `gemini-3.1-flash-lite` uses explicit minimal thinking and medium
  media resolution for lightweight requests. Other configured models retain their
  default thinking setting. Smaller images/media budget can miss small details.
  The UI displays measured Gemini response time; network/provider latency varies.
- Boxes are validated as bounded integer rectangles with positive area. Multiple
  same-label objects remain distinct within a sample. Live video and overlays share
  the camera's intrinsic aspect ratio, with percentage coordinates and mirrored x
  positions; no cropping or letterboxing offsets are introduced. Old-size results
  are discarded if the source resolution changes.

### Automated verification

```sh
cd /Users/paula/Documents/WikiWormhole/sdow
env/bin/python -m unittest discover -s tests -v
node scripts/test-camera.mjs
node scripts/test-tracking.mjs
cd website
export PATH="$PWD/../env/node/node_modules/node/bin:$PATH"
npm run build
npm run lint
```

The browser runner needs the Vite server, installed `env/browser-test` Puppeteer,
and Chrome at its standard macOS application path. It uses synthetic canvas video
and intercepted Gemini endpoints, so it sends no images to Google. Backend tests
use temporary quota databases and mocked generation. Tests cover permissions,
preview-only operation, schema gate, boxes, corrections, selection limits, expiry,
mirroring/resizing, hidden tabs, cadence, one in-flight request, quota failures,
late results, track cleanup, and the 50-frame ceiling.

### Results from this implementation session (2026-11-11)

- All 11 backend tests and the mocked Chrome camera suite passed, including device
  selection, release on camera changes, hidden-tab response rejection, selection
  limits, box expiry, and mirrored/responsive geometry.
- `npm run build` and `npm run lint` passed. SDOW health, both existing `1 → 6`
  routes (`1 → 4 → 6` and `1 → 5 → 6`), reverse no-path and invalid-title checks
  passed with Wikipedia metadata and search-history insertion mocked. Graph IDs
  were read from the current database; no graph or history data was changed.
- One real single-image request using the existing scones photo returned eight
  schema-valid boxes (cups, scones, spoon, bowl). The existing configured
  `gemini-3.1-flash-lite` key/model passed image-plus-box output validation.
- The physical **MacBook Air Camera** opened in the user's Chrome browser. Two
  sampled recognition calls completed successfully; Stop released the camera.
  This establishes the request flow, not a localization accuracy benchmark.
  Total live requests for this session: three, with no retries or fallback models.
- **iPhone remains unverified:** after the user made it ready, refreshing devices
  and reopening the camera still exposed only the MacBook Air Camera in Chrome.
  The user chose to finish with this limitation documented. The selector supports
  the iPhone when macOS exposes it; the app cannot establish Continuity Camera
  pairing itself. Follow the iPhone checklist above, including USB/Trust if needed.
- Both local servers are left running at ports 3000 and 5001. The real camera is
  stopped, and no automatic scanning is active.

### Faster recognition and local motion tracking follow-up

The model was already `gemini-3.1-flash-lite`; the main scheduling delay was the
12-second wait after every response. The new implementation uses the six-second
minimum between request starts, plus local appearance tracking in a Web Worker.
No new dependency, paid service, billing change, or Wikipedia integration was added.

Tracking uses sparse normalized grayscale patch correlation, pixel translation
search and small scale adjustments. It keeps the original appearance template to
limit gradual drift and suppresses boxes on low texture, poor matches, frame gaps
over 500 ms, resolution changes or recognition age over ten seconds. This is a
prototype for moderate motion, not robust semantic identity tracking. It may lose
fast-moving, rotating, occluded or similar-looking objects. A fresh Gemini result
replaces its candidates; local tracking cannot discover new objects by itself.

Verification: 14 backend tests, the full mocked-camera browser suite (including
actual moving canvas video through the worker with no additional API requests),
the deterministic motion/catch-up/loss tests, build and lint passed. One additional
live sample-photo call returned eight valid boxes in 2.97 seconds with the new
Flash-Lite options. This is one observed response time, not a latency guarantee or
a before/after model benchmark. The physical iPhone limitation above is unchanged.

Reload `/scan` after this update. Open the Mac webcam, Start scanning, and slowly
move a textured object once recognized. Check that its box follows, hides if the
object disappears, and reacquires on a new recognition result. Toggle mirroring and
resize the preview. Existing quota errors still stop capture and need manual restart.

## Specimen selection and Wikipedia paths (2026-11-11)

The Scan page was redesigned as a research workspace: **Fig. 1** live field of view,
**Table 1** detected objects, a **Specimens** panel (A = source, B = target), and a
result report with **Fig. 2** (path figure) and Tables 2–4.

### Choosing objects

- Click a box on the video to put it in the next free specimen slot; click it again
  to release it. With both slots full, a third click only explains how to replace one;
  it never silently changes an endpoint. **Set A / Set B** in Table 1 replaces explicitly.
- When exactly two objects are tracked and no choice has been made, they are suggested
  as A and B automatically (visible before tracing; Swap or click to change).
- Each specimen keeps an in-memory camera crop (never uploaded or stored), an editable
  name, and a Wikipedia article picker. Names resolve via exact title plus search;
  disambiguation pages are listed but never chosen by default.
- Typing names directly into the slots works with no camera or Gemini key.
- Markers stay on the same object when a new sample renames its box (same label, best
  overlap).

### Tracing (`POST /wiki/connect`, `GET /wiki/resolve`)

The SDOW SQLite graph is still the 35-page mock, so `sdow/wikipath.py` searches live
English Wikipedia with the MediaWiki Action API (local-only blueprint, like `/vision`):

1. Resolve both titles (redirects followed) and fetch A's and B's outgoing article links
   (redirect-resolved) and B's backlinks (including links through redirects).
2. **Direct** link, else **two-step** paths `A → X → B`. If B has too many backlinks,
   A's links are checked against B and its redirects with `pltitles`, so two-step
   search is still exact when every list completes.
3. Otherwise a **bounded three-step** search: A's links are checked against the 50–150
   most prominent pages linking to B (CirrusSearch `linksto:`), and each `Y → B` edge is
   re-verified directly. Three-step paths are labelled shortest only when two-step
   search was exhaustive; failures say "not found within this search limit".
4. **Shared topics** `A → X ← B` are shown separately and labelled as not a directed
   path. Citation artifacts (identifiers, publishers, disambiguation pages) rank last.

Budget: 70 upstream requests and 20 seconds per trace, two concurrent requests, one
polite retry on HTTP 429, `maxlag=5`, and a one-hour in-memory response cache. Set
`WIKIMEDIA_USER_AGENT` to add contact details per Wikimedia's policy. Tracing pauses
Gemini recognition but keeps the preview; **Scan again** resumes it.

Observed live (one run each, cold cache): Pencil → Lithium 2 steps, 9 paths, 15
requests, 1.0 s; Coin → Banana 2 steps, 23 requests, 1.2 s; Laptop → Water bottle and
Banana → Coin 3 steps (provably shortest), 1.0–2.3 s; Spoon → Stapler 3 steps. Running
many traces back-to-back without the cache triggered Wikipedia rate limiting once.

Tests: `env/bin/python -m unittest discover -s tests` (fake MediaWiki graph, no network)
and `node scripts/test-camera.mjs` (click-to-select, swap, correction, automatic pair,
typed fallback, tracing with paused recognition, path/shared views, reverse, rescan).
