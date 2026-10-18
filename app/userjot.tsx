"use client";
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import type { Theme } from "../src/theme";
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
  getState(): { session?: { status?: string } };
  createEmbed(options: { container: Element; basePath?: string; path?: string; theme?: SdkTheme }): Embed;
};
declare global { interface Window { uj?: Sdk; $ujq?: unknown[][] } }

const sdkUrl = "https://cdn.userjot.com/sdk/v3/uj.js";
const sdkTheme = (theme: Theme): SdkTheme => theme === "system" ? "auto" : theme;
// Resolves with the loaded SDK. Created up front so embeds rendered before the loader can wait on it.
let loaded: (sdk: Sdk) => void = () => {};
const ready = typeof window === "undefined" ? null : new Promise<Sdk>((resolve) => { loaded = resolve; });
let installed = false;

function install(projectId: string, theme: Theme) {
  if (installed) return;
  installed = true;
  // UserJot's loader stub: calls queue until the module loads and replays them.
  window.uj ||= new Proxy({} as Sdk, { get: (_, p) => p === "then" ? 0 : (...a: unknown[]) => { (window.$ujq ||= []).push([p, ...a]); } });
  window.uj.init(projectId, { widget: { position: "right", theme: sdkTheme(theme) }, pageContext: "origin" });
  window.uj.on("ready", () => loaded(window.uj!));
  document.head.appendChild(Object.assign(document.createElement("script"), { src: sdkUrl, type: "module", async: true }));
}

/** Loads the widget and tells it who is signed in (by internal id; see app/api/userjot/identity). */
export function UserJot({ projectId }: { projectId: string }) {
  const theme = useTheme(), initialTheme = useRef(theme);
  useEffect(() => {
    install(projectId, initialTheme.current);
    const controller = new AbortController();
    fetch("/api/userjot/identity", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const identity = response.status === 200 ? await response.json() as { token?: string; user: object } : null;
      const sdk = await ready!;
      if (identity) await sdk.identify(identity);
      else if (sdk.getState().session?.status === "identified") await sdk.logout();
    }).catch((error) => { if (!controller.signal.aborted) console.warn("UserJot identify failed", error); });
    return () => controller.abort();
  }, [projectId]);
  useEffect(() => { window.uj?.setTheme(sdkTheme(theme)); }, [theme]);
  return null;
}

/** Opens the widget, or the feedback page when the widget never loaded. */
export function openUserJot(target: Target) {
  if (!window.uj) return location.assign("/feedback");
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
  const theme = useTheme();
  useEffect(() => {
    let embed: Embed | undefined, cancelled = false;
    void ready?.then((sdk) => { if (!cancelled && container.current) embed = sdk.createEmbed({ container: container.current, basePath, theme: sdkTheme(theme) }); });
    return () => { cancelled = true; embed?.destroy(); };
  }, [basePath, theme]);
  return <div ref={container} className="board-embed" data-userjot-embed />;
}

/** Forgets the signed-in user in the widget (sign-out). */
export function userJotLogout() {
  if (window.uj) void Promise.resolve(window.uj.logout()).catch(() => {});
}
