import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticsPeriod,chartBuckets,presetPeriod} from '../src/analytics-period';
test('analytics date periods use inclusive UTC days including a leap year',()=>{
 assert.deepEqual(analyticsPeriod('2026-10-04','2026-10-04'),{since:Date.UTC(2026,9,4),until:Date.UTC(2026,9,5)-1});
 assert.deepEqual(analyticsPeriod('2024-01-01','2024-12-31'),{since:Date.UTC(2024,0,1),until:Date.UTC(2025,0,1)-1});
});
test('analytics rejects rolled dates, malformed dates, reversed and oversized periods',()=>{
 for(const date of ['2026-02-30','2026-13-01','2026-1-1','2026-10-04T00:00:00Z','not-a-date',''])assert.ok('error' in analyticsPeriod(date,'2026-10-04'));
 assert.deepEqual(analyticsPeriod('2026-10-04','2026-10-03'),{error:'Through must be on or after From.'});
 assert.deepEqual(analyticsPeriod('2024-01-01','2025-01-01'),{error:'Choose a period of at most one year.'});
 assert.ok('error' in analyticsPeriod('2026-01-01','2026-02-30'));
});
test('period presets: week from Monday, month, quarter and year through today (UTC)',()=>{
 const now=Date.UTC(2026,7,16,15); // Sunday 2026-08-16
 assert.deepEqual(presetPeriod('week',now),{since:'2026-08-10',until:'2026-08-16'});
 assert.deepEqual(presetPeriod('week',Date.UTC(2026,7,10)),{since:'2026-08-10',until:'2026-08-10'});
 assert.deepEqual(presetPeriod('month',now),{since:'2026-08-01',until:'2026-08-16'});
 assert.deepEqual(presetPeriod('quarter',now),{since:'2026-07-01',until:'2026-08-16'});
 assert.deepEqual(presetPeriod('quarter',Date.UTC(2026,11,31)),{since:'2026-10-01',until:'2026-12-31'});
 assert.deepEqual(presetPeriod('year',now),{since:'2026-01-01',until:'2026-08-16'});
 assert.deepEqual(presetPeriod('last7',now),{since:'2026-08-10',until:'2026-08-16'});
 assert.deepEqual(presetPeriod('last30',now),{since:'2026-07-18',until:'2026-08-16'});
 assert.deepEqual(presetPeriod('last90',now),{since:'2026-05-19',until:'2026-08-16'});
 assert.equal(presetPeriod('last14',now),undefined);
 assert.equal(presetPeriod('custom',now),undefined);
});
test('chart buckets: daily up to 90 days, then Monday weeks labelled by their first day in the period',()=>{
 const span=(from:string,n:number)=>Array.from({length:n},(_,i)=>new Date(Date.parse(from+'T00:00:00Z')+i*86400000).toISOString().slice(0,10));
 {const b=chartBuckets(span('2026-07-01',90));assert.equal(b.length,90);assert.deepEqual(b[0],{label:'2026-07-01',days:['2026-07-01']});}
 const weeks=chartBuckets(span('2026-01-01',293)); // Thu 2026-01-01 .. Tue 2026-10-20
 assert.deepEqual(weeks[0],{label:'2026-01-01',days:['2026-01-01','2026-01-02','2026-01-03','2026-01-04']});
 assert.deepEqual(weeks[1].days.length,7);assert.equal(weeks[1].label,'2026-01-05');
 assert.deepEqual(weeks.at(-1),{label:'2026-10-19',days:['2026-10-19','2026-10-20']});
 assert.equal(weeks.flatMap(w=>w.days).length,293);
});
