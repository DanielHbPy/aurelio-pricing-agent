# Aurelio - Elite Pricing Intelligence Agent

**Named after Marcus Aurelius** - embodying wisdom, strategic thinking, and disciplined analysis.

Aurelio is HidroBio's autonomous pricing intelligence agent that:
1. Monitors daily supermarket consumer prices (Stock, Superseis, Casa Rica)
2. Calculates market medians for each product category
3. Uses Claude AI to generate strategic B2B pricing recommendations
4. Outputs weekly pricing guidance for updating the Calculadora de Precios

## Key Files

| File | Description |
|------|-------------|
| `aurelio.mjs` | Main entry point - Node.js scraper + Claude analysis |
| `main.py` | Legacy Python scraper (deprecated) |
| `scrapers/` | Python scrapers for each supermarket |
| `utils/database.py` | SQLite price database |
| `utils/analytics_sync.py` | Zoho Analytics sync |
| `AURELIO.md` | Detailed agent documentation |

## Pricing Model

HidroBio sells B2B at prices calculated as **% of market median** (supermarket consumer price):

| Segment | Target % | Min % | Max % | Min Margin |
|---------|----------|-------|-------|------------|
| **S1 Consumidor Final** | 90% | 85% | 95% | 25% |
| **S2 HORECA** | 75% | 70% | 80% | 20% |
| **S3 Supermercados** | 68% | 60% | 75% | 15% |
| **S4 Institucional** | 60% | 55% | 65% | 10% |
| **S5 Mayorista** | 50% | 45% | 55% | EVITAR |

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

## Running Aurelio

```bash
# Single run (testing)
node aurelio.mjs --now

# Run with scheduler (08:00 Paraguay time)
node aurelio.mjs --schedule

# Daemon mode (for Railway)
node aurelio.mjs --daemon
```

## Railway Deployment

**Environment Variables:**
```bash
# Zoho OAuth
ZOHO_CLIENT_ID=xxx
ZOHO_CLIENT_SECRET=xxx
ZOHO_REFRESH_TOKEN=xxx
ZOHO_DC=.com

# Anthropic
ANTHROPIC_API_KEY=xxx

# Zoho SMTP Email
ZOHO_SMTP_USER=daniel@hidrobio.com.py
ZOHO_SMTP_PASSWORD=<zoho-app-password>
EMAIL_TO=daniel@hidrobio.com.py
```

**Deploy:**
```bash
railway login
railway init
railway up
```

## Output Example

```
════════════════════════════════════════════════════════════════════════════════
  AURELIO - REPORTE DE PRECIOS PARA ACTUALIZAR CALCULADORA
  lunes, 27 de enero de 2026
════════════════════════════════════════════════════════════════════════════════

┌─────────────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│      PRODUCTO       │   MEDIANA    │  CONS.FINAL  │    HORECA    │  SUPERMKTS   │  INSTITUC.   │
│                     │  (Mercado)   │    (90%)     │    (75%)     │    (68%)     │    (60%)     │
├─────────────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Tomate Lisa         │       15,200 │       13,680 │       11,400 │       10,336 │        9,120 │
│ Locote Amarillo     │       48,500 │       43,650 │       36,375 │       32,980 │       29,100 │
│ Lechuga Pirati      │        4,500 │        4,050 │        3,375 │        3,060 │        3,000 │
└─────────────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
```

## Database

SQLite database: `data/prices.db`

```python
from utils.database import PriceDatabase
db = PriceDatabase()
prices = db.get_today_prices()
```

## Zoho Analytics Integration

Prices automatically sync to Zoho Analytics after each scraping run.

**Table:** `Precios Supermercados` (ID: `2849493000003555002`)

| Column | Type | Description |
|--------|------|-------------|
| Fecha | Date | Price date |
| Supermercado | Text | Supermarket name |
| Producto | Text | Standardized product name |
| Producto_Raw | Text | Original scraped product name |
| Precio_Gs | Number | Price in Guaranies |
| Unidad | Text | Unit (kg, unit) |

**Manual Sync:**
```bash
# Sync today's prices
python3 utils/analytics_sync.py

# Sync all historical data
python3 utils/analytics_sync.py --all --truncate

# Sync last 7 days
python3 utils/analytics_sync.py --days 7
```

## Email Configuration

- **SMTP Host:** smtp.zoho.com:587 (TLS)
- **Sender:** daniel@hidrobio.com.py
- **Auth:** Zoho app password (Zoho > Security > App Passwords)

## Biggie Scraping (Chrome MCP)

Biggie requires JavaScript rendering. Use Claude Chrome MCP:

1. Navigate to: `https://biggie.com.py/products/fruteria-y-verduleria?skip=0`
2. Scroll through pages to find products
3. Manually add prices to database

---

*Last updated: January 26, 2026*
