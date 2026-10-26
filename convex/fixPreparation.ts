"use node";
import {budgetModel} from "./budgetModel";
import { internal } from "./_generated/api";
import { redact,eligibleFile } from "../src/engine/indexer";
import {reviewSummarySchema} from "../src/engine/review";
import {suggestionProblem,type Suggestion} from "../src/suggestions";
import {fixSuggestionSchema,fixSystem,rangeText} from "../src/fix-command";
import type {ActionCtx} from "./_generated/server";
import type {Doc} from "./_generated/dataModel";
import type {Scm,ScmChange} from "../src/gitlab";

// "@openreview fix this" (conversationJobs): one validated suggestion for a finding's exact lines. Fix pull
// requests come from OpenReview's fix agent (fixPullRequestJobs).

// Model output is published: drop explanations that claim test execution, neutralise mentions and links.
export function publishable(text:string|undefined){
  if(!text||!reviewSummarySchema(undefined,[]).safeParse({summary:text}).success)return undefined;
  return text.replace(/https?:\/\/\S+/g,"[link removed]").replace(/@(?=[\w-])/g,"@\u200b").replace(/```/g,"`").replace(/[\r\n]+/g," ").trim();
}
export type PreparedFix={suggestion?:Suggestion;explanation?:string;problem?:string;changed?:ScmChange["diff"][number]};
// A suggestion stored with the finding is reused when it still applies to the current head;
// otherwise the model proposes a replacement for exactly the finding's lines, which is validated.
export async function prepareFix(ctx:ActionCtx,p:{github:Scm;repo:Doc<"repositories">;pr:ScmChange;tree:Map<string,{path:string;sha:string}>;target:Doc<"findings">}):Promise<PreparedFix>{
  const {github,repo,pr,tree,target}=p;
  const entry=tree.get(target.filePath),changed=pr.diff.find(d=>d.path===target.filePath);
  let suggestion:Suggestion|undefined,explanation:string|undefined,problem:string|undefined,content:string|undefined;
  if(!entry||!changed||changed.status==="removed")problem="the finding's file is no longer part of this change";
  else{
    const file=await github.blob(repo.fullName,target.filePath,entry.sha);
    if(!file.content||file.size!==undefined||!eligibleFile(file))problem="the file is too large or not eligible for automated edits";
    else{
      content=file.content;
      const files=[{path:target.filePath,content,sha:entry.sha}];
      if(target.suggestion&&!suggestionProblem({...target,suggestion:target.suggestion},files,pr.diff))suggestion=target.suggestion;
      else{
        const original=rangeText(content,target.startLine,target.endLine),lines=content.split("\n");
        if(redact(original)!==original)problem="the lines contain a value that looks like a secret";
        else{
          const from=Math.max(1,target.startLine-20),to=Math.min(lines.length,target.endLine+20);
          const answer=await (await budgetModel(ctx,repo.organizationId)).generate({task:"fix",system:fixSystem,input:{finding:{title:target.title,description:target.description,impact:target.impact,suggestedFix:target.suggestedFix,category:target.category,severity:target.severity,filePath:target.filePath,startLine:target.startLine,endLine:target.endLine},replaceLines:original.split("\n").map((text,i)=>({line:target.startLine+i,text})),surrounding:redact(lines.slice(from-1,to).join("\n")).split("\n").map((text,i)=>({line:from+i,text})),revision:pr.head.sha}},fixSuggestionSchema);
          await ctx.runMutation(internal.usage.record,{repositoryId:repo._id,kind:"fix",inputTokens:answer.usage.inputTokens,outputTokens:answer.usage.outputTokens,estimatedCost:answer.usage.estimatedCost,durationMs:answer.usage.latencyMs});
          explanation=publishable(answer.value.explanation);
          const candidate={startLine:target.startLine,endLine:target.endLine,original,replacement:answer.value.replacement};
          problem=suggestionProblem({filePath:target.filePath,startLine:target.startLine,endLine:target.endLine,suggestion:candidate},files,pr.diff)??undefined;
          if(!problem)suggestion=candidate;
        }
      }
    }
  }
  return {suggestion,explanation,problem,changed};
}
