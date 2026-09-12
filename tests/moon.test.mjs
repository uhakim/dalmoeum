import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// moon.js is a browser script; run it with a stub window and no #today-moon box.
const context={window:{},document:{getElementById:()=>null},Math,Date,String,Number};
vm.createContext(context);
vm.runInContext(await readFile(new URL('../moon.js',import.meta.url),'utf8'),context);
const DalMoon=context.window.DalMoon;
const kst=text=>new Date(text+'+09:00');
const minutes=(a,b)=>Math.abs(a-b)/60000;

// Reference times for Busan (35.18N, 129.08E) from a high-precision ephemeris (astronomy-engine 2.1.19).
const reference=[
  ['2026-09-12',{moonrise:'2026-09-12T06:58',moonset:'2026-09-12T18:58',sunrise:'2026-09-12T06:03',sunset:'2026-09-12T18:35'}],
  ['2026-09-19',{moonrise:'2026-09-19T13:59',moonset:'2026-09-19T23:23',sunrise:'2026-09-19T06:09',sunset:'2026-09-19T18:25'}],
  ['2026-09-26',{moonrise:'2026-09-26T17:50',sunrise:'2026-09-26T06:14',sunset:'2026-09-26T18:15'}],
  ['2026-10-03',{moonrise:'2026-10-03T22:59',sunrise:'2026-10-03T06:19',sunset:'2026-10-03T18:05'}],
  ['2026-10-10',{moonrise:'2026-10-10T05:46',moonset:'2026-10-10T17:26',sunrise:'2026-10-10T06:25',sunset:'2026-10-10T17:55'}],
  ['2026-01-05',{moonrise:'2026-01-05T19:29',sunrise:'2026-01-05T07:32',sunset:'2026-01-05T17:25'}],
  ['2026-06-21',{moonrise:'2026-06-21T11:41',sunrise:'2026-06-21T05:09',sunset:'2026-06-21T19:41'}],
  ['2026-12-21',{moonrise:'2026-12-21T14:19',sunrise:'2026-12-21T07:27',sunset:'2026-12-21T17:15'}],
  ['2027-03-15',{moonrise:'2027-03-15T10:26',sunrise:'2027-03-15T06:35',sunset:'2027-03-15T18:30'}],
];

test('Busan rise and set times stay within three minutes of a precise ephemeris',()=>{
  for(const [day,expected] of reference){
    const info=DalMoon.daily(kst(day+'T15:30:00'));
    for(const [key,value] of Object.entries(expected)){
      assert.ok(info[key],day+' '+key+' missing');
      assert.ok(minutes(info[key],kst(value))<=3,day+' '+key+': '+info[key].toISOString()+' vs '+value);
    }
    if(info.moonrise&&info.moonset)assert.ok(info.moonset>info.moonrise,day+' moonset must follow moonrise');
  }
});

test('the same local day is used whatever the time of day or browser time zone',()=>{
  const morning=DalMoon.daily(kst('2026-09-26T00:10:00')),night=DalMoon.daily(kst('2026-09-26T23:50:00'));
  assert.equal(morning.start.getTime(),kst('2026-09-26T00:00:00').getTime());
  assert.equal(morning.moonrise.getTime(),night.moonrise.getTime());
  assert.notEqual(DalMoon.daily(kst('2026-09-27T00:10:00')).moonrise.getTime(),morning.moonrise.getTime());
});

test('observation windows fall at night with the moon well above the horizon',()=>{
  const full=DalMoon.daily(kst('2026-09-26T12:00:00'));
  assert.equal(full.windows.length,1);
  assert.ok(full.windows[0].from>full.sunset&&full.windows[0].from>full.moonrise,'full moon window opens after sunset and moonrise');
  assert.ok(full.windows[0].to>kst('2026-09-27T05:00:00')&&full.windows[0].to<kst('2026-09-27T06:14:00'),'full moon window closes before sunrise');
  for(const w of full.windows)for(let t=w.from.getTime();t<=w.to.getTime();t+=15*60000){
    assert.ok(DalMoon.altitude(new Date(t),'moon',DalMoon.site)>=4.9,'moon high enough');
    assert.ok(DalMoon.altitude(new Date(t),'sun',DalMoon.site)<=-5.9,'sky dark enough');
  }
  const newMoon=DalMoon.daily(kst('2026-09-12T12:00:00'));
  assert.equal(newMoon.windows.length,0);
  assert.equal(DalMoon.describe(kst('2026-09-12T12:00:00')).window,'오늘 밤은 달을 보기 어려워요');
  const lastQuarter=DalMoon.describe(kst('2026-10-03T12:00:00'));
  assert.match(lastQuarter.window,/^관찰하기 좋은 때 23:\d\d~내일 새벽 0[45]:\d\d$/);
  assert.match(lastQuarter.times,/^달 뜸 22:59 · 달 짐 내일 1[34]:\d\d$/);
});

test('times are shown in Korean Standard Time with next-day labels',()=>{
  const base=kst('2026-09-26T00:00:00');
  assert.equal(DalMoon.formatTime(kst('2026-09-26T17:50:00'),base),'17:50');
  assert.equal(DalMoon.formatTime(kst('2026-09-27T05:29:00'),base),'내일 새벽 05:29');
  assert.equal(DalMoon.formatTime(kst('2026-09-27T09:06:00'),base),'내일 09:06');
  assert.equal(DalMoon.formatTime(kst('2026-09-27T00:03:00'),base),'내일 새벽 00:03');
});

test('phase calculation is unchanged by the shared position helper',()=>{
  assert.equal(DalMoon.phase(kst('2026-09-26T20:00:00')).phase,'full');
  assert.equal(DalMoon.phase(kst('2026-09-11T20:00:00')).phase,'new');
  assert.equal(DalMoon.phase(kst('2026-09-19T20:00:00')).phase,'first');
  assert.ok(DalMoon.phase(kst('2026-09-26T20:00:00')).illumination>0.97);
});
