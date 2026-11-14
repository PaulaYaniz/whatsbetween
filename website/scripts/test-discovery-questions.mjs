import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const moduleUrl = source => 'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const wiki = moduleUrl(`export function discoveryEvidence(){return {topic:{title:'Music'},evidence:[{id:'wiki:1:2',sourceArticle:'Fixture',url:'https://example.test/source',excerpt:'Test source passage.'}]};}`);
const support = moduleUrl(compile('../src/worker/researchSupport.ts'));
const code=compile('../src/worker/gemini.ts').replace("from './wiki'",`from '${wiki}'`).replace("from './researchSupport'",`from '${support}'`);
const {createDiscoveryCard}=await import(moduleUrl(code));
const connection={source:{id:1,title:'Headphones'},target:{id:2,title:'Jacket'}};
const questions=['Did music subcultures connect headphones and jackets?', 'What comfort trade-off appears in both designs?', 'Which historical event could link these objects, and what evidence supports it?'];
const fixture=()=>({candidateId:'42',headline:'Explore a possible shared story',explanationSource:'This fixture contains a deliberately neutral explanation for checking the discovery response shape and its source references.',explanationTarget:'It adds enough text to exercise the existing card length check without presenting any historical claim as fact.',whyInteresting:'The questions invite further investigation rather than asserting an unsupported connection.',evidenceIds:['wiki:1:2'],suggestedQuestions:questions});
async function run(card){let requests=0;let sent;const original=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests++;sent=JSON.parse(init.body);return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(card)}]}}]});};try{return {response:await createDiscoveryCard({GEMINI_API_KEY:'fake'},connection,'42'),requests,get sent(){return sent;}};}finally{globalThis.fetch=original;}}
test('generates three questions with the card in one model request',async()=>{
 const {response,requests,sent}=await run(fixture());
 assert.equal(response.status,'supported'); assert.equal(requests,1);
 assert.deepEqual(response.card.suggestedQuestions,questions);
 assert.equal(sent.generationConfig.responseSchema.properties.suggestedQuestions.maxItems,3);
 assert.match(sent.systemInstruction.parts[0].text,/Phrase unverified possibilities as questions/);
});
test('bad question metadata falls back without discarding a usable card',async()=>{
 const {response}=await run({...fixture(),suggestedQuestions:['None']});
 assert.equal(response.status,'supported'); assert.equal(response.card.suggestedQuestions.length,3);
 assert.match(response.card.suggestedQuestions[0],/Headphones.*Jacket.*Music/);
});
test('new questions do not weaken citation validation',async()=>{
 const {response}=await run({...fixture(),evidenceIds:['made-up-source']});
 assert.equal(response.status,'unavailable'); assert.equal(response.reason,'invalid_model_response');
});
