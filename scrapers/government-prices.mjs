/**
 * SIMA/DAMA Government Price Scraper
 *
 * Scrapes wholesale market prices from Paraguay government sources:
 * - SIMA (Servicio de Informacion de Mercados Agropecuarios) - mag.gov.py
 * - DAMA (Direccion de Abastecimiento) - Mercado de Abasto Asuncion
 * - CECOPROA (Centro de Comercializacion para Productores Asociados)
 *
 * These prices represent wholesale market conditions that affect
 * supermarkets' willingness to pay for HidroBio products.
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// Products we're tracking (matching aurelio CONFIG)
const TRACKED_PRODUCTS = {
  'tomate lisa': { unit: 'kg', aliases: ['tomate holandes', 'tomate redondo'] },
  'tomate perita': { unit: 'kg', aliases: ['tomate santa cruz', 'tomate pera'] },
  'tomate cherry': { unit: 'kg', aliases: [] },
  'locote rojo': { unit: 'kg', aliases: ['pimiento rojo', 'morron rojo'] },
  'locote amarillo': { unit: 'kg', aliases: ['pimiento amarillo', 'morron amarillo'] },
  'lechuga pirati': { unit: 'docena', aliases: ['lechuga crespa'] },
  'verdeos': { unit: 'docena', aliases: ['cebollita de hoja', 'perejil', 'cilantro'] }
};

// Unit conversion factors to normalize to per-kg or per-unit
const UNIT_CONVERSIONS = {
  'caja 20kg': (price) => Math.round(price / 20),
  'caja/carton 20kg': (price) => Math.round(price / 20),
  'caja 18kg': (price) => Math.round(price / 18),
  'caja madera 18kg': (price) => Math.round(price / 18),
  'bolsa 25kg': (price) => Math.round(price / 25),
  'docena': (price) => price,  // Keep as-is for lettuce/verdeos
  'kg': (price) => price,
  'kilo': (price) => price
};

/**
 * Attempt to scrape SIMA prices from mag.gov.py
 * The SIMA publishes daily wholesale price bulletins
 */
export async function scrapeSIMA() {
  console.log('[SIMA] Attempting to scrape from mag.gov.py...');

  const results = [];

  try {
    // Try the main MAG website SIMA section
    const urls = [
      'https://www.mag.gov.py/precios-sima',
      'http://simadcmag.50webs.com/',  // Legacy SIMA site
      'https://www.mag.gov.py/index.php/institucion/dependencias/dc/sima'
    ];

    for (const url of urls) {
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

            // Check if this matches a tracked product
            for (const [product, config] of Object.entries(TRACKED_PRODUCTS)) {
              const allNames = [product, ...config.aliases];
              if (allNames.some(name => productText.includes(name))) {
                // Extract numeric price
                const priceMatch = priceText.replace(/\./g, '').match(/(\d+)/);
                if (priceMatch) {
                  results.push({
                    source: 'SIMA',
                    product: product,
                    rawName: productText,
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
          console.log(`[SIMA] Found ${results.length} prices from ${url}`);
          break;  // Stop if we found prices
        }
      } catch (urlError) {
        console.log(`[SIMA] Could not fetch ${url}: ${urlError.message}`);
      }
    }

  } catch (error) {
    console.error('[SIMA] Scrape error:', error.message);
  }

  return results;
}

/**
 * Query DAMA prices from Paraguay Open Data portal
 * Uses CKAN API at datos.gov.py
 */
export async function scrapeDAMA() {
  console.log('[DAMA] Querying datos.gov.py Open Data portal...');

  const results = [];

  try {
    // CKAN API endpoint for DAMA wholesale prices
    // Dataset: "Precios Promedios de Ventas a Nivel Mayorista"
    const ckanUrl = 'https://datos.gov.py/api/3/action/datastore_search';

    // Try known resource IDs for DAMA data
    const resourceIds = [
      // These IDs would need to be discovered from the portal
      // Search at: https://datos.gov.py/dataset?q=abasto+precios
    ];

    for (const resourceId of resourceIds) {
      try {
        const response = await fetch(`${ckanUrl}?resource_id=${resourceId}&limit=100`, {
          timeout: 15000
        });

        if (!response.ok) continue;

        const data = await response.json();
        if (data.success && data.result?.records) {
          for (const record of data.result.records) {
            // Map CKAN fields to our format
            const productName = (record.PRODUCTO || record.producto || '').toLowerCase();

            for (const [product, config] of Object.entries(TRACKED_PRODUCTS)) {
              const allNames = [product, ...config.aliases];
              if (allNames.some(name => productName.includes(name))) {
                const price = parseInt(record.PRECIO || record.precio || record.PROMEDIO || 0);
                if (price > 0) {
                  results.push({
                    source: 'DAMA',
                    product: product,
                    rawName: productName,
                    price: price,
                    unit: record.UNIDAD || config.unit,
                    date: record.FECHA || new Date().toISOString().split('T')[0]
                  });
                }
                break;
              }
            }
          }
        }

        if (results.length > 0) break;
      } catch (resourceError) {
        console.log(`[DAMA] Could not fetch resource ${resourceId}`);
      }
    }

  } catch (error) {
    console.error('[DAMA] Scrape error:', error.message);
  }

  console.log(`[DAMA] Found ${results.length} prices`);
  return results;
}

/**
 * Parse WhatsApp images of price lists (manual input)
 * These are typically shared daily by government agencies
 *
 * For now, returns placeholder indicating manual input needed
 */
export function parseManualPrices(imageData) {
  // Future: Use OCR (Tesseract.js or cloud API) to extract prices
  // For now, return empty - manual entry via dashboard
  console.log('[Manual] Image parsing not yet implemented');
  return [];
}

/**
 * Normalize price to per-kg basis for comparison
 */
export function normalizePrice(price, unit) {
  const unitLower = (unit || '').toLowerCase();

  for (const [unitPattern, converter] of Object.entries(UNIT_CONVERSIONS)) {
    if (unitLower.includes(unitPattern)) {
      return converter(price);
    }
  }

  // Default: assume it's already per-kg
  return price;
}

/**
 * Main function: scrape all government sources
 */
export async function scrapeGovernmentPrices() {
  console.log('\n📊 Scraping government wholesale prices...\n');

  const allPrices = [];

  // Try SIMA
  const simaPrices = await scrapeSIMA();
  allPrices.push(...simaPrices);

  // Try DAMA
  const damaPrices = await scrapeDAMA();
  allPrices.push(...damaPrices);

  // Deduplicate and normalize
  const normalized = [];
  const seen = new Set();

  for (const price of allPrices) {
    const key = `${price.product}-${price.source}-${price.date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      ...price,
      pricePerKg: normalizePrice(price.price, price.unit)
    });
  }

  console.log(`\n📊 Total government prices collected: ${normalized.length}`);

  return normalized;
}

/**
 * Get reference wholesale prices for a specific product
 * Returns latest price from each source
 */
export function getWholesaleReference(prices, productName) {
  const productLower = productName.toLowerCase();

  return prices
    .filter(p => productLower.includes(p.product) || p.product.includes(productLower))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .reduce((acc, p) => {
      if (!acc[p.source]) {
        acc[p.source] = p;
      }
      return acc;
    }, {});
}

// Run standalone for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeGovernmentPrices().then(prices => {
    console.log('\nResults:');
    console.log(JSON.stringify(prices, null, 2));
  });
}
