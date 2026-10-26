import Link from "next/link";
import { IdentityLeft, PrimaryTabs } from "./tabs";
import { WorkspaceMenu } from "./workspace-menu";
import { PortalDisclosure } from "./portal-disclosure";
import { UserJotButton } from "../userjot";
import { userJotConfig } from "../../src/userjot";
import {ThemePicker} from "../theme";
import { SignOutForm } from "../telemetry-identity";
import { Mark } from "../ui/logo";
import { Icon } from "../ui/icons";
import { logout, openBillingPortal } from "./actions";
import { referralConfig } from "../../src/referrals";

// The app chrome, rendered once by the portal layout and kept mounted across navigations: Greptile's
// trial banner, identity row (organization menu, icon buttons, account menu) and the eight tabs.
export function PortalNav({ login, avatar, email, role, organizationId, name, organizations, teams, savedTeam, trialDaysLeft, billingPortal }: { login: string; avatar?: string; email?: string; role: string; organizationId: string; name: string; organizations: { _id: string; name: string }[]; teams: { _id: string; name: string }[]; savedTeam?: string; trialDaysLeft?: number; billingPortal?: boolean }) {
  const feedback = Boolean(userJotConfig()), referrals = referralConfig().enabled;
  // The provider's avatar, at most 45px: next/image would need every avatar host allow-listed for no gain.
  // eslint-disable-next-line @next/next/no-img-element
  const photo = (size: number) => avatar ? <img className="avatar" src={avatar} alt="" width={size} height={size} /> : <Icon name="user" />;
  return <div className="portal-top">
    {/* Admins go straight to the Stripe billing portal, like Payment Details' button (a failure lands on Billing
        with an alert); others go to Payment Details. A plain link to Billing did nothing on the Billing page itself. */}
    {trialDaysLeft !== undefined && <div className="trial-banner"><span>{trialDaysLeft} {trialDaysLeft === 1 ? "day" : "days"} left in your free trial!</span>
      {billingPortal ? <form action={openBillingPortal}><input type="hidden" name="organizationId" value={organizationId} /><button className="button small"><Icon name="plus" />Add Payment Method</button></form>
        : <Link className="button small" href="/dashboard/organization/billing#payment-heading"><Icon name="plus" />Add Payment Method</Link>}</div>}
    <div className="portal-identity">
      <IdentityLeft><Link className="brand" href="/dashboard" aria-label="OpenReview home"><Mark /></Link><WorkspaceMenu organizationId={organizationId} name={name} role={role} organizations={organizations} teams={teams} savedTeam={savedTeam} /></IdentityLeft>
      <div className="header-actions">
        <Link className="header-button" href="/dashboard/chat" title="Chat"><Icon name="chatCircle" /><span className="sr-only">Chat</span></Link>
        <Link className="header-button" href="/docs" title="Docs"><Icon name="bookOpen" /><span className="sr-only">Docs</span></Link>
        {referrals && <Link className="header-button" href="/dashboard/account/referrals" title="Refer someone"><Icon name="gift" /><span className="sr-only">Refer someone</span></Link>}
        <PortalDisclosure className="profile" label={<>{photo(27)}<span className="sr-only">Account menu for @{login}</span></>}>
          <div className="menu user-menu">
            <div className="user-card">{avatar ? photo(45) : <span className="avatar placeholder"><Icon name="user" /></span>}<div><strong>{login}</strong><span>{email ?? `@${login}`}</span></div></div>
            <hr />
            <Link className="menu-item" href="/dashboard/account"><Icon name="gear" />Settings</Link>
            <Link className="menu-item" href="/dashboard/onboarding"><Icon name="listChecks" />Workspace setup</Link>
            {feedback && <><UserJotButton className="menu-item">Request a feature</UserJotButton><UserJotButton className="menu-item">Report a bug</UserJotButton><Link className="menu-item" href="/feedback/roadmap">Roadmap</Link></>}
            <div className="menu-theme"><ThemePicker /></div>
            <hr />
            <SignOutForm action={logout} label="Logout" className="menu-item danger" icon={<Icon name="signOut" />} />
          </div>
        </PortalDisclosure>
      </div>
    </div>
    <PrimaryTabs />
  </div>;
}
