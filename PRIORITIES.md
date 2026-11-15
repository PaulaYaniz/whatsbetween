# What's Between: priorities

Updated November 15, 2026. This replaces `HANDOFF.md`. Owners: **You** = Paula, in a dashboard. **Agent** = can be done from the CLI.

## Where things stand

- Works locally, end to end: photo recognition (Gemini), shared topics and routes (full SDOW graph, Dec 2023, served by `sdow/graph_service.py` on port 8788), explanations, Dig deeper (Deep Agents), Wolfram, saving to Atlas.
- Public via a free named Cloudflare Tunnel from this Mac at `https://whatsbetween.us` and `https://www.whatsbetween.us`. Cloudflare authoritative nameservers are active; older resolver caches may still return Porkbun during propagation.
- The SDOW download is finished and validated (13.5 GB at `data/sdow-20231220/sdow.sqlite`). The launchd job is gone. Don't download it again, and don't reset `transfer-ledger.json`.
- LangChain is used in one place: Dig deeper (`src/worker/research.ts`). MongoDB stores saved investigations and a daily AI counter (`store.ts`, `budget.ts`). Both are real but light.

## 1. Free demo from this Mac at whatsbetween.us (current plan)

The app, the graph service and the secrets all stay on the Mac. A free Cloudflare Tunnel puts it on the internet over HTTPS (needed for the phone camera). This avoids a server, Workers plan limits, Atlas network changes and moving secrets. Tradeoff: the site is only up while the Mac is awake, online and running `scripts/demo.sh`.

**Verified November 15** through a temporary tunnel: page loads, HTTPS secure context (camera allowed), session cookie, recognition/saving/Wolfram all available, article search, and a shared-topics request (POST) all worked from the public address. The origin check passes with no code changes.

**Changed:** `website/vite.config.js` now allows `whatsbetween.us`, `www.whatsbetween.us` and `*.trycloudflare.com` in `preview.allowedHosts`; Vite blocked the tunnel without it. Also added `scripts/demo.sh` and installed `cloudflared` (Homebrew).

**Abuse limits while public** (already in the code): 120 requests/min and 30 AI requests/min per session, plus 200 AI calls per day overall (`budget.ts`, `DAILY_MODEL_LIMIT`).

### Setup completed November 15

Named tunnel `whatsbetween` created; apex and www DNS routes installed. Local configuration: `~/.cloudflared/whatsbetween.yml`. Named tunnel is running. HTTPS and session API return 200 directly through Cloudflare; cached Porkbun DNS may take time to expire. Future demo starts use `scripts/demo.sh`.

### Original setup steps (completed)

1. **You:** Stop the old preview still running on port 3000 (it serves an outdated build). Then `scripts/demo.sh --quick` gives a working temporary `https://….trycloudflare.com` address right away.
2. **You:** Cloudflare dashboard → Add a domain → `whatsbetween.us` → **Free** plan. Cloudflare shows two nameservers.
3. **You:** Porkbun → Domain Management → `whatsbetween.us` → Details. Turn off DNSSEC if it's on. Under Authoritative Nameservers, replace Porkbun's with Cloudflare's two. Wait until Cloudflare marks the domain **Active** (often under an hour, up to 48 h). Delete any parking A/CNAME records it imported for `whatsbetween.us` and `www`.
4. **You** (opens a browser): `cloudflared tunnel login`, then pick `whatsbetween.us`.
5. **Agent:**
   - `cloudflared tunnel create whatsbetween`
   - `cloudflared tunnel route dns whatsbetween whatsbetween.us`
   - `cloudflared tunnel route dns whatsbetween www.whatsbetween.us`
   - Write `~/.cloudflared/whatsbetween.yml` with `tunnel: whatsbetween`, `credentials-file: <the json it created>`, and ingress `whatsbetween.us` and `www.whatsbetween.us` → `http://127.0.0.1:3000`, plus a final `http_status:404` rule.
6. **Demo day:** run `scripts/demo.sh`, keep the Mac plugged in with the lid open (or use a display), and test on your phone over cellular before presenting. Ctrl-C takes the site down.

### Later, only if it must stay up without the Mac (not free)

Put the Worker on Cloudflare and the graph on a ~$12–24/mo droplet behind the same tunnel. Before that:
- Fix the database name mismatch: `wrangler.jsonc:18` and `store.ts:27` say `whatsbetween`, but `.dev.vars` uses `wikiwormhole`.
- Add a shared-secret header on graph calls (`wiki.ts:119`, `wiki.ts:292`) and loosen those 3 s / 8 s timeouts.
- Allow `0.0.0.0/0` in Atlas, using a least-privilege user.
- Run `wrangler secret put` for each secret.
- Make sure the account is on Workers Paid. The free plan's 10 ms CPU limit won't run Dig deeper.

## 2. Deepen what already exists (no new features)

- [x] **Server-authoritative follow-up history:** research loads the latest three saved question/answer pairs from session-owned Mongo runs. Browser history is ignored; older and unsaved investigations start without prior-turn context.
- [ ] **Recognition and discovery cards call Gemini over raw REST** (`gemini.ts`), outside LangChain. Moving them to `ChatGoogleGenerativeAI.withStructuredOutput(zod)` puts every model call on one stack with the same retries, timeouts and validation. Images go in as `image_url` data URLs; keep `maxRetries` low.
- [ ] **Make the existing agent easier to see:** LangSmith tracing of Dig deeper (agent, calculator, fact-checker, to-do plan). Needs `LANGSMITH_*` secrets and `awaitAllCallbacks()`. Hide recognition inputs so photos aren't sent to LangSmith.
- [x] **Mongo hygiene:** BSON Date timestamps, ISO API summaries, and 30-day run expiration. Existing Atlas dates migrated; saved investigations/findings/evidence do not expire. Migration and live save/concurrency checks passed.
- [ ] If a LangChain MongoDB package is added: both pin `mongodb ^6`, while the app uses v7, so add `"overrides": {"mongodb": "$mongodb"}`. Atlas M0 allows 3 search/vector indexes in total.

Not now, since they're new features: vector "similar connections", a popular-connections page, agent long-term memory, and resumable checkpoints.

## 3. Known problems to fix

- [x] Discovery supplies the candidate ID in the prompt and constrains it in the response schema; regression checked.
- [x] `read_wikipedia` returns the stored evidence ID to the model; regression checked.
- [x] Saving: research from an unsaved connection creates a Mongo investigation; answers are persisted server-side, discovery cards use signed save tokens, and version allocation uses atomic increments. Verified concurrent writes and ownership against Atlas; 28 targeted tests pass.
- [ ] Shared-topic ranking still surfaces generic topics.
- [ ] Object crops are passed between pages but not shown as the PRD sketch specifies.
- [x] Camera timeout handling: recognition retries include response-body reads and respect cancellation; browser recognition has a 30 s deadline. Retry/cancellation regression tests pass. Paula confirmed the full HTTPS flow over cellular: camera, scan, connection, research before Save, saved-answer reload and follow-up (Nov 15). Intermittent upstream overload can still return a retry message.
- [x] Dependency review: production audit is clean; all 4 high findings resolved. Full audit has 7 moderate findings in development-only TypeScript ESLint/minimatch. See `docs/dependency-review.md`.
- [ ] Prettier reports 12 unformatted files (`npm run format`).
- [x] Legacy UI archived in `website/legacy-src/`; D3, lodash, styled-components, react-autosuggest, react-modal and their typings removed. Legacy blog URLs redirect to About.
- [x] `docs/deep-agents-atlas.md` updated for current research limits, Mac/tunnel deployment, Gemini project, saving and Mongo retention.

## Reference

**Run locally**
1. Graph: from `sdow/`, run `env/bin/python -m sdow.graph_service --db data/sdow-20231220/sdow.sqlite --port 8788` (health check: `/health`).
2. App: in `website/`, run `npm run serve`, which builds and previews at http://127.0.0.1:3000. Or run `scripts/demo.sh`, which does steps 1–2 and opens the tunnel.
- After every build, restart the preview. A running `vite preview` with the Cloudflare plugin serves new bundle files as HTML, which gives a blank page.
- `npm run dev` fails on a MongoDB `punycode/` import. Use the built preview.
- The package pins Node 24.16; Node 26 also builds.

**Secrets (never commit, print or paste anywhere)**
- `website/.dev.vars` (mode 0600) holds `GEMINI_API_KEY`, `GEMINI_MODEL`, `SESSION_SECRET`, `MONGODB_URI`, `MONGODB_DATABASE`, `GRAPH_SERVICE_URL` and `WOLFRAM_APP_ID`.
- `../atlas-credentials.env` holds Atlas credentials.

**Accounts**
- Gemini now uses Google Cloud project **worm** (`gen-lang-client-0890048036`), migrated and live-tested November 15. Previous Gemini project `gen-lang-client-0100636335` (**object-reccognition**) remains intact for rollback; the app no longer uses its key. Both had billing disabled at migration.
- Atlas cluster `worm` is on the FREE tier.
- Google Cloud project `wiki-wormhole` was used once for the SDOW download. Paula's cap was $2; estimated spend is about $0.46.

**Rules from Paula**
- Ask before deploying, creating paid resources, or upgrading any account. Free options first.
- Deepen and fix what exists; no new features unless strictly necessary (Nov 15).
- Don't reset, clean or bulk-commit the working tree. It has a lot of uncommitted work.
- Keep the SDOW MIT notice and credit.
