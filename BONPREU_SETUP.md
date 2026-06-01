# Bonpreu adaptation — setup & testing guide

This fork adapts ampai-uk/llm-shopping-cart (built for Ocado UK) to
Bonpreu Esclat, which runs on the same Ocado Smart Platform.

## What was changed

- `src/config.js` (NEW): central retailer config. `RETAILER=bonpreu` (default)
  sets the domain, login URL, locale (ca-ES), timezone and currency (€).
  All hard-coded `ocado.com` URLs now come from here.
- `src/operations/LoginOperation.js`: rewritten to be domain-agnostic and to
  handle Bonpreu's OpenID Connect login (app.bonpreu.cat) instead of Ocado SSO.
  CSRF extraction now tries 4 strategies (state object, meta tag, deep search,
  cookie) because Bonpreu may store it differently than Ocado.
- `src/operations/AddToCartOperation.js`, `ScrapeOrdersOperation.js`,
  `ocado-service.js`, `browser/BrowserManager.js`: use config for URLs,
  currency and locale.

## Confirmed working (probed without credentials)

- `GET /api/cart/v1/carts/active` on the Bonpreu domain returns HTTP 200 JSON
  -> the cart API path is identical to Ocado UK.
- `/graphql` exists (returns 405 to GET, as expected for a POST endpoint).
- `/login` redirects to app.bonpreu.cat OpenID Connect (lang=ca-ES).

## Still UNKNOWN — verify during your first run

1. CSRF token location. Ocado puts it in window.__INITIAL_STATE__. Bonpreu may
   differ. After first login, check the console: it prints which strategy
   found the token (or warns if none did).
2. The GraphQL `GetCompletedOrders` query shape and the order-detail JSON
   structure. If `--update-orders` returns 0 orders despite a valid session,
   the query/field names likely differ for Bonpreu. Capture the real query via
   DevTools > Network while browsing your Bonpreu order history.
3. The `apply-quantity` request body / meta fields (pageType 'BASKET', etc.).
   Likely identical, but confirm by adding one item via DevTools first.

## Steps to run (on YOUR machine, with Node 18+)

1. Install deps:           npm install
2. Install Playwright:     npx playwright install chromium
3. cp .env.example .env    (RETAILER=bonpreu is already the default)
4. Log in (opens browser): node main.js --login --head
   -> log in with your Bonpreu account; watch the console for the CSRF result.
5. Fetch order history:    node main.js --update-orders
   -> if you get 0 orders, see UNKNOWN #2 above.
6. Smoke-test search:
   node -e "require('./src/ocado-service').searchItems('llet').then(r=>console.log(JSON.stringify(r,null,2)))"
7. Run the MCP server locally (NOT on GCS):  npm run mcp
   Then connect it to Claude / Home Assistant as a local MCP server.

## Keep it local

Do NOT set GCS_BUCKET. Leaving it unset keeps session.json (your Bonpreu
session cookies) and orders.json on your own disk. Run the MCP server on your
Pi / HA box on the local network instead of deploying to Cloud Run.

## If the cart API needs no login

Worth testing (as the rtilleard/ocado-claude-skill project relies on): Bonpreu
may let you add to an anonymous basket. If so, you could skip session capture
entirely for the add-to-cart path. Test by POSTing to apply-quantity without
cookies and see if it 200s. (It may require a delivery postcode/slot first.)
