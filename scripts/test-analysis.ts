// Dev tool — NOT part of the API. Runs one real chart image through the live
// analysis pipeline (POST /api/analyses on a locally running API) and prints
// everything the model produced, for repeated use while tuning prompts.
//
//   pnpm tsx scripts/test-analysis.ts ~/Downloads/test-chart.png
//
// Deliberately leaves the created analyses row and storage object behind: the
// point is to inspect the result afterwards. The analysis id is printed so it
// can be looked up or deleted manually.
//
// Config (SUPABASE_URL / keys) is read through apps/api's own env module so
// this script and the API can never disagree about which project they target.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { env } from "../apps/api/src/lib/env.js";
import { supabaseAdmin } from "../apps/api/src/lib/supabase.js";

const API_URL = process.env["API_URL"] ?? "http://localhost:3000";
const POLL_INTERVAL_MS = 2_000;
// 2 minutes by default: the currently configured reasoning model routinely
// takes 22-60+ seconds on a real chart, so the original 30s default timed out
// on normal runs and needed a manual override every time. Still overridable,
// and a timeout here says nothing about whether the analysis eventually
// succeeded — re-read the row to find out.
const POLL_TIMEOUT_MS = Number(process.env["POLL_TIMEOUT_MS"] ?? 120_000);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const imagePath = process.argv[2];
if (!imagePath) {
  fail("Usage: pnpm tsx scripts/test-analysis.ts <path-to-chart-image>");
}

const testEmail = process.env["TEST_USER_EMAIL"];
const testPassword = process.env["TEST_USER_PASSWORD"];
if (!testEmail || !testPassword) {
  fail(
    [
      "Missing TEST_USER_EMAIL and/or TEST_USER_PASSWORD.",
      "",
      "Create a confirmed test user in Supabase Auth (Dashboard > Authentication",
      "> Users > Add user, with 'Auto Confirm User' enabled), then set both",
      "variables in apps/api/.env:",
      "",
      "  TEST_USER_EMAIL=you+test@example.com",
      "  TEST_USER_PASSWORD=<that user's password>",
    ].join("\n"),
  );
}

function show(label: string, value: unknown): void {
  const rendered =
    value === null || value === undefined
      ? "—"
      : Array.isArray(value)
        ? value.length > 0
          ? value.join(", ")
          : "—"
        : String(value);
  console.log(`  ${label.padEnd(18)} ${rendered}`);
}

async function main(): Promise<void> {
  const resolvedPath = path.resolve(
    imagePath!.startsWith("~")
      ? path.join(process.env["HOME"] ?? "", imagePath!.slice(1))
      : imagePath!,
  );
  const ext = path.extname(resolvedPath).toLowerCase();
  const mimetype = MIME_BY_EXT[ext];
  if (!mimetype) {
    fail(`Unsupported image extension '${ext}'. Use .png, .jpg, .jpeg or .webp.`);
  }
  const bytes = await readFile(resolvedPath);
  console.log(`Image: ${resolvedPath} (${bytes.byteLength} bytes, ${mimetype})`);

  // Anon-key client, exactly like a browser: signInWithPassword yields a real
  // user access token, so the request exercises the API's own auth middleware.
  const supabaseAnon = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: signIn, error: signInError } = await supabaseAnon.auth.signInWithPassword({
    email: testEmail!,
    password: testPassword!,
  });
  if (signInError || !signIn.session) {
    fail(`Sign-in failed for ${testEmail}: ${signInError?.message ?? "no session returned"}`);
  }
  console.log(`Signed in as ${testEmail}`);

  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)], { type: mimetype }), path.basename(resolvedPath));
  form.append("sourceType", "upload");

  const started = Date.now();
  const response = await fetch(`${API_URL}/api/analyses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signIn.session.access_token}` },
    body: form,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    fail(`POST /api/analyses -> ${response.status} ${JSON.stringify(body)}`);
  }
  const { id, status } = body as { id: string; status: string };
  console.log(`POST /api/analyses -> ${response.status} { id: ${id}, status: ${status} }`);

  let row: Record<string, unknown> | null = null;
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const { data, error } = await supabaseAdmin.from("analyses").select("*").eq("id", id).single();
    if (error) fail(`Failed to read analyses row ${id}: ${error.message}`);
    row = data;
    console.log(`  [${Math.round((Date.now() - started) / 1000)}s] status=${String(row?.["status"])}`);
    if (row?.["status"] === "complete" || row?.["status"] === "failed") break;
  }

  if (!row || (row["status"] !== "complete" && row["status"] !== "failed")) {
    fail(`Timed out after ${POLL_TIMEOUT_MS / 1000}s; analysis ${id} is still ${String(row?.["status"])}.`);
  }

  console.log(`\n=== Analysis ${id} — ${String(row["status"])} ===`);

  if (row["status"] === "failed") {
    show("error_code", row["error_code"]);
    show("error_message", row["error_message"]);
  } else {
    show("symbol", row["symbol"]);
    show("symbol_raw", row["symbol_raw"]);
    show("asset_class", row["asset_class"]);
    show("timeframe", row["timeframe"]);
    show("trend", row["trend"]);
    show("volatility", row["volatility"]);
    show("volume", row["volume_reading"]);
    show("sentiment", row["sentiment"]);
    show("support", row["support_levels"]);
    show("resistance", row["resistance_levels"]);
    console.log("  call");
    show("  direction", row["call_direction"]);
    show("  confidence", row["call_confidence"]);
    show("  entry", row["call_entry"]);
    show("  invalidation", row["call_invalidation"]);
    show("  target", row["call_target"]);
    show("  horizon", row["horizon_candles"]);
    console.log(`\n  summary: ${String(row["summary"] ?? "—")}`);

    const { data: patterns, error: patternsError } = await supabaseAdmin
      .from("analysis_patterns")
      .select("pattern_key, confidence, pattern_note")
      .eq("analysis_id", id)
      .order("confidence", { ascending: false });
    if (patternsError) fail(`Failed to read analysis_patterns: ${patternsError.message}`);
    console.log(`\n  patterns (${patterns?.length ?? 0}):`);
    for (const p of patterns ?? []) {
      console.log(`    - ${p.pattern_key} (${p.confidence ?? "—"}): ${p.pattern_note ?? "—"}`);
    }
  }

  console.log("\n  meta");
  show("  model_id", row["model_id"]);
  show("  prompt_version", row["prompt_version"]);
  show("  tokens", `${String(row["input_tokens"])} in / ${String(row["output_tokens"])} out`);
  show("  cost_usd", row["cost_usd"]);
  show("  latency_ms", row["latency_ms"]);
  show("  image_key", row["image_key"]);

  // Not cleaned up on purpose — inspect it, and delete it manually if wanted.
  console.log(`\nAnalysis id (row and storage object left in place): ${id}`);
}

main().catch((cause) => fail(String(cause)));
