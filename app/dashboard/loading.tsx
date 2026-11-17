import { Skeleton } from "../ui";
import { Mark } from "../ui/logo";

export default function Loading() {
  return <div className="shell portal">
    <div className="portal-top" aria-hidden="true">
      <div className="portal-identity"><span className="brand"><Mark /></span></div>
    </div>
    <main id="main" className="content page">
      <header className="page-header"><div><p className="muted">Loading</p><h1>Loading…</h1></div></header>
      <Skeleton lines={5} label="Loading dashboard" />
    </main>
  </div>;
}
