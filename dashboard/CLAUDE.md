# Aurelio Dashboard - Development Context

## Overview

The Aurelio Dashboard is a secure internal web application that displays pricing intelligence for HidroBio S.A. It provides real-time market analysis, B2B pricing recommendations, and strategy evaluation.

**Live URL:** https://aurelio-pricing-production.up.railway.app

## Architecture

```
agents/aurelio/dashboard/
├── server.js           # Express server with Zoho OAuth
├── package.json        # Dependencies
└── public/
    ├── index.html      # Main dashboard
    ├── login.html      # OAuth login page
    ├── app.js          # Dashboard JavaScript
    ├── styles.css      # Professional styling
    └── hidrobio-logo.svg  # Brand logo
```

## Authentication

Uses Zoho OAuth 2.0 with organization MFA enforcement.

### Zoho API Client (Aurelio-specific)

| Setting | Value |
|---------|-------|
| Client ID | `1000.8XZO7ETCBU6P82DI7ZMLSBM00DEAGF` |
| Redirect URI | `https://aurelio-pricing-production.up.railway.app/auth/callback` |
| Scopes | `ZohoBooks.fullaccess.all`, `ZohoCRM.modules.ALL` |

**Important:** This client is separate from the main zoho-mcp client. Created specifically for Aurelio dashboard to have its own OAuth redirect.

### User Access

All `@hidrobio.com.py` email addresses are automatically allowed. The `isAllowedUser()` function in server.js handles authorization:

```javascript
function isAllowedUser(email) {
  if (!email) return false;
  const emailLower = email.toLowerCase();
  if (emailLower.endsWith('@hidrobio.com.py')) return true;
  return ALLOWED_USERS.some(allowed => allowed.toLowerCase() === emailLower);
}
```

## Railway Deployment

### Service Configuration

| Setting | Value |
|---------|-------|
| Service | `aurelio-pricing` |
| Region | us-west1 |
| Port | 3000 |
| Root Directory | `agents/aurelio/dashboard` |
| Start Command | `node server.js` |

### Persistent Storage

A Railway Volume is mounted at `/app/data` to persist the SQLite database across deployments.

| Volume | Mount Path |
|--------|------------|
| `aurelio-pricing-volume` | `/app/data` |

The database path in aurelio.mjs checks for `/app/data/aurelio.db` first (Railway), then falls back to `./aurelio.db` (local development).

### Environment Variables (Railway)

```
ZOHO_CLIENT_ID=1000.8XZO7ETCBU6P82DI7ZMLSBM00DEAGF
ZOHO_CLIENT_SECRET=8d134bff5a251145c388df6eed518412b03dbad313
ZOHO_REFRESH_TOKEN=<from zoho-mcp .env>
ZOHO_ORG_ID=862876482
ZOHO_DC=.com
JWT_SECRET=<generate secure random string>
ANTHROPIC_API_KEY=<from zoho-mcp .env>
ZOHO_SMTP_USER=daniel@hidrobio.com.py
ZOHO_SMTP_PASSWORD=<from zoho-mcp .env>
EMAIL_FROM=aurelio@hidrobio.com.py
EMAIL_TO=daniel@hidrobio.com.py
PORT=3000
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/auth/login` | GET | No | Start Zoho OAuth flow |
| `/auth/callback` | GET | No | OAuth callback handler |
| `/auth/logout` | GET | Yes | Clear session and logout |
| `/auth/me` | GET | Yes | Get current user info |
| `/api/health` | GET | No | Health check for Railway |
| `/api/latest-report` | GET | Yes | Get latest analysis + prices |
| `/api/prices/today` | GET | Yes | Get today's prices only |
| `/api/status` | GET | Yes | System status |
| `/api/run-analysis` | POST | Yes | Trigger analysis (rate limited) |
| `/ws/progress` | WS | Yes | Real-time progress updates |

## Key Features

### 1. Dashboard Sections

- **Stats Bar** - Prices collected, supermarkets, products monitored
- **Executive Summary** - AI-generated market overview
- **Product Cards** - Per-product analysis with median, trends, floor prices, B2B bands
- **Strategy Implementation** - Compares sold prices vs recommendations
- **Market Alerts** - Orange-highlighted warnings
- **Weekly Recommendation** - Strategic advice
- **Raw Prices** - Collapsible per-supermarket data

### 2. Run Now Button

Triggers immediate price analysis with WebSocket progress updates. Rate-limited to prevent abuse.

### 3. Real-time Updates

Dashboard auto-refreshes when new analysis is available. Uses SSE (Server-Sent Events) for progress monitoring during manual runs.

## Price Normalization

### Bandeja (Package) Detection

Critical for accurate price-per-kg comparison. Products sold in packages (bandejas) need normalization:

| Product Type | Typical Package Size |
|--------------|---------------------|
| Cherry tomatoes | 300g standard, 500g family (estimated based on price range) |
| Regular lettuce | 200-250g per head |
| Premium lettuce | 250-300g per head |

The `normalizePricePerKg()` function in `aurelio.mjs` handles this:

```javascript
// Cherry tomato bandeja detection
if (nameLower.includes('cherry')) {
  const isBandeja = nameLower.includes('bandeja') || nameLower.includes('pack');
  if (isBandeja || (price >= 8000 && price <= 25000)) {
    // Estimate: 500g if price 15k-25k, otherwise 300g
    const assumedGrams = (price >= 15000 && price <= 25000) ? 500 : 300;
    const pricePerKg = Math.round(price * (1000 / assumedGrams));
    return { price: pricePerKg, normalized: true, packageSize: `~${assumedGrams}g bandeja` };
  }
}
```

**Note:** User feedback emphasized: "Not everything is sold per 1kg - pay attention to units of sale."

## Design System

### Brand Colors

```css
--hb-green-dark: #1a5c1f;
--hb-green-medium: #2e7d32;
--hb-green-light: #4CAF50;
--hb-green-pale: #e8f5e9;
```

### Typography

- **Font:** Inter (Google Fonts)
- **Weights:** 400 (regular), 500 (medium), 600 (semibold), 700 (bold)

### Icons

All icons are inline SVG from Material Design Icons set. No external dependencies.

## Common Issues & Solutions

### 1. "Invalid Redirect URI" Error

The Zoho OAuth client must have the exact callback URL configured:
- Production: `https://aurelio-pricing-production.up.railway.app/auth/callback`
- Local: `http://localhost:3000/auth/callback`

### 2. "Tu cuenta no tiene acceso" Error

User's email not in allowed list. Check `isAllowedUser()` function in server.js. All @hidrobio.com.py emails are allowed.

### 3. Database Not Persisting

Verify Railway Volume is mounted at `/app/data`. Check with:
```bash
railway run ls -la /app/data
```

### 4. ZOHO_CONFIG null on Railway

The server falls back to `process.env` when no `.env` file exists:
```javascript
if (!ZOHO_CONFIG && process.env.ZOHO_CLIENT_ID) {
  ZOHO_CONFIG = {
    ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID,
    // ... etc
  };
}
```

## Deployment Commands

```bash
# Deploy to Railway
cd agents/aurelio/dashboard
railway up

# View logs
railway logs

# Check service status
railway status

# Add environment variable
railway variables set KEY=value
```

## Related Files

| File | Purpose |
|------|---------|
| `agents/aurelio/aurelio.mjs` | Main Aurelio agent with PriceDatabase, scrapers, analysis |
| `agents/zoho-mcp/.env` | Source of API credentials |
| `media/logos/hidrobio-logo.svg` | Brand logo source |

## Security

- HMAC-SHA256 signed JWT sessions (24h expiry)
- HttpOnly + SameSite=Lax cookies
- Email domain whitelist (@hidrobio.com.py)
- Rate limiting on /api/run-analysis (1 per 5 min)
- HTTPS via Railway TLS
- No credentials stored client-side

## Monitoring

- Railway dashboard: https://railway.app (project: aurelio-pricing)
- Service health: `/auth/me` endpoint returns 401 if auth is working
- Database: Check `/api/latest-report` for most recent analysis

---

*Last updated: January 2026*
