(() => {
  'use strict';

  const HARDENING_VERSION = '2026.08.04-C9.8';
  const SALES_QUEUE_KEY = typeof VENTAS_PENDIENTES_SYNC_KEY === 'string'
    ? VENTAS_PENDIENTES_SYNC_KEY
    : 'ventasPendientesSync';
  const CASH_QUEUE_KEY = 'senorArepaCajaPendienteV4';
  const LEGACY_CASH_QUEUE_KEY = 'senorArepaCajaPendienteV3';
  const MAX_QUEUE_ITEMS = 5000;
  const HISTORY_BATCH_SIZE = 500;
  const HISTORY_MAX_DOCS = 50000;
  const OFFLINE_DEVICE_KEY = 'senorArepaDeviceIdV1';
  let syncingSalesSecurely = false;
  let syncingCashSecurely = false;
  let inventoryMigrationAttempted = false;

  const KNOWN_EMAILS = new Set(['admin@local.io', 'administrador@local.io', 'cajero@local.io']);
  const MANAGEMENT_EMAILS = new Set(['admin@local.io', 'administrador@local.io']);
  const ADMIN_EMAILS = new Set(['admin@local.io']);

  const baseNormalizarVenta = typeof normalizarVenta === 'function' ? normalizarVenta : (value => value || {});
  const baseNormalizarControlCaja = typeof normalizarControlCaja === 'function' ? normalizarControlCaja : (value => value || {});
  const baseRegistrarAuditoria = typeof registrarAuditoria === 'function' ? registrarAuditoria : null;
  const baseAbrirHistoricos = typeof abrirHistoricos === 'function' ? abrirHistoricos : null;
  const baseAbrirDomicilios = typeof abrirDomiciliosVista === 'function' ? abrirDomiciliosVista : null;
  const baseVerVentasDia = typeof verVentasDetalladasPorFecha === 'function' ? verVentasDetalladasPorFecha : null;
  const baseVerDomiciliosDia = typeof verDomiciliosDetalladosPorFecha === 'function' ? verDomiciliosDetalladosPorFecha : null;
  const baseExportarVentasDia = typeof exportarVentasDelDiaHistorico === 'function' ? exportarVentasDelDiaHistorico : null;
  const baseExportarDomiciliosDia = typeof exportarDomiciliosDelDia === 'function' ? exportarDomiciliosDelDia : null;

  function cleanText(value, max = 250) {
    return String(value ?? '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
      .slice(0, max);
  }

  function clonePlain(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function fieldValueServerTimestamp() {
    const factory = globalThis.firebase?.firestore?.FieldValue?.serverTimestamp;
    if (typeof factory !== 'function') {
      throw new Error('El SDK de Firestore no tiene disponible serverTimestamp().');
    }
    return factory();
  }

  function isOnlineFirebase() {
    return Boolean(
      navigator.onLine &&
      typeof firestoreDb !== 'undefined' && firestoreDb &&
      typeof firebaseAuth !== 'undefined' && firebaseAuth?.currentUser &&
      typeof firestoreDisponible !== 'undefined' && firestoreDisponible
    );
  }

  async function diagnosticarPermisosFirestoreC94(mostrarAviso = false) {
    const email = cleanText(firebaseAuth?.currentUser?.email || '', 150).toLowerCase();
    const projectId = cleanText(firestoreDb?.app?.options?.projectId || firebaseAuth?.app?.options?.projectId || '', 100);
    const resultado = {
      version: HARDENING_VERSION,
      projectId,
      email,
      autenticado: Boolean(firebaseAuth?.currentUser),
      ventasLectura: false,
      controlCajaLectura: false,
      movimientosInventarioGet: false,
      errores: []
    };

    if (!firestoreDb || !firebaseAuth?.currentUser) {
      resultado.errores.push('Firebase no está inicializado o no hay una sesión autenticada.');
      if (mostrarAviso) notify(resultado.errores[0], 'warning');
      return resultado;
    }

    const pruebas = [
      ['ventasLectura', () => firestoreDb.collection('ventas').limit(1).get()],
      ['controlCajaLectura', () => firestoreDb.collection('controlCaja').doc('diagnostico_c97').get()],
      ['movimientosInventarioGet', () => firestoreDb.collection('movimientosInventario').doc('diagnostico_c97').get()]
    ];

    for (const [campo, ejecutar] of pruebas) {
      try {
        await ejecutar();
        resultado[campo] = true;
      } catch (error) {
        resultado.errores.push(`${campo}: ${cleanText(error?.message || error, 300)}`);
      }
    }

    const correcto = resultado.ventasLectura && resultado.controlCajaLectura && resultado.movimientosInventarioGet;
    console.info('[Señor Arepa] Diagnóstico Firestore C9.8', resultado);
    if (mostrarAviso) {
      notify(
        correcto
          ? `Permisos Firestore C9.8 verificados para ${email}.`
          : `Las reglas C9.8 no están activas para ${email || 'la cuenta actual'}. Publica firestore.rules antes de continuar.`,
        correcto ? 'success' : 'error'
      );
    }
    return resultado;
  }
  window.diagnosticarPermisosFirestoreC94 = diagnosticarPermisosFirestoreC94;
  window.diagnosticarPermisosFirestoreC98 = diagnosticarPermisosFirestoreC94;

  function notify(message, type = 'info') {
    if (typeof window.notificarSistema === 'function') {
      window.notificarSistema(message, type);
      return;
    }
    console[type === 'error' ? 'error' : 'log'](message);
  }

  function normalizeKey(value = '') {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .trim();
  }

  function slug(value = '') {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'producto';
  }

  function shortHash(value = '') {
    let hash = 2166136261;
    for (const char of String(value)) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36).slice(0, 8);
  }

  function stableProductId(category, name, previousId = '') {
    const existing = cleanText(previousId, 100);
    if (existing && !/^\w+-\d{10,}-\d+$/.test(existing)) return existing;
    const base = `${category}_${slug(name)}`;
    return `prod_${base}_${shortHash(`${category}|${name}`)}`;
  }

  function stableInventoryId(productId, name, existing = '') {
    const current = cleanText(existing, 100);
    if (current) return current;
    return `inv_${slug(name)}_${shortHash(productId || name)}`;
  }

  function timestampToDate(value) {
    try {
      if (!value) return null;
      if (value instanceof Date) return value;
      if (typeof value.toDate === 'function') return value.toDate();
      if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    } catch (_) {
      return null;
    }
  }

  function colombiaDayKey(date) {
    const shifted = new Date(date.getTime() - 5 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
  }

  function firestoreDocId(value = '') {
    const safe = cleanText(value, 500).replaceAll('/', '_').replace(/^\.+$/, '_');
    return safe || `doc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function randomOperationId(prefix = 'op') {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }

  function getDeviceId() {
    let value = localStorage.getItem(OFFLINE_DEVICE_KEY);
    if (!value) {
      value = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      guardarLocalStorageSeguro(OFFLINE_DEVICE_KEY, value, { critico: false });
    }
    return value;
  }

  function saleIdentity(sale = {}) {
    return cleanText(sale._localId || sale._docId || sale.id || `${sale.diaClave || ''}_${sale.comanda || ''}_${sale.recibo || ''}`, 500);
  }

  function productByName(name = '') {
    const key = normalizeKey(name);
    for (const [category, products] of Object.entries(catalogoProductos || {})) {
      const found = (Array.isArray(products) ? products : []).find(product => normalizeKey(product?.nombre) === key);
      if (found) return { ...found, categoria: category };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Corrección 2: IDs estables para catálogo, pedidos e inventario.
  // ---------------------------------------------------------------------------
  function normalizeCatalog(source = null) {
    const input = source && typeof source === 'object' ? source : {};
    const output = { comida: [], adiciones: [], bebidas: [] };
    for (const category of Object.keys(output)) {
      const definition = typeof DEFINICIONES_CATALOGO !== 'undefined' ? DEFINICIONES_CATALOGO[category] : null;
      const defaultIcon = definition?.iconoDefecto || (category === 'bebidas' ? '🥤' : '•');
      const list = Array.isArray(input[category]) ? input[category] : [];
      output[category] = list.map((raw, index) => {
        const name = cleanText(raw?.nombre || `${definition?.titulo || category} ${index + 1}`, 150);
        const productId = stableProductId(category, name, raw?.productId || raw?.id || '');
        const inventoryId = category === 'bebidas'
          ? stableInventoryId(productId, name, raw?.inventoryId)
          : '';
        return {
          id: productId,
          productId,
          inventoryId,
          categoria: category,
          nombre: name,
          precio: Math.max(0, Number(raw?.precio || 0)),
          icono: cleanText(raw?.icono || defaultIcon, 12),
          activo: raw?.activo !== false
        };
      }).filter(product => product.nombre && product.activo !== false);
    }
    return output;
  }

  normalizarCatalogoProductos = normalizeCatalog;
  window.normalizarCatalogoProductos = normalizeCatalog;

  extraerCatalogoBaseDesdeDOM = function() {
    const output = { comida: [], adiciones: [], bebidas: [] };
    for (const category of Object.keys(output)) {
      const definition = DEFINICIONES_CATALOGO?.[category];
      const grid = document.querySelector(definition?.selectorGrid || '');
      if (!grid) continue;
      grid.querySelectorAll('button').forEach(button => {
        const onclickText = button.getAttribute('onclick') || '';
        const match = onclickText.match(/agregarProducto\('([^']+)'\s*,\s*([0-9.]+)/);
        if (!match) return;
        const name = cleanText(match[1], 150);
        const productId = stableProductId(category, name);
        output[category].push({
          id: productId,
          productId,
          inventoryId: category === 'bebidas' ? stableInventoryId(productId, name) : '',
          categoria: category,
          nombre: name,
          precio: Math.max(0, Number(match[2] || 0)),
          icono: typeof obtenerIconoDesdeTexto === 'function'
            ? obtenerIconoDesdeTexto(button.textContent || '', definition?.iconoDefecto || '•')
            : (definition?.iconoDefecto || '•'),
          activo: true
        });
      });
    }
    return output;
  };
  window.extraerCatalogoBaseDesdeDOM = extraerCatalogoBaseDesdeDOM;

  prepararPayloadCatalogoFirestore = function() {
    const normalized = normalizeCatalog(catalogoProductos || {});
    const payload = {};
    for (const [category, products] of Object.entries(normalized)) {
      payload[category] = products.map(product => ({
        id: product.productId,
        productId: product.productId,
        inventoryId: product.inventoryId || '',
        categoria: category,
        nombre: product.nombre,
        precio: product.precio,
        icono: product.icono,
        activo: product.activo !== false
      }));
    }
    payload.updatedAt = fieldValueServerTimestamp();
    payload.updatedBy = cleanText(firebaseAuth?.currentUser?.email || localStorage.getItem('usuarioEmailActual') || '', 150);
    payload.schemaVersion = 3;
    return payload;
  };
  window.prepararPayloadCatalogoFirestore = prepararPayloadCatalogoFirestore;

  function addProductSecure(nameOrProduct, price = 0, metadata = {}) {
    const raw = typeof nameOrProduct === 'object'
      ? nameOrProduct
      : { nombre: nameOrProduct, precio: price, ...metadata };
    const match = raw.productId ? raw : productByName(raw.nombre) || raw;
    const item = {
      nombre: cleanText(match.nombre, 150),
      precio: Math.max(0, Number(match.precio ?? price ?? 0)),
      productId: cleanText(match.productId || match.id || '', 100),
      inventoryId: cleanText(match.inventoryId || '', 100),
      categoria: cleanText(match.categoria || metadata.categoria || '', 30)
    };
    if (!item.nombre) return;
    if (item.categoria === 'bebidas' || item.inventoryId) {
      const inventoryKey = item.inventoryId || normalizeKey(item.nombre);
      const stockInfo = inventarioBebidasEstado?.[inventoryKey] || inventarioBebidasEstado?.[normalizeKey(item.nombre)];
      const stock = Number(stockInfo?.cantidad ?? NaN);
      const selected = pedido.filter(product => (product.inventoryId || normalizeKey(product.nombre)) === inventoryKey).length;
      if (Number.isFinite(stock) && selected >= stock) {
        alert(`No hay más unidades disponibles de ${item.nombre}. Stock actual: ${stock}.`);
        return;
      }
    }
    pedido.push(item);
    if (typeof actualizarTotal === 'function') actualizarTotal();
    if (typeof actualizarVistaPedido === 'function') actualizarVistaPedido();
  }

  agregarProducto = addProductSecure;
  window.agregarProducto = addProductSecure;

  renderizarCategoriaCatalogo = function(category) {
    const definition = DEFINICIONES_CATALOGO?.[category];
    const grid = document.querySelector(definition?.selectorGrid || '');
    if (!grid) return;
    const fragment = document.createDocumentFragment();
    (catalogoProductos?.[category] || []).forEach(product => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = definition.claseBoton;
      button.dataset.productName = product.nombre;
      button.dataset.productId = product.productId || product.id || '';
      button.dataset.inventoryId = product.inventoryId || '';
      button.dataset.category = category;
      button.dataset.originalLabel = typeof obtenerEtiquetaBotonProducto === 'function'
        ? obtenerEtiquetaBotonProducto(product, category)
        : `${product.icono || '•'} ${product.nombre} - $${Number(product.precio || 0).toLocaleString('es-CO')}`;
      const label = document.createElement('span');
      label.textContent = button.dataset.originalLabel;
      button.appendChild(label);
      button.addEventListener('click', () => addProductSecure({ ...product, categoria: category }));
      fragment.appendChild(button);
    });
    grid.replaceChildren(fragment);
  };
  window.renderizarCategoriaCatalogo = renderizarCategoriaCatalogo;

  actualizarProductosBebidaInventarioDesdeCatalogo = function() {
    PRODUCTOS_BEBIDA_INVENTARIO = new Set();
    (catalogoProductos?.bebidas || []).forEach(product => {
      PRODUCTOS_BEBIDA_INVENTARIO.add(product.inventoryId || normalizeKey(product.nombre));
      PRODUCTOS_BEBIDA_INVENTARIO.add(normalizeKey(product.nombre));
    });
  };
  window.actualizarProductosBebidaInventarioDesdeCatalogo = actualizarProductosBebidaInventarioDesdeCatalogo;

  obtenerMapaInventarioDesdeArray = function(items = []) {
    const map = {};
    (Array.isArray(items) ? items : []).forEach(item => {
      const legacyKey = normalizeKey(item?.nombreNormalizado || item?.nombre || '');
      const inventoryId = cleanText(item?.inventoryId || '', 100);
      const info = {
        ...item,
        nombre: cleanText(item?.nombre || legacyKey || inventoryId, 150),
        cantidad: Number(item?.cantidad || 0),
        unidad: cleanText(item?.unidad || 'unidades', 40),
        inventoryId: inventoryId || ''
      };
      if (inventoryId) map[inventoryId] = info;
      if (legacyKey) map[legacyKey] = info;
    });
    return map;
  };
  window.obtenerMapaInventarioDesdeArray = obtenerMapaInventarioDesdeArray;

  contarBebidasPedidoInventario = function(order = []) {
    const count = {};
    (Array.isArray(order) ? order : []).forEach(raw => {
      const match = raw?.productId ? raw : productByName(raw?.nombre) || raw;
      const isDrink = match?.categoria === 'bebidas' || Boolean(match?.inventoryId) || (catalogoProductos?.bebidas || []).some(product => normalizeKey(product.nombre) === normalizeKey(match?.nombre));
      if (!isDrink) return;
      const inventoryId = cleanText(match?.inventoryId || '', 100) || normalizeKey(match?.nombre);
      if (!inventoryId) return;
      if (!count[inventoryId]) {
        count[inventoryId] = {
          nombre: cleanText(match?.nombre || inventoryId, 150),
          cantidad: 0,
          productId: cleanText(match?.productId || match?.id || '', 100),
          inventoryId,
          legacyKey: normalizeKey(match?.nombre)
        };
      }
      count[inventoryId].cantidad += 1;
    });
    return count;
  };
  window.contarBebidasPedidoInventario = contarBebidasPedidoInventario;

  calcularAjustesInventarioBebidas = function(previousOrder = [], nextOrder = []) {
    const previous = contarBebidasPedidoInventario(previousOrder);
    const next = contarBebidasPedidoInventario(nextOrder);
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    const adjustments = {};
    keys.forEach(key => {
      const oldQuantity = Number(previous[key]?.cantidad || 0);
      const newQuantity = Number(next[key]?.cantidad || 0);
      const difference = oldQuantity - newQuantity;
      if (!difference) return;
      const source = next[key] || previous[key] || {};
      adjustments[key] = {
        nombre: source.nombre || key,
        cantidad: difference,
        productId: source.productId || '',
        inventoryId: source.inventoryId || key,
        legacyKey: source.legacyKey || normalizeKey(source.nombre)
      };
    });
    return adjustments;
  };
  window.calcularAjustesInventarioBebidas = calcularAjustesInventarioBebidas;

  aplicarAjustesInventarioLocal = function(adjustments = {}) {
    const entries = Object.entries(adjustments || {});
    if (!entries.length) return;
    try {
      const inventory = JSON.parse(localStorage.getItem(INVENTARIO_STORAGE_KEY) || '[]');
      let changed = false;
      for (const [key, adjustment] of entries) {
        const index = inventory.findIndex(item =>
          cleanText(item?.inventoryId, 100) === key ||
          normalizeKey(item?.nombreNormalizado || item?.nombre) === (adjustment?.legacyKey || normalizeKey(adjustment?.nombre))
        );
        if (index < 0) continue;
        inventory[index].inventoryId = inventory[index].inventoryId || key;
        inventory[index].productId = inventory[index].productId || adjustment?.productId || '';
        inventory[index].nombreNormalizado = inventory[index].nombreNormalizado || normalizeKey(inventory[index].nombre);
        inventory[index].cantidad = Math.max(0, Number(inventory[index].cantidad || 0) + Number(adjustment?.cantidad || 0));
        inventory[index].fechaISOCliente = new Date().toISOString();
        changed = true;
      }
      if (changed) {
        guardarLocalStorageSeguro(INVENTARIO_STORAGE_KEY, inventory, { critico: false });
        inventarioBebidasEstado = obtenerMapaInventarioDesdeArray(inventory);
        if (typeof actualizarAlertasStockBebidas === 'function') actualizarAlertasStockBebidas(inventarioBebidasEstado);
      }
    } catch (error) {
      console.error('No se pudo aplicar el ajuste local de inventario:', error);
    }
  };
  window.aplicarAjustesInventarioLocal = aplicarAjustesInventarioLocal;

  const secureNormalizarVenta = function(rawSale = {}) {
    const rawOrder = Array.isArray(rawSale?.pedido) ? rawSale.pedido : [];
    const normalized = baseNormalizarVenta(rawSale || {});
    normalized.pedido = (Array.isArray(normalized.pedido) ? normalized.pedido : []).map((item, index) => {
      const original = rawOrder[index] || item;
      const catalogMatch = original?.productId ? original : productByName(original?.nombre || item?.nombre);
      return {
        nombre: cleanText(item?.nombre || original?.nombre, 150),
        precio: Math.max(0, Number(item?.precio ?? original?.precio ?? 0)),
        productId: cleanText(original?.productId || original?.id || catalogMatch?.productId || catalogMatch?.id || '', 100),
        inventoryId: cleanText(original?.inventoryId || catalogMatch?.inventoryId || '', 100),
        categoria: cleanText(original?.categoria || catalogMatch?.categoria || '', 30)
      };
    });
    normalized.version = Math.max(0, Number(rawSale?.version ?? normalized.version ?? 0));
    normalized._ultimaOperacionId = cleanText(rawSale?._ultimaOperacionId || normalized._ultimaOperacionId || '', 150);
    const serverDate = timestampToDate(rawSale?.creadoServidor || rawSale?.fechaServidor || rawSale?.actualizadoServidor);
    if (serverDate) {
      normalized.fechaOficialISO = serverDate.toISOString();
      normalized.diaClaveOficial = colombiaDayKey(serverDate);
      normalized.horaFuente = 'servidor';
    } else {
      normalized.fechaOficialISO = cleanText(rawSale?.fechaOficialISO || normalized.fechaOficialISO || '', 50);
      normalized.diaClaveOficial = cleanText(rawSale?.diaClaveOficial || normalized.diaClaveOficial || '', 20);
      normalized.horaFuente = normalized.horaFuente || 'dispositivo';
    }
    return normalized;
  };

  normalizarVenta = secureNormalizarVenta;
  window.normalizarVenta = secureNormalizarVenta;

  const secureNormalizarCaja = function(raw = {}, day = '') {
    const normalized = baseNormalizarControlCaja(raw, day);
    normalized.version = Math.max(0, Number(raw?.version ?? normalized.version ?? 0));
    normalized._ultimaOperacionId = cleanText(raw?._ultimaOperacionId || normalized._ultimaOperacionId || '', 150);
    normalized._syncEstado = ['pendiente', 'sincronizado', 'error'].includes(raw?._syncEstado)
      ? raw._syncEstado
      : (normalized._syncEstado || 'sincronizado');
    return normalized;
  };
  normalizarControlCaja = secureNormalizarCaja;
  window.normalizarControlCaja = secureNormalizarCaja;

  // ---------------------------------------------------------------------------
  // Correcciones 3, 4, 6 y 8: cola ordenada, versiones, consecutivos oficiales
  // y sellos de tiempo del servidor.
  // ---------------------------------------------------------------------------
  function readSalesQueue() {
    let data = [];
    try { data = JSON.parse(localStorage.getItem(SALES_QUEUE_KEY) || '[]'); } catch (_) {}
    if (!Array.isArray(data)) return [];
    return data.map((item, index) => {
      const sale = secureNormalizarVenta(item?.venta || {});
      return {
        operacionId: firestoreDocId(item?.operacionId || `legacy_${saleIdentity(sale)}_${index}`),
        tipo: item?.tipo === 'delete' ? 'delete' : 'set',
        venta: sale,
        ajustesInventario: item?.ajustesInventario && typeof item.ajustesInventario === 'object' ? item.ajustesInventario : {},
        creadoEn: cleanText(item?.creadoEn || new Date().toISOString(), 50),
        secuencia: Number(item?.secuencia || index + 1),
        intentos: Number(item?.intentos || 0),
        ultimoError: cleanText(item?.ultimoError || '', 500),
        estado: ['pendiente', 'error', 'bloqueada'].includes(item?.estado) ? item.estado : 'pendiente',
        versionEsperada: Math.max(0, Number(item?.versionEsperada ?? Math.max(0, Number(sale.version || 1) - 1))),
        deviceId: cleanText(item?.deviceId || getDeviceId(), 100)
      };
    }).sort((a, b) => String(a.creadoEn).localeCompare(String(b.creadoEn)) || a.secuencia - b.secuencia);
  }

  function writeSalesQueue(items = []) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > MAX_QUEUE_ITEMS) {
      throw new Error(`La cola de ventas alcanzó ${MAX_QUEUE_ITEMS} operaciones. Debes sincronizar antes de registrar más cambios.`);
    }
    const serialized = JSON.stringify(list);
    if (!guardarLocalStorageSeguro(SALES_QUEUE_KEY, serialized, { critico: true })) {
      throw new Error('No fue posible guardar la cola local de ventas. Libera espacio del navegador.');
    }
    updateQueueStatus();
    return list;
  }

  obtenerVentasPendientesSync = readSalesQueue;
  guardarVentasPendientesSync = writeSalesQueue;
  window.obtenerVentasPendientesSync = readSalesQueue;
  window.guardarVentasPendientesSync = writeSalesQueue;

  guardarVentaPendienteSync = function(sale, inventoryAdjustments = {}, type = 'set', options = {}) {
    const normalizedSale = secureNormalizarVenta(sale || {});
    const list = readSalesQueue();
    const operation = {
      operacionId: firestoreDocId(options.operacionId || randomOperationId(type === 'delete' ? 'del' : 'set')),
      tipo: type === 'delete' ? 'delete' : 'set',
      venta: normalizedSale,
      ajustesInventario: inventoryAdjustments || {},
      creadoEn: options.creadoEn || new Date().toISOString(),
      secuencia: Math.max(Date.now() * 1000, Number(list.at(-1)?.secuencia || 0) + 1),
      intentos: 0,
      ultimoError: '',
      estado: 'pendiente',
      versionEsperada: Math.max(0, Number(options.versionEsperada ?? (type === 'delete' ? normalizedSale.version : Math.max(0, normalizedSale.version - 1)))),
      deviceId: getDeviceId()
    };
    if (!list.some(item => item.operacionId === operation.operacionId)) list.push(operation);
    writeSalesQueue(list);
    return operation;
  };
  window.guardarVentaPendienteSync = guardarVentaPendienteSync;

  function userContext() {
    const email = cleanText(firebaseAuth?.currentUser?.email || '', 150).toLowerCase();
    return {
      email,
      uid: cleanText(firebaseAuth?.currentUser?.uid || '', 150),
      usuario: cleanText(typeof usuarioActual !== 'undefined' ? usuarioActual : '', 100),
      rol: cleanText(typeof rolActual !== 'undefined' ? rolActual : '', 50)
    };
  }

  async function resolveInventoryReference(key, adjustment) {
    try {
      const localInventory = JSON.parse(localStorage.getItem(INVENTARIO_STORAGE_KEY) || '[]');
      const legacyKey = cleanText(adjustment?.legacyKey || normalizeKey(adjustment?.nombre), 150);
      const cached = localInventory.find(item =>
        String(item?.inventoryId || '') === String(key) ||
        (legacyKey && String(item?.nombreNormalizado || '') === legacyKey)
      );
      if (cached?._docId || cached?.id) {
        return firestoreDb.collection(INVENTARIO_COLLECTION).doc(firestoreDocId(cached._docId || cached.id));
      }
    } catch (_) {}

    const direct = firestoreDb.collection(INVENTARIO_COLLECTION).doc(firestoreDocId(key));
    const directSnap = await direct.get();
    if (directSnap.exists) return direct;

    const byId = await firestoreDb.collection(INVENTARIO_COLLECTION).where('inventoryId', '==', key).limit(1).get();
    if (!byId.empty) return byId.docs[0].ref;

    const legacyKey = cleanText(adjustment?.legacyKey || normalizeKey(adjustment?.nombre), 150);
    if (legacyKey) {
      const legacy = await firestoreDb.collection(INVENTARIO_COLLECTION).where('nombreNormalizado', '==', legacyKey).limit(1).get();
      if (!legacy.empty) return legacy.docs[0].ref;
    }
    throw new Error(`No existe inventario vinculado al producto ${adjustment?.nombre || key}.`);
  }

  function isoWeekKeyFromDay(dayKey = '') {
    const match = String(dayKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return '';
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-S${String(week).padStart(2, '0')}`;
  }

  function saleSummaryContribution(value) {
    if (!value) return null;
    const sale = secureNormalizarVenta(value);
    const day = cleanText(sale.diaClave || colombiaDayKey(timestampToDate(sale.fechaServidor) || timestampToDate(sale.fechaISO) || new Date()), 20);
    const cancelled = String(sale.estado || '').toLowerCase() === 'cancelada';
    const delivery = String(sale.tipoPedido || '').toLowerCase() === 'domicilio';
    const productTotal = Number(sale.subtotalProductos ?? sale.total ?? 0) || (sale.pedido || []).reduce((sum, product) => sum + Number(product?.precio || 0), 0);
    const deliveryCost = Math.max(0, Number(sale.costoDomicilio || 0));
    const cash = typeof obtenerValorPagoPorMedio === 'function' ? Number(obtenerValorPagoPorMedio(sale, 'efectivo') || 0) : 0;
    const deliveryTransfer = !cancelled && delivery && typeof obtenerValorDomicilioCubiertoPorTransferencia === 'function'
      ? Number(obtenerValorDomicilioCubiertoPorTransferencia(sale) || 0) : 0;
    const deliveryCash = !cancelled && delivery && typeof obtenerValorDomicilioCubiertoPorEfectivo === 'function'
      ? Number(obtenerValorDomicilioCubiertoPorEfectivo(sale) || 0) : Math.max(0, deliveryCost - deliveryTransfer);
    const charged = Math.max(0, Number(sale.totalCobrado || 0) || productTotal + deliveryCost);
    return {
      day,
      week: isoWeekKeyFromDay(day),
      month: day.slice(0, 7),
      pedidosActivos: cancelled ? 0 : 1,
      pedidosCancelados: cancelled ? 1 : 0,
      domiciliosActivos: !cancelled && delivery ? 1 : 0,
      domiciliosCancelados: cancelled && delivery ? 1 : 0,
      domiciliosTransferenciaCantidad: deliveryTransfer > 0 ? 1 : 0,
      domiciliosEfectivoCantidad: deliveryCash > 0 ? 1 : 0,
      domiciliosTransferenciaValor: Math.max(0, deliveryTransfer),
      domiciliosEfectivoValor: Math.max(0, deliveryCash),
      totalVentas: cancelled ? 0 : Math.max(0, productTotal),
      totalDomicilios: !cancelled && delivery ? deliveryCost : 0,
      totalCobrado: cancelled ? 0 : charged,
      efectivo: cancelled ? 0 : cash,
      transferencias: cancelled ? 0 : Math.max(0, charged - cash)
    };
  }

  function summaryDelta(before, after) {
    const keys = ['pedidosActivos', 'pedidosCancelados', 'domiciliosActivos', 'domiciliosCancelados', 'domiciliosTransferenciaCantidad', 'domiciliosEfectivoCantidad', 'domiciliosTransferenciaValor', 'domiciliosEfectivoValor', 'totalVentas', 'totalDomicilios', 'totalCobrado', 'efectivo', 'transferencias'];
    return Object.fromEntries(keys.map(key => [key, Number(after?.[key] || 0) - Number(before?.[key] || 0)]));
  }

  function writeSummaryIncrement(transaction, collectionName, period, delta, timestamp, user) {
    if (!period || !delta || !Object.values(delta).some(value => Number(value) !== 0)) return;
    const increment = globalThis.firebase?.firestore?.FieldValue?.increment;
    if (typeof increment !== 'function') return;
    const ref = firestoreDb.collection(collectionName).doc(firestoreDocId(period));
    const payload = {
      periodo: period,
      actualizadoServidor: timestamp,
      actualizadoPor: user.usuario,
      actualizadoUid: user.uid,
      schemaVersion: 1
    };
    Object.entries(delta).forEach(([key, value]) => { payload[key] = increment(Number(value || 0)); });
    transaction.set(ref, payload, { merge: true });
  }

  function applySummaryDeltas(transaction, previousSale, nextSale, timestamp, user) {
    const previous = saleSummaryContribution(previousSale);
    const next = saleSummaryContribution(nextSale);
    const dimensions = [
      ['resumenVentasDiario', 'day'],
      ['resumenVentasSemanal', 'week'],
      ['resumenVentasMensual', 'month']
    ];
    dimensions.forEach(([collectionName, key]) => {
      if (previous?.[key] && previous[key] !== next?.[key]) {
        writeSummaryIncrement(transaction, collectionName, previous[key], summaryDelta(previous, null), timestamp, user);
      }
      if (next?.[key] && previous?.[key] !== next[key]) {
        writeSummaryIncrement(transaction, collectionName, next[key], summaryDelta(null, next), timestamp, user);
      }
      if (previous?.[key] && next?.[key] && previous[key] === next[key]) {
        writeSummaryIncrement(transaction, collectionName, next[key], summaryDelta(previous, next), timestamp, user);
      }
    });
  }

  async function executeSaleOperation(item) {
    if (!isOnlineFirebase()) throw new Error('Sin conexión autenticada con Firebase.');
    const sale = secureNormalizarVenta(item.venta || {});
    const docId = firestoreDocId(sale._docId || sale._localId || saleIdentity(sale) || randomOperationId('venta'));
    const saleRef = firestoreDb.collection('ventas').doc(docId);
    const user = userContext();
    if (!user.uid || !user.email || !KNOWN_EMAILS.has(user.email)) {
      throw new Error(`Usuario no autorizado para sincronizar ventas: ${user.email || 'sin correo autenticado'}.`);
    }
    const inventoryEntries = [];
    for (const [key, adjustment] of Object.entries(item.ajustesInventario || {})) {
      inventoryEntries.push({ key, adjustment, ref: await resolveInventoryReference(key, adjustment) });
    }

    let resultSale = { ...sale, _docId: docId };
    let alreadyApplied = false;
    await firestoreDb.runTransaction(async transaction => {
      const saleSnap = await transaction.get(saleRef);
      const remote = saleSnap.exists ? secureNormalizarVenta({ _docId: saleSnap.id, ...saleSnap.data() }) : null;
      if (remote?._ultimaOperacionId === item.operacionId) {
        resultSale = { ...remote, _docId: docId };
        alreadyApplied = true;
        return;
      }

      // Compatibilidad con colas antiguas: si la misma venta ya existe en
      // Firestore, no se intenta actualizarla nuevamente ni se duplica.
      const legacyCreateAlreadyStored = Boolean(
        remote
        && item.tipo !== 'delete'
        && Number(item.versionEsperada || 0) === 0
        && sale._localId
        && remote._localId === sale._localId
      );
      if (legacyCreateAlreadyStored) {
        resultSale = { ...remote, _docId: docId, _syncEstado: 'sincronizado' };
        alreadyApplied = true;
        return;
      }

      if (item.tipo === 'delete' && !remote) {
        alreadyApplied = true;
        return;
      }

      const remoteVersion = Number(remote?.version || 0);
      const expectedVersion = Number(item.versionEsperada || 0);

      if (!remote && item.tipo !== 'delete' && !KNOWN_EMAILS.has(user.email)) {
        throw new Error('La cuenta autenticada no puede crear ventas.');
      }
      if (remote && item.tipo !== 'delete' && !MANAGEMENT_EMAILS.has(user.email)) {
        throw new Error('El cajero puede crear ventas, pero no modificar una venta ya sincronizada.');
      }
      if (item.tipo === 'delete' && !ADMIN_EMAILS.has(user.email)) {
        throw new Error('Solo admin@local.io puede eliminar ventas.');
      }
      if (remoteVersion !== expectedVersion) {
        const error = new Error(`Conflicto de versión: la venta cambió en otro equipo (servidor ${remoteVersion}, esperado ${expectedVersion}).`);
        error.code = 'version-conflict';
        throw error;
      }

      let counterSnap = null;
      let counterRef = null;
      const needsOfficialConsecutive = item.tipo !== 'delete' && Boolean(sale.consecutivoTemporal);
      if (needsOfficialConsecutive) {
        counterRef = firestoreDb.collection('contadores').doc(firestoreDocId(sale.diaClave || colombiaDayKey(new Date())));
        counterSnap = await transaction.get(counterRef);
      }

      const movementReads = [];
      for (const entry of inventoryEntries) {
        const movementRef = firestoreDb.collection('movimientosInventario').doc(firestoreDocId(`${item.operacionId}_${entry.key}`));
        const movementSnap = await transaction.get(movementRef);
        const inventorySnap = await transaction.get(entry.ref);
        movementReads.push({ ...entry, movementRef, movementSnap, inventorySnap });
      }

      const timestamp = fieldValueServerTimestamp();
      let officialFields = {};
      if (needsOfficialConsecutive) {
        const counters = counterSnap?.exists ? counterSnap.data() : {};
        const command = Number(counters?.comanda || 0) + 1;
        const receipt = Number(counters?.recibo || 0) + 1;
        const delivery = sale.tipoPedido === 'Domicilio' ? Number(counters?.domicilio || 0) + 1 : Number(counters?.domicilio || 0);
        officialFields = {
          comandaTemporal: sale.comanda,
          reciboTemporal: sale.recibo,
          numeroDomicilioTemporal: sale.numeroDomicilio || null,
          comanda: command,
          recibo: receipt,
          numeroDomicilio: sale.tipoPedido === 'Domicilio' ? delivery : null,
          consecutivoTemporal: false,
          consecutivoOrigen: 'reservado_al_sincronizar',
          consecutivoOficialEn: timestamp
        };
        transaction.set(counterRef, {
          diaClave: sale.diaClave,
          comanda: command,
          recibo: receipt,
          domicilio: delivery,
          actualizadoEnCliente: new Date().toISOString(),
          actualizadoServidor: timestamp,
          actualizadoPor: user.usuario,
          actualizadoUid: user.uid
        }, { merge: true });
      }

      const targetVersion = item.tipo === 'delete'
        ? remoteVersion
        : (remote ? remoteVersion + 1 : 1);

      if (item.tipo === 'delete') {
        transaction.delete(saleRef);
      } else {
        const payload = clonePlain({
          ...sale,
          ...officialFields,
          _localId: sale._localId || docId,
          version: targetVersion,
          _ultimaOperacionId: item.operacionId,
          schemaVersion: 4,
          dispositivoId: item.deviceId,
          fechaClienteISO: sale.fechaISO || new Date().toISOString(),
          clienteBusqueda: cleanText(sale.cliente, 160).toLowerCase()
        });
        delete payload._docId;
        delete payload._syncEstado;
        // Los sellos de tiempo oficiales nunca se copian desde el navegador.
        delete payload.creadoServidor;
        delete payload.actualizadoServidor;
        delete payload.fechaServidor;
        payload.actualizadoServidor = timestamp;
        if (!remote) payload.creadoServidor = timestamp;
        transaction.set(saleRef, payload, { merge: Boolean(remote) });
        resultSale = secureNormalizarVenta({ ...payload, ...officialFields, _docId: docId, _syncEstado: 'sincronizado' });
      }

      applySummaryDeltas(transaction, remote, item.tipo === 'delete' ? null : resultSale, timestamp, user);

      for (const movement of movementReads) {
        if (movement.movementSnap.exists) continue;
        if (!movement.inventorySnap.exists) throw new Error(`Inventario inexistente para ${movement.adjustment?.nombre || movement.key}.`);
        const current = Number(movement.inventorySnap.data()?.cantidad || 0);
        const delta = Number(movement.adjustment?.cantidad || 0);
        const next = current + delta;
        if (next < 0) throw new Error(`Stock insuficiente para ${movement.adjustment?.nombre || movement.key}. Disponible: ${current}.`);
        transaction.update(movement.ref, {
          cantidad: next,
          inventoryId: movement.key,
          productId: movement.adjustment?.productId || '',
          nombreNormalizado: movement.adjustment?.legacyKey || normalizeKey(movement.adjustment?.nombre),
          fechaISOCliente: new Date().toISOString(),
          actualizadoServidor: timestamp
        });
        transaction.set(movement.movementRef, {
          operacionId: item.operacionId,
          ventaId: docId,
          tipoOperacion: item.tipo,
          producto: cleanText(movement.adjustment?.nombre || movement.key, 150),
          productId: cleanText(movement.adjustment?.productId || '', 100),
          inventoryId: movement.key,
          nombreNormalizado: movement.adjustment?.legacyKey || normalizeKey(movement.adjustment?.nombre),
          cantidadAnterior: current,
          cambio: delta,
          cantidadNueva: next,
          usuario: user.usuario,
          uid: user.uid,
          fechaISOCliente: new Date().toISOString(),
          fechaServidor: timestamp
        }, { merge: false });
      }

      const auditRef = firestoreDb.collection('auditoria').doc(firestoreDocId(`aud_${item.operacionId}`));
      transaction.set(auditRef, {
        id: auditRef.id,
        accion: item.tipo === 'delete' ? 'eliminar_venta' : (remote ? 'actualizar_venta' : 'crear_venta'),
        entidad: 'ventas',
        entidadId: docId,
        usuario: user.usuario,
        rol: user.rol,
        email: user.email,
        uid: user.uid,
        fechaISOCliente: new Date().toISOString(),
        fechaServidor: timestamp,
        diaClaveCliente: sale.diaClave || colombiaDayKey(new Date()),
        detalle: {
          operacionId: item.operacionId,
          versionAnterior: remoteVersion,
          versionNueva: item.tipo === 'delete' ? null : targetVersion,
          comanda: resultSale.comanda || sale.comanda || null,
          cliente: cleanText(sale.cliente, 120),
          dispositivoId: item.deviceId
        }
      }, { merge: false });
    });

    if (typeof registrarHeartbeatFirebase === 'function') registrarHeartbeatFirebase();
    return { docId, venta: resultSale, alreadyApplied };
  }

  function applyOfficialDataToPendingSale(target, official) {
    if (!official) return target;
    return secureNormalizarVenta({
      ...target,
      _docId: official._docId || target._docId,
      comanda: official.comanda ?? target.comanda,
      recibo: official.recibo ?? target.recibo,
      numeroDomicilio: official.numeroDomicilio ?? target.numeroDomicilio,
      comandaTemporal: official.comandaTemporal ?? target.comandaTemporal,
      reciboTemporal: official.reciboTemporal ?? target.reciboTemporal,
      numeroDomicilioTemporal: official.numeroDomicilioTemporal ?? target.numeroDomicilioTemporal,
      consecutivoTemporal: official.consecutivoTemporal ?? target.consecutivoTemporal,
      consecutivoOrigen: official.consecutivoOrigen || target.consecutivoOrigen
    });
  }

  sincronizarVentasPendientesEnSegundoPlano = async function() {
    if (syncingSalesSecurely || !isOnlineFirebase()) return { exitosas: 0, fallidas: 0, bloqueadas: 0 };
    let queue = readSalesQueue();
    if (!queue.length) return { exitosas: 0, fallidas: 0, bloqueadas: 0 };
    syncingSalesSecurely = true;
    let success = 0;
    let failed = 0;
    let blocked = 0;
    const blockedSales = new Set();
    try {
      for (const original of [...queue]) {
        const identity = saleIdentity(original.venta);
        if (blockedSales.has(identity)) {
          queue = queue.map(item => item.operacionId === original.operacionId
            ? { ...item, estado: 'bloqueada', ultimoError: 'Bloqueada hasta resolver una operación anterior de la misma venta.' }
            : item);
          blocked += 1;
          continue;
        }
        try {
          const result = await executeSaleOperation(original);
          queue = queue.filter(item => item.operacionId !== original.operacionId);
          if (result.venta && original.tipo !== 'delete') {
            queue = queue.map(item => saleIdentity(item.venta) === identity
              ? { ...item, venta: applyOfficialDataToPendingSale(item.venta, result.venta), estado: 'pendiente', ultimoError: '' }
              : item);
            const stillPending = queue.some(item => saleIdentity(item.venta) === identity);
            const currentLocal = typeof obtenerVentasStorage === 'function'
              ? obtenerVentasStorage().find(item => saleIdentity(item) === identity)
              : null;
            const merged = applyOfficialDataToPendingSale(currentLocal || result.venta, result.venta);
            merged._syncEstado = stillPending ? 'pendiente' : 'sincronizado';
            if (typeof upsertVentaEnCacheLocal === 'function') upsertVentaEnCacheLocal(merged);
            if (!stillPending && typeof guardarReferenciaUltimaVenta === 'function') guardarReferenciaUltimaVenta(merged);
          }
          writeSalesQueue(queue);
          success += 1;
        } catch (error) {
          const message = cleanText(error?.message || error, 500);
          const permissionDenied = String(error?.code || '').includes('permission-denied')
            || /missing or insufficient permissions/i.test(String(error?.message || ''));
          const detailedMessage = permissionDenied
            ? `${message} Cuenta autenticada: ${firebaseAuth?.currentUser?.email || 'sin correo'}. Publica firestore.rules C9.8: esta versión habilita la lectura GET de movimientosInventario que la transacción usa para impedir descuentos duplicados.`
            : message;
          queue = queue.map(item => item.operacionId === original.operacionId
            ? { ...item, intentos: Number(item.intentos || 0) + 1, ultimoError: detailedMessage, estado: 'error' }
            : item);
          blockedSales.add(identity);
          if (original.tipo !== 'delete' && typeof upsertVentaEnCacheLocal === 'function') {
            upsertVentaEnCacheLocal({ ...original.venta, _syncEstado: 'error', syncError: detailedMessage });
          }
          writeSalesQueue(queue);
          failed += 1;
          console.error('Operación de venta detenida:', error);
          if (!navigator.onLine) break;
        }
      }
    } finally {
      syncingSalesSecurely = false;
      updateQueueStatus();
      if (typeof mostrarVentas === 'function') mostrarVentas();
      if (typeof refrescarVistasAnaliticasSiEstanAbiertas === 'function') refrescarVistasAnaliticasSiEstanAbiertas();
    }
    return { exitosas: success, fallidas: failed, bloqueadas: blocked };
  };
  window.sincronizarVentasPendientesEnSegundoPlano = sincronizarVentasPendientesEnSegundoPlano;

  guardarVentaEnFirebase = async function(sale, docId = null) {
    if (!isOnlineFirebase()) throw new Error('Firebase no está disponible.');

    const source = sale || {};
    const normalized = secureNormalizarVenta(source);
    normalized._localId = normalized._localId || docId || randomOperationId('venta');
    normalized._docId = docId || normalized._docId || normalized._localId;

    const hasExplicitVersion = Number.isInteger(Number(source?.version)) && Number(source.version) > 0;
    let expectedVersion = Math.max(0, Number(normalized.version || 0) - 1);

    // Algunos formularios antiguos no devolvían la versión de la venta.
    // Antes de editar, se consulta la versión remota para conservar el
    // control de concurrencia y cumplir las reglas de Firestore.
    if (normalized._docId && !hasExplicitVersion) {
      const snap = await firestoreDb.collection('ventas').doc(firestoreDocId(normalized._docId)).get();
      if (snap.exists) {
        expectedVersion = Number(snap.data()?.version || 0);
        normalized.version = expectedVersion + 1;
      } else {
        expectedVersion = 0;
        normalized.version = 1;
      }
    } else {
      normalized.version = Math.max(1, Number(normalized.version || 1));
    }

    const operation = {
      operacionId: randomOperationId('direct'),
      tipo: 'set',
      venta: normalized,
      ajustesInventario: {},
      creadoEn: new Date().toISOString(),
      secuencia: Date.now(),
      intentos: 0,
      ultimoError: '',
      estado: 'pendiente',
      versionEsperada: expectedVersion,
      deviceId: getDeviceId()
    };

    const result = await executeSaleOperation(operation);
    return result.docId;
  };
  window.guardarVentaEnFirebase = guardarVentaEnFirebase;

  function readCashQueue() {
    let data = [];
    try { data = JSON.parse(localStorage.getItem(CASH_QUEUE_KEY) || '[]'); } catch (_) {}
    return Array.isArray(data) ? data : [];
  }

  function writeCashQueue(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > 1000) throw new Error('La cola de caja está llena. Sincroniza antes de continuar.');
    if (!guardarLocalStorageSeguro(CASH_QUEUE_KEY, list, { critico: true })) {
      throw new Error('No fue posible guardar la cola local de caja. Libera espacio del navegador.');
    }
    updateQueueStatus();
  }

  function migrateLegacyCashQueue() {
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(LEGACY_CASH_QUEUE_KEY) || '[]'); } catch (_) {}
    if (!Array.isArray(legacy) || !legacy.length) return;
    const secure = readCashQueue();
    legacy.forEach((item, index) => {
      const payload = secureNormalizarCaja(item?.payload || {}, item?.diaClave || '');
      secure.push({
        operacionId: randomOperationId('caja_migrada'),
        diaClave: cleanText(item?.diaClave || payload.diaClave, 20),
        payload,
        versionEsperada: Math.max(0, Number(payload.version || 1) - 1),
        creadoEn: item?.actualizadoEn || new Date().toISOString(),
        secuencia: Date.now() + index,
        intentos: Number(item?.intentos || 0),
        ultimoError: cleanText(item?.ultimoError || '', 500),
        estado: 'pendiente'
      });
    });
    writeCashQueue(secure);
    localStorage.removeItem(LEGACY_CASH_QUEUE_KEY);
  }

  async function executeCashOperation(item) {
    if (!isOnlineFirebase()) throw new Error('Sin conexión autenticada con Firebase.');
    const day = cleanText(item.diaClave, 20);
    const ref = firestoreDb.collection('controlCaja').doc(firestoreDocId(day));
    const payload = secureNormalizarCaja(item.payload || {}, day);
    let result = payload;
    await firestoreDb.runTransaction(async transaction => {
      const snap = await transaction.get(ref);
      const remote = snap.exists ? secureNormalizarCaja(snap.data(), day) : null;
      if (remote?._ultimaOperacionId === item.operacionId) {
        result = remote;
        return;
      }
      const remoteVersion = Number(remote?.version || 0);
      if (remoteVersion !== Number(item.versionEsperada || 0)) {
        const error = new Error(`Conflicto de caja del ${day}: versión del servidor ${remoteVersion}, esperada ${item.versionEsperada || 0}.`);
        error.code = 'version-conflict';
        throw error;
      }
      const nextVersion = remote ? remoteVersion + 1 : 1;
      const timestamp = fieldValueServerTimestamp();
      const cleanPayload = clonePlain({
        ...payload,
        diaClave: day,
        version: nextVersion,
        _ultimaOperacionId: item.operacionId,
        schemaVersion: 4,
        actualizadoEnCliente: new Date().toISOString()
      });
      delete cleanPayload._syncEstado;
      delete cleanPayload.creadoServidor;
      delete cleanPayload.actualizadoServidor;
      cleanPayload.actualizadoServidor = timestamp;
      if (!remote) cleanPayload.creadoServidor = timestamp;
      transaction.set(ref, cleanPayload, { merge: true });
      const user = userContext();
      const auditRef = firestoreDb.collection('auditoria').doc(firestoreDocId(`aud_${item.operacionId}`));
      transaction.set(auditRef, {
        id: auditRef.id,
        accion: payload.cierreHora ? 'guardar_cierre_caja' : 'guardar_apertura_caja',
        entidad: 'controlCaja',
        entidadId: day,
        usuario: user.usuario,
        rol: user.rol,
        email: user.email,
        uid: user.uid,
        fechaISOCliente: new Date().toISOString(),
        fechaServidor: timestamp,
        detalle: { versionAnterior: remoteVersion, versionNueva: nextVersion }
      }, { merge: false });
      result = secureNormalizarCaja({ ...cleanPayload, version: nextVersion, _syncEstado: 'sincronizado' }, day);
    });
    return result;
  }

  async function syncCashQueue() {
    if (syncingCashSecurely || !isOnlineFirebase()) return { exitosas: 0, fallidas: 0 };
    let queue = readCashQueue().sort((a, b) => String(a.creadoEn).localeCompare(String(b.creadoEn)) || Number(a.secuencia || 0) - Number(b.secuencia || 0));
    if (!queue.length) return { exitosas: 0, fallidas: 0 };
    syncingCashSecurely = true;
    let success = 0;
    let failed = 0;
    const blockedDays = new Set();
    try {
      for (const item of [...queue]) {
        if (blockedDays.has(item.diaClave)) continue;
        try {
          const result = await executeCashOperation(item);
          queue = queue.filter(entry => entry.operacionId !== item.operacionId);
          const stillPending = queue.some(entry => entry.diaClave === item.diaClave);
          if (typeof guardarControlCajaEnCache === 'function') guardarControlCajaEnCache({ ...result, _syncEstado: stillPending ? 'pendiente' : 'sincronizado' });
          writeCashQueue(queue);
          success += 1;
        } catch (error) {
          const message = cleanText(error?.message || error, 500);
          queue = queue.map(entry => entry.operacionId === item.operacionId
            ? { ...entry, intentos: Number(entry.intentos || 0) + 1, ultimoError: message, estado: 'error' }
            : entry);
          blockedDays.add(item.diaClave);
          writeCashQueue(queue);
          failed += 1;
          console.error('Operación de caja detenida:', error);
        }
      }
    } finally {
      syncingCashSecurely = false;
      updateQueueStatus();
    }
    return { exitosas: success, fallidas: failed };
  }
  window.sincronizarCajaSegura = syncCashQueue;

  guardarControlCajaDia = async function(day, payload = {}) {
    const current = typeof obtenerControlCajaLocal === 'function'
      ? secureNormalizarCaja(obtenerControlCajaLocal(day) || {}, day)
      : secureNormalizarCaja({}, day);
    const expectedVersion = Number(current.version || 0);
    const target = secureNormalizarCaja({
      ...payload,
      diaClave: day,
      version: expectedVersion + 1,
      _syncEstado: 'pendiente'
    }, day);
    if (typeof guardarControlCajaEnCache === 'function') guardarControlCajaEnCache(target);
    const queue = readCashQueue();
    queue.push({
      operacionId: randomOperationId('caja'),
      diaClave: cleanText(day, 20),
      payload: target,
      versionEsperada: expectedVersion,
      creadoEn: new Date().toISOString(),
      secuencia: Math.max(Date.now() * 1000, Number(queue.at(-1)?.secuencia || 0) + 1),
      intentos: 0,
      ultimoError: '',
      estado: 'pendiente'
    });
    writeCashQueue(queue);
    if (isOnlineFirebase()) await syncCashQueue();
    return typeof obtenerControlCajaLocal === 'function' ? obtenerControlCajaLocal(day) : target;
  };
  window.guardarControlCajaDia = guardarControlCajaDia;

  registrarAuditoria = async function(action, entity, entityId, detail = {}, fixedId = '') {
    if (!isOnlineFirebase() || !baseRegistrarAuditoria) {
      return baseRegistrarAuditoria ? baseRegistrarAuditoria(action, entity, entityId, detail, fixedId) : false;
    }
    const user = userContext();
    const id = firestoreDocId(fixedId || randomOperationId('aud'));
    try {
      await firestoreDb.collection('auditoria').doc(id).set({
        id,
        accion: cleanText(action, 80),
        entidad: cleanText(entity, 80),
        entidadId: cleanText(entityId, 180),
        usuario: user.usuario,
        rol: user.rol,
        email: user.email,
        uid: user.uid,
        fechaISOCliente: new Date().toISOString(),
        fechaServidor: fieldValueServerTimestamp(),
        diaClaveCliente: colombiaDayKey(new Date()),
        detalle: clonePlain(detail || {})
      }, { merge: false });
      return true;
    } catch (error) {
      console.warn('La auditoría segura quedó pendiente en la cola heredada:', error);
      return baseRegistrarAuditoria(action, entity, entityId, detail, fixedId);
    }
  };
  window.registrarAuditoria = registrarAuditoria;

  // ---------------------------------------------------------------------------
  // Consultas históricas.
  // La estrategia eficiente y la paginación remota se implementan en
  // 06-consultas-eficientes.js. Aquí no se realizan lecturas masivas.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Migraciones compatibles.
  // ---------------------------------------------------------------------------
  function migrateLocalCatalogAndSales() {
    try {
      catalogoProductos = normalizeCatalog(catalogoProductos || {});
      if (typeof guardarCatalogoProductosLocal === 'function') guardarCatalogoProductosLocal();
      if (typeof renderizarCatalogoProductosUI === 'function') renderizarCatalogoProductosUI();

      if (typeof obtenerVentasStorage === 'function' && typeof guardarVentasEnCache === 'function') {
        guardarVentasEnCache(obtenerVentasStorage().map(secureNormalizarVenta));
      }

      const inventory = JSON.parse(localStorage.getItem(INVENTARIO_STORAGE_KEY) || '[]');
      let changed = false;
      inventory.forEach(item => {
        if (item.inventoryId) return;
        const product = (catalogoProductos?.bebidas || []).find(candidate => normalizeKey(candidate.nombre) === normalizeKey(item.nombreNormalizado || item.nombre));
        if (!product) return;
        item.inventoryId = product.inventoryId;
        item.productId = product.productId;
        item.nombreNormalizado = item.nombreNormalizado || normalizeKey(item.nombre);
        changed = true;
      });
      if (changed) guardarLocalStorageSeguro(INVENTARIO_STORAGE_KEY, inventory, { critico: false });
      inventarioBebidasEstado = obtenerMapaInventarioDesdeArray(inventory);
    } catch (error) {
      console.error('No se pudo completar la migración local:', error);
    }
  }

  async function migrateRemoteInventoryLinks() {
    if (inventoryMigrationAttempted || !isOnlineFirebase()) return;
    const role = cleanText(typeof rolActual !== 'undefined' ? rolActual : '', 50);
    if (!['admin', 'administrador'].includes(role)) return;
    inventoryMigrationAttempted = true;
    for (const product of catalogoProductos?.bebidas || []) {
      try {
        const byId = await firestoreDb.collection(INVENTARIO_COLLECTION).where('inventoryId', '==', product.inventoryId).limit(1).get();
        if (!byId.empty) continue;
        const legacy = await firestoreDb.collection(INVENTARIO_COLLECTION).where('nombreNormalizado', '==', normalizeKey(product.nombre)).limit(1).get();
        if (legacy.empty) continue;
        await legacy.docs[0].ref.set({
          inventoryId: product.inventoryId,
          productId: product.productId,
          nombreNormalizado: normalizeKey(product.nombre),
          actualizadoServidor: fieldValueServerTimestamp()
        }, { merge: true });
      } catch (error) {
        console.warn(`No se pudo vincular el inventario de ${product.nombre}:`, error);
      }
    }
  }

  function updateQueueStatus() {
    const sales = readSalesQueue().length;
    const cash = readCashQueue().length;
    let audit = 0;
    try { audit = JSON.parse(localStorage.getItem('senorArepaAuditoriaPendienteV3') || '[]').length || 0; } catch (_) {}
    const total = sales + cash + audit;
    const element = document.getElementById('syncQueueStatus');
    if (element) {
      element.textContent = total ? `${total} operación(es) pendiente(s) de sincronizar` : 'Sin operaciones pendientes';
      element.className = total ? 'mt-1 text-xs font-semibold text-amber-700' : 'mt-1 text-xs font-semibold text-green-700';
    }
  }

  function initializeHardening() {
    migrateLegacyCashQueue();
    migrateLocalCatalogAndSales();
    updateQueueStatus();
    document.documentElement.dataset.dataHardeningVersion = HARDENING_VERSION;
    window.migrarVinculosInventarioBajoDemanda = migrateRemoteInventoryLinks;
    setTimeout(() => {
      if (isOnlineFirebase()) diagnosticarPermisosFirestoreC94(false);
    }, 1200);
    setInterval(() => {
      updateQueueStatus();
      // La migración remota ya no se ejecuta periódicamente; solo bajo demanda.
    }, 15000);
  }

  window.addEventListener('online', async () => {
    await Promise.allSettled([
      sincronizarVentasPendientesEnSegundoPlano(),
      syncCashQueue()
    ]);
    // La vinculación de inventario se resuelve al vender o desde el editor.
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeHardening, { once: true });
  else initializeHardening();

  window.SENOR_AREPA_CORRECCIONES_1_A_8 = Object.freeze({
    version: HARDENING_VERSION,
    productIds: true,
    orderedOfflineQueue: true,
    optimisticConcurrency: true,
    pagedHistory: true,
    officialOfflineCounters: true,
    serverTimestamps: true,
    modularFiles: true
  });
})();

// Alias temporal para consolas o accesos directos creados en C9.3.
if (typeof window.diagnosticarPermisosFirestoreC94 === 'function') {
  window.diagnosticarPermisosFirestoreC93 = window.diagnosticarPermisosFirestoreC94;
}
console.info('[Señor Arepa] Código activo: C9.8 · proyecto esperado: prsenorarepa');
