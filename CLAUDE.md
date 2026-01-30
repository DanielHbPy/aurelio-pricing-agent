# Aurelio - Elite Pricing Intelligence Agent

**Named after Marcus Aurelius** - embodying wisdom, strategic thinking, and disciplined analysis.

Aurelio is HidroBio's autonomous pricing intelligence agent that:
1. Monitors daily supermarket consumer prices (Stock, Superseis, Casa Rica, Biggie, Supermas, Real)
2. Calculates market medians for each product category
3. Uses Claude AI to generate strategic B2B pricing recommendations
4. Compares recommendations against actual Zoho Books sales data
5. Outputs weekly pricing guidance for updating the Calculadora de Precios
6. **Web Dashboard** - Secure internal dashboard for viewing analysis (Zoho OAuth + MFA)

## Key Files

| File | Description |
|------|-------------|
| `aurelio.mjs` | Main agent - Node.js scraper + Claude analysis (3000+ lines) |
| `index.mjs` | **Combined entry point for Railway** - spawns daemon + dashboard |
| `data/aurelio.db` | SQLite database with prices, analysis, alerts, weekly_reports |
| `dashboard/` | Web dashboard server (Zoho OAuth protected) |
| `dashboard/server.mjs` | Express server with WebSocket for real-time updates |
| `dashboard/public/` | Frontend (index.html, styles.css, app.js) |
| `scrapers/government-prices.mjs` | SIMA/DAMA wholesale price scraper |
| `CLAUDE.md` | This documentation |

### Entry Point (index.mjs)
Railway runs `npm start` → `node index.mjs` which:
1. Spawns `aurelio.mjs --daemon` (scheduled scraping + analysis)
2. Spawns `dashboard/server.mjs` (web server on port 3000)
3. Forwards stdout/stderr from both processes

## Running Aurelio

### Production Commands

```bash
cd agents/aurelio

# Price scraping only (runs daily at 05:00 PYT)
npm run scrape

# Full weekly analysis with AI + email report
npm run run-now          # or: node aurelio.mjs --now

# Team introduction email
npm run intro            # Sends Aurelio introduction to team

# Daily snapshot report
npm run daily-report     # Market snapshot with prices collected

# Weekly analysis report
npm run weekly-report    # Full AI analysis + recommendations

# Combined mode (Railway deployment) - runs daemon + web dashboard
npm start                # Daemon + Dashboard on port 3000

# Daemon only mode
npm run start:daemon     # Scheduled: daily 05:00, weekly Thursday 15:00

# Dashboard only mode
npm run start:dashboard  # Web dashboard on port 3000
```

### CLI Options

```bash
node aurelio.mjs --help     # Show all options
node aurelio.mjs --now      # Full analysis immediately
node aurelio.mjs --scrape   # Scrape only (no AI analysis)
node aurelio.mjs --schedule # Run with scheduler
node aurelio.mjs --daemon   # Daemon mode for Railway
node aurelio.mjs --intro    # Send team introduction email
node aurelio.mjs --daily-report   # Send daily market snapshot
node aurelio.mjs --weekly-report  # Send weekly AI analysis
```

## Schedule (Paraguay Time - UTC-4)

| Task | Schedule | Description |
|------|----------|-------------|
| **Daily Scrape** | 05:00 PYT | Collect prices from 4 supermarkets, save to DB |
| **Weekly Analysis** | Thursday 15:00 PYT | Full AI analysis + Zoho Books comparison + email |

## Pricing Model

HidroBio sells B2B at prices calculated as **% of market median** (supermarket consumer price):

| Segment | Target % | Min % | Max % | Min Margin |
|---------|----------|-------|-------|------------|
| **S1 Consumidor Final** | 90% | 85% | 95% | 25% |
| **S2 HORECA** | 75% | 70% | 80% | 20% |
| **S3 Supermercados** | 68% | 60% | 75% | 15% |
| **S4 Institucional** | 60% | 55% | 65% | 10% |
| **S5 Mayorista** | 50% | 45% | 55% | EVITAR |

**Golden Rule:** The **Piso Absoluto** (floor price) is sacred - never sell below cost + minimum margin.

## Products Monitored

| Product | Cost (Gs.) | Piso Absoluto | Market Median Ref |
|---------|-----------|---------------|-------------------|
| Tomate Lisa | 6,926 | 8,500 | 14,950 |
| Tomate Perita | 6,926 | 8,500 | 6,950 |
| Tomate Cherry | 10,000 | 12,000 | 18,000 |
| Locote Rojo | 12,114 | 15,000 | 26,900 |
| Locote Amarillo | 12,114 | 15,000 | 47,900 |
| Lechuga Pirati | 2,500 | 3,000 | 4,500 |
| Verdeos | 1,500 | 1,800 | 3,500 |

## Supermarket Coverage

### Active Scrapers (13 supermarkets)

| Supermarket | Status | Method | Notes |
|-------------|--------|--------|-------|
| **Stock** | ✅ Active | Cheerio | nopCommerce site |
| **Superseis** | ✅ Active | Cheerio | `data-product-id` attrs |
| **Casa Rica** | ✅ Active | Cheerio | Longer timeout |
| **Biggie** | ✅ Active | REST API | Public API at `api.app.biggie.com.py` |
| **Supermas** | ✅ Active | Cheerio | PHP ecommerce, clean HTML |
| **Real** | ✅ Active | GraphQL API | Instaleap API at `nextgentheadless.instaleap.io` |
| **Areté** | ✅ Active | Cheerio | MASCREATIVO ECOMMERCE PRO platform |
| **San Cayetano** | ✅ Active | Cheerio | MASCREATIVO platform, same as Areté |
| **Casa Grütter** | ✅ Active | Cheerio | WooCommerce site |
| **Salemma** | ✅ Active | Cheerio | Laravel platform, redirect bug fixed (2026-01-30) |
| **Los Jardines** | ✅ Active | Cheerio | MASCREATIVO platform, verduras-c57 category (2026-01-30) |
| **Gran Via** | ✅ Active | REST API | VitalSoftware React SPA with public API (2026-01-30) |
| **Pryca** | ✅ Active | Cheerio + Session | Pegasus/Adianti - session cookie required (2026-01-30) |

### Disabled Scrapers

| Supermarket | Issue | Tech Stack |
|-------------|-------|------------|
| **La Bomba** | No fresh produce category | Pegasus Ecommerce (only processed foods) |
| **Fortis** | Site appears down | Unknown (was Rails + Turbo) |

### Research Notes (Future Expansion)

**Potential additions (need investigation):**
- Megaredil - unconfirmed ecommerce
- Delimarket - unconfirmed ecommerce
- Río Supermarket - unconfirmed ecommerce

**No ecommerce (skip):**
- Fortis: Only processed foods in ecommerce, no fresh produce category
- Pueblo, La Familia, La Rioja, Los Colonos, España, Carmelitas
- Multimarket, Norte - no online presence found

**Platform Reference:**
- MASCREATIVO ECOMMERCE PRO: Areté, San Cayetano, Los Jardines (easy to scrape)
- WooCommerce: Casa Rica, Casa Grütter
- Pegasus Ecommerce: Pryca (session cookie method), La Bomba (no produce)
- Instaleap: Real (GraphQL API)
- Custom: Stock (nopCommerce), Superseis, Salemma (Laravel)
- VitalSoftware: Gran Via (React SPA + REST API)

## Environment Variables

Aurelio loads credentials from `agents/zoho-mcp/.env`:

```bash
# Zoho OAuth (for Books API - sales data)
ZOHO_CLIENT_ID=xxx
ZOHO_CLIENT_SECRET=xxx
ZOHO_REFRESH_TOKEN=xxx
ZOHO_ORG_ID=862876482
ZOHO_DC=.com

# Anthropic Claude AI
ANTHROPIC_API_KEY=sk-ant-xxx

# Email (Zoho SMTP)
ZOHO_SMTP_USER=daniel@hidrobio.com.py
ZOHO_SMTP_PASSWORD=<zoho-app-password>
EMAIL_FROM=aurelio@hidrobio.com.py
EMAIL_TO=daniel@hidrobio.com.py
```

## Report Types

### 1. Team Introduction (`--intro`)
Beautiful HTML email introducing Aurelio to the team:
- Explains Aurelio's purpose and capabilities
- Shows the pricing strategy by segment
- Displays current system status
- Lists the work schedule

### 2. Daily Report (`--daily-report`)
Market snapshot email showing:
- Quick stats (prices collected, supermarkets, products)
- Market medians by product with min/max ranges
- Prices organized by supermarket
- Recent alerts

### 3. Weekly Analysis (`--now` or `--weekly-report`)
Comprehensive AI-powered analysis:
- Executive summary of market conditions
- Pricing recommendations by segment (min/target/max bands)
- Margin calculations vs. HidroBio cost structure
- **Strategy Implementation Analysis** - compares actual Zoho Books sales against recommendations
- Evaluation per product (Excelente/Bueno/Aceptable/Bajo/Crítico)
- Actionable recommendations for commercial team

## Output Example

```
════════════════════════════════════════════════════════════════════════════════
  📊 AURELIO - REPORTE DE PRECIOS PARA ACTUALIZAR CALCULADORA
  martes, 27 de enero de 2026
════════════════════════════════════════════════════════════════════════════════

📝 RESUMEN EJECUTIVO:
Mercado de tomates estable con precios consolidados alrededor de Gs. 17,950...

┌─────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│      PRODUCTO       │   MEDIANA    │  CONS.FINAL  │    HORECA    │  SUPERMKTS   │  INSTITUC.   │
├─────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Tomate Lisa         │       17,950 │       16,155 │       13,463 │       12,206 │       10,770 │
│ Locote Amarillo     │       39,950 │       35,955 │       29,963 │       27,166 │       23,970 │
└─────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘

📈 ANÁLISIS DE IMPLEMENTACIÓN DE ESTRATEGIA
┌─────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│      PRODUCTO       │  PRECIO VEND │   % MEDIANA  │  EVALUACIÓN  │   CANTIDAD   │
├─────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Tomate Lisa         │   Gs. 12,828 │        71.5% │ ✅ Bueno     │         1353 │
│ Locote Amarillo     │   Gs. 27,040 │        67.7% │ ✅ Bueno     │         29.6 │
└─────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
```

## Database Schema

SQLite database: `data/aurelio.db`

| Table | Purpose |
|-------|---------|
| `prices` | Daily scraped prices (date, supermarket, product, price, unit) |
| `analysis` | AI analysis results (median, recommendations, reasoning) |
| `alerts` | System alerts and warnings |

## Zoho Analytics Integration

Prices sync to Zoho Analytics after each scraping run.

**Table:** `Precios Supermercados` (ID: `2849493000003555002`)

| Column | Type | Description |
|--------|------|-------------|
| Fecha | Date | Price date |
| Supermercado | Text | Supermarket name |
| Producto | Text | Standardized product name |
| Producto_Raw | Text | Original scraped product name |
| Precio_Gs | Number | Price in Guaranies |
| Unidad | Text | Unit (kg, unit) |

## Web Dashboard

Aurelio includes a secure web dashboard at `dashboard/`:

**Features:**
- Visual pricing analysis matching email template
- Zoho OAuth authentication (inherits organization MFA)
- "Run Now" button to trigger immediate analysis
- Real-time WebSocket progress updates

**Access:** Only HidroBio leadership team (5 whitelisted emails)

**URL:** `https://aurelio.hidrobio.com.py` (after Railway custom domain setup)

See `dashboard/CLAUDE.md` for full documentation.

## Railway Deployment

### Project Details
- **Project:** `aurelio-pricing` (NOT `aurelio-pricing-agent`)
- **Production URL:** `https://aurelio-pricing-production.up.railway.app`
- **GitHub Repo:** `DanielHbPy/aurelio-pricing-agent`
- **Auto-deploy:** Enabled (pushes to main trigger deploy)

### Volume Mount
```
/app/data/aurelio.db → Railway Volume
```
SQLite database persists across deployments via Railway volume.

### Login Commands
```bash
cd agents/aurelio

# IMPORTANT: Use --browserless flag (no browser popup)
npx railway login --browserless
# → Enter code at railway.app/cli-verify

# Link to existing project
npx railway link

# Deploy
npx railway up

# View logs
npx railway logs
```

### Deployment Process
```bash
# After code changes:
git add -A && git commit -m "message" && git push

# Railway auto-deploys from GitHub
# Or manual deploy:
npx railway up
```

The service runs both daemon and dashboard:
- **Daemon:** Daily scraping at 05:00 PYT, weekly analysis Thursday 15:00 PYT
- **Dashboard:** Web server on port 3000 with health check at `/api/health`
- Hourly heartbeat logging

## Aurelio v2.0 Features (January 2026)

### New Capabilities
1. **Customer Lifecycle Analysis** - Integrates CRM data to show customer engagement
   - Active customers (purchased last 30 days)
   - At-risk customers (31-60 days)
   - Inactive customers (61-90 days)
   - Purchased this week count

2. **Government Wholesale Prices** - SIMA/DAMA integration
   - Scrapes Paraguay's official wholesale market prices
   - Used as additional reference for pricing decisions
   - File: `scrapers/government-prices.mjs`

3. **Enhanced Dashboard**
   - Customer analysis section with engagement stats
   - PDF export button (client-side)
   - Email-to-self button
   - Real-time WebSocket progress during analysis

### Dashboard Sections
1. **Stats Bar** - Prices collected, supermarkets, products, next analysis time
2. **Resumen Ejecutivo** - AI-generated market summary
3. **Análisis por Producto** - Product cards with:
   - Market median, trend, floor price
   - B2B pricing bands by segment
   - HidroBio sales data (last week)
   - AI evaluation and insights
4. **Customer Analysis** - Engagement metrics from CRM

## Troubleshooting

### Email not sending
1. Check `agents/zoho-mcp/.env` has SMTP credentials
2. Verify `ZOHO_SMTP_PASSWORD` is a Zoho app password (not account password)
3. Check `EMAIL_TO` is set correctly

### No prices collected
1. Run `npm run scrape` to test scraping
2. Check supermarket websites are accessible
3. Review console output for errors

### AI analysis fails
1. Verify `ANTHROPIC_API_KEY` is set
2. Check for rate limiting
3. Ensure prices exist in database

### Railway build fails
1. Ensure `index.mjs` is committed (combined entry point)
2. Check all dependencies in `package.json`
3. Verify Railway volume mount for `/app/data`

### Dashboard shows "Error al procesar"
1. Click "Ejecutar Ahora" to run fresh analysis
2. Check Railway logs: `npx railway logs`
3. Verify database has prices: run scrape first if empty

### Common URL Mistake
- **Correct:** `aurelio-pricing-production.up.railway.app`
- **Wrong:** `aurelio-pricing-agent-production.up.railway.app` (extra "agent")

---

*Last updated: January 30, 2026 (added Pryca with session cookie handling, Gran Via, Los Jardines, re-enabled Salemma - now 13 active supermarkets, 76 prices)*
