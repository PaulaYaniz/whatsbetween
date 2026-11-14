import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/worker/wikiTransport.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
const {WikipediaTransport, RequestBudget, retryDelay} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const budget = (limit = 8, time = 10_000, signal) => new RequestBudget(limit, Date.now() + time, signal);
const ok = () => Response.json({query: {pages: [{pageid: 1}]}});

test('serializes overlapping callers across requests', async () => {
  let active = 0; let maximum = 0; let calls = 0;
  const transport = new WikipediaTransport(async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return ok();
  }, 0);
  await Promise.all([transport.request('https://example.test/a', budget()), transport.request('https://example.test/b', budget())]);
  assert.equal(calls, 2); assert.equal(maximum, 1);
});

test('429 retry waits and counts both attempts against the request budget', async () => {
  let calls = 0; const timestamps = [];
  const transport = new WikipediaTransport(async () => {
    calls++; timestamps.push(Date.now());
    return calls === 1 ? new Response('', {status: 429, headers: {'Retry-After': '0'}}) : ok();
  }, 0);
  const quota = budget(2, 5000);
  await transport.request('https://example.test/retry', quota);
  assert.equal(calls, 2); assert.equal(quota.used, 2);
  assert.ok(timestamps[1] - timestamps[0] >= 990);
});

test('honors a long retry delay across subsequent callers without extra fetches', async () => {
  let calls = 0;
  const transport = new WikipediaTransport(async () => {calls++; return new Response('', {status: 429, headers: {'Retry-After': '120'}});}, 0);
  await assert.rejects(transport.request('https://example.test/a', budget(8, 3000)), error => error.code === 'upstream_throttled' && error.retryAfterSeconds >= 119);
  await assert.rejects(transport.request('https://example.test/b', budget(8, 3000)), error => error.code === 'upstream_throttled');
  assert.equal(calls, 1);
});

test('does not retry beyond the external request cap', async () => {
  let calls = 0;
  const transport = new WikipediaTransport(async () => {calls++; return new Response('', {status: 429, headers: {'Retry-After': '0'}});}, 0);
  const quota = budget(1);
  await assert.rejects(transport.request('https://example.test/a', quota), error => error.code === 'upstream_throttled');
  assert.equal(calls, 1); assert.equal(quota.used, 1);
});

test('distinguishes maxlag errors in successful HTTP responses', async () => {
  const transport = new WikipediaTransport(async () => Response.json({error: {code: 'maxlag'}}, {headers: {'Retry-After': '120'}}), 0);
  await assert.rejects(transport.request('https://example.test/lag', budget(8, 3000)), error => error.code === 'upstream_busy');
});

test('cancelled callers never reach Wikipedia', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const transport = new WikipediaTransport(async () => {calls++; return ok();}, 0);
  await assert.rejects(transport.request('https://example.test/a', budget(8, 3000, controller.signal)), error => error.code === 'cancelled');
  assert.equal(calls, 0);
});

test('supports Retry-After seconds and HTTP dates', () => {
  const now = Date.parse('2026-11-14T00:00:00Z');
  assert.equal(retryDelay('12', now), 12_000);
  assert.equal(retryDelay('Sat, 14 Nov 2026 00:00:15 GMT', now), 15_000);
  assert.equal(retryDelay('invalid', now), 5000);
});

test('coalesces identical searches and reuses the result without more upstream calls', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({query: {pages: [{pageid: 604727, ns: 0, title: 'Coffee', fullurl: 'https://en.wikipedia.org/wiki/Coffee'}]}});
  };
  try {
    const transportUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
    const wikiSource = readFileSync(new URL('../src/worker/wiki.ts', import.meta.url), 'utf8');
    const wikiCompiled = ts.transpileModule(wikiSource, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText
      .replace(/(['"])\.\/wikiTransport\1/g, JSON.stringify(transportUrl));
    const {searchArticles} = await import(`data:text/javascript;base64,${Buffer.from(wikiCompiled).toString('base64')}`);
    const quotas = [budget(), budget(), budget()];
    const results = await Promise.all(quotas.map(quota => searchArticles('Coffee', quota)));
    assert.ok(results.every(result => result.best.id === 604727));
    assert.equal(calls, 1);
    assert.equal(quotas.reduce((sum, quota) => sum + quota.used, 0), 1);
    await searchArticles('Coffee', budget());
    assert.equal(calls, 1);
  } finally {globalThis.fetch = originalFetch;}
});

test('research requests article body without the API 1200-character/intro limits', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(new URL(input));
    return Response.json({query:{pages:[{pageid:191884,title:'Headphones',extract:'Introduction\n\nHistory\n' + 'Historical detail. '.repeat(200),revisions:[{revid:123}]}]}});
  };
  try {
    const transportUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
    const wikiCompiled = ts.transpileModule(readFileSync(new URL('../src/worker/wiki.ts', import.meta.url),'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/(['"])\.\/wikiTransport\1/g,JSON.stringify(transportUrl));
    const {articleDetails} = await import(`data:text/javascript;base64,${Buffer.from(wikiCompiled).toString('base64')}`);
    const result = await articleDetails([191884],budget(),true);
    assert.equal(requests[0].searchParams.has('exintro'),false);
    assert.equal(requests[0].searchParams.has('exchars'),false);
    assert.equal(requests[0].searchParams.get('exlimit'),'1');
    assert.ok(result[0].extract.length > 1200);
  } finally {globalThis.fetch=originalFetch;}
});
