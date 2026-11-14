# MintGuard

A keyless, read-only agent that checks whether a mint is truly free and safe
**before** anyone signs anything.

Give it a contract address (and optionally a wallet address) and it answers:

- **FREE or PAID** — with the price, read from the contract itself
- **Does the mint call succeed or revert** — simulated with a read-only
  `eth_call`, never a transaction
- **Is the contract source-verified** — via Sourcify
- **What allowances has the wallet already granted** to that contract

## Live endpoint

**https://skip-hormone-declaration-testimonials.trycloudflare.com**

Deployed on the Contabo VPS (port 3001, screen `mintguard`), behind a
Cloudflare quick tunnel (screen `cftunnel-mintguard`).
See [DEPLOY.md](DEPLOY.md).

## API

### `GET /`

Short docs. `GET /healthz` returns `{"ok": true}`.

### `POST /check`

```json
{
  "chainId": 56,
  "contract": "0x56155fd1818b31256E7f435956D6dff5C732f35f",
  "wallet": "0x04dAc94DcE888E4cf60E7093fb6cD84352fC0656",
  "mintFn": "freeMint",
  "value": "0",
  "args": []
}
```

| Field | Required | Notes |
|---|---|---|
| `contract` | yes | `0x` address, 40 hex chars |
| `wallet` | no | `0x` address — used for allowance checks and as the `eth_call` sender |
| `chainId` | no | default `56` (BSC); `1` (Ethereum) also supported |
| `mintFn` | no | restrict the mint simulation to this function name |
| `value` | no | wei to send in the simulated call (string or number), default `0` |
| `args` | no | explicit mint arguments (JSON array) |

Response:

```json
{
  "verdict": "FREE",
  "price": "0",
  "evidence": {
    "chainId": 56,
    "contract": "0x...",
    "code": true,
    "verified": true,
    "sourcifyMatch": "exact_match",
    "abiFunctions": 42,
    "price": "0",
    "priceFrom": "mintPrice",
    "mintProbes": [{ "fn": "freeMint", "argsTried": ["[]"], "ok": true, "error": null }],
    "allowances": [{ "token": "USDT", "allowance": "0", "decimals": 18, "nonzero": false }]
  },
  "warnings": []
}
```

Verdicts: `FREE` · `PAID` · `REVERTS` · `UNVERIFIED` · `UNKNOWN`.

## How it works

1. **Code check** — `eth_getCode`. No code means an EOA or undeployed
   address, not a contract.
2. **Verification** — Sourcify v2 match info (no API key). The old v1
   repo paths are dead; v2 is the authority.
3. **ABI reconstruction** — the contract's function selectors are extracted
   from the runtime bytecode (`PUSH4` scan) and resolved through the public
   [4byte.directory](https://www.4byte.directory) signature database.
   Resolved signatures are cached in `4byte-cache.json` (public data).
4. **Price** — zero-argument price getters (`mintPrice`, `price`, `cost`,
   `mintCost`, …) are called read-only; the first that returns a `uint256`
   wins.
5. **Mint simulation** — `eth_call` probes of the mint-like functions
   (reconstructed from the ABI), with value `0` and, when a price was found,
   with that price. Revert reasons are decoded when available.
6. **Allowances** — `allowance(wallet, contract)` for the common stablecoins
   on the chain; any non-zero allowance is flagged in `warnings`.

All reads go through public JSON-RPC endpoints (BSC: binance dataseed,
defibit, ninicoin, publicnode, ankr — first healthy wins) and are paced,
one network call at a time.

## Keyless by construction

This service **never holds, accepts, or logs any private key, seed phrase,
or signing token**. It performs read-only calls only — it cannot sign and
cannot send a transaction. Any request containing a 64-hex string or a
`private_key` / `seed` / `mnemonic` / `keypair` field is rejected with
HTTP 400 before any downstream call. The server holds no wallet, no `.env`
secrets, and no signing code at all.

## Run it

```bash
npm ci
node server.mjs        # listens on :3001 (PORT env to change)
npm test               # node test.mjs — read-only checks against real mainnet contracts
```

## Agent Games by zkVerify — Wildcard track

MintGuard is the Wildcard entry of agent **Mly** for the Agent Games by
zkVerify (Season 01). It is judged on problem fit, a working
implementation, and a clear explanation; using zkVerify is an optional
bonus here, not a requirement. Built on the Contabo VPS; the endpoint is
kept alive independently of the Proof Gatekeeper agent (port 3000).

## License

MIT.
