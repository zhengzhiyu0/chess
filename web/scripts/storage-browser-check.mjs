// Run against the Vite dev server: node scripts/storage-browser-check.mjs
// Engines are stubbed so this checks persistence/UI without downloading or running models.
import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4175';
for (const browserType of [chromium, webkit]) {
 const browser = await browserType.launch(browserType===chromium ? {headless:true,channel:'chromium'} : {headless:true});
 try {
 const page = await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[];
 page.on('pageerror', e=>errors.push(e.message));
 await page.route('**/src/app/engines.ts', route=>route.fulfill({contentType:'text/javascript',body:`
 export class Engines {
 maia=null; sf={alive:true,lite:false,analyse:()=>new Promise(()=>{}),terminate(){}};
 readyForGame(){return true} async prepareGame(){} async warmup(){}
 async getSf(){return this.sf} async getMaia(){window.__maiaCalls=(window.__maiaCalls||0)+1;throw Error('Unexpected Maia move')}
 unloadSf(){} unloadMaia(){}
 }` }));
 await page.addInitScript(()=>{
  window.__writes=[];
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,key){window.__writes.push(key);return put.call(this,value,key)};
 });
 await page.goto(base + '/');
 await page.waitForSelector('#home.active');
 const game={id:'recovery-test',date:100,startFen:'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',tree:{c:[{u:'e2e4',c:[{u:'e7e5',c:[{u:'g1f3'}]}]},{u:'d2d4',x:1,c:[{u:'d7d5',x:1}]}]},userColor:'w',result:'',cursor:[1],mode:'review',flipped:true,tc:'5+0',clock:[200000,210000]};
 await page.evaluate(async game=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('maia-coach',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const tx=db.transaction('documents','readwrite');
  tx.objectStore('documents').put(JSON.stringify(game),'maia-coach.game');
  tx.objectStore('documents').put(JSON.stringify([{...game,result:'1-0'}]),'maia-coach.history');
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=reject}); db.close();
 },game);
 await page.goto(base + '/#game');
 await page.reload();
 await page.waitForSelector('#game.active[data-mode="review"]');
 assert.match(await page.locator('#moves .mv.cur').first().innerText(),/d4/);
 await page.waitForTimeout(450);
 assert.equal(await page.evaluate(()=>window.__maiaCalls||0),0);
 await page.keyboard.press('Escape');
 const historyBefore=await page.evaluate(()=>window.__writes.filter(k=>k==='maia-coach.history').length);
 for(let i=0;i<3;i++){
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#moves .mv.cur').count(),0);
  await page.waitForTimeout(350);
  await page.keyboard.press('ArrowRight');
  assert.match(await page.locator('#moves .mv.cur').first().innerText(),/e4/);
  await page.waitForTimeout(350);
 }
 await page.locator('#btn-flip').evaluate(el=>el.click());
 await page.waitForTimeout(350);
 assert.equal(await page.evaluate(()=>window.__writes.filter(k=>k==='maia-coach.history').length),historyBefore);
 const current=await page.evaluate(async()=>{
  const db=await new Promise(resolve=>{const r=indexedDB.open('maia-coach',1);r.onsuccess=()=>resolve(r.result)});
  const r=db.transaction('documents').objectStore('documents').get('maia-coach.game');
  const value=await new Promise(resolve=>{r.onsuccess=()=>resolve(r.result)});db.close();return JSON.parse(value);
 });
 assert.equal(current.mode,'review');
 assert.equal(current.flipped,undefined);
 assert.ok(Array.isArray(current.cursor));

 // A finished game used to rewrite the complete history on every goto().
 await page.evaluate(async game=>{
  const db=await new Promise(resolve=>{const r=indexedDB.open('maia-coach',1);r.onsuccess=()=>resolve(r.result)});
  const tx=db.transaction('documents','readwrite');
  tx.objectStore('documents').put(JSON.stringify({...game,result:'1-0'}),'maia-coach.game');
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=reject});db.close();
 },game);
 await page.reload();
 await page.waitForSelector('#game.active[data-mode="review"]');
 await page.waitForTimeout(400);
 await page.keyboard.press('Escape');
 const historyWrites=await page.evaluate(()=>window.__writes.filter(k=>k==='maia-coach.history').length);
 const gameWrites=await page.evaluate(()=>window.__writes.filter(k=>k==='maia-coach.game').length);
 await page.keyboard.press('Home');
 await page.waitForTimeout(350);
 await page.keyboard.press('ArrowRight');
 await page.waitForTimeout(350);
 assert.equal(await page.evaluate(()=>window.__writes.filter(k=>k==='maia-coach.history').length),historyWrites);
 assert.ok(await page.evaluate(()=>window.__writes.filter(k=>k==='maia-coach.game').length)>gameWrites);

 await page.addInitScript(()=>{
   const open=indexedDB.open.bind(indexedDB);
   let fail=true;
   indexedDB.open=(...args)=>{if(fail){fail=false;throw Error('Simulated database open failure')}return open(...args)};
 });
 await page.reload();
 await page.getByRole('button',{name:'重试打开数据库'}).waitFor();
 await page.getByRole('button',{name:'重试打开数据库'}).click();
 await page.waitForSelector('#game.active[data-mode="review"]');
 assert.equal(await page.getByRole('button',{name:'重试打开数据库'}).count(),0);
 assert.deepEqual(errors,[]);
 console.log(browserType.name()+': review variation recovery, no automatic Maia move, navigation/flip without history writes, database-open retry PASS');
 }finally{await browser.close()}
}
