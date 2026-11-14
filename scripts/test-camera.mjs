// All camera frames, recognition and Wikipedia responses are mocked. No Gemini or Wikipedia calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require = createRequire(new URL('../env/browser-test/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--no-sandbox'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const OBJECTS=[{label:'coin',box_2d:[100,200,500,600]},{label:'cup',box_2d:[300,650,800,900]},{label:'book',box_2d:[500,10,900,200]}];
async function scenario({configured=true, verified=true, denied=false, quota=false, slow=false, objects=OBJECTS}={}) {
  const page = await browser.newPage();
  const errors=[];
  page.on('pageerror', error=>errors.push(error.message));
  let requests=0, inFlight=0, maxFlight=0, stopCalls=0;
  const connects=[];
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    const path = url.pathname;
    if (/^\/wiki\//.test(path)) return wiki(request, url);
    if (!/^\/vision\/(status|sessions|recognize)/.test(path)) return request.continue();
    const headers = {'content-type':'application/json', 'access-control-allow-origin':'http://127.0.0.1:3000',
      'access-control-allow-headers':'Content-Type', 'access-control-allow-methods':'GET,POST,OPTIONS'};
    const usage={configured,verified,model:'gemini-3.1-flash-lite',appDailyAttempts:requests,sessionAttempts:requests,intervalSeconds:6};
    let data={}, status=200;
    if (request.method()==='OPTIONS') return request.respond({status:204,headers});
    if (path.endsWith('/status')) data=usage;
    else if (path.endsWith('/sessions')) data={session:'test-session'};
    else if (path.endsWith('/stop')) { stopCalls++; data={stopped:true}; }
    else if (path.endsWith('/recognize')) {
      requests++; inFlight++; maxFlight=Math.max(maxFlight,inFlight);
      if (slow) await delay(800);
      data=quota ? {error:'Gemini quota exceeded. Recognition paused.'} : {objects,usage:{...usage,verified:true,appDailyAttempts:requests}};
      if(quota) status=429;
      inFlight--;
    }
    await request.respond({status, headers, body:JSON.stringify(data)});
  });
  const title=text=>text.trim().replace(/^./,c=>c.toUpperCase());
  const article=(text,id)=>({id,title:title(text),url:`https://en.wikipedia.org/wiki/${encodeURIComponent(title(text))}`,description:`Test article for ${text}`});
  async function wiki(request, url) {
    const headers={'content-type':'application/json','access-control-allow-origin':'http://127.0.0.1:3000',
      'access-control-allow-headers':'Content-Type','access-control-allow-methods':'GET,POST,OPTIONS'};
    if (request.method()==='OPTIONS') return request.respond({status:204,headers});
    let data;
    if (url.pathname==='/wiki/resolve') {
      const q=url.searchParams.get('q');
      const best=article(q,100+q.length);
      data={query:q,best,candidates:[best,{...article(`${q} (disambiguation)`,900),disambiguation:true}]};
    } else {
      const body=JSON.parse(request.postData());
      connects.push(body);
      const a=article(body.source,1), b=article(body.target,3);
      data={source:{...a,input:body.source,redirected:false},target:{...b,input:body.target,redirected:false},
        status:'found',paths:[[1,2,3],[1,5,3]],pathCount:2,degrees:2,shortest:true,exhaustive:true,method:'two_hop_exhaustive',
        sharedTopics:[2,4],genericTopics:[4],sharedComplete:true,
        linkCounts:{sourceOutgoing:120,sourceOutgoingComplete:true,targetOutgoing:80,targetOutgoingComplete:true,targetIncoming:900,targetIncomingComplete:true},
        pages:{1:a,2:article('copper',2),3:b,4:{...article('ISBN',4),description:undefined},5:article('metal',5)},
        retrievedAt:Date.now(),stats:{requests:9,cachedResponses:0,budgetExhausted:false,elapsedMs:812}};
    }
    await new Promise(resolve=>setTimeout(resolve,60));
    return request.respond({status:200,headers,body:JSON.stringify(data)});
  }
  await page.evaluateOnNewDocument((denied)=>{
    window.__tracks=[];
    window.__time=Date.now();
    Date.now=()=>window.__time;
    const interval=window.setInterval;
    window.setInterval=(callback, ms, ...args)=> {
      if(ms===250) {window.__sample=callback; return 123456;}
      if(ms===100) {window.__track=callback; return 123457;}
      return interval(callback,ms,...args);
    };
    Object.defineProperty(document,'hidden',{get:()=>Boolean(window.__hidden), configurable:true});
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async(constraints)=>{
      window.__constraints=constraints;
      if(denied) throw new DOMException('Denied','NotAllowedError');
      const canvas=document.createElement('canvas');
      canvas.width=1920;canvas.height=1080;
      const context=canvas.getContext('2d');
      const texture=context.createImageData(1920,1080);
      for(let y=0;y<1080;y++) for(let x=0;x<1920;x++) {
        const v=40+(((Math.floor(x/6)*137+Math.floor(y/6)*73+Math.floor(x/6)*Math.floor(y/6)*19)%180));
        const p=(y*1920+x)*4;texture.data[p]=v;texture.data[p+1]=v;texture.data[p+2]=v;texture.data[p+3]=255;
      }
      context.putImageData(texture,0,0);
      const source=document.createElement('canvas');source.width=1920;source.height=1080;
      source.getContext('2d').putImageData(texture,0,0);
      window.__move=(dx,dy)=>{context.clearRect(0,0,1920,1080);context.drawImage(source,dx,dy);};
      const stream=canvas.captureStream(5);
      window.__tracks.push(...stream.getTracks());
      return stream;
    }});
    Object.defineProperty(navigator.mediaDevices,'enumerateDevices',{value:async()=>[
      {kind:'videoinput',deviceId:'mac',label:'Mac webcam'},
      {kind:'videoinput',deviceId:'iphone',label:'iPhone Continuity Camera'}]});
  },denied);
  await page.goto('http://127.0.0.1:3000/scan');
  await page.waitForFunction(()=>!document.body.innerText.includes('Checking backend configuration'));
  const click=async text=>page.evaluate(text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text)?.click(),text);
  const tick=async(seconds=6.5)=>{await page.evaluate(seconds=>{window.__time+=seconds*1000;window.__sample?.();},seconds);await delay(120);};
  const slot=key=>page.$eval(`.ww-slot-${key} .ww-slot-input`,input=>input.value);
  const chosen=key=>page.$eval(`.ww-slot-${key} .ww-slot-article`,select=>select.selectedOptions[0]?.textContent||'');
  return {page,errors,click,tick,slot,article:chosen,connects,get requests(){return requests;}, get maxFlight(){return maxFlight;},get stopCalls(){return stopCalls;}};
}
try {
  const missing=await scenario({configured:false,verified:false});
  assert(await missing.page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Open camera'&&!b.disabled)));
  assert(await missing.page.evaluate(()=>document.body.innerText.includes('Add GEMINI_API_KEY')));
  await missing.page.close();
  const denied=await scenario({denied:true});
  await denied.click('Open camera');
  await denied.page.waitForFunction(()=>document.body.innerText.includes('permission denied'));
  assert.equal(denied.requests,0);
  await denied.page.close();
  const check=await scenario({verified:false});
  await (await check.page.$('input[type=file]')).uploadFile(fileURLToPath(new URL('../website/src/images/logo.png',import.meta.url)));
  await check.page.locator('summary').click();
  await check.click('Check one image');
  await check.page.waitForFunction(()=>document.body.innerText.includes('Single-image check passed'));
  assert.equal(check.requests,1);
  await check.page.close();
  const active=await scenario();
  await active.click('Open camera');
  await active.page.waitForFunction(()=>document.body.innerText.includes('Live preview only'));
  assert.equal(active.requests,0);
  await active.click('Start scanning');
  await active.page.waitForFunction(()=>!!window.__sample);
  await active.tick();
  await active.page.waitForSelector('input[maxlength="60"]');
  assert.equal(active.requests,1);
  await active.tick(1); assert.equal(active.requests,1);
  await active.page.$eval('input[maxlength="60"]',input=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'penny');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await active.tick(6.5);
  assert.equal(await active.page.$eval('input[maxlength="60"]',input=>input.value),'penny');
  await active.page.evaluate(()=>{window.__hidden=true;document.dispatchEvent(new Event('visibilitychange'));});
  const before=active.requests;
  await active.tick(10); assert.equal(active.requests,before);
  await active.page.evaluate(()=>{window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  await active.tick(6.5);
  await active.page.waitForSelector('.object-box');
  await active.page.screenshot({path:'/private/tmp/wikiwormhole-camera-desktop.png',fullPage:true});
  await active.page.setViewport({width:390,height:844});
  assert(await active.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await active.page.screenshot({path:'/private/tmp/wikiwormhole-camera-mobile.png',fullPage:true});
  // Click boxes to fill specimens A then B; a third click cannot silently replace either.
  await active.tick(6.5);
  await active.page.waitForSelector('.object-box');
  await active.page.click('button[aria-label="Select penny as a specimen"]');
  await active.page.click('button[aria-label="Select cup as a specimen"]');
  assert.equal(await active.slot('a'),'penny');
  assert.equal(await active.slot('b'),'cup');
  await active.page.click('button[aria-label="Select book as a specimen"]');
  await active.page.waitForFunction(()=>document.body.innerText.includes('Both specimens are set'));
  assert.equal(await active.slot('a'),'penny');
  assert.equal(await active.slot('b'),'cup');
  assert.equal(await active.page.$$eval('.object-box-a, .object-box-b',boxes=>boxes.length),2);
  // Mirror mapping and responsive bounds: raw x=[.2,.6], mirrored x=[.4,.8].
  await active.page.locator('input[type=checkbox]').click();
  const geometry=await active.page.evaluate(()=>{
    const v=document.querySelector('video').getBoundingClientRect();
    const b=document.querySelector('.object-box').getBoundingClientRect();
    return {left:(b.left-v.left)/v.width,width:b.width/v.width,top:(b.top-v.top)/v.height};
  });
  assert(Math.abs(geometry.left-.4)<.01);
  assert(Math.abs(geometry.width-.4)<.01);
  assert(Math.abs(geometry.top-.1)<.01);
  // Expire local boxes without dispatching another recognition request.
  await active.page.evaluate(()=>{window.__time+=11000;window.__track?.();});
  await delay(150);
  assert.equal(await active.page.$('.object-box'),null);
  await active.click('Stop');
  assert(await active.page.evaluate(()=>window.__tracks.every(t=>t.readyState==='ended')));
  const stopped=active.requests;
  await active.tick(10);assert.equal(active.requests,stopped);
  assert.equal(active.maxFlight,1);assert.equal(active.errors.length,0);
  await active.page.close();
  // Exercise the actual Web Worker and video pixels, without another API request.
  const moving=await scenario();
  await moving.click('Open camera');
  await moving.page.waitForFunction(()=>document.body.innerText.includes('Live preview only'));
  await moving.click('Start scanning');await moving.page.waitForFunction(()=>!!window.__sample);
  await moving.tick();await moving.page.waitForSelector('.object-box');
  const initialLeft=await moving.page.$eval('.object-box',box=>parseFloat(box.style.left));
  for(let i=1;i<=5;i++) {
    await moving.page.evaluate(i=>{window.__move(i*6,i*6);window.__time+=100;},i);
    await delay(220);
    await moving.page.evaluate(()=>window.__track());
    await delay(80);
  }
  const following=await moving.page.$('.object-box');
  assert(following, await moving.page.$eval('body',e=>e.innerText));
  const movedLeft=await moving.page.$eval('.object-box',box=>parseFloat(box.style.left));
  assert(Math.abs(movedLeft-initialLeft-30/1920*100)<.5,'worker boxes follow video motion');
  assert.equal(moving.requests,1,'local motion never calls Gemini');
  await moving.click('Stop');await moving.page.close();
  const switching=await scenario();
  await switching.click('Open camera');
  await switching.page.waitForFunction(()=>document.body.innerText.includes('Live preview only'));
  await switching.page.select('select[aria-label="Camera"]','iphone');
  assert(await switching.page.evaluate(()=>window.__tracks.every(t=>t.readyState==='ended')));
  await switching.click('Open camera');
  await switching.page.waitForFunction(()=>document.body.innerText.includes('Live preview only'));
  assert.equal(await switching.page.evaluate(()=>window.__constraints.video.deviceId.exact),'iphone');
  assert.equal(switching.requests,0);
  await switching.click('Stop');
  await switching.page.close();
  const hidden=await scenario({slow:true});
  await hidden.click('Open camera');
  await hidden.page.waitForFunction(()=>document.body.innerText.includes('Live preview only'));
  await hidden.click('Start scanning');await hidden.page.waitForFunction(()=>!!window.__sample);
  await hidden.tick();
  await hidden.page.evaluate(()=>{window.__hidden=true;document.dispatchEvent(new Event('visibilitychange'));window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  await delay(900);
  assert.equal(await hidden.page.$('.object-box'),null);
  await hidden.click('Stop');await hidden.page.close();
  const quota=await scenario({quota:true});
  await quota.click('Open camera');await quota.page.waitForFunction(()=>document.body.innerText.includes('Live preview only'));await quota.click('Start scanning');await quota.page.waitForFunction(()=>!!window.__sample);await quota.tick();
  await quota.page.waitForFunction(()=>document.body.innerText.includes('quota exceeded'));
  await quota.tick(20);assert.equal(quota.requests,1);
  assert(await quota.page.evaluate(()=>window.__tracks.every(t=>t.readyState==='ended')));
  await quota.page.close();
  const slow=await scenario({slow:true});
  await slow.click('Open camera');await slow.page.waitForFunction(()=>document.body.innerText.includes('Live preview only'));await slow.click('Start scanning');await slow.page.waitForFunction(()=>!!window.__sample);await slow.tick();
  await slow.tick(12);assert.equal(slow.requests,1);
  await slow.click('Stop');await delay(900);
  assert.equal(await slow.page.$('input[maxlength="60"]'),null);
  assert(await slow.page.evaluate(()=>window.__tracks.every(t=>t.readyState==='ended')));
  await slow.page.close();
  const limit=await scenario();
  await limit.click('Open camera');await limit.page.waitForFunction(()=>document.body.innerText.includes('Live preview only'));await limit.click('Start scanning');await limit.page.waitForFunction(()=>!!window.__sample);
  for(let i=0;i<50;i++) await limit.tick(7);
  await limit.page.waitForFunction(()=>document.body.innerText.includes('50-request session limit reached'));
  await limit.tick(10);assert.equal(limit.requests,50);
  assert(await limit.page.evaluate(()=>window.__tracks.every(t=>t.readyState==='ended')));
  await limit.page.close();
  // Selection, swapping and tracing the Wikipedia path. Recognition pauses during the trace.
  const traced=await scenario();
  await traced.click('Open camera');
  await traced.page.waitForFunction(()=>document.body.innerText.includes('Live preview only'));
  await traced.click('Start scanning');await traced.page.waitForFunction(()=>!!window.__sample);
  await traced.tick();await traced.page.waitForSelector('.object-box');
  assert.equal(await traced.slot('a'),'','three objects: no automatic pair');
  await traced.page.click('button[aria-label="Select coin as a specimen"]');
  await traced.page.click('button[aria-label="coin, specimen A. Activate to remove."]');
  assert.equal(await traced.slot('a'),'','clicking an assigned box releases it');
  await traced.page.click('button[aria-label="Set book as specimen B"]');
  await traced.page.click('button[aria-label="Set coin as specimen A"]');
  await traced.page.waitForFunction(()=>document.querySelector('.ww-slot-a .ww-slot-article').value!=='');
  assert.equal(await traced.article('a'),'Coin');
  assert(await traced.page.$eval('.ww-slot-a .ww-slot-thumb img',img=>img.src.startsWith('data:image/jpeg')),'in-memory crop');
  await traced.page.click('button[aria-label="Set cup as specimen A"]');
  assert.equal(await traced.slot('a'),'cup','explicit Set A replaces');
  await traced.page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Trace Wikipedia path'&&!b.disabled));
  await traced.click('⇅ Swap A and B');
  assert.equal(await traced.slot('a'),'book');
  // Manual correction of a specimen re-resolves its article.
  await traced.page.$eval('.ww-slot-b .ww-slot-input',input=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'teacup');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await traced.page.waitForFunction(()=>document.querySelector('.ww-slot-b .ww-slot-article').selectedOptions[0]?.textContent==='Teacup');
  const beforeTrace=traced.requests;
  await traced.click('Trace Wikipedia path');
  await traced.page.waitForSelector('.ww-report .ww-node');
  assert.deepEqual(traced.connects.at(-1),{source:'Book',target:'Teacup'});
  assert.deepEqual(await traced.page.$$eval('.ww-figure .ww-node-title',nodes=>nodes.map(n=>n.textContent)),['Book','Copper','Teacup']);
  assert(await traced.page.evaluate(()=>document.body.innerText.includes('Shortest path · verified')));
  assert(await traced.page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Start scanning')),'recognition paused');
  assert(await traced.page.evaluate(()=>window.__tracks.some(t=>t.readyState==='live')),'preview kept');
  await traced.tick(10);assert.equal(traced.requests,beforeTrace,'no frames sent while showing the result');
  await traced.page.screenshot({path:'/private/tmp/wikiwormhole-trace-desktop.png',fullPage:true});
  // Alternative path, then shared-topic view with its distinct label.
  await traced.page.click('.ww-path-list li:nth-child(2) button');
  assert.deepEqual(await traced.page.$$eval('.ww-figure .ww-node-title',nodes=>nodes.map(n=>n.textContent)),['Book','Metal','Teacup']);
  await traced.page.evaluate(()=>[...document.querySelectorAll('.ww-topics button')].find(b=>b.textContent==='Copper').click());
  await traced.page.waitForFunction(()=>document.querySelector('.ww-figure .ww-figcaption').textContent.includes('not a directed path'));
  assert(await traced.page.evaluate(()=>document.querySelector('.ww-topic-generic').textContent.includes('citation')));
  await traced.page.setViewport({width:390,height:844});
  assert(await traced.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow on mobile');
  await traced.page.screenshot({path:'/private/tmp/wikiwormhole-trace-mobile.png',fullPage:true});
  await traced.page.setViewport({width:1440,height:900});
  await traced.click('Reverse direction (B → A)');
  await traced.page.waitForFunction(()=>document.querySelector('.ww-report-title')?.textContent.includes('Teacup'));
  assert.deepEqual(traced.connects.at(-1),{source:'Teacup',target:'Book'});
  await traced.click('Scan again');
  await traced.page.waitForFunction(()=>!document.querySelector('.ww-report'));
  await traced.page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Pause scanning'));
  assert.equal(traced.errors.length,0,traced.errors.join('\n'));
  await traced.click('Stop');await traced.page.close();
  // Exactly two visible objects: suggest them as A and B automatically.
  const pair=await scenario({objects:OBJECTS.slice(0,2)});
  await pair.click('Open camera');
  await pair.page.waitForFunction(()=>document.body.innerText.includes('Live preview only'));
  await pair.click('Start scanning');await pair.page.waitForFunction(()=>!!window.__sample);
  await pair.tick();
  await pair.page.waitForFunction(()=>document.body.innerText.includes('Suggested pair'));
  assert.equal(await pair.slot('a'),'coin');assert.equal(await pair.slot('b'),'cup');
  await pair.click('Stop');await pair.page.close();
  // Camera-free fallback: type both object names.
  const typed=await scenario({denied:true});
  for (const [key,value] of [['a','pencil'],['b','lithium']]) await typed.page.type(`.ww-slot-${key} .ww-slot-input`,value);
  await typed.page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Trace Wikipedia path'&&!b.disabled));
  await typed.click('Trace Wikipedia path');
  await typed.page.waitForSelector('.ww-report .ww-node');
  assert.deepEqual(typed.connects.at(-1),{source:'Pencil',target:'Lithium'});
  assert.equal(typed.requests,0);
  await typed.page.close();
  console.log('PASS: missing credentials, image check gate, permission denial, first result, corrections, two selections, mirrored/responsive boxes, expiry, six-second start spacing, hidden tab, overlap, quota pause, stop cleanup, late response, 50-frame cap, desktop/mobile layout, click-to-select specimens, swap, correction, auto pair, typed fallback, trace with paused recognition, alternative and shared-topic views, reverse, scan again. Zero live API calls.');
} finally { await browser.close(); }
