// Start Vite on 4175, then node scripts/rating-review-browser-check.mjs.
import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.TEST_BASE_URL??'http://127.0.0.1:4175';
for(const type of [chromium,webkit]){
 const browser=await type.launch(type===chromium?{channel:'chromium'}:{});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[]; page.on('pageerror',e=>{errors.push(e.message);console.error(type.name(),e.message)});
 page.on('dialog',d=>d.accept());
 await page.route('**/src/app/engines.ts',route=>route.fulfill({contentType:'text/javascript',body:`
 export class Engines{
 maia=null; sf={alive:true,lite:false,analyse:async(_fen,opts)=>{
 window.__searches??=[];window.__searches.push(opts.moves??[]);
 if(window.__failSearch)throw Error('Simulated engine failure');
 const best=(opts.moves??[]).length%2?'e7e5':'e2e4';
 return {bestmove:best,lines:[{multipv:1,depth:18,cp:0,pv:[best]}]};
 },terminate(){}};
 readyForGame(){return true} async prepareGame(){} async warmup(){} async getSf(){return this.sf}
 async getMaia(){return new Promise(()=>{})} unloadSf(){} unloadMaia(){}
 }`}));
 await page.goto(base); await page.waitForSelector('#home.active');
 async function seed({pending=true,cached=false,fail=false,live=false}={}){
 const game={id:'rating-locked',date:100,startFen:'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',tree:{c:[{u:'e2e4',c:[{u:'e7e5'}]}]},userColor:'w',result:'1-0',reason:'resign',elo:1500,playerElo:1500,ratingDeviation:350,ratingStreak:0,ratingPending:pending,mode:'review',cursor:[],peak:1};
 if(live){game.result='';game.reason=undefined;game.ratingPending=false;game.mode='play';game.cursor=[0,0];}
 if(cached)game.analysis={signature:'f1000e',positions:[[],[0],[0,0]].map((path,i)=>({path,best:i%2?'e7e5':'e2e4',line:{multipv:1,depth:18,cp:0,pv:[i%2?'e7e5':'e2e4']}}))};
 await page.evaluate(async game=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('maia-coach',1);r.onsuccess=()=>resolve(r.result)});
 const tx=db.transaction('documents','readwrite');const store=tx.objectStore('documents');
 store.put(JSON.stringify(game),'maia-coach.game');store.put(JSON.stringify([game]),'maia-coach.history');
 store.put(JSON.stringify({playerElo:1900,ratingDeviation:350,ratingStreak:0,ratedGames:7,sfLite:false,sfMovetime:1000,ecoAnalysis:true,autoOffline:false,sound:false,haptics:false,boardFx:false}),'maia-coach.settings');
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=reject});db.close();
 },game);
 await page.addInitScript(fail=>{window.__failSearch=fail},fail);
 await page.goto(base+'/#game');await page.reload();await page.waitForSelector(live?'#game.active[data-mode="play"]':'#game.active[data-mode="review"]',{timeout:10000}).catch(async e=>{console.error((await page.locator('body').innerText()).slice(-2500));throw e});
 }
 async function saved(){return page.evaluate(async()=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('maia-coach',1);r.onsuccess=()=>resolve(r.result)});
 const store=db.transaction('documents').objectStore('documents');
 const requests=['maia-coach.game','maia-coach.settings'].map(k=>{const r=store.get(k);return new Promise(resolve=>{r.onsuccess=()=>resolve(JSON.parse(r.result))})});
 const [game,settings]=await Promise.all(requests);db.close();return {game,settings};
 })}
 // Existing deadlocked game with changed baseline must settle without touching profile.
 await seed();await page.waitForFunction(()=>document.querySelector('#report-rating').textContent.includes('修改后的资料棋力保持不变'));
 await page.waitForTimeout(450);
 let data=await saved();assert.equal(data.settings.playerElo,1900);assert.equal(data.settings.ratedGames,7);
 assert.equal(data.game.ratingPending,undefined);assert.equal(data.game.ratingApplied,false);assert.ok(data.game.analysis.positions.length===3);
 const searches=await page.evaluate(()=>window.__searches.filter(m=>m.length===1).length);
 assert.equal(searches,1,'settlement evaluation must feed review without a second scan');
 await page.reload();await page.waitForSelector('#game.active[data-mode="review"]',{timeout:10000}).catch(async e=>{console.error((await page.locator('body').innerText()).slice(-2500));throw e});await page.waitForTimeout(450);
 assert.equal(await page.evaluate(()=>(window.__searches??[]).filter(m=>m.length===1).length),0,'reload must restore saved game analysis');
 // Preexisting play evaluations must settle immediately without rescanning other positions.
 await seed({cached:true});await page.waitForFunction(()=>document.querySelector('#report-rating').textContent.includes('修改后的资料棋力保持不变'));
 assert.equal(await page.evaluate(()=>(window.__searches??[]).filter(m=>m.length>0).length),0);
 // Failed settlement still permits review and exposes a permanent escape on the report.
 await seed({fail:true});await page.getByRole('button',{name:'重试结算'}).last().waitFor();
 await page.getByRole('button',{name:'保留本局，不计分'}).last().click();
 await page.waitForTimeout(450);data=await saved();assert.equal(data.game.ratingSkipped,true);assert.equal(data.game.ratingPending,undefined);
 assert.equal(data.settings.playerElo,1900);
 await page.locator('#btn-new').evaluate(el=>el.click());await page.waitForSelector('#game.active[data-mode="play"]');
 await page.waitForTimeout(400);assert.notEqual((await saved()).game.id,'rating-locked');

 // Change the profile through the real settings form during play, then resign and review.
 await seed({live:true});
 await page.locator('#btn-settings').evaluate(el=>el.click());
 await page.waitForSelector('#settings.active');
 await page.locator('[name="playerElo"]').fill('2100');
 await page.locator('#btn-settings-save').click();
 await page.waitForTimeout(450);
 assert.equal((await saved()).settings.playerElo,2100);
 await page.goto(base+'/#game');await page.reload();
 await page.waitForSelector('#game.active[data-mode="play"]');
 await page.locator('#btn-menu').click();
 await page.locator('#btn-resign').click();
 await page.waitForFunction(()=>document.querySelector('#result-elo').textContent.includes('修改后的资料棋力保持不变'));
 await page.waitForSelector('#dlg-result[open]');
 await page.locator('#btn-result-review').click();
 await page.waitForSelector('#game.active[data-mode="review"]');
 await page.waitForTimeout(450);
 data=await saved();assert.equal(data.settings.playerElo,2100);assert.equal(data.game.ratingPending,undefined);
 assert.equal(data.game.rating.playerBefore,1500);
 assert.deepEqual(errors,[]);console.log(type.name()+': changed-baseline recovery, analysis reuse/reload, failed-rating skip and new-game PASS');
 }finally{await browser.close()}
}
