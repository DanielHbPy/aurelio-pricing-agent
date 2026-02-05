#!/usr/bin/env node
/**
 * HidroBio Pricing Recommendation Engine
 *
 * Combines three data sources to recommend optimal selling prices:
 * 1. Wholesale prices (SIMA/CECOPROA) - Floor/minimum
 * 2. Retail prices (Supermarkets) - Ceiling/maximum
 * 3. Historical sales (Zoho Books) - What customers actually paid
 *
 * The recommended price falls within the band, adjusted for:
 * - Product quality (hydroponic premium)
 * - Market scarcity
 * - Customer type
 *
 * @author HidroBio S.A.
 * @version 1.0.0
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
const envPath = join(__dirname, '..', 'zoho-mcp', '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && !key.startsWith('#') && key.trim() && !process.env[key.trim()]) {
      process.env[key.trim()] = valueParts.join('=').trim();
    }
  });
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // Position factors for different scenarios
  positionFactors: {
    default: 0.50,        // Middle of the band
    premium: 0.65,        // High quality hydroponic
    bulk: 0.35,           // Volume discount
    scarce: 0.80,         // When wholesale shows 0 (scarcity premium)
    competitive: 0.40,    // When facing competition
  },

  // Hydroponic quality premium (%)
  hydroponicPremium: 0.25,  // 25% above commodity prices

  // Minimum margin over wholesale (%)
  minimumMargin: 0.15,  // At least 15% above wholesale

  // HidroBio product categories
  categories: {
    HORTALIZAS: '5509643000018844216',
    INSUMOS: '5509643000023296269'
  },

  // Product mapping (our name → wholesale aliases)
  productMappings: {
    'LECHUGA PIRATI': ['lechuga pirati', 'lechuga crespa', 'lechuga'],
    'LECHUGA MORADA': ['lechuga morada'],
    'LECHUGA BLANCA': ['lechuga blanca'],
    'LECHUGA LALIQUE': ['lechuga lalique', 'lechuga isabela'],
    'LOCOTE ROJO': ['locote rojo', 'pimiento rojo'],
    'LOCOTE AMARILLO': ['locote amarillo', 'pimiento amarillo'],
    'LOCOTE VERDE': ['locote verde', 'pimiento verde'],
    'TOMATE PERITA': ['tomate perita', 'tomate santa cruz', 'tomate santa'],
    'TOMATE LISA': ['tomate lisa', 'tomate holandes', 'tomate liso'],
    'RUCULA PLANA': ['rucula', 'rúcula'],
    'PEREJIL LISO': ['perejil'],
    'CILANTRO': ['cilantro'],
    'ALBAHACA': ['albahaca'],
    'ACELGA VERDE': ['acelga', 'acelga blanca']
  }
};

// =============================================================================
// DATABASE
// =============================================================================

class PricingDatabase {
  constructor() {
    const dbPath = join(__dirname, 'data', 'aurelio.db');
    this.db = new Database(dbPath);
  }

  /**
   * Get today's wholesale prices
   */
  getWholesalePrices(date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.db.prepare(`
      SELECT product, supermarket, price_guaranies, unit, product_name_raw
      FROM prices
      WHERE date = ? AND supermarket LIKE 'Mayorista%'
      AND supermarket NOT LIKE '%(minimo)' AND supermarket NOT LIKE '%(maximo)'
      ORDER BY product
    `).all(targetDate);
  }

  /**
   * Get today's retail prices
   */
  getRetailPrices(date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.db.prepare(`
      SELECT product, supermarket, price_guaranies, unit
      FROM prices
      WHERE date = ? AND supermarket NOT LIKE 'Mayorista%'
      ORDER BY product
    `).all(targetDate);
  }

  /**
   * Get historical average selling price for a product
   */
  getHistoricalAverage(product, days = 30) {
    const result = this.db.prepare(`
      SELECT AVG(price_guaranies) as avg_price, COUNT(*) as count
      FROM prices
      WHERE product = ?
      AND date >= date('now', '-' || ? || ' days')
      AND supermarket = 'HidroBio'
    `).get(product, days);
    return result;
  }

  close() {
    this.db.close();
  }
}

// =============================================================================
// ZOHO BOOKS API
// =============================================================================

async function getAccessToken() {
  const fetch = (await import('node-fetch')).default;
  const tokenRes = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });
  const data = await tokenRes.json();
  return data.access_token;
}

async function getHidroBioInventory() {
  const fetch = (await import('node-fetch')).default;
  const token = await getAccessToken();

  const res = await fetch(`https://www.zohoapis.com/books/v3/items?organization_id=${process.env.ZOHO_ORG_ID}&page=1&per_page=200&filter_by=Status.Active`, {
    headers: { 'Authorization': `Zoho-oauthtoken ${token}` }
  });
  const data = await res.json();

  // Filter to HORTALIZAS category
  return (data.items || []).filter(i => i.category_id === CONFIG.categories.HORTALIZAS);
}

// =============================================================================
// PRICING ENGINE
// =============================================================================

function findWholesalePrice(productName, wholesalePrices) {
  const mappings = CONFIG.productMappings[productName] || [productName.toLowerCase()];

  for (const alias of mappings) {
    const match = wholesalePrices.find(p =>
      p.product.toLowerCase() === alias.toLowerCase() ||
      p.product.toLowerCase().includes(alias.toLowerCase())
    );
    if (match) return match;
  }
  return null;
}

function findRetailPrice(productName, retailPrices) {
  const mappings = CONFIG.productMappings[productName] || [productName.toLowerCase()];

  for (const alias of mappings) {
    const match = retailPrices.find(p =>
      p.product.toLowerCase().includes(alias.toLowerCase())
    );
    if (match) return match;
  }
  return null;
}

function calculateRecommendedPrice(wholesale, retail, historical, options = {}) {
  const { isHydroponic = true, isScarce = false, isBulk = false } = options;

  // Determine position factor
  let positionFactor = CONFIG.positionFactors.default;
  if (isScarce) positionFactor = CONFIG.positionFactors.scarce;
  else if (isBulk) positionFactor = CONFIG.positionFactors.bulk;
  else if (isHydroponic) positionFactor = CONFIG.positionFactors.premium;

  // If no wholesale, use historical or retail as reference
  if (!wholesale || wholesale <= 0) {
    if (historical && historical > 0) {
      return {
        recommended: historical,
        floor: null,
        ceiling: retail || null,
        position: null,
        note: 'Sin precio mayorista - usando histórico'
      };
    }
    if (retail && retail > 0) {
      return {
        recommended: Math.round(retail * 0.7),  // 70% of retail when no data
        floor: null,
        ceiling: retail,
        position: 0.7,
        note: 'Sin precio mayorista - 70% del minorista'
      };
    }
    return null;
  }

  // If no retail, use wholesale + margin
  if (!retail || retail <= 0) {
    const recommended = Math.round(wholesale * (1 + CONFIG.hydroponicPremium + CONFIG.minimumMargin));
    return {
      recommended,
      floor: wholesale,
      ceiling: null,
      position: null,
      note: 'Sin precio minorista - margen mínimo aplicado'
    };
  }

  // Standard calculation: Wholesale + (Retail - Wholesale) × Position
  const band = retail - wholesale;
  let recommended = Math.round(wholesale + (band * positionFactor));

  // Apply hydroponic premium
  if (isHydroponic) {
    const premiumPrice = Math.round(wholesale * (1 + CONFIG.hydroponicPremium));
    recommended = Math.max(recommended, premiumPrice);
  }

  // Ensure minimum margin
  const minimumPrice = Math.round(wholesale * (1 + CONFIG.minimumMargin));
  recommended = Math.max(recommended, minimumPrice);

  // Never exceed retail
  recommended = Math.min(recommended, retail);

  return {
    recommended,
    floor: wholesale,
    ceiling: retail,
    position: positionFactor,
    margin: Math.round((recommended - wholesale) / wholesale * 100),
    note: isScarce ? '⚠️ Escasez en mayorista' : null
  };
}

function convertToPerUnit(price, unit) {
  if (unit === 'docena') {
    return Math.round(price / 12);
  }
  return price;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log('═'.repeat(70));
  console.log('  HIDROBIO - RECOMENDACIÓN DE PRECIOS');
  console.log('  ' + new Date().toLocaleDateString('es-PY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
  console.log('═'.repeat(70));

  const db = new PricingDatabase();

  try {
    // Get all data sources
    console.log('\n📊 Cargando datos...\n');

    const [inventory, wholesalePrices, retailPrices] = await Promise.all([
      getHidroBioInventory(),
      db.getWholesalePrices(),
      db.getRetailPrices()
    ]);

    console.log(`  ✓ Inventario HidroBio: ${inventory.length} productos`);
    console.log(`  ✓ Precios mayoristas: ${wholesalePrices.length} registros`);
    console.log(`  ✓ Precios minoristas: ${retailPrices.length} registros`);

    // Generate recommendations for each product with stock
    const recommendations = [];

    for (const item of inventory) {
      if (item.stock_on_hand <= 0) continue;

      const productName = item.name.replace(/ \(.*\)$/, '').replace(' MEMBY HB', '').trim();
      const wholesale = findWholesalePrice(productName, wholesalePrices);
      const retail = findRetailPrice(productName, retailPrices);

      // Convert wholesale docena to per-unit if needed
      let wholesalePrice = wholesale?.price_guaranies || 0;
      if (wholesale?.unit === 'docena' && item.unit === 'UNI') {
        wholesalePrice = convertToPerUnit(wholesalePrice, 'docena');
      }

      let retailPrice = retail?.price_guaranies || 0;

      const isScarce = wholesale && wholesalePrice === 0;

      const recommendation = calculateRecommendedPrice(
        wholesalePrice,
        retailPrice,
        item.rate,  // Current HidroBio price as "historical"
        { isHydroponic: true, isScarce }
      );

      recommendations.push({
        product: item.name,
        stock: item.stock_on_hand,
        unit: item.unit,
        currentPrice: item.rate,
        wholesale: wholesalePrice,
        wholesaleSource: wholesale?.supermarket || '-',
        retail: retailPrice,
        retailSource: retail?.supermarket || '-',
        ...recommendation
      });
    }

    // Display results
    console.log('\n' + '─'.repeat(70));
    console.log('  PRODUCTOS EN STOCK - RECOMENDACIONES DE PRECIO');
    console.log('─'.repeat(70));

    // Sort by margin opportunity (difference between recommended and current)
    recommendations.sort((a, b) => {
      const diffA = (a.recommended || 0) - a.currentPrice;
      const diffB = (b.recommended || 0) - b.currentPrice;
      return diffB - diffA;
    });

    for (const rec of recommendations) {
      const priceDiff = (rec.recommended || 0) - rec.currentPrice;
      const diffIndicator = priceDiff > 0 ? '📈' : priceDiff < 0 ? '📉' : '➡️';
      const diffText = priceDiff !== 0 ? ` (${priceDiff > 0 ? '+' : ''}${priceDiff.toLocaleString()})` : '';

      console.log(`\n  ${rec.product}`);
      console.log(`  ${'─'.repeat(50)}`);
      console.log(`  Stock: ${rec.stock} ${rec.unit}`);
      console.log(`  Precio actual:     ${rec.currentPrice.toLocaleString().padStart(10)} Gs/${rec.unit}`);
      console.log(`  Mayorista (piso):  ${(rec.floor || 0).toLocaleString().padStart(10)} Gs/${rec.unit}  [${rec.wholesaleSource}]`);
      console.log(`  Minorista (techo): ${(rec.ceiling || 0).toLocaleString().padStart(10)} Gs/${rec.unit}  [${rec.retailSource}]`);

      if (rec.recommended) {
        console.log(`  ${diffIndicator} RECOMENDADO:      ${rec.recommended.toLocaleString().padStart(10)} Gs/${rec.unit}${diffText}`);
        if (rec.margin) console.log(`     Margen sobre mayorista: ${rec.margin}%`);
        if (rec.note) console.log(`     ${rec.note}`);
      } else {
        console.log(`  ⚠️ Sin datos suficientes para recomendar`);
      }
    }

    // Summary
    console.log('\n' + '═'.repeat(70));
    console.log('  RESUMEN');
    console.log('═'.repeat(70));

    const priceIncreases = recommendations.filter(r => r.recommended && r.recommended > r.currentPrice);
    const priceDecreases = recommendations.filter(r => r.recommended && r.recommended < r.currentPrice);

    if (priceIncreases.length > 0) {
      console.log(`\n  📈 Oportunidad de subir precio (${priceIncreases.length} productos):`);
      for (const p of priceIncreases.slice(0, 5)) {
        const diff = p.recommended - p.currentPrice;
        console.log(`     ${p.product}: +${diff.toLocaleString()} Gs`);
      }
    }

    if (priceDecreases.length > 0) {
      console.log(`\n  📉 Considerar bajar precio (${priceDecreases.length} productos):`);
      for (const p of priceDecreases.slice(0, 5)) {
        const diff = p.currentPrice - p.recommended;
        console.log(`     ${p.product}: -${diff.toLocaleString()} Gs`);
      }
    }

    const noWholesale = recommendations.filter(r => !r.floor);
    if (noWholesale.length > 0) {
      console.log(`\n  ⚠️ Sin precio mayorista (${noWholesale.length} productos):`);
      console.log(`     ${noWholesale.map(p => p.product).join(', ')}`);
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    db.close();
  }

  console.log('\n');
}

// Run
main();
