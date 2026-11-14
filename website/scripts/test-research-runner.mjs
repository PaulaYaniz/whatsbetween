import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const moduleUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const replacements = {
  '@langchain/core/messages': moduleUrl('export class HumanMessage {constructor(content){this.content=content;}} export class SystemMessage extends HumanMessage {}'),
  '@langchain/core/tools': moduleUrl('export const tool=(fn,config)=>({...config,invoke:fn});'),
  '@langchain/google-genai': moduleUrl(`export class ChatGoogleGenerativeAI {async invoke(messages){const s=globalThis.__researchTest; s.syntheses++; s.editor=messages[0].content; const input=JSON.parse(messages[1].content); s.summaryInput=input; return {content:JSON.stringify({insightType:s.noConnection?'no_verified_connection':'specific_difference',status:'Supported finding',finding:'Grounded answer',claims:[{claim:'A sourced fact',evidenceIds:[input.evidence[0].id]}],uncertainty:s.placeholders?'None.':'',followUp:s.placeholders?'None.':'Ask another question'})};}}`),
  deepagents: moduleUrl(`export function registerHarnessProfile(){} export function createDeepAgent(options){return {async invoke(input){const s=globalThis.__researchTest; s.input=input; s.prompt=options.systemPrompt; const middleware=options.middleware[0]; const read=options.tools.find(t=>t.name==='read_wikipedia'); for(let i=0;i<4;i++){await middleware.wrapModelCall({tools:options.tools,messages:[]},async request=>{s.collectionCalls++; if(s.searchMode){s.toolOffers.push(request.tools.map(tool=>tool.name)); if(i===0)await options.tools.find(tool=>tool.name==='search_wikipedia').invoke({query:'test query'}); else await read.invoke({article_id:99,section:'History'});} else await read.invoke({article_id:191884,section:'History'}); if(s.failCollection) throw new Error('Collection deadline'); return {};}); if(s.earlyAnswer)return {messages:[{content:'Definition-only draft'}]};} throw new Error('Should hand off before a fourth collection call');}};}`),
  langchain: moduleUrl('export const createMiddleware=config=>config;'),
  zod: pathToFileURL(require.resolve('zod')).href,
  './store': moduleUrl('export async function loadInvestigation(){} export async function appendFindingVersion(){throw new Error("Unexpected save")}'),
  './wiki': moduleUrl(`export class RequestBudget {used=0; actions=[]; constructor(limit,deadline,signal){Object.assign(this,{limit,deadline,signal});} take(){this.used++;}} export async function queryWiki(){return globalThis.__researchTest.searchMode?{query:{search:[{pageid:99,title:'Bridge article'}]}}:{};} export async function articleDetails(ids,budget,fullText){const s=globalThis.__researchTest; s.reads++; s.readIds.push(ids[0]); if(s.failId===ids[0])throw new Error("Source unavailable"); if(!fullText)throw new Error('Research must request article body'); return [{article:{id:ids[0],title:ids[0]===191884?'Headphones':'Jacket',url:'https://en.wikipedia.org/?curid='+ids[0]},extract:'History: wireless audio example.',revisionId:'123'}];}`),
  './researchSupport': moduleUrl(compile('../src/worker/researchSupport.ts')),
};
let code = compile('../src/worker/research.ts');
for(const [name,url] of Object.entries(replacements)) code=code.replaceAll(`from '${name}'`, `from '${url}'`);
const {investigate} = await import(moduleUrl(code));
function setup(failCollection=false){return globalThis.__researchTest={collectionCalls:0,syntheses:0,reads:0,readIds:[],toolOffers:[],failCollection};}
const input={question:'When did wireless headphones appear?',sourceId:191884,targetId:1,history:[{role:'user',content:'Tell me about headphones.'}]};
test('tool loops hand off to a grounded answer within four model calls; duplicate reads reuse article body',async()=>{
 const s=setup(); const events=[];
 const result=await investigate({GEMINI_API_KEY:'fake-test-key'},'test',input,e=>events.push(e),new AbortController().signal);
 assert.equal(result.status,'supported'); assert.equal(s.collectionCalls,3); assert.equal(s.syntheses,1); assert.equal(s.reads,2);
 assert.deepEqual(s.readIds,[191884,1]);
 assert.equal(result.evidence.length,2); assert.equal(s.summaryInput.question,input.question);
 assert.deepEqual(s.summaryInput.priorConversation,input.history);
 assert.ok(events.some(e=>e.message==='Writing an answer from the sources collected'));
 assert.equal(events.filter(e=>e.type==='result').length,1);
});
test('collection failure with sources still synthesizes instead of returning an empty partial result',async()=>{
 const s=setup(true);
 const result=await investigate({GEMINI_API_KEY:'fake-test-key'},'test',input,()=>{},new AbortController().signal);
 assert.equal(result.finding,'Grounded answer'); assert.equal(s.syntheses,1); assert.equal(s.collectionCalls,1);
});

test('normalizes empty model fields and supplies a concrete next question',async()=>{
 const s=setup(true); s.placeholders=true;
 const result=await investigate({GEMINI_API_KEY:'fake-test-key'},'test',{...input,sourceTitle:'Headphones',targetTitle:'Jacket',sharedTopic:'Clothing'},()=>{},new AbortController().signal);
 assert.equal(result.uncertainty,''); assert.notEqual(result.followUp,'None.');
 assert.match(result.followUp,/Headphones/); assert.match(result.followUp,/Jacket/);
 assert.match(s.prompt,/definitions alone are not a discovery/);
 assert.match(s.prompt,/Clothing/);
});
test('one unavailable initial article preserves the other source and can still synthesize',async()=>{
 const s=setup(true); s.failId=1;
 const result=await investigate({GEMINI_API_KEY:'fake-test-key'},'test',input,()=>{},new AbortController().signal);
 assert.equal(result.evidence.length,1); assert.equal(result.evidence[0].sourceArticle,'Headphones');
 assert.equal(s.syntheses,1);
});

test('an early agent answer still passes through the dedicated evidence editor',async()=>{
 const s=setup(); s.earlyAnswer=true;
 const result=await investigate({GEMINI_API_KEY:'fake'},'test',input,()=>{},new AbortController().signal);
 assert.equal(s.collectionCalls,1); assert.equal(s.syntheses,1);
 assert.match(s.editor,/where an object is worn are unacceptable/);
 assert.equal(result.finding,'Grounded answer');
});
test('an editor verdict of no verified connection cannot become supported or repeat definition claims',async()=>{
 const s=setup(); s.earlyAnswer=true; s.noConnection=true;
 const result=await investigate({GEMINI_API_KEY:'fake'},'test',input,()=>{},new AbortController().signal);
 assert.equal(result.status,'insufficient'); assert.deepEqual(result.claims,[]);
});

test('the selected shared-topic article is read before collection, without duplicate reads',async()=>{
 const s=setup(); s.earlyAnswer=true;
 const result=await investigate({GEMINI_API_KEY:'fake'},'test',{...input,sharedTopic:'Decaffeination',sharedTopicId:99},()=>{},new AbortController().signal);
 assert.deepEqual(s.readIds,[191884,1,99]); assert.equal(result.evidence.length,3);
 const sourceIds=s.summaryInput.evidence.map(item=>item.sourceArticleId);
 assert.ok(sourceIds.includes(99));
});

test('a search result must be read before another search is offered',async()=>{
 const s=setup(); s.searchMode=true;
 await investigate({GEMINI_API_KEY:'fake'},'test',input,()=>{},new AbortController().signal);
 assert.ok(s.toolOffers[0].includes('search_wikipedia'));
 assert.ok(!s.toolOffers[1].includes('search_wikipedia'));
 assert.ok(s.toolOffers[2].includes('search_wikipedia'));
 assert.ok(s.readIds.includes(99));
});
