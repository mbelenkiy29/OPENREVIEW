import type {QueryCtx,MutationCtx} from './_generated/server';
import type {Doc} from './_generated/dataModel';
import {p4BaselineMetadata} from './p4Index';
import {connectionDigest} from './indexAuthority';
// Authority checks never load the depot file list: one check per call stays within read limits on 8,000-file depots.
export async function p4FixMetadata(ctx:QueryCtx|MutationCtx,review:Doc<'reviews'>){
 if(!review.nativeP4)throw new Error('Native P4 review unavailable');
 const b=await p4BaselineMetadata(ctx,{repositoryId:review.repositoryId,requestedBy:review.nativeP4.requestedBy,baselineJobId:review.nativeP4.baselineJobId});
 if(b.connection._id!==review.nativeP4.connectionId||await connectionDigest(b.connection.credentials)!==review.nativeP4.credentialDigest||b.job.sha!==review.baseSha)throw new Error('P4 review baseline or credentials changed; re-review before fixing');
 return b;
}
// Bridge fix claims build their manifest from the submitted files.
export async function p4FixAuthority(ctx:QueryCtx|MutationCtx,review:Doc<'reviews'>){
 const b=await p4FixMetadata(ctx,review);
 return {...b,files:await ctx.db.query('repositoryFiles').withIndex('by_repo',q=>q.eq('repositoryId',b.repo._id)).collect()};
}
