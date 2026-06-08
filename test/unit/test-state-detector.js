/**
 * Automated test for state detection transitions.
 * Simulates Claude-like output in tmux and verifies state detection.
 *
 * Usage: node test/unit/test-state-detector.js
 * Requires: server running on localhost:3000
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";
import http from "http";

const API = "http://localhost:3000";
const TEST_ID = "test-state";
const TMUX = `hadron-${TEST_ID}`;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname, headers: {} };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
    }
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getState() {
  const sessions = await api("GET", "/api/sessions");
  const s = sessions.find(s => s.id === TEST_ID);
  return s ? { state: s.state, blockReason: s.blockReason } : null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function tmuxSend(text) {
  // Write command to temp file and paste into tmux to avoid shell quoting issues
  writeFileSync("/tmp/hadron-test-cmd.txt", text);
  execSync(`tmux load-buffer /tmp/hadron-test-cmd.txt`);
  execSync(`tmux paste-buffer -t ${TMUX}`);
  execSync(`tmux send-keys -t ${TMUX} Enter`);
}

function tmuxCtrlC() {
  execSync(`tmux send-keys -t ${TMUX} C-c`);
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.log(`  ✗ FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

async function run() {
  console.log("=== State Detector Tests ===\n");

  // Cleanup any previous test
  try { await api("DELETE", `/api/sessions/${TEST_ID}`); } catch {}
  try { execSync(`tmux kill-session -t ${TMUX} 2>/dev/null`); } catch {}

  // Create tmux session
  execSync(`tmux new-session -d -s ${TMUX} -x 120 -y 30`);

  // Create agent via API
  await api("POST", "/api/sessions", { name: TEST_ID, role: "worker", task: "state test" });
  await sleep(1000);

  let s = await getState();
  assert(s && s.state === "idle", `Initial state is idle (got: ${s?.state})`);

  // --- Test 1: idle → working ---
  console.log("\n[Test 1] idle → working");
  // Start a node process (matches AGENT_PROCESS_RE) that prints continuously
  tmuxSend("node -e 'setInterval(() => console.log(Date.now()), 1000)'");
  // Skip period (10s) + changed threshold (6s) + buffer
  await sleep(19000);

  s = await getState();
  assert(s.state === "working", `Content changing → working (got: ${s.state})`);

  // --- Test 2: working → done ---
  console.log("\n[Test 2] working → done");
  // Stop output, start a quiet node process
  tmuxCtrlC();
  await sleep(500);
  tmuxSend("node -e 'setTimeout(() => {}, 120000)'");
  // Wait for unchanged threshold (6s) + buffer
  await sleep(10000);

  s = await getState();
  assert(s.state === "done", `Content settled → done (got: ${s.state})`);

  // --- Test 3: done stays stable ---
  console.log("\n[Test 3] done stays stable");
  await sleep(5000);
  s = await getState();
  assert(s.state === "done", `Still done after 5s (got: ${s.state})`);

  // --- Test 4: working → blocked (needs input) ---
  console.log("\n[Test 4] working → blocked (needs input)");
  // Reset to idle and clear cooldown
  await api("PATCH", `/api/sessions/${TEST_ID}`, { state: "idle" });
  await sleep(6000);

  // Output for 15s (enough to enter working), then print blocked pattern and stay alive
  tmuxCtrlC();
  await sleep(500);
  tmuxSend("node -e 'let i=setInterval(()=>console.log(Date.now()),1000);setTimeout(()=>{clearInterval(i);console.log(\"Enter to select · Esc to cancel\");setTimeout(()=>{},120000)},15000)'");
  await sleep(28000);

  s = await getState();
  assert(s.state === "blocked", `Blocked pattern detected (got: ${s.state})`);
  assert(s.blockReason === "Needs input", `Reason is "Needs input" (got: ${s.blockReason})`);

  // --- Test 5: blocked → working (user unblocks, content changes) ---
  console.log("\n[Test 5] blocked → working (unblocked)");
  tmuxCtrlC();
  await sleep(500);
  tmuxSend("node -e 'setInterval(() => console.log(Date.now()), 1000)'");
  await sleep(10000);

  s = await getState();
  assert(s.state === "working", `Blocked → working after unblock (got: ${s.state})`);

  // --- Test 6: working → blocked (API error) ---
  console.log("\n[Test 6] working → blocked (API error)");
  tmuxCtrlC();
  await sleep(500);
  tmuxSend("node -e 'let i=setInterval(()=>console.log(Date.now()),1000);setTimeout(()=>{clearInterval(i);console.log(\"API Error: 429\");setTimeout(()=>{},120000)},15000)'");
  await sleep(28000);

  s = await getState();
  assert(s.state === "blocked", `API error pattern detected (got: ${s.state})`);
  assert(s.blockReason === "API error", `Reason is "API error" (got: ${s.blockReason})`);

  // --- Test 7: blocked → working → done (user unblocks and content settles) ---
  console.log("\n[Test 7] blocked → working → done (resolved)");
  tmuxCtrlC();
  await sleep(500);
  // Longer output then quiet — blocked→working (content changes), then working→done (settles)
  tmuxSend("node -e 'let i=0;let t=setInterval(()=>{console.log(i++);if(i>12){clearInterval(t);setTimeout(()=>{},120000)}},1000)'");
  await sleep(28000);

  s = await getState();
  assert(s.state === "done", `Blocked → working → done (got: ${s.state})`);

  // --- Cleanup ---
  console.log("\n=== Cleanup ===");
  tmuxCtrlC();
  try { await api("DELETE", `/api/sessions/${TEST_ID}`); } catch {}
  try { execSync(`tmux kill-session -t ${TMUX} 2>/dev/null`); } catch {}
  console.log("  ✓ Test session cleaned up");

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error("Test error:", e.message);
  try { execSync(`tmux kill-session -t ${TMUX} 2>/dev/null`); } catch {}
  process.exit(1);
});
