require('dotenv').config({ quiet: true });
const { PrepareItemsToAddToCart, AddToCartOperation, ScrapeOrdersOperation } = require('./operations');
const storage = require('./storage-adapter');
const config = require('./config');

function formatCartSummary(cartUpdate, nameMap) {
  if (!cartUpdate) return null;

  // cartUpdate comes from the apply-quantity endpoint
  // Structure: { basketUpdateResult: { itemGroups: [{ items: [{productId, quantity, price, ...}] }], totals } }
  const basketResult = cartUpdate.basketUpdateResult || {};
  const itemGroups = basketResult.itemGroups || [];
  const totals = basketResult.totals || {};

  const lines = [];
  const cartItems = [];

  for (const group of itemGroups) {
    for (const item of (group.items || [])) {
      const name = nameMap.get(item.productId) || item.productId;
      const price = item.price?.amount ? `${config.currency}${item.price.amount}` : '';
      cartItems.push({ name, quantity: item.quantity, price });
      lines.push(`  - ${name} x${item.quantity}${price ? ` (${price})` : ''}`);
    }
  }

  const totalPrice = totals.itemsRetailPrice?.amount
    ? `${config.currency}${totals.itemsRetailPrice.amount}`
    : null;

  return {
    items: cartItems,
    totalItems: cartItems.length,
    totalPrice,
    summary: lines.length > 0
      ? `Cart (${cartItems.length} items${totalPrice ? ', ' + totalPrice : ''}):\n${lines.join('\n')}`
      : 'Cart is empty',
  };
}

async function searchItems(itemsString, opts = {}) {
  const threshold = opts.threshold ?? 0.4;
  const orders = await storage.loadOrders(opts.orderHistoryFile);

  const prep = new PrepareItemsToAddToCart({
    items: itemsString,
    orders,
    threshold,
  });
  return prep.execute();
}

async function addToCart(itemsString, opts = {}) {
  const threshold = opts.threshold ?? 0.4;
  const orders = await storage.loadOrders(opts.orderHistoryFile);

  const prep = new PrepareItemsToAddToCart({
    items: itemsString,
    orders,
    threshold,
  });
  const prepResult = await prep.execute();

  if (!prepResult.items || prepResult.items.length === 0) {
    return { success: false, message: 'No items matched from order history', unmatched: prepResult.unmatched };
  }

  const session = await storage.loadSession();
  const addOp = new AddToCartOperation({
    items: prepResult.items,
    csrfToken: session.csrfToken,
    cookies: session.cookies,
    orders,
  });
  const cartResult = await addOp.execute();

  const nameMap = await storage.loadNameMap(opts.orderHistoryFile);
  // Override with matched names from this request
  for (const item of prepResult.items) {
    if (item.matchedName) nameMap.set(item.productId, item.matchedName);
  }

  const cartSummary = formatCartSummary(cartResult.cartUpdate, nameMap);

  return {
    success: cartResult.success,
    message: cartResult.message,
    itemsAdded: cartResult.itemsAdded,
    unmatched: prepResult.unmatched,
    cart: cartSummary,
  };
}

async function getCart() {
  const session = await storage.loadSession();
  const cookies = session.cookies.map(c => `${c.name}=${c.value}`).join('; ');

  const headers = {
    'accept': 'application/json; charset=utf-8',
    'content-type': 'application/json; charset=utf-8',
    'cookie': cookies,
  };
  if (session.csrfToken) {
    headers['X-CSRF-TOKEN'] = session.csrfToken;
  }

  const resp = await fetch(config.endpoints.cartActive, {
    method: 'GET',
    headers,
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch cart: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

async function updateOrders(opts = {}) {
  const session = await storage.loadSession();
  const orderHistoryMonths = opts.months ?? 3;

  const scrapeOp = new ScrapeOrdersOperation({
    orderHistoryMonths,
    csrfToken: session.csrfToken,
    cookies: session.cookies,
  });
  return scrapeOp.execute();
}

module.exports = { searchItems, addToCart, getCart, updateOrders };
