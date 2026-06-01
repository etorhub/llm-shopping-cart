require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Operation = require('../modules/Operation');
const config = require('../config');

// Simple UUID v4 generator (no external dependency needed)
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Add to Cart operation - adds items to the Ocado cart via API
 * 
 * Input format:
 * {
 *   items: [
 *     { productId: "uuid-string", quantity: 1 },
 *     { productId: "uuid-string", quantity: 2 }
 *   ]
 * }
 * 
 * Or with optional meta:
 * {
 *   items: [
 *     { 
 *       productId: "uuid-string", 
 *       quantity: 1,
 *       meta: {
 *         itemListName: "search results",
 *         pageType: "SEARCH",
 *         favorite: false
 *       }
 *     }
 *   ]
 * }
 */
class AddToCartOperation extends Operation {
  constructor(options = {}) {
    super('AddToCart');
    this.options = {
      items: options.items || [],
      csrfToken: options.csrfToken || null,
      ...options,
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Helper to get CSRF token from cookies
   */
  async getCsrfToken() {
    const cookies = await this.page.cookies();
    const csrfCookie = cookies.find(c => c.name === 'X-CSRF-TOKEN' || c.name === 'csrfToken');
    return csrfCookie ? csrfCookie.value : null;
  }

  /**
   * Helper to get a cookie value by name
   */
  async getCookie(name) {
    const cookies = await this.page.cookies();
    const cookie = cookies.find(c => c.name === name);
    return cookie ? cookie.value : null;
  }

  /**
   * Serialize cookies array into a Cookie header string
   */
  serializeCookies(cookies) {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  /**
   * Make API request using page.evaluate (browser mode)
   */
  async apiFetch(url, method, headers, body) {
    if (!this.page) {
      return this.directFetch(url, method, headers, body);
    }
    return this.page.evaluate(async ({ url, method, headers, body }) => {
      const fetchOptions = {
        method,
        headers,
        credentials: 'include',
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
    }, { url, method, headers, body });
  }

  /**
   * Make API request using Node fetch (browserless mode)
   */
  async directFetch(url, method, headers, body) {
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
   * Build the request body for the add to cart API
   */
  buildRequestBody(items) {
    // Generate a pageViewId for this request
    const pageViewId = generateUUID();
    
    return items.map(item => {
      const requestItem = {
        productId: item.productId,
        quantity: item.quantity,
      };
      
      // Only add meta if explicitly provided (for decrement/remove, meta is omitted)
      if (item.meta) {
        requestItem.meta = {
          ...item.meta,
          pageViewId: item.meta.pageViewId || pageViewId,
        };
      } else if (item.quantity > 0) {
        // Add default meta for positive quantities
        requestItem.meta = {
          itemListName: 'direct_add',
          pageViewId: pageViewId,
          pageType: 'BASKET',
          favorite: false,
        };
      }
      
      return requestItem;
    });
  }

  /**
   * Execute the add to cart operation
   */
  async execute() {
    const page = this.page;
    const { items } = this.options;

    if (!items || items.length === 0) {
      throw new Error('No items provided to add to cart. Please provide an items array with productId and quantity.');
    }

    // Validate items
    for (const item of items) {
      if (!item.productId) {
        throw new Error('Each item must have a productId');
      }
      if (typeof item.quantity !== 'number' || item.quantity === 0) {
        throw new Error('Each item must have a quantity (positive to add, negative to remove)');
      }
    }

    // Build productId -> name map from order history + current items
    const nameMap = new Map();
    const orders = this.options.orders || [];
    for (const order of orders) {
      for (const item of (order.items || [])) {
        if (item.productId && item.name) nameMap.set(item.productId, item.name);
      }
    }
    // Override with current matchedName (more specific)
    for (const item of items) {
      if (item.matchedName) nameMap.set(item.productId, item.matchedName);
    }

    console.log(`\nAdding ${items.length} item(s) to cart...`);

    // Wait a bit to ensure we're on a valid page after login (browser mode only)
    if (this.page) {
      await this.sleep(1000, 2000);
    }

    // -----------------------------------------------------------------------
    // 1. Get required headers and tokens
    // -----------------------------------------------------------------------
    console.log('Getting authentication tokens...');

    // Use CSRF token from options if provided, otherwise try to get from cookies
    let csrfToken = this.options.csrfToken;
    if (!csrfToken && this.page) {
      csrfToken = await this.getCsrfToken();
    }

    if (!csrfToken) {
      console.log('  Warning: CSRF token not found');
    } else {
      console.log(`  CSRF token found: ${csrfToken.substring(0, 10)}...`);
    }

    // Get existing page-view-id or generate new one
    let pageViewId;
    if (this.page) {
      pageViewId = await this.getCookie('page-view-id');
    }
    if (!pageViewId) {
      pageViewId = generateUUID();
    }

    // Get client-route-id
    let clientRouteId = 'web';
    if (this.page) {
      clientRouteId = await this.getCookie('client-route-id') || 'web';
    }

    // -----------------------------------------------------------------------
    // 2. Build request and make API call
    // -----------------------------------------------------------------------
    const apiUrl = config.endpoints.applyQuantity;
    
    const headers = {
      'accept': 'application/json; charset=utf-8',
      'content-type': 'application/json; charset=utf-8',
      'ecom-request-source': 'web',
      'ecom-request-source-version': '2.51.0',
      'page-view-id': pageViewId,
      'client-route-id': clientRouteId,
    };

    if (csrfToken) {
      headers['X-CSRF-TOKEN'] = csrfToken;
    }

    const requestBody = this.buildRequestBody(items);
    
    console.log(`\nSending request to ${apiUrl}...`);

    const result = await this.apiFetch(apiUrl, 'POST', headers, requestBody);

    const response = {
      status: result._status,
      ok: result._ok,
      data: result.data,
    };

    console.log(`\nAPI Response:`);
    console.log(`  Status: ${response.status}`);
    console.log(`  OK: ${response.ok}`);

    if (!response.ok) {
      console.error(`  Error response: ${JSON.stringify(response.data)}`);
      
      // Check for common errors
      if (response.status === 401) {
        throw new Error('Authentication required. Please login first.');
      } else if (response.status === 403) {
        throw new Error('CSRF token invalid or missing. Please try again.');
      } else if (response.status === 400) {
        throw new Error(`Bad request: ${JSON.stringify(response.data)}`);
      }
      
      return {
        success: false,
        message: `Failed to add items to cart. Status: ${response.status}`,
        error: response.data,
      };
    }

    // -----------------------------------------------------------------------
    // 3. Process and return the cart response
    // -----------------------------------------------------------------------
    const cartData = response.data;
    
    // Extract basket info if available
    const basketResult = cartData.basketUpdateResult || {};
    const itemGroups = basketResult.itemGroups || [];
    const totals = basketResult.totals || {};
    
    console.log(`\nCart updated successfully!`);
    console.log(`  Item groups: ${itemGroups.length}`);
    
    // Count total items
    let totalItems = 0;
    for (const group of itemGroups) {
      const items = group.items || [];
      totalItems += items.length;
      for (const item of items) {
        const name = nameMap.get(item.productId) || item.productId;
        console.log(`    - ${name}: qty=${item.quantity}, price=£${item.price?.amount || 'N/A'}`);
      }
    }
    
    console.log(`  Total items in cart: ${totalItems}`);
    console.log(`  Items retail price: ${totals.itemsRetailPrice?.currency || '£'}${totals.itemsRetailPrice?.amount || '0.00'}`);

    // -----------------------------------------------------------------------
    // 4. Follow-up: Fetch full cart state
    // -----------------------------------------------------------------------
    console.log('\nFetching full cart state...');
    
    const cartHeaders = {
      'accept': 'application/json; charset=utf-8',
      'ecom-request-source': 'web',
    };
    
    if (csrfToken) {
      cartHeaders['X-CSRF-TOKEN'] = csrfToken;
    }
    
    const cartResponse = await this.apiFetch(
      config.endpoints.cartActive,
      'GET',
      cartHeaders
    );

    if (cartResponse._ok) {
      console.log('  Full cart state fetched successfully');
    } else {
      console.log(`  Warning: Could not fetch full cart state (${cartResponse._status})`);
    }

    return {
      success: true,
      message: `Successfully added ${items.length} item(s) to cart`,
      itemsAdded: items,
      cartUpdate: cartData,
      fullCart: cartResponse._ok ? cartResponse.data : null,
    };
  }
}

module.exports = AddToCartOperation;
