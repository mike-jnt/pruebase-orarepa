(() => {
  'use strict';

  const HARDENING_VERSION = '2026.08.08-C9.32';
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
  let syncingPostprocesosVenta = false;
  let syncingCashSecurely = false;
  let inventoryMigrationAttempted = false;

  // C9.32: la seguridad operativa usa los usuarios realmente configurados
  // por el sistema, evitando que cajeros válidos queden con ventas eternamente
  // pendientes por una lista de correos incompleta.
  const SYSTEM_USER_RECORDS = Object.values(typeof usuariosPorEmail === 'object' && usuariosPorEmail ? usuariosPorEmail : {});
  const SYSTEM_EMAILS = SYSTEM_USER_RECORDS.map(item => String(item?.email || '').trim().toLowerCase()).filter(Boolean);
  const KNOWN_EMAILS = new Set([...SYSTEM_EMAILS, 'admin@local.io', 'administrador@local.io', 'cajero@local.io', 'alfredo@local.io', 'cajero1@local.io']);
  const MANAGEMENT_EMAILS = new Set(SYSTEM_USER_RECORDS
    .filter(item => ['admin', 'administrador'].includes(String(item?.rol || '').toLowerCase()))
    .map(item => String(item?.email || '').trim().toLowerCase()));
  MANAGEMENT_EMAILS.add('admin@local.io');
  MANAGEMENT_EMAILS.add('administrador@local.io');
  const ADMIN_EMAILS = new Set(SYSTEM_USER_RECORDS
    .filter(item => String(item?.rol || '').toLowerCase() === 'admin')
    .map(item => String(item?.email || '').trim().toLowerCase()));
  ADMIN_EMAILS.add('admin@local.io');

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
    // C9.32: no usamos firestoreDisponible como bloqueo absoluto. Ese indicador
    // puede quedar temporalmente en false por un listener/diagnóstico aun cuando
    // una escritura directa ya podría funcionar. La operación real contra
    // Firestore es la autoridad final y, si falla, permanece en la cola.
    return Boolean(
      navigator.onLine &&
      typeof firestoreDb !== 'undefined' && firestoreDb &&
      typeof firebaseAuth !== 'undefined' && firebaseAuth?.currentUser
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
    console.info('[Señor Arepa] Diagnóstico Firestore C9.32', resultado);
    if (mostrarAviso) {
      notify(
        correcto
          ? `Permisos Firestore C9.32 verificados para ${email}.`
          : `Las reglas C9.32 no están activas para ${email || 'la cuenta actual'}. Publica firestore.rules antes de continuar.`,
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
    const value = date instanceof Date ? date : new Date(date || Date.now());
    const safe = Number.isNaN(value.getTime()) ? new Date() : value;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(safe);
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
      normalized.diaClaveOficial = cleanText(rawSale?.diaClave || rawSale?.diaClaveOficial || normalized.diaClave || colombiaDayKey(serverDate), 20);
      normalized.horaFuente = 'servidor';
    } else {
      normalized.fechaOficialISO = cleanText(rawSale?.fechaOficialISO || normalized.fechaOficialISO || '', 50);
      normalized.diaClaveOficial = cleanText(rawSale?.diaClave || rawSale?.diaClaveOficial || normalized.diaClaveOficial || '', 20);
      normalized.horaFuente = normalized.horaFuente || 'dispositivo';
    }
    normalized.diaClave = cleanText(rawSale?.diaClave || normalized.diaClave || normalized.diaClaveOficial || '', 20);
    normalized.fechaNegocioISO = cleanText(rawSale?.fechaNegocioISO || normalized.fechaNegocioISO || '', 50);
    normalized.mesClave = cleanText(rawSale?.mesClave || normalized.mesClave || (normalized.diaClave ? normalized.diaClave.slice(0, 7) : ''), 10);
    normalized.semanaClave = cleanText(rawSale?.semanaClave || normalized.semanaClave || '', 20);
    normalized.zonaHoraria = cleanText(rawSale?.zonaHoraria || normalized.zonaHoraria || 'America/Bogota', 40);
    normalized.ordenDia = positiveConsecutive(rawSale?.ordenDia || normalized.ordenDia || normalized.numeroVentaDia || 0) || null;
    normalized.claveVentaDia = cleanText(rawSale?.claveVentaDia || normalized.claveVentaDia || '', 40);
    normalized.postProcesoEstado = cleanText(rawSale?.postProcesoEstado || normalized.postProcesoEstado || '', 30);
    normalized.postProcesoOperacionId = cleanText(rawSale?.postProcesoOperacionId || normalized.postProcesoOperacionId || '', 150);
    normalized.postProcesoError = cleanText(rawSale?.postProcesoError || normalized.postProcesoError || '', 450);
    normalized.postProcesoIntentos = Math.max(0, Number(rawSale?.postProcesoIntentos ?? normalized.postProcesoIntentos ?? 0));
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

  function positiveConsecutive(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function localDailyConsecutiveSeed(day, excludedIdentity = '') {
    try {
      if (typeof obtenerVentasStorage !== 'function') return { total: 0, maxCommand: 0, maxReceipt: 0, maxDelivery: 0 };
      const sales = obtenerVentasStorage().filter(candidate => {
        const normalized = secureNormalizarVenta(candidate || {});
        const candidateDay = normalized.diaClave || colombiaDayKey(timestampToDate(normalized.fechaISO) || new Date());
        if (candidateDay !== day) return false;
        if (excludedIdentity && saleIdentity(normalized) === excludedIdentity) return false;
        const syncState = String(normalized._syncEstado || '').toLowerCase();
        // No contamos otras ventas todavía pendientes: el contador de Firestore
        // las asignará una a una dentro de sus propias transacciones.
        if (['pendiente', 'error'].includes(syncState) && normalized.consecutivoTemporal) return false;
        return true;
      });
      const maxCommand = sales.reduce((max, candidate) => Math.max(max, positiveConsecutive(candidate.numeroVentaDia), positiveConsecutive(candidate.comanda)), 0);
      const maxReceipt = sales.reduce((max, candidate) => Math.max(max, positiveConsecutive(candidate.numeroVentaDia), positiveConsecutive(candidate.recibo)), 0);
      const maxDelivery = sales.reduce((max, candidate) => Math.max(max, positiveConsecutive(candidate.numeroDomicilio)), 0);
      return { total: sales.length, maxCommand, maxReceipt, maxDelivery };
    } catch (_) {
      return { total: 0, maxCommand: 0, maxReceipt: 0, maxDelivery: 0 };
    }
  }

  function summarySaleCount(data = {}) {
    const activos = Math.max(0, Number(data?.pedidosActivos || 0));
    const cancelados = Math.max(0, Number(data?.pedidosCancelados || 0));
    const legado = Math.max(0, Number(data?.cantidadVentas || data?.ventas || 0));
    return Math.max(activos + cancelados, legado);
  }

  function summaryDeliveryCount(data = {}) {
    const activos = Math.max(0, Number(data?.domiciliosActivos || 0));
    const cancelados = Math.max(0, Number(data?.domiciliosCancelados || 0));
    const legado = Math.max(0, Number(data?.cantidadDomicilios || data?.domicilios || 0));
    return Math.max(activos + cancelados, legado);
  }

  // C9.32: el contador diario deja de "adivinar" ventas a partir de números
  // heredados. Se migra una sola vez usando DOCUMENTOS REALES de Firestore y,
  // desde ese punto, solo avanza dentro de la misma transacción que crea la venta.
  const atomicCounterPreparation = new Map();

  function colombiaDayRange(day) {
    const safe = cleanText(day, 20);
    const start = new Date(`${safe}T05:00:00.000Z`);
    if (Number.isNaN(start.getTime())) throw new Error(`diaClave inválido: ${safe}`);
    return {
      start: start.toISOString(),
      end: new Date(start.getTime() + 86400000 - 1).toISOString()
    };
  }

  async function fetchConfirmedSalesForCounter(day, includeLegacyScan = false) {
    const range = colombiaDayRange(day);
    const [byDay, byDate] = await Promise.all([
      firestoreDb.collection('ventas').where('diaClave', '==', day).get(),
      firestoreDb.collection('ventas')
        .where('fechaISO', '>=', range.start)
        .where('fechaISO', '<=', range.end)
        .orderBy('fechaISO', 'asc')
        .get()
    ]);
    const map = new Map();
    const addDocument = doc => {
      const sale = secureNormalizarVenta({ _docId: doc.id, ...doc.data() });
      const rawDate = timestampToDate(sale.fechaNegocioISO || sale.fechaISO || sale.fechaOficialISO || sale.fecha);
      const saleDay = cleanText(sale.diaClave || sale.diaClaveOficial || (rawDate ? colombiaDayKey(rawDate) : ''), 20);
      if (saleDay === day) map.set(doc.id, sale);
    };
    [...byDay.docs, ...byDate.docs].forEach(addDocument);

    // Solo durante la migración de un contador heredado hacemos una revisión
    // completa de compatibilidad. Esto recupera documentos muy antiguos que
    // no tenían diaClave ni fechaISO normalizada. Se ejecuta una sola vez al
    // convertir el día al esquema atomico_v4.
    if (includeLegacyScan) {
      const legacySnapshot = await firestoreDb.collection('ventas').get();
      legacySnapshot.docs.forEach(addDocument);
    }
    return Array.from(map.values());
  }

  async function prepareAtomicDailyCounter(day, options = {}) {
    if (!isOnlineFirebase() || !day) return null;
    const force = Boolean(options.force);
    const cached = atomicCounterPreparation.get(day);
    if (!force && cached && (Date.now() - cached.at) < 30000) return cached.result;

    const ref = firestoreDb.collection('contadores').doc(firestoreDocId(day));
    const preCounterSnap = await ref.get();
    const preCounter = preCounterSnap.exists ? (preCounterSnap.data() || {}) : {};
    const preAtomic = String(preCounter.esquemaConsecutivo || '') === 'atomico_v4' && Number(preCounter.schemaVersionContador || 0) >= 4;

    // C9.32: una vez que el día ya tiene contador atómico NO se vuelven a leer
    // todas las ventas ni se reescribe el contador antes de cada pedido. Eso
    // reducía fiabilidad, generaba contención y podía dejar ventas en Pendiente.
    if (preAtomic && !force) {
      const result = {
        day,
        ultimoConsecutivo: positiveConsecutive(preCounter.ultimoConsecutivo || preCounter.numeroVentaDia || preCounter.comanda),
        ventasEmitidas: Math.max(0, Number(preCounter.ventasEmitidas || 0)),
        ventasExistentes: Math.max(0, Number(preCounter.ventasExistentes || 0)),
        documentosConfirmadosObservados: Math.max(0, Number(preCounter.documentosConfirmadosObservados || preCounter.ventasExistentes || 0)),
        migrated: false,
        atomic: true
      };
      atomicCounterPreparation.set(day, { at: Date.now(), result });
      return result;
    }

    // Solo la primera migración de un día heredado hace un rastreo de los
    // documentos reales. El viejo número del contador NO se toma como cantidad.
    const suppliedSales = Array.isArray(options.sales)
      ? options.sales.map(item => secureNormalizarVenta(item || {}))
      : null;
    const sales = suppliedSales || await fetchConfirmedSalesForCounter(day, true);
    const confirmedDocs = sales.length;
    let result = null;

    await firestoreDb.runTransaction(async transaction => {
      const snap = await transaction.get(ref);
      const current = snap.exists ? (snap.data() || {}) : {};
      const alreadyAtomic = String(current.esquemaConsecutivo || '') === 'atomico_v4' && Number(current.schemaVersionContador || 0) >= 4;

      if (alreadyAtomic) {
        result = {
          day,
          ultimoConsecutivo: positiveConsecutive(current.ultimoConsecutivo || current.numeroVentaDia || current.comanda),
          ventasEmitidas: Math.max(0, Number(current.ventasEmitidas || 0)),
          ventasExistentes: Math.max(0, Number(current.ventasExistentes || 0)),
          documentosConfirmadosObservados: Math.max(0, Number(current.documentosConfirmadosObservados || current.ventasExistentes || 0)),
          migrated: false,
          atomic: true
        };
        return;
      }

      // Para migrar, reconstruimos la base a partir de documentos reales. El
      // consecutivo de arranque es el mayor entre cantidad y números válidos
      // encontrados, evitando tanto un contador inflado como reutilizar números
      // que sí estén confirmados en documentos existentes.
      const maxConfirmedSequence = sales.reduce((max, candidate) => Math.max(
        max,
        positiveConsecutive(candidate?.numeroVentaDia),
        positiveConsecutive(candidate?.ordenDia),
        positiveConsecutive(candidate?.comanda),
        positiveConsecutive(candidate?.recibo)
      ), 0);
      const baseSequence = Math.max(confirmedDocs, maxConfirmedSequence);
      const deliveryBase = sales.reduce((max, candidate) => Math.max(max, positiveConsecutive(candidate?.numeroDomicilio)), 0);

      result = {
        day,
        ultimoConsecutivo: baseSequence,
        ventasEmitidas: confirmedDocs,
        ventasExistentes: confirmedDocs,
        documentosConfirmadosObservados: confirmedDocs,
        migrated: true,
        atomic: true
      };

      transaction.set(ref, {
        diaClave: day,
        schemaVersionContador: 4,
        esquemaConsecutivo: 'atomico_v4',
        ultimoConsecutivo: baseSequence,
        numeroVentaDia: baseSequence,
        ordenDia: baseSequence,
        comanda: baseSequence,
        recibo: baseSequence,
        domicilio: deliveryBase,
        ventasEmitidas: confirmedDocs,
        ventasExistentes: confirmedDocs,
        documentosConfirmadosObservados: confirmedDocs,
        migradoDesdeContadorAnterior: true,
        contadorAnteriorDetectado: positiveConsecutive(current.ultimoConsecutivo || current.numeroVentaDia || current.comanda),
        actualizadoEnCliente: new Date().toISOString(),
        actualizadoServidor: fieldValueServerTimestamp()
      }, { merge: true });
    });

    atomicCounterPreparation.set(day, { at: Date.now(), result });
    if (result?.migrated) {
      console.info(`[C9.32] Contador ${day} migrado una sola vez desde ${result.documentosConfirmadosObservados} documento(s) reales.`);
    }
    return result;
  }

  async function reconcileDailyCounter(day, sales = []) {
    return prepareAtomicDailyCounter(day, { sales, force: true });
  }
  window.reconciliarContadorVentasDia = reconcileDailyCounter;
  window.prepararContadorAtomicoVentasDia = prepareAtomicDailyCounter;

  function buildInventoryAdjustmentsForConfirmedSale(sale, fallback = {}) {
    if (fallback && typeof fallback === 'object' && Object.keys(fallback).length) return fallback;
    try {
      if (typeof calcularAjustesInventarioBebidas === 'function') {
        return calcularAjustesInventarioBebidas([], sale?.pedido || []);
      }
    } catch (error) {
      console.warn('[C9.32] No se pudieron reconstruir ajustes de inventario:', error);
    }
    return {};
  }

  async function postProcessConfirmedSale(saleInput, operationId, inventoryAdjustments = {}) {
    if (!isOnlineFirebase()) throw new Error('Sin conexión para completar el postproceso de la venta.');
    const sale = secureNormalizarVenta(saleInput || {});
    const docId = firestoreDocId(sale._docId || sale._localId || saleIdentity(sale));
    const opId = firestoreDocId(operationId || sale.postProcesoOperacionId || `post_${docId}`);
    const saleRef = firestoreDb.collection('ventas').doc(docId);
    const processRef = firestoreDb.collection('procesosVenta').doc(opId);
    const user = userContext();
    const adjustments = buildInventoryAdjustmentsForConfirmedSale(sale, inventoryAdjustments);
    const inventoryEntries = [];
    for (const [key, adjustment] of Object.entries(adjustments || {})) {
      inventoryEntries.push({ key, adjustment, ref: await resolveInventoryReference(key, adjustment) });
    }

    await firestoreDb.runTransaction(async transaction => {
      const processSnap = await transaction.get(processRef);
      const saleSnap = await transaction.get(saleRef);
      if (!saleSnap.exists) throw new Error(`La venta ${docId} no existe para completar su postproceso.`);
      const remoteSale = secureNormalizarVenta({ _docId: saleSnap.id, ...saleSnap.data() });

      // Si el marcador existe, inventario/resúmenes/auditoría ya se aplicaron
      // juntos en una transacción anterior. Solo aseguramos el estado final.
      if (processSnap.exists) {
        if (String(remoteSale.postProcesoEstado || '') !== 'completo') {
          transaction.update(saleRef, {
            postProcesoEstado: 'completo',
            postProcesoError: '',
            postProcesoActualizadoServidor: fieldValueServerTimestamp()
          });
        }
        return;
      }

      const movementReads = [];
      for (const entry of inventoryEntries) {
        const movementRef = firestoreDb.collection('movimientosInventario').doc(firestoreDocId(`${opId}_${entry.key}`));
        const movementSnap = await transaction.get(movementRef);
        const inventorySnap = await transaction.get(entry.ref);
        movementReads.push({ ...entry, movementRef, movementSnap, inventorySnap });
      }

      const timestamp = fieldValueServerTimestamp();
      // Los resúmenes se aplican una sola vez gracias al documento procesosVenta.
      applySummaryDeltas(transaction, null, remoteSale, timestamp, user);

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
          operacionId: opId,
          ventaId: docId,
          tipoOperacion: 'set',
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

      const auditRef = firestoreDb.collection('auditoria').doc(firestoreDocId(`aud_${opId}`));
      transaction.set(auditRef, {
        id: auditRef.id,
        accion: 'crear_venta',
        entidad: 'ventas',
        entidadId: docId,
        usuario: user.usuario,
        rol: user.rol,
        email: user.email,
        uid: user.uid,
        fechaISOCliente: new Date().toISOString(),
        fechaServidor: timestamp,
        diaClaveCliente: remoteSale.diaClave || colombiaDayKey(new Date()),
        detalle: {
          operacionId: opId,
          versionNueva: Number(remoteSale.version || 1),
          comanda: remoteSale.comanda || null,
          cliente: cleanText(remoteSale.cliente, 120),
          dispositivoId: remoteSale.dispositivoId || getDeviceId()
        }
      }, { merge: false });

      transaction.set(processRef, {
        operacionId: opId,
        ventaId: docId,
        diaClave: remoteSale.diaClave || '',
        estado: 'completo',
        uid: user.uid,
        email: user.email,
        creadoServidor: timestamp
      }, { merge: false });

      transaction.update(saleRef, {
        postProcesoEstado: 'completo',
        postProcesoError: '',
        postProcesoActualizadoServidor: timestamp
      });
    });
    return true;
  }

  async function syncPendingSalePostprocesses() {
    if (syncingPostprocesosVenta || !isOnlineFirebase()) return { completas: 0, fallidas: 0 };
    syncingPostprocesosVenta = true;
    let completas = 0;
    let fallidas = 0;
    try {
      const snapshot = await firestoreDb.collection('ventas')
        .where('postProcesoEstado', '==', 'pendiente')
        .limit(25)
        .get();
      for (const doc of snapshot.docs) {
        const sale = secureNormalizarVenta({ _docId: doc.id, ...doc.data() });
        try {
          await postProcessConfirmedSale(sale, sale.postProcesoOperacionId || `post_${doc.id}`);
          completas += 1;
        } catch (error) {
          fallidas += 1;
          console.warn(`[C9.32] Venta #${sale.numeroVentaDia || '?'} confirmada, postproceso pendiente:`, error);
          try {
            await doc.ref.update({
              postProcesoEstado: 'pendiente',
              postProcesoError: cleanText(error?.message || error, 450),
              postProcesoIntentos: Math.max(0, Number(sale.postProcesoIntentos || 0)) + 1,
              postProcesoActualizadoServidor: fieldValueServerTimestamp()
            });
          } catch (_) {}
        }
      }
    } finally {
      syncingPostprocesosVenta = false;
    }
    return { completas, fallidas };
  }
  window.sincronizarPostprocesosVentasPendientes = syncPendingSalePostprocesses;

  async function executeNewSaleAtomicCore(item, sale, docId, saleRef, user) {
    const saleDayKey = cleanText(sale.diaClave || sale.diaClaveOficial || colombiaDayKey(timestampToDate(sale.fechaISO) || new Date()), 20);
    const businessDate = timestampToDate(sale.fechaNegocioISO || sale.fechaISO);
    if (businessDate && colombiaDayKey(businessDate) !== saleDayKey) {
      throw new Error(`La fecha de negocio no coincide con diaClave (${saleDayKey}).`);
    }

    const prepared = await prepareAtomicDailyCounter(saleDayKey);
    if (!prepared) throw new Error('No fue posible preparar el contador atómico del día.');

    let resultSale = { ...sale, _docId: docId };
    let alreadyApplied = false;
    await firestoreDb.runTransaction(async transaction => {
      const saleSnap = await transaction.get(saleRef);
      if (saleSnap.exists) {
        const remote = secureNormalizarVenta({ _docId: saleSnap.id, ...saleSnap.data() });
        if (remote?._ultimaOperacionId === item.operacionId || (sale._localId && remote?._localId === sale._localId)) {
          resultSale = { ...remote, _docId: docId, _syncEstado: 'sincronizado' };
          alreadyApplied = true;
          return;
        }
        throw new Error(`Ya existe un documento diferente para la venta ${docId}.`);
      }

      const counterRef = firestoreDb.collection('contadores').doc(firestoreDocId(saleDayKey));
      const counterSnap = await transaction.get(counterRef);
      const counters = counterSnap.exists ? (counterSnap.data() || {}) : {};
      const atomicCounter = String(counters?.esquemaConsecutivo || '') === 'atomico_v4' && Number(counters?.schemaVersionContador || 0) >= 4;
      if (!atomicCounter) {
        atomicCounterPreparation.delete(saleDayKey);
        const error = new Error('El contador del día todavía no está preparado. Se reintentará sin emitir número.');
        error.code = 'counter-reprepare';
        throw error;
      }

      const commandBase = positiveConsecutive(counters?.ultimoConsecutivo || counters?.numeroVentaDia || counters?.comanda);
      const command = commandBase + 1;
      const deliveryBase = positiveConsecutive(counters?.domicilio);
      const delivery = sale.tipoPedido === 'Domicilio' ? deliveryBase + 1 : deliveryBase;
      const claveVentaDia = `${saleDayKey}-${String(command).padStart(6, '0')}`;
      const ventasEmitidas = Math.max(0, Number(counters?.ventasEmitidas || 0)) + 1;
      const ventasExistentes = Math.max(0, Number(counters?.ventasExistentes || 0)) + 1;
      const timestamp = fieldValueServerTimestamp();

      const payload = clonePlain({
        ...sale,
        comandaTemporal: sale.comanda || null,
        reciboTemporal: sale.recibo || null,
        numeroDomicilioTemporal: sale.numeroDomicilio || null,
        diaClave: saleDayKey,
        mesClave: sale.mesClave || saleDayKey.slice(0, 7),
        semanaClave: sale.semanaClave || '',
        zonaHoraria: 'America/Bogota',
        numeroVentaDia: command,
        ordenDia: command,
        claveVentaDia,
        comanda: command,
        recibo: command,
        numeroDomicilio: sale.tipoPedido === 'Domicilio' ? delivery : null,
        consecutivoTemporal: false,
        consecutivoOrigen: 'firestore_transaccion_core_v4',
        consecutivoOficialEn: timestamp,
        _localId: sale._localId || docId,
        version: 1,
        _ultimaOperacionId: item.operacionId,
        schemaVersion: 7,
        dispositivoId: item.deviceId,
        fechaISO: sale.fechaISO || new Date().toISOString(),
        fechaNegocioISO: sale.fechaNegocioISO || sale.fechaISO || new Date().toISOString(),
        fechaNegocioDia: saleDayKey,
        fechaClienteISO: sale.fechaISO || new Date().toISOString(),
        clienteBusqueda: cleanText(sale.cliente, 160).toLowerCase(),
        postProcesoEstado: 'pendiente',
        postProcesoOperacionId: item.operacionId,
        postProcesoIntentos: 0,
        postProcesoError: ''
      });
      delete payload._docId;
      delete payload._syncEstado;
      delete payload.creadoServidor;
      delete payload.actualizadoServidor;
      delete payload.fechaServidor;
      payload.creadoServidor = timestamp;
      payload.actualizadoServidor = timestamp;
      payload.fechaServidor = timestamp;

      // C9.32: esta transacción crítica contiene SOLO venta + contador. Ninguna
      // falla de inventario, resumen o auditoría puede consumir un número sin
      // que exista el documento de venta correspondiente.
      transaction.set(saleRef, payload, { merge: false });
      transaction.set(counterRef, {
        diaClave: saleDayKey,
        schemaVersionContador: 4,
        esquemaConsecutivo: 'atomico_v4',
        ultimoConsecutivo: command,
        numeroVentaDia: command,
        ordenDia: command,
        comanda: command,
        recibo: command,
        domicilio: delivery,
        ventasEmitidas,
        ventasExistentes,
        ultimaVentaId: docId,
        ultimaClaveVentaDia: claveVentaDia,
        actualizadoEnCliente: new Date().toISOString(),
        actualizadoServidor: timestamp,
        actualizadoPor: user.usuario,
        actualizadoUid: user.uid
      }, { merge: true });

      resultSale = secureNormalizarVenta({ ...payload, _docId: docId, _syncEstado: 'sincronizado' });
    });

    // El pedido ya está confirmado y numerado. El postproceso se intenta de
    // inmediato, pero si falla NO devolvemos la venta a estado Pendiente.
    try {
      await postProcessConfirmedSale(resultSale, item.operacionId, item.ajustesInventario || {});
      resultSale.postProcesoEstado = 'completo';
      resultSale.postProcesoError = '';
    } catch (error) {
      resultSale.postProcesoEstado = 'pendiente';
      resultSale.postProcesoError = cleanText(error?.message || error, 450);
      console.warn(`[C9.32] Venta #${resultSale.numeroVentaDia || '?'} confirmada; postproceso se reintentará:`, error);
    }

    if (typeof registrarHeartbeatFirebase === 'function') registrarHeartbeatFirebase();
    return { docId, venta: resultSale, alreadyApplied, coreConfirmed: true };
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

    const isCreateOperation = item.tipo !== 'delete' && Number(item.versionEsperada || 0) === 0;
    if (isCreateOperation) {
      return executeNewSaleAtomicCore(item, sale, docId, saleRef, user);
    }

    const inventoryEntries = [];
    for (const [key, adjustment] of Object.entries(item.ajustesInventario || {})) {
      inventoryEntries.push({ key, adjustment, ref: await resolveInventoryReference(key, adjustment) });
    }

    let resultSale = { ...sale, _docId: docId };
    let alreadyApplied = false;
    // C9.32: el día de negocio se fija al crear la venta y nunca se vuelve a
    // calcular al sincronizar. Así una cola que se suba después de medianoche
    // sigue perteneciendo al día en que realmente se tomó el pedido.
    const saleDayKey = cleanText(sale.diaClave || sale.diaClaveOficial || colombiaDayKey(timestampToDate(sale.fechaISO) || new Date()), 20);
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
      const needsOfficialConsecutive = item.tipo !== 'delete' && !remote;
      const updateExistingCountOnDelete = item.tipo === 'delete' && remote && Number(remote?.schemaVersion || 0) >= 6;
      if (needsOfficialConsecutive || updateExistingCountOnDelete) {
        counterRef = firestoreDb.collection('contadores').doc(firestoreDocId(remote?.diaClave || saleDayKey));
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
        const atomicCounter = String(counters?.esquemaConsecutivo || '') === 'atomico_v4' && Number(counters?.schemaVersionContador || 0) >= 4;
        if (!atomicCounter) {
          atomicCounterPreparation.delete(saleDayKey);
          const error = new Error('El contador diario cambió mientras se preparaba la venta. La operación se reintentará para evitar números duplicados.');
          error.code = 'counter-reprepare';
          throw error;
        }

        const commandBase = positiveConsecutive(counters?.ultimoConsecutivo || counters?.numeroVentaDia || counters?.comanda);
        const command = commandBase + 1;
        const receipt = command;
        const deliveryBase = positiveConsecutive(counters?.domicilio);
        const delivery = sale.tipoPedido === 'Domicilio' ? deliveryBase + 1 : deliveryBase;
        const claveVentaDia = `${saleDayKey}-${String(command).padStart(6, '0')}`;
        const ventasEmitidas = Math.max(0, Number(counters?.ventasEmitidas ?? commandBase)) + 1;
        const ventasExistentes = Math.max(0, Number(counters?.ventasExistentes ?? commandBase)) + 1;

        officialFields = {
          comandaTemporal: sale.comanda || null,
          reciboTemporal: sale.recibo || null,
          numeroDomicilioTemporal: sale.numeroDomicilio || null,
          diaClave: saleDayKey,
          mesClave: sale.mesClave || saleDayKey.slice(0, 7),
          semanaClave: sale.semanaClave || '',
          zonaHoraria: 'America/Bogota',
          numeroVentaDia: command,
          ordenDia: command,
          claveVentaDia,
          comanda: command,
          recibo: receipt,
          numeroDomicilio: sale.tipoPedido === 'Domicilio' ? delivery : null,
          consecutivoTemporal: false,
          consecutivoOrigen: 'firestore_transaccion_atomica_v3',
          consecutivoOficialEn: timestamp
        };
        transaction.set(counterRef, {
          diaClave: saleDayKey,
          schemaVersionContador: 4,
          esquemaConsecutivo: 'atomico_v4',
          ultimoConsecutivo: command,
          numeroVentaDia: command,
          ordenDia: command,
          comanda: command,
          recibo: command,
          domicilio: delivery,
          ventasEmitidas,
          ventasExistentes,
          ultimaVentaId: docId,
          ultimaClaveVentaDia: claveVentaDia,
          actualizadoEnCliente: new Date().toISOString(),
          actualizadoServidor: timestamp,
          actualizadoPor: user.usuario,
          actualizadoUid: user.uid
        }, { merge: true });
      } else if (updateExistingCountOnDelete && counterRef) {
        const counters = counterSnap?.exists ? counterSnap.data() : {};
        if (String(counters?.esquemaConsecutivo || '') === 'atomico_v4') {
          transaction.set(counterRef, {
            ventasExistentes: Math.max(0, Number(counters?.ventasExistentes || 0) - 1),
            actualizadoEnCliente: new Date().toISOString(),
            actualizadoServidor: timestamp,
            actualizadoPor: user.usuario,
            actualizadoUid: user.uid
          }, { merge: true });
        }
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
          schemaVersion: remote ? Math.max(1, Number(remote.schemaVersion || 1)) : 6,
          dispositivoId: item.deviceId,
          diaClave: saleDayKey,
          mesClave: sale.mesClave || saleDayKey.slice(0, 7),
          zonaHoraria: sale.zonaHoraria || 'America/Bogota',
          fechaISO: sale.fechaISO || new Date().toISOString(),
          fechaNegocioISO: sale.fechaNegocioISO || sale.fechaISO || new Date().toISOString(),
          fechaNegocioDia: saleDayKey,
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
        if (!remote) {
          payload.creadoServidor = timestamp;
          payload.fechaServidor = timestamp;
        } else if (remote?.fechaServidor) {
          payload.fechaServidor = remote.fechaServidor;
        }
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
      numeroVentaDia: official.numeroVentaDia ?? target.numeroVentaDia,
      comanda: official.comanda ?? target.comanda,
      recibo: official.recibo ?? target.recibo,
      numeroDomicilio: official.numeroDomicilio ?? target.numeroDomicilio,
      ordenDia: official.ordenDia ?? target.ordenDia,
      claveVentaDia: official.claveVentaDia || target.claveVentaDia,
      diaClave: official.diaClave || target.diaClave,
      mesClave: official.mesClave || target.mesClave,
      semanaClave: official.semanaClave || target.semanaClave,
      fechaNegocioISO: official.fechaNegocioISO || target.fechaNegocioISO,
      zonaHoraria: official.zonaHoraria || target.zonaHoraria,
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
            ? `${message} Cuenta autenticada: ${firebaseAuth?.currentUser?.email || 'sin correo'}. Verifica que firestore.rules C9.32 esté publicado.`
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

          // C9.32: las ventas NUEVAS se sincronizan en FIFO estricto. Si la
          // primera pendiente no puede confirmarse, no dejamos que una venta
          // posterior tome su lugar en el contador. Esto conserva 1,2,3... en
          // el mismo orden en que se tomaron los pedidos.
          const esCreacionNueva = original.tipo !== 'delete' && Number(original.versionEsperada || 0) === 0;
          if (esCreacionNueva) {
            let bloquear = false;
            queue = queue.map(item => {
              if (item.operacionId === original.operacionId) {
                bloquear = true;
                return item;
              }
              if (bloquear && item.tipo !== 'delete' && Number(item.versionEsperada || 0) === 0) {
                return { ...item, estado: 'bloqueada', ultimoError: `Esperando la venta anterior (${original.operacionId}) para conservar el consecutivo diario.` };
              }
              return item;
            });
            writeSalesQueue(queue);
            break;
          }
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
      // C9.32: una venta que falló por un corte breve se reintenta aunque el
      // navegador nunca haya emitido un nuevo evento "online". La cola es
      // idempotente por operacionId, por lo que el mismo pedido no se duplica.
      if (isOnlineFirebase() && readSalesQueue().length && !syncingSalesSecurely) {
        sincronizarVentasPendientesEnSegundoPlano().catch(error => {
          console.warn('[C9.32] Reintento automático de ventas pendiente:', error);
        });
      }
      if (isOnlineFirebase() && !syncingPostprocesosVenta) {
        syncPendingSalePostprocesses().catch(error => {
          console.warn('[C9.32] Reintento de postprocesos de venta:', error);
        });
      }
    }, 15000);
  }

  window.addEventListener('online', async () => {
    await Promise.allSettled([
      sincronizarVentasPendientesEnSegundoPlano(),
      syncPendingSalePostprocesses(),
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
console.info('[Señor Arepa] Código activo: C9.32 · proyecto esperado: prsenorarepa');
