#!/usr/bin/env node
/**
 * AURELIO - Elite Pricing Intelligence Agent for HidroBio S.A.
 *
 * Named after Aurelius - embodying wisdom, strategic thinking, and disciplined analysis.
 *
 * Aurelio is an autonomous pricing specialist that:
 * 1. Monitors daily supermarket prices for tomatoes and lettuce in Asuncion
 * 2. Applies reasoning architecture to analyze market conditions
 * 3. Generates strategic pricing recommendations aligned with HidroBio's premium positioning
 * 4. Syncs data to Zoho Analytics for business intelligence
 *
 * Deployment: Railway (cloud) - runs daily at 08:00 Paraguay time
 */

import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import Database from 'better-sqlite3';
// Note: nodemailer removed - Railway blocks SMTP, using Zoho Mail API instead
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // Agent Identity
  name: 'Aurelio',
  role: 'Elite Pricing Intelligence Specialist',

  // Schedule (Paraguay Time - UTC-4 / UTC-3 DST)
  schedule: {
    hour: 8,
    minute: 0,
    timezone: 'America/Asuncion'
  },

  // Products to monitor (costs from HidroBio Calculadora Precios 2026 v4)
  // Note: "Tomate Perita" = "Tomate Santa Cruz" in market
  // Note: "Tomate Lisa" can also be found as "Tomate Holandés"
  products: [
    {
      name: 'Tomate Lisa',
      searchTerms: ['tomate lisa', 'tomate redondo', 'tomate holandes', 'tomate holandés'],
      unit: 'kg',
      hidrobioCost: 6926,  // Gs. per kg (from calculator)
      hidrobioPisoAbsoluto: 8500,  // Floor price - never sell below
      marketMedianRef: 14950,  // Reference median from supermarkets
      hidrobioMinMargin: 0.25  // 25% minimum margin
    },
    {
      name: 'Tomate Perita',
      // Tomate Perita = Tomate Santa Cruz in Paraguay market
      searchTerms: ['tomate perita', 'tomate pera', 'tomate santa cruz'],
      unit: 'kg',
      hidrobioCost: 6926,
      hidrobioPisoAbsoluto: 8500,
      marketMedianRef: 6950,
      hidrobioMinMargin: 0.25
    },
    {
      name: 'Tomate Cherry',
      searchTerms: ['tomate cherry', 'cherry rojo'],  // Cherry is specific - don't fallback to other tomatoes
      unit: 'kg',
      hidrobioCost: 10000,  // Per kg
      hidrobioPisoAbsoluto: 12000,
      marketMedianRef: 18000,
      hidrobioMinMargin: 0.25
    },
    {
      name: 'Locote Rojo',
      searchTerms: ['locote rojo', 'pimiento rojo', 'morron rojo'],
      unit: 'kg',
      hidrobioCost: 12114,
      hidrobioPisoAbsoluto: 15000,
      marketMedianRef: 26900,
      hidrobioMinMargin: 0.25
    },
    {
      name: 'Locote Amarillo',
      searchTerms: ['locote amarillo', 'pimiento amarillo', 'morron amarillo'],
      unit: 'kg',
      hidrobioCost: 12114,
      hidrobioPisoAbsoluto: 15000,
      marketMedianRef: 47900,
      hidrobioMinMargin: 0.25
    },
    {
      name: 'Lechuga Pirati',
      searchTerms: ['lechuga pirati', 'lechuga crespa'],
      unit: 'unidad',
      hidrobioCost: 2500,
      hidrobioPisoAbsoluto: 3000,
      marketMedianRef: 4500,
      hidrobioMinMargin: 0.25
    },
    {
      name: 'Verdeos',
      searchTerms: ['cebollita', 'perejil', 'cilantro', 'verdeo'],
      unit: 'atado',
      hidrobioCost: 1500,
      hidrobioPisoAbsoluto: 1800,
      marketMedianRef: 3500,
      hidrobioMinMargin: 0.25
    }
  ],

  // Supermarkets to monitor (Asuncion Gran Area)
  supermarkets: [
    {
      name: 'Stock',
      enabled: true,
      baseUrl: 'https://www.stock.com.py',
      searchUrl: 'https://www.stock.com.py/search.aspx?searchterms={query}',
      scraper: 'stock',
      notes: 'nopCommerce platform, reliable HTML scraping'
    },
    {
      name: 'Superseis',
      enabled: true,
      baseUrl: 'https://www.superseis.com.py',
      searchUrl: 'https://www.superseis.com.py/search?search={query}',
      scraper: 'superseis',
      notes: 'Custom e-commerce, data-product-id attributes'
    },
    {
      name: 'Casa Rica',
      enabled: true,
      baseUrl: 'https://casarica.com.py',
      // Search doesn't work well for fresh produce, use category instead
      categoryUrl: 'https://casarica.com.py/catalogo/verduras-c287',
      scraper: 'casarica',
      notes: 'WordPress/WooCommerce - use category browsing'
    },
    {
      name: 'Fortis',
      enabled: false,  // Disabled - Turbo/Hotwire app loads products via JS, needs browser automation
      baseUrl: 'https://www.fortis.com.py',
      searchUrl: 'https://www.fortis.com.py/busqueda?query={query}',
      scraper: 'fortis',
      notes: 'Rails + Turbo/Hotwire - requires Playwright/Puppeteer'
    },
    {
      name: 'Biggie',
      enabled: false,  // Disabled - requires browser automation (Vue SPA)
      baseUrl: 'https://www.biggie.com.py',
      // Biggie uses category browsing, not search
      categoryUrl: 'https://www.biggie.com.py/products/fruteria-y-verduleria?skip=0',
      scraper: 'biggie',
      notes: 'Vue/Nuxt SPA - API not public, needs Playwright/Puppeteer'
    },
    {
      name: 'Salemma',
      enabled: true,
      baseUrl: 'https://www.salemmaonline.com.py',
      searchUrl: 'https://www.salemmaonline.com.py/buscar?criterio={query}',
      categoryUrl: 'https://www.salemmaonline.com.py/frutas-y-verduras/verduras',
      scraper: 'salemma',
      notes: 'Laravel-based, category browsing recommended'
    }
  ],

  // HidroBio Premium Pricing Policy (from Calculator v4 + PricingPolicyHB.pdf)
  // Prices are expressed as % of market median (not cost-plus)
  pricingPolicy: {
    // Segment bands (% vs market median supermarket price)
    segments: {
      // S1: Consumidor Final - Venta directa, delivery, ferias
      consumidorFinal: {
        minPct: 0.85,   // 85% of median
        metaPct: 0.90,  // Target: 90% of median
        maxPct: 0.95,   // Max: 95% of median
        minMargin: 0.25,  // Must have at least 25% margin vs cost
        strategy: 'Mejor margen directo'
      },
      // S2: HORECA - Hoteles 4-5★, restaurantes gourmet
      horeca: {
        minPct: 0.70,
        metaPct: 0.75,
        maxPct: 0.80,
        minMargin: 0.20,
        strategy: 'Volumen consistente'
      },
      // S3: Supermercados - Stock, Superseis, Casa Rica
      supermercados: {
        minPct: 0.60,
        metaPct: 0.68,
        maxPct: 0.75,
        minMargin: 0.15,
        strategy: 'Volumen alto'
      },
      // S4: Institucional - Hospitales, colegios, comedores
      institucional: {
        minPct: 0.55,
        metaPct: 0.60,
        maxPct: 0.65,
        minMargin: 0.10,
        strategy: 'Contratos anuales'
      },
      // S5: Mayorista - EVITAR este segmento
      mayorista: {
        minPct: 0.45,
        metaPct: 0.50,
        maxPct: 0.55,
        minMargin: 0.05,
        strategy: '⚠️ EVITAR - Solo si hay exceso de producción'
      }
    },
    // Discounts for "Mediano" grade products (vs Standard)
    medianoDiscounts: {
      consumidorFinal: { min: -0.10, meta: -0.11, max: -0.12 },
      horeca: { min: -0.15, meta: -0.165, max: -0.18 },
      supermercados: { min: -0.12, meta: -0.135, max: -0.15 },
      institucional: { min: -0.10, meta: -0.11, max: -0.12 }
    },
    // Rules
    rules: {
      neverBelowPisoAbsoluto: true,  // Floor price is sacred
      horecaNeverBelowSupermercados: true,
      premiumPositioning: true,  // Never be the cheapest
      avoidMayoristaSegment: true  // Only as last resort
    }
  },

  // Zoho Analytics
  zoho: {
    orgId: '837764545',
    workspaceId: '2849493000002538243',
    marketPricesTableId: '2849493000003555002'
  },

  // Alert thresholds
  alerts: {
    priceChangeThreshold: 0.15,  // Alert on >15% change
    competitorUndercutThreshold: 0.20  // Alert if competitor >20% cheaper
  }
};

// =============================================================================
// DATABASE
// =============================================================================

class PriceDatabase {
  constructor() {
    const dataDir = join(__dirname, 'data');
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(join(dataDir, 'aurelio.db'));
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        supermarket TEXT NOT NULL,
        product TEXT NOT NULL,
        product_name_raw TEXT,
        price_guaranies INTEGER NOT NULL,
        unit TEXT DEFAULT 'kg',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(date, supermarket, product, product_name_raw)
      );

      CREATE TABLE IF NOT EXISTS analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        product TEXT NOT NULL,
        market_median INTEGER,
        market_min INTEGER,
        market_max INTEGER,
        hidrobio_recommended_price INTEGER,
        hidrobio_recommended_margin REAL,
        reasoning TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(date, product)
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        product TEXT,
        supermarket TEXT,
        message TEXT NOT NULL,
        severity TEXT DEFAULT 'info',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_prices_date ON prices(date);
      CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product);
      CREATE INDEX IF NOT EXISTS idx_analysis_date ON analysis(date);
    `);
  }

  savePrice(supermarket, product, priceGuaranies, productNameRaw, unit = 'kg') {
    const date = new Date().toISOString().split('T')[0];
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO prices (date, supermarket, product, product_name_raw, price_guaranies, unit)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(date, supermarket, product, productNameRaw, priceGuaranies, unit);
  }

  getTodayPrices(product = null) {
    const date = new Date().toISOString().split('T')[0];
    if (product) {
      return this.db.prepare(`
        SELECT * FROM prices WHERE date = ? AND product = ?
      `).all(date, product);
    }
    return this.db.prepare(`SELECT * FROM prices WHERE date = ?`).all(date);
  }

  getHistoricalPrices(product, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split('T')[0];

    return this.db.prepare(`
      SELECT * FROM prices
      WHERE product = ? AND date >= ?
      ORDER BY date DESC
    `).all(product, sinceStr);
  }

  getMedianPrice(product, days = 7) {
    const prices = this.getHistoricalPrices(product, days);
    if (prices.length === 0) return null;

    const values = prices.map(p => p.price_guaranies).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return values.length % 2 !== 0
      ? values[mid]
      : Math.round((values[mid - 1] + values[mid]) / 2);
  }

  saveAnalysis(product, analysis) {
    const date = new Date().toISOString().split('T')[0];
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO analysis
      (date, product, market_median, market_min, market_max,
       hidrobio_recommended_price, hidrobio_recommended_margin, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      date, product, analysis.marketMedian, analysis.marketMin, analysis.marketMax,
      analysis.recommendedPrice, analysis.recommendedMargin, analysis.reasoning
    );
  }

  saveAlert(alertType, message, severity = 'info', product = null, supermarket = null) {
    const date = new Date().toISOString().split('T')[0];
    const stmt = this.db.prepare(`
      INSERT INTO alerts (date, alert_type, product, supermarket, message, severity)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(date, alertType, product, supermarket, message, severity);
  }

  close() {
    this.db.close();
  }
}

// =============================================================================
// SCRAPERS
// =============================================================================

const SCRAPERS = {
  /**
   * Stock.com.py scraper (nopCommerce platform)
   * Structure: h2.product-title > a.product-title-link for name
   *            div.prices > span.price-label for price (format: "  17.950")
   */
  async stock(config, query) {
    const url = config.searchUrl.replace('{query}', encodeURIComponent(query));
    const results = [];

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 30000
      });

      const html = await response.text();
      const $ = cheerio.load(html);

      // Stock uses product-title-link for product names
      // Find all product titles and their associated prices
      $('h2.product-title').each((_, el) => {
        const $title = $(el);
        const name = $title.find('a.product-title-link').text().trim();

        // Navigate to the prices wrapper - it's near the product title
        // Look for div.prices in the parent container
        const $parent = $title.closest('div').parent();
        const priceText = $parent.find('span.price-label').first().text().trim();
        const price = extractPrice(priceText);

        if (name && price && isFreshProduce(name)) {
          results.push({
            supermarket: config.name,
            name: name.trim(),
            price,
            unit: detectUnit(name)
          });
        }
      });

      // Alternative: find by productPrice class directly
      if (results.length === 0) {
        $('span.productPrice').each((idx, el) => {
          const $price = $(el);
          const priceText = $price.find('span.price-label').text().trim();
          const price = extractPrice(priceText);

          // Find the corresponding product name (go up to parent container, then find title)
          const $container = $price.closest('div.prices-wrapper').parent();
          const name = $container.find('a.product-title-link').text().trim() ||
                      $container.find('h2.product-title a').text().trim();

          if (name && price && isFreshProduce(name)) {
            // Check for duplicates
            if (!results.some(r => r.name === name)) {
              results.push({
                supermarket: config.name,
                name: name.trim(),
                price,
                unit: detectUnit(name)
              });
            }
          }
        });
      }
    } catch (error) {
      console.error(`[Aurelio] Error scraping ${config.name}:`, error.message);
    }

    return results;
  },

  /**
   * Superseis.com.py scraper
   * Structure: div.product-thumb[data-product-id][data-product-price="₲ 17.950"]
   *            a[data-product-name]
   */
  async superseis(config, query) {
    const url = config.searchUrl.replace('{query}', encodeURIComponent(query));
    const results = [];

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 30000
      });

      const html = await response.text();
      const $ = cheerio.load(html);

      // Find products by data-product-id attribute on div.product-thumb
      $('div.product-thumb[data-product-id]').each((_, el) => {
        const $el = $(el);

        // Extract name from data-product-name attribute on anchor tag
        let name = $el.find('a[data-product-name]').attr('data-product-name') || '';
        if (!name) {
          // Fallback: get text from the anchor
          name = $el.find('a').first().text().trim();
        }

        // Extract price from data-product-price attribute (format: "₲ 17.950")
        const priceAttr = $el.attr('data-product-price') || '';
        const price = extractPrice(priceAttr);

        if (name && price && isFreshProduce(name)) {
          // Avoid duplicates
          if (!results.some(r => r.name === name)) {
            results.push({
              supermarket: config.name,
              name: name.trim(),
              price,
              unit: detectUnit(name)
            });
          }
        }
      });
    } catch (error) {
      console.error(`[Aurelio] Error scraping ${config.name}:`, error.message);
    }

    return results;
  },

  /**
   * Casa Rica scraper
   * Uses category browsing (search doesn't work well for fresh produce)
   * Structure: div.product > h2.ecommercepro-loop-product__title for name
   *            span.price > span.amount for price (format: "₲. 7.200")
   */
  async casarica(config, query) {
    const results = [];

    try {
      // Use category page for fresh produce
      const url = config.categoryUrl || 'https://casarica.com.py/catalogo/verduras-c287';

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 45000
      });

      const html = await response.text();
      const $ = cheerio.load(html);

      $('div.product').each((_, el) => {
        const $el = $(el);

        // Get name from product title
        let name = $el.find('h2.ecommercepro-loop-product__title').text().trim();
        if (!name) {
          name = $el.find('.product-title, .title').first().text().trim();
        }

        // Get price from span.amount (format: "₲. 7.200")
        let priceText = $el.find('span.amount').first().text().trim();
        const price = extractPrice(priceText);

        // Filter by query if provided
        const queryLower = query.toLowerCase();
        const nameLower = name.toLowerCase();

        if (name && price && nameLower.includes(queryLower.split(' ')[0]) && isFreshProduce(name)) {
          // Avoid duplicates
          if (!results.some(r => r.name === name)) {
            results.push({
              supermarket: config.name,
              name: name.trim(),
              price,
              unit: detectUnit(name)
            });
          }
        }
      });
    } catch (error) {
      console.error(`[Aurelio] Error scraping ${config.name}:`, error.message);
    }

    return results;
  },

  /**
   * Fortis.com.py scraper (Rails + Turbo/Hotwire)
   * Note: May require location cookie for full results
   */
  async fortis(config, query) {
    const url = config.searchUrl.replace('{query}', encodeURIComponent(query));
    const results = [];

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          // Set location cookie for Asuncion
          'Cookie': 'location=Asunción'
        },
        timeout: 30000
      });

      const html = await response.text();
      const $ = cheerio.load(html);

      // Fortis uses card-based product layout
      $('.product-card, .card, [data-product]').each((_, el) => {
        const $el = $(el);

        // Extract name
        let name = $el.find('.product-name, .card-title, h5, h6').first().text().trim();
        if (!name) {
          name = $el.find('a').first().text().trim();
        }

        // Extract price - Fortis uses Gs. format
        let priceText = $el.find('.price, .product-price, .text-primary').first().text();
        const price = extractPrice(priceText);

        if (name && price && isFreshProduce(name)) {
          results.push({
            supermarket: config.name,
            name: name.trim(),
            price,
            unit: detectUnit(name)
          });
        }
      });

      // Alternative: look for JSON-LD structured data
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).html());
          if (json['@type'] === 'Product' || (Array.isArray(json) && json[0]?.['@type'] === 'Product')) {
            const products = Array.isArray(json) ? json : [json];
            for (const p of products) {
              if (p.name && p.offers?.price && isFreshProduce(p.name)) {
                results.push({
                  supermarket: config.name,
                  name: p.name,
                  price: parseInt(p.offers.price) || extractPrice(String(p.offers.price)),
                  unit: detectUnit(p.name)
                });
              }
            }
          }
        } catch (e) { /* ignore parse errors */ }
      });

    } catch (error) {
      console.error(`[Aurelio] Error scraping ${config.name}:`, error.message);
    }

    return results;
  },

  /**
   * Biggie.com.py scraper (Vue/Nuxt SPA)
   * Uses internal API endpoint to fetch products
   */
  async biggie(config, query) {
    const results = [];

    try {
      // Biggie exposes an API for products - try to hit the category endpoint
      // The SPA fetches from an API, let's try the direct API call
      const apiUrl = 'https://api.biggie.com.py/api/v1/products';

      // First try: category-based browsing (more reliable)
      const categoryResponse = await fetch(
        `https://api.biggie.com.py/api/v1/classifications/fruteria-y-verduleria/products?skip=0&take=100`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Origin': 'https://www.biggie.com.py',
            'Referer': 'https://www.biggie.com.py/'
          },
          timeout: 30000
        }
      );

      if (categoryResponse.ok) {
        const data = await categoryResponse.json();
        const products = data.products || data.items || data || [];

        for (const p of products) {
          const name = p.name || p.title || p.description || '';
          const price = p.price || p.finalPrice || p.salePrice || 0;

          // Filter by query if provided
          const queryLower = query.toLowerCase();
          const nameLower = name.toLowerCase();

          if (nameLower.includes(queryLower.split(' ')[0]) && price && isFreshProduce(name)) {
            results.push({
              supermarket: config.name,
              name: name.trim(),
              price: typeof price === 'number' ? price : extractPrice(String(price)),
              unit: detectUnit(name)
            });
          }
        }
      } else {
        // Fallback: try search endpoint
        const searchResponse = await fetch(
          `https://api.biggie.com.py/api/v1/products/search?q=${encodeURIComponent(query)}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json'
            },
            timeout: 30000
          }
        );

        if (searchResponse.ok) {
          const data = await searchResponse.json();
          const products = data.products || data.items || data || [];

          for (const p of products) {
            const name = p.name || p.title || '';
            const price = p.price || p.finalPrice || 0;

            if (name && price && isFreshProduce(name)) {
              results.push({
                supermarket: config.name,
                name: name.trim(),
                price: typeof price === 'number' ? price : extractPrice(String(price)),
                unit: detectUnit(name)
              });
            }
          }
        }
      }
    } catch (error) {
      console.error(`[Aurelio] Error scraping ${config.name}:`, error.message);
      // Biggie API might not be publicly accessible - that's OK, we have other sources
    }

    return results;
  },

  /**
   * Salemma Online scraper (Laravel-based)
   * Best results from category browsing
   * Structure: a.apsubtitle for product name
   *            h6.pprice for price (format: "Gs. 8.500")
   *            or input[name="price"] with value
   */
  async salemma(config, query) {
    const results = [];

    try {
      // Use category page for more reliable results
      const categoryUrl = config.categoryUrl || 'https://www.salemmaonline.com.py/frutas-y-verduras/verduras';

      const response = await fetch(categoryUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        },
        timeout: 30000
      });

      const html = await response.text();
      const $ = cheerio.load(html);

      // Find products by the apsubtitle link which contains the product name
      $('a.apsubtitle').each((_, el) => {
        const $el = $(el);
        const name = $el.text().trim();

        // Find the container (closest form or div containing price)
        const $container = $el.closest('form, div').parent();

        // Get price from h6.pprice or input[name="price"]
        let price = 0;
        const priceInput = $container.find('input[name="price"]').val();
        if (priceInput) {
          price = parseInt(priceInput) || 0;
        }
        if (!price) {
          const priceText = $container.find('h6.pprice').text().trim();
          price = extractPrice(priceText);
        }

        // Filter by query
        const queryLower = query.toLowerCase();
        const nameLower = name.toLowerCase();

        if (name && price && nameLower.includes(queryLower.split(' ')[0]) && isFreshProduce(name)) {
          // Avoid duplicates
          if (!results.some(r => r.name === name)) {
            results.push({
              supermarket: config.name,
              name: name.trim(),
              price,
              unit: detectUnit(name)
            });
          }
        }
      });

    } catch (error) {
      console.error(`[Aurelio] Error scraping ${config.name}:`, error.message);
    }

    return results;
  }
};

/**
 * Extract price in Guaranies from text
 */
function extractPrice(text) {
  if (!text) return 0;

  // Remove currency symbols and normalize
  let cleaned = text
    .replace(/[₲Gs$G]/gi, '')
    .replace(/\s+/g, '')
    .replace(/\/kg|\/un|\/u/gi, '');

  // Handle Paraguay format (. as thousand separator)
  // Example: "17.950" -> 17950
  if (cleaned.includes('.') && !cleaned.includes(',')) {
    cleaned = cleaned.replace(/\./g, '');
  }
  // Handle mixed format: "17.950,00"
  else if (cleaned.includes('.') && cleaned.includes(',')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  }

  const price = parseInt(cleaned.replace(/[^\d]/g, ''));
  return isNaN(price) ? 0 : price;
}

/**
 * Check if product is fresh produce (not processed)
 */
function isFreshProduce(name) {
  const excluded = [
    // Processed/canned foods
    'extracto', 'puré', 'pure', 'salsa', 'enlatado', 'lata',
    'sardina', 'atún', 'atun', 'ketchup', 'pasta', 'pulpa',
    'deshidratado', 'seco', 'concentrado', 'conserva',
    'pelado', 'perita x', 'perita en',  // canned peeled tomatoes
    // Meat/processed products that might contain vegetable names
    'chorizo', 'salchicha', 'hamburguesa', 'empanada', 'pizza',
    'milanesa', 'fiambre', 'jamon', 'jamón', 'queso',
    // Other non-fresh
    'congelado', 'frozen', 'envasado', 'procesado',
    'polvo', 'condimento', 'especias', 'sazonador',
    // Packaging that indicates processed
    'frasco', 'botella', 'tetra', 'brick', 'sachet',
    'gr ', 'grs', 'ml ', 'cc '  // gram/ml measures usually indicate processed
  ];

  const nameLower = name.toLowerCase();

  // Exclude if contains any forbidden word
  if (excluded.some(word => nameLower.includes(word))) {
    return false;
  }

  // Must contain a recognizable fresh produce indicator or be short enough
  // (long names are usually processed products with ingredient lists)
  if (nameLower.length > 60) {
    return false;
  }

  // Fresh produce typically has "x kg" or "por kg" or simple names
  const freshIndicators = ['x kg', 'por kg', '/kg', 'x un', 'por un', 'por kilo', 'fresco', 'fresca', 'por unidad', 'x mz'];
  const hasFreshIndicator = freshIndicators.some(ind => nameLower.includes(ind));

  // If name is short (< 35 chars) and doesn't have excluded words, it's likely fresh
  return nameLower.length < 35 || hasFreshIndicator;
}

/**
 * Detect unit from product name
 */
function detectUnit(name) {
  const nameLower = name.toLowerCase();
  if (nameLower.includes('/kg') || nameLower.includes('por kg') || nameLower.includes('x kg')) {
    return 'kg';
  }
  if (nameLower.includes('/un') || nameLower.includes('unidad') || nameLower.includes('mazo')) {
    return 'unidad';
  }
  return 'kg';  // Default
}

/**
 * Check if a product name matches a search term with color/type specificity
 * For example: "locote rojo" should only match "locote rojo", not "locote amarillo"
 */
function productMatches(productName, searchTerm) {
  const nameLower = productName.toLowerCase();
  const termLower = searchTerm.toLowerCase();

  // Split into words
  const termWords = termLower.split(/\s+/);

  // For single-word terms, just check if the name contains it
  if (termWords.length === 1) {
    return nameLower.includes(termLower);
  }

  // For multi-word terms, check if ALL words are present
  // This ensures "locote rojo" only matches products with both "locote" AND "rojo"
  const allWordsPresent = termWords.every(word => nameLower.includes(word));

  // Special handling for color-specific terms
  const colors = ['rojo', 'amarillo', 'verde', 'blanco', 'morado', 'morada'];
  const termHasColor = termWords.some(w => colors.includes(w));

  if (termHasColor) {
    // If term specifies a color, product must also have that color
    return allWordsPresent;
  }

  // For non-color terms, check first word is present
  return nameLower.includes(termWords[0]);
}

// =============================================================================
// ZOHO ANALYTICS SYNC
// =============================================================================

async function syncToZohoAnalytics(db) {
  const credentials = loadZohoCredentials();
  if (!credentials.ZOHO_REFRESH_TOKEN) {
    console.log('[Aurelio] Zoho credentials not found, skipping Analytics sync');
    return;
  }

  try {
    const accessToken = await getZohoAccessToken(credentials);
    const prices = db.getTodayPrices();

    if (prices.length === 0) {
      console.log('[Aurelio] No prices to sync');
      return;
    }

    // Transform to Analytics format
    const data = prices.map(p => ({
      Fecha: p.date,
      Supermercado: p.supermarket,
      Producto: p.product,
      Producto_Raw: p.product_name_raw || p.product,
      Precio_Gs: p.price_guaranies,
      Unidad: p.unit || 'kg'
    }));

    await importToAnalytics(accessToken, data, 'append', CONFIG.zoho.marketPricesTableId);
    console.log(`[Aurelio] Synced ${data.length} prices to Zoho Analytics`);
  } catch (error) {
    console.error('[Aurelio] Failed to sync to Analytics:', error.message);
  }
}

function loadZohoCredentials() {
  // Try environment variables first (for Railway)
  if (process.env.ZOHO_REFRESH_TOKEN) {
    return {
      ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID,
      ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET,
      ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN,
      ZOHO_DC: process.env.ZOHO_DC || '.com'
    };
  }

  // Fallback to .env file
  const envPath = join(__dirname, '..', 'zoho-mcp-server', '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const creds = {};
    for (const line of content.split('\n')) {
      if (line.includes('=') && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        creds[key.trim()] = valueParts.join('=').trim();
      }
    }
    return creds;
  }

  return {};
}

async function getZohoAccessToken(credentials) {
  const dc = credentials.ZOHO_DC || '.com';
  const url = `https://accounts.zoho${dc}/oauth/v2/token`;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: credentials.ZOHO_CLIENT_ID,
    client_secret: credentials.ZOHO_CLIENT_SECRET,
    refresh_token: credentials.ZOHO_REFRESH_TOKEN
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error}`);
  }
  return data.access_token;
}

async function importToAnalytics(accessToken, data, importType, tableId) {
  const config = JSON.stringify({
    importType,
    fileType: 'json',
    autoIdentify: true,
    onError: 'skiprow'
  });

  const url = `https://analyticsapi.zoho.com/restapi/v2/workspaces/${CONFIG.zoho.workspaceId}/views/${tableId}/data?CONFIG=${encodeURIComponent(config)}`;

  const boundary = '----AurelioFormBoundary';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="DATA"',
    '',
    JSON.stringify(data),
    `--${boundary}--`
  ].join('\r\n');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Zoho-oauthtoken ${accessToken}`,
      'ZANALYTICS-ORGID': CONFIG.zoho.orgId,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Analytics import failed: ${response.status} - ${text}`);
  }

  return await response.json();
}

// =============================================================================
// REASONING ENGINE (Claude-Powered Analysis)
// =============================================================================

async function analyzeWithClaude(db, todayPrices) {
  const anthropic = new Anthropic();

  // Prepare market data for each product
  const productAnalyses = [];

  for (const productConfig of CONFIG.products) {
    const prices = todayPrices.filter(p => p.product === productConfig.name);
    if (prices.length === 0) continue;

    const priceValues = prices.map(p => p.price_guaranies);
    const marketMedian = median(priceValues);
    const marketMin = Math.min(...priceValues);
    const marketMax = Math.max(...priceValues);

    // Get historical trend (7 days for weekly average)
    const historicalMedian = db.getMedianPrice(productConfig.name, 7);

    // Calculate segment prices based on policy
    const segments = CONFIG.pricingPolicy.segments;
    const calculatedPrices = {
      consumidorFinal: Math.round(marketMedian * segments.consumidorFinal.metaPct),
      horeca: Math.round(marketMedian * segments.horeca.metaPct),
      supermercados: Math.round(marketMedian * segments.supermercados.metaPct),
      institucional: Math.round(marketMedian * segments.institucional.metaPct),
      mayorista: Math.round(marketMedian * segments.mayorista.metaPct)
    };

    // Check if calculated prices are above floor (Piso Absoluto)
    const pisoAbsoluto = productConfig.hidrobioPisoAbsoluto;
    const alerts = [];
    for (const [segment, price] of Object.entries(calculatedPrices)) {
      if (price < pisoAbsoluto) {
        alerts.push(`${segment}: Gs. ${price.toLocaleString()} está BAJO el piso absoluto (Gs. ${pisoAbsoluto.toLocaleString()})`);
        calculatedPrices[segment] = pisoAbsoluto;  // Enforce floor
      }
    }

    // Calculate margins vs cost
    const margins = {};
    for (const [segment, price] of Object.entries(calculatedPrices)) {
      margins[segment] = ((price - productConfig.hidrobioCost) / productConfig.hidrobioCost * 100).toFixed(1);
    }

    productAnalyses.push({
      product: productConfig.name,
      unit: productConfig.unit,
      hidrobioCost: productConfig.hidrobioCost,
      pisoAbsoluto: productConfig.hidrobioPisoAbsoluto,
      todayPrices: prices,
      marketMedian,
      marketMin,
      marketMax,
      weeklyMedian: historicalMedian,
      calculatedPrices,
      margins,
      priceCount: prices.length,
      trend: historicalMedian ? ((marketMedian - historicalMedian) / historicalMedian * 100).toFixed(1) : null,
      alerts
    });
  }

  if (productAnalyses.length === 0) {
    return { recommendations: [], summary: 'No hay datos de precios para analizar hoy.' };
  }

  // Build the prompt for Claude
  const systemPrompt = `Eres AURELIO, el especialista de inteligencia de precios elite de HidroBio S.A., una empresa de agricultura hidropónica premium en Paraguay.

TU MISIÓN: Analizar los precios de mercado (lo que los supermercados cobran al consumidor final) y recomendar los precios B2B que HidroBio debe cobrar a sus diferentes segmentos de clientes.

MODELO DE PRECIOS HIDROBIO:
Los precios de venta B2B de HidroBio se calculan como PORCENTAJE de la mediana de precios del mercado (supermercados):
- S1 Consumidor Final (venta directa): 90% de mediana (rango 85-95%)
- S2 HORECA (hoteles/restaurantes): 75% de mediana (rango 70-80%)
- S3 Supermercados (retail): 68% de mediana (rango 60-75%)
- S4 Institucional: 60% de mediana (rango 55-65%)
- S5 Mayorista: 50% de mediana (EVITAR este segmento)

REGLAS CRÍTICAS:
1. PISO ABSOLUTO: Nunca vender por debajo del piso absoluto del producto
2. MARGEN MÍNIMO: Al menos 15-25% sobre costo de producción según segmento
3. PREMIUM: Nunca ser el más barato - somos calidad hidropónica sin pesticidas

FORMATO DE RESPUESTA (JSON puro, sin markdown):
{
  "fecha": "YYYY-MM-DD",
  "resumenEjecutivo": "Resumen de 2-3 oraciones sobre el mercado esta semana",
  "productos": [
    {
      "producto": "nombre",
      "medianaSupermercados": número (precio consumidor en supermercados),
      "tendencia": "subiendo|bajando|estable",
      "cambioSemanal": "X%",
      "preciosRecomendadosHidroBio": {
        "consumidorFinal": { "precio": número, "margen": "X%" },
        "horeca": { "precio": número, "margen": "X%" },
        "supermercados": { "precio": número, "margen": "X%" },
        "institucional": { "precio": número, "margen": "X%" }
      },
      "pisoAbsoluto": número,
      "comentario": "Observación específica del producto",
      "alertas": ["lista de alertas si hay violaciones de reglas"]
    }
  ],
  "recomendacionSemanal": "Resumen ejecutivo para el equipo comercial sobre qué precios actualizar",
  "alertasGenerales": ["alertas importantes"]
}`;

  const userPrompt = `ANÁLISIS DE PRECIOS - ${new Date().toISOString().split('T')[0]}

PRECIOS DE SUPERMERCADOS (lo que paga el consumidor final en retail):

${productAnalyses.map(p => `
### ${p.product} (${p.unit})
COSTOS HIDROBIO:
- Costo de producción: Gs. ${p.hidrobioCost.toLocaleString()}
- Piso Absoluto (nunca vender debajo): Gs. ${p.pisoAbsoluto.toLocaleString()}

PRECIOS OBSERVADOS EN SUPERMERCADOS HOY:
${p.todayPrices.map(tp => `  - ${tp.supermarket}: Gs. ${tp.price_guaranies.toLocaleString()} (${tp.product_name_raw})`).join('\n')}

ESTADÍSTICAS:
  - MEDIANA (base para cálculo): Gs. ${p.marketMedian.toLocaleString()}
  - Mínimo: Gs. ${p.marketMin.toLocaleString()}
  - Máximo: Gs. ${p.marketMax.toLocaleString()}
  - Tendencia vs semana pasada: ${p.trend ? `${p.trend}%` : 'sin datos'}
  - Promedio últimos 7 días: ${p.weeklyMedian ? `Gs. ${p.weeklyMedian.toLocaleString()}` : 'N/A'}

PRECIOS B2B CALCULADOS (antes de tu análisis):
  - Consumidor Final (90%): Gs. ${p.calculatedPrices.consumidorFinal.toLocaleString()} → Margen: ${p.margins.consumidorFinal}%
  - HORECA (75%): Gs. ${p.calculatedPrices.horeca.toLocaleString()} → Margen: ${p.margins.horeca}%
  - Supermercados (68%): Gs. ${p.calculatedPrices.supermercados.toLocaleString()} → Margen: ${p.margins.supermercados}%
  - Institucional (60%): Gs. ${p.calculatedPrices.institucional.toLocaleString()} → Margen: ${p.margins.institucional}%

${p.alerts.length > 0 ? `⚠️ ALERTAS: ${p.alerts.join('; ')}` : ''}
`).join('\n')}

CONTEXTO HIDROBIO:
- Productores hidropónicos premium con 7+ años en el mercado
- Premio AHK Paraguay Sostenibilidad 2025 (1er lugar)
- Sin pesticidas, disponibles 365 días, trazabilidad completa
- Objetivo: posicionamiento PREMIUM, nunca el más barato

TAREA:
1. Revisa los precios calculados y valida si son coherentes
2. Ajusta si hay violaciones del piso absoluto o márgenes insuficientes
3. Genera recomendaciones finales para que el equipo actualice la Calculadora de Precios
4. Identifica alertas o tendencias importantes`;

  try {
    console.log('[Aurelio] Iniciando análisis con Claude...');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      system: systemPrompt
    });

    const content = response.content[0].text;

    // Parse JSON response
    try {
      const analysis = JSON.parse(content);
      console.log('[Aurelio] Análisis completado exitosamente');
      return analysis;
    } catch (parseError) {
      console.error('[Aurelio] Error parsing Claude response:', parseError.message);
      console.log('[Aurelio] Raw response:', content.substring(0, 500));
      return {
        resumenEjecutivo: 'Error al procesar el análisis',
        productos: [],
        alertasGenerales: ['Error de parsing en la respuesta de Claude'],
        accionesRecomendadas: []
      };
    }
  } catch (error) {
    console.error('[Aurelio] Error calling Claude:', error.message);
    return {
      resumenEjecutivo: 'Error al conectar con el servicio de análisis',
      productos: [],
      alertasGenerales: [`Error: ${error.message}`],
      accionesRecomendadas: []
    };
  }
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// =============================================================================
// EMAIL REPORT (Using Zoho Mail SMTP)
// =============================================================================

async function sendEmailReport(analysis, todayPrices) {
  // Build email content
  const date = new Date().toLocaleDateString('es-PY', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const hasAlerts = (analysis.alertasGenerales?.length > 0) ||
    analysis.productos?.some(p => p.alertas?.length > 0);

  const subject = hasAlerts
    ? `🚨 [Aurelio] Precios Semanales - ${date} (Alertas)`
    : `📊 [Aurelio] Precios Semanales - ${date}`;

  // Print comprehensive console report
  console.log('\n' + '═'.repeat(80));
  console.log('  📊 AURELIO - REPORTE DE PRECIOS PARA ACTUALIZAR CALCULADORA');
  console.log('  ' + date);
  console.log('═'.repeat(80));

  console.log('\n📝 RESUMEN EJECUTIVO:');
  console.log('─'.repeat(40));
  console.log(analysis.resumenEjecutivo || 'Sin resumen disponible');

  if (analysis.productos && analysis.productos.length > 0) {
    console.log('\n' + '═'.repeat(80));
    console.log('  💰 PRECIOS RECOMENDADOS PARA LA CALCULADORA');
    console.log('═'.repeat(80));

    // Create a nice table format
    console.log('\n┌─────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐');
    console.log('│      PRODUCTO       │   MEDIANA    │  CONS.FINAL  │    HORECA    │  SUPERMKTS   │  INSTITUC.   │');
    console.log('│                     │  (Mercado)   │    (90%)     │    (75%)     │    (68%)     │    (60%)     │');
    console.log('├─────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤');

    for (const prod of analysis.productos) {
      const name = (prod.producto || 'N/A').padEnd(19).substring(0, 19);
      const median = formatPrice(prod.medianaSupermercados);
      const cf = formatPriceWithMargin(prod.preciosRecomendadosHidroBio?.consumidorFinal);
      const horeca = formatPriceWithMargin(prod.preciosRecomendadosHidroBio?.horeca);
      const super_ = formatPriceWithMargin(prod.preciosRecomendadosHidroBio?.supermercados);
      const inst = formatPriceWithMargin(prod.preciosRecomendadosHidroBio?.institucional);

      console.log(`│ ${name} │ ${median} │ ${cf} │ ${horeca} │ ${super_} │ ${inst} │`);
    }

    console.log('└─────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘');

    // Detailed breakdown per product
    console.log('\n📋 DETALLE POR PRODUCTO:');
    console.log('─'.repeat(40));

    for (const prod of analysis.productos) {
      console.log(`\n  🍅 ${prod.producto}`);
      console.log(`     Mediana supermercados: Gs. ${prod.medianaSupermercados?.toLocaleString() || 'N/A'}`);
      console.log(`     Tendencia: ${prod.tendencia || 'N/A'} (${prod.cambioSemanal || '0%'})`);
      console.log(`     Piso absoluto: Gs. ${prod.pisoAbsoluto?.toLocaleString() || 'N/A'}`);

      if (prod.preciosRecomendadosHidroBio) {
        const precios = prod.preciosRecomendadosHidroBio;
        console.log(`     PRECIOS B2B RECOMENDADOS:`);
        if (precios.consumidorFinal) {
          console.log(`       → Consumidor Final: Gs. ${precios.consumidorFinal.precio?.toLocaleString()} (margen ${precios.consumidorFinal.margen})`);
        }
        if (precios.horeca) {
          console.log(`       → HORECA: Gs. ${precios.horeca.precio?.toLocaleString()} (margen ${precios.horeca.margen})`);
        }
        if (precios.supermercados) {
          console.log(`       → Supermercados: Gs. ${precios.supermercados.precio?.toLocaleString()} (margen ${precios.supermercados.margen})`);
        }
        if (precios.institucional) {
          console.log(`       → Institucional: Gs. ${precios.institucional.precio?.toLocaleString()} (margen ${precios.institucional.margen})`);
        }
      }

      if (prod.comentario) {
        console.log(`     💡 ${prod.comentario}`);
      }

      if (prod.alertas?.length > 0) {
        for (const alert of prod.alertas) {
          console.log(`     ⚠️ ${alert}`);
        }
      }
    }
  }

  // Weekly recommendation summary
  if (analysis.recomendacionSemanal) {
    console.log('\n' + '═'.repeat(80));
    console.log('  ✅ RECOMENDACIÓN PARA EL EQUIPO COMERCIAL');
    console.log('═'.repeat(80));
    console.log('\n' + analysis.recomendacionSemanal);
  }

  // Alerts
  if (analysis.alertasGenerales?.length > 0) {
    console.log('\n⚠️ ALERTAS GENERALES:');
    console.log('─'.repeat(40));
    for (const alert of analysis.alertasGenerales) {
      console.log(`  ❗ ${alert}`);
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log(`  Generado por Aurelio | ${new Date().toISOString()}`);
  console.log('═'.repeat(80) + '\n');

  // Send email using Resend API (HTTPS - works on cloud platforms)
  // Railway blocks SMTP, so we use Resend's REST API instead
  const resendApiKey = process.env.RESEND_API_KEY;

  if (resendApiKey) {
    try {
      console.log('[Aurelio] 📧 Enviando email a daniel@hidrobio.com.py via Resend...');

      // Generate HTML content
      const htmlContent = generateEmailHtml(analysis, todayPrices, date);

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Aurelio HidroBio <onboarding@resend.dev>',
          to: ['daniel@hidrobio.com.py'],
          subject: subject,
          html: htmlContent
        })
      });

      const result = await response.json();

      if (response.ok && result.id) {
        console.log(`[Aurelio] ✅ Email enviado via Resend (ID: ${result.id})`);
      } else {
        console.error('[Aurelio] ❌ Error Resend API:', JSON.stringify(result));
      }
    } catch (error) {
      console.error('[Aurelio] ❌ Error enviando email:', error.message);
    }
  } else {
    console.log('[Aurelio] ℹ️ Email no configurado (agregar RESEND_API_KEY a las variables de entorno)');
  }
}

function formatPrice(value) {
  if (!value) return '     N/A    ';
  const str = value.toLocaleString();
  return str.padStart(12).substring(0, 12);
}

function formatPriceWithMargin(obj) {
  if (!obj || !obj.precio) return '     N/A    ';
  const str = obj.precio.toLocaleString();
  return str.padStart(12).substring(0, 12);
}

function generateEmailHtml(analysis, todayPrices, date) {
  // Group prices by supermarket for the raw prices table
  const pricesBySupermarket = {};
  const pricesByProduct = {};

  if (todayPrices && todayPrices.length > 0) {
    for (const p of todayPrices) {
      // By supermarket
      if (!pricesBySupermarket[p.supermarket]) {
        pricesBySupermarket[p.supermarket] = [];
      }
      pricesBySupermarket[p.supermarket].push(p);

      // By product
      if (!pricesByProduct[p.product]) {
        pricesByProduct[p.product] = [];
      }
      pricesByProduct[p.product].push(p);
    }
  }

  // Generate raw prices section
  const rawPricesHtml = Object.entries(pricesBySupermarket).map(([supermarket, prices]) => `
    <div style="margin-bottom: 20px;">
      <h4 style="color: #1565C0; margin-bottom: 10px;">🏪 ${supermarket}</h4>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr style="background: #E3F2FD;">
          <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Producto</th>
          <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">Precio (Gs.)</th>
          <th style="padding: 8px; border: 1px solid #ddd; text-align: center;">Unidad</th>
        </tr>
        ${prices.map(p => `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd;">${p.name}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: right; font-weight: bold;">${p.price?.toLocaleString()}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${p.unit || 'kg'}</td>
        </tr>
        `).join('')}
      </table>
    </div>
  `).join('');

  // Generate product analysis cards
  const productCardsHtml = analysis.productos?.map(prod => {
    const alertsHtml = prod.alertas?.length > 0
      ? `<div style="background: #FFF3E0; border-left: 4px solid #FF9800; padding: 10px; margin-top: 10px;">
          ${prod.alertas.map(a => `<div>⚠️ ${a}</div>`).join('')}
         </div>`
      : '';

    const precios = prod.preciosRecomendadosHidroBio || {};

    return `
    <div style="border: 2px solid #4CAF50; border-radius: 12px; margin: 20px 0; overflow: hidden;">
      <div style="background: #4CAF50; color: white; padding: 15px;">
        <h3 style="margin: 0;">🍅 ${prod.producto}</h3>
      </div>
      <div style="padding: 15px;">
        <div style="display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 15px;">
          <div style="flex: 1; min-width: 200px;">
            <div style="color: #666; font-size: 12px;">MEDIANA MERCADO</div>
            <div style="font-size: 24px; font-weight: bold; color: #1565C0;">
              Gs. ${prod.medianaSupermercados?.toLocaleString() || 'N/A'}
            </div>
          </div>
          <div style="flex: 1; min-width: 200px;">
            <div style="color: #666; font-size: 12px;">TENDENCIA</div>
            <div style="font-size: 18px;">
              ${prod.tendencia === 'alza' ? '📈' : prod.tendencia === 'baja' ? '📉' : '➡️'}
              ${prod.tendencia || 'estable'} (${prod.cambioSemanal || '0%'})
            </div>
          </div>
          <div style="flex: 1; min-width: 200px;">
            <div style="color: #666; font-size: 12px;">PISO ABSOLUTO</div>
            <div style="font-size: 18px; color: #D32F2F;">
              Gs. ${prod.pisoAbsoluto?.toLocaleString() || 'N/A'}
            </div>
          </div>
        </div>

        <h4 style="color: #2E7D32; margin: 15px 0 10px;">💰 PRECIOS B2B RECOMENDADOS</h4>
        <table style="width: 100%; border-collapse: collapse;">
          <tr style="background: #E8F5E9;">
            <th style="padding: 10px; border: 1px solid #C8E6C9; text-align: left;">Segmento</th>
            <th style="padding: 10px; border: 1px solid #C8E6C9; text-align: right;">Precio (Gs.)</th>
            <th style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">Margen</th>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #C8E6C9;">⭐⭐⭐⭐⭐ Consumidor Final (90%)</td>
            <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: right; font-weight: bold;">
              ${precios.consumidorFinal?.precio?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">
              ${precios.consumidorFinal?.margen || 'N/A'}
            </td>
          </tr>
          <tr style="background: #F1F8E9;">
            <td style="padding: 10px; border: 1px solid #C8E6C9;">⭐⭐⭐⭐ HORECA (75%)</td>
            <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: right; font-weight: bold;">
              ${precios.horeca?.precio?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">
              ${precios.horeca?.margen || 'N/A'}
            </td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #C8E6C9;">⭐⭐⭐ Supermercados (68%)</td>
            <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: right; font-weight: bold;">
              ${precios.supermercados?.precio?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">
              ${precios.supermercados?.margen || 'N/A'}
            </td>
          </tr>
          <tr style="background: #F1F8E9;">
            <td style="padding: 10px; border: 1px solid #C8E6C9;">⭐⭐ Institucional (60%)</td>
            <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: right; font-weight: bold;">
              ${precios.institucional?.precio?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">
              ${precios.institucional?.margen || 'N/A'}
            </td>
          </tr>
        </table>

        ${prod.comentario ? `
        <div style="background: #E3F2FD; padding: 10px; margin-top: 15px; border-radius: 4px;">
          💡 <em>${prod.comentario}</em>
        </div>
        ` : ''}

        ${alertsHtml}
      </div>
    </div>
    `;
  }).join('') || '<p>No hay datos de productos</p>';

  // Main email HTML
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px;">

  <!-- Header -->
  <div style="background: linear-gradient(135deg, #2E7D32, #4CAF50); color: white; padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; font-size: 28px;">🌿 AURELIO</h1>
    <p style="margin: 5px 0 0; font-size: 16px; opacity: 0.9;">Elite Pricing Intelligence Agent</p>
    <p style="margin: 15px 0 0; font-size: 14px; background: rgba(255,255,255,0.2); display: inline-block; padding: 5px 15px; border-radius: 20px;">
      📅 ${date}
    </p>
  </div>

  <!-- Summary -->
  <div style="background: #FAFAFA; padding: 20px; border-left: 4px solid #4CAF50;">
    <h2 style="color: #2E7D32; margin-top: 0;">📝 Resumen Ejecutivo</h2>
    <p style="font-size: 15px; color: #555;">
      ${analysis.resumenEjecutivo || 'Sin resumen disponible'}
    </p>
  </div>

  <!-- Stats Bar -->
  <div style="display: flex; flex-wrap: wrap; background: #E8F5E9; padding: 15px; margin: 20px 0; border-radius: 8px;">
    <div style="flex: 1; min-width: 120px; text-align: center; padding: 10px;">
      <div style="font-size: 24px; font-weight: bold; color: #2E7D32;">${todayPrices?.length || 0}</div>
      <div style="font-size: 12px; color: #666;">Precios Recolectados</div>
    </div>
    <div style="flex: 1; min-width: 120px; text-align: center; padding: 10px;">
      <div style="font-size: 24px; font-weight: bold; color: #2E7D32;">${Object.keys(pricesBySupermarket).length}</div>
      <div style="font-size: 12px; color: #666;">Supermercados</div>
    </div>
    <div style="flex: 1; min-width: 120px; text-align: center; padding: 10px;">
      <div style="font-size: 24px; font-weight: bold; color: #2E7D32;">${analysis.productos?.length || 0}</div>
      <div style="font-size: 12px; color: #666;">Productos Analizados</div>
    </div>
  </div>

  <!-- Product Analysis Cards -->
  <h2 style="color: #2E7D32; border-bottom: 2px solid #4CAF50; padding-bottom: 10px;">
    💰 Análisis y Recomendaciones por Producto
  </h2>
  ${productCardsHtml}

  <!-- General Alerts -->
  ${analysis.alertasGenerales?.length > 0 ? `
  <div style="background: #FFF3E0; border: 1px solid #FFB74D; border-radius: 8px; padding: 20px; margin: 20px 0;">
    <h3 style="color: #E65100; margin-top: 0;">🚨 Alertas Generales</h3>
    <ul style="margin: 0; padding-left: 20px;">
      ${analysis.alertasGenerales.map(a => `<li style="margin: 5px 0;">${a}</li>`).join('')}
    </ul>
  </div>
  ` : ''}

  <!-- Weekly Recommendation -->
  ${analysis.recomendacionSemanal ? `
  <div style="background: #E8F5E9; border: 2px solid #4CAF50; border-radius: 8px; padding: 20px; margin: 20px 0;">
    <h3 style="color: #2E7D32; margin-top: 0;">✅ Recomendación para el Equipo Comercial</h3>
    <p style="font-size: 15px; color: #333;">
      ${analysis.recomendacionSemanal}
    </p>
  </div>
  ` : ''}

  <!-- Raw Prices Section (Collapsible-style) -->
  <div style="margin-top: 30px; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
    <div style="background: #1565C0; color: white; padding: 15px;">
      <h3 style="margin: 0;">📊 Precios Recolectados Hoy por Supermercado</h3>
    </div>
    <div style="padding: 15px; background: #FAFAFA;">
      ${rawPricesHtml || '<p>No hay precios disponibles</p>'}
    </div>
  </div>

  <!-- Footer -->
  <div style="text-align: center; margin-top: 30px; padding: 20px; background: #F5F5F5; border-radius: 8px;">
    <p style="margin: 0; color: #666; font-size: 12px;">
      🌿 Generado por <strong>Aurelio</strong> - Sistema de Inteligencia de Precios<br>
      <strong>HidroBio S.A.</strong> | Nueva Italia, Paraguay<br>
      ${new Date().toLocaleString('es-PY', { dateStyle: 'full', timeStyle: 'long' })}
    </p>
  </div>

</body>
</html>
  `;
}

// =============================================================================
// MAIN AGENT LOOP
// =============================================================================

async function runAurelio() {
  console.log('\n' + '🌿'.repeat(40));
  console.log(`\n  AURELIO - Elite Pricing Intelligence Agent`);
  console.log(`  HidroBio S.A. | ${new Date().toLocaleString('es-PY')}`);
  console.log('\n' + '🌿'.repeat(40) + '\n');

  const db = new PriceDatabase();

  try {
    // Step 1: Scrape prices from all supermarkets
    console.log('[Aurelio] 📡 Paso 1: Recolectando precios del mercado...');
    const allPrices = [];

    for (const supermarket of CONFIG.supermarkets) {
      if (!supermarket.enabled) continue;

      console.log(`[Aurelio]   → Escaneando ${supermarket.name}...`);
      const scraper = SCRAPERS[supermarket.scraper];

      if (!scraper) {
        console.log(`[Aurelio]   ⚠️ No hay scraper para ${supermarket.name}`);
        continue;
      }

      for (const product of CONFIG.products) {
        for (const term of product.searchTerms) {
          try {
            const results = await scraper(supermarket, term);

            for (const result of results) {
              // Match against target product using improved matching
              if (productMatches(result.name, term)) {
                // Check for duplicates before adding
                const isDupe = allPrices.some(p =>
                  p.supermarket === result.supermarket &&
                  p.name === result.name &&
                  p.product === product.name
                );
                if (!isDupe) {
                  allPrices.push({
                    ...result,
                    product: product.name,
                    unit: product.unit
                  });
                }
              }
            }
          } catch (error) {
            console.error(`[Aurelio]   ❌ Error buscando "${term}" en ${supermarket.name}:`, error.message);
          }
        }
      }
    }

    console.log(`[Aurelio] ✅ Recolectados ${allPrices.length} precios`);

    // Step 2: Save to database
    console.log('[Aurelio] 💾 Paso 2: Guardando en base de datos...');
    for (const price of allPrices) {
      db.savePrice(
        price.supermarket,
        price.product,
        price.price,
        price.name,
        price.unit
      );
    }

    // Step 3: Sync to Zoho Analytics
    console.log('[Aurelio] ☁️ Paso 3: Sincronizando con Zoho Analytics...');
    await syncToZohoAnalytics(db);

    // Step 4: AI Analysis
    console.log('[Aurelio] 🧠 Paso 4: Analizando con inteligencia artificial...');
    const todayPrices = db.getTodayPrices();
    const analysis = await analyzeWithClaude(db, todayPrices);

    // Save analysis to database
    if (analysis.productos) {
      for (const prod of analysis.productos) {
        db.saveAnalysis(prod.producto, {
          marketMedian: prod.precioMercadoMediana,
          marketMin: prod.precioMercadoMin,
          marketMax: prod.precioMercadoMax,
          recommendedPrice: prod.recomendaciones?.supermercados,
          recommendedMargin: prod.margenRecomendado,
          reasoning: prod.razonamiento
        });
      }
    }

    // Save alerts
    if (analysis.alertasGenerales) {
      for (const alert of analysis.alertasGenerales) {
        db.saveAlert('market', alert, 'warning');
      }
    }

    // Step 5: Send email report
    console.log('[Aurelio] 📧 Paso 5: Generando reporte...');
    await sendEmailReport(analysis, todayPrices);

    console.log('\n[Aurelio] ✅ Ciclo completado exitosamente\n');

  } catch (error) {
    console.error('[Aurelio] ❌ Error en el ciclo principal:', error);
    db.saveAlert('system', `Error en ejecución: ${error.message}`, 'error');
  } finally {
    db.close();
  }
}

// =============================================================================
// SCHEDULER
// =============================================================================

function scheduleNextRun() {
  const now = new Date();
  const targetHour = CONFIG.schedule.hour;
  const targetMinute = CONFIG.schedule.minute;

  // Calculate next run time
  let nextRun = new Date(now);
  nextRun.setHours(targetHour, targetMinute, 0, 0);

  // If we've already passed the target time today, schedule for tomorrow
  if (now >= nextRun) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const msUntilRun = nextRun.getTime() - now.getTime();
  const hoursUntil = Math.floor(msUntilRun / (1000 * 60 * 60));
  const minutesUntil = Math.floor((msUntilRun % (1000 * 60 * 60)) / (1000 * 60));

  console.log(`[Aurelio] ⏰ Próxima ejecución programada: ${nextRun.toLocaleString('es-PY')}`);
  console.log(`[Aurelio]    (en ${hoursUntil}h ${minutesUntil}m)`);

  setTimeout(async () => {
    await runAurelio();
    scheduleNextRun();  // Schedule the next day's run
  }, msUntilRun);
}

// =============================================================================
// ENTRY POINT
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--now') || args.includes('-n')) {
    // Run immediately
    console.log('[Aurelio] Modo: Ejecución inmediata');
    await runAurelio();
  } else if (args.includes('--schedule') || args.includes('-s')) {
    // Run with scheduler
    console.log('[Aurelio] Modo: Programado (08:00 Paraguay)');
    console.log('[Aurelio] Ejecutando análisis inicial...');
    await runAurelio();
    scheduleNextRun();

    // Keep process alive
    console.log('[Aurelio] 🟢 Agente en ejecución continua. Ctrl+C para detener.');
  } else if (args.includes('--daemon') || args.includes('-d')) {
    // Daemon mode for Railway - run immediately then schedule
    console.log('[Aurelio] Modo: Daemon (Railway)');
    await runAurelio();
    scheduleNextRun();

    // Keep alive with heartbeat
    setInterval(() => {
      console.log(`[Aurelio] 💓 Heartbeat - ${new Date().toLocaleString('es-PY')}`);
    }, 3600000);  // Every hour

  } else {
    // Default: run once
    console.log('[Aurelio] Modo: Ejecución única');
    await runAurelio();
  }
}

main().catch(console.error);
