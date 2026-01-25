"""
Base scraper class for supermarket price extraction.
"""

import re
import logging
from abc import ABC, abstractmethod
from typing import Optional
import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)


class BaseScraper(ABC):
    """Abstract base class for supermarket scrapers."""

    def __init__(self, config: dict):
        self.name = config.get("name", "Unknown")
        self.base_url = config.get("base_url", "")
        self.search_url = config.get("search_url", "")
        self.enabled = config.get("enabled", True)
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "es-PY,es;q=0.9,en;q=0.8",
        })

    def search(self, query: str) -> list:
        """
        Search for products matching the query.
        Returns list of dicts with: name, price, unit, url
        """
        if not self.enabled:
            logger.info(f"{self.name}: Scraper disabled, skipping")
            return []

        try:
            url = self.search_url.format(query=query)
            logger.info(f"{self.name}: Searching for '{query}' at {url}")

            response = self.session.get(url, timeout=30)
            response.raise_for_status()

            soup = BeautifulSoup(response.text, "lxml")
            products = self._parse_products(soup)

            logger.info(f"{self.name}: Found {len(products)} products for '{query}'")
            return products

        except requests.RequestException as e:
            logger.error(f"{self.name}: Request failed - {e}")
            return []
        except Exception as e:
            logger.error(f"{self.name}: Parse error - {e}")
            return []

    @abstractmethod
    def _parse_products(self, soup: BeautifulSoup) -> list:
        """
        Parse product listings from the search results page.
        Must be implemented by each supermarket scraper.
        """
        pass

    def _extract_price(self, text: str) -> Optional[int]:
        """
        Extract price in Guaranies from text.
        Handles formats like: "Gs 17.950", "₲ 17,950", "17950"
        """
        if not text:
            return None

        # Remove currency symbols and common text
        cleaned = text.replace("Gs", "").replace("₲", "").replace("G$", "")
        cleaned = cleaned.replace("/kg", "").replace("/un", "").replace("/u", "")
        cleaned = cleaned.strip()

        # Extract numeric value
        # Handle both . and , as thousand separators
        match = re.search(r"[\d.,]+", cleaned)
        if not match:
            return None

        price_str = match.group()

        # Determine if . or , is thousand separator
        # In Paraguay, typically use . as thousand separator
        if "." in price_str and "," in price_str:
            # Both present - assume format like 1.234,56
            price_str = price_str.replace(".", "").replace(",", ".")
        elif "." in price_str:
            # Could be 17.950 (thousands) or 17.95 (decimal)
            parts = price_str.split(".")
            if len(parts[-1]) == 3:
                # Likely thousand separator (17.950)
                price_str = price_str.replace(".", "")
            # else keep as is
        elif "," in price_str:
            # Likely thousand separator
            price_str = price_str.replace(",", "")

        try:
            return int(float(price_str))
        except ValueError:
            return None

    def _normalize_product_name(self, name: str) -> str:
        """Normalize product name for matching."""
        if not name:
            return ""
        return name.lower().strip()

    def _is_fresh_produce(self, name: str) -> bool:
        """
        Check if product is fresh produce (not canned/processed).
        """
        name_lower = name.lower()

        # Exclude processed products
        exclude_terms = [
            "extracto", "pure", "puré", "salsa", "pelado", "enlatado",
            "conserva", "lata", "botella", "tetra", "sachet", "sobre",
            "sardina", "atun", "atún", "ketchup", "pasta", "pulpa"
        ]

        for term in exclude_terms:
            if term in name_lower:
                return False

        # Include fresh produce indicators
        include_terms = [
            "por kg", "por kilo", "x kg", "/kg", "kg x", "1 kg",
            "fresco", "bandeja", "granel", "x 1"
        ]

        for term in include_terms:
            if term in name_lower:
                return True

        # If no exclusions and has "kg" anywhere, likely fresh
        if "kg" in name_lower:
            return True

        return True  # Default to true if no exclusions match
