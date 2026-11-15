import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const moduleUrl = source => 'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const wiki = moduleUrl(`export class RequestBudget {} export async function articleDetails(ids){return ids.map(id=>({article:{id,title:'Article '+id,url:'https://example.test/'+id},extract:'A source passage about the connection.',revisionId:'1'}));} export function discoveryEvidence(connection,candidateId){if(candidateId==='43')return null;return {topic:{title:'Music'},evidence:[{id:'wiki:1:2',sourceArticle:'Fixture',url:'https://example.test/source',excerpt:'Test source passage.'}]};}`);
const support = moduleUrl(compile('../src/worker/researchSupport.ts'));
const code=compile('../src/worker/gemini.ts').replace("from './wiki'",`from '${wiki}'`).replace("from './researchSupport'",`from '${support}'`);
const {createDiscoveryCard, recognizeFrame}=await import(moduleUrl(code));
const connection={source:{id:1,title:'Headphones'},target:{id:2,title:'Jacket'},path:{routes:[[{id:1,title:'Headphones'},{id:43,title:'Radio'},{id:2,title:'Jacket'}]]}};
const questions=['Did music subcultures connect headphones and jackets?', 'What comfort trade-off appears in both designs?', 'Which historical event could link these objects, and what evidence supports it?'];
const fixture=()=>({candidateId:'42',headline:'Explore a possible shared story',explanationSource:'This fixture contains a deliberately neutral explanation for checking the discovery response shape and its source references.',explanationTarget:'It adds enough text to exercise the existing card length check without presenting any historical claim as fact.',whyInteresting:'The questions invite further investigation rather than asserting an unsupported connection.',evidenceIds:['wiki:1:2'],suggestedQuestions:questions});
async function run(card,candidateId="42"){let requests=0;let sent;const original=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests++;sent=JSON.parse(init.body);return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(card)}]}}]});};try{return {response:await createDiscoveryCard({GEMINI_API_KEY:'fake'},connection,candidateId),requests,get sent(){return sent;}};}finally{globalThis.fetch=original;}}
test('generates three questions with the card in one model request',async()=>{
 const {response,requests,sent}=await run(fixture());
 assert.equal(response.status,'supported'); assert.equal(requests,1);
 assert.deepEqual(response.card.suggestedQuestions,questions);
 assert.equal(sent.generationConfig.responseSchema.properties.suggestedQuestions.maxItems,3);
 assert.match(sent.contents[0].parts[0].text,/Set "candidateId" to exactly 42/);
 assert.deepEqual(sent.generationConfig.responseSchema.properties.candidateId.enum,['42']);
 assert.deepEqual(sent.generationConfig.responseSchema.properties.evidenceIds.items.enum,['wiki:1:2']);
 assert.match(sent.systemInstruction.parts[0].text,/Phrase unverified possibilities as questions/);
});
test('bad question metadata falls back without discarding a usable card',async()=>{
 const {response}=await run({...fixture(),suggestedQuestions:['None']});
 assert.equal(response.status,'supported'); assert.equal(response.card.suggestedQuestions.length,3);
 assert.match(response.card.suggestedQuestions[0],/Headphones.*Jacket/);
});
test('new questions do not weaken citation validation',async()=>{
 const {response}=await run({...fixture(),evidenceIds:['made-up-source']});
 assert.equal(response.status,'unavailable'); assert.equal(response.reason,'invalid_model_response');
});

test('route stops get passage-backed explanations without a shared topic',async()=>{
 const {response}=await run({...fixture(),candidateId:'43',evidenceIds:['wiki:43:1','wiki:43:43']},'43');
 assert.equal(response.status,'supported');
 assert.equal(response.card.candidateId,'43');
});

test('recognition retries a timeout while reading the response body',async()=>{
 const original=globalThis.fetch; let calls=0;
 globalThis.fetch=async()=>{
   calls++;
   if(calls===1)return {text:async()=>{throw new DOMException('Timed out','TimeoutError');}};
   return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({objects:[{label:'mug',box_2d:[1,2,900,950]}]})}]}}]});
 };
 try{
   const result=await recognizeFrame({GEMINI_API_KEY:'fake'},'A'.repeat(100),'image/jpeg');
   assert.equal(calls,2); assert.equal(result.objects[0].label,'mug');
 }finally{globalThis.fetch=original;}
});
test('recognition cancellation does not retry',async()=>{
 const controller=new AbortController(); controller.abort();
 const original=globalThis.fetch; let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('Unexpected request');};
 try{
   await assert.rejects(recognizeFrame({GEMINI_API_KEY:'fake'},'A'.repeat(100),'image/jpeg',controller.signal),{name:'AbortError'});
   assert.equal(calls,0);
 }finally{globalThis.fetch=original;}
});
