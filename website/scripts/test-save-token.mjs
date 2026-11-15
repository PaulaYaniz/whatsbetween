import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../src/worker/session.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {signResult,readResult}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('signed discovery saves reject edited cards, other sessions and expiration',async()=>{
 const request=new Request('http://localhost/api/discover');
 const env={SESSION_SECRET:'test-only-secret'};
 const result={sessionId:'owner',expiresAt:Date.now()+60000,connection:{sharedTopics:[]},discoveryCard:{headline:'Original'}};
 const token=await signResult(request,env,result);
 assert.equal((await readResult(request,env,token,'owner')).discoveryCard.headline,'Original');
 const [payload,signature]=token.split('.');
 const edited=JSON.parse(Buffer.from(payload,'base64url').toString());
 edited.discoveryCard.headline='Forged';
 assert.equal(await readResult(request,env,Buffer.from(JSON.stringify(edited)).toString('base64url')+'.'+signature,'owner'),null);
 assert.equal(await readResult(request,env,token,'other'),null);
 assert.equal(await readResult(request,env,await signResult(request,env,{...result,expiresAt:Date.now()-1}),'owner'),null);
});
