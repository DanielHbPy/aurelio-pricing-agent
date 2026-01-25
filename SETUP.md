# HidroBio Price Monitor - Setup Guide

## Quick Start

1. **Install dependencies:**
   ```bash
   cd price-monitor
   pip3 install -r requirements.txt
   ```

2. **Test run:**
   ```bash
   python3 main.py
   ```

3. **Test email (after configuring SMTP):**
   ```bash
   python3 main.py --test-email
   ```

## Email Configuration

The email report requires SMTP credentials. Set these environment variables:

```bash
export SMTP_USER="your-email@hidrobio.com.py"
export SMTP_PASSWORD="your-app-password"
```

For Zoho Mail, create an App Password:
1. Go to Zoho Mail > Settings > Security > App Passwords
2. Generate a new app password for "Price Monitor"
3. Use that password (not your login password)

### Alternative: Gmail SMTP

Update `config.yaml`:
```yaml
email:
  recipient: daniel@hidrobio.com.py
  sender: your-gmail@gmail.com
  smtp_host: smtp.gmail.com
  smtp_port: 587
```

For Gmail, enable 2FA and create an App Password:
1. Go to Google Account > Security > App Passwords
2. Generate password for "Mail" on "Mac"

## Daily Scheduling (macOS)

To run the price monitor automatically every day at 8:00 AM:

1. **Copy the plist to LaunchAgents:**
   ```bash
   cp com.hidrobio.pricemonitor.plist ~/Library/LaunchAgents/
   ```

2. **Load the scheduler:**
   ```bash
   launchctl load ~/Library/LaunchAgents/com.hidrobio.pricemonitor.plist
   ```

3. **Verify it's loaded:**
   ```bash
   launchctl list | grep hidrobio
   ```

### Unload (to stop daily runs):
```bash
launchctl unload ~/Library/LaunchAgents/com.hidrobio.pricemonitor.plist
```

### Run manually:
```bash
launchctl start com.hidrobio.pricemonitor
```

## Supermarket Coverage

Currently enabled:
- **Stock** (stock.com.py) - Working
- **Superseis** (superseis.com.py) - Working

Disabled (need browser automation for JavaScript-heavy sites):
- Biggie (biggie.com.py) - Vue/Nuxt.js SPA
- Salemma, Fortis, Casa Rica - URL verification needed

## Data Storage

- **Database:** `data/prices.db` (SQLite)
- **Logs:** `data/monitor.log`

## Viewing Historical Data

```python
from utils.database import PriceDatabase

db = PriceDatabase()

# Get today's prices
prices = db.get_today_prices("Tomate Lisa")
for p in prices:
    print(f"{p['supermarket']}: {p['price']:,} Gs")

# Get 7-day trend
trend = db.get_price_trend("Tomate Lisa")
print(f"Trend: {trend['trend']} ({trend['change_percent']}%)")
```

## Troubleshooting

**Email not sending:**
- Check SMTP_USER and SMTP_PASSWORD environment variables
- Verify SMTP settings in config.yaml
- Check data/monitor.log for errors

**No prices found:**
- Supermarket website structure may have changed
- Check internet connection
- Run with verbose logging: `python3 main.py 2>&1 | tee debug.log`

**Scheduler not running:**
- Check: `launchctl list | grep hidrobio`
- View logs: `tail -f data/launchd.log`
- Ensure computer is awake at scheduled time (8:00 AM)
