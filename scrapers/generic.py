"""
Generic scraper that works with most e-commerce sites.
Uses common patterns to extract product data.
"""

import re
from bs4 import BeautifulSoup
from .base_scraper import BaseScraper


class GenericScraper(BaseScraper):
    """
    Generic scraper that attempts to extract products using common patterns.
    Used as fallback for supermarkets without specific scrapers.
    """

    def _parse_products(self, soup: BeautifulSoup) -> list:
        """Parse products using common e-commerce patterns."""
        products = []

        # Common product container patterns
        container_patterns = [
            {"class_": re.compile(r"product", re.I)},
            {"class_": re.compile(r"item", re.I)},
            {"class_": re.compile(r"card", re.I)},
            {"data-product": True},
            {"data-item": True},
            {"itemtype": "http://schema.org/Product"},
        ]

        product_elements = []
        for pattern in container_patterns:
            elements = soup.find_all("div", **pattern)
            if elements:
                product_elements = elements
                break

        if not product_elements:
            # Try article tags
            product_elements = soup.find_all("article")

        for element in product_elements:
            try:
                product = self._extract_product_data(element)
                if product and self._is_fresh_produce(product["name"]):
                    products.append(product)
            except Exception:
                continue

        return products

    def _extract_product_data(self, element) -> dict:
        """Extract product data from a container element."""

        # Try multiple patterns for name
        name = None
        name_patterns = [
            ("h1", {}),
            ("h2", {}),
            ("h3", {}),
            ("h4", {}),
            ("a", {"class_": re.compile(r"name|title", re.I)}),
            ("span", {"class_": re.compile(r"name|title", re.I)}),
            ("p", {"class_": re.compile(r"name|title", re.I)}),
            ("div", {"class_": re.compile(r"name|title", re.I)}),
        ]

        for tag, attrs in name_patterns:
            elem = element.find(tag, **attrs)
            if elem:
                name = elem.get_text(strip=True)
                if len(name) > 3:  # Minimum reasonable name length
                    break

        if not name:
            # Try title attribute
            link = element.find("a", title=True)
            if link:
                name = link.get("title")

        if not name:
            return None

        # Try multiple patterns for price
        price = None
        price_patterns = [
            {"class_": re.compile(r"price", re.I)},
            {"class_": re.compile(r"valor", re.I)},
            {"class_": re.compile(r"costo", re.I)},
            {"itemprop": "price"},
        ]

        for pattern in price_patterns:
            for tag in ["span", "div", "p", "strong"]:
                elem = element.find(tag, **pattern)
                if elem:
                    price_text = elem.get_text(strip=True)
                    price = self._extract_price(price_text)
                    if price:
                        break
            if price:
                break

        if not price:
            # Look for any text containing Gs or ₲
            text = element.get_text()
            match = re.search(r"[Gs₲G\$]\s*[\d.,]+", text)
            if match:
                price = self._extract_price(match.group())

        if not price:
            return None

        # Extract URL
        url = ""
        link = element.find("a", href=True)
        if link:
            url = link["href"]
            if url and not url.startswith("http"):
                url = self.base_url.rstrip("/") + "/" + url.lstrip("/")

        return {
            "name": name,
            "price": price,
            "unit": "kg",
            "url": url,
            "supermarket": self.name
        }
