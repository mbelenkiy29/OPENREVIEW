import {test} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {HttpModel,ModelFailure} from '../src/engine/model';
import {Embeddings} from '../src/engine/embeddings';
import {InferenceBudgetError,allowedModels,modelAllowed,type InferenceBilling} from '../src/inference-billing';
const request={task:'conversation',system:'Verify',input:{unicode:'💰'}};
test('model reserves UTF-8 request ceiling before fetch, settles receipt, and cached calls reserve nothing',async t=>{
 const events:string[]=[],cache=new Map<string,string>();let ceiling=0;
 const billing:InferenceBilling={async reserve(q){events.push('reserve');ceiling=q.inputTokenCeiling;assert.equal(q.outputTokenCeiling,6000);return 'r';},async settle(id,u){events.push('settle');assert.equal(id,'r');assert.deepEqual(u,{inputTokens:20,outputTokens:10});}};
 t.mock.method(globalThis,'fetch',async(_url:string,o:RequestInit)=>{events.push('fetch');assert.ok(ceiling>=Buffer.byteLength(String(o.body))+1024);return Response.json({choices:[{message:{content:'{"answer":"ok"}'}}],usage:{prompt_tokens:20,completion_tokens:10}});});
 const persist={get:async(k:string)=>cache.get(k)??null,set:async(k:string,v:string)=>{cache.set(k,v);}},model=new HttpModel({provider:'openai',apiKey:'fixture',model:'gpt-4.1'},persist,billing);
 await model.generate(request,z.object({answer:z.string()}));await model.generate(request,z.object({answer:z.string()}));assert.deepEqual(events,['reserve','fetch','settle']);
});
test('receipt storage failure retains reservation without repeating successful paid generation',async t=>{
 let sends=0;const billing:InferenceBilling={async reserve(){return 'r';},async settle(){throw Error('storage unavailable');}};
 t.mock.method(globalThis,'fetch',async()=>{sends++;return Response.json({choices:[{message:{content:'{"answer":"ok"}'}}],usage:{prompt_tokens:20,completion_tokens:10}});});
 assert.equal((await new HttpModel({provider:'openai',apiKey:'fixture',model:'gpt-4.1'},undefined,billing).generate(request,z.object({answer:z.string()}))).value.answer,'ok');assert.equal(sends,1);
});
test('budget refusal never sends a model or embedding request',async t=>{
 let sends=0;t.mock.method(globalThis,'fetch',async()=>{sends++;throw Error('must not send');});const billing:InferenceBilling={async reserve(){throw new InferenceBudgetError('exhausted');},async settle(){throw Error();}};
 await assert.rejects(new HttpModel({provider:'openai',apiKey:'fixture',model:'gpt-4.1'},undefined,billing).generate(request,z.object({answer:z.string()})),ModelFailure);
 const old=process.env.EMBEDDING_MODEL;process.env.EMBEDDING_MODEL='text-embedding-3-small';try{await assert.rejects(new Embeddings(billing).embed(['source']),InferenceBudgetError);}finally{if(old===undefined)delete process.env.EMBEDDING_MODEL;else process.env.EMBEDDING_MODEL=old;}assert.equal(sends,0);
});

test("workspace model list is the operator's priced models for the configured provider",()=>{
 const env={LLM_PROVIDER:'openrouter',INFERENCE_PRICES:JSON.stringify({'openrouter:openai/gpt-4.1':{input:2,output:8},'openrouter:openai/text-embedding-3-small':{input:0.02,output:0},'openai:gpt-4.1':{input:2,output:8}})};
 assert.deepEqual(allowedModels(env),[{model:'openai/gpt-4.1',input:2,output:8}]);
 assert.deepEqual(allowedModels({}),[],'no price table, no list');
 assert.deepEqual(allowedModels({INFERENCE_PRICES:'{bad'}),[],'a malformed table offers nothing');
 assert.equal(modelAllowed('anything',[]),true,'without a list any model name is accepted');
 assert.equal(modelAllowed('openai/gpt-4.1',allowedModels(env)),true);
 assert.equal(modelAllowed('openai/gpt-5',allowedModels(env)),false);
});
