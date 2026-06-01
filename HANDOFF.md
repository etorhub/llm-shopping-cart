# Bonpreu MCP — Session Handoff (resume in Claude Code)

Paste this file into Claude Code (or keep it as `HANDOFF.md` in the repo root and
tell Claude Code to read it). It captures the full context and what's left.

---

## TL;DR

Goal: control my Bonpreu Esclat online grocery cart by voice through Home
Assistant. I built an MCP server (forked from ampai-uk/llm-shopping-cart, which
targeted Ocado UK) and adapted it to Bonpreu. The core works and is tested
against my real account. Remaining work is deployment on my own infra: dockerise
on my NAS, then wire it into Home Assistant Assist with a voice satellite.

Fork: https://github.com/etorhub/llm-shopping-cart (I have push access; Claude
in the previous session could not push, only prepare commits + patches.)

## Key technical fact

Bonpreu's shop (compraonline.bonpreuesclat.cat) runs on the **Ocado Smart
Platform**, the same as Ocado UK. So the API is essentially identical — adapting
the Ocado project to Bonpreu mostly meant changing the domain and the login
flow. Verified live:
- `GET /api/cart/v1/carts/active` → 200 JSON (same path as Ocado)
- `/graphql` exists; `GetCompletedOrders` query works unchanged
- `/login` → redirects to app.bonpreu.cat OpenID Connect (lang=ca-ES, channel=osp)
- CSRF token lives in `window.__INITIAL_STATE__.session.csrf.token` (same as Ocado)
- Order JSON structure identical (groupedProducts.products, name, productId...)

## What was done (3 commits on top of upstream, all on `main`)

1. **Adapt to Bonpreu** (12a6d8c)
   - NEW `src/config.js`: central retailer config via `RETAILER` env var
     (default `bonpreu`, also `ocado`). Sets domain, login URL, locale (ca-ES),
     timezone (Europe/Madrid), currency (€), builds all endpoint URLs. Removed
     all hard-coded ocado.com.
   - Rewrote `src/operations/LoginOperation.js`: domain-agnostic, handles
     Bonpreu OIDC, 4 CSRF-extraction strategies (the __INITIAL_STATE__ one wins).
   - Routed URLs/currency/locale through config in AddToCartOperation,
     ScrapeOrdersOperation, ocado-service, BrowserManager.
   - Added `.env.example`, `BONPREU_SETUP.md`.

2. **NAS Docker deployment** (0dd634a)
   - `Dockerfile.nas`: production image, runs ONLY mcp-server-http.js, excludes
     Playwright/Puppeteer (dev deps) → small image, no browser needed on NAS.
     Has a healthcheck.
   - `docker-compose.nas.yml`: restart:unless-stopped, LAN port 8080,
     session.json mounted read-only, data/ writable volume (so session + order
     history survive rebuilds). OAuth env vars present but commented.
   - `DEPLOY_NAS.md`: full flow. `scripts/push-session-to-nas.sh`: scp helper.
   - Guarded the scrape's 404 page-navigation fallback so it skips gracefully in
     browserless mode (no `page` object inside the server).

3. **Home Assistant SSE transport** (e05670f)
   - HA's MCP Client integration speaks the older **SSE** transport, NOT the
     Streamable HTTP that `/mcp` uses. Added SSE alongside existing endpoints:
     `GET /sse` (opens stream) + `POST /messages?sessionId=...` (receives msgs).
   - Verified end-to-end: SSE handshake + initialize + tools/list correctly
     expose the three tools over the stream.
   - `HOME_ASSISTANT.md`: full HA setup guide.

## Architecture

```
[PC with screen]            [NAS]                      [Home Assistant]
node main.js --login  --scp-->  Docker container   <--MCP/SSE-- MCP Client integ.
(makes session.json)  session   mcp-server-http.js              |
                                reads session.json       conversation agent (LLM)
                                GET /sse, POST /messages   + Assist API (house control)
                                                                |
                                                        voice satellite (Voice PE/Atom)
```

- Login needs a browser → done on the PC, session.json copied to the NAS.
- NAS container only runs the server (browserless): search/add-to-cart/
  update-orders all work via direct fetch with the saved cookies.
- HA is the MCP client; tools join the conversation agent's toolset next to the
  Assist API, so ONE agent can both control the house and shop.

## The three MCP tools

- `search_items(items, threshold?)` — fuzzy-match against order history, no cart
  change. Only previously-ordered products match (Fuse.js).
- `add_to_cart(items)` — match + POST /api/cart/v1/carts/active/apply-quantity.
  This is the only thing that mutates the real account. No checkout/payment.
- `update_orders(months?)` — refresh order history via GraphQL + REST.

Item string format: `"llet, ous(6), pa"` (optional quantity in parens).

## Decisions made

- Storage stays LOCAL (never set GCS_BUCKET) → cookies never leave my infra.
- Single HA agent for house + shopping (MCP Client adds tools to the agent).
- LLM model NOT yet chosen — server is model-agnostic, decide at HA-agent config
  time, changeable later. Cloud (Claude/OpenAI) = more reliable tool-calling for
  the cart; local (Ollama/llama.cpp) = fully private but model-dependent.

## Known constraints / gotchas

- **Session expires in ~5–7 days.** When add_to_cart starts returning 401/403 or
  update_orders returns 0 orders, re-login on PC + re-copy session.json. This is
  the main recurring maintenance. (Worth exploring a smoother refresh later.)
- **OAuth is OFF by default** → on an open LAN anyone who finds port 8080 can add
  to my cart (can't checkout). Recommend enabling OAuth (vars in compose).
- HA needs the SSE URL ending in `/sse`. If OAuth is on, HA needs the client
  secret in Application Credentials.
- Prompt risk: the agent may confuse "add to my list" with creating an HA to-do
  list instead of calling add_to_cart. The suggested system prompt in
  HOME_ASSISTANT.md addresses this; may need tuning.

## NEXT STEPS (in order)

1. **Push the work** (if not already pushed): the 3 commits are on `main`.
   Patches also exist if needed. Confirm `git log` shows 12a6d8c, 0dd634a,
   e05670f.

2. **Dockerise on the NAS** (see DEPLOY_NAS.md):
   - On PC: `node main.js --login --head` → makes session.json. Already have
     38 orders / 1756 products fetched, so data/orders.json may already exist.
   - Create NAS folder, copy repo + session/ + data/. scp session.json over.
   - `docker compose -f docker-compose.nas.yml up -d --build`
   - `curl http://NAS_IP:8080/` → expect {"status":"ok","service":"ocado-mcp"}
   - Verify SSE: `curl -sN http://NAS_IP:8080/sse` → should emit an `endpoint`
     event with /messages?sessionId=...

3. **(Recommended) Enable OAuth** before exposing on LAN. Generate two
   `openssl rand -hex 32` secrets, set OAUTH_CLIENT_ID/SECRET/JWT_SECRET in
   compose, restart.

4. **Wire into Home Assistant** (see HOME_ASSISTANT.md):
   - Pick + install an LLM conversation agent integration.
   - Add "Model Context Protocol" (client) integration → URL
     `http://NAS_IP:8080/sse` (+ client secret if OAuth on).
   - Ensure the agent has BOTH the Assist API and the new MCP LLM API enabled.
   - Assign the agent to an Assist pipeline + the voice satellite.
   - Add the suggested system prompt.

5. **Test by voice**: "afegeix llet i ous a la compra" → check the cart at
   compraonline.bonpreuesclat.cat. Do checkout/payment manually.

## Things likely to need help during the above (flag to Claude Code)

- HA failing to validate/connect the SSE endpoint (esp. with OAuth).
- Tuning the agent prompt so "add to shopping list" reliably calls add_to_cart
  and not an HA to-do list.
- A less-manual session refresh (current: PC login + scp every ~5–7 days).
- If `update_orders` ever returns 0 despite a fresh session, capture the real
  GraphQL request via DevTools and compare field names.

## Repo orientation (for Claude Code)

- `mcp-server-http.js` — the HTTP/SSE server (run this in the container).
- `main.js` — CLI: `--login --head`, `--update-orders`, `--add-to-cart`, etc.
- `src/config.js` — retailer config (the heart of the Bonpreu adaptation).
- `src/operations/` — LoginOperation, AddToCartOperation, ScrapeOrdersOperation,
  PrepareItemsToAddToCart (Fuse.js matching).
- `src/ocado-service.js` — searchItems / addToCart / getCart / updateOrders.
- `src/storage-adapter.js` — local-file vs GCS storage (keep local).
- Docs: BONPREU_SETUP.md, DEPLOY_NAS.md, HOME_ASSISTANT.md.
- `upstream` remote = original ampai-uk repo (for pulling future changes).
