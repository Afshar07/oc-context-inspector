// Asserts what the plugin recorded during e2e/run.sh. Reads the data directory only; exits 1 on any failed check.
// Usage: node e2e/assert.mjs <dataDir>
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: node e2e/assert.mjs <dataDir>");
  process.exit(2);
}

const failures = [];
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures.push(`${name}${detail ? `\n    ${detail}` : ""}`);
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const sessionFiles = readdirSync(dataDir).filter((n) => n.endsWith(".jsonl"));
const markers = existsSync(path.join(dataDir, "sessions"))
  ? readdirSync(path.join(dataDir, "sessions")).filter((n) => n.endsWith(".json")).map((n) => readJson(path.join(dataDir, "sessions", n)))
  : [];

// sessionID -> records
const bySession = new Map();
for (const file of sessionFiles) {
  const records = readFileSync(path.join(dataDir, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  bySession.set(file.slice(0, -".jsonl".length), records);
}

const scenarioOf = (record) => /^call_SCENARIO-([A-Z])_\d+$/.exec(record.callID)?.[1];

// --- session isolation: every session file holds the calls of exactly one scripted session ----------------------
const scenarioSession = new Map();
for (const [sessionID, records] of bySession) {
  const scenarios = new Set(records.map(scenarioOf));
  check(`session ${sessionID} holds a single scenario`, scenarios.size === 1, `found ${[...scenarios].join(",")}`);
  for (const r of records) check(`record sessionID matches its file (${r.callID})`, r.sessionID === sessionID);
  const [scenario] = scenarios;
  check(`scenario ${scenario} is not split over several sessions`, !scenarioSession.has(scenario));
  scenarioSession.set(scenario, sessionID);
}
eq("scenarios with records", [...scenarioSession.keys()].sort(), ["A", "B", "C", "E", "S"]);

const records = (scenario) => bySession.get(scenarioSession.get(scenario)) ?? [];
const forFile = (scenario, filePath) => records(scenario).filter((r) => r.filePath === filePath);
const ranges = (list) => list.map((r) => r.requestedRange);
const delivered = (list) => list.map((r) => (r.delivered ? [r.delivered.range?.start, r.delivered.range?.end] : null));

// --- A: repeated reads, a failed read, an excluded path ---------------------------------------------------------
eq("A: records (src/app.ts is not a context path, so 6 of 7 reads are recorded)", records("A").length, 6);
eq("A: nothing recorded for the excluded path", forFile("A", "src/app.ts").length, 0);
eq("A: AGENTS.md read twice, in order", forFile("A", "AGENTS.md").map((r) => r.status), ["completed", "completed"]);
eq("A: AGENTS.md requested ranges", ranges(forFile("A", "AGENTS.md")), [{}, {}]);
eq("A: AGENTS.md delivered lines", delivered(forFile("A", "AGENTS.md")), [[1, 3], [1, 3]]);
check("A: AGENTS.md read reached the end of the file", forFile("A", "AGENTS.md").every((r) => r.delivered?.reachedEof && r.delivered.fileLines === 3));
eq("A: architecture.md requested ranges", ranges(forFile("A", ".ai/architecture.md")), [{ offset: 10, limit: 20 }, { offset: 10, limit: 20 }, { offset: 30, limit: 10 }]);
eq("A: architecture.md delivered lines", delivered(forFile("A", ".ai/architecture.md")), [[10, 29], [10, 29], [30, 39]]);
check("A: paged architecture.md reads did not claim the end of the file", forFile("A", ".ai/architecture.md").every((r) => r.delivered && !r.delivered.reachedEof));
const [missing] = forFile("A", ".ai/missing.md");
eq("A: failed read is recorded as an error", missing?.status, "error");
check("A: failed read carries a message", /not found/i.test(missing?.errorMessage ?? ""), String(missing?.errorMessage));
check("A: failed read has no delivered range or fingerprint", missing && !("delivered" in missing) && !("fileAtRead" in missing));
check("A: successful reads carry a file fingerprint", records("A").filter((r) => r.status === "completed").every((r) => r.fileAtRead?.sizeBytes > 0 && r.fileAtRead?.mtimeMs > 0));

// --- B: concurrent session sees only its own reads --------------------------------------------------------------
eq("B: records", records("B").length, 2);
eq("B: style.md range", [ranges(forFile("B", ".ai/style.md")), delivered(forFile("B", ".ai/style.md"))], [[{ limit: 5 }], [[1, 5]]]);
eq("B: AGENTS.md range", [ranges(forFile("B", "AGENTS.md")), delivered(forFile("B", "AGENTS.md"))], [[{ offset: 2 }], [[2, 3]]]);
check("B has none of A's files", forFile("B", ".ai/architecture.md").length === 0 && forFile("B", ".ai/missing.md").length === 0);

// --- C: empty file, out-of-range offset, whole file longer than a page, last page, offset 0 ------------------------
eq("C: records", records("C").length, 5);
const [empty] = forFile("C", ".ai/empty.md");
eq("C: empty file delivered nothing and was reported empty", [empty?.delivered?.lineCount, empty?.delivered?.reachedEof, empty?.delivered?.fileLines], [0, true, 0]);
eq("C: offset past the end is an error", forFile("C", ".ai/short.md").map((r) => r.status), ["error"]);
const longReads = forFile("C", ".ai/long.md");
eq("C: long.md delivered lines (whole file is NOT capped at a 2000-line page)", delivered(longReads), [[1, 2500], [2400, 2500], [1, 2000]]);
eq("C: long.md reached-end flags", longReads.map((r) => r.delivered?.reachedEof), [true, true, false]);
eq("C: long.md total lines when the end was reached", longReads.map((r) => r.delivered?.fileLines), [2500, 2500, undefined]);

// --- E / S: delegation. S is a child of E. (Stock subagents cannot spawn agents, so nesting is covered by unit tests only.) ---
const lead = scenarioSession.get("E");
const sub = scenarioSession.get("S");
check("E and S are different sessions", lead && sub && lead !== sub);
check("lead agent is attributed", records("E").every((r) => typeof r.agentID === "string" && r.agentID !== ""), JSON.stringify(records("E").map((r) => r.agentID)));
check("lead session is a root session", records("E").every((r) => r.lineage === "root" && !("parentSessionID" in r)));
check("subagent is attributed", records("S").every((r) => typeof r.agentID === "string" && r.agentID !== ""), JSON.stringify(records("S").map((r) => r.agentID)));
check("subagent session is a child of the lead session", records("S").every((r) => r.lineage === "child" && r.parentSessionID === lead), JSON.stringify(records("S").map((r) => [r.lineage, r.parentSessionID])));
eq("S: reads", records("S").map((r) => [r.filePath, r.delivered?.range?.start, r.delivered?.range?.end]), [["AGENTS.md", 1, 3], [".ai/architecture.md", 1, 10]]);
eq("E: its own read (the subagent's reads are not its own)", records("E").map((r) => [r.filePath, r.delivered?.range?.end]), [[".ai/style.md", 3]]);
check("original call IDs are preserved", records("S").every((r) => /^call_SCENARIO-S_\d+$/.test(r.callID)));

// --- session tracking: zero-read sessions are observed too --------------------------------------------------------
eq("observed sessions: A-F plus the subagents S and N (D, F and N read no context)", markers.length, 8);
const markerIDs = new Set(markers.map((m) => m.sessionID));
check("every session with records is also marked as observed", [...bySession.keys()].every((id) => markerIDs.has(id)));
eq("exactly three observed sessions have no records (D, F, N)", [...markerIDs].filter((id) => !bySession.has(id)).length, 3);
check("session markers carry a lineage", markers.every((m) => m.lineage === "root" || m.lineage === "child"), JSON.stringify(markers.map((m) => m.lineage)));
// F delegates to N, which only reads a non-context file: a subagent with zero context reads must still be a known child.
const children = markers.filter((m) => m.lineage === "child");
eq("two child sessions", children.length, 2);
check("S is a child of E", children.some((m) => m.sessionID === sub && m.parentSessionID === lead));
const zeroRead = children.find((m) => m.sessionID !== sub);
check("N (zero context reads) is a child of a root session that also read nothing", zeroRead !== undefined && markers.some((m) => m.sessionID === zeroRead.parentSessionID && m.lineage === "root") && !bySession.has(zeroRead.sessionID) && !bySession.has(zeroRead.parentSessionID));
check("tracking start is recorded", existsSync(path.join(dataDir, "tracking.json")));

// --- privacy: no file contents on disk ----------------------------------------------------------------------------
const everything = [...sessionFiles.map((f) => readFileSync(path.join(dataDir, f), "utf8")), ...markers.map((m) => JSON.stringify(m))].join("\n");
for (const secret of ["Use TypeScript", "architecture line", "line 1234"]) {
  check(`file contents are not persisted (${secret})`, !everything.includes(secret));
}

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks failed:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`${checks} checks passed`);
