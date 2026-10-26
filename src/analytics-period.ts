const day=86400000;
export function analyticsPeriod(since:string,until:string):{since:number;until:number}|{error:string}{
 const parse=(value:string)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return NaN;
  const at=Date.parse(value+"T00:00:00.000Z");
  return Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===value?at:NaN;
 };
 const start=parse(since),end=parse(until)+day-1;
 if(!Number.isFinite(start)||!Number.isFinite(end))return {error:"Choose valid From and Through dates."};
 if(end<start)return {error:"Through must be on or after From."};
 if(end-start>366*day)return {error:"Choose a period of at most one year."};
 return {since:start,until:end};
}
export const periodPresets=[["week","This week"],["last7","Last 7 days"],["last30","Last 30 days"],["last60","Last 60 days"],["last90","Last 90 days"],["month","This month"],["quarter","This quarter"],["year","This year"],["custom","Custom"]] as const;
// Greptile-style time periods (UTC): the current week (from Monday), the last 7–90 days, month, quarter or year, through today.
export function presetPeriod(name:string,now:number):{since:string;until:string}|undefined{
 const d=new Date(now),y=d.getUTCFullYear(),m=d.getUTCMonth(),iso=(t:number)=>new Date(t).toISOString().slice(0,10),last=/^last(7|30|60|90)$/.exec(name);
 const start=last?Date.UTC(y,m,d.getUTCDate()-Number(last[1])+1):name==="week"?Date.UTC(y,m,d.getUTCDate()-(d.getUTCDay()+6)%7):name==="month"?Date.UTC(y,m,1):name==="quarter"?Date.UTC(y,m-m%3,1):name==="year"?Date.UTC(y,0,1):NaN;
 return Number.isFinite(start)?{since:iso(start),until:iso(now)}:undefined;
}
// Greptile's "auto" granularity: one point per day up to 90 days, then one per week (Monday-based, UTC),
// labelled with its first day in the period.
export function chartBuckets(days:string[]):{label:string;days:string[]}[]{
 if(days.length<=90)return days.map(d=>({label:d,days:[d]}));
 const weeks=new Map<string,string[]>();
 for(const d of days){const at=Date.parse(d+"T00:00:00Z"),monday=new Date(at-((new Date(at).getUTCDay()+6)%7)*86400000).toISOString().slice(0,10);weeks.set(monday,[...(weeks.get(monday)??[]),d]);}
 return [...weeks.values()].map(days=>({label:days[0],days}));
}
