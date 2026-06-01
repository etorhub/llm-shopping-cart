const fs = require('fs');
const Operation = require('../modules/Operation');
const config = require('../config');

const SESSION_FILE = './session.json';

/**
 * Login operation - opens a browser for the user to log in manually,
 * then captures cookies + CSRF token into session.json.
 *
 * Adapted to be retailer-agnostic (see src/config.js). For Bonpreu the login
 * redirects to app.bonpreu.cat (OpenID Connect), NOT Ocado SSO, so we detect
 * "still logging in" via config.ssoHosts and the words login/authorize/openid.
 *
 * IMPORTANT: the CSRF token location may differ from Ocado. This version tries
 * several strategies. After your first login, check which one worked; if none
 * did, open DevTools on the logged-in site, search for "csrf", and adjust
 * extractCsrf() accordingly.
 */
class LoginOperation extends Operation {
  constructor(options = {}) {
    super('Login');
    this.options = { ...options };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isLoginUrl(url) {
    const lower = url.toLowerCase();
    if (lower.includes('login') || lower.includes('authorize') || lower.includes('openid')) {
      return true;
    }
    return config.ssoHosts.some((h) => lower.includes(h.toLowerCase()));
  }

  async extractCsrf() {
    // Strategy 1: window.__INITIAL_STATE__ (Ocado UK location)
    let token = await this.page.evaluate(() => {
      try {
        if (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.session
            && window.__INITIAL_STATE__.session.csrf
            && window.__INITIAL_STATE__.session.csrf.token) {
          return window.__INITIAL_STATE__.session.csrf.token;
        }
      } catch (e) { /* ignore */ }
      return null;
    });
    if (token) return { token, source: '__INITIAL_STATE__' };

    // Strategy 2: a <meta name="csrf-token"> or similar tag
    token = await this.page.evaluate(() => {
      const sel = document.querySelector('meta[name="csrf-token"], meta[name="csrf"], meta[name="X-CSRF-TOKEN"]');
      return sel ? sel.getAttribute('content') : null;
    });
    if (token) return { token, source: 'meta-tag' };

    // Strategy 3: deep-search any window state object for a csrf-looking key
    token = await this.page.evaluate(() => {
      function findCsrf(obj, depth) {
        if (!obj || depth > 4 || typeof obj !== 'object') return null;
        for (const k of Object.keys(obj)) {
          if (/csrf/i.test(k) && typeof obj[k] === 'string' && obj[k].length > 8) {
            return obj[k];
          }
          const nested = findCsrf(obj[k], depth + 1);
          if (nested) return nested;
        }
        return null;
      }
      try { return findCsrf(window.__INITIAL_STATE__ || window.__PRELOADED_STATE__ || {}, 0); }
      catch (e) { return null; }
    });
    if (token) return { token, source: 'state-deep-search' };

    // Strategy 4: a cookie named *csrf*
    const cookies = await this.page.cookies();
    const csrfCookie = cookies.find((c) => /csrf/i.test(c.name));
    if (csrfCookie) return { token: csrfCookie.value, source: 'cookie:' + csrfCookie.name };

    return { token: null, source: 'none' };
  }

  async execute() {
    const page = this.page;

    console.log('Navigating to ' + config.baseUrl + ' ...');
    await page.goto(config.baseUrl + '/', { waitUntil: 'networkidle0', timeout: 30000 });
    console.log('  Loaded: ' + page.url());
    await this.sleep(2000);

    console.log('Looking for cookie accept button...');
    try {
      await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
      await page.click('#onetrust-accept-btn-handler');
      console.log('  Cookies accepted');
    } catch (e) {
      console.log('  No cookie banner found or already accepted');
    }
    await this.sleep(1000);

    console.log('Navigating to login page...');
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('  Loaded: ' + page.url());

    console.log('\n  Please log in manually in the browser window.');
    console.log('  Enter your email and password, complete any CAPTCHA or 2FA, then wait.\n');

    const loginTimeout = 5 * 60 * 1000;
    const startTime = Date.now();
    let loggedIn = false;

    while (Date.now() - startTime < loginTimeout) {
      await this.sleep(2000);
      if (!this.isLoginUrl(page.url())) { loggedIn = true; break; }
    }

    if (!loggedIn) {
      console.log('  Login timed out - no login detected within 5 minutes');
      return { success: false, message: 'Login timed out' };
    }

    console.log('  Login successful! Current URL: ' + page.url());

    try {
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
    } catch (e) { /* may already be done */ }

    const host = new URL(config.baseUrl).host;
    if (this.isLoginUrl(page.url()) || !page.url().includes(host)) {
      console.log('  Navigating back to ' + config.baseUrl + ' to capture session...');
      await page.goto(config.baseUrl + '/', { waitUntil: 'networkidle0', timeout: 30000 });
    }

    console.log('\nExtracting CSRF token...');
    let csrfToken = null;
    let csrfSource = 'none';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await this.extractCsrf();
      if (res.token) {
        csrfToken = res.token; csrfSource = res.source;
        console.log('  CSRF token found via ' + res.source + ': ' + csrfToken.substring(0, 10) + '...');
        break;
      }
      console.log('  CSRF not found yet (attempt ' + attempt + '/5), waiting...');
      await this.sleep(2000);
      if (attempt === 3) {
        console.log('  Reloading page to retry...');
        await page.reload({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});
      }
    }

    if (!csrfToken) {
      console.log('\n  WARNING: CSRF token NOT found by any strategy.');
      console.log('  Cookies will still be saved. Inspect the logged-in site');
      console.log('  (DevTools > search "csrf") and update extractCsrf() in');
      console.log('  src/operations/LoginOperation.js.');
    }

    console.log('\nSaving session to file...');
    const cookies = await page.cookies();
    const session = { cookies, csrfToken, csrfSource, retailer: config.retailer };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    console.log('  Saved ' + cookies.length + ' cookies' + (csrfToken ? ' + CSRF token' : ' (NO CSRF)') + ' to ' + SESSION_FILE);

    return { success: true, message: 'Login successful', csrfToken };
  }
}

module.exports = LoginOperation;
