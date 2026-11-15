import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

import ts from 'typescript';

const require = createRequire(import.meta.url);
let code = ts.transpileModule(
  readFileSync(new URL('../src/worker/researchTracing.ts', import.meta.url), 'utf8'),
  {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}
).outputText;
for (const name of [
  '@langchain/core/callbacks/promises',
  '@langchain/core/runnables',
  '@langchain/core/tracers/tracer_langchain',
  'langsmith',
]) {
  code = code.replaceAll(
    "from '" + name + "'",
    "from '" + pathToFileURL(require.resolve(name)).href + "'"
  );
}
const {tool} = require('@langchain/core/tools');
const {z} = require('zod');
const {redactTrace, traceResearch} = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);
test('redacts image content and credential fields while preserving research text', () => {
  const result = redactTrace({
    question: 'Why?',
    imageBase64: 'private-photo',
    nested: {
      apiKey: 'private-key',
      messages: [{type: 'image_url', image_url: {url: 'data:image/jpeg;base64,PHOTO'}}],
    },
    answer: 'See data:image/png;base64,PHOTO',
  });
  const text = JSON.stringify(result);
  assert.ok(!text.includes('private-photo'));
  assert.ok(!text.includes('private-key'));
  assert.ok(!text.includes('PHOTO'));
  assert.equal(result.question, 'Why?');
});
test('tracing requires explicit enablement and a key', async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    return 'answer';
  };
  assert.equal(await traceResearch({}, {}, run), 'answer');
  assert.equal(await traceResearch({LANGSMITH_TRACING: 'true'}, {}, run), 'answer');
  assert.equal(await traceResearch({LANGSMITH_API_KEY: 'unused'}, {}, run), 'answer');
  assert.equal(calls, 3);
});
test('enabled tracing uploads a redacted run and preserves its result', async () => {
  const original = globalThis.fetch;
  const uploads = [];
  globalThis.fetch = async (url, init) => {
    uploads.push({url: String(url), body: init?.body ? await new Response(init.body).text() : ''});
    return Response.json({version: '0.12.0', batch_ingest_config: {use_multipart_endpoint: false}});
  };
  try {
    const value = await traceResearch(
      {
        LANGSMITH_TRACING: 'true',
        LANGSMITH_API_KEY: 'fake-test-key',
        LANGSMITH_ENDPOINT: 'https://trace.example.test',
      },
      {question: 'test', imageBase64: 'private-photo'},
      async (_input, config) => {
        const calc = tool(async () => 'verified', {
          name: 'calculator_trace_fixture',
          description: 'Test nested tool tracing',
          schema: z.object({}),
        });
        await calc.invoke({}, config);
        return {answer: 'done'};
      }
    );
    assert.deepEqual(value, {answer: 'done'});
    assert.ok(uploads.length > 0);
    assert.ok(
      uploads.some((row) => String(row.body).includes('calculator_trace_fixture')),
      'nested tool should inherit the research trace'
    );
    assert.ok(uploads.every((row) => !String(row.body).includes('private-photo')));
  } finally {
    globalThis.fetch = original;
  }
});
