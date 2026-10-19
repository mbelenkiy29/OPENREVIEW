"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export function Live({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [active, router]);
  return active ? (
    <span className="live" role="status">
      Updating automatically
    </span>
  ) : null;
}
export function Copy({
  value,
  label = "Copy fix prompt",
  failedLabel = "Copy failed; select the prompt below",
}: {
  value: string;
  label?: string;
  failedLabel?: string;
}) {
  return (
    <button
      onClick={async (event) => {
        const target = event.currentTarget;
        try {
          await navigator.clipboard.writeText(value);
          target.textContent = "Copied";
        } catch {
          target.textContent = failedLabel;
        }
      }}
    >
      {label}
    </button>
  );
}
