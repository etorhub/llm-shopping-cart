/**
 * Central retailer configuration.
 *
 * The original project hard-coded ocado.com everywhere. Because Bonpreu runs on
 * the same Ocado Smart Platform, the API *paths* are identical — only the base
 * domain, the login/SSO flow, the locale and the currency differ.
 *
 * Override any of these with environment variables (e.g. in a .env file) so you
 * never have to touch the operation files again.
 */
require('dotenv').config({ quiet: true });

const RETAILER = process.env.RETAILER || 'bonpreu';

const PRESETS = {
  ocado: {
    baseUrl: 'https://www.ocado.com',
    loginUrl: 'https://www.ocado.com/login',
    // Hostnames that mean "still on a login/SSO page, not logged in yet"
    ssoHosts: ['accounts.ocado.com', 'sso.ocado.com'],
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    currency: '£',
  },
  bonpreu: {
    baseUrl: 'https://www.compraonline.bonpreuesclat.cat',
    loginUrl: 'https://www.compraonline.bonpreuesclat.cat/login',
    // Bonpreu uses its own OpenID Connect server, NOT Ocado SSO.
    // While the browser URL contains app.bonpreu.cat we are still logging in.
    ssoHosts: ['app.bonpreu.cat', 'openid-connect'],
    locale: 'ca-ES',
    timezoneId: 'Europe/Madrid',
    currency: '€',
  },
};

const preset = PRESETS[RETAILER] || PRESETS.bonpreu;

// Allow per-field env overrides
const config = {
  retailer: RETAILER,
  baseUrl: process.env.BASE_URL || preset.baseUrl,
  loginUrl: process.env.LOGIN_URL || preset.loginUrl,
  ssoHosts: preset.ssoHosts,
  locale: process.env.LOCALE || preset.locale,
  timezoneId: process.env.TIMEZONE_ID || preset.timezoneId,
  currency: process.env.CURRENCY || preset.currency,
};

// Convenience: full endpoint URLs (paths are shared across Ocado OSP retailers)
config.endpoints = {
  cartActive: `${config.baseUrl}/api/cart/v1/carts/active`,
  applyQuantity: `${config.baseUrl}/api/cart/v1/carts/active/apply-quantity`,
  graphql: `${config.baseUrl}/graphql`,
  orderDetail: (orderId) => `${config.baseUrl}/api/order/v6/orders/${orderId}`,
  orderDetailPage: (orderId) => `${config.baseUrl}/orders/${orderId}/details`,
};

module.exports = config;
