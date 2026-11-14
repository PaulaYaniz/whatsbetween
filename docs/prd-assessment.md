# PRD assessment — November 14, 2026

Basis: PRD v2.1, current source review, current local service checks, production build, eight Wikipedia tests, and eleven local graph-service tests. No new Gemini or Wolfram calls were made for this assessment. Prior successful recognition and Atlas checks are distinguished from current checks below.

## Overall judgment

A substantial local prototype exists, including real graph data, recognition, persisted investigations, and a research implementation. It has not yet demonstrated all PRD acceptance criteria. The biggest remaining work is reliable evidence-backed discoveries, complete research/version workflows, camera reliability, public hosting, and evaluation across varied pairs. A feature being present in code is not equivalent to an accepted end-to-end capability.

## Current evidence

- Full SDOW snapshot is downloaded and validated, per `data/sdow-20231220/download-status.json`: compressed MD5 verified, SQLite quick_check `ok`, 13,535,555,584-byte SQLite database, 17,509,363 page records including redirects, 6,777,987 link-table records, and 10,749,828 redirect records. Snapshot date: December 20, 2023.
- The local graph service is running on port 8788; `/health` reports ready and the correct snapshot.
- The running app uses that graph: coffee/tea `/api/connect` returned HTTP 200 in 890 ms, 12 shared topics, evidence arrays for those topics, and a one-hop path. This is one observed run, not a latency benchmark or factual-card evaluation.
- Production build passes; eight Wikipedia transport/cache tests and eleven graph-service tests pass.
- `/api/status` currently reports recognition, saving, and calculations configured. This establishes configuration, not successful provider execution.
- Earlier session checks verified Gemini recognition of the existing image fixture, Atlas save/list/reopen, and rejection of another session's investigation access. They did not establish the complete 15-pair evaluation or two-version follow-up workflow.
- The handoff file is stale: it still describes the graph download as incomplete, no graph integration, missing Wolfram credentials, and prompt/evidence-ID bugs that have since been changed. Prefer current code and status artifacts.

## Requirement coverage

| PRD area | Status | Remaining acceptance work |
| --- | --- | --- |
| Automatic recognition and selection | Partial | Main Scan page has camera, automatic sampling, boxes, candidate chips, corrections, upload and typed fallback. Add camera selection; enforce one request across automatic/manual/upload paths; back off on failures; discard stale results and expire old overlays. Verify actual iPhone 11/Continuity Camera. |
| Shared topics | Working locally, incomplete evaluation | Full-graph service is integrated and filters generic hubs. Evaluate arbitrary pairs, redirect handling, meaningful coverage, and snapshot/live-content differences. Explain truncation/filtering of topic lists rather than suggesting exhaustive results. |
| Directed paths | Added secondary feature | Local directed bidirectional search and a snapshot-labeled path strip exist; graph fixture tests pass. Benchmark difficult real pairs, deadline/cancellation behavior, and every displayed edge before broadly claiming shortest paths. |
| Discovery cards | Implemented, quality acceptance pending | Structured output, candidate IDs, evidence IDs and 40–80-word validation exist. Retrieval primarily uses lead excerpts, not reliably the passages around the shared topic. Ranking is mainly graph specificity, not semantic evidence quality. Evaluate each side's factual support and reject weak claims. |
| Deeper research | Implemented, acceptance pending | Actual Deep Agents JS tools, model budget and tool allowlist exist. Demonstrate adaptive tool choices in the target deployed runtime. Supply existing connection evidence and prior finding context, test deadline/cancel/quota cases, and persist useful partial evidence and stop reasons. |
| Wolfram | Configured; requirements incomplete | API response is read as text, but `units` is returned as an empty string. Preserve interpreted query, actual assumptions and units, and display them. Verify a relevant calculation plus unsupported, ambiguous and quota cases. |
| Saved investigations | Basic persistence previously verified; workflow partial | Version records exist, but there is no complete reopen-and-continue workflow or previous/current finding comparison. Fix save-after-unsaved-research, atomic version allocation, evidence provenance and failure consistency. Test two real versions and deletion. |
| Continued discovery and UI | Partial | Another topic, explore, back and scan again controls exist. Explore currently chooses which endpoint to replace automatically and searches immediately. Back restores only part of the previous result state. Add article summary panels and render actual selected-object thumbnails. |
| Privacy, sessions and usage | Partial | Server secrets, signed anonymous owner sessions, ownership checks, payload caps and rate bindings exist. Add the pre-camera frame-sharing notice, explicit retention/reset behavior, attribution/license details, and a verified shared Gemini project budget. Review database-user privileges. |
| Public Cloudflare deployment | Not accepted yet | Current verified app is localhost. A deployed Worker cannot reach the graph at the user's Mac loopback address. Choose and verify graph-service hosting/access and its budget before publishing; verify HTTPS camera permissions and full deployed agent flow. |
| Evaluation | Incomplete | Complete the PRD's preselected 15 varied pairs, including unfamiliar objects. Record recognition/corrections, meaningful-card coverage, unsupported claims, request/model counts, cold/cached timing, and source review. Existing fixture tests are valuable but do not replace this. |

## Concrete defects found in current source

1. **Graph results are still coupled to live evidence availability.** `website/src/worker/wiki.ts`, around lines 418–430: after obtaining a valid local graph result, most Wikipedia passage-fetch failures are rethrown. A throttle can therefore discard the useful graph response. Return the verified graph/path with a separate evidence-unavailable state, as required by the PRD.
2. **Saved page reads the wrong title shape.** `SavedPage.tsx`, around line 100, reads `selected.summary.source/target`, but `loadInvestigation()` returns source and target at the top level. The detail heading can omit the article titles.
3. **Save-after-research can fail to attach the result.** `DiscoverPage.tsx` updates React state with the new investigation ID, then calls `persistFinding`, whose closure still reads the previous state. Pass the created ID explicitly. Research evidence also needs a server-validated persistence route instead of trusting a browser-supplied finding alone.
4. **Version numbers are not allocated atomically.** `store.ts` reads `current.version + 1` before inserting and updating. Concurrent follow-ups can collide or leave incomplete writes. The unique index prevents duplicate version rows, but not an interrupted multi-collection save.
5. **Partial research isn't durably saved on all exit paths.** Several insufficient/catch branches in `research.ts` return partial evidence without appending a finding/run record. Stop reasons also aren't consistently populated for every request cap/abort.
6. **Camera one-request rule is not global to all entry points.** `ScanPage.tsx` has a local `busySample` flag for the automatic loop, separate from manual capture and photo upload. Those paths can overlap. Hidden tabs skip new samples but do not cancel in-flight responses; old boxes lack an age cutoff and may remain visible after failures.
7. **Snapshot provenance is incomplete in the shared-topic view.** PathStrip displays the snapshot; the shared-topic caption does not use `graphSnapshot`. Current article existence checks don't prove that a 2023 link still occurs in today's prose.
8. **Wolfram and research context need completion.** The computation tool emits empty units, and the research invocation starts with selected IDs and the question rather than the current evidence/card and prior-version context. A general tool loop exists, but this is not the full investigatory workflow specified in the PRD.

These are assessment findings only; application behavior was not edited during this review.

## Recommended order

1. **Make a dependable text-first discovery flow:** keep valid SDOW graph/path results through provider failures; gather relevant passages; rank and manually verify source-backed explanations for varied pairs.
2. **Finish research and persistence together:** prove the adaptive agent loop, calculations with units, partial saves, save-after-research, reopen/follow-up and two-version comparison. Keep cancellation and all budgets testable.
3. **Stabilize the main Scan/Discover experience:** one recognition request at a time, stale-overlay handling, device selector, privacy notice, selected thumbnails, explicit endpoint replacement and complete back state.
4. **Resolve production architecture:** select a reachable graph host within separately authorized allowances; verify Cloudflare deployment, provider secrets, runtime compatibility, ownership, retention and usage controls.
5. **Run the full 15-pair acceptance set and rehearse:** publish observed cold/cached results, source-review every displayed claim, exercise failure cases, then rehearse the two-minute demo.

Avoid spending the next iteration on more graph features, vector search, multi-agent features, or smooth tracking. The graph is now present; reliability and the quality of the discovery explanation are the higher-value remaining work.
