#!/usr/bin/env python3
"""
HidroBio Price Monitor
Daily retail price monitoring for Paraguay supermarkets.

Usage:
    python main.py              # Run once (for testing or manual execution)
    python main.py --schedule   # Run with daily scheduler
    python main.py --test-email # Test email sending
"""

import os
import sys
import logging
import argparse
import statistics
from datetime import datetime
from pathlib import Path

import yaml
import schedule
import time
import pytz

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from scrapers import get_scraper, SCRAPERS
from scrapers.generic import GenericScraper
from utils.database import PriceDatabase
from utils.email_sender import EmailSender
from utils.analytics_sync import (
    load_zoho_credentials, get_access_token, import_to_analytics,
    get_prices_from_sqlite, MARKET_PRICES_TABLE_ID
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(Path(__file__).parent / "data" / "monitor.log")
    ]
)
logger = logging.getLogger(__name__)


class PriceMonitor:
    def __init__(self, config_path: str = None):
        if config_path is None:
            config_path = Path(__file__).parent / "config.yaml"

        with open(config_path) as f:
            self.config = yaml.safe_load(f)

        self.db = PriceDatabase()
        self.email_sender = EmailSender(self.config.get("email", {}))
        self.alert_threshold = self.config.get("alerts", {}).get("threshold_percent", 15)

    def run(self):
        """Run the full price monitoring workflow."""
        logger.info("Starting price monitoring run")

        # 1. Scrape prices from all supermarkets
        all_prices = self._scrape_all_prices()

        # 2. Save to database
        self._save_prices(all_prices)

        # 3. Sync to Zoho Analytics
        self._sync_to_analytics()

        # 4. Generate report data
        report_data = self._generate_report_data()

        # 5. Send email
        if report_data["products"]:
            self.email_sender.send_report(report_data)
            logger.info("Price monitoring run complete")
        else:
            logger.warning("No prices found, skipping email")

    def _scrape_all_prices(self) -> list:
        """Scrape prices from all enabled supermarkets."""
        all_prices = []
        products = self.config.get("products", [])
        supermarkets = self.config.get("supermarkets", [])

        for supermarket_config in supermarkets:
            if not supermarket_config.get("enabled", True):
                continue

            name = supermarket_config.get("name", "")
            logger.info(f"Scraping {name}...")

            try:
                # Get appropriate scraper
                if name in SCRAPERS:
                    scraper = SCRAPERS[name](supermarket_config)
                else:
                    scraper = GenericScraper(supermarket_config)

                # Search for each product
                for product in products:
                    product_name = product.get("name", "")
                    search_terms = product.get("search_terms", [product_name.lower()])

                    for term in search_terms:
                        results = scraper.search(term)

                        for result in results:
                            # Match result to product
                            if self._matches_product(result["name"], product):
                                all_prices.append({
                                    "supermarket": name,
                                    "product": product_name,
                                    "product_name_raw": result["name"],
                                    "price": result["price"],
                                    "unit": product.get("unit", "kg")
                                })

            except Exception as e:
                logger.error(f"Error scraping {name}: {e}")
                continue

        logger.info(f"Total prices collected: {len(all_prices)}")
        return all_prices

    def _matches_product(self, raw_name: str, product: dict) -> bool:
        """Check if a scraped product name matches a target product."""
        raw_lower = raw_name.lower()
        search_terms = product.get("search_terms", [])

        for term in search_terms:
            if term.lower() in raw_lower:
                return True
        return False

    def _save_prices(self, prices: list):
        """Save scraped prices to database."""
        for price_data in prices:
            self.db.save_price(
                supermarket=price_data["supermarket"],
                product=price_data["product"],
                price_guaranies=price_data["price"],
                product_name_raw=price_data.get("product_name_raw"),
                unit=price_data.get("unit", "kg")
            )
        logger.info(f"Saved {len(prices)} prices to database")

    def _sync_to_analytics(self):
        """Sync today's prices to Zoho Analytics."""
        try:
            credentials = load_zoho_credentials()
            if not credentials.get('ZOHO_REFRESH_TOKEN'):
                logger.warning("Zoho credentials not found, skipping Analytics sync")
                return

            access_token = get_access_token(credentials)
            prices = get_prices_from_sqlite()  # Today only

            if prices and MARKET_PRICES_TABLE_ID:
                result = import_to_analytics(access_token, prices, 'append', MARKET_PRICES_TABLE_ID)
                logger.info(f"Synced {len(prices)} prices to Zoho Analytics")
            else:
                logger.warning("No prices to sync or table ID not set")
        except Exception as e:
            logger.error(f"Failed to sync to Analytics: {e}")

    def _generate_report_data(self) -> dict:
        """Generate data structure for email report."""
        products_config = self.config.get("products", [])
        report_products = []
        alerts = []
        trends = {}

        for product in products_config:
            product_name = product.get("name", "")

            # Get today's prices
            prices = self.db.get_today_prices(product_name)

            if not prices:
                continue

            # Deduplicate: keep only one price per supermarket (lowest price)
            # This handles cases like "Tomate Santa Cruz" vs "Tomate Santa Cruz Extra"
            seen_supermarkets = {}
            for p in prices:
                sm = p["supermarket"]
                if sm not in seen_supermarkets or p["price"] < seen_supermarkets[sm]["price"]:
                    seen_supermarkets[sm] = p
            prices = list(seen_supermarkets.values())

            # Calculate median
            price_values = [p["price"] for p in prices]
            median = int(statistics.median(price_values))

            # Check for alerts
            for price in prices:
                previous = self.db.get_previous_price(
                    price["supermarket"],
                    product_name
                )
                if previous:
                    change = ((price["price"] - previous) / previous) * 100
                    if abs(change) >= self.alert_threshold:
                        alerts.append({
                            "product": product_name,
                            "supermarket": price["supermarket"],
                            "change_percent": change,
                            "previous_price": previous,
                            "current_price": price["price"]
                        })

            # Get trend
            trend = self.db.get_price_trend(product_name)
            trends[product_name] = trend

            report_products.append({
                "name": product_name,
                "median": median,
                "prices": sorted(prices, key=lambda x: x["price"])
            })

        return {
            "date": datetime.now(),
            "products": report_products,
            "alerts": alerts,
            "trends": trends
        }

    def test_email(self):
        """Send a test email with sample data."""
        test_data = {
            "date": datetime.now(),
            "products": [
                {
                    "name": "Tomate Lisa",
                    "median": 17500,
                    "prices": [
                        {"supermarket": "Stock", "price": 17950},
                        {"supermarket": "Superseis", "price": 17950},
                        {"supermarket": "Biggie", "price": 16500},
                    ]
                },
                {
                    "name": "Locote Rojo",
                    "median": 28000,
                    "prices": [
                        {"supermarket": "Stock", "price": 27500},
                        {"supermarket": "Superseis", "price": 28500},
                    ]
                }
            ],
            "alerts": [
                {
                    "product": "Tomate Lisa",
                    "supermarket": "Biggie",
                    "change_percent": -18.5,
                    "previous_price": 20250,
                    "current_price": 16500
                }
            ],
            "trends": {
                "Tomate Lisa": {"trend": "down", "change_percent": -5.2},
                "Locote Rojo": {"trend": "up", "change_percent": 3.1}
            }
        }

        logger.info("Sending test email...")
        success = self.email_sender.send_report(test_data)
        if success:
            logger.info("Test email sent successfully!")
        else:
            logger.error("Failed to send test email")


def run_scheduler(monitor: PriceMonitor, schedule_time: str):
    """Run the monitor on a daily schedule."""
    logger.info(f"Starting scheduler - will run daily at {schedule_time}")

    schedule.every().day.at(schedule_time).do(monitor.run)

    # Also run immediately on startup
    monitor.run()

    while True:
        schedule.run_pending()
        time.sleep(60)


def main():
    parser = argparse.ArgumentParser(description="HidroBio Price Monitor")
    parser.add_argument(
        "--schedule",
        action="store_true",
        help="Run with daily scheduler"
    )
    parser.add_argument(
        "--test-email",
        action="store_true",
        help="Send a test email"
    )
    parser.add_argument(
        "--config",
        type=str,
        default=None,
        help="Path to config file"
    )

    args = parser.parse_args()

    monitor = PriceMonitor(args.config)

    if args.test_email:
        monitor.test_email()
    elif args.schedule:
        schedule_time = monitor.config.get("schedule", {}).get("time", "08:00")
        run_scheduler(monitor, schedule_time)
    else:
        # Single run
        monitor.run()


if __name__ == "__main__":
    main()
