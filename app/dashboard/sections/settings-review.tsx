import { repositoryDisplay, providerShort } from "../../../src/provider-display";
import Link from "next/link";

import { lockableKeys, strictnessPresets } from "../../../src/review-settings";
import { saveSettings, decideConvention } from "../actions";
import { ModelSelect } from "../model-select";
import { Locked } from "../locked";
import { SummarySettings } from "../summary-settings";
import { PortalDisclosure } from "../portal-disclosure";
import { LevelSlider, SaveBar, Stepper, TagInput, type Stop } from "../review-controls";
import { Row, SettingsHeading, Switch } from "../settings-ui";
import { Icon, type IconName } from "../../ui/icons";

import type { DashboardContext } from "../load";

// Code Review Settings, laid out like Greptile's: each section is an outlined icon, a display heading and a
// subtitle above a white card of setting rows. The section ids are the sub-navigation's jump targets
// (reviewSections in ../sidebar.tsx lists them in this order). One form saves every field (saveSettings).
const FORM = "review-settings-form";
// The stored snapshot is capped in length; an older cut-off one shows no values rather than breaking the page.
const fileSnapshot = (values: string): Record<string, unknown> => { try { return JSON.parse(values) as Record<string, unknown>; } catch { return {}; } };

const pct = (n: number) => Math.round(n * 100) + "%";
const strictnessStops: Stop[] = [
  { value: "0", label: "Custom", help: "Uses the severity threshold and minimum confidence under OpenReview Comments." },
  ...([[1, "Low", "Fewest comments"], [2, "Medium", "Balanced"], [3, "High", "Most thorough"]] as const).map(([level, label, lead]) => ({ value: String(level), label, help: `${lead}: ${strictnessPresets[level].severityThreshold} severity and above, at ${pct(strictnessPresets[level].minimumConfidence)} confidence or more.` })),
];
const severityStops: Stop[] = [
  { value: "critical", label: "Critical", help: "OpenReview comments only on critical findings." },
  ...(["high", "medium", "low"] as const).map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1), help: `OpenReview comments on ${s}-severity findings and above.` })),
];
// Shown where a plan without deep reviews locks the engine, agent budgets and model overrides.
const deepNote = "The agentic engines, agent budgets and model overrides are part of deep reviews on the Pro plan; until then reviews run the standard pipeline on the workspace model.";
const categories = ["correctness", "security", "data", "compatibility", "testing", "performance", "rules", "style", "syntax"];
const providerIcon = (kind?: string): IconName => kind?.startsWith("github") ? "githubLogo" : kind === "gitlab" ? "gitlabLogo" : "gitBranch";

/** Page-header actions: the repository whose settings are shown, and the workspace and team defaults. */
export function ReviewSettingsActions({ ctx }: { ctx: DashboardContext }) {
  const { data, repoSettings, filters } = ctx;
  if (!repoSettings) return null;
  const team = filters.team ? "&team=" + filters.team : "", repo = repoSettings.repo, current = data.repositories.find((r) => r._id === repo._id);
  return <div className="page-actions">
    <Link className="button" href="/dashboard/organization/teams">Workspace &amp; team defaults</Link>
    {/* Keyed by repository: choosing one changes only the query, so the remount is what closes the menu. */}
    <PortalDisclosure key={repo._id} className="repo-switch" label={<><Icon name={providerIcon(current?.provider?.kind)} /><span title={repositoryDisplay(current)}>{repo.fullName}</span><Icon name="caretUpDown" /><span className="sr-only">Choose repository</span></>}>
      <div className="menu">
        <p className="menu-label">Repositories</p>
        {data.repositories.map((r) => <Link key={r._id} className="menu-item" href={`/dashboard/code-review?repository=${r._id}${team}`} aria-current={r._id === repo._id ? "true" : undefined} title={repositoryDisplay(r)}>
          <Icon name={providerIcon(r.provider?.kind)} /><span>{r.fullName}<small>{providerShort(r.provider ?? null)}</small></span>{r._id === repo._id && <Icon name="check" />}
        </Link>)}
      </div>
    </PortalDisclosure>
  </div>;
}

export function ReviewSettingsSection({ ctx }: { ctx: DashboardContext }) {
  const { locked, conventions, data, isAdmin, repoSettings, semantic } = ctx;
  if (!repoSettings) return <div className="review-settings"><div className="empty-state settings-card">
    <Icon name="gitBranch" />
    <strong>{data.repositories.length ? "Repository unavailable" : "No repositories yet"}</strong>
    <p>Connect a code provider and enable repositories to choose how OpenReview reviews them.</p>
    <div className="actions"><Link className="button primary" href="/dashboard/providers">Go to Code Providers</Link><Link className="button" href="/dashboard/organization/teams">Workspace &amp; team defaults</Link></div>
  </div></div>;
  const { repo, settings: s, models } = repoSettings, config = repo.configFile;
  const fileValues = config ? fileSnapshot(config.values) : {};
  return <div className="review-settings">
    {!isAdmin && <p className="notice-banner" role="status"><Icon name="lockSimple" />Workspace admin access is required to edit these settings.</p>}
    <form action={saveSettings} id={FORM} className="stack">
      <input type="hidden" name="repositoryId" value={repo._id} />
      <fieldset disabled={!isAdmin}>
        <legend className="sr-only">Repository review settings</legend>

        <div id="review-general" className="settings-group">
          <SettingsHeading icon="pulse" title="When OpenReview Reviews" sub="Control when OpenReview runs and how much it reviews" />
          <div className="settings-card">
            <LevelSlider key={"st" + (s.strictness ?? 0)} id="rs-strictness" name="strictness" title="Strictness level" stops={strictnessStops} value={String(s.strictness ?? 0)} />
            <Row id="rs-automatic" title="Automatic reviews" help="When off, OpenReview reviews only on “@openreview review” or a trigger label."><Switch id="rs-automatic" name="automatic" on={s.automatic} /></Row>
            <Row id="rs-rereview" title="Auto-review on new commits" help="Review again when new commits are pushed to the pull request."><Switch id="rs-rereview" name="rereview" on={s.rereview} /></Row>
            <Row id="rs-drafts" title="Review draft pull requests" help="Drafts are skipped while this is off."><Switch id="rs-drafts" name="drafts" on={s.drafts} /></Row>
            <Row id="rs-maxFiles" title="File change limit" help="Skip automatic reviews above this many changed files. 0 means no limit."><Stepper id="rs-maxFiles" name="maxFiles" min={0} value={s.maxFiles ?? 0} describedBy="rs-maxFiles-help" /></Row>
            <Row id="rs-maxChangedLines" title="Changed line limit" help="Skip automatic reviews above this many changed lines. 0 means no limit."><Stepper id="rs-maxChangedLines" name="maxChangedLines" min={0} step={50} value={s.maxChangedLines ?? 0} describedBy="rs-maxChangedLines-help" /></Row>
            <div className="filters">
              <span className="setting-title">Filters</span>
              <div className="filters-box">
                {([["triggerLabels", "Trigger labels", "openreview, needs-review", "Adding one of these labels starts a review."], ["targetBranches", "Target branches", "main, release/*", "Only pull requests into these branches are reviewed. Empty means all."], ["ignoredBranches", "Ignored branches", "dependabot/*", "Pull requests from these source branches are skipped."], ["excludedAuthors", "Excluded authors", "dependabot[bot], *-bot", "Pull requests by these authors (globs) are skipped."]] as const).map(([key, title, placeholder, help]) =>
                  <Row key={key} id={"rs-" + key} title={title} help={help} className="filter-row"><TagInput key={(s[key] ?? []).join()} id={"rs-" + key} name={key} value={s[key] ?? []} placeholder={placeholder} describedBy={`rs-${key}-help`} /></Row>)}
              </div>
            </div>
          </div>
        </div>

        <div id="review-formatting" className="settings-group">
          <SettingsHeading icon="gitPullRequest" title="PR Summaries" sub="Adjust what OpenReview posts at the top of the PR" link={<Link className="heading-link" href="/dashboard/account/review">Personal review settings<Icon name="arrowSquareOut" /></Link>} />
          <div className="settings-card">
            <Row id="rs-summaryPlacement" title="Summary location" help="Where the summary goes on GitHub. It is edited in place on every review, so the pull request stays quiet.">
              <select key={s.summaryPlacement} id="rs-summaryPlacement" name="summaryPlacement" defaultValue={s.summaryPlacement ?? "description"} aria-describedby="rs-summaryPlacement-help"><option value="description">Pull request description</option><option value="comment">One comment</option></select>
            </Row>
            <SummarySettings key={JSON.stringify([repo._id, s.summarySections, s.commentStyle, s.hideFooter, s.sectionLayout])} initial={s.summarySections} style={s.commentStyle} hideFooter={s.hideFooter} layout={s.sectionLayout} />
          </div>
        </div>

        <div id="review-instructions" className="settings-group">
          <SettingsHeading icon="gear" title="Custom Instructions" sub="Fine-tune how OpenReview reviews your code" />
          <div className="settings-card">
            <label className="setting-title" htmlFor="rs-instructions">Instructions</label>
            <textarea id="rs-instructions" name="instructions" rows={5} defaultValue={s.instructions} placeholder="Flag any new dependency that is not pinned to an exact version." />
          </div>
        </div>

        <div id="review-categories" className="settings-group">
          <SettingsHeading icon="chatCircleDots" title="OpenReview Comments" sub="Adjust what OpenReview comments on and how much it says" />
          <div className="settings-card">
            <LevelSlider key={"sv" + s.severityThreshold} id="rs-severity" name="severityThreshold" title="Severity threshold" help="Used when the strictness level is Custom." stops={severityStops} value={s.severityThreshold} />
            <Row id="rs-minimumConfidence" title="Minimum confidence" help="The confidence (0.5–1) a finding needs to be posted. Used when the strictness level is Custom."><Stepper id="rs-minimumConfidence" name="minimumConfidence" min={0.5} max={1} step={0.01} value={s.minimumConfidence} describedBy="rs-minimumConfidence-help" /></Row>
            <Row id="rs-maxComments" title="Maximum comments" help="The most inline comments one review posts (0–30)."><Stepper id="rs-maxComments" name="maxComments" min={0} max={30} value={s.maxComments} describedBy="rs-maxComments-help" /></Row>
            <Row id="rs-ignoredPaths" title="Ignored paths" help="Files matching these globs are not reviewed." className="filter-row"><TagInput key={s.ignoredPaths.join()} id="rs-ignoredPaths" name="ignoredPaths" value={s.ignoredPaths} placeholder="e.g. **/*.generated.ts" describedBy="rs-ignoredPaths-help" /></Row>
            <fieldset className="check-group">
              <legend className="setting-title">Review categories</legend>
              <div className="check-grid">{categories.map((c) => <label key={c} className="check"><input type="checkbox" name="categories" value={c} defaultChecked={s.categories.includes(c)} />{c[0].toUpperCase() + c.slice(1)}</label>)}</div>
            </fieldset>
            <input type="hidden" name="threadRepliesConfigured" value="true" />
            <Row id="rs-threadReplies" title="Replies in OpenReview threads" help="Answer replies to OpenReview’s inline findings without an @openreview mention (GitHub; people with write access; never bots; at most 3 answers per thread and 10 per pull request each hour)."><Switch id="rs-threadReplies" name="threadReplies" on={s.threadReplies ?? true} /></Row>
            <input type="hidden" name="securityScanConfigured" value="true" />
            <Row id="rs-securityScan" title="Security checks" help="Run deterministic security checks on added lines (secrets, SQL concatenation, disabled TLS verification, dynamic code evaluation, shell commands, unsafe deserialization) and look up changed dependency versions in OSV.dev. Outbound requests can be turned off for the whole install with OSV_ENABLED=false."><Switch id="rs-securityScan" name="securityScan" on={s.securityScan ?? true} /></Row>
          </div>
        </div>

        <div id="review-checks" className="settings-group">
          <SettingsHeading icon="checkCircle" title="Status Checks" sub="Report each review as a check run on the pull request (GitHub)" />
          <div className="settings-card">
            <Row id="rs-checkFailureSeverity" title="GitHub check run" help="Fail the check when findings reach this severity.">
              <select key={s.checkFailureSeverity} id="rs-checkFailureSeverity" name="checkFailureSeverity" defaultValue={s.checkFailureSeverity ?? "off"} aria-describedby="rs-checkFailureSeverity-help"><option value="off">neutral (never fails)</option>{["critical", "high", "medium", "low"].map((v) => <option key={v} value={v}>fail at {v} or above</option>)}</select>
            </Row>
            <Row id="rs-checkMinimumScore" title="Check run minimum confidence" help="Fail the check when the review’s confidence score is below this.">
              <select key={s.checkMinimumScore} id="rs-checkMinimumScore" name="checkMinimumScore" defaultValue={String(s.checkMinimumScore ?? 0)} aria-describedby="rs-checkMinimumScore-help"><option value="0">off</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>fail below {n}/5</option>)}</select>
            </Row>
          </div>
        </div>

        <div id="review-tier" className="settings-group">
          <SettingsHeading icon="stack" title="Review Tier" sub="How deep each review goes, with which engine and model" />
          <div className="settings-card">
            <Row id="rs-mode" title="Depth" help={locked.includes("review.deep") ? "Deep is on the Pro plan; reviews run at standard until then." : undefined}><select key={s.mode} id="rs-mode" name="mode" defaultValue={s.mode}>{["fast", "standard", "deep", "auto"].map((v) => <option key={v}>{v}</option>)}</select></Row>
            <Locked feature="review.deep" locked={locked} note={deepNote}><Row id="rs-reviewEngine" title="Review engine"><select key={s.reviewEngine} id="rs-reviewEngine" name="reviewEngine" defaultValue={s.reviewEngine ?? "pipeline"}><option value="pipeline">pipeline (specialists)</option><option value="agentic">agentic (tool-calling, experimental)</option><option value="hypotheses">hypotheses (parallel investigations, experimental)</option></select></Row>
              <Row id="rs-model" title="Model override" help={<>Replaces the workspace model (<Link href="/dashboard/code-review/model">AI Model</Link>) for this repository.</>}><ModelSelect id="rs-model" name="model" value={s.model} models={models} empty="Workspace default" /></Row></Locked>
            <Row id="rs-maxReviewTier" title="Highest tier a request may use" help={<>People with write access can comment <code>@openreview review fast</code>, <code>standard</code> or <code>deep</code>, or add an <code>openreview:fast|standard|deep</code> label. A comment wins over a label, a label over the configured tier (which touched <code>.openreview/</code> folders can raise). This cap applies to all of them.</>}>
              <select key={s.maxReviewTier} id="rs-maxReviewTier" name="maxReviewTier" defaultValue={s.maxReviewTier ?? "deep"} aria-describedby="rs-maxReviewTier-help"><option value="deep">deep (no cap)</option><option value="standard">standard</option><option value="fast">fast</option></select>
            </Row>
          </div>
        </div>

        <div id="review-budgets" className="settings-group">
          <SettingsHeading icon="cpu" title="Agent Budgets" sub="Turn and tool-call limits for the agentic engine and each hypothesis" />
          <div className="settings-card"><Locked feature="review.deep" locked={locked} note={deepNote}>
            {([["agentTurns", "Agentic engine turns"], ["agentToolCalls", "Agentic engine tool calls"], ["hypothesisTurns", "Turns per hypothesis"], ["hypothesisToolCalls", "Tool calls per hypothesis"]] as const).map(([key, title]) =>
              <Row key={key} id={"rs-" + key} title={title}><Stepper id={"rs-" + key} name={key} min={0} max={1000} value={s[key] ?? 0} describedBy="rs-budgets-note" /></Row>)}
            <p className="card-note" id="rs-budgets-note">0 uses the review tier&apos;s default. Values are clamped to the operator&apos;s hard caps (AGENT_MAX_TURNS, AGENT_MAX_TOOL_CALLS); token and time budgets stay per tier. The review page shows the budget a review used.</p>
          </Locked></div>
        </div>

        <div id="review-agents" className="settings-group">
          <SettingsHeading icon="robot" title="Coding Agents" sub="Pull requests that coding agents write, and the fixes OpenReview opens" />
          <div className="settings-card">
            <Locked feature="review.deep" locked={locked} note={deepNote}><Row id="rs-aiAuthoredModel" title={<>Review model for agent-authored pull requests <span className="badge">Experimental</span></>} help="Detection uses explicit signals only: a known agent bot author, a Co-Authored-By trailer naming a coding agent, an agent branch prefix (claude/, copilot/, cursor/, codex/, devin/, jules/) or a marker the agent adds to the description. The reason is shown on the review.">
              <ModelSelect id="rs-aiAuthoredModel" name="aiAuthoredModel" value={s.aiAuthoredModel} models={models} empty="The usual model" />
            </Row></Locked>
            <Locked feature="fix.pullRequests" locked={locked}><input type="hidden" name="fixConfigured" value="true" />
            <Row id="rs-fixPullRequests" title="Fix pull requests" help="Allow “@openreview fix this in a new PR” to open a fix pull request on a new branch (GitHub, needs the Contents: Read and write permission; the pull request’s own branch is never written)."><Switch id="rs-fixPullRequests" name="fixPullRequests" on={s.fixPullRequests ?? false} /></Row></Locked>
          </div>
        </div>

        <div id="review-locks" className="settings-group">
          <SettingsHeading icon="lockSimple" title="Config File" sub={<>What the repository&apos;s <code>.openreview.json</code> may change</>} />
          <div className="settings-card">
            <Row title="Repository config file" help={config ? <>From base revision <code>{config.sha.slice(0, 7)}</code>: {config.files.map((f) => <code key={f}>{f} </code>)}{config.rules ? ` · ${config.rules} rules` : ""}</> : <>No <code>.openreview.json</code> or <code>.openreview/</code> configuration was found on a reviewed base branch yet.</>}>
              <span className={"status-chip" + (config ? " completed" : "")}><Icon name={config ? "check" : "fileText"} />{config ? "Found" : "Not found"}</span>
            </Row>
            {config?.warnings.map((w) => <p key={w} className="notice-banner" role="alert"><Icon name="warning" />{w}</p>)}
            <input type="hidden" name="lockedConfigured" value="true" />
            <fieldset className="check-group">
              <legend className="setting-title">Lock against the repository config file</legend>
              <p>Locked settings keep the values on this page even when the file sets them.</p>
              <div className="check-grid mono">{lockableKeys.map((key) => <label key={key} className="check"><input type="checkbox" name="lockedKeys" value={key} defaultChecked={(s.lockedKeys ?? []).includes(key)} />{key}</label>)}</div>
            </fieldset>
            <details className="effective-config"><summary>Effective configuration and sources</summary>
              <div className="table-box"><table><thead><tr><th>Setting</th><th>Value</th><th>Source</th></tr></thead><tbody>{lockableKeys.map((key) => {
                const fromFile = config?.applied.includes(key), blocked = config?.blocked.includes(key);
                const value = fromFile ? fileValues[key] : (s as Record<string, unknown>)[key];
                return <tr key={key}><td>{key}</td><td><code>{JSON.stringify(value ?? null).slice(0, 120)}</code></td><td>{fromFile ? "repository file" : (repoSettings.provenance[key] ?? "default") + ((s.lockedKeys ?? []).includes(key) ? " · locked" : "") + (blocked ? " (file value ignored)" : "")}</td></tr>;
              })}</tbody></table></div>
              {config?.cascade && (() => {
                const levels = JSON.parse(config.cascade) as { directory: string; sources: string[]; keys: string[]; ignore: number; include: number }[];
                return <><h3>Directory cascade</h3><p className="muted">Deeper <code>.openreview/</code> folders override shallower ones for files under them (categories, strictness, thresholds, ignore and include); the review tier and comment limit use the highest value among the directories a change touches. Locked settings never change.</p>
                  <div className="table-box"><table><thead><tr><th>Directory</th><th>Overrides</th><th>Files</th><th>Sources</th></tr></thead><tbody>{levels.map((l) => <tr key={l.directory}><td><code>{l.directory}</code></td><td>{l.keys.length ? l.keys.join(", ") : "—"}</td><td>{l.ignore || l.include ? `${l.ignore} ignore · ${l.include} include` : "—"}</td><td>{l.sources.map((src) => <code key={src}>{src} </code>)}</td></tr>)}</tbody></table></div></>;
              })()}
            </details>
          </div>
        </div>
      </fieldset>
      {isAdmin && <SaveBar />}
    </form>

    <div id="review-conventions" className="settings-group">
      <SettingsHeading icon="graduationCap" title="Learned Conventions" sub="Conventions OpenReview learns from human review comments" link={<Link className="heading-link" href={"/dashboard/context/learned?repository=" + repo._id}>Learned preferences<Icon name="arrowSquareOut" /></Link>} />
      <div className="settings-card">
        {/* Saved with the form above (form=…). Locked, the fieldset is disabled, so saving leaves the stored choice alone. */}
        <Locked feature="memory.conventions" locked={locked}><fieldset className="plain" disabled={!isAdmin}>
          <input type="hidden" name="conventionsConfigured" value="true" form={FORM} />
          <Row id="rs-autoApproveConventions" title="Auto-approve learned conventions" help="Approve conventions learned from human review comments automatically. They only add review guidance."><Switch id="rs-autoApproveConventions" name="autoApproveConventions" on={s.autoApproveConventions ?? false} form={FORM} /></Row>
        </fieldset></Locked>
        {conventions.length === 0 ? <p className="card-note">No conventions learned yet. OpenReview reads human review comments on merged pull requests daily and suggests recurring conventions here.</p> : <ul className="conventions" aria-label="Learned team conventions">{conventions.map((rule) => (
          <li key={rule._id}>
            <div><strong>{rule.text}</strong><p><span className={`badge ${rule.status === "approved" ? "low" : rule.status === "rejected" ? "critical" : "medium"}`}>{rule.status}</span> {rule.category} · seen {rule.frequency}× · {rule.evidence.map((e, i) => <a key={e.url} href={e.url} rel="noreferrer">{i ? ", " : ""}@{e.author}</a>)}</p></div>
            {isAdmin && <form action={decideConvention} className="inline-actions"><input type="hidden" name="ruleId" value={rule._id} />{rule.status !== "approved" && <button className="small" name="decision" value="approved">Approve</button>}{rule.status !== "rejected" && <button className="small" name="decision" value="rejected">Reject</button>}{rule.status === "approved" && <button className="small" name="decision" value="disabled">Disable</button>}</form>}
          </li>
        ))}</ul>}
      </div>
    </div>

    {semantic && <div id="review-retrieval" className="settings-group">
      <SettingsHeading icon="graph" title="Semantic Retrieval" sub="Embedding search over this repository’s code, beside full-text and code-graph retrieval" />
      <div className="settings-card">
        <Row title="Semantic retrieval" help={semantic.configured ? <>{semantic.model} · {semantic.chunks}{semantic.more ? "+" : ""} chunks across {semantic.files} files{semantic.stale ? ` · ${semantic.stale} chunks from another model are replaced on the next re-index` : ""}{!semantic.chunks ? " · re-index to build chunk embeddings" : ""}</> : <>Set <code>EMBEDDING_MODEL</code> (an OpenAI-compatible 1,536-dimension endpoint) in the backend environment and re-index; full-text and code-graph retrieval run either way.</>}>
          <span className={"status-chip" + (semantic.configured ? " completed" : "")}><Icon name={semantic.configured ? "check" : "x"} />{semantic.configured ? "On" : "Off"}</span>
        </Row>
      </div>
    </div>}
  </div>;
}
