# Aurelio Railway Deployment Guide

## Quick Deploy Steps

### 1. Create GitHub Repository

```bash
cd /Users/danielstanca/Development/HidroBioAgroparkWithClaude/price-monitor

# Create repo on GitHub (via web or CLI)
# Then push:
git remote add origin https://github.com/YOUR_USERNAME/aurelio-pricing-agent.git
git push -u origin main
```

### 2. Create Railway Project

1. Go to https://railway.app/new
2. Click **"Deploy from GitHub repo"**
3. Select the `aurelio-pricing-agent` repository
4. Railway will auto-detect `nixpacks.toml` and `railway.toml`

### 3. Set Environment Variables

In Railway Dashboard → Your Project → Variables, add:

```
ANTHROPIC_API_KEY=<your-anthropic-api-key>
ZOHO_CLIENT_ID=<your-zoho-client-id>
ZOHO_CLIENT_SECRET=<your-zoho-client-secret>
ZOHO_REFRESH_TOKEN=<your-zoho-refresh-token>
ZOHO_DC=.com
SMTP_USER=daniel@hidrobio.com.py
SMTP_PASSWORD=<your-zoho-app-password>
```

**Note:** Get credentials from `/Users/danielstanca/Development/HidroBioAgroparkWithClaude/zoho-mcp-server/.env`

### 4. Deploy

Railway will automatically deploy when you push to GitHub.

Manual trigger: Railway Dashboard → Deployments → **Deploy**

## Verification

Check logs in Railway Dashboard:
```
[Aurelio] Modo: Daemon (Railway)
[Aurelio] 📡 Paso 1: Recolectando precios del mercado...
[Aurelio]   → Escaneando Stock...
...
[Aurelio] ✅ Recolectados XX precios
[Aurelio] 💓 Heartbeat - DD/MM/YYYY, HH:MM:SS
```

## Schedule

Aurelio runs automatically at **08:00 Paraguay time (UTC-4)** daily.

Heartbeat logged every hour to confirm agent is alive.

## Updating

```bash
cd /Users/danielstanca/Development/HidroBioAgroparkWithClaude/price-monitor
git add -A && git commit -m "Update message" && git push
# Railway auto-deploys
```
