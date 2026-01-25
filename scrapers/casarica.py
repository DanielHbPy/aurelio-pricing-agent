"""
Scraper for Casa Rica (casarica.com.py)
Traditional HTML site with server-rendered content.
"""

import re
from bs4 import BeautifulSoup
from .base_scraper import BaseScraper


class CasaRicaScraper(BaseScraper):
    """Scraper for Casa Rica supermarket."""

    # Category URLs for fresh produce
    CATEGORY_URLS = {
        "verduras": "/catalogo/verduras-c287",
        "frutas": "/catalogo/frutas-c282",
    }

    def _parse_products(self, soup: BeautifulSoup) -> list:
        """Parse products from Casa Rica search/category results."""
        products = []

        # Casa Rica uses div.product for product containers
        product_elements = soup.find_all("div", class_="product")

        for element in product_elements:
            try:
                # Extract product name from h2.ecommercepro-loop-product__title
                name_elem = (
                    element.find("h2", class_="ecommercepro-loop-product__title") or
                    element.find("h2") or
                    element.find("h3")
                )

                if not name_elem:
                    continue

                name = name_elem.get_text(strip=True)

                # Skip non-fresh produce
                if not self._is_fresh_produce(name):
                    continue

                # Extract price - Casa Rica uses span.price or span.amount
                price = None
                price_elem = (
                    element.find("span", class_="price") or
                    element.find("span", class_="amount")
                )

                if price_elem:
                    price_text = price_elem.get_text(strip=True)
                    price = self._extract_casarica_price(price_text)

                if not price:
                    # Try finding any text with ₲ symbol
                    for text in element.stripped_strings:
                        if "₲" in text:
                            price = self._extract_casarica_price(text)
                            if price:
                                break

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

    def _extract_casarica_price(self, price_text: str) -> int:
        """
        Extract price from Casa Rica format.
        Format: ₲. 48.300 (dot as thousands separator)
        """
        if not price_text:
            return None

        # Remove currency symbols and whitespace
        cleaned = price_text.replace("₲", "").replace(".", "").replace(",", "")
        cleaned = cleaned.replace("Gs", "").strip()

        # Extract numeric value
        match = re.search(r"(\d+)", cleaned)
        if match:
            try:
                return int(match.group(1))
            except ValueError:
                return None
        return None

    def search_category(self, category: str = "verduras") -> list:
        """
        Search by category instead of keyword.
        Casa Rica works better with category browsing.
        """
        import logging
        logger = logging.getLogger(__name__)

        if category not in self.CATEGORY_URLS:
            return []

        url = self.base_url.rstrip("/") + self.CATEGORY_URLS[category]

        all_products = []

        # Paginate through results (Casa Rica has 20 products per page)
        for page in range(1, 6):  # Max 5 pages
            page_url = f"{url}?page={page}"

            try:
                response = self.session.get(page_url, timeout=30)
                response.raise_for_status()

                soup = BeautifulSoup(response.text, "lxml")
                products = self._parse_products(soup)

                if not products:
                    break  # No more products

                all_products.extend(products)

            except Exception as e:
                logger.error(f"{self.name}: Category search failed - {e}")
                break

        return all_products
