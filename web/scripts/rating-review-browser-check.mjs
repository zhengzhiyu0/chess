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
 await page.route('**/__ratingseed',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Rating fixture</title>'}));
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
 async function seed({pending=true,cached=false,fail=false,live=false,profile=1500,result="1-0",assists,temperature=1,settingsPatch={},cursor,period=[]}={}){
 const game={id:'rating-locked',date:100,startFen:'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',tree:{c:[{u:'e2e4',c:[{u:'e7e5'}]}]},userColor:'w',result:'1-0',reason:'resign',elo:1500,playerElo:1500,ratingDeviation:350,ratingVolatility:0.06,ratingStreak:0,ratingPending:pending,independentGames:0,temperature,assists,mode:'review',cursor:cursor??[],peak:1};
 game.result=result;game.ratingPeriod=period;game.independentGames=period.length;
 if(live){game.result='';game.reason=undefined;game.ratingPending=false;game.mode='play';game.cursor=cursor??[0,0];}
 if(cached)game.analysis={signature:'f1000e',positions:[[],[0],[0,0]].map((path,i)=>({path,best:i%2?'e7e5':'e2e4',line:{multipv:1,depth:18,cp:0,pv:[i%2?'e7e5':'e2e4']}}))};
 // Stop the app before replacing storage, so pending checkpoints cannot overwrite fixtures.
 await page.goto(base+'/__ratingseed');
 await page.evaluate(async ({game,profile,settingsPatch,period})=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('maia-coach',1);r.onsuccess=()=>resolve(r.result)});
 const tx=db.transaction('documents','readwrite');const store=tx.objectStore('documents');
 store.put(JSON.stringify(game),'maia-coach.game');store.put(JSON.stringify([game]),'maia-coach.history');
 store.put(JSON.stringify({playerElo:profile,independentGames:period.length,ratingPeriod:period,ratingDeviation:350,ratingVolatility:0.06,ratingStreak:0,ratedGames:7,sfLite:false,sfMovetime:1000,ecoAnalysis:true,autoOffline:false,sound:false,haptics:false,boardFx:false,...settingsPatch}),'maia-coach.settings');
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=reject});db.close();
 },{game,profile,settingsPatch,period});
 await page.addInitScript(fail=>{window.__failSearch=fail},fail);
 await page.goto(base+'/#game');await page.reload();await page.waitForSelector(live?'#game.active[data-mode="play"]':'#game.active[data-mode="review"]',{timeout:10000}).catch(async e=>{console.error((await page.locator('body').innerText()).slice(-2500));throw e});
 }
 async function saved(){await page.waitForTimeout(450);return page.evaluate(async()=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('maia-coach',1);r.onsuccess=()=>resolve(r.result)});
 const store=db.transaction('documents').objectStore('documents');
 const requests=['maia-coach.game','maia-coach.settings'].map(k=>{const r=store.get(k);return new Promise(resolve=>{r.onsuccess=()=>resolve(JSON.parse(r.result))})});
 const [game,settings]=await Promise.all(requests);db.close();return {game,settings};
 })}
 // A failed Stockfish cannot delay or suppress result-only settlement.
 await seed({fail:true});
 await page.waitForFunction(()=>document.querySelector('#report-rating').textContent.includes('参考范围'));
 let data=await saved();assert.equal(data.settings.playerElo,1500);assert.equal(data.settings.ratedGames,8);
 assert.equal(data.settings.independentGames,1);assert.equal(data.game.rating.method,'glicko2-period-v1');
 assert.equal(data.settings.ratingVolatility,data.game.rating.volatilityAfter);
 assert.equal(data.settings.ratingVolatility,0.06);
 assert.equal(data.settings.ratingPeriod.length,1);
 assert.equal(data.game.ratingPending,undefined);
 await page.reload();await page.waitForSelector('#game.active[data-mode="review"]');
 assert.equal((await saved()).settings.independentGames,1,'reload must not rerate');
 const nineDraws=Array.from({length:9},()=>({rating:1500,deviation:0,score:0.5}));
 await seed({period:nineDraws});
 await page.waitForFunction(()=>document.querySelector('#report-rating').textContent.includes('10/10'));
 data=await saved();assert.ok(Math.abs(data.settings.playerElo-1531.6295460500871)<1e-9);assert.equal(data.settings.independentGames,10);assert.deepEqual(data.settings.ratingPeriod,[]);
 await page.reload();await page.waitForSelector('#game.active[data-mode="review"]');
 assert.equal((await saved()).settings.independentGames,10,'completed period must not be applied twice');
 // Actual help, including a deleted branch ledger, excludes wins AND losses.
 for(const result of ['1-0','0-1']){
   for(const assists of [{undo:1,hint:0},{undo:0,hint:1},{undo:0,hint:0,positions:{'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -':{info:true}}}]){
     await seed({result,assists});
     await page.waitForFunction(()=>document.querySelector('#report-rating').textContent.includes('辅助训练'));
     data=await saved();assert.equal(data.settings.playerElo,1500);assert.equal(data.settings.ratedGames,7);
     assert.equal(data.settings.independentGames,0);assert.equal(data.settings.ratingDeviation,350);
     assert.equal(data.settings.ratingVolatility,0.06);
   }
 }
 await seed({temperature:0.8});
 await page.waitForFunction(()=>document.querySelector('#report-rating').textContent.includes('随机性'));
 assert.equal((await saved()).game.rating.excluded,'sampling');
 // Profile edits are never overwritten by a pending old game.
 await seed({profile:1900});
 await page.waitForFunction(()=>document.querySelector('#report-rating').textContent.includes('修改后的资料棋力保持不变'));
 data=await saved();assert.equal(data.settings.playerElo,1900);assert.equal(data.game.ratingApplied,false);
 // A switch without output is allowed; scalar eval / win chance remain rated on either turn.
 await seed({live:true,settingsPatch:{aidBest:true},fail:true});
 await page.waitForTimeout(200);assert.equal((await saved()).game.assists,undefined);
 for(const cursor of [[0],[0,0]]){
   await seed({live:true,settingsPatch:{aidEval:true,aidWinPct:true},cursor,cached:true});
   await page.waitForFunction(()=>document.querySelector('#evalbar-text').textContent!=='…');
   data=await saved();assert.equal(data.game.assists,undefined,'scalar feedback must not mark assistance');
   await page.locator('#btn-menu').click();
   await page.locator('#btn-resign').click();
   await page.waitForFunction(()=>document.querySelector('#result-elo').textContent.includes('参考范围'));
   data=await saved();assert.equal(data.settings.playerElo,1500);assert.equal(data.settings.independentGames,1);
 }
 await seed({live:true,period:nineDraws,cached:true,settingsPatch:{aidEval:true,aidWinPct:true}});
 await page.reload();await page.waitForSelector('#game.active[data-mode="play"]');
 await page.locator('#btn-menu').click();await page.locator('#btn-resign').click();
 await page.waitForFunction(()=>document.querySelector('#result-elo').textContent.includes('10/10'));
 data=await saved();assert.ok(Math.abs(data.settings.playerElo-1468.3704539499129)<1e-9);assert.equal(data.settings.independentGames,10);assert.deepEqual(data.settings.ratingPeriod,[]);
 // Actual best-move output excludes the game and preserves the unchanged rating state.
 await seed({live:true,settingsPatch:{aidBest:true},cached:true});
 await page.waitForFunction(()=>document.querySelector('#game').textContent.includes('训练对局'));
 data=await saved();assert.equal(data.game.assists.best,true);
 await page.locator('#btn-menu').click();
 await page.locator('#btn-resign').click();
 await page.waitForFunction(()=>document.querySelector('#result-elo').textContent.includes('辅助训练'));
 data=await saved();assert.equal(data.settings.playerElo,1500);assert.equal(data.settings.independentGames,0);
 // Mobile profile states the uncertainty, local scale and next useful opponent.
 await seed({live:true});
 await page.setViewportSize({width:390,height:844});
 await page.goto(base+'/#home');
 await page.locator('[data-home-tab="data"]').click();
 await page.locator('#btn-profile-rating').click();
 await page.locator('#profile-rating').waitFor({state:'visible'});
 assert.match(await page.locator('#profile-rating').innerText(),/棋力定位中[\s\S]*参考范围[\s\S]*Maia 1500/);
 const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,items:[...document.querySelectorAll('#dlg-profile-rating, #profile-rating, #profile-rating *')].map(el=>({tag:el.tagName,cls:el.className,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right})).filter(x=>x.left<0||x.right>innerWidth)}));
 assert.deepEqual(overflow.items,[],'profile dialog must fit the mobile viewport');
 await page.locator('#dlg-profile-rating button').last().click();
 await page.setViewportSize({width:1280,height:900});

 // Saving unrelated settings preserves full-precision rating state; no manual input remains.
 await seed({live:true,profile:1900.123456789});
 await page.locator('#btn-settings').evaluate(el=>el.click());
 await page.waitForSelector('#settings.active');
 assert.equal(await page.locator('[name="playerElo"]').count(),0);
 await page.locator('#btn-settings-save').click();
 await page.waitForTimeout(450);
 assert.equal((await saved()).settings.playerElo,1900.123456789);
 await page.goto(base+'/#game');await page.reload();
 await page.waitForSelector('#game.active[data-mode="play"]');
 await page.locator('#btn-menu').click();
 await page.locator('#btn-resign').click();
 await page.waitForFunction(()=>document.querySelector('#result-elo').textContent.includes('修改后的资料棋力保持不变'));
 await page.waitForSelector('#dlg-result[open]');
 await page.locator('#btn-result-review').click();
 await page.waitForSelector('#game.active[data-mode="review"]');
 await page.waitForTimeout(450);
 data=await saved();assert.equal(data.settings.playerElo,1900.123456789);assert.equal(data.game.ratingPending,undefined);
 assert.equal(data.game.rating.playerBefore,1500);
 // Repositioning uses the official initial state and clears the pending period.
 await page.locator('#btn-settings').evaluate(el=>el.click());
 await page.waitForSelector('#settings.active');
 await page.locator('#btn-rating-reset').click();
 data=await saved();assert.equal(data.settings.playerElo,1500);assert.equal(data.settings.ratingDeviation,350);
 assert.equal(data.settings.ratingVolatility,0.06);assert.deepEqual(data.settings.ratingPeriod,[]);assert.equal(data.settings.independentGames,0);
 assert.deepEqual(errors,[]);console.log(type.name()+': immediate result/reload, assisted wins/losses, scalar feedback rated, best-move exclusion, sampling, changed baseline and mobile profile PASS');
 }finally{await browser.close()}
}
