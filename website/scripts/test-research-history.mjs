import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import ts from 'typescript';

const url = (code) => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
let code = ts.transpileModule(
  readFileSync(new URL('../src/worker/store.ts', import.meta.url), 'utf8'),
  {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}
).outputText;
code = code.replace(
  /from 'mongodb'/,
  "from '" +
    url(
      'export class MongoClient {async connect(){} db(){return globalThis.__historyDb} async close(){}}'
    ) +
    "'"
);
const {loadResearchHistory, appendFindingVersion} = await import(url(code));
test('history is owner-scoped, bounded and chronological; missing owners return null', async () => {
  let owned = true;
  const calls = [];
  globalThis.__historyDb = {
    collection(name) {
      return name === 'investigations'
        ? {
            async findOne(query) {
              assert.deepEqual(query, {id: 'id', ownerSessionId: 'owner'});
              return owned ? {} : null;
            },
          }
        : {
            find(query) {
              calls.push(query);
              return {
                sort(order) {
                  assert.deepEqual(order, {createdAt: -1, _id: -1});
                  return this;
                },
                limit(n) {
                  assert.equal(n, 3);
                  return this;
                },
                async toArray() {
                  return [
                    {question: 'new', answer: 'second'},
                    {question: 'old', answer: 'first'},
                  ];
                },
              };
            },
          };
    },
  };
  assert.deepEqual(await loadResearchHistory({MONGODB_URI: 'mock'}, 'owner', 'id'), [
    {role: 'user', content: 'old'},
    {role: 'assistant', content: 'first'},
    {role: 'user', content: 'new'},
    {role: 'assistant', content: 'second'},
  ]);
  assert.deepEqual(calls[0], {
    investigationId: 'id',
    ownerSessionId: 'owner',
    question: {$type: 'string'},
    answer: {$type: 'string'},
  });
  owned = false;
  assert.equal(await loadResearchHistory({MONGODB_URI: 'mock'}, 'owner', 'id'), null);
  assert.equal(calls.length, 1);
});

test('simultaneous saves allocate distinct server versions and cannot lower the counter', async () => {
  const record = {
    id: 'id',
    ownerSessionId: 'owner',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const findings = [];
  globalThis.__historyDb = {
    collection(name) {
      return {
        async createIndex() {},
        async findOneAndUpdate(query, update) {
          assert.equal(query.ownerSessionId, 'owner');
          assert.deepEqual(update, {$inc: {version: 1}});
          record.version++;
          return {...record};
        },
        async findOne() {
          return {...record};
        },
        async insertOne(item) {
          assert.ok(item.createdAt instanceof Date);
          if (name === 'runs') {
            assert.ok(item.expiresAt instanceof Date);
            assert.equal(item.expiresAt - item.createdAt, 30 * 86400_000);
          }
          if (name === 'findings') {
            if (item.version === 2) await new Promise((resolve) => setTimeout(resolve, 20));
            assert.ok(!findings.some((row) => row.version === item.version));
            findings.push(item);
          }
        },
        async updateOne(query, update) {
          assert.equal(update.$set.version, undefined);
        },
      };
    },
  };
  const finding = {
    status: 'Supported finding',
    finding: 'Answer',
    claims: [],
    uncertainty: '',
    followUp: '',
  };
  const run = {
    toolActions: [],
    durationMs: 1,
    requestCount: 1,
    modelCalls: 1,
    status: 'complete',
    question: 'Question',
    answer: 'Answer',
  };
  await Promise.all([
    appendFindingVersion({MONGODB_URI: 'mock'}, 'owner', 'id', finding, [], run),
    appendFindingVersion({MONGODB_URI: 'mock'}, 'owner', 'id', finding, [], run),
  ]);
  assert.deepEqual(findings.map((row) => row.version).sort(), [2, 3]);
  assert.equal(record.version, 3);
});
