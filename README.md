# What’s Between…?

**Turn curiosity about your surroundings into discovery.**

What do a banana and a shoe have in common? What about a computer and a jacket? What’s Between…? lets you begin with two everyday objects and explore the histories, materials, mechanisms, and ideas that connect them—even before you know what question to ask.

[Open the demo](https://whatsbetween.us)

## Explore, investigate, and return

1. **Notice:** Scan your surroundings or upload a photo. Gemini recognizes objects, and you choose or correct their article matches.
2. **Discover:** Explore shared topics and paths, then read explanations with linked sources.
3. **Investigate:** Ask a question with **Deep research**. Parallel investigators explore different perspectives, gather evidence, and feed separate verification, review, and synthesis stages.
4. **Continue:** Save investigations, inspect their evidence, and ask follow-up questions using research history loaded from the server.

## How it works

| Technology | Role |
| --- | --- |
| React, TypeScript, and Vite | Camera interface, object selection, interactive connection map, research progress, and saved investigations |
| Gemini API | Multimodal object recognition, discovery explanations, and research reasoning |
| LangChain Deep Agents | Parallel historical and design investigators, with conditional coordinator and specialist subagents |
| LangSmith | Tracing model calls, tools, investigator branches, and review stages |
| Wikipedia API | Article matching and retrieval of source passages |
| SDOW, Python, and SQLite | Wikipedia graph queries, shared topics, and bidirectional breadth-first path search |
| Wolfram Alpha | Optional calculations through a specialist research subagent |
| MongoDB Atlas | Investigations, versioned findings, supporting evidence, and research-run history |
| Cloudflare tooling | Worker-style TypeScript API runtime and public HTTPS access through Cloudflare Tunnel |

### Deep research

Two Deep Agents run in parallel: a **historical investigator** explores historical and cultural connections, while a **design investigator** explores mechanisms, functions, and design principles. Both use Wikipedia tools and return structured claims linked to collected evidence.

Separate model calls perform **citation verification**, **skeptical review**, and **final editing**. A conditional coordinator handles numerical questions or provides a fallback; it can delegate to calculator and fact-checker subagents. All agents do not run for every question, and time and request budgets limit each investigation.

The graph suggests leads to investigate. A hyperlink alone does not prove a causal or historical relationship, and model review does not guarantee factual accuracy. Sources remain available for users to inspect.

### Saved investigations

MongoDB Atlas stores selected articles, connection context, versioned findings, and evidence. Follow-up context is loaded from saved server records rather than trusting browser-submitted assistant messages.

Saved investigations, findings, and evidence have no automatic expiration. Research-run records expire after 30 days. Access is tied to a browser-session cookie; there are currently no accounts or cross-device synchronization, and losing that cookie removes access to the saved records. Camera images are sent to Gemini for recognition but are not saved in Atlas.

## Run locally

Use Node.js 24.16 and Python with the dependencies in `requirements.txt`. The graph database is approximately **13.5 GB** and is not included in this repository. See [data-source documentation](docs/data-source.md) for obtaining and preparing it.

From the repository root, prepare the Python environment:

```sh
python3 -m venv env
env/bin/pip install -r requirements.txt
```

Start the graph service in one terminal:

```sh
env/bin/python -m sdow.graph_service --db data/sdow-20231220/sdow.sqlite --port 8788
```

In another terminal, install the application and create its private configuration:

```sh
cd website
npm install
cp .dev.vars.example .dev.vars
```

Edit `website/.dev.vars` with your Gemini API key, MongoDB connection details, and a random session secret of at least 32 characters. Wolfram Alpha and LangSmith configuration are optional. The file is git-ignored; never commit credentials.

Then start the application:

```sh
npm run serve
```

Open **http://127.0.0.1:3000**. This command builds the app and starts its preview server. After source changes, stop and rerun it so both the build and the preview asset map are refreshed. A GitHub push does not update this running server.

## Demo deployment

The public demo currently uses **Cloudflare Tunnel** to reach an application and Python graph service running on a Mac. Availability depends on that computer remaining awake, online, and running both services. It is not yet an independent cloud deployment.

On macOS, with the database, environment, and `cloudflared` installed, `scripts/demo.sh` starts the demo using the configured named tunnel. `scripts/demo.sh --quick` uses a temporary HTTPS address instead. Stop any existing app on port 3000 before running the script.

The main deployment challenge is hosting the large SQLite graph and its Python query service alongside the application. Independent hosting with persistent storage is the next infrastructure priority.

## Attribution

Built on [Six Degrees of Wikipedia (SDOW)](https://github.com/jwngr/sdow), created by **Jacob Wenger** and released under the [MIT License](LICENSE). The repository retains inherited SDOW code and history. Its graph foundation is extended here with camera interaction, object recognition and selection, discovery explanations, Deep research, and persistent investigations.

The graph snapshot is from **December 2023**; article passages can be retrieved live. Wikipedia article text is contributed by Wikipedia editors under its applicable licenses, including [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
