import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/components/wikiwormhole/articleMatch.ts', import.meta.url), 'utf8'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext},
}).outputText;
const {closestArticle, rankArticleMatches} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const article = (id, title, extra = {}) => ({id, title, url: `https://en.wikipedia.org/?curid=${id}`, ...extra});

test('prefers the detected label over a more popular longer title', () => {
  assert.equal(closestArticle('apple', [article(1, 'Apple Inc.'), article(2, 'Apple'), article(3, 'Apple Records')]).id, 2);
});
test('handles case, accents, underscores and punctuation', () => {
  assert.equal(closestArticle('cafe_cup', [article(1, 'Coffee'), article(2, 'Café cup')]).id, 2);
});
test('prefers the simple plural match to unrelated alternatives', () => {
  assert.equal(closestArticle('bottles', [article(1, 'Bottle cap'), article(2, 'Bottle'), article(3, 'Bottles and Extras')]).id, 2);
});
test('does not automatically select a disambiguation page', () => {
  assert.equal(closestArticle('cup', [article(1, 'Cup', {disambiguation: true}), article(2, 'Cup (vessel)'), article(3, 'Cup (disambiguation)')]).id, 2);
  assert.equal(closestArticle('cup', [article(1, 'Cup', {disambiguation: true})]), null);
});
test('keeps alternatives available and removes duplicate article IDs', () => {
  const ranked = rankArticleMatches('phone', [article(1, 'Phone booth'), article(2, 'Phone'), article(1, 'Phone booth')]);
  assert.deepEqual(ranked.map(value => value.id), [2, 1]);
  assert.equal(closestArticle('phone', []), null);
});
