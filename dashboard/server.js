/**
 * Aurelio Dashboard Server
 *
 * Secure internal dashboard for HidroBio's pricing intelligence.
 * Features:
 * - Zoho OAuth authentication (inherits organization MFA)
 * - Real-time pricing analysis display
 * - On-demand analysis trigger with WebSocket progress
 *
 * @author HidroBio S.A.
 * @version 1.0.0
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DASHBOARD_PORT || process.env.PORT || 3000;

// ============================================================
// Configuration
// ============================================================

// Load environment from zoho-mcp/.env or aurelio's path
let ZOHO_CONFIG = null;
const envPaths = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', 'zoho-mcp', '.env')
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    ZOHO_CONFIG = {};
    envContent.split('\n').forEach(line => {
      const [key, ...valueParts] = line.split('=');
      if (key && !key.startsWith('#') && key.trim()) {
        ZOHO_CONFIG[key.trim()] = valueParts.join('=').trim();
      }
    });
    console.log(`[Dashboard] Loaded config from ${envPath}`);
    break;
  }
}

if (!ZOHO_CONFIG) {
  // Fall back to process.env (for Railway deployment)
  if (process.env.ZOHO_CLIENT_ID) {
    ZOHO_CONFIG = {
      ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID,
      ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET,
      ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN,
      ZOHO_ORG_ID: process.env.ZOHO_ORG_ID,
      ZOHO_DC: process.env.ZOHO_DC || '.com',
      JWT_SECRET: process.env.JWT_SECRET
    };
    console.log('[Dashboard] Using environment variables for Zoho config');
  } else {
    console.error('[Dashboard] ERROR: No Zoho config found (neither .env file nor environment variables)');
  }
}

// JWT secret for session tokens
const JWT_SECRET = process.env.JWT_SECRET || ZOHO_CONFIG?.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// Allowed Zoho One users (HidroBio team)
// All @hidrobio.com.py emails are allowed
const ALLOWED_USERS = process.env.ALLOWED_USERS?.split(',') || [
  'maximiliano.samaniego@hidrobio.com.py',
  'daniel@hidrobio.com.py',
  'wilson.sanchez@hidrobio.com.py',
  'fernando.samaniego@hidrobio.com.py',
  'christian.pampliega@hidrobio.com.py',
  'martha.pampliega@hidrobio.com.py'
];

// Also allow any @hidrobio.com.py domain email
function isAllowedUser(email) {
  if (!email) return false;
  const emailLower = email.toLowerCase();
  // Allow any HidroBio domain email
  if (emailLower.endsWith('@hidrobio.com.py')) return true;
  // Or check explicit whitelist
  return ALLOWED_USERS.some(allowed => allowed.toLowerCase() === emailLower);
}

// Session storage
const sessions = new Map();

// Rate limiting for run-analysis
const analysisRateLimit = new Map();
const RATE_LIMIT_MINUTES = 5;

// WebSocket clients for progress updates
const wsClients = new Set();

// Path to Aurelio's database - check Railway volume first, then local
const RAILWAY_DB_PATH = '/app/data/aurelio.db';
const LOCAL_DB_PATH = path.join(__dirname, '..', 'data', 'aurelio.db');
const AURELIO_DB_PATH = fs.existsSync(RAILWAY_DB_PATH) ? RAILWAY_DB_PATH : LOCAL_DB_PATH;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ============================================================
// Zoho OAuth Functions
// ============================================================

const ZOHO_DC = ZOHO_CONFIG?.ZOHO_DC || '.com';

// Exchange authorization code for user tokens
async function exchangeCodeForTokens(code, redirectUri) {
  const tokenUrl = `https://accounts.zoho${ZOHO_DC}/oauth/v2/token`;
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ZOHO_CONFIG.ZOHO_CLIENT_ID,
    client_secret: ZOHO_CONFIG.ZOHO_CLIENT_SECRET,
    code: code,
    redirect_uri: redirectUri
  });

  return new Promise((resolve, reject) => {
    const req = https.request(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(params.toString());
    req.end();
  });
}

// Get user info from Zoho
async function getZohoUserInfo(accessToken) {
  const userUrl = `https://accounts.zoho${ZOHO_DC}/oauth/user/info`;

  return new Promise((resolve, reject) => {
    const req = https.request(userUrl, {
      method: 'GET',
      headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ============================================================
// Session Management (JWT)
// ============================================================

function createSessionToken(userData) {
  const payload = {
    sub: userData.ZUID || userData.email,
    email: userData.Email || userData.email,
    name: userData.Display_Name || userData.name,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hours
  };

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

function verifySessionToken(token) {
  try {
    const [header, body, signature] = token.split('.');

    const expectedSig = crypto.createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');

    if (signature !== expectedSig) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch (e) {
    return null;
  }
}

function getSessionFromRequest(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return verifySessionToken(authHeader.substring(7));
  }

  const cookies = req.headers.cookie?.split(';').reduce((acc, c) => {
    const [key, val] = c.trim().split('=');
    acc[key] = val;
    return acc;
  }, {}) || {};

  if (cookies.session) {
    return verifySessionToken(cookies.session);
  }

  return null;
}

// ============================================================
// Database Access (Aurelio's SQLite)
// ============================================================

let Database = null;

async function loadDatabase() {
  if (!Database) {
    try {
      const betterSqlite3 = await import('better-sqlite3');
      Database = betterSqlite3.default;
    } catch (e) {
      console.error('[Dashboard] Failed to load better-sqlite3:', e.message);
      return null;
    }
  }

  if (!fs.existsSync(AURELIO_DB_PATH)) {
    console.error('[Dashboard] Aurelio database not found:', AURELIO_DB_PATH);
    return null;
  }

  return new Database(AURELIO_DB_PATH, { readonly: true });
}

async function getTodayPrices() {
  const db = await loadDatabase();
  if (!db) return [];

  try {
    const today = new Date().toISOString().split('T')[0];
    return db.prepare(`
      SELECT * FROM prices
      WHERE date = ?
      ORDER BY supermarket, product
    `).all(today);
  } finally {
    db.close();
  }
}

/**
 * Get wholesale (mayorista) prices - from SIMA/DAMA via WhatsApp watcher
 * These are stored with supermarket names like "Mayorista: DAMA ASU"
 */
async function getWholesalePrices() {
  const db = await loadDatabase();
  if (!db) return [];

  try {
    // Get prices from the last 7 days for wholesale sources
    return db.prepare(`
      SELECT * FROM prices
      WHERE supermarket LIKE 'Mayorista:%'
      ORDER BY date DESC, supermarket, product
    `).all();
  } finally {
    db.close();
  }
}

/**
 * Get latest wholesale prices (one per product/market)
 */
async function getLatestWholesalePrices() {
  const db = await loadDatabase();
  if (!db) return [];

  try {
    // Get the most recent price for each product from each wholesale market
    return db.prepare(`
      SELECT p.* FROM prices p
      INNER JOIN (
        SELECT product, supermarket, MAX(date) as max_date
        FROM prices
        WHERE supermarket LIKE 'Mayorista:%'
        GROUP BY product, supermarket
      ) latest ON p.product = latest.product
        AND p.supermarket = latest.supermarket
        AND p.date = latest.max_date
      ORDER BY p.product, p.supermarket
    `).all();
  } finally {
    db.close();
  }
}

/**
 * Get price comparison: wholesale vs retail for each product
 */
async function getPriceComparison() {
  const db = await loadDatabase();
  if (!db) return { wholesale: [], retail: [], comparison: [] };

  try {
    const today = new Date().toISOString().split('T')[0];

    // Get latest wholesale prices
    const wholesale = db.prepare(`
      SELECT p.product, p.supermarket, p.price_guaranies, p.unit, p.date, p.product_name_raw
      FROM prices p
      INNER JOIN (
        SELECT product, supermarket, MAX(date) as max_date
        FROM prices
        WHERE supermarket LIKE 'Mayorista:%'
        GROUP BY product, supermarket
      ) latest ON p.product = latest.product
        AND p.supermarket = latest.supermarket
        AND p.date = latest.max_date
      ORDER BY p.product
    `).all();

    // Get today's retail prices (non-wholesale)
    const retail = db.prepare(`
      SELECT product, supermarket, price_guaranies, unit, date, product_name_raw
      FROM prices
      WHERE date = ? AND supermarket NOT LIKE 'Mayorista:%'
      ORDER BY product, supermarket
    `).all(today);

    // Build comparison by product
    const wholesaleByProduct = {};
    wholesale.forEach(p => {
      if (!wholesaleByProduct[p.product]) {
        wholesaleByProduct[p.product] = [];
      }
      wholesaleByProduct[p.product].push(p);
    });

    const retailByProduct = {};
    retail.forEach(p => {
      if (!retailByProduct[p.product]) {
        retailByProduct[p.product] = [];
      }
      retailByProduct[p.product].push(p);
    });

    const comparison = [];
    const allProducts = new Set([...Object.keys(wholesaleByProduct), ...Object.keys(retailByProduct)]);

    for (const product of allProducts) {
      const wholesalePrices = wholesaleByProduct[product] || [];
      const retailPrices = retailByProduct[product] || [];

      // Calculate wholesale average (lowest market prices)
      const wholesaleAvg = wholesalePrices.length > 0
        ? Math.round(wholesalePrices.reduce((sum, p) => sum + p.price_guaranies, 0) / wholesalePrices.length)
        : null;

      // Calculate retail median
      let retailMedian = null;
      if (retailPrices.length > 0) {
        const sorted = retailPrices.map(p => p.price_guaranies).sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        retailMedian = sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      }

      // Calculate markup percentage
      let markupPct = null;
      if (wholesaleAvg && retailMedian) {
        markupPct = Math.round(((retailMedian - wholesaleAvg) / wholesaleAvg) * 100);
      }

      comparison.push({
        product,
        wholesaleAvg,
        wholesaleMin: wholesalePrices.length > 0 ? Math.min(...wholesalePrices.map(p => p.price_guaranies)) : null,
        wholesaleMax: wholesalePrices.length > 0 ? Math.max(...wholesalePrices.map(p => p.price_guaranies)) : null,
        wholesaleSources: wholesalePrices.map(p => ({
          market: p.supermarket.replace('Mayorista: ', ''),
          price: p.price_guaranies,
          date: p.date
        })),
        retailMedian,
        retailMin: retailPrices.length > 0 ? Math.min(...retailPrices.map(p => p.price_guaranies)) : null,
        retailMax: retailPrices.length > 0 ? Math.max(...retailPrices.map(p => p.price_guaranies)) : null,
        retailCount: retailPrices.length,
        markupPct,
        unit: wholesalePrices[0]?.unit || retailPrices[0]?.unit || 'kg'
      });
    }

    return {
      wholesale,
      retail,
      comparison: comparison.sort((a, b) => a.product.localeCompare(b.product))
    };
  } finally {
    db.close();
  }
}

async function getLatestAnalysis() {
  const db = await loadDatabase();
  if (!db) return null;

  try {
    // Check if weekly_reports table exists
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='weekly_reports'
    `).get();

    if (tableExists) {
      const report = db.prepare(`
        SELECT * FROM weekly_reports ORDER BY generated_at DESC LIMIT 1
      `).get();

      if (report) {
        return {
          ...report,
          analysis: JSON.parse(report.analysis_json || '{}')
        };
      }
    }

    // Fallback: get latest from analysis table
    const latestDate = db.prepare(`
      SELECT DISTINCT date FROM analysis ORDER BY date DESC LIMIT 1
    `).get();

    if (!latestDate) return null;

    const analysisRows = db.prepare(`
      SELECT * FROM analysis WHERE date = ?
    `).all(latestDate.date);

    return {
      date: latestDate.date,
      analysis: analysisRows
    };
  } finally {
    db.close();
  }
}

async function getRecentAlerts(days = 7) {
  const db = await loadDatabase();
  if (!db) return [];

  try {
    return db.prepare(`
      SELECT * FROM alerts
      WHERE date >= date('now', '-${days} days')
      ORDER BY created_at DESC
    `).all();
  } finally {
    db.close();
  }
}

async function getSystemStatus() {
  const db = await loadDatabase();
  if (!db) return { status: 'database_unavailable' };

  try {
    const latestPrice = db.prepare(`
      SELECT date, COUNT(*) as count FROM prices
      GROUP BY date ORDER BY date DESC LIMIT 1
    `).get();

    // Get actual timestamp of most recent price entry
    const latestTimestamp = db.prepare(`
      SELECT created_at FROM prices
      WHERE date = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(latestPrice?.date || '');

    const supermarkets = db.prepare(`
      SELECT DISTINCT supermarket FROM prices WHERE date = ?
    `).all(latestPrice?.date || '');

    const products = db.prepare(`
      SELECT DISTINCT product FROM prices WHERE date = ?
    `).all(latestPrice?.date || '');

    // Format last run time in Paraguay timezone (UTC-4 / UTC-3 DST)
    let lastRunPYT = null;
    if (latestTimestamp?.created_at) {
      const utcDate = new Date(latestTimestamp.created_at + 'Z');
      lastRunPYT = utcDate.toLocaleString('es-PY', {
        timeZone: 'America/Asuncion',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    return {
      status: 'operational',
      lastScrape: latestPrice?.date || null,
      lastScrapeTimestamp: latestTimestamp?.created_at || null,
      lastRunPYT: lastRunPYT,
      pricesCollected: latestPrice?.count || 0,
      supermarketsCount: supermarkets.length,
      productsCount: products.length,
      nextScheduled: getNextThursday()
    };
  } finally {
    db.close();
  }
}

function getNextThursday() {
  const now = new Date();
  const daysUntilThursday = (4 - now.getDay() + 7) % 7 || 7;
  const nextThursday = new Date(now);
  nextThursday.setDate(now.getDate() + daysUntilThursday);
  nextThursday.setHours(15, 0, 0, 0); // 15:00 PYT
  return nextThursday.toISOString();
}

// ============================================================
// Auth Handlers
// ============================================================

async function handleAuthLogin(req, res) {
  const host = req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const redirectUri = `${protocol}://${host}/auth/callback`;

  const scopes = [
    'aaaserver.profile.READ'
  ].join(',');

  const authUrl = `https://accounts.zoho${ZOHO_DC}/oauth/v2/auth?` +
    `scope=${encodeURIComponent(scopes)}` +
    `&client_id=${ZOHO_CONFIG.ZOHO_CLIENT_ID}` +
    `&response_type=code` +
    `&access_type=offline` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&prompt=consent`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}

async function handleAuthCallback(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(302, { Location: '/login.html?error=' + encodeURIComponent(error) });
    res.end();
    return;
  }

  if (!code) {
    res.writeHead(302, { Location: '/login.html?error=no_code' });
    res.end();
    return;
  }

  try {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const redirectUri = `${protocol}://${req.headers.host}/auth/callback`;

    const tokens = await exchangeCodeForTokens(code, redirectUri);

    if (tokens.error) {
      throw new Error(tokens.error);
    }

    const userInfo = await getZohoUserInfo(tokens.access_token);

    // Check if user is allowed
    const userEmail = userInfo.Email;
    const isAllowed = isAllowedUser(userEmail);

    if (!isAllowed) {
      console.log(`[Dashboard] Unauthorized login attempt: ${userEmail}`);
      res.writeHead(302, { Location: '/login.html?error=unauthorized' });
      res.end();
      return;
    }

    // Create session token
    const sessionToken = createSessionToken(userInfo);

    // Store session
    sessions.set(userInfo.ZUID, {
      user: userInfo,
      loginAt: new Date().toISOString()
    });

    console.log(`[Dashboard] User logged in: ${userEmail}`);

    res.writeHead(302, {
      'Set-Cookie': `session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${24*60*60}`,
      'Location': '/'
    });
    res.end();

  } catch (err) {
    console.error('[Dashboard] Auth callback error:', err);
    res.writeHead(302, { Location: '/login.html?error=' + encodeURIComponent(err.message) });
    res.end();
  }
}

async function handleAuthLogout(req, res) {
  const session = getSessionFromRequest(req);
  if (session) {
    console.log(`[Dashboard] User logged out: ${session.email}`);
  }

  res.writeHead(302, {
    'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0',
    'Location': '/login.html'
  });
  res.end();
}

async function handleAuthMe(req, res) {
  const session = getSessionFromRequest(req);

  if (!session) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not authenticated' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    email: session.email,
    name: session.name,
    authenticated: true
  }));
}

// ============================================================
// API Handlers
// ============================================================

async function handleApiLatestReport(req, res, session) {
  try {
    const analysis = await getLatestAnalysis();
    const prices = await getTodayPrices();
    const alerts = await getRecentAlerts();
    const status = await getSystemStatus();

    console.log(`[Dashboard] ${session.email} fetched latest report`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: {
        analysis,
        prices,
        alerts,
        status
      }
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

async function handleApiPricesToday(req, res, session) {
  try {
    const prices = await getTodayPrices();

    console.log(`[Dashboard] ${session.email} fetched today's prices`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, prices }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

async function handleApiWholesalePrices(req, res, session) {
  try {
    const comparison = await getPriceComparison();

    console.log(`[Dashboard] ${session.email} fetched wholesale price comparison`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...comparison }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

async function handleApiStatus(req, res, session) {
  try {
    const status = await getSystemStatus();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, status }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

async function handleApiRunAnalysis(req, res, session) {
  // Check rate limit
  const lastRun = analysisRateLimit.get(session.email);
  const now = Date.now();

  if (lastRun && (now - lastRun) < RATE_LIMIT_MINUTES * 60 * 1000) {
    const waitMinutes = Math.ceil((RATE_LIMIT_MINUTES * 60 * 1000 - (now - lastRun)) / 60000);
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: `Rate limited. Wait ${waitMinutes} minute(s).`
    }));
    return;
  }

  analysisRateLimit.set(session.email, now);
  console.log(`[Dashboard] ${session.email} triggered manual analysis`);

  // Spawn Aurelio analysis
  try {
    const { spawn } = await import('child_process');
    const aurelioPath = path.join(__dirname, '..', 'aurelio.mjs');

    const child = spawn('node', [aurelioPath, '--now'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env }
    });

    // Send progress updates via WebSocket
    child.stdout.on('data', (data) => {
      const message = data.toString();
      broadcastProgress({ type: 'output', message });
    });

    child.stderr.on('data', (data) => {
      const message = data.toString();
      broadcastProgress({ type: 'error', message });
    });

    child.on('close', (code) => {
      broadcastProgress({
        type: 'complete',
        success: code === 0,
        message: code === 0 ? 'Analysis completed successfully' : `Analysis failed with code ${code}`
      });
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Analysis started. Watch WebSocket for progress.'
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

async function handleApiHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
}

// Rate limiting for email
const emailRateLimit = new Map();
const EMAIL_RATE_LIMIT_MINUTES = 5;

async function handleApiExportPdf(req, res, session) {
  console.log(`[Dashboard] ${session.email} requested PDF export`);

  try {
    // Get latest analysis data
    const analysis = await getLatestAnalysis();
    const prices = await getTodayPrices();

    if (!analysis) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No analysis data available' }));
      return;
    }

    // For now, return HTML as a downloadable file that can be printed to PDF
    // Full PDF generation with pdfkit would require significant layout work
    const analysisData = analysis.analysis || analysis;
    const html = generatePdfHtml(analysisData, prices);

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="aurelio-reporte-${new Date().toISOString().split('T')[0]}.html"`
    });
    res.end(html);

  } catch (error) {
    console.error('[Dashboard] PDF export error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

async function handleApiSendEmail(req, res, session) {
  // Check rate limit
  const lastSend = emailRateLimit.get(session.email);
  const now = Date.now();

  if (lastSend && (now - lastSend) < EMAIL_RATE_LIMIT_MINUTES * 60 * 1000) {
    const waitMinutes = Math.ceil((EMAIL_RATE_LIMIT_MINUTES * 60 * 1000 - (now - lastSend)) / 60000);
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: `Rate limited. Wait ${waitMinutes} minute(s).`
    }));
    return;
  }

  emailRateLimit.set(session.email, now);
  console.log(`[Dashboard] ${session.email} requested email send`);

  try {
    // Spawn Aurelio to send email with --email-only flag
    const { spawn } = await import('child_process');
    const aurelioPath = path.join(__dirname, '..', 'aurelio.mjs');

    // Run aurelio with --now which includes sending email
    const child = spawn('node', [aurelioPath, '--now'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        EMAIL_TO: session.email  // Override recipient to current user
      }
    });

    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[Dashboard] Email sent successfully to ${session.email}`);
      } else {
        console.error(`[Dashboard] Email send failed with code ${code}`);
      }
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Email analysis started',
      sentTo: session.email
    }));

  } catch (error) {
    console.error('[Dashboard] Email send error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

function generatePdfHtml(analysis, prices) {
  const date = new Date().toLocaleDateString('es-PY', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Aurelio - Reporte de Precios | ${date}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; line-height: 1.6; color: #1a1a2e; padding: 2rem; max-width: 900px; margin: 0 auto; }
    .header { background: linear-gradient(135deg, #1a5c1f, #2e7d32); color: white; padding: 2rem; border-radius: 12px; margin-bottom: 2rem; }
    .header h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .header .subtitle { opacity: 0.9; }
    .section { background: white; border: 1px solid #e0e0e0; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .section-title { font-size: 1.2rem; font-weight: 600; margin-bottom: 1rem; color: #1a5c1f; border-bottom: 2px solid #e8f5e9; padding-bottom: 0.5rem; }
    .summary { background: #f5f5f5; padding: 1rem; border-radius: 8px; border-left: 4px solid #1a5c1f; }
    .product-card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .product-name { font-weight: 600; color: #1a5c1f; font-size: 1.1rem; margin-bottom: 0.5rem; }
    .metric { display: inline-block; margin-right: 2rem; margin-bottom: 0.5rem; }
    .metric-label { font-size: 0.8rem; color: #666; }
    .metric-value { font-size: 1.1rem; font-weight: 600; }
    .metric-value.blue { color: #1565c0; }
    .metric-value.red { color: #c62828; }
    .metric-value.green { color: #2e7d32; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e0e0e0; }
    th { background: #f5f5f5; font-weight: 600; }
    .alert { background: #fff3e0; border-left: 4px solid #ef6c00; padding: 1rem; margin-bottom: 0.5rem; border-radius: 4px; }
    .recommendation { background: #e8f5e9; border-left: 4px solid #2e7d32; padding: 1rem; border-radius: 4px; }
    .footer { text-align: center; color: #666; font-size: 0.9rem; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e0e0e0; }
    @media print { body { padding: 0; } .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>AURELIO - Reporte de Precios</h1>
    <div class="subtitle">HidroBio S.A. | ${date}</div>
  </div>

  <div class="section">
    <div class="section-title">Resumen Ejecutivo</div>
    <div class="summary">${analysis.resumenEjecutivo || 'Sin resumen disponible.'}</div>
  </div>

  ${analysis.productos ? `
  <div class="section">
    <div class="section-title">Analisis por Producto</div>
    ${analysis.productos.map(prod => `
      <div class="product-card">
        <div class="product-name">${prod.producto}</div>
        <div class="metric">
          <div class="metric-label">Mediana Mercado</div>
          <div class="metric-value blue">Gs. ${(prod.medianaSupermercados || 0).toLocaleString('es-PY')}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Tendencia</div>
          <div class="metric-value ${prod.tendencia?.includes('+') ? 'green' : prod.tendencia?.includes('-') ? 'red' : ''}">${prod.tendencia || 'estable'}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Piso Absoluto</div>
          <div class="metric-value red">Gs. ${(prod.pisoAbsoluto || 0).toLocaleString('es-PY')}</div>
        </div>
        ${prod.razonamiento ? `<p style="margin-top: 0.5rem; color: #666; font-size: 0.9rem;">💡 ${prod.razonamiento}</p>` : ''}
      </div>
    `).join('')}
  </div>
  ` : ''}

  ${analysis.alertasGenerales && analysis.alertasGenerales.length > 0 ? `
  <div class="section">
    <div class="section-title">Alertas</div>
    ${analysis.alertasGenerales.map(alert => `<div class="alert">⚠️ ${alert}</div>`).join('')}
  </div>
  ` : ''}

  ${analysis.recomendacionSemanal ? `
  <div class="section">
    <div class="section-title">Recomendacion Semanal</div>
    <div class="recommendation">${analysis.recomendacionSemanal}</div>
  </div>
  ` : ''}

  <div class="footer">
    <p>Generado por Aurelio - Sistema de Inteligencia de Precios</p>
    <p>HidroBio S.A. | Paraguay</p>
  </div>
</body>
</html>`;
}

// ============================================================
// WebSocket for Progress Updates
// ============================================================

function broadcastProgress(data) {
  const message = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  }
}

// ============================================================
// HTTP Server
// ============================================================

const server = http.createServer(async (req, res) => {
  // CORS headers (same-origin only for production)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Health check (public)
  if (pathname === '/api/health') {
    return handleApiHealth(req, res);
  }

  // Auth routes (public)
  if (pathname === '/auth/login') {
    return handleAuthLogin(req, res);
  }
  if (pathname === '/auth/callback') {
    return handleAuthCallback(req, res);
  }
  if (pathname === '/auth/logout') {
    return handleAuthLogout(req, res);
  }
  if (pathname === '/auth/me') {
    return handleAuthMe(req, res);
  }

  // API routes (require auth)
  if (pathname.startsWith('/api/')) {
    const session = getSessionFromRequest(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated', redirect: '/login.html' }));
      return;
    }

    if (pathname === '/api/latest-report') {
      return handleApiLatestReport(req, res, session);
    }
    if (pathname === '/api/prices/today') {
      return handleApiPricesToday(req, res, session);
    }
    if (pathname === '/api/prices/wholesale') {
      return handleApiWholesalePrices(req, res, session);
    }
    if (pathname === '/api/status') {
      return handleApiStatus(req, res, session);
    }
    if (pathname === '/api/run-analysis' && req.method === 'POST') {
      return handleApiRunAnalysis(req, res, session);
    }
    if (pathname === '/api/export/pdf' && req.method === 'POST') {
      return handleApiExportPdf(req, res, session);
    }
    if (pathname === '/api/email/send' && req.method === 'POST') {
      return handleApiSendEmail(req, res, session);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Protected routes - require authentication
  const protectedPaths = ['/', '/index.html'];
  if (protectedPaths.includes(pathname)) {
    const session = getSessionFromRequest(req);
    if (!session) {
      res.writeHead(302, { Location: '/login.html' });
      res.end();
      return;
    }
  }

  // Serve static files
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        const session = getSessionFromRequest(req);
        if (!session && !pathname.includes('login')) {
          res.writeHead(302, { Location: '/login.html' });
          res.end();
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

// WebSocket server for progress updates
const wss = new WebSocketServer({ server, path: '/ws/progress' });

wss.on('connection', (ws, req) => {
  // Verify authentication via cookie
  const cookies = req.headers.cookie?.split(';').reduce((acc, c) => {
    const [key, val] = c.trim().split('=');
    acc[key] = val;
    return acc;
  }, {}) || {};

  const session = cookies.session ? verifySessionToken(cookies.session) : null;

  if (!session) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  console.log(`[Dashboard] WebSocket connected: ${session.email}`);
  wsClients.add(ws);

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[Dashboard] WebSocket disconnected: ${session.email}`);
  });
});

server.listen(PORT, () => {
  console.log(`
  ====================================
  AURELIO - Pricing Intelligence Dashboard
  HidroBio S.A.
  ====================================

  Server running at: http://localhost:${PORT}

  Authentication: Zoho OAuth (organization MFA)
  Allowed users: ${ALLOWED_USERS.length}

  Routes:
    GET  /              - Dashboard (requires auth)
    GET  /login.html    - Login page
    GET  /auth/login    - Start Zoho OAuth flow
    GET  /auth/callback - OAuth callback
    GET  /auth/logout   - Logout
    GET  /auth/me       - Get current user info
    GET  /api/health    - Health check
    GET  /api/latest-report   - Get latest analysis
    GET  /api/prices/today    - Get today's prices
    GET  /api/status          - System status
    POST /api/run-analysis    - Trigger analysis (rate limited)
    WS   /ws/progress         - Analysis progress updates

  Press Ctrl+C to stop
  `);
});
