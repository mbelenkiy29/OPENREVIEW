"use client";
import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Shows the one-shot message a server action left in the `openreview_toast` cookie, then clears it.
export function Toaster() {
  const pathname = usePathname(), params = useSearchParams();
  const [toast, setToast] = useState<{ text: string; tone: string } | null>(null);
  useEffect(() => { take(setToast); }, [pathname, params]);
  // An action that returns to the same URL (or only revalidates) changes neither, so watch briefly after each submit.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const watch = () => { clearInterval(timer); let tries = 0; timer = setInterval(() => { if (take(setToast) || ++tries > 40) clearInterval(timer); }, 250); };
    document.addEventListener("submit", watch, true);
    return () => { document.removeEventListener("submit", watch, true); clearInterval(timer); };
  }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast]);
  if (!toast) return null;
  return <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} aria-live="polite"><span>{toast.text}</span><button type="button" className="small" aria-label="Dismiss" onClick={() => setToast(null)}>×</button></div>;
}

function take(show: (toast: { text: string; tone: string }) => void) {
  const raw = document.cookie.split("; ").find((c) => c.startsWith("openreview_toast="))?.slice("openreview_toast=".length);
  if (!raw) return false;
  document.cookie = "openreview_toast=; Max-Age=0; Path=/; SameSite=Lax";
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as { text?: unknown; tone?: unknown };
    if (typeof value.text === "string") show({ text: value.text.slice(0, 200), tone: value.tone === "error" ? "error" : "success" });
  } catch { /* ignore malformed */ }
  return true;
}
