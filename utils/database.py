"""
Database utilities for storing and retrieving price history.
Uses SQLite for simplicity and portability.
"""

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
import statistics


class PriceDatabase:
    def __init__(self, db_path: str = None):
        if db_path is None:
            db_path = Path(__file__).parent.parent / "data" / "prices.db"
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _get_connection(self):
        return sqlite3.connect(self.db_path)

    def _init_db(self):
        """Initialize database tables."""
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS prices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date DATE NOT NULL,
                    supermarket TEXT NOT NULL,
                    product TEXT NOT NULL,
                    product_name_raw TEXT,
                    price_guaranies INTEGER NOT NULL,
                    unit TEXT DEFAULT 'kg',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(date, supermarket, product, product_name_raw)
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_prices_date
                ON prices(date)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_prices_product
                ON prices(product)
            """)
            conn.commit()

    def save_price(
        self,
        supermarket: str,
        product: str,
        price_guaranies: int,
        product_name_raw: str = None,
        unit: str = "kg",
        date: datetime = None
    ):
        """Save a price record."""
        if date is None:
            date = datetime.now().date()
        elif isinstance(date, datetime):
            date = date.date()

        with self._get_connection() as conn:
            try:
                conn.execute("""
                    INSERT OR REPLACE INTO prices
                    (date, supermarket, product, product_name_raw, price_guaranies, unit)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (date, supermarket, product, product_name_raw, price_guaranies, unit))
                conn.commit()
            except sqlite3.IntegrityError:
                pass  # Duplicate entry, ignore

    def get_today_prices(self, product: str = None) -> list:
        """Get all prices for today."""
        today = datetime.now().date()
        return self.get_prices_for_date(today, product)

    def get_prices_for_date(self, date, product: str = None) -> list:
        """Get all prices for a specific date."""
        with self._get_connection() as conn:
            if product:
                cursor = conn.execute("""
                    SELECT supermarket, product, price_guaranies, product_name_raw, unit
                    FROM prices
                    WHERE date = ? AND product = ?
                    ORDER BY price_guaranies ASC
                """, (date, product))
            else:
                cursor = conn.execute("""
                    SELECT supermarket, product, price_guaranies, product_name_raw, unit
                    FROM prices
                    WHERE date = ?
                    ORDER BY product, price_guaranies ASC
                """, (date,))

            return [
                {
                    "supermarket": row[0],
                    "product": row[1],
                    "price": row[2],
                    "product_name_raw": row[3],
                    "unit": row[4]
                }
                for row in cursor.fetchall()
            ]

    def get_median_price(self, product: str, date=None) -> Optional[int]:
        """Calculate median price for a product on a given date."""
        if date is None:
            date = datetime.now().date()

        prices = self.get_prices_for_date(date, product)
        if not prices:
            return None

        price_values = [p["price"] for p in prices]
        return int(statistics.median(price_values))

    def get_week_ago_median(self, product: str) -> Optional[int]:
        """Get median price from 7 days ago."""
        week_ago = datetime.now().date() - timedelta(days=7)
        return self.get_median_price(product, week_ago)

    def get_previous_price(self, supermarket: str, product: str) -> Optional[int]:
        """Get the most recent previous price for a product at a supermarket."""
        today = datetime.now().date()

        with self._get_connection() as conn:
            cursor = conn.execute("""
                SELECT price_guaranies
                FROM prices
                WHERE supermarket = ? AND product = ? AND date < ?
                ORDER BY date DESC
                LIMIT 1
            """, (supermarket, product, today))

            row = cursor.fetchone()
            return row[0] if row else None

    def get_price_trend(self, product: str, days: int = 7) -> dict:
        """Get price trend over the specified number of days."""
        end_date = datetime.now().date()
        start_date = end_date - timedelta(days=days)

        with self._get_connection() as conn:
            cursor = conn.execute("""
                SELECT date, AVG(price_guaranies) as avg_price
                FROM prices
                WHERE product = ? AND date BETWEEN ? AND ?
                GROUP BY date
                ORDER BY date ASC
            """, (product, start_date, end_date))

            data = cursor.fetchall()

            if len(data) < 2:
                return {"trend": "insufficient_data", "change_percent": 0}

            first_price = data[0][1]
            last_price = data[-1][1]
            change_percent = ((last_price - first_price) / first_price) * 100

            if change_percent > 2:
                trend = "up"
            elif change_percent < -2:
                trend = "down"
            else:
                trend = "stable"

            return {
                "trend": trend,
                "change_percent": round(change_percent, 1),
                "first_price": int(first_price),
                "last_price": int(last_price)
            }
