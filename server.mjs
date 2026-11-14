// MintGuard — keyless, read-only mint-safety check.
// Takes a contract address (+ optional wallet) and answers, BEFORE anyone
// signs: is the mint free or paid, does the mint call succeed or revert,
// is the contract source-verified, and what ERC20 allowances has the wallet
// already granted to that contract.
//
// KEYLESS BY CONSTRUCTION: this service never holds, accepts, or logs a
// private key, seed phrase, or signing token. It only performs read-only
// JSON-RPC calls (eth_getCode, eth_call) and public lookups (Sourcify v2,
// 4byte.directory). Any input containing a 64-hex string or a key/seed /
// mnemonic field name is rejected with 400 before any downstream call.
//
// ABI source (no API key): Sourcify v2 match info for verification status,
// plus function selectors extracted from the runtime bytecode and resolved
// through 4byte.directory (public signature database) to rebuild a working
// ABI for price getters and mint probes.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const PORT = Number(process.env.PORT || 3001);
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "4byte-cache.json");

// Public RPC endpoints, tried in order. BSC public RPCs rate-limit; pace
// calls and fail over to the next endpoint on error.
const RPCS = {
  56: [
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
    "https://bsc-dataseed1.ninicoin.io",
    "https://bsc.publicnode.com",
    "https://rpc.ankr.com/bsc",
  ],
  1: [
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
  ],
};

const ERC20 = {
  56: [
    { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955" },
    { symbol: "BUSD", address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56" },
    { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
    { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
    { symbol: "DAI", address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3" },
  ],
  1: [
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
    { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  ],
};

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const PRICE_FN_NAMES = [
  "mintPrice", "price", "cost", "mintCost", "publicPrice",
  "salePrice", "getPrice", "mintFee", "mintingPrice",
];

// --- 4byte signature cache (public data only) ------------------------------
let sigCache = {};
try { sigCache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); } catch { sigCache = {}; }
let cacheDirty = false;
function saveSigCache() {
  if (!cacheDirty) return;
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(sigCache, null, 1)); cacheDirty = false; } catch { /* non-fatal */ }
}

// --- helpers ---------------------------------------------------------------

async function fetchJson(url, ms = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "MintGuard/1.0" } });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}

async function rpcCall(provider, method, params) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await provider.send(method, params);
  } finally { clearTimeout(t); }
}

async function pickProvider(chainId) {
  const urls = RPCS[chainId] || [];
  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
      await Promise.race([
        p.getBlockNumber(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), FETCH_TIMEOUT_MS)),
      ]);
      return { provider: p, rpcUrl: url };
    } catch { /* try next */ }
  }
  return null;
}

function decodeRevert(e) {
  const data = e?.data ?? e?.info?.error?.data ?? null;
  const msg = e?.info?.error?.message || e?.reason || e?.message || "";
  if (typeof data === "string") {
    if (data === "0x" || data.length <= 2) return "revert (no reason)";
    if (data.startsWith("0x08c379a0")) {
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10));
        return decoded[0].slice(0, 120);
      } catch { /* fall through */ }
    }
    if (data.startsWith("0x4e487b71")) return `panic ${data.slice(-2)}`;
    if (data.length > 2) return `revert data ${data.slice(0, 42)}`;
  }
  const m = String(msg).match(/reverted with reason string '([^']+)'/);
  if (m) return m[1].slice(0, 120);
  if (/revert/i.test(msg)) return msg.replace(/^.*revert/i, "revert").slice(0, 120);
  return "revert";
}

// Resolve a custom-error selector (0x + 4 bytes) to its name. Custom errors
// share the 4-byte namespace with function selectors, so the regular
// signatures database resolves them (e.g. 0xb23bee05 -> WrongPayment).
async function resolveErrorName(data) {
  if (typeof data !== "string" || data.length < 10) return null;
  const sel = data.slice(0, 10);
  const key = `err:${sel}`;
  if (Object.prototype.hasOwnProperty.call(sigCache, key)) return sigCache[key];
  try {
    const { status, json } = await fetchJson(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`, 8000);
    if (status === 200 && json?.results?.length) {
      const name = json.results[0].text_signature.split("(")[0];
      sigCache[key] = name;
      cacheDirty = true;
      saveSigCache();
      return name;
    }
  } catch { /* leave unresolved */ }
  sigCache[key] = null;
  cacheDirty = true;
  saveSigCache();
  return null;
}

async function describeRevert(e) {
  const data = e?.data ?? e?.info?.error?.data ?? null;
  const base = decodeRevert(e);
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10 && !data.startsWith("0x08c379a0") && !data.startsWith("0x4e487b71")) {
    const name = await resolveErrorName(data);
    if (name) return `${name} ${data.slice(0, 10)}`;
  }
  return base;
}

// Names that look like mint functions but are read-only views (price getters,
// counters, flags). Probing them as mints pollutes the evidence.
function isViewLikeMint(name) {
  if (/^(minted|claimed|totalMinted)/i.test(name)) return true;
  if (/(Price|Cost|Fee|Open|Paused|Count|Supply|Limit|PerWallet|PerUser|Max|Active|Start|End|Time|Date|By|Enabled|Live)$/.test(name)) return true;
  return false;
}

// Sourcify v2 match info (no API key). The v1 repo paths are removed.
async function fetchVerification(chainId, contract) {
  try {
    const { status, json } = await fetchJson(`https://sourcify.dev/server/v2/contract/${chainId}/${contract}`);
    if (status === 200 && json) {
      const match = json.match || json.creationMatch || json.runtimeMatch || null;
      return { verified: match === "exact_match", match };
    }
  } catch { /* unverified/unknown */ }
  return { verified: false, match: null };
}

// Extract PUSH4 selectors from runtime bytecode, resolve them via the
// public 4byte.directory database, rebuild a minimal ABI. Only the first
// 4 KiB are scanned (the dispatcher lives at the start of the code) and
// misses are cached too, so repeat checks stay fast.
async function reconstructAbi(bytecode) {
  const selectors = new Set();
  const bytes = ethers.getBytes(bytecode).slice(0, 4096);
  for (let i = 0; i + 5 <= bytes.length; i++) {
    if (bytes[i] === 0x63) { // PUSH4
      selectors.add(ethers.hexlify(bytes.slice(i + 1, i + 5)));
    }
  }
  const list = [...selectors].slice(0, 80);
  const fns = [];
  for (const sel of list) {
    let sig;
    if (Object.prototype.hasOwnProperty.call(sigCache, sel)) {
      sig = sigCache[sel];
    } else {
      try {
        const { status, json } = await fetchJson(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`, 8000);
        if (status === 200 && json?.results?.length) {
          sig = json.results[0].text_signature;
        } else {
          sig = null;
        }
      } catch { sig = null; }
      sigCache[sel] = sig;
      cacheDirty = true;
      await new Promise((r) => setTimeout(r, 40)); // pace the public API
    }
    if (!sig) continue;
    const m = sig.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)$/);
    if (!m) continue;
    const inputs = m[2] === "" ? [] : m[2].split(",");
    fns.push({ name: m[1], inputs, signature: sig });
  }
  saveSigCache();
  return fns;
}

function isAddress(v) {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

// Rejects anything that looks like a secret. Returns an error string or null.
function scanForSecrets(body) {
  const hay = JSON.stringify(body);
  if (/\b[0-9a-fA-F]{64}\b/.test(hay)) return "input contains a 64-hex string (looks like a private key)";
  const bad = ["private_key", "privatekey", "seed", "mnemonic", "keypair", "secret"];
  for (const k of Object.keys(body || {})) {
    if (bad.includes(String(k).toLowerCase())) return `forbidden field name: ${k}`;
  }
  return null;
}

function zeroArgForType(t) {
  if (t.startsWith("uint") || t.startsWith("int")) return 0n;
  if (t === "address") return ethers.ZeroAddress;
  if (t === "bool") return false;
  if (t.startsWith("bytes")) return "0x";
  if (t === "string") return "";
  if (t.endsWith("[]")) return [];
  return null; // tuple / unknown — caller filters these out
}

function oneArgForType(t) {
  if (t.startsWith("uint") || t.startsWith("int")) return 1n;
  return zeroArgForType(t);
}

function safeJson(obj) {
  return JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

// --- the check -------------------------------------------------------------

async function runCheck(input) {
  const chainId = input.chainId === undefined ? 56 : input.chainId;
  const contract = input.contract;
  const wallet = input.wallet || null;
  const evidence = { chainId, contract, code: null, verified: null, sourcifyMatch: null, abiFunctions: 0, price: null, priceFrom: null, mintProbes: [], allowances: [] };
  const warnings = [];

  if (!Object.prototype.hasOwnProperty.call(RPCS, chainId)) {
    return { status: 400, body: { error: `unsupported chainId ${chainId} (supported: 56, 1)` } };
  }
  if (!isAddress(contract)) {
    return { status: 400, body: { error: "contract must be a 0x address (40 hex chars)" } };
  }
  if (wallet !== null && !isAddress(wallet)) {
    return { status: 400, body: { error: "wallet must be a 0x address (40 hex chars)" } };
  }

  const picked = await pickProvider(chainId);
  if (!picked) {
    return { status: 503, body: { verdict: "UNKNOWN", error: "no reachable public RPC for this chain right now", evidence, warnings: ["all public RPC endpoints failed"] } };
  }
  const { provider } = picked;
  evidence.rpc = picked.rpcUrl.replace(/^(https?:\/\/[^/]+).*/, "$1"); // host only

  // 1. code?
  let code;
  try {
    code = await rpcCall(provider, "eth_getCode", [contract, "latest"]);
  } catch (e) {
    return { status: 503, body: { verdict: "UNKNOWN", error: `eth_getCode failed: ${String(e).slice(0, 120)}`, evidence, warnings } };
  }
  evidence.code = !!code && code !== "0x";
  if (!evidence.code) {
    return { status: 200, body: { verdict: "UNKNOWN", price: null, evidence, warnings: ["no contract code at this address (EOA or undeployed)"] } };
  }

  // 2. Sourcify verification (sequential; one network call at a time)
  const ver = await fetchVerification(chainId, contract);
  evidence.verified = ver.verified;
  evidence.sourcifyMatch = ver.match;
  if (!ver.verified) warnings.push("contract source is NOT verified on Sourcify — read the bytecode with care");

  // 3. Rebuild ABI from bytecode selectors via 4byte.directory
  const fns = await reconstructAbi(code);
  evidence.abiFunctions = fns.length;
  if (!fns.length) warnings.push("could not reconstruct any function signatures from bytecode");

  // 4. price getters (from reconstructed ABI first, then well-known names)
  const priceCandidates = [];
  for (const f of fns) {
    if (f.inputs.length === 0 && /price|cost|fee/i.test(f.name) && !priceCandidates.includes(f.name)) {
      priceCandidates.push(f.name);
    }
  }
  for (const n of PRICE_FN_NAMES) if (!priceCandidates.includes(n)) priceCandidates.push(n);
  for (const name of priceCandidates.slice(0, 10)) {
    try {
      const iface = new ethers.Interface([`function ${name}() view returns (uint256)`]);
      const raw = await rpcCall(provider, "eth_call", [{ to: contract, data: iface.encodeFunctionData(name) }, "latest"]);
      const value = BigInt(raw);
      evidence.price = value.toString();
      evidence.priceFrom = name;
      break;
    } catch { /* getter absent or reverts — try next */ }
  }

  // 5. mint simulation (read-only eth_call, never a transaction)
  const mintTargets = [];
  if (input.mintFn) mintTargets.push({ name: input.mintFn, inputs: null });
  else {
    for (const f of fns) {
      if (/^(mint|claim|publicMint|freeMint|mintNFT|buy)/i.test(f.name) && !isViewLikeMint(f.name)) mintTargets.push(f);
    }
    if (!mintTargets.length) {
      for (const n of ["mint", "freeMint", "publicMint", "claim"]) mintTargets.push({ name: n, inputs: [] });
    }
  }
  const from = wallet || ethers.ZeroAddress;
  const valueWei = input.value !== undefined ? BigInt(String(input.value)) : 0n;
  const customArgs = Array.isArray(input.args) ? input.args : null;
  for (const target of [...new Map(mintTargets.map((t) => [t.name, t])).values()].slice(0, 6)) {
    const name = target.name;
    const attempts = [];
    const attemptErrors = [];
    try {
      const inputs = target.inputs; // null = unknown arity (use custom args or no-arg)
      const variants = [];
      if (customArgs) variants.push(customArgs);
      if (inputs) {
        variants.push(inputs.map((t) => zeroArgForType(t)));
        if (inputs.length === 1) variants.push([oneArgForType(inputs[0])]);
        if (inputs.some((t) => t === "address")) {
          variants.push(inputs.map((t) => (t === "address" ? (wallet || ethers.ZeroAddress) : zeroArgForType(t))));
        }
      } else {
        variants.push([]);
      }
      const usable = variants.filter((v) => v.every((x) => x !== null)).slice(0, 3);
      const frag = inputs ? `function ${name}(${inputs.join(",")}) payable` : `function ${name}() payable`;
      const iface = new ethers.Interface([frag]);
      let ok = false, lastErr = "";
      for (const args of usable) {
        attempts.push(JSON.stringify(args.map((a) => String(a))));
        const data = iface.encodeFunctionData(name, args);
        try {
          await rpcCall(provider, "eth_call", [{ from, to: contract, data, value: "0x" + valueWei.toString(16) }, "latest"]);
          ok = true;
          attemptErrors.push(null);
          break;
        } catch (e) { lastErr = await describeRevert(e); attemptErrors.push(lastErr); }
        if (evidence.price && BigInt(evidence.price) > 0n) {
          try {
            await rpcCall(provider, "eth_call", [{ from, to: contract, data, value: "0x" + BigInt(evidence.price).toString(16) }, "latest"]);
            ok = true;
            attemptErrors.push(null);
            break;
          } catch (e) { lastErr = await describeRevert(e); attemptErrors.push(lastErr); }
        }
      }
      evidence.mintProbes.push({ fn: name, argsTried: attempts, attemptErrors, ok, error: ok ? null : lastErr });
    } catch (e) {
      evidence.mintProbes.push({ fn: name, argsTried: attempts, attemptErrors, ok: false, error: String(e).slice(0, 120) });
    }
  }

  // 6. allowances granted by the wallet to this contract (one retry per token:
  // public RPCs rate-limit after many calls)
  if (wallet) {
    for (const t of ERC20[chainId] || []) {
      let record = null;
      for (let attempt = 0; attempt < 2 && !record; attempt++) {
        try {
          const tok = new ethers.Contract(t.address, ERC20_ABI, provider);
          const [allow, dec] = await Promise.all([
            tok.allowance(wallet, contract),
            tok.decimals().catch(() => 18),
          ]);
          record = { token: t.symbol, allowance: allow.toString(), decimals: Number(dec), nonzero: allow > 0n };
        } catch {
          await new Promise((r) => setTimeout(r, 800)); // back off before retry
        }
      }
      if (record) {
        evidence.allowances.push(record);
        if (record.nonzero) warnings.push(`wallet already allows ${record.token} spend by this contract (${record.allowance} base units) — revoke if you no longer trust it`);
      } else {
        evidence.allowances.push({ token: t.symbol, allowance: null, decimals: null, nonzero: null, error: "token call failed after retry" });
      }
    }
  }

  // 7. verdict
  const priceWei = evidence.price ? BigInt(evidence.price) : null;
  const anyMintOk = evidence.mintProbes.some((p) => p.ok);
  let verdict;
  if (priceWei !== null && priceWei > 0n) verdict = "PAID";
  else if (priceWei === 0n && anyMintOk) verdict = "FREE";
  else if (evidence.mintProbes.length > 0 && !anyMintOk) verdict = "REVERTS";
  else if (!evidence.verified) verdict = "UNVERIFIED";
  else verdict = "UNKNOWN";
  if (verdict === "REVERTS") warnings.push("every mint probe reverted — the mint may be closed, sold out, allowlisted, or need different arguments");
  if (verdict === "PAID") warnings.push("this mint costs money — do not sign unless you accept the price");
  return { status: 200, body: { verdict, price: evidence.price, evidence, warnings } };
}

// --- HTTP server -----------------------------------------------------------

const server = http.createServer((req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(safeJson(obj));
  };
  (async () => {
    try {
      if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true });
      if (req.method === "GET" && req.url === "/") {
        return send(200, {
          name: "MintGuard",
          docs: "POST /check {chainId?, contract, wallet?, mintFn?, value?, args?} — read-only, keyless mint-safety check",
          chains: [56, 1],
          verdicts: ["FREE", "PAID", "REVERTS", "UNVERIFIED", "UNKNOWN"],
          keyless: "this service never holds or accepts any private key, seed, or signing token",
        });
      }
      if (req.method === "POST" && req.url === "/check") {
        let raw = "";
        await new Promise((resolve, reject) => {
          req.on("data", (c) => { raw += c; if (raw.length > 65536) reject(new Error("body too large")); });
          req.on("end", resolve);
          req.on("error", reject);
        });
        let body;
        try { body = JSON.parse(raw || "{}"); } catch { return send(400, { error: "invalid JSON body" }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { error: "body must be a JSON object" });
        const secretErr = scanForSecrets(body);
        if (secretErr) return send(400, { error: `rejected: ${secretErr}` });
        const out = await runCheck(body);
        console.log(`[check] chain=${body.chainId ?? 56} contract=${body.contract} -> ${out.body.verdict ?? out.body.error} (${out.status})`);
        return send(out.status, out.body);
      }
      return send(404, { error: "not found" });
    } catch (e) {
      console.error("[error]", String(e).slice(0, 300));
      try { send(500, { error: "internal error" }); } catch { /* socket gone */ }
    }
  })();
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", String(e).slice(0, 300)));

server.listen(PORT, () => console.log(`mint-guard listening on :${PORT}`));
