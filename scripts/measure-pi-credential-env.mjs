#!/usr/bin/env node
// OF-279: re-measure the Pi credential table (PI_FULLY_DEFINED_CREDENTIAL_ENV in packages/daemon/src/adapters/pi-readiness.ts).
//   node scripts/measure-pi-credential-env.mjs <path to an installed Pi's node_modules/@earendil-works/pi-ai/dist>
// Loads Pi's builtin providers and, for each, finds the minimal sets of environment names that make its api-key resolver return a
// credential (dummy values, no file checks, no network, nothing read from any login). A provider with no set is oauth-only
// (openai-codex); a provider whose resolver also checks files (google-vertex, amazon-bedrock) is ambient and stays out of the table.
// Compare the output with the table by hand; where a credential needs several names together, the table lists them all (any one exempts).
import fs from "node:fs"; import path from "node:path";
const D = process.argv[2];
if (!D) { console.error("usage: measure-pi-credential-env.mjs <pi-ai dist dir>"); process.exit(2); }
const { builtinProviders } = await import(path.resolve(D, "providers/all.js"));
// candidate names: every ALL_CAPS string literal in providers/, api/, auth/, env-api-keys.js
const cands = new Set();
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "data") walk(p); } else if (e.name.endsWith(".js")) for (const m of fs.readFileSync(p, "utf8").matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) cands.add(m[1]); } };
for (const sub of ["providers", "api", "auth"]) walk(path.join(D, sub));
for (const m of fs.readFileSync(path.join(D, "env-api-keys.js"), "utf8").matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) cands.add(m[1]);
const names = [...cands].sort();
const sig = new AbortController().signal;
const out = {};
const providers = builtinProviders();
for (const p of providers) {
  const auth = p.auth ?? {};
  const kinds = Object.keys(auth);
  const ak = auth.apiKey;
  const res = async (set) => { if (!ak) return false; const ctx = { env: async (n) => (set.has(n) ? "dummy" : undefined), fileExists: async () => false }; try { return !!(await ak.resolve({ ctx, credential: undefined, signal: sig })); } catch { return false; } };
  const sets = [];
  let pool = new Set(names);
  // find sufficient sets: take the whole pool; if it resolves, shrink greedily to a minimal set; remove one member of it from the pool (try each) to find alternatives
  const minimal = async (start) => { let cur = new Set(start); for (const n of [...cur]) { cur.delete(n); if (!(await res(cur))) cur.add(n); } return cur; };
  const found = [];
  const explore = async (poolSet, depth) => {
    if (depth > 4 || !(await res(poolSet))) return;
    const m = await minimal(poolSet);
    const key = [...m].sort().join("+");
    if (found.some((f) => f.join("+") === key)) return;
    found.push([...m].sort());
    for (const n of m) { const next = new Set(poolSet); next.delete(n); await explore(next, depth + 1); }
  };
  await explore(pool, 0);
  out[p.id] = { kinds, minimalSufficientEnvSets: found };
}
console.log(JSON.stringify(out, null, 1));
