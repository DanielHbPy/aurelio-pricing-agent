#!/usr/bin/env python3
"""
Sync supermarket prices from SQLite to Zoho Analytics.

This script exports price data from the local SQLite database and pushes it
to a Zoho Analytics table for comparison with HidroBio sales prices.

Usage:
    python utils/analytics_sync.py              # Sync today's prices
    python utils/analytics_sync.py --all        # Sync all historical prices
    python utils/analytics_sync.py --days 7     # Sync last 7 days
"""

import os
import sys
import json
import sqlite3
import logging
import argparse
from datetime import datetime, timedelta
from pathlib import Path

# Add parent directory for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Zoho Analytics Configuration
ANALYTICS_ORG_ID = '837764545'
ANALYTICS_WORKSPACE_ID = '2849493000002538243'  # HB - Business Intelligence
# Table name for creating/importing
MARKET_PRICES_TABLE_NAME = 'Precios Supermercados'
# Table ID (created 2026-01-20)
MARKET_PRICES_TABLE_ID = os.environ.get('ZOHO_MARKET_PRICES_TABLE_ID', '2849493000003555002')

# OAuth credentials from MCP server
MCP_ENV_PATH = Path(__file__).parent.parent.parent / 'zoho-mcp-server' / '.env'


def load_zoho_credentials():
    """Load Zoho OAuth credentials from MCP server .env file."""
    credentials = {}
    if MCP_ENV_PATH.exists():
        with open(MCP_ENV_PATH) as f:
            for line in f:
                if '=' in line and not line.startswith('#'):
                    key, value = line.strip().split('=', 1)
                    credentials[key] = value
    return credentials


def get_access_token(credentials):
    """Get fresh access token using refresh token."""
    import urllib.request
    import urllib.parse

    token_url = f"https://accounts.zoho{credentials.get('ZOHO_DC', '.com')}/oauth/v2/token"

    params = urllib.parse.urlencode({
        'grant_type': 'refresh_token',
        'client_id': credentials['ZOHO_CLIENT_ID'],
        'client_secret': credentials['ZOHO_CLIENT_SECRET'],
        'refresh_token': credentials['ZOHO_REFRESH_TOKEN'],
    }).encode()

    req = urllib.request.Request(token_url, data=params, method='POST')
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')

    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode())
        if 'error' in data:
            raise Exception(f"Token refresh failed: {data['error']}")
        return data['access_token']


def get_prices_from_sqlite(days=None, all_data=False):
    """Get price data from SQLite database."""
    db_path = Path(__file__).parent.parent / 'data' / 'prices.db'

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    if all_data:
        query = """
            SELECT date, supermarket, product, product_name_raw, price_guaranies, unit
            FROM prices
            ORDER BY date DESC, supermarket, product
        """
        cursor.execute(query)
    elif days:
        since_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')
        query = """
            SELECT date, supermarket, product, product_name_raw, price_guaranies, unit
            FROM prices
            WHERE date >= ?
            ORDER BY date DESC, supermarket, product
        """
        cursor.execute(query, (since_date,))
    else:
        # Today only
        today = datetime.now().strftime('%Y-%m-%d')
        query = """
            SELECT date, supermarket, product, product_name_raw, price_guaranies, unit
            FROM prices
            WHERE date = ?
            ORDER BY supermarket, product
        """
        cursor.execute(query, (today,))

    rows = cursor.fetchall()
    conn.close()

    # Convert to list of dicts for JSON
    data = []
    for row in rows:
        data.append({
            'Fecha': row['date'],
            'Supermercado': row['supermarket'],
            'Producto': row['product'],
            'Producto_Raw': row['product_name_raw'] or row['product'],
            'Precio_Gs': row['price_guaranies'],
            'Unidad': row['unit'] or 'kg'
        })

    return data


def get_table_id(access_token, table_name):
    """Find table ID by name in workspace."""
    import urllib.request

    dc = '.com'
    url = f"https://analyticsapi.zoho{dc}/restapi/v2/workspaces/{ANALYTICS_WORKSPACE_ID}/views"

    req = urllib.request.Request(url, method='GET')
    req.add_header('Authorization', f'Zoho-oauthtoken {access_token}')
    req.add_header('ZANALYTICS-ORGID', ANALYTICS_ORG_ID)

    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode())
            if result.get('status') == 'success' and 'data' in result:
                views = result['data'].get('views', [])
                for view in views:
                    if view.get('viewName') == table_name and view.get('viewType') == 'Table':
                        return view.get('viewId')
    except Exception as e:
        logger.error(f"Error looking up table: {e}")

    return None


def create_table_with_data(access_token, data, table_name):
    """Create a new table by importing data (table auto-created)."""
    import urllib.request
    import urllib.parse

    dc = '.com'

    config = {
        'tableName': table_name,
        'fileType': 'json',
        'autoIdentify': True,
        'onError': 'skiprow'
    }

    config_json = urllib.parse.quote(json.dumps(config))
    url = f"https://analyticsapi.zoho{dc}/restapi/v2/workspaces/{ANALYTICS_WORKSPACE_ID}/data?CONFIG={config_json}"

    boundary = '----PythonFormBoundary'
    json_data = json.dumps(data)

    body = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="DATA"\r\n\r\n'
        f'{json_data}\r\n'
        f'--{boundary}--\r\n'
    ).encode('utf-8')

    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Authorization', f'Zoho-oauthtoken {access_token}')
    req.add_header('ZANALYTICS-ORGID', ANALYTICS_ORG_ID)
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')

    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode())
            return result
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        logger.error(f"HTTP Error {e.code}: {error_body}")
        raise


def import_to_analytics(access_token, data, import_type='append', table_id=None):
    """Push data to existing Zoho Analytics table."""
    import urllib.request
    import urllib.parse

    if not table_id:
        raise ValueError("table_id is required for importing to existing table")

    dc = '.com'

    config = {
        'importType': import_type,
        'fileType': 'json',
        'autoIdentify': True,
        'onError': 'skiprow'
    }

    config_json = urllib.parse.quote(json.dumps(config))
    url = f"https://analyticsapi.zoho{dc}/restapi/v2/workspaces/{ANALYTICS_WORKSPACE_ID}/views/{table_id}/data?CONFIG={config_json}"

    boundary = '----PythonFormBoundary'
    json_data = json.dumps(data)

    body = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="DATA"\r\n\r\n'
        f'{json_data}\r\n'
        f'--{boundary}--\r\n'
    ).encode('utf-8')

    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Authorization', f'Zoho-oauthtoken {access_token}')
    req.add_header('ZANALYTICS-ORGID', ANALYTICS_ORG_ID)
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')

    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode())
            return result
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        logger.error(f"HTTP Error {e.code}: {error_body}")
        raise


def main():
    parser = argparse.ArgumentParser(description='Sync prices to Zoho Analytics')
    parser.add_argument('--all', action='store_true', help='Sync all historical data')
    parser.add_argument('--days', type=int, help='Sync last N days')
    parser.add_argument('--truncate', action='store_true', help='Replace all data (use with --all)')
    parser.add_argument('--create', action='store_true', help='Create table if not exists')
    args = parser.parse_args()

    # Load credentials
    credentials = load_zoho_credentials()
    if not credentials.get('ZOHO_REFRESH_TOKEN'):
        logger.error("Zoho credentials not found. Check MCP server .env file.")
        sys.exit(1)

    # Get access token
    logger.info("Getting Zoho access token...")
    access_token = get_access_token(credentials)

    # Get prices from SQLite
    logger.info("Fetching prices from database...")
    prices = get_prices_from_sqlite(days=args.days, all_data=args.all)

    if not prices:
        logger.warning("No prices found to sync")
        return

    logger.info(f"Found {len(prices)} price records to sync")

    # Check if table exists
    table_id = MARKET_PRICES_TABLE_ID or get_table_id(access_token, MARKET_PRICES_TABLE_NAME)

    if not table_id:
        if args.create:
            logger.info(f"Creating table '{MARKET_PRICES_TABLE_NAME}' with initial data...")
            result = create_table_with_data(access_token, prices, MARKET_PRICES_TABLE_NAME)
            logger.info(f"Table created: {result}")
            # Get the new table ID
            table_id = get_table_id(access_token, MARKET_PRICES_TABLE_NAME)
            if table_id:
                logger.info(f"New table ID: {table_id}")
                logger.info(f"Set ZOHO_MARKET_PRICES_TABLE_ID={table_id} for future syncs")
            return
        else:
            logger.error(
                f"Table '{MARKET_PRICES_TABLE_NAME}' not found. "
                f"Run with --create to create it, or set ZOHO_MARKET_PRICES_TABLE_ID env var."
            )
            sys.exit(1)

    logger.info(f"Using table ID: {table_id}")

    # Determine import type
    import_type = 'truncateadd' if args.truncate else 'append'

    # Push to Analytics
    logger.info(f"Pushing to Zoho Analytics (import_type={import_type})...")
    result = import_to_analytics(access_token, prices, import_type, table_id)

    logger.info(f"Sync complete: {result}")


if __name__ == '__main__':
    main()
