"use client";
import {useId,useRef,useState} from "react";
import {defaults,summarySections,summaryLabels,layoutSections} from "../../src/review-settings";
import {findingComment} from "../../src/review-summary";
import {example,exampleSummary} from "./summary-example";
import {ReviewMarkdown} from "./markdown";
import {Icon,type IconName} from "../ui/icons";
import {useFormReset} from "./review-controls";
// Greptile's PR Summaries option cards: one switch per part of the summary comment.
const parts:Record<(typeof summarySections)[number],[IconName,string]>={overview:["fileText","Include a text summary of the changes"],affectedAreas:["folders","Show a table of changed files with a line about each"],diagram:["graph","Generate a sequence diagram of the changes, when one applies"],findings:["table","Show a table of verified findings by priority"],agentPrompt:["robot","Add a prompt that hands the findings to your coding agent"],requirements:["listChecks","Check the change against the linked issue's requirements"],score:["chartBar","Include a 1–5 confidence score for the PR"],risk:["gauge","Include a risk assessment and its reason"],resolved:["checkCircle","List earlier findings this review confirmed resolved"],skipped:["eyeSlash","List the changed files the review skipped, and why"],testSource:["terminalWindow","List the test files the change touches"],tips:["lightbulb","Add a feature tip to the summary footer"]};
// `id`: a jump-link target on Code Review Settings; the Teams page renders one per team without it.
export function SummarySettings({id,initial,style="concise",hideFooter=false,layout={}}:{id?:string;initial?:string[];style?:string;hideFooter?:boolean;layout?:Record<string,string>}){
 const [selected,setSelected]=useState<string[]>(initial??[...defaults.summarySections]),[commentStyle,setCommentStyle]=useState(style);
 const ref=useRef<HTMLFieldSetElement>(null),uid=useId();
 useFormReset(ref,()=>{setSelected(initial??[...defaults.summarySections]);setCommentStyle(style);});
 const summary=exampleSummary(selected);
 return <fieldset ref={ref} id={id} className="wide summary-settings"><legend>Review formatting</legend><input type="hidden" name="summaryConfigured" value="true"/>
  <div className="setting-row"><div><label htmlFor={uid+"style"}>Comment style</label><p>How much each inline finding says</p></div><select id={uid+"style"} name="commentStyle" value={commentStyle} onChange={e=>setCommentStyle(e.target.value)}><option>concise</option><option>detailed</option><option>compact</option></select></div>
  <div className="summary-parts" role="group" aria-label="Summary sections">{summarySections.map(section=><div className="option-card" key={section}><Icon name={parts[section][0]}/><div><label htmlFor={uid+section}><strong>{summaryLabels[section]}</strong></label><p id={uid+section+"d"}>{parts[section][1]}</p></div><input id={uid+section} type="checkbox" role="switch" name="summarySections" value={section} aria-describedby={uid+section+"d"} checked={selected.includes(section)} onChange={e=>setSelected(summarySections.filter(s=>s===section?e.target.checked:selected.includes(s)))}/></div>)}</div>
  <div className="setting-row"><div><label htmlFor={uid+"footer"}>Hide the footer</label><p>Leave out the review number, re-run command and tips</p></div><input id={uid+"footer"} type="checkbox" role="switch" name="hideFooter" defaultChecked={hideFooter}/></div>
  <details className="summary-layout"><summary>GitHub section layout</summary>{layoutSections.map(section=><div className="setting-row" key={section}><div><label htmlFor={uid+"layout-"+section}>{summaryLabels[section]}</label><p>Shown, expanded or collapsed in the GitHub summary</p></div><select id={uid+"layout-"+section} name={"layout:"+section} defaultValue={layout[section]??""}><option value="">default</option><option value="plain">shown</option><option value="open">expanded</option><option value="collapsed">collapsed</option></select></div>)}</details>
  <p className="muted">Execution evidence and coverage always appear. These settings apply to future reviews.</p>
  <details className="summary-preview"><summary>Live comment preview · example data</summary><div aria-live="polite"><h3>Summary</h3><ReviewMarkdown>{summary}</ReviewMarkdown><h3>Inline finding</h3><ReviewMarkdown>{findingComment(example,commentStyle)}</ReviewMarkdown></div></details>
 </fieldset>;
}
