#!/usr/bin/env npx tsx
/**
 * sync.ts — CLI bridge from agent skills to the web database.
 *
 * All release-decision skills use this script to read/write project state.
 * No skill should construct raw HTTP requests — always call sync.ts.
 *
 * COMMANDS
 * ─────────────────────────────────────────────────────────────────────────────
 *  get-experiment  <experimentId>
 *  update-state    <experimentId> --<field> "<value>" ...
 *  set-stage       <experimentId> <stage>
 *  add-activity    <experimentId> --type <type> --title "<title>" [--detail "..."]
 *
 *  create-run      <experimentId> <slug> [--field value ...]     (writes status=draft)
 *  start-run       <experimentId> <slug>                          (writes status=collecting)
 *  analyze-run     <experimentId> <slug>                          (writes status=analyzing)
 *  decide-run      <experimentId> <slug>                          (writes status=decided)
 *  archive-run     <experimentId> <slug>                          (writes status=archived)
 *  save-input      <experimentId> <slug> --inputData '<json>'
 *  save-result     <experimentId> <slug> --analysisResult '<json>'
 *  record-decision <experimentId> <slug> --decision <DECISION> --decisionSummary "..." [--decisionReason "..."]
 *  save-learning   <experimentId> <slug> --whatChanged "..." --whatHappened "..." [--confirmedOrRefuted "..." --whyItHappened "..." --nextHypothesis "..."]
 *
 * CANONICAL ENUMS (enforced by this script)
 * ─────────────────────────────────────────────────────────────────────────────
 *  stage:             intent | hypothesis | implementing | measuring | learning
 *  activity type:     stage_update | field_update | run_created | run_collecting |
 *                     run_analyzing | run_decided | run_archived |
 *                     decision_recorded | learning_captured
 *  run status:        draft | collecting | analyzing | decided | archived
 *  method:            bayesian_ab | frequentist | bandit
 *  decision:          CONTINUE | PAUSE | ROLLBACK | INCONCLUSIVE
 *  primaryMetricType: binary | continuous
 *  primaryMetricAgg:  once | count | sum | average
 *
 * FIELD FORMAT STANDARDS (for update-state)
 * ─────────────────────────────────────────────────────────────────────────────
 *  variants:      pipe-separated  →  "key1 (annotation1)|key2 (annotation2)"
 *                 e.g. "standard (control)|streamlined (treatment)"
 *  primaryMetric: plain text paragraph — event name + rationale for choosing it
 *  guardrails:    newline-separated list of guardrail descriptions (plain text)
 *
 * GUARDRAIL EVENTS (create-run / update fields)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Pass --guardrailEvents as comma-separated event names.
 *  sync.ts automatically converts to JSON array for storage.
 *  e.g. --guardrailEvents "checkout_abandoned,support_chat_open"
 *
 * Environment:
 *   SYNC_API_URL  — base URL of the web app (default: https://www.featbit.ai)
 *   ACCESS_TOKEN  — Bearer token sent as Authorization header. REQUIRED.
 *                   Issue one from the web UI: /data/env-settings → Agent
 *                   tokens → Issue token. The token is bound to the project
 *                   it was minted under; any sync.ts call against an
 *                   experiment in a different project returns 403.
 */

const API_BASE = process.env.SYNC_API_URL ?? "https://www.featbit.ai";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN ?? "";

// ── Canonical enums ───────────────────────────────────────────────────────────

const VALID_STAGES = new Set(["intent", "hypothesis", "implementing", "measuring", "learning"]);

const VALID_ACTIVITY_TYPES = new Set([
  "stage_update",
  "field_update",
  "run_created",
  "run_collecting",
  "run_analyzing",
  "run_decided",
  "run_archived",
  "decision_recorded",
  "learning_captured",
]);

// Run statuses are NOT exposed as a string parameter anywhere — each status
// has its own dedicated helper + CLI command (see setRunCollecting etc.).
// That way the agent can't misspell a status or use a value from the old
// enum (`running`, `paused`, `completed`). Kept here only for documentation.
// Canonical values: draft | collecting | analyzing | decided | archived

const VALID_METHODS = new Set(["bayesian_ab", "frequentist", "bandit"]);

const VALID_DECISIONS = new Set(["CONTINUE", "PAUSE", "ROLLBACK", "INCONCLUSIVE"]);

// Single canonical vocabulary used by ALL paths (run columns AND state JSON).
// Use these everywhere — never reintroduce the legacy "numeric" / "last" /
// "count-only" subsets, which used to differ between run and state writes.
const VALID_METRIC_TYPES = new Set(["binary", "continuous"]);

const VALID_METRIC_AGG = new Set(["once", "count", "sum", "average"]);

// Fields allowed in update-state
const ALLOWED_STATE_FIELDS = new Set([
  "goal", "intent", "hypothesis", "change", "variants",
  "primaryMetric", "guardrails", "constraints",
  "openQuestions", "lastAction", "lastLearning", "flagKey",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recognise flags. Primarily expects `--key value` pairs, but tolerates
 * `key value` pairs when the bare name matches one of the known fields
 * (union of all field sets used across commands). LLMs have a habit of
 * dropping the `--` prefix; this safety net keeps calls from silently
 * doing nothing.
 */
const KNOWN_BARE_FIELDS = new Set<string>([
  ...ALLOWED_STATE_FIELDS,
  "type", "title", "detail",
  "hypothesis", "method", "methodReason",
  "primaryMetricEvent", "primaryMetricType", "primaryMetricAgg",
  "metricDescription", "guardrailEvents", "guardrailDescriptions",
  "controlVariant", "treatmentVariant", "trafficAllocation",
  "minimumSample", "observationStart", "observationEnd",
  "priorProper", "priorMean", "priorStddev",
  "trafficPercent", "trafficOffset", "layerId", "audienceFilters",
  "inputData", "analysisResult",
  "decision", "decisionSummary", "decisionReason",
  "whatChanged", "whatHappened", "confirmedOrRefuted",
  "whyItHappened", "nextHypothesis",
]);

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = "true";
      }
      continue;
    }
    // Lenient mode: bare `<fieldName> <value>` with no `--` prefix.
    if (KNOWN_BARE_FIELDS.has(arg)) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        console.error(
          `[warn] flag "${arg}" was given without the required "--" prefix; accepted for safety. Always use "--${arg}".`,
        );
        result[arg] = next;
        i++;
      }
    }
  }
  return result;
}

function requireEnum(value: string, valid: Set<string>, name: string): void {
  if (!valid.has(value)) {
    console.error(`Invalid ${name}: "${value}". Valid values: ${[...valid].join(" | ")}`);
    process.exit(1);
  }
}

/** Convert comma-separated event names to JSON array string for DB storage */
function guardrailEventsToJson(csv: string): string {
  const events = csv.split(",").map((e) => e.trim()).filter(Boolean);
  return JSON.stringify(events);
}

async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  options?: { exitOnError?: boolean }
): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const exitOnError = options?.exitOnError ?? true;
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    if (ACCESS_TOKEN) headers["Authorization"] = `Bearer ${ACCESS_TOKEN}`;
    res = await fetch(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (exitOnError) {
      console.error(`Unable to reach sync API at ${API_BASE}. ${message}`);
      process.exit(1);
    }
    return null;
  }

  const data = await res.json();
  if (!res.ok) {
    if (exitOnError) {
      console.error(`ERROR ${res.status}:`, data);
      process.exit(1);
    }
    return null;
  }
  return data;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function getExperiment(experimentId: string) {
  const experiment = await api("GET", `/api/experiments/${experimentId}`, undefined, {
    exitOnError: false,
  });
  if (experiment === null) {
    console.log(
      JSON.stringify(
        { status: "unavailable", experimentId, message: "Database unreachable — treat as blank experiment" },
        null,
        2
      )
    );
    return;
  }
  console.log(JSON.stringify(experiment, null, 2));
}

const GUARDRAIL_DIRECTIONS = new Set(["increase_bad", "decrease_bad"]);

/**
 * Validate the shape of a primaryMetric / guardrail JSON object. The web UI
 * renders name/event/metricType/metricAgg as separate columns, so all four
 * fields are required. `description` is optional free text.
 */
function validateMetricObject(
  obj: unknown,
  kind: "primaryMetric" | "guardrail entry",
  requireDirection: boolean,
): string[] {
  const errs: string[] = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    errs.push(`${kind} must be a JSON object, not ${typeof obj}.`);
    return errs;
  }
  const o = obj as Record<string, unknown>;
  for (const key of ["name", "event"]) {
    if (typeof o[key] !== "string" || !o[key]) {
      errs.push(`${kind}.${key} is required (non-empty string).`);
    }
  }
  if (typeof o.metricType !== "string" || !VALID_METRIC_TYPES.has(o.metricType)) {
    errs.push(
      `${kind}.metricType must be one of: ${[...VALID_METRIC_TYPES].join(" | ")}`,
    );
  }
  if (typeof o.metricAgg !== "string" || !VALID_METRIC_AGG.has(o.metricAgg)) {
    errs.push(
      `${kind}.metricAgg must be one of: ${[...VALID_METRIC_AGG].join(" | ")}`,
    );
  }
  if (requireDirection) {
    if (
      typeof o.direction !== "string" ||
      !GUARDRAIL_DIRECTIONS.has(o.direction)
    ) {
      errs.push(
        `${kind}.direction must be one of: ${[...GUARDRAIL_DIRECTIONS].join(" | ")}`,
      );
    }
  }
  if (o.description !== undefined && typeof o.description !== "string") {
    errs.push(`${kind}.description must be a string if provided.`);
  }
  return errs;
}

async function updateState(experimentId: string, flags: Record<string, string>) {
  if (Object.keys(flags).length === 0) {
    console.error("No state fields provided. Use --goal, --intent, --hypothesis, etc.");
    console.error(`Allowed fields: ${[...ALLOWED_STATE_FIELDS].join(", ")}`);
    process.exit(1);
  }
  // Validate variants format if provided
  if (flags.variants && flags.variants.includes("{")) {
    console.error('variants must be pipe-separated: "key1 (annotation1)|key2 (annotation2)"');
    console.error('Example: --variants "standard (control)|streamlined (treatment)"');
    process.exit(1);
  }
  // Validate primaryMetric JSON shape if provided
  if (flags.primaryMetric !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.primaryMetric);
    } catch {
      console.error(
        `--primaryMetric must be a JSON object with fields {name, event, metricType, metricAgg, description?}.`,
      );
      console.error(
        `Example: --primaryMetric '{"name":"Signup conversion","event":"signup_completed","metricType":"binary","metricAgg":"once","description":"..."}'`,
      );
      process.exit(1);
    }
    const errs = validateMetricObject(parsed, "primaryMetric", false);
    if (errs.length > 0) {
      for (const e of errs) console.error(e);
      process.exit(1);
    }
  }
  // Validate guardrails JSON array shape if provided
  if (flags.guardrails !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.guardrails);
    } catch {
      console.error(
        `--guardrails must be a JSON array of objects: [{name, event, metricType, metricAgg, direction, description?}, ...]`,
      );
      console.error(
        `Example: --guardrails '[{"name":"Checkout abandonment","event":"checkout_abandoned","metricType":"binary","metricAgg":"once","direction":"increase_bad"}]'`,
      );
      process.exit(1);
    }
    if (!Array.isArray(parsed)) {
      console.error("--guardrails must be a JSON array (use [] for no guardrails).");
      process.exit(1);
    }
    const allErrs: string[] = [];
    parsed.forEach((entry, i) => {
      const errs = validateMetricObject(entry, `guardrail[${i}]`, true);
      allErrs.push(...errs);
    });
    if (allErrs.length > 0) {
      for (const e of allErrs) console.error(e);
      process.exit(1);
    }
  }
  // Filter to only allowed fields
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (ALLOWED_STATE_FIELDS.has(key)) body[key] = value;
  }
  if (Object.keys(body).length === 0) {
    console.error(`None of the provided fields are valid. Allowed: ${[...ALLOWED_STATE_FIELDS].join(", ")}`);
    process.exit(1);
  }
  const result = await api("PUT", `/api/experiments/${experimentId}/state`, body);
  console.log(JSON.stringify(result, null, 2));
}

async function setStage(experimentId: string, stage: string) {
  requireEnum(stage, VALID_STAGES, "stage");
  const result = await api("PUT", `/api/experiments/${experimentId}/stage`, { stage });
  console.log(JSON.stringify(result, null, 2));
}

async function addActivity(experimentId: string, flags: Record<string, string>) {
  const { type, title, detail } = flags;
  if (!type || !title) {
    console.error("--type and --title are required.");
    process.exit(1);
  }
  requireEnum(type, VALID_ACTIVITY_TYPES, "activity type");
  const result = await api("POST", `/api/experiments/${experimentId}/activity`, { type, title, detail });
  console.log(JSON.stringify(result, null, 2));
}

/** Build the body for create-run / any run update, applying type coercions and validations */
function buildRunBody(flags: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (key === "minimumSample") {
      body[key] = parseInt(value, 10);
    } else if (key === "priorProper") {
      body[key] = value === "true" || value === "1";
    } else if (key === "priorMean" || key === "priorStddev" || key === "trafficPercent") {
      body[key] = parseFloat(value);
    } else if (key === "trafficOffset") {
      body[key] = parseInt(value, 10);
    } else if (key === "observationStart" || key === "observationEnd") {
      body[key] = new Date(value).toISOString();
    } else if (key === "guardrailEvents") {
      // Accept comma-separated; convert to JSON array for storage
      body[key] = guardrailEventsToJson(value);
    } else if (key === "method") {
      requireEnum(value, VALID_METHODS, "method");
      body[key] = value;
    } else if (key === "primaryMetricType") {
      requireEnum(value, VALID_METRIC_TYPES, "primaryMetricType");
      body[key] = value;
    } else if (key === "primaryMetricAgg") {
      requireEnum(value, VALID_METRIC_AGG, "primaryMetricAgg");
      body[key] = value;
    } else {
      body[key] = value;
    }
  }
  return body;
}

async function createRun(experimentId: string, slug: string, flags: Record<string, string>) {
  const body = { slug, status: "draft", ...buildRunBody(flags) };
  const result = await api("POST", `/api/experiments/${experimentId}/experiment-run`, body);
  console.log(JSON.stringify(result, null, 2));
}

// ── Run status transitions (one helper per status, no string param) ──────────
//
// Each helper writes a single hardcoded status value. The agent cannot pass
// a wrong or out-of-enum status, because no status string crosses the CLI
// boundary — the command name IS the status.

async function setRunCollecting(experimentId: string, slug: string) {
  const result = await api("POST", `/api/experiments/${experimentId}/experiment-run`, { slug, status: "collecting" });
  console.log(JSON.stringify(result, null, 2));
}

async function setRunAnalyzing(experimentId: string, slug: string) {
  const result = await api("POST", `/api/experiments/${experimentId}/experiment-run`, { slug, status: "analyzing" });
  console.log(JSON.stringify(result, null, 2));
}

async function setRunDecided(experimentId: string, slug: string) {
  const result = await api("POST", `/api/experiments/${experimentId}/experiment-run`, { slug, status: "decided" });
  console.log(JSON.stringify(result, null, 2));
}

async function setRunArchived(experimentId: string, slug: string) {
  const result = await api("POST", `/api/experiments/${experimentId}/experiment-run`, { slug, status: "archived" });
  console.log(JSON.stringify(result, null, 2));
}

async function saveInput(experimentId: string, slug: string, flags: Record<string, string>) {
  if (!flags.inputData) {
    console.error("--inputData is required (JSON string of collected metrics).");
    process.exit(1);
  }
  // Validate it is valid JSON
  try { JSON.parse(flags.inputData); } catch {
    console.error("--inputData must be a valid JSON string.");
    process.exit(1);
  }
  const result = await api("POST", `/api/experiments/${experimentId}/experiment-run`, {
    slug,
    inputData: flags.inputData,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function saveResult(experimentId: string, slug: string, flags: Record<string, string>) {
  if (!flags.analysisResult) {
    console.error("--analysisResult is required (JSON string from Bayesian analysis).");
    process.exit(1);
  }
  try { JSON.parse(flags.analysisResult); } catch {
    console.error("--analysisResult must be a valid JSON string.");
    process.exit(1);
  }
  const result = await api("POST", `/api/experiments/${experimentId}/experiment-run`, {
    slug,
    analysisResult: flags.analysisResult,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function recordDecision(experimentId: string, slug: string, flags: Record<string, string>) {
  if (!flags.decision) {
    console.error("--decision is required.");
    console.error(`Valid values: ${[...VALID_DECISIONS].join(" | ")}`);
    process.exit(1);
  }
  requireEnum(flags.decision, VALID_DECISIONS, "decision");
  if (!flags.decisionSummary) {
    console.error("--decisionSummary is required (plain-language action).");
    process.exit(1);
  }
  const body: Record<string, unknown> = {
    slug,
    decision: flags.decision,
    decisionSummary: flags.decisionSummary,
  };
  if (flags.decisionReason) body.decisionReason = flags.decisionReason;
  const result = await api("POST", `/api/experiments/${experimentId}/experiment-run`, body);
  console.log(JSON.stringify(result, null, 2));
}

async function saveLearning(experimentId: string, slug: string, flags: Record<string, string>) {
  const LEARNING_FIELDS = ["whatChanged", "whatHappened", "confirmedOrRefuted", "whyItHappened", "nextHypothesis"];
  const body: Record<string, unknown> = { slug };
  for (const field of LEARNING_FIELDS) {
    if (flags[field]) body[field] = flags[field];
  }
  if (Object.keys(body).length === 1) {
    console.error(`At least one learning field is required: ${LEARNING_FIELDS.join(", ")}`);
    process.exit(1);
  }
  const result = await api("POST", `/api/experiments/${experimentId}/experiment-run`, body);
  console.log(JSON.stringify(result, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

function printHelp() {
  const abs = "$HOME/.claude/skills/project-sync/scripts/sync.ts";
  console.log(`project-sync / sync.ts — CLI bridge to the FeatBit web DB.

INVOCATION (always absolute path — cwd on sandbox0 VMs is /workspace):
  npx tsx ${abs} <command> [args]

All flag arguments REQUIRE the "--" prefix. e.g. --primaryMetric, not bare primaryMetric.

COMMANDS:
  get-experiment  <experimentId>
  update-state    <experimentId> [--goal "..."] [--intent "..."] [--hypothesis "..."]
                                 [--change "..."] [--variants "key (ann)|key (ann)"]
                                 [--primaryMetric '<json>'] [--guardrails '<json-array>']
                                 [--constraints "..."] [--openQuestions "..."]
                                 [--lastAction "..."] [--lastLearning "..."] [--flagKey "..."]
  set-stage       <experimentId> <intent|hypothesis|implementing|measuring|learning>
  add-activity    <experimentId> --type <activity-type> --title "..." [--detail "..."]
  create-run      <experimentId> <slug> [--hypothesis "..."] [--method bayesian_ab|frequentist|bandit]
                                        [--primaryMetricEvent <event>] [--primaryMetricType binary|continuous]
                                        [--primaryMetricAgg once|sum|last]
                                        [--controlVariant <v>] [--treatmentVariant <v>]
                                        [--guardrailEvents "evt1,evt2"] [--minimumSample N]
                                        [--trafficPercent N] [--priorProper true|false]
                                        [--priorMean f] [--priorStddev f]
                                        [--observationStart ISO] [--observationEnd ISO]
  start-run       <experimentId> <slug>    (writes status=collecting)
  analyze-run     <experimentId> <slug>    (writes status=analyzing)
  decide-run      <experimentId> <slug>    (writes status=decided)
  archive-run     <experimentId> <slug>    (writes status=archived)
  save-input      <experimentId> <slug> --inputData '<json>'
  save-result     <experimentId> <slug> --analysisResult '<json>'
  record-decision <experimentId> <slug> --decision CONTINUE|PAUSE|ROLLBACK|INCONCLUSIVE
                                        --decisionSummary "..." [--decisionReason "..."]
  save-learning   <experimentId> <slug> --whatChanged "..." --whatHappened "..."
                                        [--confirmedOrRefuted "..."] [--whyItHappened "..."]
                                        [--nextHypothesis "..."]

STATE FIELD FORMATS (on project state via update-state):
  variants        pipe-separated string  — "standard (control)|streamlined (treatment)"
  primaryMetric   JSON object            — {"name","event","metricType","metricAgg","description"?}
                                           metricType: binary | continuous
                                           metricAgg:  once | count | sum | average
  guardrails      JSON array             — [{"name","event","metricType","metricAgg","direction","description"?}, ...]
                                           direction: increase_bad | decrease_bad

EXAMPLE:
  npx tsx ${abs} update-state 84fbc6b8-5817-... \\
    --primaryMetric '{"name":"Signup conversion","event":"signup_completed","metricType":"binary","metricAgg":"once","description":"Proportion of visitors that sign up."}'
`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "--help" || command === "-h" || command === "help" || !command) {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case "get-experiment": {
      const [experimentId] = rest;
      if (!experimentId) { console.error("Usage: sync.ts get-experiment <experiment-id>"); process.exit(1); }
      await getExperiment(experimentId);
      break;
    }
    case "update-state": {
      const [experimentId, ...flagArgs] = rest;
      if (!experimentId) { console.error("Usage: sync.ts update-state <experiment-id> --goal '...'"); process.exit(1); }
      await updateState(experimentId, parseArgs(flagArgs));
      break;
    }
    case "set-stage": {
      const [experimentId, stage] = rest;
      if (!experimentId || !stage) { console.error(`Usage: sync.ts set-stage <experiment-id> <stage>\nValid: ${[...VALID_STAGES].join(" | ")}`); process.exit(1); }
      await setStage(experimentId, stage);
      break;
    }
    case "add-activity": {
      const [experimentId, ...flagArgs] = rest;
      if (!experimentId) { console.error("Usage: sync.ts add-activity <experiment-id> --type <type> --title '...'"); process.exit(1); }
      await addActivity(experimentId, parseArgs(flagArgs));
      break;
    }
    case "create-run": {
      const [experimentId, slug, ...flagArgs] = rest;
      if (!experimentId || !slug) { console.error("Usage: sync.ts create-run <experiment-id> <slug> [--field value ...]"); process.exit(1); }
      await createRun(experimentId, slug, parseArgs(flagArgs));
      break;
    }
    case "start-run": {
      const [experimentId, slug] = rest;
      if (!experimentId || !slug) { console.error("Usage: sync.ts start-run <experiment-id> <slug>"); process.exit(1); }
      await setRunCollecting(experimentId, slug);
      break;
    }
    case "analyze-run": {
      const [experimentId, slug] = rest;
      if (!experimentId || !slug) { console.error("Usage: sync.ts analyze-run <experiment-id> <slug>"); process.exit(1); }
      await setRunAnalyzing(experimentId, slug);
      break;
    }
    case "decide-run": {
      const [experimentId, slug] = rest;
      if (!experimentId || !slug) { console.error("Usage: sync.ts decide-run <experiment-id> <slug>"); process.exit(1); }
      await setRunDecided(experimentId, slug);
      break;
    }
    case "archive-run": {
      const [experimentId, slug] = rest;
      if (!experimentId || !slug) { console.error("Usage: sync.ts archive-run <experiment-id> <slug>"); process.exit(1); }
      await setRunArchived(experimentId, slug);
      break;
    }
    case "save-input": {
      const [experimentId, slug, ...flagArgs] = rest;
      if (!experimentId || !slug) { console.error("Usage: sync.ts save-input <experiment-id> <slug> --inputData '<json>'"); process.exit(1); }
      await saveInput(experimentId, slug, parseArgs(flagArgs));
      break;
    }
    case "save-result": {
      const [experimentId, slug, ...flagArgs] = rest;
      if (!experimentId || !slug) { console.error("Usage: sync.ts save-result <experiment-id> <slug> --analysisResult '<json>'"); process.exit(1); }
      await saveResult(experimentId, slug, parseArgs(flagArgs));
      break;
    }
    case "record-decision": {
      const [experimentId, slug, ...flagArgs] = rest;
      if (!experimentId || !slug) { console.error("Usage: sync.ts record-decision <experiment-id> <slug> --decision CONTINUE --decisionSummary '...'"); process.exit(1); }
      await recordDecision(experimentId, slug, parseArgs(flagArgs));
      break;
    }
    case "save-learning": {
      const [experimentId, slug, ...flagArgs] = rest;
      if (!experimentId || !slug) { console.error("Usage: sync.ts save-learning <experiment-id> <slug> --whatChanged '...' --whatHappened '...'"); process.exit(1); }
      await saveLearning(experimentId, slug, parseArgs(flagArgs));
      break;
    }
    default: {
      console.error(`Unknown command: ${command ?? "(none)"}`);
      console.error("Commands:");
      console.error("  get-experiment  <experimentId>");
      console.error("  update-state    <experimentId> --<field> '<value>' ...");
      console.error("  set-stage       <experimentId> <stage>");
      console.error("  add-activity    <experimentId> --type <type> --title '<title>'");
      console.error("  create-run      <experimentId> <slug> [--field value ...]");
      console.error("  start-run       <experimentId> <slug>   (status=collecting)");
      console.error("  analyze-run     <experimentId> <slug>   (status=analyzing)");
      console.error("  decide-run      <experimentId> <slug>   (status=decided)");
      console.error("  archive-run     <experimentId> <slug>   (status=archived)");
      console.error("  save-input      <experimentId> <slug> --inputData '<json>'");
      console.error("  save-result     <experimentId> <slug> --analysisResult '<json>'");
      console.error("  record-decision <experimentId> <slug> --decision <DECISION> --decisionSummary '<text>'");
      console.error("  save-learning   <experimentId> <slug> --whatChanged '<text>' ...");
      process.exit(1);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`sync.ts failed: ${message}`);
  process.exit(1);
});
