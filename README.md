# What's Between

What's Between connects two everyday objects through Wikipedia. Scan a pair, pick the two articles, and see the shortest path between them through the Wikipedia link graph, with a short AI explanation grounded in the article text.

- Live site: https://whatsbetween.us (once deployed)
- Stack: React + Vite front end, Cloudflare Worker API, MongoDB Atlas for saved investigations, Gemini for recognition and explanations, optional Wolfram Alpha calculations.
- Path search uses a local snapshot of the Wikipedia link graph (December 2023). It is labelled with that date in the app.

## Development

```sh
cd website
npm install
npm run serve        # builds and previews at http://127.0.0.1:3000 with local secrets from ../.dev.vars
```

Secrets live in `website/.dev.vars` (git-ignored). See `website/.dev.vars.example` for names only.

The graph service (`graph_service.py`, Python) serves the link graph from a local SQLite file that is not included in the repository. Build it from the Wikipedia link dump described in `docs/data-source.md`.

## Attribution

What's Between is built on [Six Degrees of Wikipedia](https://github.com/jwngr/sdow) by Jacob Wenger, released under the MIT License. See `LICENSE`.
