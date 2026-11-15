import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

import ts from 'typescript';

const require = createRequire(import.meta.url);
let code = ts.transpileModule(
  readFileSync(new URL('../src/worker/researchTeam.ts', import.meta.url), 'utf8'),
  {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}
).outputText;
for (const name of ['zod', '@langchain/core/runnables'])
  code = code.replaceAll(
    "from '" + name + "'",
    "from '" + pathToFileURL(require.resolve(name)).href + "'"
  );
const {runResearchTeam, parseTeamLead, parseTeamReview} = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);
const claim = {claim: 'Both share a documented mechanism', evidenceIds: ['wiki:1:2']};
const lead = (angle) => ({angle, claims: [claim], gaps: []});
test('rejects invented evidence and reviewer-invented claims', () => {
  assert.throws(() => parseTeamLead(lead('history'), 'history', new Set()));
  assert.throws(() =>
    parseTeamReview({approved: [{...claim, claim: 'Invented'}], rejected: [], retry: null}, [
      lead('history'),
    ])
  );
});
test('runs competing leads, verification and review with at most one retry', async () => {
  const calls = [];
  let reviews = 0;
  const result = await runResearchTeam({
    investigate: async (angle, question) => {
      calls.push([angle, question]);
      return lead(angle);
    },
    verify: async () => {
      calls.push(['verify']);
      return 'supported';
    },
    review: async () => ({
      approved: [claim],
      rejected: [],
      retry:
        ++reviews === 1
          ? {angle: 'history', question: 'Find a date'}
          : {angle: 'design', question: 'Must not run'},
    }),
    canRetry: () => true,
    activity: () => {},
  });
  assert.equal(result.retried, true);
  assert.equal(calls.filter((c) => ['history', 'design'].includes(c[0])).length, 3);
  assert.equal(reviews, 2);
  assert.deepEqual(calls[2], ['verify']);
});
test('failed investigator does not discard the other lead; exhausted budget forbids retry', async () => {
  const result = await runResearchTeam({
    investigate: async (angle) => {
      if (angle === 'history') throw Error('timeout');
      return lead(angle);
    },
    verify: async () => 'supported',
    review: async () => ({
      approved: [claim],
      rejected: [],
      retry: {angle: 'history', question: 'Retry'},
    }),
    canRetry: () => false,
    activity: () => {},
  });
  assert.equal(result.leads.length, 1);
  assert.equal(result.retried, false);
});
