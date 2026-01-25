"""
Supermarket scrapers for price monitoring.
"""

from .base_scraper import BaseScraper
from .stock import StockScraper
from .superseis import SuperseisScraper
from .casarica import CasaRicaScraper

# Map supermarket names to scraper classes
SCRAPERS = {
    "Stock": StockScraper,
    "Superseis": SuperseisScraper,
    "Casa Rica": CasaRicaScraper,
    # Add more as implemented:
    # "Biggie": BiggieScraper,
    # "Salemma": SalemmaScraper,
}


def get_scraper(supermarket_config: dict) -> BaseScraper:
    """
    Get the appropriate scraper for a supermarket.
    Falls back to a generic HTML scraper if no specific one exists.
    """
    name = supermarket_config.get("name", "")
    scraper_class = SCRAPERS.get(name, BaseScraper)

    # For supermarkets without specific scrapers, use a generic approach
    if scraper_class == BaseScraper:
        from .generic import GenericScraper
        return GenericScraper(supermarket_config)

    return scraper_class(supermarket_config)


__all__ = ["BaseScraper", "StockScraper", "SuperseisScraper", "CasaRicaScraper", "get_scraper", "SCRAPERS"]
