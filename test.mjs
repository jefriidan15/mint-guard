// MintGuard tests — read-only checks against real mainnet contracts.
// Spawns the server on :3001, asserts structured results, kills it.
// Usage: node test.mjs
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:3001";
const VERDICTS = ["FREE", "PAID", "REVERTS", "UNVERIFIED", "UNKNOWN"];
let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; results.push(`PASS ${name}`); }
  else { fail++; results.push(`FAIL ${name} ${detail}`); }
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, json };
}

async function waitHealthz(tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + "/healthz");
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server = spawn("node", ["server.mjs"], { env: { ...process.env, PORT: "3001" }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });

try {
  check("server boots", await waitHealthz(), "(healthz never 200)");

  // docs + healthz
  const docs = await fetch(BASE + "/");
  check("GET / returns docs", docs.ok, `status ${docs.status}`);
  const docsJson = await docs.json();
  check("docs mention keyless", /keyless/i.test(JSON.stringify(docsJson)));

  // --- real contracts (BSC mainnet) ---
  const real = [
    { name: "Claf Eye", contract: "0x1c759C4e075103b5B250DB5114B832b17B99C456" },
    { name: "Paper Snake", contract: "0xEbeA35ec1a30045361E6e5147D2ede2080b334b0" },
    { name: "OinkHash pigs", contract: "0x56155fd1818b31256E7f435956D6dff5C732f35f" },
  ];
  for (const t of real) {
    const { status, json } = await post("/check", { contract: t.contract });
    check(`${t.name}: HTTP 200`, status === 200, `status ${status} ${JSON.stringify(json)?.slice(0, 150)}`);
    check(`${t.name}: verdict in enum`, VERDICTS.includes(json?.verdict), `verdict=${json?.verdict}`);
    check(`${t.name}: code exists`, json?.evidence?.code === true, `code=${json?.evidence?.code}`);
    check(`${t.name}: verified flag is boolean`, typeof json?.evidence?.verified === "boolean", `verified=${json?.evidence?.verified}`);
    check(`${t.name}: mintProbes is an array`, Array.isArray(json?.evidence?.mintProbes));
    check(`${t.name}: warnings is an array`, Array.isArray(json?.warnings));
    if (t.name === "OinkHash pigs") {
      check("OinkHash: verified on Sourcify (exact_match)", json?.evidence?.verified === true, `verified=${json?.evidence?.verified} match=${json?.evidence?.sourcifyMatch}`);
      check("OinkHash: price getter found (mintPrice 0.0015 BNB)", json?.price === "1500000000000000", `price=${json?.price} from=${json?.evidence?.priceFrom}`);
    }
    console.log(`  ${t.name}: verdict=${json?.verdict} price=${json?.price} priceFrom=${json?.evidence?.priceFrom} verified=${json?.evidence?.verified} abiFns=${json?.evidence?.abiFunctions} probes=${JSON.stringify(json?.evidence?.mintProbes?.map((p) => p.fn + ":" + (p.ok ? "ok" : "revert:" + (p.error || "").slice(0, 40))))}`);
  }

  // --- wallet allowances (W2) against one contract ---
  const w = await post("/check", { contract: real[2].contract, wallet: "0x04dAc94DcE888E4cf60E7093fb6cD84352fC0656" });
  check("wallet check: HTTP 200", w.status === 200, `status ${w.status}`);
  check("wallet check: allowances array", Array.isArray(w.json?.evidence?.allowances), "no allowances array");
  if (Array.isArray(w.json?.evidence?.allowances)) {
    check("wallet check: 5 tokens probed", w.json.evidence.allowances.length === 5, `got ${w.json.evidence.allowances.length}`);
    console.log(`  allowances: ${JSON.stringify(w.json.evidence.allowances.map((a) => a.token + "=" + a.allowance))}`);
  }

  // --- negative tests ---
  const eoa = await post("/check", { contract: "0x000A0fEF6fe5fAc91eFc239e2342fd691A2a8531" });
  check("EOA as contract: HTTP 200 + UNKNOWN", eoa.status === 200 && eoa.json?.verdict === "UNKNOWN", `status ${eoa.status} verdict=${eoa.json?.verdict}`);
  check("EOA as contract: code false", eoa.json?.evidence?.code === false, `code=${eoa.json?.evidence?.code}`);

  const garbage = await post("/check", { contract: "notanaddress" });
  check("garbage contract: HTTP 400", garbage.status === 400, `status ${garbage.status}`);

  const missing = await post("/check", {});
  check("missing contract: HTTP 400", missing.status === 400, `status ${missing.status}`);

  const badWallet = await post("/check", { contract: real[0].contract, wallet: "xyz" });
  check("bad wallet: HTTP 400", badWallet.status === 400, `status ${badWallet.status}`);

  const badChain = await post("/check", { contract: real[0].contract, chainId: 999 });
  check("unsupported chain: HTTP 400", badChain.status === 400, `status ${badChain.status}`);

  // --- secret rejection ---
  const key64 = await post("/check", { contract: "0x" + "ab".repeat(32) });
  // 0x + 64 hex chars is a 64-hex string AND a 42-char address is required; either way it must be 400
  check("64-hex input rejected: HTTP 400", key64.status === 400, `status ${key64.status}`);
  const keyField = await post("/check", { contract: real[0].contract, private_key: "0x1234" });
  check("private_key field rejected: HTTP 400", keyField.status === 400, `status ${keyField.status}`);
  const seedField = await post("/check", { contract: real[0].contract, seed: "word word word" });
  check("seed field rejected: HTTP 400", seedField.status === 400, `status ${seedField.status}`);

  const notFound = await fetch(BASE + "/nope");
  check("unknown route: HTTP 404", notFound.status === 404, `status ${notFound.status}`);
} finally {
  server.kill("SIGTERM");
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
