#!/usr/bin/env npx tsx
/**
 * analyze.ts — trigger a fresh analysis for an experiment run.
 *
 * Thin HTTP wrapper around the web app's POST /api/experiments/:id/analyze.
 * The server-side endpoint queries track-service for the latest metrics,
 * runs the Bayesian or Bandit algorithm (picked from the run's `method`
 * field), and writes both `inputData` and `analysisResult` back to the
 * run record. This script exists so SKILL.md / references don't have to
 * spell out raw curl invocations.
 *
 * Usage:
 *   npx tsx $HOME/.claude/skills/experiment-workspace/scripts/analyze.ts <experiment-id> <run-id> [--no-fresh]
 *
 * `--no-fresh` lets the server return a cached `analysisResult` if
 * track-service is temporarily unavailable. Default is `forceFresh: true`.
 *
 * Environment:
 *   SYNC_API_URL — base URL of the web app (default: https://www.featbit.ai)
 */

const API_BASE = process.env.SYNC_API_URL ?? "https://www.featbit.ai";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  const [experimentId, runId] = positional;

  if (!experimentId || !runId) {
    console.error("Usage: npx tsx $HOME/.claude/skills/experiment-workspace/scripts/analyze.ts <experiment-id> <run-id> [--no-fresh]");
    process.exit(1);
  }

  const forceFresh = !flags.has("--no-fresh");
  const url = `${API_BASE}/api/experiments/${experimentId}/analyze`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, forceFresh }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Unable to reach analyze endpoint at ${API_BASE}. ${msg}`);
    process.exit(1);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`ERROR ${res.status}:`, body);
    process.exit(1);
  }

  // Server may return:
  //   { analysisResult, inputData }           — successful analysis
  //   { status: "no_data", reason: "..." }    — no events yet / zero users
  //   { warning: "...", stale: true, ... }    — cached fallback
  console.log(JSON.stringify(body, null, 2));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`analyze.ts failed: ${msg}`);
  process.exit(1);
});
