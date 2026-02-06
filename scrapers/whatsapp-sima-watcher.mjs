#!/usr/bin/env node
/**
 * WhatsApp Wholesale Price Watcher
 *
 * Monitors the AGRÓNOMOS DEL PARAGUAY WhatsApp group folder for wholesale price lists.
 * Uses Claude Vision to extract pricing data from multiple government sources:
 *
 * Sources monitored:
 * - SIMA (Servicio de Información de Mercados Agropecuarios) - mag.gov.py
 *   - DAMA Asunción (Mercado de Abasto) - main wholesale market
 *   - Ciudad del Este prices
 *   - Encarnación prices
 * - CECOPROA (Centro de Comercialización para Productores Asociados)
 *
 * These are WHOLESALE prices (lowest in market) vs supermarket RETAIL prices (highest).
 * The spread between wholesale and retail informs HidroBio's pricing strategy.
 *
 * @author HidroBio S.A.
 * @version 1.1.0
 */

import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { watch, existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, readdir } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

// Load environment variables from .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try to load .env from various locations
const envPaths = [
  join(__dirname, '..', '.env'),
  join(__dirname, '..', '..', 'zoho-mcp', '.env'),
  join(__dirname, '.env')
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const [key, ...valueParts] = line.split('=');
      if (key && !key.startsWith('#') && key.trim() && !process.env[key.trim()]) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    });
    console.log(`[Config] Loaded from ${envPath}`);
    break;
  }
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // WhatsApp group folder for AGRÓNOMOS DEL PARAGUAY
  whatsappGroupId: '595985310106-1443489884@g.us',

  // Base path for WhatsApp media on macOS
  whatsappMediaBase: join(
    homedir(),
    'Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message/Media'
  ),

  // Supported file types
  supportedExtensions: ['.jpg', '.jpeg', '.png', '.pdf'],

  // Products to track (matching Aurelio CONFIG)
  trackedProducts: {
    // Tomatoes
    'tomate lisa': { unit: 'kg', aliases: ['tomate holandes', 'tomate holandés', 'tomate redondo', 'tomate liso'] },
    'tomate perita': { unit: 'kg', aliases: ['tomate santa cruz', 'tomate pera', 'tomate santa'] },
    'tomate cherry': { unit: 'kg', aliases: ['cherry'] },

    // Peppers
    'locote rojo': { unit: 'kg', aliases: ['pimiento rojo', 'morron rojo', 'morrón rojo'] },
    'locote amarillo': { unit: 'kg', aliases: ['pimiento amarillo', 'morron amarillo', 'morrón amarillo'] },
    'locote verde': { unit: 'kg', aliases: ['pimiento verde', 'morron verde'] },

    // Lettuce
    'lechuga pirati': { unit: 'docena', aliases: ['lechuga crespa', 'lechuga', 'lechuga blanca'] },

    // Verdeos
    'cebollita de hoja': { unit: 'docena', aliases: ['cebollita', 'verdeo', 'cebolla hoja'] },
    'perejil': { unit: 'docena', aliases: [] },
    'cilantro': { unit: 'docena', aliases: [] },

    // Other vegetables (for market intelligence)
    'repollo blanco': { unit: 'kg', aliases: ['repollo'] },
    'pepino': { unit: 'kg', aliases: [] },
    'calabaza': { unit: 'kg', aliases: [] },
    'zanahoria': { unit: 'kg', aliases: [] }
  },

  // Unit conversions to normalize to per-kg or per-unit
  unitConversions: {
    'caja 20kg': 20,
    'caja 20 kg': 20,
    'caja carton 20kg': 20,
    'caja carton 20 kg': 20,
    'caja/carton 20kg': 20,
    'caja madera 20kg': 20,
    'caja 18kg': 18,
    'caja 15kg': 15,
    'caja 10kg': 10,
    'bolsa 25kg': 25,
    'bolsa 20kg': 20,
    'bolsa 20 kg': 20,
    'bolsa 30kg': 30,
    'kilo': 1,
    'kg': 1,
    'docena': 1,  // Keep as-is for lettuce/verdeos (counted per dozen)
    'unidad': 1
  },

  // Polling interval in ms (for fallback if fs.watch fails)
  pollingInterval: 30000,  // 30 seconds

  // Debounce time for file detection (files may be written incrementally)
  debounceMs: 2000
};

// =============================================================================
// DATABASE
// =============================================================================

class SIMAPriceDatabase {
  constructor() {
    // Check for Railway volume mount first, then fallback to local data directory
    const railwayDataDir = '/app/data';
    const localDataDir = join(__dirname, '..', 'data');

    const dataDir = existsSync(railwayDataDir) ? railwayDataDir : localDataDir;

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = join(dataDir, 'aurelio.db');
    console.log(`[SIMA Watcher] Database path: ${dbPath}`);
    this.db = new Database(dbPath);
    this.initSchema();
  }

  initSchema() {
    // Ensure the prices table exists (should already exist from Aurelio)
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

      CREATE INDEX IF NOT EXISTS idx_prices_date ON prices(date);
      CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product);
      CREATE INDEX IF NOT EXISTS idx_prices_supermarket ON prices(supermarket);

      -- Track processed WhatsApp files to avoid re-processing
      CREATE TABLE IF NOT EXISTS sima_processed_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL UNIQUE,
        file_hash TEXT,
        processed_at TEXT DEFAULT CURRENT_TIMESTAMP,
        prices_extracted INTEGER DEFAULT 0,
        extraction_result TEXT
      );
    `);
  }

  savePrice(product, priceGuaranies, productNameRaw, unit = 'kg', priceType = 'promedio', market = 'DAMA Asunción', source = 'SIMA') {
    const date = new Date().toISOString().split('T')[0];

    // Create descriptive supermarket name that shows:
    // 1. It's wholesale (Mayorista)
    // 2. The specific market/city
    // 3. The source (SIMA vs CECOPROA)
    // Format: "Mayorista: DAMA ASU" or "Mayorista: CDE" or "Mayorista: CECOPROA"
    let marketShort;
    if (market.includes('Asunción') || market === 'DAMA') {
      marketShort = 'DAMA ASU';
    } else if (market.includes('Este') || market === 'CDE') {
      marketShort = 'CDE';
    } else if (market.includes('Encarnación') || market === 'ENC') {
      marketShort = 'ENC';
    } else if (market.includes('CECOPROA') || source === 'CECOPROA') {
      marketShort = 'CECOPROA';
    } else {
      marketShort = market.substring(0, 10);
    }

    // Main price uses clean name, min/max get suffix
    const supermarket = priceType === 'promedio'
      ? `Mayorista: ${marketShort}`
      : `Mayorista: ${marketShort} (${priceType})`;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO prices (date, supermarket, product, product_name_raw, price_guaranies, unit)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(date, supermarket, product, productNameRaw, priceGuaranies, unit);
    console.log(`[${marketShort}] ${product}: ${priceGuaranies.toLocaleString()} Gs/${unit} (${priceType})`);
  }

  isFileProcessed(filePath) {
    const stmt = this.db.prepare('SELECT id FROM sima_processed_files WHERE file_path = ?');
    return !!stmt.get(filePath);
  }

  markFileProcessed(filePath, pricesExtracted, result = 'success') {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sima_processed_files (file_path, processed_at, prices_extracted, extraction_result)
      VALUES (?, datetime('now'), ?, ?)
    `);
    stmt.run(filePath, pricesExtracted, result);
  }

  getTodayWholesalePrices() {
    const date = new Date().toISOString().split('T')[0];
    return this.db.prepare(`
      SELECT * FROM prices
      WHERE date = ? AND supermarket LIKE 'DAMA%'
      ORDER BY product
    `).all(date);
  }

  // Alias for backwards compatibility
  getTodaySIMAPrices() {
    return this.getTodayWholesalePrices();
  }

  close() {
    this.db.close();
  }
}

// =============================================================================
// CLAUDE VISION OCR
// =============================================================================

const anthropic = new Anthropic();

/**
 * Extract prices from a SIMA price list image using Claude Vision
 */
async function extractPricesFromImage(imagePath) {
  console.log(`[Claude Vision] Processing: ${basename(imagePath)}`);

  // Read and encode the image
  const imageBuffer = readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');

  // Determine media type
  const ext = extname(imagePath).toLowerCase();
  let mediaType = 'image/jpeg';
  if (ext === '.png') mediaType = 'image/png';
  if (ext === '.pdf') mediaType = 'application/pdf';

  const prompt = `Analyze this wholesale price list image from Paraguay's Ministry of Agriculture (MAG).

This could be one of several document types:
1. **SIMA - DAMA** (Mercado de Abasto Asunción) - main wholesale market
2. **SIMA - Multi-city** (Asunción, Ciudad del Este, Encarnación prices in columns)
3. **CECOPROA** (Centro de Comercialización para Productores Asociados)
4. **SIMA - Frutas** (wholesale fruit prices)
5. **SIMA - Hortalizas** (wholesale vegetable prices)

Extract ALL prices for these HidroBio products (use exact normalized names):
- "Tomate Lisa" (also called "Tomate Holandés", "Tomate Redondo")
- "Tomate Perita" (also called "Tomate Santa Cruz", "Tomate Pera")
- "Tomate Cherry"
- "Locote Rojo" (red bell pepper, "Pimiento Rojo", "Morrón Rojo")
- "Locote Amarillo" (yellow bell pepper)
- "Locote Verde" (green bell pepper, "Pimiento Verde")
- "Lechuga Pirati" (or any lettuce: Crespa, Blanca, Mantecosa, Morada, Repollada, Isabela)
- "Cebollita de Hoja" (green onion/scallion, "Cebolla Hoja")
- "Perejil" (parsley)
- "Cilantro"
- "Repollo Blanco" (white cabbage)
- "Pepino" (cucumber)

Return JSON with this structure:
{
  "date": "YYYY-MM-DD",  // Date from document header (FECHA: XX-XX-XXXX)
  "source": "SIMA" or "CECOPROA",  // Which organization
  "market": "DAMA Asunción" or "Ciudad del Este" or "Encarnación" or "CECOPROA",
  "document_type": "hortalizas" or "frutas" or "multi-city" or "general",
  "prices": [
    {
      "product": "Tomate Lisa",  // Normalized name from list above
      "product_raw": "TOMATE LISA (1ra)",  // Exact text from document
      "unit": "kg",  // Normalized: kg, docena, unidad
      "unit_raw": "CAJA CARTON 20 KG",  // Exact unit text
      "origin": "PY",  // N/E column if present: PY, AR, BR, CHN
      "price_min": 8000,  // MINIMO column
      "price_common": 10000,  // COMUN column
      "price_max": 12000,  // MAXIMO column
      "price_avg": 10000,  // PROMEDIO column (main price we use)
      "market_city": "Asunción"  // If multi-city document, which city column
    }
  ]
}

CRITICAL RULES:
1. **CONVERT ALL CAJA PRICES TO PER-KG**:
   - "CAJA CARTON 20 KG" → divide price by 20
   - "CAJA MADERA 18 KG" → divide price by 18
   - "BOLSA 25 KG" → divide price by 25
   - Report the per-kg price in price fields, but keep original unit in unit_raw
2. Use PROMEDIO as main price when available, else COMUN, else average of MIN/MAX
3. Prices are in Paraguayan Guaraníes (Gs.) - no decimals needed
4. For multi-city documents (columns: Asunción, C. del Este, Encarnación), create separate entries for each city
5. Skip products with price = 0 (not available)
6. Return ONLY valid JSON, no markdown
7. If image is unreadable: {"error": "Could not read image", "prices": []}

EXAMPLE: If document shows "TOMATE SANTA CRUZ - CAJA CARTON 20 KG - 180,000 Gs"
Return: {"product": "Tomate Perita", "unit": "kg", "unit_raw": "CAJA CARTON 20 KG", "price_avg": 9000}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Image
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ]
    });

    // Extract JSON from response
    const responseText = response.content[0].text;
    console.log(`[Claude Vision] Raw response length: ${responseText.length} chars`);

    // Try to parse JSON (handle potential markdown code blocks)
    let jsonStr = responseText;

    // Strip markdown code blocks if present
    if (responseText.includes('```')) {
      const match = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        jsonStr = match[1].trim();
        console.log(`[Claude Vision] Stripped markdown, JSON length: ${jsonStr.length} chars`);
      }
    }

    // Also try to extract just the JSON object/array if there's extra text
    if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
      const jsonMatch = jsonStr.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
        console.log(`[Claude Vision] Extracted JSON from text`);
      }
    }

    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error(`[Claude Vision] JSON parse failed: ${parseError.message}`);
      console.error(`[Claude Vision] First 500 chars: ${jsonStr.substring(0, 500)}`);
      return { error: `JSON parse error: ${parseError.message}`, prices: [], rawResponse: responseText.substring(0, 1000) };
    }

    console.log(`[Claude Vision] Extracted ${result.prices?.length || 0} prices`);
    return result;

  } catch (error) {
    console.error(`[Claude Vision] Error:`, error.message);
    return { error: error.message, prices: [] };
  }
}

/**
 * Normalize product name to match Aurelio's tracked products
 */
function normalizeProductName(rawName) {
  const lower = rawName.toLowerCase();

  for (const [product, config] of Object.entries(CONFIG.trackedProducts)) {
    // Check main name
    if (lower.includes(product)) {
      return product;
    }
    // Check aliases
    for (const alias of config.aliases) {
      if (lower.includes(alias)) {
        return product;
      }
    }
  }

  return null;  // Not a tracked product
}

/**
 * Convert price to per-kg or per-unit basis
 */
function normalizePrice(price, unitRaw) {
  const unitLower = (unitRaw || '').toLowerCase();

  for (const [pattern, divisor] of Object.entries(CONFIG.unitConversions)) {
    if (unitLower.includes(pattern)) {
      return Math.round(price / divisor);
    }
  }

  // Default: assume already per-kg
  return price;
}

// =============================================================================
// FILE WATCHER
// =============================================================================

class WhatsAppSIMAWatcher {
  constructor() {
    this.db = new SIMAPriceDatabase();
    this.watchPath = join(CONFIG.whatsappMediaBase, CONFIG.whatsappGroupId);
    this.pendingFiles = new Map();  // Debounce map
    this.watcher = null;
    this.isProcessing = false;
  }

  /**
   * Start watching the WhatsApp folder
   */
  start() {
    console.log('\n🔍 SIMA Price Watcher Starting...\n');
    console.log(`📁 Watching: ${this.watchPath}`);

    if (!existsSync(this.watchPath)) {
      console.error(`❌ WhatsApp folder not found: ${this.watchPath}`);
      console.log('\nMake sure:');
      console.log('1. WhatsApp Desktop is installed and logged in');
      console.log('2. You are a member of the AGRÓNOMOS DEL PARAGUAY group');
      console.log('3. Media auto-download is enabled in WhatsApp settings');
      return false;
    }

    // Process any existing unprocessed files first
    this.scanExistingFiles();

    // Set up file watcher
    try {
      this.watcher = watch(this.watchPath, { recursive: true }, (eventType, filename) => {
        if (filename && this.isRelevantFile(filename)) {
          this.handleFileChange(filename);
        }
      });

      console.log('✅ Watcher active - waiting for new price list images...\n');

      // Also poll periodically as backup (fs.watch can be unreliable)
      setInterval(() => this.scanExistingFiles(), CONFIG.pollingInterval);

      return true;
    } catch (error) {
      console.error('❌ Failed to start watcher:', error.message);
      return false;
    }
  }

  /**
   * Check if file is a relevant image/PDF
   */
  isRelevantFile(filename) {
    const ext = extname(filename).toLowerCase();
    return CONFIG.supportedExtensions.includes(ext);
  }

  /**
   * Handle file change event (with debouncing)
   */
  handleFileChange(filename) {
    const fullPath = join(this.watchPath, filename);

    // Clear existing timeout if any
    if (this.pendingFiles.has(fullPath)) {
      clearTimeout(this.pendingFiles.get(fullPath));
    }

    // Set new timeout to debounce rapid file writes
    const timeoutId = setTimeout(() => {
      this.pendingFiles.delete(fullPath);
      this.processFile(fullPath);
    }, CONFIG.debounceMs);

    this.pendingFiles.set(fullPath, timeoutId);
  }

  /**
   * Scan for existing unprocessed files
   */
  scanExistingFiles() {
    if (this.isProcessing) return;

    try {
      const files = this.findAllMediaFiles(this.watchPath);

      for (const filePath of files) {
        if (!this.db.isFileProcessed(filePath) && this.isRelevantFile(filePath)) {
          this.processFile(filePath);
        }
      }
    } catch (error) {
      console.error('[Scan] Error:', error.message);
    }
  }

  /**
   * Recursively find all media files in directory
   */
  findAllMediaFiles(dir) {
    const files = [];

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          files.push(...this.findAllMediaFiles(fullPath));
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (CONFIG.supportedExtensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      // Ignore permission errors
    }

    return files;
  }

  /**
   * Process a single image file
   */
  async processFile(filePath) {
    if (this.isProcessing) {
      // Queue for later
      setTimeout(() => this.processFile(filePath), 5000);
      return;
    }

    // Skip if already processed
    if (this.db.isFileProcessed(filePath)) {
      return;
    }

    // Skip thumbnail files
    if (filePath.endsWith('.thumb')) {
      return;
    }

    this.isProcessing = true;

    try {
      console.log(`\n📄 Processing: ${basename(filePath)}`);

      // Check file size (skip very small files - likely thumbnails)
      const stats = statSync(filePath);
      if (stats.size < 10000) {  // Less than 10KB
        console.log(`  ⏭️ Skipped: File too small (${stats.size} bytes)`);
        this.db.markFileProcessed(filePath, 0, 'skipped_too_small');
        return;
      }

      // Extract prices using Claude Vision
      const result = await extractPricesFromImage(filePath);

      if (result.error) {
        console.log(`  ⚠️ Could not extract prices: ${result.error}`);
        this.db.markFileProcessed(filePath, 0, `error: ${result.error}`);
        return;
      }

      // Save extracted prices
      let savedCount = 0;

      for (const priceData of (result.prices || [])) {
        const normalizedProduct = normalizeProductName(priceData.product || priceData.product_raw);

        if (!normalizedProduct) {
          console.log(`  ⏭️ Skipped: ${priceData.product_raw} (not tracked)`);
          continue;
        }

        // Get the average price (main reference)
        const avgPrice = priceData.price_avg || priceData.price_common || priceData.price_max;

        if (!avgPrice || avgPrice <= 0) {
          continue;
        }

        // Normalize price if it's per-caja
        const normalizedPrice = normalizePrice(avgPrice, priceData.unit_raw);

        // Determine unit for this product
        const productConfig = CONFIG.trackedProducts[normalizedProduct];
        const unit = productConfig?.unit || 'kg';

        // Determine market from result or priceData
        const market = priceData.market_city || result.market || 'DAMA Asunción';
        const source = result.source || 'SIMA';

        // Save the average price (main)
        this.db.savePrice(
          normalizedProduct,
          normalizedPrice,
          priceData.product_raw || priceData.product,
          unit,
          'promedio',
          market,
          source
        );
        savedCount++;

        // Also save min/max for reference if available
        if (priceData.price_min && priceData.price_min > 0) {
          const minPrice = normalizePrice(priceData.price_min, priceData.unit_raw);
          this.db.savePrice(normalizedProduct, minPrice, priceData.product_raw, unit, 'minimo', market, source);
        }
        if (priceData.price_max && priceData.price_max > 0) {
          const maxPrice = normalizePrice(priceData.price_max, priceData.unit_raw);
          this.db.savePrice(normalizedProduct, maxPrice, priceData.product_raw, unit, 'maximo', market, source);
        }
      }

      const marketInfo = result.market ? ` (${result.market})` : '';
      console.log(`  ✅ Saved ${savedCount} prices from ${result.source || 'SIMA'}${marketInfo}`);
      this.db.markFileProcessed(filePath, savedCount, 'success');

      // Show today's SIMA prices
      this.showTodayPrices();

    } catch (error) {
      console.error(`  ❌ Error processing file:`, error.message);
      this.db.markFileProcessed(filePath, 0, `error: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Display today's wholesale prices summary
   */
  showTodayPrices() {
    const prices = this.db.getTodayWholesalePrices();

    if (prices.length === 0) {
      console.log('\n📊 No wholesale prices for today yet.\n');
      return;
    }

    console.log('\n📊 Today\'s Wholesale Prices (SIMA/CECOPROA):');
    console.log('═'.repeat(60));

    // Group by market, then by product
    const byMarket = {};
    for (const p of prices) {
      // Extract market from supermarket name (e.g., "Mayorista: DAMA ASU" -> "DAMA ASU")
      const market = p.supermarket.replace('Mayorista: ', '').replace(/ \(.*\)$/, '');

      if (!byMarket[market]) {
        byMarket[market] = {};
      }
      if (!byMarket[market][p.product]) {
        byMarket[market][p.product] = { prices: {} };
      }

      // Check if this is min/max variant
      if (p.supermarket.includes('(minimo)')) {
        byMarket[market][p.product].prices.min = p.price_guaranies;
      } else if (p.supermarket.includes('(maximo)')) {
        byMarket[market][p.product].prices.max = p.price_guaranies;
      } else {
        byMarket[market][p.product].prices.avg = p.price_guaranies;
        byMarket[market][p.product].unit = p.unit;
      }
    }

    for (const [market, products] of Object.entries(byMarket)) {
      console.log(`\n📍 ${market}:`);
      console.log('─'.repeat(50));

      for (const [product, data] of Object.entries(products)) {
        const avg = data.prices.avg || 0;
        const min = data.prices.min || avg;
        const max = data.prices.max || avg;
        const unit = data.unit || 'kg';

        if (avg > 0) {
          console.log(`  ${product.padEnd(20)} ${avg.toLocaleString().padStart(10)} Gs/${unit}  (${min.toLocaleString()}-${max.toLocaleString()})`);
        }
      }
    }

    console.log('\n' + '═'.repeat(60) + '\n');
  }

  /**
   * Stop the watcher
   */
  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.db.close();
    console.log('\n👋 SIMA Watcher stopped.\n');
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log('═'.repeat(60));
  console.log('  AURELIO - SIMA WhatsApp Price Watcher');
  console.log('  Wholesale market prices from AGRÓNOMOS DEL PARAGUAY');
  console.log('═'.repeat(60));

  const watcher = new WhatsAppSIMAWatcher();

  if (!watcher.start()) {
    process.exit(1);
  }

  // Handle shutdown
  process.on('SIGINT', () => {
    watcher.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    watcher.stop();
    process.exit(0);
  });

  // Keep running
  console.log('Press Ctrl+C to stop.\n');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Export for use by Aurelio
export { WhatsAppSIMAWatcher, extractPricesFromImage, normalizeProductName, normalizePrice };
