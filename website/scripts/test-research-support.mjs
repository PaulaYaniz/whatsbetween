import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/worker/researchSupport.ts', import.meta.url), 'utf8');
const {outputText} = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}});
const {parseWolframResult, unsupportedNumbers, wolframSuggestions, RESEARCH_LIMITS, shouldSynthesize, parseResearchJson, selectResearchPassages, researchFailureMessage, cleanResearchText, normalizeResearchAnswer, validSuggestedQuestions, researchQuestions} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
test('reserves the fourth model call for synthesis, and closes research early for time/request headroom', () => {
  // The last model call is reserved for the answer editor.
  assert.equal(shouldSynthesize(RESEARCH_LIMITS.modelCalls - 1, 3, 1000), false);
  assert.equal(shouldSynthesize(RESEARCH_LIMITS.modelCalls, 3, 1000), true);
  assert.equal(shouldSynthesize(2, RESEARCH_LIMITS.requests - 2, 1000), true);
  assert.equal(shouldSynthesize(2, 2, RESEARCH_LIMITS.collectionMs), true);
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
 assert.ok(questions[0].includes('Headphones') && questions[0].includes('Jacket'));
 assert.match(questions[1],/Music/); assert.ok(!questions.some(question=>question.includes('surprising difference')));
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

test('suggested questions are short enough to read at a glance',()=>{
 for (const question of researchQuestions('Headphones','Jacket','Music')) assert.ok(question.length <= 90, question);
 const long=['Did a person, event, or cultural movement connect Paper and Bottle through Ampoule in history?', 'Do paper and bottles share a design problem?', 'Which documented event links these objects?'];
 assert.equal(validSuggestedQuestions(long),false);
});

test('suggestions investigate a causal premise instead of assuming it',()=>{
 const questions=researchQuestions('Headphones','Jacket','Trousers',['How did portable audio influence jacket pockets?', 'How does fashion connect these objects?', 'Is there a documented history of audio devices in clothing?']);
 assert.equal(questions[0],'Did portable audio influence jacket pockets?');
 assert.equal(questions[1],'Does fashion connect these objects?');
});

test('Wolfram text answers are parsed into result, interpretation and units', () => {
  const text = 'Input interpretation:\n250 g × 4.184 J/(g K) × 80 K\n\nResult:\n83680 J (joules)\n\nWolfram|Alpha website result for x:\nhttps://www.wolframalpha.com/input?i=x';
  assert.deepEqual(parseWolframResult(text), {result: '83680 J (joules)', interpretation: '250 g × 4.184 J/(g K) × 80 K', units: 'joules'});
  assert.equal(wolframSuggestions('could not understand: x.\nThings to try instead:\nheat required\n250 grams'), 'heat required 250 grams');
});

test('numbers must come from the cited sources or the question', () => {
  // The bug this guards against: a calculation cited to articles that never mention it.
  assert.deepEqual(unsupportedNumbers('about 83,680 joules at 4.184 J/g°C', ['Coffee is a brewed drink.', 'Tea arrived in 1650.']), [83680, 4.184]);
  assert.deepEqual(unsupportedNumbers('about 83,680 joules', ['Result:\n83680 J (joules)']), []);
  assert.deepEqual(unsupportedNumbers('roughly 84,000 J', ['83680 J']), [], 'rounding within 2% is accepted');
  assert.deepEqual(unsupportedNumbers('heating 250 ml from 20 to 100 °C in 2 steps', ['heat 250 ml of water from 20 °C to 100 °C']), []);
  assert.deepEqual(unsupportedNumbers('tea reached Europe in 1610', ['Tea arrived in 1650.']), [1610]);
});
