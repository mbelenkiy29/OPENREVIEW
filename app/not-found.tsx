import Link from "next/link";
import { Mark } from "./ui/logo";

export default function NotFound() {
  return <main id="main" className="welcome"><Link className="brand" href="/"><Mark /> OpenReview</Link><h1>Page not found</h1><p>The page you asked for does not exist.</p><p><Link className="button primary" href="/">Go home</Link> <Link className="button" href="/docs/quickstart">Read the docs</Link></p></main>;
}
