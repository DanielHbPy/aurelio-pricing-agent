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
import nodemailer from 'nodemailer';
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
    // Daily scrape: 05:00 PYT - collect prices, save to DB, alert on errors
    dailyScrape: {
      hour: 5,
      minute: 0
    },
    // Weekly analysis: Thursday 15:00 PYT - full analysis + email report
    weeklyAnalysis: {
      dayOfWeek: 4, // Thursday (0=Sunday, 4=Thursday)
      hour: 15,
      minute: 0
    },
    timezone: 'America/Asuncion'
  },

  // Products to monitor (costs from HidroBio Calculadora Precios 2026 v4)
  // Note: "Tomate Perita" = "Tomate Santa Cruz" in market
  // Note: "Tomate Lisa" can also be found as "Tomate Holandés"
  products: [
    {
      name: 'Tomate Lisa',
      // ONLY match "lisa" or "holandes" - these are the same variety (round tomato)
      searchTerms: ['tomate lisa', 'tomate holandes', 'tomate holandés'],
      // Exclude Santa Cruz (that's Perita) and Cherry
      excludeTerms: ['santa cruz', 'cherry', 'perita', 'pera'],
      unit: 'kg',
      hidrobioCost: 6926,  // Gs. per kg (from calculator)
      hidrobioPisoAbsoluto: 8500,  // Floor price - never sell below
      marketMedianRef: 14950,  // Reference median from supermarkets
      hidrobioMinMargin: 0.25  // 25% minimum margin
    },
    {
      name: 'Tomate Perita',
      // Tomate Perita = Tomate Santa Cruz in Paraguay market (oblong/plum tomato)
      searchTerms: ['tomate perita', 'tomate pera', 'tomate santa cruz'],
      // Exclude Lisa and Cherry
      excludeTerms: ['lisa', 'holandes', 'holandés', 'cherry'],
      unit: 'kg',
      hidrobioCost: 6926,
      hidrobioPisoAbsoluto: 8500,
      marketMedianRef: 6950,
      hidrobioMinMargin: 0.25
    },
    {
      name: 'Tomate Cherry',
      // Cherry is specific - MUST have "tomate" to avoid candy/other products
      searchTerms: ['tomate cherry'],
      // Exclude other tomato types AND non-food items
      excludeTerms: ['lisa', 'santa cruz', 'perita', 'holandes', 'caramelo', 'candy', 'halls', 'mentho', 'deo', 'axe', 'spray', 'bodyspra', 'desodorante'],
      unit: 'kg',
      hidrobioCost: 10000,  // Per kg
      hidrobioPisoAbsoluto: 12000,
      marketMedianRef: 18000,
      hidrobioMinMargin: 0.25
    },
    {
      name: 'Locote Rojo',
      searchTerms: ['locote rojo', 'pimiento rojo', 'morron rojo'],
      excludeTerms: ['amarillo', 'verde'],
      unit: 'kg',
      hidrobioCost: 12114,
      hidrobioPisoAbsoluto: 15000,
      marketMedianRef: 26900,
      hidrobioMinMargin: 0.25
    },
    {
      name: 'Locote Amarillo',
      searchTerms: ['locote amarillo', 'pimiento amarillo', 'morron amarillo'],
      excludeTerms: ['rojo', 'verde'],
      unit: 'kg',
      hidrobioCost: 12114,
      hidrobioPisoAbsoluto: 15000,
      marketMedianRef: 47900,
      hidrobioMinMargin: 0.25
    },
    {
      name: 'Lechuga Pirati',
      // Match Pirati specifically, and other common lechuga types sold by unit
      searchTerms: ['lechuga pirati', 'lechuga crespa', 'lechuga mantecosa', 'lechuga blanca', 'lechuga mimosa'],
      // Exclude kg-priced items (repollada is sold by kg at supermarkets, not comparable)
      excludeTerms: ['repollada', 'por kg', 'x kg'],
      unit: 'unidad',
      hidrobioCost: 2500,
      hidrobioPisoAbsoluto: 3000,
      marketMedianRef: 4500,
      hidrobioMinMargin: 0.25
    },
    {
      name: 'Verdeos',
      // ONLY fresh verdeos - cebollita de hoja and fresh perejil/cilantro por unidad
      searchTerms: ['cebollita de hoja', 'perejil por', 'cilantro por', 'verdeo'],
      // Exclude ALL processed/packaged products
      excludeTerms: ['molido', 'molida', 'tostado', 'galleta', 'gramos', 'gr', 'hierbapar', 'arcoiris', 'kelwa', 'paquete', 'bolsa'],
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
      categoryUrl: 'https://casarica.com.py/catalogo/verduras-c287',
      // Direct product URLs for items not in category page (search is JS-rendered)
      // Verified via Chrome MCP 2026-01-26: Amarillo 48,300 | Rojo 41,400
      directProducts: {
        'tomate cherry': 'https://casarica.com.py/tomate-cherry-angel-sweet-soleil-300-g-p40414',
        'locote amarillo': 'https://casarica.com.py/locote-amarillo-x-kg-p4301',
        'locote rojo': 'https://casarica.com.py/locote-rojo-importado-x-kg-p4305'
      },
      scraper: 'casarica',
      notes: 'WordPress/WooCommerce - use category + direct URLs for items not in category'
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
      enabled: true,  // Enabled 2026-01-28 - discovered public API at api.app.biggie.com.py
      baseUrl: 'https://www.biggie.com.py',
      apiUrl: 'https://api.app.biggie.com.py/api/articles?take=100&skip=0&classificationName=fruteria-y-verduleria',
      scraper: 'biggie',
      notes: 'Vue/Nuxt SPA with public API - no browser automation needed'
    },
    {
      name: 'Salemma',
      enabled: false,  // Disabled 2026-01-28 - server has broken www→non-www redirect (drops / before path)
      baseUrl: 'https://www.salemmaonline.com.py',
      searchUrl: 'https://www.salemmaonline.com.py/buscar?criterio={query}',
      categoryUrl: 'https://www.salemmaonline.com.py/frutas-y-verduras/verduras',
      scraper: 'salemma',
      notes: 'DISABLED: Apache redirect bug creates invalid URLs (salemmaonline.com.pyfrutas... missing /)'
    },
    {
      name: 'Supermas',
      enabled: true,  // Added 2026-01-28 - clean HTML category pages
      baseUrl: 'https://www.supermas.com.py',
      categoryUrl: 'https://www.supermas.com.py/catalogo/frutas-y-verduras-c36',
      scraper: 'supermas',
      notes: 'PHP-based ecommerce, reliable HTML scraping'
    },
    {
      name: 'Real',
      enabled: true,  // Added 2026-01-28 - Instaleap GraphQL API reverse-engineered
      baseUrl: 'https://www.realonline.com.py',
      apiUrl: 'https://nextgentheadless.instaleap.io/api/v3',
      clientId: 'CADENA_REAL',
      storeReference: '2',
      scraper: 'real',
      notes: 'Instaleap headless commerce - GraphQL API'
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
    // Check for Railway volume mount first, then fallback to local data directory
    const railwayDataDir = '/app/data';
    const localDataDir = join(__dirname, 'data');

    // Use Railway volume if it exists, otherwise use local
    const dataDir = existsSync(railwayDataDir) ? railwayDataDir : localDataDir;

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = join(dataDir, 'aurelio.db');
    console.log(`[Aurelio] Database path: ${dbPath}`);
    this.db = new Database(dbPath);
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

      CREATE TABLE IF NOT EXISTS weekly_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_start TEXT NOT NULL,
        week_end TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        prices_count INTEGER,
        supermarkets_count INTEGER,
        products_count INTEGER,
        generated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(week_start)
      );

      CREATE INDEX IF NOT EXISTS idx_weekly_reports_week ON weekly_reports(week_start);
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

  getRecentAlerts(days = 7) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split('T')[0];

    return this.db.prepare(`
      SELECT * FROM alerts
      WHERE date >= ?
      ORDER BY created_at DESC
    `).all(sinceStr);
  }

  /**
   * Save full weekly analysis report (for dashboard)
   */
  saveWeeklyReport(analysis, pricesCount, supermarketsCount, productsCount) {
    const now = new Date();
    // Get start of week (Monday)
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    // Get end of week (Sunday)
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO weekly_reports
      (week_start, week_end, analysis_json, prices_count, supermarkets_count, products_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      weekStartStr,
      weekEndStr,
      JSON.stringify(analysis),
      pricesCount,
      supermarketsCount,
      productsCount
    );
  }

  /**
   * Get latest weekly report (for dashboard)
   */
  getLatestWeeklyReport() {
    return this.db.prepare(`
      SELECT * FROM weekly_reports
      ORDER BY generated_at DESC
      LIMIT 1
    `).get();
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-PY,es;q=0.9,en;q=0.8'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

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
          // Normalize price to per-kg for packaged products
          const normalized = normalizePricePerKg(name, price);
          const result = {
            supermarket: config.name,
            name: normalized.normalized ? `${name.trim()} [→${normalized.packageSize}→kg]` : name.trim(),
            price: normalized.price,
            unit: detectUnit(name)
          };
          if (normalized.normalized) {
            result.originalPrice = normalized.originalPrice;
            result.packageSize = normalized.packageSize;
          }
          results.push(result);
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
              // Normalize price to per-kg
              const normalized = normalizePricePerKg(name, price);
              const result = {
                supermarket: config.name,
                name: normalized.normalized ? `${name.trim()} [→${normalized.packageSize}→kg]` : name.trim(),
                price: normalized.price,
                unit: detectUnit(name)
              };
              if (normalized.normalized) {
                result.originalPrice = normalized.originalPrice;
                result.packageSize = normalized.packageSize;
              }
              results.push(result);
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

    // Retry logic for flaky connections
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000); // 45s timeout

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-PY,es;q=0.9,en;q=0.8',
            'Connection': 'keep-alive'
          },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

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

        // Success - break out of retry loop
        return results;

      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    // All retries failed
    console.error(`[Aurelio] Error scraping ${config.name}:`, lastError?.message || 'Unknown error');
    return results;
  },

  /**
   * Casa Rica scraper
   * Uses category browsing + direct product URLs for premium items
   * Cherry tomatoes are NOT in the category page (search is JS-rendered)
   * Structure: div.product > h2.ecommercepro-loop-product__title for name
   *            span.price > span.amount for price (format: "₲. 7.200")
   */
  async casarica(config, query) {
    const results = [];
    const queryLower = query.toLowerCase();

    // Helper to parse Casa Rica products from category HTML
    const parseProducts = ($, queryLower) => {
      const found = [];

      // Try multiple product selectors (WooCommerce variations)
      const productSelectors = [
        'div.product',
        'li.product',
        '.product-small',
        '.product-item'
      ];

      for (const selector of productSelectors) {
        $(selector).each((_, el) => {
          const $el = $(el);

          // Get name from multiple possible locations
          let name = $el.find('h2.ecommercepro-loop-product__title').text().trim();
          if (!name) name = $el.find('.product-title').text().trim();
          if (!name) name = $el.find('.woocommerce-loop-product__title').text().trim();
          if (!name) name = $el.find('h2 a, h3 a, .title a').first().text().trim();
          if (!name) name = $el.find('a.woocommerce-LoopProduct-link').text().trim();

          // Get price - avoid span.amount alone as it picks up discount badges (e.g., "30%")
          // Use more specific selectors that target actual price elements
          let priceText = $el.find('.price .ecommercepro-Price-amount').first().text().trim();
          if (!priceText) priceText = $el.find('.price .amount').first().text().trim();
          if (!priceText) priceText = $el.find('.woocommerce-Price-amount.amount').first().text().trim();
          if (!priceText) priceText = $el.find('ins .amount').first().text().trim();  // Discounted price
          if (!priceText) priceText = $el.find('.price').first().text().trim();

          const price = extractPrice(priceText);
          const nameLower = name.toLowerCase();

          // Match against query (first word match)
          const queryFirstWord = queryLower.split(' ')[0];
          if (name && price && nameLower.includes(queryFirstWord) && isFreshProduce(name)) {
            // Normalize price to per-kg for packaged products
            const normalized = normalizePricePerKg(name, price);

            // Avoid duplicates
            if (!found.some(r => r.name === name)) {
              const result = {
                supermarket: config.name,
                name: name.trim(),
                price: normalized.price,
                unit: detectUnit(name)
              };
              if (normalized.normalized) {
                result.originalPrice = normalized.originalPrice;
                result.packageSize = normalized.packageSize;
                result.name = `${name.trim()} [→${normalized.packageSize}→kg]`;
              }
              found.push(result);
            }
          }
        });
      }

      return found;
    };

    // Helper to scrape a single product page
    const scrapeDirectProduct = async (productUrl, queryLower) => {
      try {
        const response = await fetch(productUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 30000
        });

        const html = await response.text();
        const $ = cheerio.load(html);

        // Get product name from h1
        let name = $('h1.product_title, h1.product-title, .product-title').text().trim();
        // Remove duplicate text (Casa Rica sometimes doubles the title)
        if (name) {
          const half = name.length / 2;
          if (name.substring(0, half) === name.substring(half)) {
            name = name.substring(0, half);
          }
        }

        // Get price - Casa Rica uses ecommercepro-Price-amount class
        // Avoid span.amount alone as it can pick up discount badges
        let priceText = $('.price .ecommercepro-Price-amount').first().text().trim();
        if (!priceText) priceText = $('.price .amount').first().text().trim();
        if (!priceText) priceText = $('p.price').first().text().trim();
        if (!priceText) priceText = $('.summary .price').first().text().trim();
        const price = extractPrice(priceText);

        if (name && price && isFreshProduce(name)) {
          const normalized = normalizePricePerKg(name, price);
          const result = {
            supermarket: config.name,
            name: name.trim(),
            price: normalized.price,
            unit: detectUnit(name)
          };
          if (normalized.normalized) {
            result.originalPrice = normalized.originalPrice;
            result.packageSize = normalized.packageSize;
            result.name = `${name.trim()} [→${normalized.packageSize}→kg]`;
          }
          return result;
        }
      } catch (error) {
        console.error(`[Aurelio] Error scraping direct product ${productUrl}:`, error.message);
      }
      return null;
    };

    try {
      // STRATEGY 1: Check if we have a direct product URL for this query
      if (config.directProducts) {
        for (const [productKey, productUrl] of Object.entries(config.directProducts)) {
          if (queryLower.includes(productKey) || productKey.includes(queryLower)) {
            const directResult = await scrapeDirectProduct(productUrl, queryLower);
            if (directResult) {
              results.push(directResult);
            }
          }
        }
      }

      // STRATEGY 2: If no direct match or want more results, try category page
      if (results.length === 0) {
        const categoryUrl = config.categoryUrl || 'https://casarica.com.py/catalogo/verduras-c287';

        const response = await fetch(categoryUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 45000
        });

        const html = await response.text();
        const $ = cheerio.load(html);
        const categoryResults = parseProducts($, queryLower);

        // Add only non-duplicate results
        for (const r of categoryResults) {
          if (!results.some(existing => existing.name === r.name)) {
            results.push(r);
          }
        }
      }
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
   * Uses public API endpoint: https://api.app.biggie.com.py/api/articles
   * Discovered 2026-01-28 via Chrome network inspection
   */
  async biggie(config, query) {
    const results = [];

    try {
      // Biggie public API - fetches all products from fruteria-y-verduleria category
      // API returns: { items: [...], count: N }
      // Each item has: id, code, name, price, unitOfMeasure, brand, family, images
      const apiUrl = 'https://api.app.biggie.com.py/api/articles?take=100&skip=0&classificationName=fruteria-y-verduleria';

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Origin': 'https://biggie.com.py',
          'Referer': 'https://biggie.com.py/'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const products = data.items || [];

        const queryLower = query.toLowerCase();

        for (const p of products) {
          const name = p.name || '';
          const price = p.price || 0;
          const nameLower = name.toLowerCase();

          // Filter by query - match first word of query
          const queryFirstWord = queryLower.split(' ')[0];
          if (nameLower.includes(queryFirstWord) && price && isFreshProduce(name)) {
            // Avoid duplicates
            if (!results.some(r => r.name === name)) {
              results.push({
                supermarket: config.name,
                name: name.trim(),
                price: typeof price === 'number' ? price : extractPrice(String(price)),
                unit: detectUnit(name)
              });
            }
          }
        }
      } else {
        console.error(`[Aurelio] Biggie API returned ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(`[Aurelio] Biggie API request timed out`);
      } else {
        console.error(`[Aurelio] Error scraping ${config.name}:`, error.message);
      }
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
  },

  /**
   * Supermas.com.py scraper (PHP-based ecommerce)
   * Added 2026-01-28 - Clean HTML structure
   * Structure: div.product container
   *            h2.woocommerce-loop-product__title for name
   *            span.amount for price (format: "₲. 18.900")
   */
  async supermas(config, query) {
    const results = [];

    try {
      const categoryUrl = config.categoryUrl || 'https://www.supermas.com.py/catalogo/frutas-y-verduras-c36';

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);

      const response = await fetch(categoryUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-PY,es;q=0.9,en;q=0.8'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const html = await response.text();
      const $ = cheerio.load(html);

      // Find all products in the category page
      $('div.product').each((_, el) => {
        const $el = $(el);

        // Get product name from h2.woocommerce-loop-product__title
        const name = $el.find('h2.woocommerce-loop-product__title').text().trim();

        // Get price from span.amount (skip empty <ins> amounts for discounted prices)
        // Take the last non-empty amount which is the current price
        let price = 0;
        $el.find('span.amount').each((_, priceEl) => {
          const priceText = $(priceEl).text().trim();
          if (priceText) {
            const extracted = extractPrice(priceText);
            if (extracted > 0) {
              price = extracted;
            }
          }
        });

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
      if (error.name === 'AbortError') {
        console.error(`[Aurelio] Supermas request timed out`);
      } else {
        console.error(`[Aurelio] Error scraping ${config.name}:`, error.message);
      }
    }

    return results;
  },

  /**
   * Real Online (Cadena Real) - Instaleap GraphQL API
   * API discovered via reverse engineering 2026-01-28
   * Endpoint: https://nextgentheadless.instaleap.io/api/v3
   */
  async real(config, query) {
    const results = [];

    try {
      const apiUrl = config.apiUrl || 'https://nextgentheadless.instaleap.io/api/v3';
      const clientId = config.clientId || 'CADENA_REAL';
      const storeReference = config.storeReference || '2';

      // GraphQL query for product search
      const graphqlQuery = {
        query: `query SearchProducts($input: SearchProductsInput!) {
          searchProducts(searchProductsInput: $input) {
            products {
              name
              price
              description
            }
          }
        }`,
        variables: {
          input: {
            pageSize: 50,
            currentPage: 1,
            storeReference: storeReference,
            search: [{ query: query }],
            clientId: clientId
          }
        }
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Origin': 'https://www.realonline.com.py',
          'Referer': 'https://www.realonline.com.py/'
        },
        body: JSON.stringify(graphqlQuery),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const products = data?.data?.searchProducts?.products || [];

        for (const product of products) {
          const name = product.name || '';
          // Price is already in Guaranies (e.g., 19950 = Gs. 19,950)
          const price = product.price || 0;

          // Filter for fresh produce only
          if (name && price > 0 && isFreshProduce(name)) {
            // Avoid duplicates
            if (!results.some(r => r.name === name)) {
              // Normalize price per kg for packaged products
              const normalized = normalizePricePerKg(name, price);
              results.push({
                supermarket: config.name,
                name: name.trim(),
                price: normalized.price,
                unit: detectUnit(name),
                originalPrice: normalized.normalized ? normalized.originalPrice : undefined,
                packageSize: normalized.packageSize
              });
            }
          }
        }
      } else {
        console.error(`[Aurelio] Real API returned ${response.status}`);
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(`[Aurelio] Real request timed out`);
      } else {
        console.error(`[Aurelio] Error scraping ${config.name}:`, error.message);
      }
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
    'congelado', 'frozen', 'procesado',
    'polvo', 'condimento', 'especias', 'sazonador',
    // Packaging that indicates processed (but NOT gram weight which can be fresh packaged)
    'frasco', 'botella', 'tetra', 'brick', 'sachet',
    'ml ', 'cc ',  // ml/cc measures usually indicate processed liquids
    // NON-FOOD ITEMS - candy, personal care, etc.
    'caramelo', 'caramelos', 'candy', 'halls', 'mentho', 'mento',
    'chicle', 'goma de mascar', 'gomita',
    'deo', 'desodorante', 'axe', 'rexona', 'dove',
    'spray', 'bodyspra', 'aerosol', 'perfume', 'colonia',
    'shampoo', 'acondicionador', 'jabon', 'jabón',
    'crema', 'locion', 'loción', 'gel de', 'gel para',
    'detergente', 'limpiador', 'lavandina',
    // Snacks that might have cherry/tomato flavors
    'snack', 'chip', 'papa frita', 'nachos'
  ];

  const nameLower = name.toLowerCase();

  // Exclude if contains any forbidden word
  if (excluded.some(word => nameLower.includes(word))) {
    return false;
  }

  // Allow packaged fresh produce (cherry tomatoes, etc.) - these have gram weights
  // Examples: "TOMATE CHERRY 300 G", "LECHUGA HIDROPONICA 200G"
  const packagedFresh = ['cherry', 'hidroponic', 'hidroponico', 'hidropónico', 'organico', 'orgánico'];
  if (packagedFresh.some(word => nameLower.includes(word))) {
    return true;  // These are fresh even if packaged
  }

  // Must contain a recognizable fresh produce indicator or be short enough
  // (long names are usually processed products with ingredient lists)
  if (nameLower.length > 70) {  // Increased limit for packaged product names
    return false;
  }

  // Fresh produce typically has "x kg" or "por kg" or simple names
  const freshIndicators = ['x kg', 'por kg', '/kg', 'x un', 'por un', 'por kilo', 'fresco', 'fresca', 'por unidad', 'x mz', ' g ', ' gr'];
  const hasFreshIndicator = freshIndicators.some(ind => nameLower.includes(ind));

  // If name is reasonable length and doesn't have excluded words, it's likely fresh
  return nameLower.length < 45 || hasFreshIndicator;
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
 * Normalize price to per-kg for products sold by weight
 * Detects package sizes like "300 g", "500g", "1 kg" and converts
 * Also handles "bandeja" products (typically 300g trays for cherry tomatoes)
 */
function normalizePricePerKg(name, price) {
  const nameLower = name.toLowerCase();

  // Skip if already per kg
  if (nameLower.includes('/kg') || nameLower.includes('por kg') || nameLower.includes('x kg')) {
    return { price, normalized: false, packageSize: null };
  }

  // Detect package weight patterns
  // Pattern: "300 g", "300g", "500 g", "1 kg", "1.5 kg", etc.
  const gramsMatch = nameLower.match(/(\d+(?:[.,]\d+)?)\s*g(?:r|rs|ramos)?(?:\s|$|\))/i);
  const kgMatch = nameLower.match(/(\d+(?:[.,]\d+)?)\s*kg(?:\s|$|\))/i);

  if (gramsMatch) {
    const grams = parseFloat(gramsMatch[1].replace(',', '.'));
    if (grams > 0 && grams < 1000) {  // Reasonable gram range
      const pricePerKg = Math.round(price * (1000 / grams));
      return {
        price: pricePerKg,
        normalized: true,
        packageSize: `${grams}g`,
        originalPrice: price
      };
    }
  }

  if (kgMatch) {
    const kg = parseFloat(kgMatch[1].replace(',', '.'));
    if (kg > 0 && kg !== 1) {  // Not exactly 1 kg
      const pricePerKg = Math.round(price / kg);
      return {
        price: pricePerKg,
        normalized: true,
        packageSize: `${kg}kg`,
        originalPrice: price
      };
    }
  }

  // ==========================================================================
  // BANDEJA NORMALIZATION - Based on Paraguay market research (Jan 2026)
  // Standard bandeja sizes:
  // - Cherry tomato: 250g (small), 300g (standard), 500g (family)
  // - Lettuce: 200-250g per head (sold per unit, not normalized to kg)
  // - Herbs (albahaca, cilantro): 30-50g (sold per unit)
  // ==========================================================================

  // Cherry tomato bandejas - normalize to per kg
  // Research: Casa Rica 300g, EcoAgro 500g, standard market 250-300g
  if (nameLower.includes('cherry')) {
    const isBandeja = nameLower.includes('bandeja') || nameLower.includes('pack') ||
                      nameLower.includes('caja') || nameLower.includes('paquete');

    // Price heuristic for cherry tomatoes without explicit weight:
    // - Per bandeja (250-300g): typically 8,000-20,000 Gs
    // - Per kg: typically 35,000-60,000 Gs
    // If no weight detected and price suggests per-bandeja, normalize
    if (isBandeja || (price >= 8000 && price <= 25000)) {
      // Check if it's likely a 500g pack (higher price point: 15,000-25,000)
      const assumedGrams = (price >= 15000 && price <= 25000) ? 500 : 300;
      const pricePerKg = Math.round(price * (1000 / assumedGrams));
      return {
        price: pricePerKg,
        normalized: true,
        packageSize: `~${assumedGrams}g bandeja`,
        originalPrice: price,
        estimated: true
      };
    }
  }

  // Lettuce and herbs in bandejas - keep as unit price, don't normalize to kg
  // These products are sold per mazo/unidad, not by weight
  const unitProducts = ['lechuga', 'albahaca', 'cilantro', 'perejil', 'rucula', 'rúcula',
                        'acelga', 'espinaca', 'kale', 'berro'];
  if (unitProducts.some(p => nameLower.includes(p))) {
    return { price, normalized: false, packageSize: null, unit: 'unidad' };
  }

  // Other bandeja products without explicit weight - return as-is with note
  if (nameLower.includes('bandeja')) {
    return { price, normalized: false, packageSize: 'bandeja', unit: 'unidad' };
  }

  return { price, normalized: false, packageSize: null };
}

/**
 * Check if a product name matches a search term with exclusion support
 * For example: "locote rojo" should only match "locote rojo", not "locote amarillo"
 * @param {string} productName - The scraped product name
 * @param {string} searchTerm - The search term to match
 * @param {string[]} excludeTerms - Terms that should NOT be present (optional)
 * @returns {boolean}
 */
function productMatches(productName, searchTerm, excludeTerms = []) {
  const nameLower = productName.toLowerCase();
  const termLower = searchTerm.toLowerCase();

  // FIRST: Check exclusions - if ANY exclude term is present, reject immediately
  if (excludeTerms && excludeTerms.length > 0) {
    for (const exclude of excludeTerms) {
      if (nameLower.includes(exclude.toLowerCase())) {
        return false;
      }
    }
  }

  // Split search term into words
  const termWords = termLower.split(/\s+/);

  // For multi-word terms, ALL words must be present
  if (termWords.length > 1) {
    return termWords.every(word => nameLower.includes(word));
  }

  // For single-word terms, just check if present
  return nameLower.includes(termLower);
}

// =============================================================================
// ZOHO ANALYTICS SYNC
// =============================================================================

async function syncToZohoAnalytics(db) {
  const credentials = loadZohoCredentials();
  if (!credentials.ZOHO_REFRESH_TOKEN) {
    console.log('[Aurelio] ℹ️ Zoho credentials not found, skipping Analytics sync');
    return;
  }

  try {
    const accessToken = await getZohoAccessToken(credentials);
    const prices = db.getTodayPrices();

    if (prices.length === 0) {
      console.log('[Aurelio] ℹ️ No prices to sync');
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
    console.log(`[Aurelio] ✅ Synced ${data.length} prices to Zoho Analytics`);
  } catch (error) {
    // Check for OAuth scope error
    if (error.message.includes('INVALID_OAUTHSCOPE') || error.message.includes('8540')) {
      console.log('[Aurelio] ⚠️ Zoho Analytics sync skipped - OAuth token missing ZohoAnalytics.data.CREATE scope');
      console.log('[Aurelio]    To enable: regenerate token with scope ZohoAnalytics.fullaccess.CREATE');
    } else {
      console.error('[Aurelio] ❌ Analytics sync failed:', error.message);
    }
  }
}

function loadZohoCredentials() {
  // Try environment variables first (for Railway)
  if (process.env.ZOHO_REFRESH_TOKEN) {
    return {
      ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID,
      ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET,
      ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN,
      ZOHO_DC: process.env.ZOHO_DC || '.com',
      ZOHO_SMTP_USER: process.env.ZOHO_SMTP_USER,
      ZOHO_SMTP_PASSWORD: process.env.ZOHO_SMTP_PASSWORD,
      EMAIL_TO: process.env.EMAIL_TO
    };
  }

  // Fallback to .env file (try multiple locations)
  const envPaths = [
    join(__dirname, '..', 'zoho-mcp', '.env'),               // From agents/aurelio/ → agents/zoho-mcp/
    join(__dirname, '..', '..', 'zoho-mcp-server', '.env'),  // Legacy location
    join(__dirname, '.env')                                   // Local .env
  ];

  const envPath = envPaths.find(p => existsSync(p));
  if (envPath) {
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

/**
 * Load credentials from .env file and set as environment variables
 * Called once at startup to ensure all env vars are available
 */
function loadEnvCredentials() {
  const creds = loadZohoCredentials();
  for (const [key, value] of Object.entries(creds)) {
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
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
// ZOHO BOOKS INTEGRATION - Sales History
// =============================================================================

/**
 * Query Zoho Books for HidroBio sales prices over the last week
 * Returns detailed sales data per product for strategy implementation analysis
 */
async function getWeeklySalesPrices() {
  const credentials = loadZohoCredentials();

  if (!credentials.ZOHO_REFRESH_TOKEN) {
    console.log('[Aurelio] ⚠️ Sin credenciales para consultar ventas de Zoho Books');
    return { sales: {}, period: null };
  }

  try {
    const accessToken = await getZohoAccessToken(credentials);
    const orgId = credentials.ZOHO_ORG_ID || '862876482';

    // Calculate date range (last 7 days)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const formatDate = (d) => d.toISOString().split('T')[0];
    const startDateStr = formatDate(startDate);
    const endDateStr = formatDate(endDate);

    // Query invoices from last 7 days
    // Zoho Books API: use date_start and date_end parameters, status as separate param
    const invoicesUrl = `https://www.zohoapis.com/books/v3/invoices?organization_id=${orgId}&date_start=${startDateStr}&date_end=${endDateStr}&status=sent&sort_column=date&sort_order=D&per_page=100`;

    const invoicesResponse = await fetch(invoicesUrl, {
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!invoicesResponse.ok) {
      const errorText = await invoicesResponse.text();
      console.log('[Aurelio] ⚠️ Error consultando facturas:', invoicesResponse.status, errorText.substring(0, 200));
      return { sales: {}, period: { start: startDateStr, end: endDateStr } };
    }

    const invoicesData = await invoicesResponse.json();
    const invoices = invoicesData.invoices || [];

    console.log(`[Aurelio] 📊 Encontradas ${invoices.length} facturas del ${startDateStr} al ${endDateStr}`);

    // Product name mappings (Zoho Books item names → Aurelio product names)
    const productMappings = {
      'TOMATE LISA': 'Tomate Lisa',
      'TOMATE PERITA': 'Tomate Perita',
      'TOMATE CHERRY': 'Tomate Cherry',
      'LOCOTE ROJO': 'Locote Rojo',
      'LOCOTE AMARILLO': 'Locote Amarillo',
      'LECHUGA PIRATI': 'Lechuga Pirati',
      'LECHUGA': 'Lechuga Pirati',  // Generic lechuga → Pirati
      'PEREJIL': 'Verdeos',
      'CILANTRO': 'Verdeos',
      'ALBAHACA': 'Verdeos',
      'CEBOLLITA': 'Verdeos',
      'RUCULA': 'Verdeos'
    };

    // Aggregate sales by product with customer segment tracking
    const salesByProduct = {};

    for (const invoice of invoices) {
      // Skip if invoice date is outside our range (double-check)
      const invoiceDate = new Date(invoice.date);
      if (invoiceDate < startDate || invoiceDate > endDate) continue;

      // Get invoice details to access line items
      const detailUrl = `https://www.zohoapis.com/books/v3/invoices/${invoice.invoice_id}?organization_id=${orgId}`;
      const detailResponse = await fetch(detailUrl, {
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!detailResponse.ok) continue;

      const detailData = await detailResponse.json();
      const lineItems = detailData.invoice?.line_items || [];
      const customerName = invoice.customer_name || 'Unknown';

      for (const item of lineItems) {
        const itemName = (item.name || '').toUpperCase();

        // Find matching product
        for (const [bookName, aurelioName] of Object.entries(productMappings)) {
          if (itemName.includes(bookName)) {
            if (!salesByProduct[aurelioName]) {
              salesByProduct[aurelioName] = {
                totalRevenue: 0,
                totalQuantity: 0,
                transactions: [],
                customers: new Set()
              };
            }

            const unitPrice = item.rate || (item.item_total / item.quantity);
            const quantity = item.quantity || 0;

            salesByProduct[aurelioName].totalRevenue += item.item_total || 0;
            salesByProduct[aurelioName].totalQuantity += quantity;
            salesByProduct[aurelioName].customers.add(customerName);
            salesByProduct[aurelioName].transactions.push({
              date: invoice.date,
              customer: customerName,
              quantity: quantity,
              unitPrice: Math.round(unitPrice),
              total: item.item_total || 0
            });
            break;
          }
        }
      }
    }

    // Calculate statistics for each product
    const salesData = {};
    for (const [product, data] of Object.entries(salesByProduct)) {
      if (data.totalQuantity > 0) {
        const prices = data.transactions.map(t => t.unitPrice);
        salesData[product] = {
          avgPrice: Math.round(data.totalRevenue / data.totalQuantity),
          totalQty: Math.round(data.totalQuantity * 10) / 10,  // 1 decimal
          totalRevenue: Math.round(data.totalRevenue),
          transactionCount: data.transactions.length,
          customerCount: data.customers.size,
          minPrice: Math.min(...prices),
          maxPrice: Math.max(...prices),
          priceSpread: Math.max(...prices) - Math.min(...prices),
          // For strategy analysis: what % of transactions were at different price points
          transactions: data.transactions
        };
      }
    }

    console.log(`[Aurelio] ✅ Ventas analizadas: ${Object.keys(salesData).length} productos, ${invoices.length} facturas`);

    return {
      sales: salesData,
      period: {
        start: startDateStr,
        end: endDateStr,
        invoiceCount: invoices.length
      }
    };

  } catch (error) {
    console.error('[Aurelio] ❌ Error consultando Zoho Books:', error.message);
    return { sales: {}, period: null };
  }
}

// =============================================================================
// CUSTOMER ANALYSIS - CRM Segments and Lifecycle Integration
// =============================================================================

/**
 * Fetch customer analysis data from Zoho CRM
 * Uses lifecycle stages from the lifecycle-monitor agent and segments
 * Returns engagement metrics and segment breakdown of weekly sales
 */
async function getCustomerAnalysis(invoices) {
  const credentials = loadZohoCredentials();

  if (!credentials.ZOHO_REFRESH_TOKEN) {
    console.log('[Aurelio] ⚠️ Sin credenciales para consultar CRM');
    return null;
  }

  try {
    const accessToken = await getZohoAccessToken(credentials);
    const dc = credentials.ZOHO_DC || '.com';

    // Fetch CRM accounts with segment and lifecycle data
    const fields = 'Account_Name,Segmento,Etapa_del_ciclo_de_vida,Interes_Principal,ZB_Books_Customer_ID,Desde_Ultimo_Pedido,Fecha_del_Ultimo_Pedido';
    let allAccounts = [];
    let page = 1;

    while (page <= 10) {
      const url = `https://www.zohoapis${dc}/crm/v6/Accounts?fields=${fields}&per_page=200&page=${page}`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
      });

      if (!response.ok) break;

      const data = await response.json();
      if (!data.data || data.data.length === 0) break;

      allAccounts.push(...data.data);
      if (data.data.length < 200) break;
      page++;
    }

    console.log(`[Aurelio] 👥 Loaded ${allAccounts.length} CRM accounts`);

    // Build lookup: Books customer_id → Account data
    const accountLookup = new Map();
    for (const account of allAccounts) {
      if (account.ZB_Books_Customer_ID) {
        accountLookup.set(account.ZB_Books_Customer_ID.toString(), {
          name: account.Account_Name,
          segment: account.Segmento || 'Sin Segmento',
          lifecycle: account.Etapa_del_ciclo_de_vida || 'Prospecto',
          interest: account.Interes_Principal,
          daysSinceOrder: account.Desde_Ultimo_Pedido
        });
      }
    }

    // Analyze customers by segment and lifecycle
    const segmentStats = {};
    const lifecycleStats = {
      'Cliente Activo': { count: 0, revenue: 0 },
      'En Riesgo': { count: 0, revenue: 0 },
      'Inactivo': { count: 0, revenue: 0 },
      'Prospecto': { count: 0, revenue: 0 },
      'Descalificado': { count: 0, revenue: 0 },
      'No Aplica': { count: 0, revenue: 0 }
    };

    // Initialize segment stats for known segments
    const knownSegments = [
      '⭐⭐⭐⭐⭐ Directo/B2C',
      '⭐⭐⭐⭐ HORECA Premium',
      '⭐⭐⭐ Supermercado',
      '⭐⭐ Institucional',
      '⭐ Mayorista/Distribuidor',
      'Sin Segmento'
    ];

    for (const seg of knownSegments) {
      segmentStats[seg] = {
        uniqueCustomers: new Set(),
        transactions: 0,
        revenue: 0,
        products: {}
      };
    }

    // Process invoices and enrich with segment data
    const customersThisWeek = new Set();
    const newCustomers = [];
    const repeatCustomers = [];

    for (const invoice of invoices || []) {
      const customerId = invoice.customer_id?.toString();
      const customerName = invoice.customer_name || 'Unknown';
      const accountData = accountLookup.get(customerId);

      const segment = accountData?.segment || 'Sin Segmento';
      const lifecycle = accountData?.lifecycle || 'Prospecto';

      // Track unique customers
      customersThisWeek.add(customerId);

      // Initialize segment if not known
      if (!segmentStats[segment]) {
        segmentStats[segment] = {
          uniqueCustomers: new Set(),
          transactions: 0,
          revenue: 0,
          products: {}
        };
      }

      segmentStats[segment].uniqueCustomers.add(customerId);
      segmentStats[segment].transactions++;
      segmentStats[segment].revenue += invoice.total || 0;

      // Track lifecycle
      if (lifecycleStats[lifecycle]) {
        lifecycleStats[lifecycle].count++;
        lifecycleStats[lifecycle].revenue += invoice.total || 0;
      }
    }

    // Calculate engagement metrics
    const freshAccounts = allAccounts.filter(a =>
      a.Interes_Principal === 'Productos Frescos'
    );

    const activeCustomers = freshAccounts.filter(a =>
      a.Etapa_del_ciclo_de_vida === 'Cliente Activo'
    ).length;

    const atRiskCustomers = freshAccounts.filter(a =>
      a.Etapa_del_ciclo_de_vida === 'En Riesgo'
    ).length;

    const inactiveCustomers = freshAccounts.filter(a =>
      a.Etapa_del_ciclo_de_vida === 'Inactivo'
    ).length;

    // Build segment summary (convert Sets to counts)
    const segmentSummary = {};
    for (const [seg, stats] of Object.entries(segmentStats)) {
      if (stats.uniqueCustomers.size > 0 || stats.revenue > 0) {
        // Extract short segment name for display
        const shortName = seg.replace(/⭐+\s*/g, '').trim() || 'Sin Segmento';
        segmentSummary[shortName] = {
          uniqueCustomers: stats.uniqueCustomers.size,
          transactions: stats.transactions,
          revenue: Math.round(stats.revenue),
          avgTransaction: stats.transactions > 0 ? Math.round(stats.revenue / stats.transactions) : 0
        };
      }
    }

    console.log(`[Aurelio] ✅ Customer analysis: ${activeCustomers} activos, ${atRiskCustomers} en riesgo, ${inactiveCustomers} inactivos`);

    return {
      totalFreshCustomers: freshAccounts.length,
      bySegment: segmentSummary,
      engagement: {
        activeCustomers,
        atRiskCustomers,
        inactiveCustomers,
        customersThisWeek: customersThisWeek.size
      },
      lifecycleStats
    };

  } catch (error) {
    console.error('[Aurelio] ❌ Error consultando CRM:', error.message);
    return null;
  }
}

// =============================================================================
// GOVERNMENT WHOLESALE PRICES - SIMA/DAMA Integration
// =============================================================================

/**
 * Scrape government wholesale prices from SIMA and DAMA sources
 * These prices represent wholesale market conditions that affect negotiations
 */
async function getGovernmentWholesalePrices() {
  console.log('[Aurelio] 📊 Consultando precios mayoristas del gobierno...');

  const results = [];

  // Products we're tracking
  const TRACKED_PRODUCTS = {
    'tomate lisa': { unit: 'kg', aurelioName: 'Tomate Lisa' },
    'tomate perita': { unit: 'kg', aurelioName: 'Tomate Perita' },
    'tomate cherry': { unit: 'kg', aurelioName: 'Tomate Cherry' },
    'locote rojo': { unit: 'kg', aurelioName: 'Locote Rojo' },
    'locote amarillo': { unit: 'kg', aurelioName: 'Locote Amarillo' },
    'lechuga pirati': { unit: 'docena', aurelioName: 'Lechuga Pirati' },
    'lechuga': { unit: 'docena', aurelioName: 'Lechuga Pirati' },
    'verdeos': { unit: 'docena', aurelioName: 'Verdeos' }
  };

  // Try SIMA (mag.gov.py)
  const simaUrls = [
    'https://www.mag.gov.py/precios-sima',
    'https://www.mag.gov.py/index.php/institucion/dependencias/dc/sima'
  ];

  for (const url of simaUrls) {
    try {
      const response = await fetch(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HidroBioBot/1.0; +https://hidrobio.com.py)'
        }
      });

      if (!response.ok) continue;

      const html = await response.text();
      const $ = cheerio.load(html);

      // Look for price tables
      $('table').each((_, table) => {
        const rows = $(table).find('tr');
        rows.each((_, row) => {
          const cells = $(row).find('td, th');
          if (cells.length < 2) return;

          const productText = $(cells[0]).text().toLowerCase().trim();
          const priceText = $(cells[cells.length - 1]).text().trim();

          for (const [product, config] of Object.entries(TRACKED_PRODUCTS)) {
            if (productText.includes(product)) {
              const priceMatch = priceText.replace(/\./g, '').match(/(\d+)/);
              if (priceMatch) {
                results.push({
                  source: 'SIMA',
                  product: config.aurelioName,
                  price: parseInt(priceMatch[1]),
                  unit: config.unit,
                  date: new Date().toISOString().split('T')[0]
                });
              }
              break;
            }
          }
        });
      });

      if (results.length > 0) {
        console.log(`[Aurelio] SIMA: ${results.length} precios encontrados`);
        break;
      }
    } catch (e) {
      // Continue to next URL
    }
  }

  // Try DAMA (datos.gov.py CKAN API)
  try {
    const ckanUrl = 'https://datos.gov.py/api/3/action/package_search?q=abasto+precios';
    const searchResponse = await fetch(ckanUrl, { timeout: 10000 });

    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      if (searchData.success && searchData.result?.results) {
        for (const dataset of searchData.result.results.slice(0, 3)) {
          for (const resource of dataset.resources || []) {
            if (resource.format === 'CSV' || resource.format === 'JSON') {
              // Could download and parse, but for now just note availability
              console.log(`[Aurelio] DAMA dataset encontrado: ${dataset.title}`);
            }
          }
        }
      }
    }
  } catch (e) {
    // DAMA API not available
  }

  console.log(`[Aurelio] 📊 Precios mayoristas: ${results.length} encontrados`);

  return results;
}

// =============================================================================
// REASONING ENGINE (Claude-Powered Analysis)
// =============================================================================

async function analyzeWithClaude(db, todayPrices) {
  const anthropic = new Anthropic();

  // Get weekly sales data from Zoho Books
  console.log('[Aurelio] 📊 Consultando precios de venta de última semana...');
  const weeklySales = await getWeeklySalesPrices();

  // Get customer analysis from CRM (segments and lifecycle)
  console.log('[Aurelio] 👥 Consultando análisis de clientes...');
  const customerAnalysis = await getCustomerAnalysis(weeklySales.invoices);

  // Get government wholesale prices (SIMA/DAMA)
  console.log('[Aurelio] 🏛️ Consultando precios mayoristas del gobierno...');
  const wholesalePrices = await getGovernmentWholesalePrices();

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

    // Get actual sales data for this product
    const salesData = weeklySales.sales?.[productConfig.name] || null;

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
      alerts,
      // Actual HidroBio sales data from Zoho Books
      actualSales: salesData
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
        "consumidorFinal": {
          "precioMeta": número (precio objetivo - 90% de mediana),
          "precioMinimo": número (precio mínimo negociable - 85% de mediana, respetando piso),
          "precioMaximo": número (precio máximo - 95% de mediana),
          "margen": "X%"
        },
        "horeca": {
          "precioMeta": número (75% de mediana),
          "precioMinimo": número (70% de mediana, respetando piso),
          "precioMaximo": número (80% de mediana),
          "margen": "X%"
        },
        "supermercados": {
          "precioMeta": número (68% de mediana),
          "precioMinimo": número (60% de mediana, respetando piso),
          "precioMaximo": número (75% de mediana),
          "margen": "X%"
        },
        "institucional": {
          "precioMeta": número (60% de mediana),
          "precioMinimo": número (55% de mediana, respetando piso),
          "precioMaximo": número (65% de mediana),
          "margen": "X%"
        }
      },
      "pisoAbsoluto": número,
      "comentario": "Observación específica del producto",
      "alertas": ["lista de alertas si hay violaciones de reglas"],
      "implementacionEstrategia": {
        "tieneVentas": boolean,
        "precioPromedioVendido": número o null,
        "cantidadVendida": número o null,
        "porcentajeVsMediana": "X%" o null (precioVendido/medianaSupermercados*100),
        "evaluacion": "excelente|bueno|aceptable|bajo|critico|sin_datos",
        "comentarioImplementacion": "Análisis breve de cómo se está implementando la estrategia"
      }
    }
  ],
  "recomendacionSemanal": "Resumen ejecutivo para el equipo comercial sobre qué precios actualizar y bandas de negociación",
  "analisisImplementacion": {
    "resumen": "Evaluación global de cómo se está implementando la estrategia de precios",
    "productosDestacados": ["productos donde la implementación es excelente"],
    "productosMejorar": ["productos donde hay oportunidad de mejora"],
    "accionesSugeridas": ["1-3 acciones concretas para mejorar la implementación"]
  },
  "analisisClientes": {
    "resumen": "Evaluación del engagement de clientes y oportunidades",
    "clientesEnRiesgo": número,
    "segmentoMasValor": "nombre del segmento con mayor revenue o ticket promedio",
    "accionesEngagement": ["1-2 acciones para retener clientes en riesgo o activar inactivos"]
  },
  "referenciaMayorista": {
    "tendencia": "subiendo|bajando|estable|sin_datos",
    "oportunidad": "Descripción breve de cómo aprovechar o proteger vs precios mayoristas"
  },
  "alertasGenerales": ["alertas importantes"]
}

IMPORTANTE:
1. Para cada segmento, el vendedor puede negociar DENTRO de la banda (precioMinimo - precioMaximo), con precioMeta como precio inicial de oferta.
2. La evaluación de implementación compara el precio promedio vendido vs la mediana del mercado:
   - excelente: vendiendo a 75-95% de mediana (dentro de bandas HORECA-ConsumidorFinal)
   - bueno: vendiendo a 65-75% de mediana (banda Supermercados)
   - aceptable: vendiendo a 55-65% de mediana (banda Institucional)
   - bajo: vendiendo a 45-55% de mediana (banda Mayorista - EVITAR)
   - critico: vendiendo a <45% de mediana (perdiendo margen)
   - sin_datos: no hay ventas registradas esta semana`;

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

📈 VENTAS REALES HIDROBIO (últimos 7 días):
${p.actualSales ? `  - Precio promedio vendido: Gs. ${p.actualSales.avgPrice.toLocaleString()}
  - % vs Mediana Mercado: ${(p.actualSales.avgPrice / p.marketMedian * 100).toFixed(1)}%
  - Rango de precios vendidos: Gs. ${p.actualSales.minPrice.toLocaleString()} - Gs. ${p.actualSales.maxPrice.toLocaleString()}
  - Dispersión de precios: Gs. ${p.actualSales.priceSpread?.toLocaleString() || '0'} (max-min)
  - Cantidad vendida: ${p.actualSales.totalQty} ${p.unit}
  - Clientes: ${p.actualSales.customerCount || 1}
  - Facturas: ${p.actualSales.transactionCount || p.actualSales.invoiceCount}
  - Ingresos totales: Gs. ${p.actualSales.totalRevenue?.toLocaleString() || 'N/A'}` : '  - Sin datos de ventas esta semana'}

${p.alerts.length > 0 ? `⚠️ ALERTAS: ${p.alerts.join('; ')}` : ''}
`).join('\n')}

CONTEXTO HIDROBIO:
- Productores hidropónicos premium con 7+ años en el mercado
- Premio AHK Paraguay Sostenibilidad 2025 (1er lugar)
- Sin pesticidas, disponibles 365 días, trazabilidad completa
- Objetivo: posicionamiento PREMIUM, nunca el más barato

${wholesalePrices.length > 0 ? `
🏛️ PRECIOS MAYORISTAS DEL GOBIERNO (SIMA/DAMA):
Estos precios representan el mercado mayorista y afectan las negociaciones con supermercados:
${wholesalePrices.map(p => `- ${p.product}: Gs. ${p.price.toLocaleString()}/${p.unit} (${p.source})`).join('\n')}
` : ''}

${customerAnalysis ? `
👥 ANÁLISIS DE CLIENTES (datos del CRM):

ENGAGEMENT DE CLIENTES (productos frescos):
- Total clientes productos frescos: ${customerAnalysis.totalFreshCustomers}
- Clientes Activos: ${customerAnalysis.engagement.activeCustomers} (comprando regularmente)
- En Riesgo: ${customerAnalysis.engagement.atRiskCustomers} (sin comprar en periodo normal)
- Inactivos: ${customerAnalysis.engagement.inactiveCustomers} (más de 2x su periodo normal sin comprar)
- Clientes que compraron esta semana: ${customerAnalysis.engagement.customersThisWeek}

VENTAS POR SEGMENTO (esta semana):
${Object.entries(customerAnalysis.bySegment).map(([seg, data]) =>
  `- ${seg}: ${data.uniqueCustomers} clientes, ${data.transactions} transacciones, Gs. ${data.revenue.toLocaleString()} ingresos, ticket promedio Gs. ${data.avgTransaction.toLocaleString()}`
).join('\n')}
` : ''}

TAREA:
1. Revisa los precios calculados y valida si son coherentes
2. Ajusta si hay violaciones del piso absoluto o márgenes insuficientes
3. Genera recomendaciones finales para que el equipo actualice la Calculadora de Precios
4. Identifica alertas o tendencias importantes
5. ANÁLISIS DE IMPLEMENTACIÓN: Compara los precios REALMENTE vendidos vs nuestra estrategia:
   - ¿Estamos vendiendo dentro de las bandas recomendadas?
   - ¿A qué segmento corresponden los precios que estamos vendiendo?
   - ¿Hay oportunidad de subir precios sin perder clientes?
   - Si el precio promedio vendido es muy bajo vs la mediana, ¿estamos regalando margen?
6. ANÁLISIS DE CLIENTES (si hay datos):
   - ¿Hay clientes En Riesgo que necesitan atención comercial?
   - ¿Qué segmentos están generando más valor?
   - ¿Hay correlación entre segmento y precios pagados?
7. REFERENCIA MAYORISTA (si hay datos SIMA/DAMA):
   - ¿Cómo están los precios HidroBio vs mayorista?
   - Si el mayorista sube, es oportunidad para subir precios
   - Si el mayorista baja, presión competitiva`;

  try {
    console.log('[Aurelio] Iniciando análisis con Claude...');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 8192,
      messages: [
        { role: 'user', content: userPrompt }
      ],
      system: systemPrompt
    });

    let content = response.content[0].text;

    // Strip markdown code blocks if present (```json ... ```)
    if (content.includes('```')) {
      content = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    }

    // Clean up common JSON issues from LLM responses
    // Remove trailing commas before closing brackets
    content = content.replace(/,(\s*[\]}])/g, '$1');
    // Remove any leading/trailing whitespace
    content = content.trim();

    // Parse JSON response
    let analysis;
    try {
      analysis = JSON.parse(content);
      console.log('[Aurelio] Análisis completado exitosamente');
    } catch (parseError) {
      console.error('[Aurelio] Error parsing Claude response:', parseError.message);
      console.log('[Aurelio] Raw response (first 1000 chars):', content.substring(0, 1000));
      console.log('[Aurelio] Raw response (last 500 chars):', content.substring(content.length - 500));

      // Try to extract partial JSON if possible
      try {
        // Find the last valid JSON object
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          let cleaned = jsonMatch[0];
          cleaned = cleaned.replace(/,(\s*[\]}])/g, '$1');
          analysis = JSON.parse(cleaned);
          console.log('[Aurelio] Recuperado análisis parcial');
        }
      } catch (e) {
        console.error('[Aurelio] No se pudo recuperar análisis parcial');
      }

      if (!analysis) {
        analysis = {
          resumenEjecutivo: 'Error al procesar el análisis. Ejecuta de nuevo.',
          productos: [],
          alertasGenerales: ['Error de parsing en la respuesta de Claude - intenta ejecutar de nuevo'],
          accionesRecomendadas: []
        };
      }
    }

    // Always inject raw CRM data for dashboard (independent of Claude's response)
    if (customerAnalysis && !analysis.datosCrmDirectos) {
      analysis.datosCrmDirectos = {
        totalFreshCustomers: customerAnalysis.totalFreshCustomers,
        engagement: customerAnalysis.engagement,
        bySegment: customerAnalysis.bySegment
      };
      console.log('[Aurelio] ✅ Datos CRM inyectados en análisis');
    }

    return analysis;
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
        console.log(`     BANDAS DE PRECIOS B2B (Mín - Meta - Máx):`);
        const formatBand = (seg) => {
          if (!seg) return 'N/A';
          const min = seg.precioMinimo || seg.precio;
          const meta = seg.precioMeta || seg.precio;
          const max = seg.precioMaximo || seg.precio;
          return `Gs. ${min?.toLocaleString()} - ${meta?.toLocaleString()} - ${max?.toLocaleString()} (margen ${seg.margen})`;
        };
        if (precios.consumidorFinal) {
          console.log(`       → Consumidor Final: ${formatBand(precios.consumidorFinal)}`);
        }
        if (precios.horeca) {
          console.log(`       → HORECA: ${formatBand(precios.horeca)}`);
        }
        if (precios.supermercados) {
          console.log(`       → Supermercados: ${formatBand(precios.supermercados)}`);
        }
        if (precios.institucional) {
          console.log(`       → Institucional: ${formatBand(precios.institucional)}`);
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

  // Strategy Implementation Analysis
  if (analysis.analisisImplementacion) {
    console.log('\n' + '═'.repeat(80));
    console.log('  📈 ANÁLISIS DE IMPLEMENTACIÓN DE ESTRATEGIA');
    console.log('═'.repeat(80));

    console.log('\n' + analysis.analisisImplementacion.resumen || 'Sin análisis disponible');

    // Per-product implementation summary table
    const productsWithSales = analysis.productos?.filter(p => p.implementacionEstrategia?.tieneVentas);
    if (productsWithSales?.length > 0) {
      console.log('\n┌─────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┐');
      console.log('│      PRODUCTO       │  PRECIO VEND │   % MEDIANA  │  EVALUACIÓN  │   CANTIDAD   │');
      console.log('├─────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤');

      for (const prod of productsWithSales) {
        const impl = prod.implementacionEstrategia;
        const name = (prod.producto || 'N/A').padEnd(19).substring(0, 19);
        const avgPrice = impl.precioPromedioVendido ? `Gs. ${impl.precioPromedioVendido.toLocaleString()}`.padStart(12) : '     N/A    ';
        const pctMedian = impl.porcentajeVsMediana ? impl.porcentajeVsMediana.padStart(12) : '     N/A    ';
        const evalIcon = {
          'excelente': '⭐ Excelente',
          'bueno': '✅ Bueno    ',
          'aceptable': '➖ Aceptable',
          'bajo': '⚠️ Bajo     ',
          'critico': '🔴 Crítico  '
        }[impl.evaluacion] || impl.evaluacion?.padEnd(12).substring(0, 12) || '     N/A    ';
        const qty = impl.cantidadVendida ? `${impl.cantidadVendida}`.padStart(12) : '     N/A    ';

        console.log(`│ ${name} │ ${avgPrice} │ ${pctMedian} │ ${evalIcon} │ ${qty} │`);
      }
      console.log('└─────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┘');
    }

    if (analysis.analisisImplementacion.productosDestacados?.length > 0) {
      console.log('\n  🌟 DESTACADOS:');
      for (const p of analysis.analisisImplementacion.productosDestacados) {
        console.log(`     ✓ ${p}`);
      }
    }

    if (analysis.analisisImplementacion.productosMejorar?.length > 0) {
      console.log('\n  📌 OPORTUNIDADES DE MEJORA:');
      for (const p of analysis.analisisImplementacion.productosMejorar) {
        console.log(`     → ${p}`);
      }
    }

    if (analysis.analisisImplementacion.accionesSugeridas?.length > 0) {
      console.log('\n  🎯 ACCIONES SUGERIDAS:');
      for (let i = 0; i < analysis.analisisImplementacion.accionesSugeridas.length; i++) {
        console.log(`     ${i + 1}. ${analysis.analisisImplementacion.accionesSugeridas[i]}`);
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

  // Send email using Zoho Mail SMTP
  const smtpUser = process.env.ZOHO_SMTP_USER || process.env.SMTP_USER;
  const smtpPassword = process.env.ZOHO_SMTP_PASSWORD || process.env.SMTP_PASSWORD;
  const emailTo = process.env.EMAIL_TO || 'daniel@hidrobio.com.py';

  if (smtpUser && smtpPassword) {
    try {
      console.log(`[Aurelio] 📧 Enviando email a ${emailTo} via Zoho SMTP...`);

      // Generate HTML content
      const htmlContent = generateEmailHtml(analysis, todayPrices, date);

      // Create Zoho SMTP transporter
      // Using port 465 with SSL (more likely to work on cloud platforms than 587/TLS)
      const transporter = nodemailer.createTransport({
        host: 'smtp.zoho.com',
        port: 465,
        secure: true, // SSL
        auth: {
          user: smtpUser,
          pass: smtpPassword
        },
        tls: {
          rejectUnauthorized: false // Allow self-signed certs if needed
        }
      });

      // Send email
      // Use aurelio@hidrobio.com.py as sender if configured as alias in Zoho Mail
      const emailFrom = process.env.EMAIL_FROM || smtpUser;
      const info = await transporter.sendMail({
        from: `"Aurelio - HidroBio" <${emailFrom}>`,
        to: emailTo,
        subject: subject,
        html: htmlContent,
        text: generatePlainTextReport(analysis) // Fallback plain text
      });

      console.log(`[Aurelio] ✅ Email enviado exitosamente (Message ID: ${info.messageId})`);

    } catch (error) {
      console.error('[Aurelio] ❌ Error enviando email via SMTP:', error.message);

      // If SMTP fails, try Zoho Mail API as fallback (if configured)
      await tryZohoMailApi(subject, generateEmailHtml(analysis, todayPrices, date), emailTo);
    }
  } else {
    console.log('[Aurelio] ℹ️ Email no configurado. Agregar a variables de entorno:');
    console.log('           ZOHO_SMTP_USER=daniel@hidrobio.com.py');
    console.log('           ZOHO_SMTP_PASSWORD=<app-password>');
  }
}

/**
 * Generate plain text version of the report for email
 */
function generatePlainTextReport(analysis) {
  let text = `AURELIO - REPORTE DE PRECIOS HIDROBIO\n`;
  text += `${'='.repeat(50)}\n\n`;

  text += `RESUMEN EJECUTIVO:\n`;
  text += `${analysis.resumenEjecutivo || 'Sin resumen disponible'}\n\n`;

  if (analysis.productos && analysis.productos.length > 0) {
    text += `PRECIOS RECOMENDADOS:\n`;
    text += `${'-'.repeat(30)}\n`;

    for (const prod of analysis.productos) {
      text += `\n${prod.producto}\n`;
      text += `  Mediana Mercado: Gs. ${prod.medianaSupermercados?.toLocaleString() || 'N/A'}\n`;

      if (prod.preciosRecomendadosHidroBio) {
        const p = prod.preciosRecomendadosHidroBio;
        const getPrice = (seg) => seg?.precioMeta || seg?.precio;
        if (p.consumidorFinal) text += `  → Consumidor Final: Gs. ${getPrice(p.consumidorFinal)?.toLocaleString()}\n`;
        if (p.horeca) text += `  → HORECA: Gs. ${getPrice(p.horeca)?.toLocaleString()}\n`;
        if (p.supermercados) text += `  → Supermercados: Gs. ${getPrice(p.supermercados)?.toLocaleString()}\n`;
        if (p.institucional) text += `  → Institucional: Gs. ${getPrice(p.institucional)?.toLocaleString()}\n`;
      }
    }
  }

  if (analysis.recomendacionSemanal) {
    text += `\nRECOMENDACIÓN SEMANAL:\n`;
    text += `${analysis.recomendacionSemanal}\n`;
  }

  text += `\n${'='.repeat(50)}\n`;
  text += `Generado por Aurelio - HidroBio S.A.\n`;

  return text;
}

/**
 * Fallback: Try sending via Zoho Mail API (requires ZohoMail.messages.CREATE scope)
 */
async function tryZohoMailApi(subject, htmlContent, toEmail) {
  const credentials = loadZohoCredentials();

  if (!credentials.ZOHO_REFRESH_TOKEN) {
    console.log('[Aurelio] ℹ️ Zoho Mail API fallback no disponible (sin credenciales OAuth)');
    return false;
  }

  try {
    console.log('[Aurelio] 🔄 Intentando envío via Zoho Mail API...');

    const accessToken = await getZohoAccessToken(credentials);

    // First, get the account ID
    const accountsResponse = await fetch('https://mail.zoho.com/api/accounts', {
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!accountsResponse.ok) {
      const errorText = await accountsResponse.text();
      console.log('[Aurelio] ⚠️ Zoho Mail API no disponible (scope ZohoMail.messages.CREATE no configurado)');
      console.log(`[Aurelio]    Error: ${errorText.substring(0, 200)}`);
      return false;
    }

    const accountsData = await accountsResponse.json();
    const accountId = accountsData.data?.[0]?.accountId;

    if (!accountId) {
      console.log('[Aurelio] ⚠️ No se encontró cuenta de Zoho Mail');
      return false;
    }

    // Send email
    const sendResponse = await fetch(`https://mail.zoho.com/api/accounts/${accountId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        fromAddress: process.env.ZOHO_SMTP_USER || 'daniel@hidrobio.com.py',
        toAddress: toEmail,
        subject: subject,
        content: htmlContent,
        mailFormat: 'html'
      })
    });

    if (sendResponse.ok) {
      const result = await sendResponse.json();
      console.log(`[Aurelio] ✅ Email enviado via Zoho Mail API`);
      return true;
    } else {
      const errorText = await sendResponse.text();
      console.error('[Aurelio] ❌ Error Zoho Mail API:', errorText.substring(0, 200));
      return false;
    }

  } catch (error) {
    console.error('[Aurelio] ❌ Error en Zoho Mail API fallback:', error.message);
    return false;
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

/**
 * Generate HTML for Strategy Implementation Analysis section
 */
function generateStrategyImplementationHtml(analysis) {
  if (!analysis.analisisImplementacion) return '';

  const productsWithSales = analysis.productos?.filter(p => p.implementacionEstrategia?.tieneVentas) || [];

  // Build products table
  let productsTableHtml = '';
  if (productsWithSales.length === 0) {
    productsTableHtml = '<p style="color: #7B1FA2;">Sin datos de ventas esta semana para analizar.</p>';
  } else {
    const rows = productsWithSales.map((prod, i) => {
      const impl = prod.implementacionEstrategia;
      const evalColor =
        impl.evaluacion === 'excelente' ? '#4CAF50' :
        impl.evaluacion === 'bueno' ? '#8BC34A' :
        impl.evaluacion === 'aceptable' ? '#FFC107' :
        impl.evaluacion === 'bajo' ? '#FF9800' :
        impl.evaluacion === 'critico' ? '#F44336' : '#9E9E9E';
      const evalLabel =
        impl.evaluacion === 'excelente' ? '⭐ Excelente' :
        impl.evaluacion === 'bueno' ? '✅ Bueno' :
        impl.evaluacion === 'aceptable' ? '➖ Aceptable' :
        impl.evaluacion === 'bajo' ? '⚠️ Bajo' :
        impl.evaluacion === 'critico' ? '🔴 Crítico' : impl.evaluacion || 'N/A';
      const bgColor = i % 2 === 0 ? '#FCE4EC' : '#F8BBD9';

      return `
        <tr style="background: ${bgColor};">
          <td style="padding: 10px; border: 1px solid #E1BEE7;"><strong>${prod.producto}</strong></td>
          <td style="padding: 10px; border: 1px solid #E1BEE7; text-align: right;">Gs. ${impl.precioPromedioVendido?.toLocaleString() || 'N/A'}</td>
          <td style="padding: 10px; border: 1px solid #E1BEE7; text-align: center; font-weight: bold;">${impl.porcentajeVsMediana || 'N/A'}</td>
          <td style="padding: 10px; border: 1px solid #E1BEE7; text-align: center;">
            <span style="background: ${evalColor}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 12px;">
              ${evalLabel}
            </span>
          </td>
          <td style="padding: 10px; border: 1px solid #E1BEE7; text-align: right;">${impl.cantidadVendida?.toLocaleString() || 'N/A'}</td>
        </tr>
      `;
    }).join('');

    productsTableHtml = `
      <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
        <tr style="background: #CE93D8; color: white;">
          <th style="padding: 10px; border: 1px solid #BA68C8; text-align: left;">Producto</th>
          <th style="padding: 10px; border: 1px solid #BA68C8; text-align: right;">Precio Vendido</th>
          <th style="padding: 10px; border: 1px solid #BA68C8; text-align: center;">% Mediana</th>
          <th style="padding: 10px; border: 1px solid #BA68C8; text-align: center;">Evaluación</th>
          <th style="padding: 10px; border: 1px solid #BA68C8; text-align: right;">Cantidad</th>
        </tr>
        ${rows}
      </table>
    `;
  }

  // Build destacados section
  const destacadosHtml = analysis.analisisImplementacion.productosDestacados?.length > 0 ? `
    <div style="flex: 1; min-width: 250px; background: #E8F5E9; border-radius: 8px; padding: 15px; border-left: 4px solid #4CAF50;">
      <h4 style="color: #2E7D32; margin: 0 0 10px;">🌟 Productos Destacados</h4>
      <ul style="margin: 0; padding-left: 20px; color: #1B5E20;">
        ${analysis.analisisImplementacion.productosDestacados.map(p => `<li style="margin: 5px 0;">${p}</li>`).join('')}
      </ul>
    </div>
  ` : '';

  // Build mejorar section
  const mejorarHtml = analysis.analisisImplementacion.productosMejorar?.length > 0 ? `
    <div style="flex: 1; min-width: 250px; background: #FFF3E0; border-radius: 8px; padding: 15px; border-left: 4px solid #FF9800;">
      <h4 style="color: #E65100; margin: 0 0 10px;">📌 Oportunidades de Mejora</h4>
      <ul style="margin: 0; padding-left: 20px; color: #BF360C;">
        ${analysis.analisisImplementacion.productosMejorar.map(p => `<li style="margin: 5px 0;">${p}</li>`).join('')}
      </ul>
    </div>
  ` : '';

  // Build acciones section
  const accionesHtml = analysis.analisisImplementacion.accionesSugeridas?.length > 0 ? `
    <div style="margin-top: 20px; background: white; border-radius: 8px; padding: 15px; border: 2px solid #9C27B0;">
      <h4 style="color: #7B1FA2; margin: 0 0 10px;">🎯 Acciones Sugeridas</h4>
      <ol style="margin: 0; padding-left: 25px; color: #4A148C;">
        ${analysis.analisisImplementacion.accionesSugeridas.map(a => `<li style="margin: 8px 0;">${a}</li>`).join('')}
      </ol>
    </div>
  ` : '';

  return `
  <div style="margin-top: 30px; border: 2px solid #9C27B0; border-radius: 12px; overflow: hidden;">
    <div style="background: linear-gradient(135deg, #7B1FA2, #9C27B0); color: white; padding: 20px;">
      <h2 style="margin: 0; font-size: 22px;">📈 Análisis de Implementación de Estrategia</h2>
      <p style="margin: 5px 0 0; opacity: 0.9; font-size: 14px;">Comparación Ventas HidroBio vs Precios de Mercado</p>
    </div>
    <div style="padding: 20px; background: #F3E5F5;">
      ${analysis.analisisImplementacion.resumen ? `
      <p style="font-size: 15px; color: #4A148C; margin-bottom: 20px; line-height: 1.6;">
        ${analysis.analisisImplementacion.resumen}
      </p>
      ` : ''}

      ${productsTableHtml}

      <div style="display: flex; flex-wrap: wrap; gap: 20px;">
        ${destacadosHtml}
        ${mejorarHtml}
      </div>

      ${accionesHtml}
    </div>
  </div>
  `;
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
          <td style="padding: 8px; border: 1px solid #ddd;">${p.product_name_raw || p.product || 'N/A'}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: right; font-weight: bold;">${(p.price_guaranies || p.price || 0).toLocaleString()}</td>
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

        <h4 style="color: #2E7D32; margin: 15px 0 10px;">💰 BANDAS DE PRECIOS B2B (Negociación)</h4>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr style="background: #E8F5E9;">
            <th style="padding: 8px; border: 1px solid #C8E6C9; text-align: left;">Segmento</th>
            <th style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #D32F2F;">Mínimo</th>
            <th style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #2E7D32; font-weight: bold;">Meta</th>
            <th style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #1565C0;">Máximo</th>
            <th style="padding: 8px; border: 1px solid #C8E6C9; text-align: center;">Margen</th>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #C8E6C9;">⭐⭐⭐⭐⭐ Consumidor Final</td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #D32F2F;">
              ${(precios.consumidorFinal?.precioMinimo || precios.consumidorFinal?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; font-weight: bold; background: #E8F5E9;">
              ${(precios.consumidorFinal?.precioMeta || precios.consumidorFinal?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #1565C0;">
              ${(precios.consumidorFinal?.precioMaximo || precios.consumidorFinal?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center;">
              ${precios.consumidorFinal?.margen || 'N/A'}
            </td>
          </tr>
          <tr style="background: #FAFAFA;">
            <td style="padding: 8px; border: 1px solid #C8E6C9;">⭐⭐⭐⭐ HORECA</td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #D32F2F;">
              ${(precios.horeca?.precioMinimo || precios.horeca?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; font-weight: bold; background: #E8F5E9;">
              ${(precios.horeca?.precioMeta || precios.horeca?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #1565C0;">
              ${(precios.horeca?.precioMaximo || precios.horeca?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center;">
              ${precios.horeca?.margen || 'N/A'}
            </td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #C8E6C9;">⭐⭐⭐ Supermercados</td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #D32F2F;">
              ${(precios.supermercados?.precioMinimo || precios.supermercados?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; font-weight: bold; background: #E8F5E9;">
              ${(precios.supermercados?.precioMeta || precios.supermercados?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #1565C0;">
              ${(precios.supermercados?.precioMaximo || precios.supermercados?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center;">
              ${precios.supermercados?.margen || 'N/A'}
            </td>
          </tr>
          <tr style="background: #FAFAFA;">
            <td style="padding: 8px; border: 1px solid #C8E6C9;">⭐⭐ Institucional</td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #D32F2F;">
              ${(precios.institucional?.precioMinimo || precios.institucional?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; font-weight: bold; background: #E8F5E9;">
              ${(precios.institucional?.precioMeta || precios.institucional?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center; color: #1565C0;">
              ${(precios.institucional?.precioMaximo || precios.institucional?.precio)?.toLocaleString() || 'N/A'}
            </td>
            <td style="padding: 8px; border: 1px solid #C8E6C9; text-align: center;">
              ${precios.institucional?.margen || 'N/A'}
            </td>
          </tr>
        </table>
        <p style="font-size: 11px; color: #666; margin-top: 5px;">
          <strong>Rojo</strong> = Precio mínimo (walk-away) | <strong>Verde</strong> = Precio meta (inicial) | <strong>Azul</strong> = Precio máximo (premium)
        </p>

        ${prod.comentario ? `
        <div style="background: #E3F2FD; padding: 10px; margin-top: 15px; border-radius: 4px;">
          💡 <em>${prod.comentario}</em>
        </div>
        ` : ''}

        ${prod.implementacionEstrategia?.tieneVentas ? `
        <div style="margin-top: 15px; border: 1px solid #9C27B0; border-radius: 8px; overflow: hidden;">
          <div style="background: #9C27B0; color: white; padding: 8px 12px; font-size: 13px;">
            📈 Ventas HidroBio (última semana)
          </div>
          <div style="padding: 12px; background: #F3E5F5;">
            <div style="display: flex; flex-wrap: wrap; gap: 15px;">
              <div style="flex: 1; min-width: 100px;">
                <div style="color: #7B1FA2; font-size: 11px; font-weight: bold;">PRECIO PROMEDIO</div>
                <div style="font-size: 18px; font-weight: bold;">Gs. ${prod.implementacionEstrategia.precioPromedioVendido?.toLocaleString() || 'N/A'}</div>
              </div>
              <div style="flex: 1; min-width: 100px;">
                <div style="color: #7B1FA2; font-size: 11px; font-weight: bold;">% DE MEDIANA</div>
                <div style="font-size: 18px; font-weight: bold;">${prod.implementacionEstrategia.porcentajeVsMediana || 'N/A'}</div>
              </div>
              <div style="flex: 1; min-width: 100px;">
                <div style="color: #7B1FA2; font-size: 11px; font-weight: bold;">CANTIDAD</div>
                <div style="font-size: 18px; font-weight: bold;">${prod.implementacionEstrategia.cantidadVendida?.toLocaleString() || 'N/A'}</div>
              </div>
              <div style="flex: 1; min-width: 100px;">
                <div style="color: #7B1FA2; font-size: 11px; font-weight: bold;">EVALUACIÓN</div>
                <div style="font-size: 16px; font-weight: bold; padding: 2px 8px; border-radius: 4px; display: inline-block; ${
                  prod.implementacionEstrategia.evaluacion === 'excelente' ? 'background: #4CAF50; color: white;' :
                  prod.implementacionEstrategia.evaluacion === 'bueno' ? 'background: #8BC34A; color: white;' :
                  prod.implementacionEstrategia.evaluacion === 'aceptable' ? 'background: #FFC107; color: #333;' :
                  prod.implementacionEstrategia.evaluacion === 'bajo' ? 'background: #FF9800; color: white;' :
                  prod.implementacionEstrategia.evaluacion === 'critico' ? 'background: #F44336; color: white;' :
                  'background: #9E9E9E; color: white;'
                }">
                  ${prod.implementacionEstrategia.evaluacion === 'excelente' ? '⭐ Excelente' :
                    prod.implementacionEstrategia.evaluacion === 'bueno' ? '✅ Bueno' :
                    prod.implementacionEstrategia.evaluacion === 'aceptable' ? '➖ Aceptable' :
                    prod.implementacionEstrategia.evaluacion === 'bajo' ? '⚠️ Bajo' :
                    prod.implementacionEstrategia.evaluacion === 'critico' ? '🔴 Crítico' :
                    prod.implementacionEstrategia.evaluacion || 'N/A'}
                </div>
              </div>
            </div>
            ${prod.implementacionEstrategia.comentarioImplementacion ? `
            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #CE93D8; font-size: 13px; color: #6A1B9A;">
              ${prod.implementacionEstrategia.comentarioImplementacion}
            </div>
            ` : ''}
          </div>
        </div>
        ` : `
        <div style="margin-top: 15px; background: #ECEFF1; padding: 10px; border-radius: 4px; color: #607D8B; font-size: 13px;">
          📊 Sin datos de ventas esta semana
        </div>
        `}

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
    <p style="margin: 5px 0 0; font-size: 16px; opacity: 0.9;">Inteligencia de Precios - HidroBio</p>
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

  <!-- Strategy Implementation Analysis -->
  ${generateStrategyImplementationHtml(analysis)}

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
      🌿 Generado por <strong>Aurelio</strong> - Inteligencia de Precios<br>
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

/**
 * Run Aurelio in scrape-only mode (daily at 05:00)
 * Just collects prices and saves to DB, alerts on errors
 */
async function runScrapingOnly() {
  loadEnvCredentials();

  console.log('\n' + '📊'.repeat(40));
  console.log(`\n  AURELIO - Recolección Diaria de Precios`);
  console.log(`  HidroBio S.A. | ${new Date().toLocaleString('es-PY')}`);
  console.log('\n' + '📊'.repeat(40) + '\n');

  const db = new PriceDatabase();
  let errorCount = 0;
  const allPrices = [];

  try {
    console.log('[Aurelio] 📡 Recolectando precios del mercado...');

    for (const supermarket of CONFIG.supermarkets) {
      if (!supermarket.enabled) continue;

      console.log(`[Aurelio]   → Escaneando ${supermarket.name}...`);
      const scraper = SCRAPERS[supermarket.scraper];

      if (!scraper) {
        console.log(`[Aurelio]   ⚠️ No hay scraper para ${supermarket.name}`);
        errorCount++;
        continue;
      }

      for (const product of CONFIG.products) {
        for (const term of product.searchTerms) {
          try {
            const results = await scraper(supermarket, term);
            for (const result of results) {
              // Use exclude terms to prevent cross-contamination between products
              if (productMatches(result.name, term, product.excludeTerms)) {
                const isDupe = allPrices.some(p =>
                  p.supermarket === result.supermarket &&
                  p.name === result.name &&
                  p.product === product.name
                );
                if (!isDupe) {
                  allPrices.push({ ...result, product: product.name, unit: product.unit });
                }
              }
            }
          } catch (error) {
            console.error(`[Aurelio]   ❌ Error "${term}" en ${supermarket.name}:`, error.message);
            errorCount++;
          }
        }
      }
    }

    console.log(`[Aurelio] ✅ Recolectados ${allPrices.length} precios`);

    // Save to database
    console.log('[Aurelio] 💾 Guardando en base de datos...');
    for (const price of allPrices) {
      db.savePrice(price.supermarket, price.product, price.price, price.name, price.unit);
    }

    // Sync to Zoho Analytics
    console.log('[Aurelio] ☁️ Sincronizando con Zoho Analytics...');
    await syncToZohoAnalytics(db);

    // Alert if errors occurred
    if (errorCount > 0) {
      console.log(`[Aurelio] ⚠️ ${errorCount} errores durante recolección`);
      db.saveAlert('scraping', `${errorCount} errores durante recolección diaria`, 'warning');
      await sendErrorAlert(errorCount, allPrices.length);
    }

    console.log(`\n[Aurelio] ✅ Recolección diaria completada (${allPrices.length} precios)\n`);

  } catch (error) {
    console.error('[Aurelio] ❌ Error crítico en recolección:', error);
    db.saveAlert('system', `Error crítico: ${error.message}`, 'error');
    await sendErrorAlert(1, 0, error.message);
  } finally {
    db.close();
  }
}

/**
 * Send error alert email when scraping fails
 */
async function sendErrorAlert(errorCount, pricesCollected, criticalError = null) {
  const credentials = loadZohoCredentials();
  if (!credentials.ZOHO_SMTP_USER || !credentials.ZOHO_SMTP_PASSWORD) return;

  const transporter = nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: { user: credentials.ZOHO_SMTP_USER, password: credentials.ZOHO_SMTP_PASSWORD }
  });

  const subject = criticalError
    ? `🚨 [Aurelio] ERROR CRÍTICO - ${new Date().toLocaleDateString('es-PY')}`
    : `⚠️ [Aurelio] Alertas en Recolección - ${new Date().toLocaleDateString('es-PY')}`;

  const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2 style="color: ${criticalError ? '#dc3545' : '#ffc107'};">${criticalError ? '🚨 Error Crítico' : '⚠️ Alertas de Recolección'}</h2>
      <p><strong>Fecha:</strong> ${new Date().toLocaleString('es-PY')}</p>
      ${criticalError ? `<p><strong>Error:</strong> ${criticalError}</p>` : ''}
      <p><strong>Errores encontrados:</strong> ${errorCount}</p>
      <p><strong>Precios recolectados:</strong> ${pricesCollected}</p>
      <hr>
      <p style="color: #666; font-size: 12px;">Aurelio - Inteligencia de Precios | HidroBio S.A.</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"Aurelio - HidroBio" <${credentials.EMAIL_FROM || credentials.ZOHO_SMTP_USER}>`,
      to: credentials.EMAIL_TO || 'daniel@hidrobio.com.py',
      subject,
      html
    });
    console.log('[Aurelio] 📧 Alerta enviada por email');
  } catch (error) {
    console.error('[Aurelio] ❌ Error enviando alerta:', error.message);
  }
}

/**
 * Run Aurelio full analysis mode (weekly Thursday 15:00)
 * Scrapes, analyzes, compares with sales, and sends full report
 */
async function runAurelio() {
  // Load credentials from .env file
  loadEnvCredentials();

  console.log('\n' + '🌿'.repeat(40));
  console.log(`\n  AURELIO - Análisis Semanal de Precios`);
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
              // Match against target product using improved matching with exclusions
              if (productMatches(result.name, term, product.excludeTerms)) {
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

    // Save full weekly report for dashboard
    const supermarkets = [...new Set(todayPrices.map(p => p.supermarket))];
    const products = [...new Set(todayPrices.map(p => p.product))];
    db.saveWeeklyReport(
      analysis,
      todayPrices.length,
      supermarkets.length,
      products.length
    );
    console.log('[Aurelio] 💾 Reporte semanal guardado para dashboard');

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

/**
 * Calculate next scheduled run time
 * Returns { type: 'daily'|'weekly', time: Date }
 */
function getNextScheduledRun() {
  const now = new Date();
  const dailyConfig = CONFIG.schedule.dailyScrape;
  const weeklyConfig = CONFIG.schedule.weeklyAnalysis;

  // Calculate next daily scrape (05:00 every day)
  let nextDaily = new Date(now);
  nextDaily.setHours(dailyConfig.hour, dailyConfig.minute, 0, 0);
  if (now >= nextDaily) {
    nextDaily.setDate(nextDaily.getDate() + 1);
  }

  // Calculate next weekly analysis (Thursday 15:00)
  let nextWeekly = new Date(now);
  nextWeekly.setHours(weeklyConfig.hour, weeklyConfig.minute, 0, 0);

  // Find next Thursday
  const daysUntilThursday = (weeklyConfig.dayOfWeek - now.getDay() + 7) % 7;
  if (daysUntilThursday === 0 && now >= nextWeekly) {
    // It's Thursday but we've passed the time, schedule for next week
    nextWeekly.setDate(nextWeekly.getDate() + 7);
  } else {
    nextWeekly.setDate(nextWeekly.getDate() + daysUntilThursday);
  }

  // Return whichever is sooner
  if (nextDaily < nextWeekly) {
    return { type: 'daily', time: nextDaily };
  } else {
    return { type: 'weekly', time: nextWeekly };
  }
}

function scheduleNextRun() {
  const nextRun = getNextScheduledRun();
  const now = new Date();

  const msUntilRun = nextRun.time.getTime() - now.getTime();
  const hoursUntil = Math.floor(msUntilRun / (1000 * 60 * 60));
  const minutesUntil = Math.floor((msUntilRun % (1000 * 60 * 60)) / (1000 * 60));

  const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const dayName = dayNames[nextRun.time.getDay()];

  const typeLabel = nextRun.type === 'daily' ? '📊 Recolección Diaria' : '📧 Análisis Semanal + Email';

  console.log(`[Aurelio] ⏰ Próxima ejecución: ${typeLabel}`);
  console.log(`[Aurelio]    ${dayName}, ${nextRun.time.toLocaleString('es-PY')}`);
  console.log(`[Aurelio]    (en ${hoursUntil}h ${minutesUntil}m)`);

  setTimeout(async () => {
    if (nextRun.type === 'daily') {
      await runScrapingOnly();
    } else {
      await runAurelio();  // Full analysis + email
    }
    scheduleNextRun();  // Schedule the next run
  }, msUntilRun);
}

// =============================================================================
// TEAM REPORTS - For introducing Aurelio to the team
// =============================================================================

/**
 * Generate a daily summary report for the team
 * Shows: prices collected today, market snapshot, any alerts
 */
async function generateDailyTeamReport() {
  loadEnvCredentials();

  const db = new PriceDatabase();
  const date = new Date().toLocaleDateString('es-PY', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  try {
    const todayPrices = db.getTodayPrices();
    const alerts = db.getRecentAlerts(7); // Last 7 days

    // Group prices by product
    const pricesByProduct = {};
    for (const p of todayPrices) {
      if (!pricesByProduct[p.product]) {
        pricesByProduct[p.product] = [];
      }
      pricesByProduct[p.product].push(p);
    }

    // Calculate medians
    const productSummaries = [];
    for (const [product, prices] of Object.entries(pricesByProduct)) {
      const values = prices.map(p => p.price_guaranies).filter(v => v > 0).sort((a, b) => a - b);
      const median = values.length > 0 ? values[Math.floor(values.length / 2)] : 0;
      const min = values.length > 0 ? Math.min(...values) : 0;
      const max = values.length > 0 ? Math.max(...values) : 0;

      productSummaries.push({
        product,
        median,
        min,
        max,
        priceCount: prices.length,
        sources: [...new Set(prices.map(p => p.supermarket))]
      });
    }

    // Generate HTML email
    const html = generateDailyReportHtml(date, productSummaries, todayPrices, alerts);

    // Send email
    const subject = `📊 [Aurelio] Resumen Diario - ${date}`;
    await sendTeamEmail(subject, html);

    console.log(`[Aurelio] ✅ Reporte diario enviado para ${date}`);
    return { success: true, date, pricesCollected: todayPrices.length };

  } finally {
    db.close();
  }
}

/**
 * Generate HTML for daily team report
 */
function generateDailyReportHtml(date, productSummaries, todayPrices, alerts) {
  const pricesBySupermarket = {};
  for (const p of todayPrices) {
    if (!pricesBySupermarket[p.supermarket]) {
      pricesBySupermarket[p.supermarket] = [];
    }
    pricesBySupermarket[p.supermarket].push(p);
  }

  const productRows = productSummaries.map((p, i) => `
    <tr style="background: ${i % 2 === 0 ? '#F8FFF8' : '#FFFFFF'};">
      <td style="padding: 12px; border: 1px solid #C8E6C9; font-weight: bold;">${p.product}</td>
      <td style="padding: 12px; border: 1px solid #C8E6C9; text-align: right; font-size: 18px; color: #2E7D32;">
        Gs. ${p.median.toLocaleString()}
      </td>
      <td style="padding: 12px; border: 1px solid #C8E6C9; text-align: right; color: #666;">
        ${p.min.toLocaleString()} - ${p.max.toLocaleString()}
      </td>
      <td style="padding: 12px; border: 1px solid #C8E6C9; text-align: center;">${p.priceCount}</td>
      <td style="padding: 12px; border: 1px solid #C8E6C9; font-size: 12px; color: #666;">
        ${p.sources.join(', ')}
      </td>
    </tr>
  `).join('');

  const supermarketSections = Object.entries(pricesBySupermarket).map(([supermarket, prices]) => `
    <div style="margin-bottom: 20px;">
      <h4 style="color: #1565C0; margin: 0 0 10px;">🏪 ${supermarket}</h4>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tr style="background: #E3F2FD;">
          <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Producto</th>
          <th style="padding: 8px; border: 1px solid #ddd; text-align: right;">Precio</th>
          <th style="padding: 8px; border: 1px solid #ddd; text-align: center;">Unidad</th>
        </tr>
        ${prices.map(p => `
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd;">${p.product_name_raw || p.product}</td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: right; font-weight: bold;">
            Gs. ${(p.price_guaranies || p.price || 0).toLocaleString()}
          </td>
          <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${p.unit || 'kg'}</td>
        </tr>
        `).join('')}
      </table>
    </div>
  `).join('');

  const alertsHtml = alerts.length > 0 ? `
    <div style="background: #FFF3E0; border: 1px solid #FFB74D; border-radius: 8px; padding: 15px; margin-top: 20px;">
      <h3 style="color: #E65100; margin: 0 0 10px;">⚠️ Alertas Recientes</h3>
      <ul style="margin: 0; padding-left: 20px;">
        ${alerts.map(a => `<li style="margin: 5px 0;">${a.message} <span style="color: #999; font-size: 11px;">(${new Date(a.created_at).toLocaleDateString('es-PY')})</span></li>`).join('')}
      </ul>
    </div>
  ` : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px;">

  <!-- Header -->
  <div style="background: linear-gradient(135deg, #2E7D32, #4CAF50); color: white; padding: 25px; text-align: center; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; font-size: 24px;">📊 AURELIO - Resumen Diario</h1>
    <p style="margin: 5px 0 0; font-size: 14px; opacity: 0.9;">Inteligencia de Precios | HidroBio S.A.</p>
    <p style="margin: 15px 0 0; font-size: 13px; background: rgba(255,255,255,0.2); display: inline-block; padding: 5px 15px; border-radius: 20px;">
      📅 ${date}
    </p>
  </div>

  <!-- Quick Stats -->
  <div style="display: flex; flex-wrap: wrap; background: #E8F5E9; padding: 15px; border-radius: 0 0 12px 12px; margin-bottom: 20px;">
    <div style="flex: 1; min-width: 100px; text-align: center; padding: 10px;">
      <div style="font-size: 28px; font-weight: bold; color: #2E7D32;">${todayPrices.length}</div>
      <div style="font-size: 12px; color: #666;">Precios Recolectados</div>
    </div>
    <div style="flex: 1; min-width: 100px; text-align: center; padding: 10px;">
      <div style="font-size: 28px; font-weight: bold; color: #2E7D32;">${Object.keys(pricesBySupermarket).length}</div>
      <div style="font-size: 12px; color: #666;">Supermercados</div>
    </div>
    <div style="flex: 1; min-width: 100px; text-align: center; padding: 10px;">
      <div style="font-size: 28px; font-weight: bold; color: #2E7D32;">${productSummaries.length}</div>
      <div style="font-size: 12px; color: #666;">Productos</div>
    </div>
  </div>

  <!-- Market Snapshot -->
  <h2 style="color: #2E7D32; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; margin-top: 30px;">
    📈 Snapshot del Mercado
  </h2>
  <p style="color: #666; font-size: 14px; margin-bottom: 15px;">
    Precios medianos de supermercados en Asunción - actualizado hoy a las 05:00
  </p>

  <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
    <tr style="background: #4CAF50; color: white;">
      <th style="padding: 12px; border: 1px solid #2E7D32; text-align: left;">Producto</th>
      <th style="padding: 12px; border: 1px solid #2E7D32; text-align: right;">Mediana</th>
      <th style="padding: 12px; border: 1px solid #2E7D32; text-align: right;">Rango</th>
      <th style="padding: 12px; border: 1px solid #2E7D32; text-align: center;"># Precios</th>
      <th style="padding: 12px; border: 1px solid #2E7D32; text-align: left;">Fuentes</th>
    </tr>
    ${productRows}
  </table>

  ${alertsHtml}

  <!-- Raw Prices by Supermarket -->
  <div style="margin-top: 30px; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
    <div style="background: #1565C0; color: white; padding: 15px;">
      <h3 style="margin: 0;">🏪 Detalle por Supermercado</h3>
    </div>
    <div style="padding: 15px; background: #FAFAFA;">
      ${supermarketSections || '<p>No hay precios disponibles</p>'}
    </div>
  </div>

  <!-- Footer -->
  <div style="text-align: center; margin-top: 30px; padding: 20px; background: #F5F5F5; border-radius: 8px;">
    <p style="margin: 0; color: #666; font-size: 12px;">
      🌿 Generado por <strong>Aurelio</strong> - Inteligencia de Precios<br>
      <strong>HidroBio S.A.</strong> | Nueva Italia, Paraguay<br>
      <span style="color: #999;">${new Date().toLocaleString('es-PY')}</span>
    </p>
    <p style="margin: 10px 0 0; color: #999; font-size: 11px;">
      Este reporte se genera automáticamente todos los días a las 05:00 PYT
    </p>
  </div>

</body>
</html>
  `;
}

/**
 * Generate a comprehensive weekly report for the team
 * Shows: full analysis, pricing recommendations, sales comparison, trends
 */
async function generateWeeklyTeamReport() {
  loadEnvCredentials();

  const db = new PriceDatabase();
  const date = new Date().toLocaleDateString('es-PY', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  try {
    // Get today's prices
    const todayPrices = db.getTodayPrices();

    // Run full AI analysis
    console.log('[Aurelio] 🧠 Ejecutando análisis completo con IA...');
    const analysis = await analyzeWithClaude(db, todayPrices);

    // Generate the full weekly report (reuse existing function)
    await sendEmailReport(analysis, todayPrices);

    console.log(`[Aurelio] ✅ Reporte semanal enviado para ${date}`);
    return { success: true, date, analysis };

  } finally {
    db.close();
  }
}

/**
 * Generate an introduction email to present Aurelio to the team
 */
async function sendAurelioIntroduction() {
  loadEnvCredentials();

  const db = new PriceDatabase();
  const date = new Date().toLocaleDateString('es-PY', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  try {
    const todayPrices = db.getTodayPrices();

    // Group prices by product for stats
    const pricesByProduct = {};
    for (const p of todayPrices) {
      if (!pricesByProduct[p.product]) {
        pricesByProduct[p.product] = [];
      }
      pricesByProduct[p.product].push(p);
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px;">

  <!-- Header with Avatar -->
  <div style="background: linear-gradient(135deg, #1B5E20, #2E7D32, #4CAF50); color: white; padding: 40px; text-align: center; border-radius: 16px 16px 0 0;">
    <div style="width: 120px; height: 120px; background: white; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 20px rgba(0,0,0,0.2);">
      <span style="font-size: 60px;">🌿</span>
    </div>
    <h1 style="margin: 0; font-size: 32px; text-shadow: 2px 2px 4px rgba(0,0,0,0.2);">Hola, soy Aurelio</h1>
    <p style="margin: 10px 0 0; font-size: 18px; opacity: 0.95;">Tu nuevo especialista en inteligencia de precios</p>
  </div>

  <!-- Introduction -->
  <div style="background: #F1F8E9; padding: 30px; border-left: 4px solid #4CAF50;">
    <h2 style="color: #2E7D32; margin-top: 0;">👋 ¡Mucho gusto, equipo HidroBio!</h2>
    <p style="font-size: 16px; color: #333;">
      Mi nombre viene de <strong>Marco Aurelio</strong>, el emperador filósofo romano,
      conocido por su sabiduría, pensamiento estratégico y disciplina en el análisis.
    </p>
    <p style="font-size: 16px; color: #333;">
      A partir de hoy, estaré trabajando 24/7 para monitorear los precios del mercado
      y ayudarles a tomar decisiones estratégicas de pricing.
    </p>
  </div>

  <!-- What I Do -->
  <div style="padding: 30px 0;">
    <h2 style="color: #2E7D32; border-bottom: 2px solid #4CAF50; padding-bottom: 10px;">
      🎯 ¿Qué hago por ustedes?
    </h2>

    <div style="display: flex; flex-wrap: wrap; gap: 20px; margin-top: 20px;">
      <div style="flex: 1; min-width: 250px; background: white; border: 1px solid #C8E6C9; border-radius: 12px; padding: 20px;">
        <div style="font-size: 40px; margin-bottom: 10px;">📡</div>
        <h3 style="color: #2E7D32; margin: 0 0 10px;">Monitoreo Diario</h3>
        <p style="color: #666; margin: 0; font-size: 14px;">
          Todos los días a las <strong>05:00</strong> escaneo 4+ supermercados
          y recolecto precios de tomates, locotes y lechugas.
        </p>
      </div>

      <div style="flex: 1; min-width: 250px; background: white; border: 1px solid #C8E6C9; border-radius: 12px; padding: 20px;">
        <div style="font-size: 40px; margin-bottom: 10px;">🧠</div>
        <h3 style="color: #2E7D32; margin: 0 0 10px;">Análisis con IA</h3>
        <p style="color: #666; margin: 0; font-size: 14px;">
          Uso Claude (inteligencia artificial) para analizar tendencias,
          calcular medianas y generar recomendaciones estratégicas.
        </p>
      </div>

      <div style="flex: 1; min-width: 250px; background: white; border: 1px solid #C8E6C9; border-radius: 12px; padding: 20px;">
        <div style="font-size: 40px; margin-bottom: 10px;">💰</div>
        <h3 style="color: #2E7D32; margin: 0 0 10px;">Pricing por Segmento</h3>
        <p style="color: #666; margin: 0; font-size: 14px;">
          Genero bandas de precios B2B para cada segmento:
          Consumidor Final, HORECA, Supermercados e Institucional.
        </p>
      </div>

      <div style="flex: 1; min-width: 250px; background: white; border: 1px solid #C8E6C9; border-radius: 12px; padding: 20px;">
        <div style="font-size: 40px; margin-bottom: 10px;">📧</div>
        <h3 style="color: #2E7D32; margin: 0 0 10px;">Reportes Semanales</h3>
        <p style="color: #666; margin: 0; font-size: 14px;">
          Cada <strong>jueves a las 15:00</strong> envío un reporte completo
          con análisis, recomendaciones y comparación de ventas.
        </p>
      </div>
    </div>
  </div>

  <!-- Pricing Strategy -->
  <div style="background: #E8F5E9; border-radius: 12px; padding: 25px; margin: 20px 0;">
    <h2 style="color: #2E7D32; margin-top: 0;">📊 Mi Estrategia de Precios</h2>
    <p style="color: #555; font-size: 15px;">
      Aplico la filosofía de <strong>"% de mediana del mercado"</strong> - no cost-plus.
      HidroBio debe posicionarse como premium pero competitivo:
    </p>

    <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px;">
      <tr style="background: #4CAF50; color: white;">
        <th style="padding: 10px; border: 1px solid #2E7D32;">Segmento</th>
        <th style="padding: 10px; border: 1px solid #2E7D32;">% Mediana</th>
        <th style="padding: 10px; border: 1px solid #2E7D32;">Margen Mín.</th>
        <th style="padding: 10px; border: 1px solid #2E7D32;">Estrategia</th>
      </tr>
      <tr style="background: #F8FFF8;">
        <td style="padding: 10px; border: 1px solid #C8E6C9;">⭐⭐⭐⭐⭐ Consumidor Final</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">85-95%</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">25%</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9;">Mejor margen directo</td>
      </tr>
      <tr>
        <td style="padding: 10px; border: 1px solid #C8E6C9;">⭐⭐⭐⭐ HORECA</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">70-80%</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">20%</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9;">Volumen consistente</td>
      </tr>
      <tr style="background: #F8FFF8;">
        <td style="padding: 10px; border: 1px solid #C8E6C9;">⭐⭐⭐ Supermercados</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">60-75%</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">15%</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9;">Volumen alto</td>
      </tr>
      <tr>
        <td style="padding: 10px; border: 1px solid #C8E6C9;">⭐⭐ Institucional</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">55-65%</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9; text-align: center;">10%</td>
        <td style="padding: 10px; border: 1px solid #C8E6C9;">Contratos anuales</td>
      </tr>
      <tr style="background: #FFF3E0;">
        <td style="padding: 10px; border: 1px solid #FFB74D;">⚠️ Mayorista</td>
        <td style="padding: 10px; border: 1px solid #FFB74D; text-align: center;">45-55%</td>
        <td style="padding: 10px; border: 1px solid #FFB74D; text-align: center;">5%</td>
        <td style="padding: 10px; border: 1px solid #FFB74D; color: #E65100; font-weight: bold;">EVITAR</td>
      </tr>
    </table>

    <div style="background: #FFF9C4; border-left: 4px solid #FBC02D; padding: 15px; margin-top: 20px; border-radius: 4px;">
      <strong style="color: #F57F17;">⚠️ Regla de Oro:</strong>
      <span style="color: #555;">El <strong>Piso Absoluto</strong> es sagrado - nunca recomiendo vender por debajo del costo + margen mínimo.</span>
    </div>
  </div>

  <!-- Current Status -->
  <div style="padding: 25px 0;">
    <h2 style="color: #2E7D32; border-bottom: 2px solid #4CAF50; padding-bottom: 10px;">
      📈 Estado Actual del Sistema
    </h2>

    <div style="display: flex; flex-wrap: wrap; background: #E8F5E9; padding: 20px; border-radius: 12px; margin-top: 15px;">
      <div style="flex: 1; min-width: 120px; text-align: center; padding: 15px;">
        <div style="font-size: 36px; font-weight: bold; color: #2E7D32;">${todayPrices.length}</div>
        <div style="font-size: 13px; color: #666;">Precios en BD Hoy</div>
      </div>
      <div style="flex: 1; min-width: 120px; text-align: center; padding: 15px;">
        <div style="font-size: 36px; font-weight: bold; color: #2E7D32;">${Object.keys(pricesByProduct).length}</div>
        <div style="font-size: 13px; color: #666;">Productos Monitoreados</div>
      </div>
      <div style="flex: 1; min-width: 120px; text-align: center; padding: 15px;">
        <div style="font-size: 36px; font-weight: bold; color: #2E7D32;">4</div>
        <div style="font-size: 13px; color: #666;">Supermercados</div>
      </div>
      <div style="flex: 1; min-width: 120px; text-align: center; padding: 15px;">
        <div style="font-size: 36px; font-weight: bold; color: #4CAF50;">✓</div>
        <div style="font-size: 13px; color: #666;">Sistema Operativo</div>
      </div>
    </div>
  </div>

  <!-- Schedule -->
  <div style="background: white; border: 2px solid #4CAF50; border-radius: 12px; padding: 25px; margin: 20px 0;">
    <h2 style="color: #2E7D32; margin-top: 0;">📅 Mi Horario de Trabajo</h2>

    <div style="display: flex; flex-wrap: wrap; gap: 20px;">
      <div style="flex: 1; min-width: 200px;">
        <div style="background: #E3F2FD; padding: 15px; border-radius: 8px; border-left: 4px solid #1565C0;">
          <h4 style="color: #1565C0; margin: 0 0 5px;">📊 Recolección Diaria</h4>
          <p style="margin: 0; font-size: 14px; color: #333;">
            <strong>Todos los días - 05:00 PYT</strong><br>
            Escaneo supermercados, guardo precios, sincronizo con Zoho Analytics
          </p>
        </div>
      </div>
      <div style="flex: 1; min-width: 200px;">
        <div style="background: #F3E5F5; padding: 15px; border-radius: 8px; border-left: 4px solid #7B1FA2;">
          <h4 style="color: #7B1FA2; margin: 0 0 5px;">📧 Análisis Semanal</h4>
          <p style="margin: 0; font-size: 14px; color: #333;">
            <strong>Jueves - 15:00 PYT</strong><br>
            Análisis completo con IA, comparación de ventas, reporte por email
          </p>
        </div>
      </div>
    </div>
  </div>

  <!-- Contact -->
  <div style="background: #FAFAFA; border-radius: 12px; padding: 25px; margin: 20px 0; text-align: center;">
    <h2 style="color: #2E7D32; margin-top: 0;">💬 ¿Preguntas?</h2>
    <p style="color: #666; font-size: 15px; margin-bottom: 20px;">
      Si tienen dudas sobre mis reportes o quieren ajustar la estrategia de precios,
      contacten a Daniel Stanca quien puede reconfigurar mis parámetros.
    </p>
    <p style="margin: 0; color: #999; font-size: 13px;">
      daniel.stanca@hidrobio.com.py
    </p>
  </div>

  <!-- Footer -->
  <div style="text-align: center; margin-top: 30px; padding: 25px; background: linear-gradient(135deg, #2E7D32, #4CAF50); border-radius: 12px; color: white;">
    <p style="margin: 0; font-size: 18px; font-weight: bold;">
      ¡Estoy listo para trabajar! 🌿
    </p>
    <p style="margin: 10px 0 0; font-size: 14px; opacity: 0.9;">
      <strong>Aurelio</strong> - Inteligencia de Precios | HidroBio S.A.<br>
      ${date}
    </p>
  </div>

</body>
</html>
    `;

    const subject = `🌿 ¡Hola Equipo! Soy Aurelio, su nuevo especialista en precios`;
    await sendTeamEmail(subject, html);

    console.log('[Aurelio] ✅ Email de introducción enviado al equipo');
    return { success: true };

  } finally {
    db.close();
  }
}

/**
 * Helper function to send team emails
 */
async function sendTeamEmail(subject, htmlContent) {
  const credentials = loadZohoCredentials();
  const smtpUser = credentials.ZOHO_SMTP_USER || process.env.SMTP_USER;
  const smtpPassword = credentials.ZOHO_SMTP_PASSWORD || process.env.SMTP_PASSWORD;
  const emailTo = credentials.EMAIL_TO || process.env.EMAIL_TO || 'daniel@hidrobio.com.py';
  const emailFrom = credentials.EMAIL_FROM || process.env.EMAIL_FROM || smtpUser;

  console.log(`[Aurelio] 📧 Preparando email...`);
  console.log(`[Aurelio]    De: ${emailFrom}`);
  console.log(`[Aurelio]    Para: ${emailTo}`);
  console.log(`[Aurelio]    Asunto: ${subject}`);

  if (!smtpUser || !smtpPassword) {
    console.log('[Aurelio] ⚠️ Email no configurado - imprimiendo a consola');
    console.log(`Subject: ${subject}`);
    console.log('HTML content generated (use --intro with email config to send)');
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.zoho.com',
      port: 465,
      secure: true,
      auth: { user: smtpUser, pass: smtpPassword },
      tls: { rejectUnauthorized: false }
    });

    console.log(`[Aurelio] 🔗 Conectando a smtp.zoho.com:465...`);

    const info = await transporter.sendMail({
      from: `"Aurelio - HidroBio" <${emailFrom}>`,
      to: emailTo,
      subject: subject,
      html: htmlContent
    });

    console.log(`[Aurelio] ✅ Email enviado! Message ID: ${info.messageId}`);
    console.log(`[Aurelio]    Response: ${info.response}`);
    return true;

  } catch (error) {
    console.error(`[Aurelio] ❌ Error enviando email: ${error.message}`);
    console.error(`[Aurelio]    Stack: ${error.stack}`);
    return false;
  }
}

// =============================================================================
// ENTRY POINT
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
AURELIO - Inteligencia de Precios | HidroBio S.A.

Uso: node aurelio.mjs [opción]

Opciones:
  --now, -n        Ejecutar análisis completo ahora (scrape + análisis + email)
  --scrape         Solo recolectar precios (sin análisis ni email)
  --schedule, -s   Modo programado (05:00 diario, jueves 15:00 análisis)
  --daemon, -d     Modo daemon para Railway (programado + heartbeat)
  --help, -h       Mostrar esta ayuda

Reportes para el equipo:
  --intro          Enviar email de introducción al equipo (presenta a Aurelio)
  --daily-report   Generar y enviar reporte diario (snapshot del mercado)
  --weekly-report  Generar y enviar reporte semanal completo (análisis + recomendaciones)

Programación:
  - Diario 05:00 PYT: Recolección de precios (alerta si hay errores)
  - Jueves 15:00 PYT: Análisis semanal completo + comparación ventas + email
`);
    return;
  }

  // Team report commands
  if (args.includes('--intro')) {
    console.log('[Aurelio] Modo: Enviar introducción al equipo');
    await sendAurelioIntroduction();
    return;
  }

  if (args.includes('--daily-report')) {
    console.log('[Aurelio] Modo: Generar reporte diario');
    await generateDailyTeamReport();
    return;
  }

  if (args.includes('--weekly-report')) {
    console.log('[Aurelio] Modo: Generar reporte semanal');
    await generateWeeklyTeamReport();
    return;
  }

  if (args.includes('--now') || args.includes('-n')) {
    // Run full analysis immediately
    console.log('[Aurelio] Modo: Análisis completo inmediato');
    await runAurelio();

  } else if (args.includes('--scrape')) {
    // Scrape only mode
    console.log('[Aurelio] Modo: Solo recolección de precios');
    await runScrapingOnly();

  } else if (args.includes('--schedule') || args.includes('-s')) {
    // Run with scheduler
    console.log('[Aurelio] Modo: Programado');
    console.log('[Aurelio]   📊 Diario 05:00 PYT - Recolección de precios');
    console.log('[Aurelio]   📧 Jueves 15:00 PYT - Análisis semanal + email');
    console.log('[Aurelio] Ejecutando recolección inicial...');
    await runScrapingOnly();
    scheduleNextRun();
    console.log('[Aurelio] 🟢 Agente en ejecución continua. Ctrl+C para detener.');

  } else if (args.includes('--daemon') || args.includes('-d')) {
    // Daemon mode for Railway
    console.log('[Aurelio] Modo: Daemon (Railway)');
    console.log('[Aurelio]   📊 Diario 05:00 PYT - Recolección de precios');
    console.log('[Aurelio]   📧 Jueves 15:00 PYT - Análisis semanal + email');

    // Check if today is Thursday around analysis time
    const now = new Date();
    const isThursday = now.getDay() === 4;
    const isAfternoon = now.getHours() >= 14 && now.getHours() <= 16;

    if (isThursday && isAfternoon) {
      console.log('[Aurelio] Es jueves por la tarde - ejecutando análisis completo...');
      await runAurelio();
    } else {
      console.log('[Aurelio] Ejecutando recolección inicial...');
      await runScrapingOnly();
    }

    scheduleNextRun();

    // Keep alive with heartbeat
    setInterval(() => {
      console.log(`[Aurelio] 💓 Heartbeat - ${new Date().toLocaleString('es-PY')}`);
    }, 3600000);  // Every hour

  } else {
    // Default: run full analysis once
    console.log('[Aurelio] Modo: Ejecución única (análisis completo)');
    await runAurelio();
  }
}

main().catch(console.error);
