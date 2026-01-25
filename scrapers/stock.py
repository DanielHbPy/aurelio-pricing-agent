"""
Scraper for Stock Supermercados (stock.com.py)
"""

import re
from bs4 import BeautifulSoup
from .base_scraper import BaseScraper


class StockScraper(BaseScraper):
    """Scraper for Stock supermarket (nopCommerce-based)."""

    def _parse_products(self, soup: BeautifulSoup) -> list:
        """Parse products from Stock search results."""
        products = []

        # Stock uses nopCommerce - look for item-box or product-item containers
        product_elements = soup.find_all("div", class_="item-box")

        if not product_elements:
            product_elements = soup.find_all("div", class_="product-item")

        if not product_elements:
            # Look for any div with product data attributes
            product_elements = soup.find_all("div", {"data-productid": True})

        if not product_elements:
            # Fallback: parse text directly for product patterns
            return self._parse_from_text(soup)

        for element in product_elements:
            try:
                # Extract product name from product-title or any link
                name_elem = (
                    element.find(class_="product-title") or
                    element.find("h2", class_="product-name") or
                    element.find("a", title=True)
                )

                if not name_elem:
                    # Try finding first link with text
                    name_elem = element.find("a")

                if not name_elem:
                    continue

                name = name_elem.get("title") or name_elem.get_text(strip=True)

                # Skip non-fresh produce
                if not self._is_fresh_produce(name):
                    continue

                # Extract price - Stock uses 'prices' class
                price_elem = (
                    element.find(class_="prices") or
                    element.find(class_="actual-price") or
                    element.find(class_="price") or
                    element.find(class_="product-price")
                )

                if not price_elem:
                    # Try finding any element with Gs in text
                    for elem in element.find_all(string=re.compile(r"Gs\s*[\d.,]+")):
                        price = self._extract_price(str(elem))
                        if price:
                            break
                    else:
                        continue
                else:
                    price_text = price_elem.get_text(strip=True)
                    price = self._extract_price(price_text)

                if not price:
                    continue

                # Extract URL
                url_elem = element.find("a", href=True)
                url = url_elem["href"] if url_elem else ""
                if url and not url.startswith("http"):
                    url = self.base_url.rstrip("/") + "/" + url.lstrip("/")

                products.append({
                    "name": name,
                    "price": price,
                    "unit": "kg",
                    "url": url,
                    "supermarket": self.name
                })

            except Exception:
                continue

        return products

    def _parse_from_text(self, soup: BeautifulSoup) -> list:
        """Fallback: parse products directly from page text."""
        products = []
        text = soup.get_text()

        # Pattern: PRODUCT NAME X KG ... Gs PRICE
        # Look for lines that have both product names and prices
        lines = text.split('\n')

        for line in lines:
            line = line.strip()
            if not line:
                continue

            # Check if this looks like a product with price
            price_match = re.search(r'Gs\s*([\d.,]+)', line)
            if not price_match:
                continue

            # Check for fresh produce indicators
            if any(term in line.lower() for term in ['tomate', 'locote', 'pimiento', 'lechuga', 'morron', 'morrón']):
                price = self._extract_price(price_match.group(0))
                if price:
                    # Extract product name (everything before Gs)
                    name_part = line[:price_match.start()].strip()
                    if len(name_part) > 5 and self._is_fresh_produce(name_part):
                        products.append({
                            "name": name_part,
                            "price": price,
                            "unit": "kg",
                            "url": "",
                            "supermarket": self.name
                        })

        return products
