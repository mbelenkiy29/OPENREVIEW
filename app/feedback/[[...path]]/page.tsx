import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { userJotConfig } from "../../../src/userjot";
import { boardTitle } from "../../../src/userjot-board";
import { SiteFooter, SiteHeader } from "../../site-chrome";
import { UserJotButton, UserJotEmbed } from "../../userjot";

type Props = { params: Promise<{ path?: string[] }> };
const description = "Request features, report bugs, vote on what comes next and follow the OpenReview roadmap.";
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { path = [] } = await params;
  return { title: boardTitle(`/feedback/${path.join("/")}`), description };
}
// The public UserJot board inside the site: posts, votes and the roadmap. Deep links such as
// /feedback/roadmap and /feedback/board/p/<post> open that view (UserJotEmbed keeps the URL in sync).
// Posting goes through the widget, which knows who is signed in.
export default function Feedback() {
  const config = userJotConfig();
  if (!config) notFound();
  return <div className="docs-layout single">
    <SiteHeader />
    <main className="board-page">
      <header className="board-intro">
        <div>
          <h1>Feedback</h1>
          <p className="muted">{description}</p>
        </div>
        <div className="board-actions">
          <UserJotButton className="primary">Request a feature</UserJotButton>
          <UserJotButton>Report a bug</UserJotButton>
        </div>
      </header>
      <UserJotEmbed basePath="/feedback" />
      {config.boardUrl && <p className="muted board-note">Prefer a full page? <a href={config.boardUrl}>Open the board on UserJot</a>.</p>}
    </main>
    <SiteFooter />
  </div>;
}
