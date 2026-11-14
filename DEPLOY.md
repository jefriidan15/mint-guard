# MintGuard — deployment status

**Status: LIVE and verified end-to-end (2026-11-15 ~01:40 WIB).**

## Public endpoint

    https://skip-hormone-declaration-testimonials.trycloudflare.com

- `GET /healthz` → `{"ok": true}`
- `POST /check` with `{contract, wallet?}` → verdict + evidence (see README).

Agent: MintGuard, Agent Games by zkVerify **Wildcard** entry (agent Mly).
Repo: https://github.com/jefriidan15/mint-guard (public, MIT).

## Test evidence (all PASS)

| Test | Result |
|---|---|
| `node test.mjs` on the VM — 36 checks | **36 passed, 0 failed** (~12 s warm cache) |
| Claf Eye `0x1c75…456` | REVERTS, verified=true (Sourcify exact_match), mint reverts `WrongPayment 0xb23bee05` |
| Paper Snake `0xEbeA…4b0` | REVERTS, verified=false, mint reverts `already claimed` |
| OinkHash pigs `0x5615…35f` | **PAID**, price `1500000000000000` (0.0015 BNB) from `mintPrice`, verified=true |
| Wallet check (W2) vs OinkHash | 5 tokens probed (USDT/BUSD/USDC/WBNB/DAI), all allowances `0` |
| EOA as contract | HTTP 200, verdict UNKNOWN, `code: false` |
| Negative inputs (garbage, missing, bad wallet, bad chain) | HTTP 400 |
| Secret rejection (64-hex input, `private_key` / `seed` fields) | HTTP 400 |
| Live `POST /check` over the PUBLIC tunnel URL, from the VPS | PAID, price 1500000000000000, verified=true, all 5 allowances `0` |
| Health `GET /healthz` over the public URL from the VPS | HTTP 200 `{"ok":true}` |

## Leak check (before push, programmatic)

- 64-hex strings in the pushed files: **0**
- `.env` / keypair / secret / `.pem` / `.key` files present: **0**
- `private_key|mnemonic|seed|keypair` matches: **11, all intentional** —
  the `scanForSecrets` blocklist in `server.mjs`, the negative tests in
  `test.mjs`, and the keyless-safety wording in the README/comments.
  No real secret anywhere.
- `4byte-cache.json` (public 4byte signatures only, gitignored) was
  **copied to the VPS** so the endpoint is fast from the first check; it
  contains no secrets.

## Ops (VPS, /root/mint-guard/)

- Screens: `mintguard` (server, port 3001, auto-restart loop, `server.log`),
  `cftunnel-mintguard` (cloudflared quick tunnel, log
  `/tmp/cloudflared-mintguard.log`). Untouched: `agentgames` + `cftunnel-agent`
  (Mly, port 3000), `9router`, `cftunnel` (9router, port 20128).
- Files: `server.mjs`, `test.mjs`, `package.json`, `package-lock.json`,
  `README.md`, `LICENSE`, `.gitignore`, `4byte-cache.json` (warm cache),
  `server.log`. The VPS runs the exact public repo commit.
- Restart server: `screen -S mintguard -X quit`, then
  `screen -dmS mintguard bash -c 'cd /root/mint-guard; while true; do PORT=3001 node server.mjs >> server.log 2>&1; sleep 2; done'`
- Restart tunnel: `screen -S cftunnel-mintguard -X quit`, then
  `screen -dmS cftunnel-mintguard bash -c 'cloudflared tunnel --url http://localhost:3001 > /tmp/cloudflared-mintguard.log 2>&1'`
  — the URL changes on tunnel restart; update the README + the dashboard
  submission with the new URL.
- Update the VPS from the repo: `cd /root/mint-guard && git pull && screen -S mintguard -X quit` (relaunch with the command above).

## Caveats

1. **Tunnel URL is volatile.** If the `cftunnel-mintguard` screen restarts
   or the VPS reboots, the trycloudflare.com URL changes. A named tunnel +
   own domain would fix this permanently.
2. **Cloudflare 403 from some egresses.** The public URL works from the
   VPS egress (all tests above) but may return HTTP 403 from the Muse VM's
   egress or the browser crawler — the Mly tunnel shows the same client-IP
   based behaviour. If a judge hits a 403, the service itself is still up;
   re-check from the VPS.
3. **First check on a fresh contract is slow (~1–3 min)** — the ABI has to
   be rebuilt selector-by-selector from the public 4byte database. Repeat
   checks are fast (in-memory + `4byte-cache.json` cache). The VPS copy
   ships with the three test contracts' signatures pre-cached.
4. **Revert reasons depend on the RPC node.** Some public BSC nodes return
   the reason string (`already claimed`, `closed`), others return a bare
   revert. The verdict and price do not depend on it.
5. **No API keys anywhere.** Sourcify v2, 4byte.directory, and the public
   BSC RPCs are all keyless. The old Sourcify v1 repo paths are dead
   (redirect to a removed API) — the server uses v2 match info only.
