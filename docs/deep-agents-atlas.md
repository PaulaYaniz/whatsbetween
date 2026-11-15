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

## Research tracing (optional)

Set these privately in `website/.dev.vars`:
```dotenv
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=<your LangSmith API key>
LANGSMITH_PROJECT=whatsbetween
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
```
Create a key in LangSmith Settings → API Keys. Never commit it or paste it in
chat. Restart with `npm run serve` after changing secrets. In LangSmith, open
the `whatsbetween` project and run Dig deeper to find the “Dig deeper” root,
research agent, tool/subagent calls and answer editor. Without both the flag
and key, no research traces are sent. Set the flag to false to disable.

Tracing is scoped to research, not recognition or discovery. Research questions,
source passages, tool outputs and generated answers are trace content; do not
use sensitive questions while enabled. The root receives no request/cookie/env.
Image blocks, image data URLs and credential fields are redacted before upload.
Callback and client queues are flushed at completion, with a bounded wait;
telemetry failures do not replace answers. See the [LangChain tracing guide](https://docs.langchain.com/langsmith/trace-with-langchain).

The LangSmith Codex tracing plugin is separate: its `LANGSMITH_CODEX_*`
settings trace coding sessions, not this application's research agent.

## Competing research team

Dig deeper now dispatches two isolated Deep Agents investigators through a
connection-researcher orchestration layer: historical/cultural and
design/mechanism. Each gets at most three model turns, the shared evidence
registry and bounded Wikipedia tools. One branch failing does not discard the
other branch's result. Zod validates handoffs and rejects unknown evidence IDs.

A skeptical-review layer invokes an isolated citation-verifier model context,
then reviews the competing claims. Its approved claims must be copied from
the proposals, with evidence IDs drawn from those proposals. The answer's
supporting claims are replaced with that approved list server-side; an empty
list forces insufficient evidence. One targeted reinvestigation and re-review
is permitted only with call, request and time headroom. Calculator delegation
remains conditional through the existing coordinator for numerical questions.
No recursive delegation is exposed to the investigator branches.

Limits remain 10 shared model calls, 10 research requests and 70 seconds total.
The new orchestration reserves the editor call and may end with insufficient
evidence rather than expanding the budget. Planning/handoffs are surfaced in
the activity feed and LangSmith. A live test on November 15 produced 40 trace
records, including both investigators, skeptical review, citation checking,
targeted reinvestigation, final review and answer editing; it returned
insufficient evidence with no approved claims. The temporary QA save was removed.
