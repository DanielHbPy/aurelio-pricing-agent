# Aurelio - Elite Pricing Intelligence Agent

**Named after Marcus Aurelius** - embodying wisdom, strategic thinking, and disciplined analysis.

Aurelio is HidroBio's autonomous pricing intelligence agent that:
1. Monitors daily supermarket consumer prices (Stock, Superseis, Casa Rica, Salemma)
2. Calculates market medians for each product category
3. Uses Claude AI to generate strategic B2B pricing recommendations
4. Compares recommendations against actual Zoho Books sales data
5. Outputs weekly pricing guidance for updating the Calculadora de Precios

## Key Files

| File | Description |
|------|-------------|
| `aurelio.mjs` | Main entry point - Node.js scraper + Claude analysis (2800+ lines) |
| `data/aurelio.db` | SQLite database with prices, analysis, alerts |
| `AURELIO.md` | Detailed agent documentation |
| `AURELIO-ROADMAP.md` | Future development roadmap |

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

# Daemon mode (Railway deployment)
npm start                # Scheduled: daily 05:00, weekly Thursday 15:00
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

| Supermarket | Status | Method | Notes |
|-------------|--------|--------|-------|
| **Stock** | Active | Cheerio/Node.js | nopCommerce site |
| **Superseis** | Active | Cheerio/Node.js | `data-product-id` attrs |
| **Casa Rica** | Active | Cheerio/Node.js | Longer timeout |
| **Salemma** | Active | Cheerio/Node.js | Laravel category pages |

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

## Railway Deployment

```bash
railway login
railway init
railway up
```

The agent runs in daemon mode with:
- Daily scraping at 05:00 PYT
- Weekly analysis on Thursday 15:00 PYT
- Hourly heartbeat logging

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

---

*Last updated: January 27, 2026*
