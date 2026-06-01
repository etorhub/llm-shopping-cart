require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const puppeteer = require('puppeteer');
const config = require('../config');

/**
 * Manages browser lifecycle for operations
 */
class BrowserManager {
  constructor(options = {}) {
    this.options = {
      headless: options.headless ?? true,
      useStealth: options.useStealth ?? false,
      viewport: options.viewport || { width: 1280, height: 900 },
      locale: options.locale || config.locale,
      timezoneId: options.timezoneId || config.timezoneId,
      userAgent: options.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ...options,
    };
    
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * Launch browser and create a new context/page
   */
  async launch() {
    console.log(`Launching browser... (headless: ${this.options.headless})`);
    
    if (this.options.useStealth) {
      // Use Playwright with stealth plugin
      chromium.use(stealth());
      this.browser = await chromium.launch({
        headless: this.options.headless,
        args: [
          '--disable-blink-features=AutomationControlled',
          `--window-size=${this.options.viewport.width},${this.options.viewport.height}`,
        ],
      });
      
      this.context = await this.browser.newContext({
        viewport: this.options.viewport,
        locale: this.options.locale,
        timezoneId: this.options.timezoneId,
        userAgent: this.options.userAgent,
      });
    } else {
      // Use Puppeteer
      this.browser = await puppeteer.launch({
        headless: this.options.headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      
      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();
      await this.page.setViewport({ 
        width: this.options.viewport.width, 
        height: this.options.viewport.height 
      });
      
      return { browser: this.browser, context: null, page: this.page };
    }
    
    this.page = await this.context.newPage();
    console.log('Browser launched successfully');
    
    return { browser: this.browser, context: this.context, page: this.page };
  }

  /**
   * Get the current page
   */
  getPage() {
    return this.page;
  }

  /**
   * Get the browser instance
   */
  getBrowser() {
    return this.browser;
  }

  /**
   * Get the browser context
   */
  getContext() {
    return this.context;
  }

  /**
   * Take a screenshot
   */
  async screenshot(name) {
    if (this.page) {
      await this.page.screenshot({ path: name, fullPage: true });
      console.log(`Screenshot saved: ${name}`);
    }
  }

  /**
   * Close the browser
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      console.log('Browser closed');
    }
  }
}

module.exports = BrowserManager;
