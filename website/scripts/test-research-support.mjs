import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/worker/researchSupport.ts', import.meta.url), 'utf8');
const {outputText} = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}});
const {shouldSynthesize, parseResearchJson, selectResearchPassages, researchFailureMessage, cleanResearchText, normalizeResearchAnswer, validSuggestedQuestions, researchQuestions} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
test('reserves the fourth model call for synthesis, and closes research early for time/request headroom', () => {
  assert.equal(shouldSynthesize(3, 3, 1000), false);
  assert.equal(shouldSynthesize(4, 3, 1000), true);
  assert.equal(shouldSynthesize(2, 6, 1000), true);
  assert.equal(shouldSynthesize(2, 2, 30000), true);
});
test('historical research includes relevant later passages instead of only the lead', () => {
  const history = 'History\nThe first wireless headphones appeared in an early radio era.';
  const text = 'Headphones are audio devices.\n\n' + Array.from({length:100}, (_,i) => `Unrelated paragraph ${i}. ` + 'Other technical information. '.repeat(10)).join('\n\n') + '\n\n' + history;
  const result = selectResearchPassages(text, 'When did headphones start coming without cables?');
  assert.ok(result.includes(history));
  assert.ok(result.startsWith('Headphones are audio devices.'));
  assert.ok(result.length <= 10000);
});
test('handles JSON code fences without accepting malformed output', () => {
  assert.deepEqual(parseResearchJson('```json\n{"finding":"test"}\n```'), {finding:'test'});
  assert.throws(() => parseResearchJson('not valid JSON'));
});

test('provider outages give readable retry guidance without exposing raw API URLs', () => {
 const result = researchFailureMessage(new Error('[503] https://example.test/models/model:generateContent high demand'));
 assert.match(result, /busy right now/); assert.doesNotMatch(result, /https|generateContent/);
 assert.match(researchFailureMessage(new Error('Research exceeded 45 seconds.')), /ran out of time/);
});

test('legacy cards get three distinct investigable questions about the actual pair and topic',()=>{
 const questions=researchQuestions('Headphones','Jacket','Music');
 assert.equal(questions.length,3); assert.equal(new Set(questions).size,3);
 assert.ok(questions.every(question=>question.includes('Headphones') && question.includes('Jacket')));
 assert.match(questions[0],/Music/); assert.ok(!questions.some(question=>question.includes('surprising difference')));
});
test('validated generated questions are preserved; malformed and duplicate lists use contextual fallbacks',()=>{
 const generated=['Did music change how headphones and jackets signal identity?', 'Do headphones and jackets share a comfort-versus-protection trade-off?', 'Which documented event links these objects?'];
 assert.equal(validSuggestedQuestions(generated),true);
 assert.deepEqual(researchQuestions('Headphones','Jacket','Music',generated),generated);
 for (const bad of [undefined,[],['Same question?','Same question?','Same question?'],['short','short2','short3']]) {
   assert.equal(validSuggestedQuestions(bad),false);
   assert.equal(researchQuestions('Headphones','Jacket','Music',bad).length,3);
 }
});
test('placeholder cleanup hides empty fields but preserves substantive uncertainty',()=>{
 for(const value of ['None','None.','N/A','Not applicable',null,undefined,'']) assert.equal(cleanResearchText(value),'');
 assert.equal(cleanResearchText('None of the sources establish a date.'),'None of the sources establish a date.');
 const result=normalizeResearchAnswer({uncertainty:'None.',followUp:'None.'},'Which event connects the objects?');
 assert.equal(result.uncertainty,''); assert.equal(result.followUp,'Which event connects the objects?');
});

test('suggestions investigate a causal premise instead of assuming it',()=>{
 const questions=researchQuestions('Headphones','Jacket','Trousers',['How did portable audio influence jacket pockets?', 'How does fashion connect these objects?', 'Is there a documented history of audio devices in clothing?']);
 assert.equal(questions[0],'Did portable audio influence jacket pockets?');
 assert.equal(questions[1],'Does fashion connect these objects?');
});
