"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import type { Theme } from "../src/theme";
import { boardTitle, boardView, withoutEmbedTheme } from "../src/userjot-board";
import { useTheme } from "./theme";

// UserJot widget v3 (https://userjot.com/docs/widget-v3-reference): feature requests, bug reports,
// the roadmap and updates. Loaded once from the root layout when src/userjot.ts is configured.
type SdkTheme = "auto" | "light" | "dark";
type Target = { to: "feedback"; compose?: boolean } | { to: "home" | "roadmap" | "updates" };
type Embed = { navigate(path: string): void; destroy(): void };
type Sdk = {
  init(projectId: string, options?: object): void;
  identify(input: { token?: string; user?: object }): Promise<unknown>;
  logout(): Promise<void>;
  open(target?: Target): Promise<void>;
  setTheme(theme: SdkTheme): void;
  on(event: "ready", listener: () => void): () => void;
  on(event: "error", listener: (error?: { code?: string }) => void): () => void;
  getState(): { session?: { status?: string } };
  createEmbed(options: { container: Element; basePath?: string; path?: string; theme?: SdkTheme }): Embed;
};
declare global { interface Window { uj?: Sdk; $ujq?: unknown[][] } }

const sdkUrl = "https://cdn.userjot.com/sdk/v3/uj.js";
// Identity tokens last an hour (src/userjot.ts), so a tab open longer than this identifies again
// the next time it is viewed.
const identityRefresh = 45 * 60_000;
const sdkTheme = (theme: Theme): SdkTheme => theme === "system" ? "auto" : theme;
// Resolves with the loaded SDK. Created up front so embeds rendered before the loader can wait on it.
let loaded: (sdk: Sdk) => void = () => {};
const ready = typeof window === "undefined" ? null : new Promise<Sdk>((resolve) => { loaded = resolve; });
let installed = false, failed = false, fallbackUrl = "/feedback";

function install(projectId: string, theme: Theme, boardUrl?: string) {
  if (installed) return;
  installed = true;
  if (boardUrl) fallbackUrl = boardUrl;
  // UserJot's loader stub: calls queue until the module loads and replays them.
  window.uj ||= new Proxy({} as Sdk, { get: (_, p) => p === "then" ? 0 : (...a: unknown[]) => { (window.$ujq ||= []).push([p, ...a]); } });
  window.uj.init(projectId, { widget: { position: "right", theme: sdkTheme(theme) }, pageContext: "origin" });
  window.uj.on("ready", () => loaded(window.uj!));
  // A blocked script, or an SDK that cannot start, leaves only the stub, which would quietly queue
  // every open() call; openUserJot sends people to the board instead.
  window.uj.on("error", (error) => { if (error?.code === "BOOTSTRAP_FAILED") failed = true; });
  document.head.appendChild(Object.assign(document.createElement("script"), { src: sdkUrl, type: "module", async: true, onerror: () => { failed = true; } }));
}

/** Loads the widget and tells it who is signed in (by internal id; see app/api/userjot/identity). */
export function UserJot({ projectId, boardUrl }: { projectId: string; boardUrl?: string }) {
  const theme = useTheme(), initialTheme = useRef(theme);
  useEffect(() => {
    install(projectId, initialTheme.current, boardUrl);
    let controller: AbortController | undefined, identifiedAt = 0;
    const identify = () => {
      controller?.abort();
      const { signal } = controller = new AbortController();
      identifiedAt = Date.now();
      fetch("/api/userjot/identity", { cache: "no-store", signal }).then(async (response) => {
        const identity = response.status === 200 ? await response.json() as { token?: string; user: object } : null;
        const sdk = await ready!;
        if (signal.aborted) return;
        if (identity) await sdk.identify(identity);
        else if (sdk.getState().session?.status === "identified") await sdk.logout();
      }).catch((error) => { if (!signal.aborted) console.warn("UserJot identify failed", error); });
    };
    const refresh = () => { if (document.visibilityState === "visible" && Date.now() - identifiedAt > identityRefresh) identify(); };
    identify();
    document.addEventListener("visibilitychange", refresh);
    return () => { controller?.abort(); document.removeEventListener("visibilitychange", refresh); };
  }, [projectId, boardUrl]);
  useEffect(() => { window.uj?.setTheme(sdkTheme(theme)); }, [theme]);
  return null;
}

/** Opens the widget, or the board when the widget could not load. */
export function openUserJot(target: Target) {
  if (!window.uj || failed) return location.assign(fallbackUrl);
  void Promise.resolve(window.uj.open(target)).catch(() => {});
}

/** A button that opens the widget's feedback form, closing the menu it sits in. */
export function UserJotButton({ children, className }: { children: ReactNode; className?: string }) {
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest("details")?.removeAttribute("open");
    openUserJot({ to: "feedback", compose: true });
  };
  return <button type="button" className={className} onClick={open}>{children}</button>;
}

/** The public board inside this page; the browser URL follows it under `basePath`. */
export function UserJotEmbed({ basePath }: { basePath: string }) {
  const container = useRef<HTMLDivElement>(null);
  const theme = useTheme(), pathname = usePathname();
  useEffect(() => {
    let embed: Embed | undefined, cancelled = false;
    void ready?.then((sdk) => {
      if (cancelled || !container.current) return;
      const url = withoutEmbedTheme(location.href);
      if (url) history.replaceState(null, "", url);
      embed = sdk.createEmbed({ container: container.current, basePath, theme: sdkTheme(theme) });
    });
    return () => { cancelled = true; embed?.destroy(); };
  }, [basePath, theme]);
  // Browsing the embed changes the URL without a navigation, so the layout's title template is
  // applied here too.
  useEffect(() => { document.title = `${boardTitle(pathname)} · OpenReview`; }, [pathname]);
  return <div ref={container} className="board-embed" data-userjot-embed />;
}

/** The header's Roadmap and Feedback links, marked current from the URL the embed keeps in sync. */
export function BoardNavLinks() {
  const view = boardView(usePathname());
  return <>
    <Link href="/feedback/roadmap" aria-current={view === "roadmap" ? "page" : undefined}>Roadmap</Link>
    <Link href="/feedback" aria-current={view === "feedback" ? "page" : undefined}>Feedback</Link>
  </>;
}

/** Forgets the signed-in user in the widget (sign-out). */
export function userJotLogout() {
  if (window.uj) void Promise.resolve(window.uj.logout()).catch(() => {});
}
