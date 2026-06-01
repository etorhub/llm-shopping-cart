require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Operation = require('../modules/Operation');
const storage = require('../storage-adapter');
const config = require('../config');

/**
 * Scrape Orders operation - fetches order history from Ocado
 */
class ScrapeOrdersOperation extends Operation {
  constructor(options = {}) {
    super('ScrapeOrders');
    this.options = {
      outputFile: options.outputFile || 'data/orders.json',
      ...options,
    };
  }

  sleep(min, max) {
    const ms = max ? Math.floor(Math.random() * (max - min) + min) : min;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async humanType(selector, text) {
    const el = await this.page.waitForSelector(selector, { timeout: 10000 });
    await el.click();
    for (const ch of text) {
      await this.page.keyboard.type(ch, { delay: Math.floor(Math.random() * 100) + 30 });
    }
  }

  async tryClick(selectors, { timeout = 5000 } = {}) {
    for (const sel of selectors) {
      try {
        const el = await this.page.waitForSelector(sel, { timeout });
        if (el) {
          await el.click();
          return true;
        }
      } catch { /* try next */ }
    }
    return false;
  }

  /**
   * Serialize cookies array into a Cookie header string (browserless mode)
   */
  serializeCookies(cookies) {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  /**
   * Make direct API request using Node.js fetch (browserless mode)
   */
  async directFetch(url, options = {}) {
    const { method = 'GET', headers = {}, body = null } = options;
    
    const fetchHeaders = { ...headers };
    if (this.options.cookies) {
      fetchHeaders['cookie'] = this.serializeCookies(this.options.cookies);
    }

    const fetchOptions = {
      method,
      headers: fetchHeaders,
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    const resp = await fetch(url, fetchOptions);
    const contentType = resp.headers.get('content-type') || '';

    let data;
    if (contentType.includes('application/json')) {
      data = await resp.json();
    } else {
      data = await resp.text();
    }

    return {
      _status: resp.status,
      _ok: resp.ok,
      _headers: Object.fromEntries(resp.headers.entries()),
      data,
    };
  }

  /**
   * Make API request - uses browser evaluate in browser mode, direct fetch in browserless mode
   */
  async apiFetch(url, headers = {}) {
    // Browserless mode: use direct fetch
    if (!this.page) {
      const result = await this.directFetch(url, { method: 'GET', headers });
      return result._ok ? { ...result.data, _status: result._status, _ok: result._ok } : { _status: result._status, _ok: false };
    }
    
    // Browser mode: use page.evaluate
    return this.page.evaluate(async ({ url, headers }) => {
      const resp = await fetch(url, { headers, credentials: 'include' });
      if (!resp.ok) return { _status: resp.status, _ok: false };
      const data = await resp.json();
      data._status = resp.status;
      data._ok = true;
      return data;
    }, { url, headers });
  }

  /**
   * Make GraphQL request - uses browser evaluate in browser mode, direct fetch in browserless mode
   */
  async graphqlFetch(operationName, query, variables = {}) {
    const csrfToken = this.options.csrfToken || null;
    
    // Browserless mode: use direct fetch
    if (!this.page) {
      const headers = {
        'content-type': 'application/json',
        'accept': 'application/json',
      };
      if (csrfToken) headers['X-CSRF-TOKEN'] = csrfToken;
      
      const result = await this.directFetch(config.endpoints.graphql, {
        method: 'POST',
        headers,
        body: { operationName, query, variables },
      });
      
      return result._ok ? { ...result.data, _status: result._status, _ok: result._ok } : { _status: result._status, _ok: false };
    }
    
    // Browser mode: use page.evaluate
    return this.page.evaluate(async ({ operationName, query, variables, csrfToken }) => {
      const headers = {
        'content-type': 'application/json',
        'accept': 'application/json',
      };
      if (csrfToken) headers['X-CSRF-TOKEN'] = csrfToken;
      const resp = await fetch('/graphql', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ operationName, query, variables }),
      });
      if (!resp.ok) return { _status: resp.status, _ok: false };
      const data = await resp.json();
      data._status = resp.status;
      data._ok = true;
      return data;
    }, { operationName, query, variables, csrfToken });
  }

  /**
   * Load existing orders from storage
   */
  async loadExistingOrders() {
    return storage.loadOrders();
  }

  /**
   * Save orders - appends new orders, updates existing ones
   */
  async saveOrders(newOrders) {
    // Load existing orders
    const existingOrders = await this.loadExistingOrders();

    // Create a map of existing orders by orderId
    const ordersMap = new Map();
    for (const order of existingOrders) {
      if (order.orderId) {
        ordersMap.set(order.orderId, order);
      }
    }

    // Process new orders:
    // - If order exists and status is DELIVERED and has items, skip (keep existing)
    // - If order exists and status is NOT DELIVERED, update with new data
    // - If order is new, add it
    let addedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const newOrder of newOrders) {
      const orderId = newOrder.orderId;
      if (!orderId) continue;

      const existing = ordersMap.get(orderId);

      if (existing) {
        if (existing.status === 'DELIVERED' && existing.items && existing.items.length > 0) {
          skippedCount++;
        } else {
          ordersMap.set(orderId, newOrder);
          updatedCount++;
        }
      } else {
        ordersMap.set(orderId, newOrder);
        addedCount++;
      }
    }

    // Convert map back to array and sort by date descending
    const finalOrders = Array.from(ordersMap.values());
    finalOrders.sort((a, b) => {
      if (!a.date || !b.date) return 0;
      return new Date(b.date) - new Date(a.date);
    });

    await storage.saveOrders(finalOrders);

    console.log(`  Saved ${finalOrders.length} orders`);
    console.log(`  Added: ${addedCount}, Updated: ${updatedCount}, Skipped: ${skippedCount}`);

    return finalOrders;
  }

  /**
   * Execute the scrape orders operation
   */
  async execute() {
    const page = this.page;

    // Wait a bit to ensure we're on a valid page after login
    await this.sleep(2000, 4000);

    // -----------------------------------------------------------------------
    // 1. Load existing orders from history file
    // -----------------------------------------------------------------------
    const existingOrders = await this.loadExistingOrders();
    const existingMap = new Map();
    for (const order of existingOrders) {
      if (order.orderId) existingMap.set(order.orderId, order);
    }
    console.log(`\nExisting orders in file: ${existingMap.size}`);

    // -----------------------------------------------------------------------
    // 2. Fetch full order list via GraphQL (with cursor pagination)
    // -----------------------------------------------------------------------
    console.log('\nFetching all completed orders via GraphQL...');

    const COMPLETED_ORDERS_QUERY = `
      query GetCompletedOrders($first: Int!, $after: String) {
        completedOrders(first: $first, after: $after) {
          pageInfo {
            endCursor
            hasNextPage
          }
          edges {
            node {
              orderId
              status
            }
          }
        }
      }
    `;

    const PAGE_SIZE = 20;
    const MAX_PAGES = 50;
    const allOrderIds = [];
    const seenOrderIds = new Set();
    let cursor = null;
    let hasNextPage = true;
    let pageNum = 0;

    while (hasNextPage && pageNum < MAX_PAGES) {
      pageNum++;
      const variables = { first: PAGE_SIZE };
      if (cursor) variables.after = cursor;

      const result = await this.graphqlFetch('GetCompletedOrders', COMPLETED_ORDERS_QUERY, variables);

      if (!result._ok) {
        console.error(`  GraphQL returned status ${result._status}. Stopping.`);
        break;
      }

      if (result.errors) {
        console.error(`  GraphQL errors: ${JSON.stringify(result.errors).substring(0, 300)}`);
        break;
      }

      const connection = result.data?.completedOrders;
      if (!connection) {
        console.error('  No completedOrders in response.');
        break;
      }

      const edges = connection.edges || [];
      const pageInfo = connection.pageInfo || {};

      for (const edge of edges) {
        const node = edge.node;
        if (!node?.orderId || seenOrderIds.has(node.orderId)) continue;
        seenOrderIds.add(node.orderId);
        allOrderIds.push(node.orderId);
      }

      console.log(`  Page ${pageNum}: ${edges.length} orders (${allOrderIds.length} total unique)`);

      hasNextPage = pageInfo.hasNextPage === true;
      cursor = pageInfo.endCursor || null;

      if (!hasNextPage || edges.length === 0) break;
      await this.sleep(500, 1000);
    }

    console.log(`  Done — ${allOrderIds.length} orders across ${pageNum} pages`);

    // -----------------------------------------------------------------------
    // 3. Diff against history file — only fetch new or non-delivered orders
    // -----------------------------------------------------------------------
    const ordersToFetch = [];
    for (const orderId of allOrderIds) {
      const existing = existingMap.get(orderId);
      if (existing && existing.status === 'DELIVERED' && existing.items?.length > 0) {
        continue; // already complete
      }
      ordersToFetch.push(orderId);
    }

    console.log(`\n  New or non-delivered: ${ordersToFetch.length}`);
    console.log(`  Already complete (skipped): ${allOrderIds.length - ordersToFetch.length}`);

    if (ordersToFetch.length === 0) {
      console.log('\nAll orders are up to date.');
      const finalOrders = await this.saveOrders([]);
      return { success: true, message: `No new orders. ${existingMap.size} orders in file`, orders: Array.from(existingMap.values()) };
    }

    // -----------------------------------------------------------------------
    // 4. Fetch order details via REST API
    // -----------------------------------------------------------------------
    console.log(`\nFetching details for ${ordersToFetch.length} orders via REST API...`);

    const REST_HEADERS = {
      'accept': 'application/json; charset=utf-8',
      'ecom-request-source': 'web',
    };
    const fullOrders = [];

    for (let i = 0; i < ordersToFetch.length; i++) {
      const orderId = ordersToFetch[i];
      console.log(`  [${i + 1}/${ordersToFetch.length}] Fetching order ${orderId} ...`);

      const detailUrl = config.endpoints.orderDetail(orderId);
      const detail = await this.apiFetch(detailUrl, REST_HEADERS);

      if (detail._ok) {
        delete detail._status;
        delete detail._ok;
        const orderData = detail.entities?.order?.[orderId] || detail;
        fullOrders.push(orderData);
      } else if (detail._status === 404) {
        // Fallback: navigate to order details page
        console.log(`    Direct API 404 — falling back to page navigation ...`);

        const detailData = await new Promise(async (resolve) => {
          let resolved = false;
          const timeout = setTimeout(() => {
            if (!resolved) { resolved = true; resolve(null); }
          }, 15000);

          const handler = async (response) => {
            const url = response.url();
            if (url.includes(orderId) && url.includes('/api/') &&
                (response.headers()['content-type'] || '').includes('json')) {
              try {
                const body = await response.json();
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  page.off('response', handler);
                  resolve(body);
                }
              } catch { /* ignore parse errors */ }
            }
          };

          page.on('response', handler);
          try {
            await page.goto(config.endpoints.orderDetailPage(orderId), {
              waitUntil: 'domcontentloaded',
              timeout: 12000,
            });
          } catch {
            if (!resolved) { resolved = true; clearTimeout(timeout); page.off('response', handler); resolve(null); }
          }
        });

        if (detailData) {
          const orderData = detailData.entities?.order?.[orderId] || detailData;
          fullOrders.push(orderData);
        } else {
          console.log(`    Could not fetch details for ${orderId}`);
          fullOrders.push({ _orderId: orderId });
        }
      } else {
        console.log(`    API returned ${detail._status} for ${orderId}`);
        fullOrders.push({ _orderId: orderId });
      }

      if (i < ordersToFetch.length - 1) {
        await this.sleep(1000, 2000);
      }
    }

    // -----------------------------------------------------------------------
    // 5. Merge, format, and save
    // -----------------------------------------------------------------------
    console.log('\nProcessing and saving results ...');

      const orders = fullOrders.map((o) => {
      const rawProducts = o.groupedProducts?.products || [];
      const substitutes = o.groupedProducts?.substitutes || [];

      // Save all product details from the API
      const items = rawProducts.map((p) => ({
        productId: p.productId || null,
        type: p.type || null,
        retailerProductId: p.retailerProductId || null,
        name: p.name || 'Unknown',
        quantity: p.quantity || 1,
        image: p.image ? {
          src: p.image.src || null,
          alt: p.image.alt || null,
          title: p.image.title || null,
        } : null,
        prices: p.prices ? {
          retail: p.prices.retail ? {
            amount: p.prices.retail.amount || null,
            currency: p.prices.retail.currency || null,
          } : null,
          offered: p.prices.offered ? {
            amount: p.prices.offered.amount || null,
            currency: p.prices.offered.currency || null,
          } : null,
          grossOffered: p.prices.grossOffered || null,
          netOffered: p.prices.netOffered || null,
          pricePerItem: p.prices.pricePerItem ? {
            amount: p.prices.pricePerItem.amount || null,
            currency: p.prices.pricePerItem.currency || null,
          } : null,
          pricePerUnit: p.prices.pricePerUnit || null,
        } : null,
        packInfo: p.packInfo ? {
          packSizeDescription: p.packInfo.packSizeDescription || null,
          weight: p.packInfo.weight || null,
          typicalWeight: p.packInfo.typicalWeight || null,
          subtext: p.packInfo.subtext || null,
        } : null,
        isInCurrentCatalog: p.isInCurrentCatalog || false,
        promotions: p.promotions || [],
        substitutes: p.substitutes || [],
        proposedSubstitutes: p.proposedSubstitutes || [],
        preferredSubstitute: p.preferredSubstitute || null,
        isAlcohol: p.isAlcohol || false,
        sellerId: p.sellerId || null,
        expirationDate: p.expirationDate || null,
        storageType: p.storageType || null,
        isSample: p.isSample || false,
      }));

      // Add accepted substitutes as separate items
      for (const sub of substitutes) {
        const accepted = (sub.substitutes || []).find((s) => s.status === 'ACCEPTED');
        if (accepted) {
          items.push({
            productId: accepted.productId || null,
            type: accepted.type || null,
            retailerProductId: accepted.retailerProductId || null,
            name: `${accepted.name} (sub for ${sub.name})`,
            quantity: accepted.quantity || 1,
            image: accepted.image ? {
              src: accepted.image.src || null,
              alt: accepted.image.alt || null,
              title: accepted.image.title || null,
            } : null,
            prices: accepted.prices ? {
              retail: accepted.prices.retail ? {
                amount: accepted.prices.retail.amount || null,
                currency: accepted.prices.retail.currency || null,
              } : null,
              offered: accepted.prices.offered ? {
                amount: accepted.prices.offered.amount || null,
                currency: accepted.prices.offered.currency || null,
              } : null,
              grossOffered: accepted.prices.grossOffered || null,
              netOffered: accepted.prices.netOffered || null,
              pricePerItem: accepted.prices.pricePerItem ? {
                amount: accepted.prices.pricePerItem.amount || null,
                currency: accepted.prices.pricePerItem.currency || null,
              } : null,
              pricePerUnit: accepted.prices.pricePerUnit || null,
            } : null,
            packInfo: accepted.packInfo ? {
              packSizeDescription: accepted.packInfo.packSizeDescription || null,
              weight: accepted.packInfo.weight || null,
              typicalWeight: accepted.packInfo.typicalWeight || null,
              subtext: accepted.packInfo.subtext || null,
            } : null,
            isInCurrentCatalog: accepted.isInCurrentCatalog || false,
            promotions: accepted.promotions || [],
            substitutes: accepted.substitutes || [],
            proposedSubstitutes: accepted.proposedSubstitutes || [],
            preferredSubstitute: accepted.preferredSubstitute || null,
            isAlcohol: accepted.isAlcohol || false,
            sellerId: accepted.sellerId || null,
            expirationDate: accepted.expirationDate || null,
            storageType: accepted.storageType || null,
            isSample: accepted.isSample || false,
            _isSubstitute: true,
            _substitutedFor: sub.name,
          });
        }
      }

      const totals = o.orderTotals || {};
      const charges = o.charges || {};

      return {
        orderId: o.orderId || o.orderReference || '',
        date: o.dates?.deliveryStartDate || null,
        total: totals.finalPrice ? `£${totals.finalPrice.amount}` : null,
        status: o.status || null,
        totalItems: o.totalItems || items.length || null,
        address: o.address || null,
        charges: {
          delivery: charges.delivery ? `£${charges.delivery.amount}` : null,
          carrierBag: charges.carrierBag ? `£${charges.carrierBag.amount}` : null,
          deliveryPromo: charges.deliveryPromotion?.promoDescription || null,
        },
        savings: totals.totalSavings ? `£${totals.totalSavings.amount}` : null,
        items,
      };
    });

    // Sort by date descending
    orders.sort((a, b) => {
      if (!a.date || !b.date) return 0;
      return new Date(b.date) - new Date(a.date);
    });

    // Save orders using the saveOrders method (appends new orders, updates existing)
    const finalOrders = await this.saveOrders(orders);

    return { success: true, message: `Scraped ${orders.length} orders, ${finalOrders.length} total in file`, orders: finalOrders };
  }
}

module.exports = ScrapeOrdersOperation;
