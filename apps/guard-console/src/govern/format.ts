import type { BadgeTone } from "@vibtra/ui/react";

export const hoursOf = (minutes: number): string => `${(Math.round((minutes / 60) * 10) / 10).toLocaleString("en-US")} h`;

export const dollarsOf = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const relativeTo = (iso: string, now: number = Date.now()): string => {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return "unknown";
  const future = ms >= 0;
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60_000);
  const words = minutes < 1 ? "now" : minutes < 90 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / (60 * 24))} days`;
  if (words === "now") return "just now";
  return future ? `in ${words}` : `${words} ago`;
};

export const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  stopped: "Stopped",
  starting: "Starting",
  stopping: "Stopping",
  failed: "Failed",
  "quota-stopping": "Stopping at a limit",
};

export const PHASES = ["starting", "running", "stopping", "quota-stopping", "stopped", "failed"] as const;

export const statusTone = (status: string): BadgeTone =>
  status === "running" ? "ok" : status === "failed" ? "danger" : status === "starting" || status === "stopping" || status === "quota-stopping" ? "warn" : "neutral";
