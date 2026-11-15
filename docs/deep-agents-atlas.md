# What's Between: Gemini, Deep Agents and Atlas

The TypeScript API runs with the compiled Vite/Cloudflare preview on this Mac.
The full SDOW SQLite graph is served locally on port 8788 by
`sdow.graph_service`. A named Cloudflare Tunnel serves the app at
https://whatsbetween.us and https://www.whatsbetween.us.

## Running the demo

From `sdow/`, run `scripts/demo.sh`. It starts the graph service, builds and
serves the app on port 3000, keeps the Mac awake and opens the named tunnel.
Keep the Mac online and plugged in. Stop existing previews before starting.
For app-only work, run `npm run serve` in `website/`; restart preview after
every build. Use Node 24.16 (`.nvmrc`). The development runner has a Mongo
`punycode/` import issue; use compiled preview instead of `npm run dev`.

Secrets stay in ignored, mode-0600 `website/.dev.vars`. The local preview
script fills missing values from the older ignored `sdow/.env.local`.
Never print or commit credentials. Gemini uses project `worm`
(`gen-lang-client-0890048036`) and model `gemini-3.1-flash-lite`.
Gemini billing was disabled when verified November 15, 2026.

## Research and storage

Dig deeper uses Deep Agents, LangChain and request-scoped Wikipedia tools,
with calculator and fact-checker subagents. Recognition and discovery cards
still use Gemini REST directly. Wolfram is optional via `WOLFRAM_APP_ID`.

One research run is bounded by 10 model calls, 10 external research requests,
a 45-second collection phase and a 70-second total deadline. The final model
call and request/time headroom are reserved for synthesis. Model-backed HTTP
requests also share a Mongo daily counter (default 200); this is a request cap,
not an exact count of every provider call inside the agent.

Sessions use signed HttpOnly cookies. Investigations and history are scoped
to the owning session; clearing cookies does not transfer ownership.
Research on an unsaved connection creates an investigation when Atlas is
configured. Research answers are saved server-side; discovery saves use signed
card tokens. Concurrent writes allocate versions with an atomic increment.
Browsers cannot submit arbitrary finding text through the old finding endpoint.

Mongo stores investigation, finding and run timestamps as BSON Dates. Public
summary timestamps remain ISO strings. Research runs have a BSON `expiresAt`
and a single-field TTL index with `expireAfterSeconds: 0`; new runs expire after
30 days. TTL cleanup is asynchronous. Saved investigations, findings and
evidence do not expire. Follow-up context currently reads the latest three
question/answer pairs from runs, so that context expires with those runs.
Photos are used for recognition and are not saved to Atlas.

For existing databases, from `website/` run:
```sh
node scripts/migrate-mongo-dates.mjs          # preview counts
node scripts/migrate-mongo-dates.mjs --apply # convert dates and install TTL
```
The migration is idempotent, preserves unparseable strings and gives existing
run logs at least 30 days from migration before expiration. It does not delete
saved investigations. See [Mongo TTL behavior](https://www.mongodb.com/docs/manual/core/index-ttl/).

## Checks and deployment

Use `npm run build`, `node --test scripts/test-*.mjs`, and
`node scripts/check-save-atlas.mjs` for live temporary save/concurrency checks.
The latter cleans up its QA investigation. Phone-over-cellular scanning,
research before Save, saved-answer reload and follow-ups were confirmed
November 15, 2026. The named domain was also verified over normal DNS/HTTPS.

The current setup runs from the Mac, not a deployed Worker. Moving to hosted
Workers/graph infrastructure requires a separate deployment review, secret
configuration, Atlas connectivity checks and explicit approval for paid plans.
Never enable paid services or broaden Atlas network access as routine setup.
