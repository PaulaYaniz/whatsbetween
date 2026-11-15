import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';
const require=createRequire(import.meta.url);
let code=ts.transpileModule(readFileSync(new URL('../src/worker/store.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
code=code.replace("from 'mongodb'","from '"+pathToFileURL(require.resolve('mongodb')).href+"'");
const store=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const env=parseEnv(readFileSync(new URL('../.dev.vars',import.meta.url),'utf8'));
const owner='save-qa-'+crypto.randomUUID();
let id;
try{
 const connection={source:{id:1,title:'Save QA source',url:'https://example.test/1'},target:{id:2,title:'Save QA target',url:'https://example.test/2'},sharedTopics:[],evidenceByTopic:{}};
 const saved=await store.saveInvestigation(env,owner,connection,'Temporary save verification');
 id=saved.id;
 const finding={status:'Supported finding',finding:'QA answer',claims:[],uncertainty:'',followUp:''};
 const run={toolActions:[],durationMs:0,requestCount:0,modelCalls:0,status:'complete',question:'QA question',answer:'QA answer'};
 await Promise.all([store.appendFindingVersion(env,owner,id,finding,[],run),store.appendFindingVersion(env,owner,id,finding,[],run)]);
 const loaded=await store.loadInvestigation(env,owner,id);
 assert.deepEqual(loaded.findings.map(row=>row.version),[3,2]);
 assert.equal(loaded.version,3);
 assert.equal((await store.loadResearchHistory(env,owner,id)).length,4);
 assert.equal(await store.loadResearchHistory(env,owner+'other',id),null);
 console.log('Atlas save, concurrent append, reload, history and ownership checks passed.');
}finally{
 if(id) {await store.deleteInvestigation(env,owner,id);console.log('Temporary QA investigation removed.');}
}
