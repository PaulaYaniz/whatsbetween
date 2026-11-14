# WikiWormhole Cloudflare, Gemini, and Atlas setup

The WikiWormhole product UI and API run in a TypeScript Cloudflare Worker. Its
Deep Agents research loop uses Gemini and request-scoped Wikipedia tools. The
older Python/SQLite SDOW application remains a local graph experiment; it is not
the deployed WikiWormhole backend.

## Local Worker

For a working local preview, run `npm run serve` from `website/` and open
`http://127.0.0.1:3000`. This builds the app and runs the compiled Worker with
Vite preview. The startup script imports existing Gemini settings from the
Python prototype's ignored `sdow/.env.local` into ignored `website/.dev.vars`
when those settings are missing. Existing Worker settings take precedence.
It generates a private session secret once, and reports configuration status
without printing credentials. Add `MONGODB_URI` to `website/.dev.vars` to
enable Atlas saving, then restart `npm run serve`.

The development runner currently fails on a transitive MongoDB
CommonJS `punycode/` import; the compiled preview successfully serves the UI,
signed browser sessions, and live Wikipedia article search.

From `website/`, install the npm dependencies and copy `.dev.vars.example` to
`.dev.vars`. Fill in `GEMINI_API_KEY` and a random `SESSION_SECRET` to enable
anonymous sessions, discovery cards, and deeper research. Set `MONGODB_URI` to
an Atlas connection string to enable saving. The free Atlas tier is sufficient
for development; the MLH offer and account credits depend on eligibility and are
not prerequisites for testing the unsaved discovery flow.

Run `npm run dev` for the Vite/Cloudflare local runtime. Run `npm run build` to
check the static assets and Worker bundle. Wrangler serves the UI and Worker
routes from one origin. The app creates a signed, HttpOnly anonymous session
cookie; investigations are visible only to that session. Clearing browser
cookies starts a new session and does not transfer saved items.

## Optional integrations

- Gemini is required for object recognition, generated discovery cards, and
  adaptive research. Without a key, article search and shared-link discovery
  remain available, and the UI reports that generated explanations are off.
- MongoDB Atlas is required to save, reopen, version, and delete investigations.
  Without Atlas, those endpoints return a configuration error; results remain
  in the current page state and are not represented as saved.
- Wolfram Alpha is optional. Set `WOLFRAM_APP_ID` to enable one calculation per
  research run. When it is unset, the tool tells the agent no calculation was
  performed. This repository does not include an AppID or confirm an active
  account entitlement.

## Limits and deployment gates

Research is capped at four model calls, eight external research requests, one
Wolfram request, and 45 seconds per run. Image payloads are sent for recognition
only and are not written to Atlas. Wikipedia source excerpts, revision IDs,
finding versions, and bounded run records are stored when Atlas is configured.

Before a public deployment, add secrets with Wrangler, configure an Atlas
network access rule that permits the Cloudflare Worker, and verify a real
end-to-end run with the target accounts. Direct MongoDB connections from
Workers can add connection setup latency; measure Atlas operations under the
target deployment. Local checks on November 14, 2026 verified Gemini image
recognition and an Atlas database ping, plus investigation save, list, reopen,
evidence retrieval, and rejection of access from a different session through
the compiled Worker preview. Public Cloudflare deployment and a live Wolfram
calculation remain unverified.

## MongoDB Atlas account and billing

Create a free MongoDB account and select the free forever Atlas tier for an
initial prototype. The MLH page advertises $50 in Atlas credits through the
GitHub Student Developer Pack; eligibility and activation are handled by GitHub
and MongoDB. Credits are different from an Atlas subscription. Commercial
subscriptions may have monthly invoices, term commitments, prepaid credits, or
marketplace billing. Organization owners or billing admins manage subscription
activation and billing in Atlas. Do not add subscription activation codes or
billing details to this repository. See [MongoDB subscription management](https://www.mongodb.com/docs/atlas/billing/subscription/)
and the [MLH MongoDB offer](https://mlh.link/mongodb-benefits) for current terms.

## Upstream workshop

The dependency and runtime pattern is informed by the
[LangChain Deep Agents HackPrinceton workshop](https://github.com/langchain-samples/hack-princeton-intro-to-deep-agents).
This app uses the JavaScript Deep Agents package and its own bounded research
tools; it does not run the workshop's Python environment or copy its agent
configuration wholesale.
