import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {convexTest} from 'convex-test';
import schema from '../convex/schema';
import {api,internal} from '../convex/_generated/api';
import {changelogFeed,parseChangelog} from '../src/changelog';
const modules=import.meta.glob('../convex/**/*.ts');
const svc='changelog-service',env=['RESEND_API_KEY','EMAIL_FROM','RESEND_CHANGELOG_SEGMENT_ID'];
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.setSystemTime(Date.UTC(2026,9,19,12));Object.assign(process.env,{SERVICE_SECRET:svc,APP_URL:'https://review.example.com'});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const k of env)delete process.env[k];});

// Resend and the live feed, faked: a create for a contact that already exists answers 409, or 200 without changing it.
function fakeResend(){
 const mails:{to:string;text:string}[]=[],broadcasts:Record<string,unknown>[]=[],calls:string[]=[],contacts=new Map<string,{unsubscribed:boolean;segments:Set<string>}>();
 const state={feed:'',existingCreate:409};
 vi.spyOn(globalThis,'fetch').mockImplementation(async(u:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(u)),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):{};
  calls.push(`${method} ${url.pathname}`);
  if(url.href==='https://review.example.com/changelog/feed.xml')return new Response(state.feed);
  if(url.pathname==='/emails'){mails.push({to:body.to[0],text:body.text});return Response.json({id:'m'+mails.length});}
  if(url.pathname==='/broadcasts'){broadcasts.push(body);return Response.json({id:'b'+broadcasts.length});}
  if(url.pathname==='/contacts'){
   if(contacts.has(body.email))return state.existingCreate===200?Response.json({id:'c'}):Response.json({name:'conflict'},{status:409});
   contacts.set(body.email,{unsubscribed:body.unsubscribed,segments:new Set(body.segments.map((s:{id:string})=>s.id))});return Response.json({id:'c'});
  }
  const [,,email,,segment]=url.pathname.split('/'),contact=contacts.get(decodeURIComponent(email));
  if(!contact)return Response.json({name:'not_found'},{status:404});
  if(method==='PATCH')contact.unsubscribed=body.unsubscribed;else contact.segments.add(segment);
  return Response.json({id:'c'});
 });
 return {mails,broadcasts,calls,contacts,state};
}
const confirmToken=(text:string)=>/\/api\/changelog\/confirm\?token=([A-Za-z0-9._-]+)/.exec(text)![1];
const feed=(md:string)=>changelogFeed(parseChangelog(md),'https://review.example.com',new Date());
const md='# Changelog\n\n## October 2026\n\n### Site\n- RSS feed.\n';

test('changelog sign-up is double opt-in, stores no address, and lands in the Resend segment',async()=>{
 const t=convexTest(schema,modules),r=fakeResend();
 await expect(t.action(api.changelogJobs.subscribe,{secret:svc,email:'a@example.com'})).rejects.toThrow('not configured');
 Object.assign(process.env,{RESEND_API_KEY:'re_fixture',EMAIL_FROM:'OpenReview <noreply@example.com>',RESEND_CHANGELOG_SEGMENT_ID:'seg_1'});
 await expect(t.action(api.changelogJobs.subscribe,{secret:'wrong',email:'a@example.com'})).rejects.toThrow();
 await t.action(api.changelogJobs.subscribe,{secret:svc,email:'Reader@Example.com'});
 expect(r.mails[0].to).toBe('reader@example.com');
 const token=confirmToken(r.mails[0].text);
 expect(token).not.toContain('reader');
 expect(JSON.stringify(await t.run(ctx=>ctx.db.query('rateLimits').collect()))).not.toContain('reader');
 expect(r.contacts.size).toBe(0);
 expect(await t.action(api.changelogJobs.confirm,{secret:svc,token})).toBe(true);
 expect(r.contacts.get('reader@example.com')).toEqual({unsubscribed:false,segments:new Set(['seg_1'])});
 // Someone who unsubscribed in Resend and signs up again is subscribed again.
 r.contacts.get('reader@example.com')!.unsubscribed=true;
 expect(await t.action(api.changelogJobs.confirm,{secret:svc,token})).toBe(true);
 expect(r.contacts.get('reader@example.com')!.unsubscribed).toBe(false);
 expect(r.calls.slice(-3)).toEqual(['POST /contacts','PATCH /contacts/reader%40example.com','POST /contacts/reader%40example.com/segments/seg_1']);
 // Resend may instead answer the create with 200 and change nothing: the contact is still subscribed again and back in the segment.
 r.state.existingCreate=200;Object.assign(r.contacts.get('reader@example.com')!,{unsubscribed:true,segments:new Set()});
 expect(await t.action(api.changelogJobs.confirm,{secret:svc,token})).toBe(true);
 expect(r.contacts.get('reader@example.com')).toEqual({unsubscribed:false,segments:new Set(['seg_1'])});
 // Tampered or expired links do nothing, and each address gets 3 links an hour.
 expect(await t.action(api.changelogJobs.confirm,{secret:svc,token:token.slice(0,-2)+'xx'})).toBe(false);
 await t.action(api.changelogJobs.subscribe,{secret:svc,email:'reader@example.com'});
 await t.action(api.changelogJobs.subscribe,{secret:svc,email:'reader@example.com'});
 await expect(t.action(api.changelogJobs.subscribe,{secret:svc,email:'reader@example.com'})).rejects.toThrow('Rate limit');
 vi.advanceTimersByTime(25*3600_000);
 expect(await t.action(api.changelogJobs.confirm,{secret:svc,token:confirmToken(r.mails[2].text)})).toBe(false);
});

test('the weekly digest sends one broadcast with only the new entries, never the whole history',async()=>{
 const t=convexTest(schema,modules),r=fakeResend();
 expect(await t.action(internal.changelogJobs.digest,{})).toBe('not configured');
 Object.assign(process.env,{RESEND_API_KEY:'re_fixture',EMAIL_FROM:'OpenReview <noreply@example.com>',RESEND_CHANGELOG_SEGMENT_ID:'seg_1'});
 r.state.feed=feed(md);
 expect(await t.action(internal.changelogJobs.digest,{})).toBe('recorded the current changelog');
 expect(r.broadcasts).toEqual([]);
 r.state.feed=feed(md.replace('- RSS feed.\n','- RSS feed.\n- Changelog by email.\n'));
 expect(await t.action(internal.changelogJobs.digest,{})).toBe('1 sections sent');
 expect(r.broadcasts).toHaveLength(1);
 expect(r.broadcasts[0]).toMatchObject({segment_id:'seg_1',from:'OpenReview <noreply@example.com>',send:true,subject:"What's new in OpenReview: Site"});
 expect(r.broadcasts[0].text).toContain('• Changelog by email.');
 expect(r.broadcasts[0].text).not.toContain('RSS feed');
 expect(r.broadcasts[0].html).toContain('<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a>');
 expect(await t.action(internal.changelogJobs.digest,{})).toBe('0 sections sent');
 // A broken feed is not recorded, so the next good run still sends only what is new.
 r.state.feed='<rss></rss>';
 await expect(t.action(internal.changelogJobs.digest,{})).rejects.toThrow('no entries');
 r.state.feed=feed(md.replace('- RSS feed.\n','- RSS feed.\n- Changelog by email.\n'));
 expect(await t.action(internal.changelogJobs.digest,{})).toBe('0 sections sent');
 expect(r.broadcasts).toHaveLength(1);
});

test('changelog sign-ups are capped at 100 an hour across all addresses',async()=>{
 const t=convexTest(schema,modules);
 for(let i=0;i<100;i++)await t.mutation(internal.changelog.limitSubscribe,{emailHash:'h'+i});
 await expect(t.mutation(internal.changelog.limitSubscribe,{emailHash:'another'})).rejects.toThrow('Rate limit');
 vi.advanceTimersByTime(3600_000);
 await t.mutation(internal.changelog.limitSubscribe,{emailHash:'another'});
});
