"""
Scraper for Superseis (superseis.com.py)
"""

from bs4 import BeautifulSoup
from .base_scraper import BaseScraper


class SuperseisScraper(BaseScraper):
    """Scraper for Superseis supermarket."""

    def _parse_products(self, soup: BeautifulSoup) -> list:
        """Parse products from Superseis search results."""
        products = []

        # Superseis uses data-product-id attribute for product containers
        product_elements = soup.find_all(attrs={"data-product-id": True})

        for element in product_elements:
            try:
                # Extract product name - look for any text that contains product info
                name = None
                for elem in element.find_all(['a', 'span', 'h2', 'h3', 'div']):
                    text = elem.get_text(strip=True)
                    # Look for reasonable product name (not too short, not just a price)
                    if len(text) > 5 and not text.startswith('₲') and not text.startswith('Gs'):
                        # Avoid descriptions - they're usually longer
                        if len(text) < 80:
                            name = text
                            break

                if not name:
                    continue

                # Clean name - remove promotional text after the actual name
                if 'Añadí' in name:
                    name = name.split('Añadí')[0].strip()
                if 'Preparate' in name:
                    name = name.split('Preparate')[0].strip()

                # Skip promotional/discount entries
                if 'Te ahorras' in name or 'ahorras' in name.lower():
                    continue

                # Skip non-fresh produce
                if not self._is_fresh_produce(name):
                    continue

                # Extract price - first try data attribute, then class
                price = None
                price_data = element.get("data-product-price")
                if price_data:
                    price = self._extract_price(price_data)

                if not price:
                    price_elem = (
                        element.find(class_="price") or
                        element.find(class_="price-special-suggest") or
                        element.find(class_="price-normal-suggest")
                    )
                    if price_elem:
                        price = self._extract_price(price_elem.get_text(strip=True))

                if not price:
                    continue

                # Extract URL
                url_elem = element.find("a", href=True)
                url = url_elem["href"] if url_elem else ""
                if url and not url.startswith("http"):
                    url = self.base_url + url

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
