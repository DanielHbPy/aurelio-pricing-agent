# AURELIO - Roadmap de Capacidades Futuras

## Visión

Transformar a Aurelio de un **agente de inteligencia de precios** a un **sistema autónomo de gestión de precios** que:
1. Investiga el mercado
2. Actualiza precios automáticamente en Zoho Books
3. Sincroniza con Luciana para cotizaciones instantáneas
4. Libera al equipo comercial para tareas estratégicas

---

## Fase 1: Automatización de Precios (Q1 2026)

### 1.1 Auto-Update de Precios en Zoho Books

**Objetivo:** Aurelio actualiza automáticamente los precios de venta en Zoho Books basado en su análisis semanal.

**Flujo propuesto:**
```
Aurelio analiza mercado → Calcula bandas de precios → Actualiza Zoho Books Items → Luciana usa precios actualizados
```

**Implementación técnica:**
- Usar Zoho Books API: `PUT /items/{item_id}` para actualizar `rate` (precio de venta)
- Crear campos personalizados en Zoho Books:
  - `precio_minimo` (piso de negociación)
  - `precio_meta` (precio objetivo)
  - `precio_maximo` (precio premium)
  - `fecha_actualizacion_aurelio`
  - `segmento_recomendado`

**Reglas de seguridad:**
- Nunca actualizar por debajo del piso absoluto
- Requiere aprobación humana si cambio > 15%
- Log de todos los cambios para auditoría
- Rollback automático si hay error

### 1.2 Integración Aurelio ↔ Luciana

**Objetivo:** Luciana consulta los precios actualizados por Aurelio para cada cotización.

**Flujo propuesto:**
```
Cliente pide cotización → Luciana consulta Zoho Books → Obtiene precio_meta del segmento del cliente → Ofrece precio personalizado
```

**Beneficios:**
- Cotizaciones instantáneas con precios competitivos
- Precios diferenciados por segmento automáticamente
- Sin intervención manual del equipo comercial

---

## Fase 2: Precios Dinámicos por Segmento (Q2 2026)

### 2.1 Price Lists por Segmento en Zoho Books

**Objetivo:** Mantener listas de precios separadas para cada segmento de cliente.

**Estructura:**
| Price List | Segmento | % de Mediana |
|------------|----------|--------------|
| `PL-CONSUMIDOR` | Consumidor Final | 90% |
| `PL-HORECA` | HORECA Premium | 75% |
| `PL-SUPERMERCADOS` | Supermercados | 68% |
| `PL-INSTITUCIONAL` | Institucional | 60% |

**Automatización:**
- Aurelio actualiza las 4 listas de precios cada jueves
- Zoho CRM asigna automáticamente la lista según el segmento del cliente
- Luciana detecta el segmento y aplica la lista correspondiente

### 2.2 Detección Automática de Segmento

**Objetivo:** Luciana identifica el segmento del cliente automáticamente.

**Señales para clasificación:**
- Historial de compras (volumen, frecuencia)
- Tipo de negocio (restaurant, supermercado, etc.)
- Canal de contacto (WhatsApp directo vs distribuidor)
- Palabras clave en mensajes ("para mi restaurant", "somos supermercado")

---

## Fase 3: Inteligencia Predictiva (Q3 2026)

### 3.1 Predicción de Demanda

**Objetivo:** Aurelio predice la demanda de cada producto para la próxima semana.

**Inputs:**
- Historial de ventas (Zoho Books)
- Tendencias de precios de mercado
- Estacionalidad
- Eventos especiales (feriados, fiestas)

**Outputs:**
- Proyección de demanda por producto
- Recomendación de producción para Wilson (Director de Productividad)
- Alertas de posible escasez o excedente

### 3.2 Pricing Dinámico por Inventario

**Objetivo:** Ajustar precios según nivel de inventario.

**Reglas:**
| Inventario | Ajuste de Precio |
|------------|------------------|
| Excedente (>120% de demanda esperada) | -5% para acelerar rotación |
| Normal (80-120%) | Precio estándar |
| Bajo (<80%) | +5% para maximizar margen |
| Crítico (<50%) | +10% y alerta a producción |

---

## Fase 4: Autonomía Comercial (Q4 2026)

### 4.1 Negociación Automática con Luciana

**Objetivo:** Luciana puede negociar precios dentro de las bandas definidas por Aurelio.

**Flujo:**
```
Cliente: "¿Me pueden hacer un descuento?"
Luciana: [Consulta bandas de Aurelio para este cliente/producto]
Luciana: "Puedo ofrecerle Gs. 12,500 por ser cliente frecuente" (dentro de banda)
```

**Reglas de negociación:**
- Clientes nuevos: empezar en `precio_maximo`
- Clientes recurrentes: ofrecer `precio_meta`
- Clientes VIP (>6 meses, >X volumen): puede llegar a `precio_minimo`
- Nunca bajar del piso absoluto

### 4.2 Descuentos por Volumen Automáticos

**Objetivo:** Aplicar descuentos escalonados según cantidad del pedido.

| Cantidad | Descuento |
|----------|-----------|
| 1-10 kg | 0% |
| 11-50 kg | 3% |
| 51-100 kg | 5% |
| >100 kg | 7% (requiere aprobación) |

### 4.3 Dashboard Ejecutivo en Tiempo Real

**Objetivo:** Panel para dirección con métricas clave.

**Métricas:**
- Margen promedio por producto (hoy vs meta)
- Ventas por segmento
- Oportunidades de mejora de precios
- Alertas de precios bajo piso
- Comparativa vs competencia

---

## Fase 5: Ecosistema Integrado (2027)

### 5.1 Conexión con Producción

**Flujo completo:**
```
Aurelio detecta alta demanda → Notifica a Wilson → Wilson ajusta producción → Inventario se optimiza → Precios se estabilizan
```

### 5.2 Alertas Proactivas al Equipo Comercial

**Tipos de alertas:**
- "Tomate cherry: mercado subió 15%, oportunidad de aumentar precios"
- "Locote rojo: 3 competidores bajaron precio, mantener posición premium"
- "Cliente X no compra hace 2 semanas, sugerir promoción"

### 5.3 Reportes para Inversores

**Aurelio genera automáticamente:**
- Análisis de márgenes mensuales
- Posicionamiento vs mercado
- Tendencias de precios de commodities
- Proyecciones de ingresos

---

## Beneficios Esperados

| Métrica | Actual | Con Automatización |
|---------|--------|-------------------|
| Tiempo de cotización | 5-10 min | Instantáneo |
| Errores de precio | Frecuentes | Eliminados |
| Margen promedio | Variable | Optimizado +10-15% |
| Horas equipo comercial en pricing | 10h/semana | 0h/semana |
| Actualización de precios | Manual, esporádica | Automática, semanal |

---

## Próximos Pasos Inmediatos

1. **Crear campos personalizados en Zoho Books Items**
   - `cf_precio_minimo`, `cf_precio_meta`, `cf_precio_maximo`
   - `cf_segmento_recomendado`, `cf_fecha_aurelio`

2. **Implementar endpoint de actualización en Aurelio**
   - `aurelio.mjs --update-prices` (con flag de dry-run)
   - Log detallado de cambios

3. **Modificar Luciana para consultar bandas de precios**
   - Leer campos personalizados de Zoho Books
   - Aplicar precio según segmento del cliente

4. **Definir proceso de aprobación**
   - Cambios <15%: automático
   - Cambios >15%: notificación a Daniel/Fernando para aprobación

---

## Riesgos y Mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Error en scraping causa precio incorrecto | Validación: precio nuevo debe estar ±30% del anterior |
| Cliente recibe precio desactualizado | Timestamp de última actualización visible |
| Competencia monitorea nuestros precios | Los precios B2B no son públicos |
| Pérdida de margen por automatización | Piso absoluto nunca se viola |

---

*"El futuro del pricing es autónomo. El equipo comercial debe enfocarse en relaciones, no en calculadoras."*

— **Aurelio Benítez**, Enero 2026

---

<small>Documento de planificación estratégica | HidroBio S.A. | Versión 1.0</small>
