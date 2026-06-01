#!/usr/bin/env node
const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');
const { searchItems, addToCart, updateOrders } = require('./src/ocado-service');

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';
const OAUTH_JWT_SECRET = process.env.OAUTH_JWT_SECRET || 'default-jwt-secret';
const TOKEN_EXPIRY = '1h';

// In-memory store for authorization codes (short-lived, cleared on restart is fine)
const authCodes = new Map();

const app = express();
app.use(express.json());

// --- OAuth authorize endpoint (Authorization Code flow) ---
app.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, state, scope } = req.query;

  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type' });
  }
  if (client_id !== OAUTH_CLIENT_ID) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  // Auto-approve: generate an authorization code and redirect back
  const code = crypto.randomBytes(32).toString('hex');
  authCodes.set(code, { clientId: client_id, redirectUri: redirect_uri, expiresAt: Date.now() + 60000 });

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// --- OAuth token endpoint (authorization_code + client_credentials) ---
app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
  const grantType = req.body.grant_type;

  // Accept credentials from body or Basic auth header
  let clientId = req.body.client_id;
  let clientSecret = req.body.client_secret;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const [id, secret] = decoded.split(':');
    clientId = clientId || id;
    clientSecret = clientSecret || secret;
  }

  if (clientId !== OAUTH_CLIENT_ID || clientSecret !== OAUTH_CLIENT_SECRET) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  if (grantType === 'authorization_code') {
    const { code, redirect_uri } = req.body;
    const stored = authCodes.get(code);
    if (!stored || stored.expiresAt < Date.now() || stored.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    authCodes.delete(code);
  } else if (grantType !== 'client_credentials') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  const token = jwt.sign({ sub: clientId, scope: 'mcp' }, OAUTH_JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
});

// --- OAuth metadata (RFC 8414) ---
// Serve at root and MCP-relative paths for client discovery
function oauthMetadata(req, res) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const baseUrl = `${proto}://${req.get('host')}`;
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  });
}
app.get('/.well-known/oauth-authorization-server', oauthMetadata);
app.get('/.well-known/oauth-authorization-server/mcp', oauthMetadata);
app.get('/mcp/.well-known/oauth-authorization-server', oauthMetadata);

// --- Auth middleware (validates JWT from /token endpoint) ---
function authMiddleware(req, res, next) {
  if (!OAUTH_CLIENT_ID) return next(); // no OAuth configured = open (local dev)
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token', hint: 'POST /token with client_credentials to get a Bearer token' });
  }
  try {
    req.auth = jwt.verify(header.slice(7), OAUTH_JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'invalid_token', message: err.message });
  }
}

// --- Health check ---
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'ocado-mcp' }));

// --- MCP Streamable HTTP endpoint (stateless, one server+transport per request) ---
app.post('/mcp', authMiddleware, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Handle GET and DELETE for MCP protocol (required by spec, but stateless = not supported)
app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Stateless mode — SSE streams not supported' });
});
app.delete('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Stateless mode — session termination not supported' });
});

// --- MCP SSE transport (for Home Assistant's MCP Client integration) ---
// Home Assistant's MCP integration speaks the older SSE transport, not
// Streamable HTTP. SSE is stateful: the client opens GET /sse to receive a
// stream, then POSTs JSON-RPC messages to /messages?sessionId=... . We keep one
// transport per open connection, keyed by its sessionId.
const sseTransports = new Map();

app.get('/sse', authMiddleware, async (req, res) => {
  // The endpoint passed here is where the client must POST its messages.
  const transport = new SSEServerTransport('/messages', res);
  sseTransports.set(transport.sessionId, transport);

  res.on('close', () => {
    sseTransports.delete(transport.sessionId);
    transport.close();
  });

  const server = createMcpServer();
  await server.connect(transport); // calls transport.start() internally
});

app.post('/messages', authMiddleware, async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessionId && sseTransports.get(sessionId);
  if (!transport) {
    return res.status(400).json({ error: 'No active SSE session for that sessionId' });
  }
  // Pass the already-parsed body (express.json ran globally) so the transport
  // doesn't try to read the stream a second time.
  await transport.handlePostMessage(req, res, req.body);
});

// --- REST endpoints (for OpenAI / generic HTTP clients) ---
app.post('/api/search', authMiddleware, async (req, res) => {
  try {
    const { query, items, threshold } = req.body;
    const result = await searchItems(query || items, { threshold });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/add-to-cart', authMiddleware, async (req, res) => {
  try {
    const { items, threshold } = req.body;
    const result = await addToCart(items, { threshold });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/update-orders', authMiddleware, async (req, res) => {
  try {
    const { months } = req.body;
    const result = await updateOrders({ months });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- MCP server factory ---
function createMcpServer() {
  const server = new McpServer({
    name: 'ocado',
    version: '1.0.0',
  });

  server.tool(
    'search_items',
    `Fuzzy-match items against Ocado order history without adding to cart.
Use this only if the user wants to preview what products would be matched before committing to add_to_cart.
If user wants to add items to the cart, use add_to_cart instead.
Items are matched against previously ordered products, so only items the user has ordered before will match.

Examples:
  "milk" -> matches "M&S Organic Whole Milk 2 Pints"
  "eggs, bread, cheese" -> matches each against order history
  "milk(2), eggs(6)" -> matches with quantities (useful for add_to_cart later)

The response includes:
  - items: matched products with productId, quantity, matchedName
  - unmatched: items that couldn't be found in order history

If items come back as unmatched, try more specific names or different terms.
Always show the user the matched product names so they can confirm before adding to cart.`,
    {
      items: z.string().describe('Comma-separated list of items, e.g. "milk, eggs, bread". Optional quantities: "milk(2), eggs(6)"'),
      threshold: z.number().min(0).max(1).optional().describe('Fuzzy match threshold (0=exact, 1=loose). Default 0.4'),
    },
    async ({ items, threshold }) => {
      try {
        const result = await searchItems(items, { threshold });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'add_to_cart',
    `This tool is used to add items to the Ocado online grocery cart. User can provide list of items to add to the cart.
  Internally the function will perform fuzzy matching against the order history to find the correct products to add to the cart.
  This function requires a valid session — if you get an auth error, tell the user to run "node main.js --login" first.

Pass all items in a single call rather than one at a time.

Examples:
  "milk, eggs, bread" -> adds 1 of each
  "milk(2), eggs(6), blueberries(3)" -> adds with specific quantities
  "milk(-1)" -> removes 1 milk from the cart
  "high protein cheese" -> fuzzy matches to e.g. "Cathedral City High Protein Half Fat Cheddar Cheese"

The response includes:
  - itemsAdded: what was matched and added (with productId, quantity, matchedName)
  - unmatched: items that couldn't be found in order history — tell the user about these
  - cart: full current cart contents after the update, with item names, quantities and prices

Always show the user:
1. What was added (and what was unmatched)
2. The full cart content with item names, quantities, prices, and price
2. The total price of the cart`,
    {
      items: z.string().describe('Comma-separated list of items, e.g. "milk, eggs, bread". Optional quantities: "milk(2), eggs(6)"'),
      threshold: z.number().min(0).max(1).optional().describe('Fuzzy match threshold (0=exact, 1=loose). Default 0.4'),
    },
    async ({ items, threshold }) => {
      try {
        const result = await addToCart(items, { threshold });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'update_orders',
    `Fetch latest Ocado order history via API and save to data file.
  The data file is then used to perform fuzzy matching against the order history to find the correct products to add to the cart.
Requires a valid session — if you get an auth error, tell the user to run "node main.js --login" first.

Run this when the user wants to refresh their order history, e.g. after a new delivery.
The order history is what search_items and add_to_cart match against, so it needs to be up to date.

The response includes order details with items, prices, and delivery dates.`,
    {
      months: z.number().optional().describe('How many months of order history to fetch. Default 3'),
    },
    async ({ months }) => {
      try {
        const result = await updateOrders({ months });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

app.listen(PORT, () => {
  console.log(`Ocado MCP HTTP server listening on port ${PORT}`);
  console.log(`  MCP endpoint: POST /mcp`);
  console.log(`  MCP SSE endpoint (Home Assistant): GET /sse`);
  console.log(`  REST endpoints: POST /api/search, /api/add-to-cart, /api/update-orders`);
  console.log(`  OAuth token endpoint: POST /token`);
  console.log(`  Auth: ${OAUTH_CLIENT_ID ? 'OAuth (client_credentials)' : 'OPEN (no OAUTH_CLIENT_ID set)'}`);
  console.log(`  Storage: ${process.env.GCS_BUCKET ? `GCS (${process.env.GCS_BUCKET})` : 'local filesystem'}`);
});
