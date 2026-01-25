"""
Email utilities for sending price reports.
"""

import os
import smtplib
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)


class EmailSender:
    def __init__(self, config: dict):
        self.recipient = config.get("recipient", "")
        self.sender = config.get("sender", "pricebot@hidrobio.com.py")
        self.smtp_host = config.get("smtp_host", "smtp.zoho.com")
        self.smtp_port = config.get("smtp_port", 587)
        self.smtp_user = os.environ.get("SMTP_USER", "")
        self.smtp_password = os.environ.get("SMTP_PASSWORD", "")

    def send_report(self, report_data: dict) -> bool:
        """
        Send the daily price report email.

        report_data should contain:
        - date: datetime
        - products: list of product summaries
        - alerts: list of price alerts
        - trends: dict of weekly trends
        """
        try:
            subject = self._generate_subject(report_data)
            html_body = self._generate_html_report(report_data)
            text_body = self._generate_text_report(report_data)

            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = self.sender
            msg["To"] = self.recipient

            msg.attach(MIMEText(text_body, "plain", "utf-8"))
            msg.attach(MIMEText(html_body, "html", "utf-8"))

            with smtplib.SMTP(self.smtp_host, self.smtp_port) as server:
                server.starttls()
                if self.smtp_user and self.smtp_password:
                    server.login(self.smtp_user, self.smtp_password)
                server.send_message(msg)

            logger.info(f"Price report sent to {self.recipient}")
            return True

        except Exception as e:
            logger.error(f"Failed to send email: {e}")
            return False

    def _generate_subject(self, report_data: dict) -> str:
        """Generate email subject line."""
        date = report_data.get("date", datetime.now())
        date_str = date.strftime("%d %b %Y")

        alerts = report_data.get("alerts", [])
        if alerts:
            return f"🚨 Precios Diarios - {date_str} ({len(alerts)} alertas)"
        return f"🍅 Precios Diarios HidroBio - {date_str}"

    def _generate_html_report(self, report_data: dict) -> str:
        """Generate HTML email body."""
        date = report_data.get("date", datetime.now())
        date_str = date.strftime("%d/%m/%Y")
        products = report_data.get("products", [])
        alerts = report_data.get("alerts", [])
        trends = report_data.get("trends", {})

        html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body {{ font-family: Arial, sans-serif; margin: 20px; color: #333; }}
                h1 {{ color: #2e7d32; border-bottom: 2px solid #2e7d32; padding-bottom: 10px; }}
                h2 {{ color: #1565c0; margin-top: 30px; }}
                h3 {{ color: #555; margin-top: 20px; }}
                table {{ border-collapse: collapse; width: 100%; margin: 15px 0; }}
                th, td {{ border: 1px solid #ddd; padding: 10px; text-align: left; }}
                th {{ background-color: #f5f5f5; font-weight: bold; }}
                .price {{ font-weight: bold; }}
                .alert {{ background-color: #fff3cd; }}
                .up {{ color: #2e7d32; }}  /* Green = price up = good for HidroBio */
                .down {{ color: #d32f2f; }}  /* Red = price down = bad for HidroBio */
                .median {{ background-color: #e8f5e9; font-weight: bold; }}
                .footer {{ margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 12px; }}
            </style>
        </head>
        <body>
            <h1>🍅 Resumen de Precios - {date_str}</h1>
        """

        # Alerts section
        if alerts:
            html += """
            <h2>🚨 Alertas de Precio</h2>
            <table>
                <tr><th>Producto</th><th>Supermercado</th><th>Cambio</th><th>Precio Anterior</th><th>Precio Actual</th></tr>
            """
            for alert in alerts:
                change_class = "up" if alert["change_percent"] > 0 else "down"
                change_symbol = "↑" if alert["change_percent"] > 0 else "↓"
                html += f"""
                <tr class="alert">
                    <td>{alert['product']}</td>
                    <td>{alert['supermarket']}</td>
                    <td class="{change_class}">{change_symbol} {abs(alert['change_percent']):.1f}%</td>
                    <td>₲ {alert['previous_price']:,}</td>
                    <td>₲ {alert['current_price']:,}</td>
                </tr>
                """
            html += "</table>"

        # Products section
        for product in products:
            html += f"""
            <h2>{product['name']}</h2>
            <p class="median">Mediana: ₲ {product['median']:,}/kg</p>
            <table>
                <tr><th>Supermercado</th><th>Precio/kg</th><th>vs Mediana</th></tr>
            """
            for price in product["prices"]:
                diff = ((price["price"] - product["median"]) / product["median"]) * 100
                diff_class = "up" if diff > 5 else ("down" if diff < -5 else "")
                diff_str = f"+{diff:.0f}%" if diff > 0 else f"{diff:.0f}%"
                html += f"""
                <tr>
                    <td>{price['supermarket']}</td>
                    <td class="price">₲ {price['price']:,}</td>
                    <td class="{diff_class}">{diff_str}</td>
                </tr>
                """
            html += "</table>"

        # Trends section
        if trends:
            html += """
            <h2>📈 Tendencia Semanal</h2>
            <table>
                <tr><th>Producto</th><th>Tendencia</th><th>Cambio</th></tr>
            """
            for product_name, trend in trends.items():
                if trend["trend"] == "insufficient_data":
                    continue
                trend_symbol = "↑" if trend["trend"] == "up" else ("↓" if trend["trend"] == "down" else "→")
                trend_class = "up" if trend["trend"] == "up" else ("down" if trend["trend"] == "down" else "")
                html += f"""
                <tr>
                    <td>{product_name}</td>
                    <td>{trend_symbol}</td>
                    <td class="{trend_class}">{trend['change_percent']:+.1f}%</td>
                </tr>
                """
            html += "</table>"

        html += f"""
            <div class="footer">
                <p>Generado automáticamente por HidroBio Price Monitor</p>
                <p>Datos recopilados de: Stock, Superseis, Biggie, Salemma, Fortis, Casa Rica</p>
            </div>
        </body>
        </html>
        """
        return html

    def _generate_text_report(self, report_data: dict) -> str:
        """Generate plain text email body."""
        date = report_data.get("date", datetime.now())
        date_str = date.strftime("%d/%m/%Y")
        products = report_data.get("products", [])
        alerts = report_data.get("alerts", [])

        text = f"""
RESUMEN DE PRECIOS - {date_str}
{'=' * 40}

"""
        if alerts:
            text += "🚨 ALERTAS DE PRECIO\n"
            text += "-" * 30 + "\n"
            for alert in alerts:
                symbol = "↑" if alert["change_percent"] > 0 else "↓"
                text += f"{alert['product']} ({alert['supermarket']}): {symbol} {abs(alert['change_percent']):.1f}%\n"
            text += "\n"

        for product in products:
            text += f"\n{product['name']}\n"
            text += "-" * 20 + "\n"
            text += f"Mediana: ₲ {product['median']:,}/kg\n\n"

            for price in product["prices"]:
                diff = ((price["price"] - product["median"]) / product["median"]) * 100
                diff_str = f"+{diff:.0f}%" if diff > 0 else f"{diff:.0f}%"
                text += f"  {price['supermarket']}: ₲ {price['price']:,} ({diff_str})\n"

        text += f"""
{'=' * 40}
Generado por HidroBio Price Monitor
"""
        return text
