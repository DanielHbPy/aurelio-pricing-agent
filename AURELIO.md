# AURELIO - Elite Pricing Intelligence Agent

**Named after Marcus Aurelius - embodying wisdom, strategic thinking, and disciplined analysis.**

Aurelio is HidroBio's autonomous pricing intelligence agent that monitors competitor prices, analyzes market conditions, and generates strategic pricing recommendations aligned with the premium positioning strategy.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AURELIO AGENT (Railway Cloud)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│  │    Stock     │    │  Superseis   │    │  Casa Rica   │  ... más         │
│  │   Scraper    │    │   Scraper    │    │   Scraper    │                  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                  │
│         │                   │                   │                          │
│         └───────────────────┼───────────────────┘                          │
│                             ▼                                              │
│                    ┌────────────────┐                                      │
│                    │   SQLite DB    │                                      │
│                    │  (aurelio.db)  │                                      │
│                    └────────┬───────┘                                      │
│                             │                                              │
│         ┌───────────────────┼───────────────────┐                          │
│         ▼                   ▼                   ▼                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                   │
│  │    Claude    │   │    Zoho      │   │    Email     │                   │
│  │  Reasoning   │   │  Analytics   │   │   Report     │                   │
│  │   Engine     │   │    Sync      │   │  Generator   │                   │
│  └──────────────┘   └──────────────┘   └──────────────┘                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Features

### 1. Market Price Monitoring
- Scrapes daily prices from major Asuncion supermarkets:
  - **Stock** (nopCommerce platform)
  - **Superseis** (custom e-commerce)
  - **Casa Rica** (WordPress/WooCommerce)
- Tracks 7 product categories:
  - Tomate Lisa, Tomate Perita, Tomate Cherry
  - Locote Rojo, Locote Amarillo
  - Lechuga Pirati
  - Verdeos (perejil, cilantro, etc.)

### 2. AI-Powered Analysis (Claude)
- Uses Claude Sonnet for strategic reasoning
- Analyzes market trends and competitor positioning
- Generates segment-specific price recommendations:
  - **S1 Consumidor Final** (90% of median)
  - **S2 HORECA** (75% of median)
  - **S3 Supermercados** (68% of median)
  - **S4 Institucional** (60% of median)
  - **S5 Mayorista** (50% of median - AVOID)

### 3. Premium Positioning Logic
Embedded pricing rules from HidroBio's strategy:
- **Piso Absoluto**: Floor price per product (never sell below)
- **Minimum Margins**: 25% for premium, 15% for volume segments
- **Never cheapest**: Position as quality, not price leader
- **Mediano discounts**: -11% to -16% for smaller grade products

### 4. Data Sync
- Stores all prices in local SQLite database
- Syncs to Zoho Analytics for BI dashboards
- Enables comparison: HidroBio prices vs. market

## Installation

### Local Development

```bash
cd price-monitor

# Install dependencies
npm install

# Run immediately (testing)
npm run run-now

# Run with scheduler (08:00 Paraguay time)
npm run schedule
```

### Railway Deployment

1. **Create Railway project:**
```bash
# In the price-monitor directory
railway login
railway init
```

2. **Set environment variables in Railway dashboard:**
```bash
# Zoho OAuth
ZOHO_CLIENT_ID=xxx
ZOHO_CLIENT_SECRET=xxx
ZOHO_REFRESH_TOKEN=xxx
ZOHO_DC=.com

# Anthropic
ANTHROPIC_API_KEY=xxx

# Email (optional)
SMTP_USER=daniel@hidrobio.com.py
SMTP_PASSWORD=xxx
```

3. **Deploy:**
```bash
railway up
```

Or connect to GitHub for auto-deploy on push.

## Configuration

All configuration is in `aurelio.mjs` under the `CONFIG` object:

### Products (from Calculator v4)

| Product | Cost (Gs.) | Floor (Gs.) | Market Median |
|---------|-----------|-------------|---------------|
| Tomate Lisa | 6,926 | 8,500 | 14,950 |
| Tomate Perita | 6,926 | 8,500 | 6,950 |
| Locote Rojo | 12,114 | 15,000 | 26,900 |
| Locote Amarillo | 12,114 | 15,000 | 47,900 |
| Lechuga Pirati | 2,500 | 3,000 | 4,500 |
| Verdeos | 1,500 | 1,800 | 3,500 |

### Segment Pricing Model

Based on **% of Market Median** (not cost-plus):

| Segment | Min % | Target % | Max % | Min Margin |
|---------|-------|----------|-------|------------|
| Consumidor Final | 85% | 90% | 95% | 25% |
| HORECA | 70% | 75% | 80% | 20% |
| Supermercados | 60% | 68% | 75% | 15% |
| Institucional | 55% | 60% | 65% | 10% |
| Mayorista | 45% | 50% | 55% | 5% |

## Database Schema

### `prices` table
```sql
id, date, supermarket, product, product_name_raw, price_guaranies, unit
```

### `analysis` table
```sql
id, date, product, market_median, market_min, market_max,
hidrobio_recommended_price, hidrobio_recommended_margin, reasoning
```

### `alerts` table
```sql
id, date, alert_type, product, supermarket, message, severity
```

## Output Example

```
🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿

  AURELIO - Elite Pricing Intelligence Agent
  HidroBio S.A. | 25/1/2026, 08:00:00

🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿

[Aurelio] 📡 Paso 1: Recolectando precios del mercado...
[Aurelio]   → Escaneando Stock...
[Aurelio]   → Escaneando Superseis...
[Aurelio]   → Escaneando Casa Rica...
[Aurelio] ✅ Recolectados 23 precios

[Aurelio] 💾 Paso 2: Guardando en base de datos...
[Aurelio] ☁️ Paso 3: Sincronizando con Zoho Analytics...
[Aurelio] Synced 23 prices to Zoho Analytics

[Aurelio] 🧠 Paso 4: Analizando con inteligencia artificial...
[Aurelio] Análisis completado exitosamente

[Aurelio] 📧 Paso 5: Generando reporte...

================================================================================
📧 REPORTE DE EMAIL - 📊 [Aurelio] Análisis de Precios - sábado, 25 de enero de 2026
================================================================================

📝 RESUMEN EJECUTIVO:
El mercado de hortalizas en Asunción muestra estabilidad en tomates con
precios de Tomate Lisa manteniéndose altos (mediana Gs. 15,200). Locote
Amarillo presenta oportunidad de posicionamiento premium dado el spread
significativo entre costo (Gs. 12,114) y precio de mercado (Gs. 48,500).

💰 RECOMENDACIONES POR PRODUCTO:

  Tomate Lisa:
    Mercado (mediana): Gs. 15,200
    → Redistribuidores: N/A (evitar)
    → Supermercados: Gs. 10,336
    → HORECA: Gs. 11,400
    → Consumidor Final: Gs. 13,680
    📝 Premium positioning justified by quality differential. Market
       median 120% above cost provides healthy margin across all segments.
```

## Monitoring

### Railway Logs
```bash
railway logs
```

### Heartbeat
The agent logs a heartbeat every hour when running in daemon mode:
```
[Aurelio] 💓 Heartbeat - 25/1/2026, 09:00:00
```

### Zoho Analytics
Prices sync to table: **Precios Supermercados** (ID: `2849493000003555002`)

Query: `HB vs Mercado - Comparacion Precios` joins with HidroBio sales data.

## Troubleshooting

### Scraper failures
- Check if supermarket website changed structure
- Increase timeout for slow sites (Casa Rica)
- Review selector patterns in `SCRAPERS` object

### Zoho sync failures
- Verify refresh token is valid
- Check OAuth scopes include Analytics API
- Confirm table ID exists

### Claude analysis errors
- Check ANTHROPIC_API_KEY is set
- Review JSON parsing errors in logs
- Validate system prompt format

## Contact

**Daniel Stanca** - daniel@hidrobio.com.py
**HidroBio S.A.** - Nueva Italia, Paraguay
