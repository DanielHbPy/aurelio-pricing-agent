/**
 * Aurelio Dashboard - Frontend Application
 * Handles data fetching, rendering, and real-time updates
 */

// State
let currentUser = null;
let reportData = null;
let ws = null;

// DOM Elements
const elements = {
  reportDate: document.getElementById('report-date'),
  userName: document.getElementById('user-name'),
  runNowBtn: document.getElementById('run-now-btn'),
  downloadPdfBtn: document.getElementById('download-pdf-btn'),
  sendEmailBtn: document.getElementById('send-email-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  progressModal: document.getElementById('progress-modal'),
  progressBar: document.getElementById('progress-bar'),
  progressLog: document.getElementById('progress-log'),
  closeModalBtn: document.getElementById('close-modal-btn'),
  statPrices: document.getElementById('stat-prices'),
  statSupermarkets: document.getElementById('stat-supermarkets'),
  statProducts: document.getElementById('stat-products'),
  statNext: document.getElementById('stat-next'),
  summaryText: document.getElementById('summary-text'),
  productsContainer: document.getElementById('products-container'),
  strategySection: document.getElementById('strategy-section'),
  strategyTbody: document.getElementById('strategy-tbody'),
  strategySummary: document.getElementById('strategy-summary'),
  strategyActions: document.getElementById('strategy-actions'),
  // Customer analysis section
  customerSection: document.getElementById('customer-section'),
  customersActive: document.getElementById('customers-active'),
  customersRisk: document.getElementById('customers-risk'),
  customersInactive: document.getElementById('customers-inactive'),
  customersWeek: document.getElementById('customers-week'),
  customerSummary: document.getElementById('customer-summary'),
  customerActions: document.getElementById('customer-actions'),
  alertsSection: document.getElementById('alerts-section'),
  alertsContainer: document.getElementById('alerts-container'),
  recommendationSection: document.getElementById('recommendation-section'),
  recommendationText: document.getElementById('recommendation-text'),
  rawPricesContainer: document.getElementById('raw-prices-container'),
  footerTimestamp: document.getElementById('footer-timestamp')
};

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Check authentication
  try {
    const response = await fetch('/auth/me');
    const data = await response.json();

    if (!data.authenticated) {
      window.location.href = '/login.html';
      return;
    }

    currentUser = data;
    elements.userName.textContent = data.name || data.email;
  } catch (error) {
    window.location.href = '/login.html';
    return;
  }

  // Setup event listeners
  elements.runNowBtn.addEventListener('click', handleRunNow);
  elements.downloadPdfBtn.addEventListener('click', handleDownloadPdf);
  elements.sendEmailBtn.addEventListener('click', handleSendEmail);
  elements.logoutBtn.addEventListener('click', handleLogout);
  elements.closeModalBtn.addEventListener('click', closeModal);

  // Load data
  await loadReport();

  // Update timestamp
  updateFooterTimestamp();
  setInterval(updateFooterTimestamp, 60000);

  // Setup WebSocket for progress updates
  setupWebSocket();
}

async function loadReport() {
  try {
    const response = await fetch('/api/latest-report');
    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error);
    }

    reportData = result.data;
    renderDashboard();
  } catch (error) {
    console.error('Error loading report:', error);
    elements.summaryText.textContent = 'Error al cargar el reporte. Intenta refrescar la pagina.';
  }
}

function renderDashboard() {
  const { analysis, prices, alerts, status } = reportData;

  // Update report date
  const reportDate = analysis?.date || status?.lastScrape || new Date().toISOString().split('T')[0];
  elements.reportDate.textContent = formatDate(reportDate);

  // Update stats
  elements.statPrices.textContent = status?.pricesCollected || prices?.length || '--';
  elements.statSupermarkets.textContent = status?.supermarketsCount || '--';
  elements.statProducts.textContent = status?.productsCount || '--';
  elements.statNext.textContent = status?.nextScheduled ? formatShortDate(status.nextScheduled) : '--';

  // Get analysis data (handle both formats)
  const analysisData = analysis?.analysis || analysis;

  if (typeof analysisData === 'object' && analysisData.resumenEjecutivo) {
    // Full analysis JSON
    renderFullAnalysis(analysisData, prices);
  } else if (Array.isArray(analysisData)) {
    // Array of analysis rows from DB
    renderBasicAnalysis(analysisData, prices);
  } else {
    // No analysis yet
    renderPricesOnly(prices);
  }

  // Render alerts
  renderAlerts(alerts);

  // Render raw prices
  renderRawPrices(prices);
}

function renderFullAnalysis(analysis, prices) {
  // Executive Summary
  elements.summaryText.textContent = analysis.resumenEjecutivo || 'Sin resumen disponible.';

  // Product Cards
  if (analysis.productos && analysis.productos.length > 0) {
    elements.productsContainer.innerHTML = analysis.productos.map(renderProductCard).join('');
  } else {
    elements.productsContainer.innerHTML = '<p class="loading-placeholder">Sin analisis de productos disponible.</p>';
  }

  // Strategy Implementation
  if (analysis.analisisImplementacion) {
    renderStrategySection(analysis.analisisImplementacion, analysis.productos);
  }

  // Customer Analysis
  if (analysis.analisisClientes) {
    renderCustomerSection(analysis.analisisClientes);
  }

  // Weekly Recommendation
  if (analysis.recomendacionSemanal) {
    elements.recommendationSection.classList.remove('hidden');
    elements.recommendationText.textContent = analysis.recomendacionSemanal;
  }

  // General Alerts
  if (analysis.alertasGenerales && analysis.alertasGenerales.length > 0) {
    const existingAlerts = elements.alertsContainer.innerHTML;
    const generalAlertsHtml = analysis.alertasGenerales.map(a =>
      `<div class="alert-item">⚠️ ${a}</div>`
    ).join('');
    elements.alertsContainer.innerHTML = generalAlertsHtml + existingAlerts;
    elements.alertsSection.classList.remove('hidden');
  }
}

function renderBasicAnalysis(analysisRows, prices) {
  elements.summaryText.textContent = 'Analisis basico disponible. Ejecuta un analisis completo para ver recomendaciones detalladas.';

  const productCards = analysisRows.map(row => `
    <div class="product-card">
      <div class="product-card-header">
        <h3>🍅 ${row.product}</h3>
      </div>
      <div class="product-card-body">
        <div class="product-metrics">
          <div class="metric">
            <div class="metric-label">Mediana Mercado</div>
            <div class="metric-value blue">Gs. ${formatNumber(row.market_median)}</div>
          </div>
          <div class="metric">
            <div class="metric-label">Rango</div>
            <div class="metric-value">Gs. ${formatNumber(row.market_min)} - ${formatNumber(row.market_max)}</div>
          </div>
        </div>
        ${row.reasoning ? `<div class="product-comment">💡 ${row.reasoning}</div>` : ''}
      </div>
    </div>
  `).join('');

  elements.productsContainer.innerHTML = productCards || '<p class="loading-placeholder">Sin analisis disponible.</p>';
}

function renderPricesOnly(prices) {
  elements.summaryText.textContent = 'Precios recolectados. Ejecuta un analisis completo para ver recomendaciones de precios B2B.';
  elements.productsContainer.innerHTML = '<p class="loading-placeholder">Ejecuta "Ejecutar Ahora" para generar analisis de productos.</p>';
}

function renderProductCard(product) {
  const precios = product.preciosRecomendadosHidroBio || {};

  const trendIcon = product.tendencia === 'alza' ? '📈' :
                    product.tendencia === 'baja' ? '📉' : '➡️';

  const alertsHtml = product.alertas && product.alertas.length > 0
    ? `<div class="product-alerts">${product.alertas.map(a => `⚠️ ${a}`).join('<br>')}</div>`
    : '';

  const salesHtml = product.implementacionEstrategia?.tieneVentas
    ? renderSalesImplementation(product.implementacionEstrategia)
    : '';

  return `
    <div class="product-card">
      <div class="product-card-header">
        <h3>🍅 ${product.producto}</h3>
      </div>
      <div class="product-card-body">
        <div class="product-metrics">
          <div class="metric">
            <div class="metric-label">Mediana Mercado</div>
            <div class="metric-value blue">Gs. ${formatNumber(product.medianaSupermercados)}</div>
          </div>
          <div class="metric">
            <div class="metric-label">Tendencia</div>
            <div class="metric-trend">${trendIcon} ${product.tendencia || 'estable'} (${product.cambioSemanal || '0%'})</div>
          </div>
          <div class="metric">
            <div class="metric-label">Piso Absoluto</div>
            <div class="metric-value red">Gs. ${formatNumber(product.pisoAbsoluto)}</div>
          </div>
        </div>

        <div class="pricing-table-wrapper">
          <h4>💰 Bandas de Precios B2B (Negociacion)</h4>
          <table class="pricing-table">
            <thead>
              <tr>
                <th>Segmento</th>
                <th class="price-min">Minimo</th>
                <th class="price-target">Meta</th>
                <th class="price-max">Maximo</th>
                <th>Margen</th>
              </tr>
            </thead>
            <tbody>
              ${renderPricingRow('⭐⭐⭐⭐⭐ Consumidor Final', precios.consumidorFinal)}
              ${renderPricingRow('⭐⭐⭐⭐ HORECA', precios.horeca)}
              ${renderPricingRow('⭐⭐⭐ Supermercados', precios.supermercados)}
              ${renderPricingRow('⭐⭐ Institucional', precios.institucional)}
            </tbody>
          </table>
          <p class="pricing-legend">
            <strong style="color: var(--red-dark);">Rojo</strong> = Precio minimo (walk-away) |
            <strong style="color: var(--green-dark);">Verde</strong> = Precio meta (inicial) |
            <strong style="color: var(--blue-dark);">Azul</strong> = Precio maximo (premium)
          </p>
        </div>

        ${product.comentario ? `<div class="product-comment">💡 ${product.comentario}</div>` : ''}
        ${salesHtml}
        ${alertsHtml}
      </div>
    </div>
  `;
}

function renderPricingRow(segmentName, precios) {
  if (!precios) return '';

  return `
    <tr>
      <td>${segmentName}</td>
      <td class="price-min">${formatNumber(precios.precioMinimo || precios.precio)}</td>
      <td class="price-target">${formatNumber(precios.precioMeta || precios.precio)}</td>
      <td class="price-max">${formatNumber(precios.precioMaximo || precios.precio)}</td>
      <td>${precios.margen || 'N/A'}</td>
    </tr>
  `;
}

function renderSalesImplementation(impl) {
  const evalClass = `evaluation-${impl.evaluacion || 'unknown'}`;
  const evalText = {
    'excelente': '⭐ Excelente',
    'bueno': '✅ Bueno',
    'aceptable': '➖ Aceptable',
    'bajo': '⚠️ Bajo',
    'critico': '🔴 Critico'
  }[impl.evaluacion] || impl.evaluacion || 'N/A';

  return `
    <div class="sales-implementation">
      <div class="sales-implementation-header">📈 Ventas HidroBio (ultima semana)</div>
      <div class="sales-implementation-body">
        <div class="sales-metrics">
          <div class="sales-metric">
            <div class="sales-metric-label">Precio Promedio</div>
            <div class="sales-metric-value">Gs. ${formatNumber(impl.precioPromedioVendido)}</div>
          </div>
          <div class="sales-metric">
            <div class="sales-metric-label">% de Mediana</div>
            <div class="sales-metric-value">${impl.porcentajeVsMediana || 'N/A'}</div>
          </div>
          <div class="sales-metric">
            <div class="sales-metric-label">Cantidad</div>
            <div class="sales-metric-value">${formatNumber(impl.cantidadVendida)}</div>
          </div>
          <div class="sales-metric">
            <div class="sales-metric-label">Evaluacion</div>
            <div class="sales-metric-value">
              <span class="evaluation-badge ${evalClass}">${evalText}</span>
            </div>
          </div>
        </div>
        ${impl.comentarioImplementacion ? `<div class="sales-comment">💬 ${impl.comentarioImplementacion}</div>` : ''}
      </div>
    </div>
  `;
}

function renderStrategySection(impl, productos) {
  elements.strategySection.classList.remove('hidden');

  // Summary
  elements.strategySummary.innerHTML = `<p>${impl.resumen || ''}</p>`;

  // Table
  const rows = productos
    .filter(p => p.implementacionEstrategia?.tieneVentas)
    .map(p => {
      const impl = p.implementacionEstrategia;
      const evalClass = `evaluation-${impl.evaluacion || 'unknown'}`;
      const evalText = {
        'excelente': '⭐ Excelente',
        'bueno': '✅ Bueno',
        'aceptable': '➖ Aceptable',
        'bajo': '⚠️ Bajo',
        'critico': '🔴 Critico'
      }[impl.evaluacion] || impl.evaluacion;

      return `
        <tr>
          <td>${p.producto}</td>
          <td>Gs. ${formatNumber(impl.precioPromedioVendido)}</td>
          <td>${impl.porcentajeVsMediana}</td>
          <td><span class="evaluation-badge ${evalClass}">${evalText}</span></td>
          <td>${formatNumber(impl.cantidadVendida)}</td>
        </tr>
      `;
    });

  elements.strategyTbody.innerHTML = rows.join('');

  // Actions
  if (impl.accionesSugeridas && impl.accionesSugeridas.length > 0) {
    elements.strategyActions.innerHTML = `
      <h4>🎯 Acciones Sugeridas</h4>
      <ul>${impl.accionesSugeridas.map(a => `<li>${a}</li>`).join('')}</ul>
    `;
  }
}

function renderCustomerSection(customerData) {
  if (!customerData || !elements.customerSection) return;

  elements.customerSection.classList.remove('hidden');

  // Update engagement stats
  if (elements.customersActive) {
    elements.customersActive.textContent = customerData.clientesActivos ?? customerData.engagement?.activeCustomers ?? '--';
  }
  if (elements.customersRisk) {
    elements.customersRisk.textContent = customerData.clientesEnRiesgo ?? customerData.engagement?.atRiskCustomers ?? '--';
  }
  if (elements.customersInactive) {
    elements.customersInactive.textContent = customerData.clientesInactivos ?? customerData.engagement?.inactiveCustomers ?? '--';
  }
  if (elements.customersWeek) {
    elements.customersWeek.textContent = customerData.clientesSemana ?? customerData.engagement?.customersThisWeek ?? '--';
  }

  // Summary
  if (customerData.resumen && elements.customerSummary) {
    elements.customerSummary.innerHTML = `<p>${customerData.resumen}</p>`;
    if (customerData.segmentoMasValor) {
      elements.customerSummary.innerHTML += `<p><strong>Segmento de mayor valor:</strong> ${customerData.segmentoMasValor}</p>`;
    }
  }

  // Actions
  if (customerData.accionesEngagement && customerData.accionesEngagement.length > 0 && elements.customerActions) {
    elements.customerActions.innerHTML = `
      <h4>🎯 Acciones de Engagement</h4>
      <ul>${customerData.accionesEngagement.map(a => `<li>${a}</li>`).join('')}</ul>
    `;
  }
}

function renderAlerts(alerts) {
  if (!alerts || alerts.length === 0) return;

  elements.alertsSection.classList.remove('hidden');
  const alertsHtml = alerts.map(alert => `
    <div class="alert-item">
      <strong>${alert.alert_type || 'Alerta'}:</strong> ${alert.message}
      <span style="font-size: 0.8rem; color: #666; margin-left: 0.5rem;">(${alert.product || ''} - ${alert.supermarket || ''})</span>
    </div>
  `).join('');

  elements.alertsContainer.innerHTML += alertsHtml;
}

function renderRawPrices(prices) {
  if (!prices || prices.length === 0) {
    elements.rawPricesContainer.innerHTML = '<p class="loading-placeholder">No hay precios recolectados hoy.</p>';
    return;
  }

  // Group by supermarket
  const bySupermarket = {};
  prices.forEach(p => {
    const sm = p.supermarket;
    if (!bySupermarket[sm]) bySupermarket[sm] = [];
    bySupermarket[sm].push(p);
  });

  const html = Object.entries(bySupermarket).map(([supermarket, priceList]) => `
    <div class="supermarket-group">
      <div class="supermarket-header" onclick="toggleSupermarket(this)">
        <span>🏪 ${supermarket} (${priceList.length} productos)</span>
        <span class="supermarket-toggle">▼</span>
      </div>
      <div class="supermarket-prices">
        <table class="prices-table">
          <thead>
            <tr>
              <th>Producto</th>
              <th style="text-align: right;">Precio (Gs.)</th>
              <th>Unidad</th>
            </tr>
          </thead>
          <tbody>
            ${priceList.map(p => `
              <tr>
                <td>${p.product_name_raw || p.product}</td>
                <td class="price-value">${formatNumber(p.price_guaranies || p.price)}</td>
                <td>${p.unit || 'kg'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `).join('');

  elements.rawPricesContainer.innerHTML = html;
}

// Toggle supermarket collapse
window.toggleSupermarket = function(header) {
  const group = header.parentElement;
  group.classList.toggle('collapsed');
};

// Run Now Handler
async function handleRunNow() {
  elements.runNowBtn.disabled = true;
  elements.runNowBtn.innerHTML = '<span class="btn-icon">⏳</span> Ejecutando...';

  // Show modal
  elements.progressModal.classList.remove('hidden');
  elements.progressBar.style.width = '5%';
  elements.progressLog.textContent = 'Iniciando analisis...\n';
  elements.closeModalBtn.classList.add('hidden');

  try {
    const response = await fetch('/api/run-analysis', { method: 'POST' });
    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error);
    }

    elements.progressLog.textContent += 'Analisis en progreso. Monitoreando via WebSocket...\n';
    elements.progressBar.style.width = '10%';
  } catch (error) {
    elements.progressLog.textContent += `Error: ${error.message}\n`;
    elements.closeModalBtn.classList.remove('hidden');
    resetRunButton();
  }
}

// WebSocket Setup
function setupWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws/progress`);

  ws.onopen = () => {
    console.log('WebSocket connected');
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleProgressUpdate(data);
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    // Attempt to reconnect after 5 seconds
    setTimeout(setupWebSocket, 5000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

function handleProgressUpdate(data) {
  if (data.type === 'output') {
    elements.progressLog.textContent += data.message;
    elements.progressLog.scrollTop = elements.progressLog.scrollHeight;

    // Update progress bar based on output
    if (data.message.includes('Escaneando')) {
      elements.progressBar.style.width = '30%';
    } else if (data.message.includes('Recolectados')) {
      elements.progressBar.style.width = '50%';
    } else if (data.message.includes('Analizando')) {
      elements.progressBar.style.width = '70%';
    } else if (data.message.includes('Guardando')) {
      elements.progressBar.style.width = '85%';
    }
  } else if (data.type === 'error') {
    elements.progressLog.textContent += `[ERROR] ${data.message}`;
    elements.progressLog.scrollTop = elements.progressLog.scrollHeight;
  } else if (data.type === 'complete') {
    elements.progressBar.style.width = '100%';
    elements.progressLog.textContent += `\n✅ ${data.message}\n`;
    elements.closeModalBtn.classList.remove('hidden');
    resetRunButton();

    // Reload data after completion
    if (data.success) {
      setTimeout(() => {
        loadReport();
      }, 1000);
    }
  }
}

function closeModal() {
  elements.progressModal.classList.add('hidden');
  elements.progressBar.style.width = '0%';
  elements.progressLog.textContent = '';
}

function resetRunButton() {
  elements.runNowBtn.disabled = false;
  elements.runNowBtn.innerHTML = '<span class="btn-icon">▶</span> Ejecutar Ahora';
}

// PDF Download Handler
async function handleDownloadPdf() {
  elements.downloadPdfBtn.disabled = true;
  elements.downloadPdfBtn.innerHTML = '<span class="btn-icon">⏳</span> Generando...';

  try {
    const response = await fetch('/api/export/pdf', { method: 'POST' });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Error generando PDF');
    }

    // Download the PDF
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aurelio-reporte-${new Date().toISOString().split('T')[0]}.pdf`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();

  } catch (error) {
    alert('Error: ' + error.message);
  } finally {
    elements.downloadPdfBtn.disabled = false;
    elements.downloadPdfBtn.innerHTML = '<svg class="btn-icon-svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> PDF';
  }
}

// Email Send Handler
async function handleSendEmail() {
  elements.sendEmailBtn.disabled = true;
  elements.sendEmailBtn.innerHTML = '<span class="btn-icon">⏳</span> Enviando...';

  try {
    const response = await fetch('/api/email/send', { method: 'POST' });
    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'Error enviando email');
    }

    alert('Email enviado exitosamente a ' + (result.sentTo || currentUser.email));

  } catch (error) {
    alert('Error: ' + error.message);
  } finally {
    elements.sendEmailBtn.disabled = false;
    elements.sendEmailBtn.innerHTML = '<svg class="btn-icon-svg" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg> Email';
  }
}

// Logout Handler
function handleLogout() {
  window.location.href = '/auth/logout';
}

// Utility Functions
function formatNumber(num) {
  if (num === null || num === undefined) return 'N/A';
  return Math.round(num).toLocaleString('es-PY');
}

function formatDate(dateStr) {
  if (!dateStr) return '--';
  const date = new Date(dateStr);
  return date.toLocaleDateString('es-PY', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function formatShortDate(dateStr) {
  if (!dateStr) return '--';
  const date = new Date(dateStr);
  return date.toLocaleDateString('es-PY', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function updateFooterTimestamp() {
  elements.footerTimestamp.textContent = new Date().toLocaleString('es-PY');
}
