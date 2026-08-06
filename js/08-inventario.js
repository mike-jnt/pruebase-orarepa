(() => {
  'use strict';

  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyDxrAJcH5AAxIAK2rRWD61aSQklaH--dT0',
    authDomain: 'prsenorarepa.firebaseapp.com',
    projectId: 'prsenorarepa',
    storageBucket: 'prsenorarepa.firebasestorage.app',
    messagingSenderId: '55349021122',
    appId: '1:55349021122:web:e4c65b2f2911bd2c4eee5b',
    measurementId: 'G-8JGY4PVMMV'
  };

  const PROJECT_ID = 'prsenorarepa';
  const FIREBASE_APP_NAME = 'senorArepaPOS_prsenorarepa';
  const MANAGEMENT_EMAILS = new Set(['admin@local.io', 'administrador@local.io']);
  const INVENTARIO_COLLECTION = 'inventario';
  const MOVIMIENTOS_COLLECTION = 'movimientosInventario';
  const CATALOGO_COLLECTION = 'configuracion';
  const CATALOGO_DOC = 'catalogoProductos';
  const INVENTARIO_STORAGE_KEY = 'inventarioCocina';
  const PAGE_SIZE = 20;
  const EXPORT_PAGE_SIZE = 200;
  const EXPORT_LIMIT = 10000;
  const TIMEZONE_CO = 'America/Bogota';

  const BEBIDAS_FALLBACK = [
    'QUATRO', 'COCA COLA 400 ml', 'COCA COLA 250 ml', 'JUGO HIT 500 ml', 'SPRITE', 'COCA COLA ZERO',
    'BRISA LIMON', 'BRISA MANZANA', 'MISTER TEA', 'AGUA CON GAS', 'AGUA SABORISADA', 'POSTOBON 400 ml',
    'POSTOBON 250 ml', 'POSTOBON 1.5', 'SODA BRETAÑA', 'GATORADE', 'PREMIO 400 ml', 'PREMIO 1.5l',
    'QUATRO 1.5L', 'COCA COLA 1.5L', 'JUGO HIT 1.L', 'SPRITE 1.5L', 'COCA COLA ZERO 1.5L', 'AGUA',
    'MILO CALIENTE', 'CAFE CON LECHE', 'TINTO', 'CERVEZA POKER', 'CERVEZA CORONA'
  ];

  let firebaseApp = null;
  let firebaseAuth = null;
  let firestoreDb = null;
  let usuarioAutenticado = null;
  let firestoreDisponible = false;
  let inventario = [];
  let catalogoBebidas = [];
  let paginaActual = 0;
  let cursoresPagina = [null];
  let hayPaginaSiguiente = false;
  let busquedaActual = '';
  let temporizadorBusqueda = null;
  let cargando = false;

  const $ = (id) => document.getElementById(id);

  function escapeHtml(valor) {
    return String(valor ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function limpiarTexto(valor, max = 160) {
    return String(valor ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function slug(valor = '') {
    return limpiarTexto(valor, 200).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'producto';
  }

  function shortHash(valor = '') {
    let hash = 2166136261;
    for (const char of String(valor)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36).slice(0, 8);
  }

  function stableProductId(categoria, nombre, previo = '') {
    const existente = limpiarTexto(previo, 100);
    if (existente && !/^\w+-\d{10,}-\d+$/.test(existente)) return existente;
    return `prod_${categoria}_${slug(nombre)}_${shortHash(`${categoria}|${nombre}`)}`;
  }

  function stableInventoryId(productId, nombre, previo = '') {
    return limpiarTexto(previo, 100) || `inv_${slug(nombre)}_${shortHash(productId || nombre)}`;
  }

  function normalizarClaveInventario(nombre = '') {
    return String(nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '').trim();
  }

  function obtenerFechaHoy() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE_CO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  function esGestion(user = usuarioAutenticado) {
    return Boolean(user?.email && MANAGEMENT_EMAILS.has(String(user.email).toLowerCase()));
  }

  function actualizarIndicadorDB(estado, detalle = '') {
    const dot = $('dbStatusDot');
    const text = $('dbStatusText');
    const sub = $('dbStatusSubtext');
    const meta = $('dbStatusMeta');
    if (!dot || !text || !sub || !meta) return;
    dot.className = 'estado-db-dot';
    if (estado === 'conectado') {
      dot.classList.add('conectado');
      text.textContent = 'Conectado con Firebase';
      sub.textContent = detalle || `Página ${paginaActual + 1}: ${inventario.length} productos cargados.`;
      meta.textContent = 'Modo: consultas paginadas';
    } else if (estado === 'verificando') {
      dot.classList.add('verificando');
      text.textContent = 'Consultando inventario';
      sub.textContent = detalle || 'Leyendo solo la página solicitada.';
      meta.textContent = 'Modo: verificando';
    } else {
      text.textContent = 'Sin conexión con Firebase';
      sub.textContent = detalle || 'Se muestra un respaldo local limitado.';
      meta.textContent = 'Modo: local';
    }
  }

  function bloquearPagina(mensaje) {
    actualizarIndicadorDB('desconectado', mensaje);
    document.querySelectorAll('input, select, button').forEach((el) => { el.disabled = true; });
  }

  function normalizarItem(item = {}, fallbackId = '') {
    const nombre = limpiarTexto(item.nombre, 150);
    const productId = limpiarTexto(item.productId, 100);
    const inventoryId = limpiarTexto(item.inventoryId, 100) || fallbackId || limpiarTexto(item.id, 100);
    return {
      id: fallbackId || limpiarTexto(item.id, 100) || inventoryId,
      inventoryId,
      productId,
      nombre,
      nombreNormalizado: normalizarClaveInventario(item.nombreNormalizado || nombre),
      nombreBusqueda: limpiarTexto(item.nombreBusqueda || nombre, 150).toLowerCase(),
      cantidad: Number(item.cantidad || 0),
      unidad: limpiarTexto(item.unidad || 'unidades', 30),
      fecha: limpiarTexto(item.fecha || item.fechaISOCliente || obtenerFechaHoy(), 20),
      categoria: limpiarTexto(item.categoria || 'general', 50),
      origen: limpiarTexto(item.origen || 'manual', 50),
      version: Number(item.version || 0)
    };
  }

  function guardarInventarioLocal() {
    try {
      localStorage.setItem(INVENTARIO_STORAGE_KEY, JSON.stringify(inventario.slice(0, PAGE_SIZE)));
    } catch (error) {
      console.warn('No se pudo guardar la caché local de inventario; se continúa conectado a Firestore.', error);
      try { localStorage.removeItem(INVENTARIO_STORAGE_KEY); } catch (_) {}
    }
  }

  function cargarInventarioLocal() {
    try {
      const arr = JSON.parse(localStorage.getItem(INVENTARIO_STORAGE_KEY) || '[]');
      inventario = Array.isArray(arr) ? arr.map((item) => normalizarItem(item, item.id)).slice(0, PAGE_SIZE) : [];
    } catch (_) { inventario = []; }
  }

  async function iniciarFirebaseInventario() {
    actualizarIndicadorDB('verificando');
    cargarInventarioLocal();
    actualizarInventario();
    try {
      if (window.firebaseReadyPromise) await window.firebaseReadyPromise;
      if (!window.firebase) throw new Error('No se cargó Firebase.');
      if (firebase.apps.some((app) => app?.options?.projectId && app.options.projectId !== PROJECT_ID)) throw new Error('Se detectó otro proyecto Firebase.');
      firebaseApp = firebase.apps.find((app) => app?.name === FIREBASE_APP_NAME) || firebase.initializeApp(FIREBASE_CONFIG, FIREBASE_APP_NAME);
      firebaseAuth = firebase.auth(firebaseApp);
      firestoreDb = firebase.firestore(firebaseApp);
      try {
        firestoreDb.settings({
          experimentalAutoDetectLongPolling: false,
          experimentalForceLongPolling: true,
          experimentalLongPollingOptions: { timeoutSeconds: 25 },
          ignoreUndefinedProperties: true,
          merge: true
        });
      } catch (error) {
        console.warn('No fue posible aplicar el transporte robusto de Firestore:', error);
      }
      firestoreDisponible = true;
      firebaseAuth.onAuthStateChanged(async (user) => {
        usuarioAutenticado = user || null;
        if (!user) {
          bloquearPagina('No hay sesión iniciada. Regresa al POS e inicia sesión.');
          return;
        }
        if (!esGestion(user)) {
          bloquearPagina('Inventario solo está disponible para administrador y admin.');
          return;
        }
        document.querySelectorAll('input, select, button').forEach((el) => { el.disabled = false; });
        await cargarCatalogoBebidas();
        await cargarPaginaInventario(true);
      });
    } catch (error) {
      console.error(error);
      actualizarIndicadorDB('desconectado', error.message || 'No se pudo conectar.');
    }
  }

  async function cargarCatalogoBebidas() {
    try {
      const snap = await firestoreDb.collection(CATALOGO_COLLECTION).doc(CATALOGO_DOC).get();
      const lista = Array.isArray(snap.data()?.bebidas) ? snap.data().bebidas : [];
      catalogoBebidas = lista.filter((p) => p?.activo !== false).map((p) => {
        const nombre = limpiarTexto(p.nombre, 150);
        const productId = stableProductId('bebidas', nombre, p.productId || p.id);
        return { nombre, productId, inventoryId: stableInventoryId(productId, nombre, p.inventoryId) };
      });
    } catch (error) {
      console.warn('No se pudo cargar catálogo remoto:', error);
      catalogoBebidas = [];
    }
    if (!catalogoBebidas.length) {
      catalogoBebidas = BEBIDAS_FALLBACK.map((nombre) => {
        const productId = stableProductId('bebidas', nombre);
        return { nombre, productId, inventoryId: stableInventoryId(productId, nombre) };
      });
    }
    cargarOpcionesBebidasMenu();
  }

  function cargarOpcionesBebidasMenu() {
    const select = $('bebidaMenuSelect');
    if (!select) return;
    const actual = select.value;
    select.innerHTML = '<option value="">Selecciona una bebida del menú</option>' + catalogoBebidas.map((p) => `<option value="${escapeHtml(p.inventoryId)}">${escapeHtml(p.nombre)}</option>`).join('');
    if (catalogoBebidas.some((p) => p.inventoryId === actual)) select.value = actual;
  }

  function obtenerBebidaSeleccionada() {
    return catalogoBebidas.find((p) => p.inventoryId === $('bebidaMenuSelect')?.value) || null;
  }

  function aplicarBebidaMenuSeleccionada() {
    const bebida = obtenerBebidaSeleccionada();
    if (!bebida) return;
    $('nombreProducto').value = bebida.nombre;
    $('unidadMedida').value = 'unidades';
  }

  function crearPaginacion() {
    const botonesAgregar = document.querySelector('.seccion button[onclick="sincronizarBebidasMenuFaltantes()"]')?.parentElement;
    if (botonesAgregar && !$('btnMigrarInventarioAntiguo')) {
      botonesAgregar.insertAdjacentHTML('afterend', '<button id="btnMigrarInventarioAntiguo" type="button" onclick="migrarMetadatosInventario()" style="margin-top:8px">🧩 Preparar inventario antiguo</button>');
    }
    const lista = $('listaInventario');
    if (lista && !$('paginacionInventario')) {
      lista.insertAdjacentHTML('afterend', `
        <div id="paginacionInventario" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:15px">
          <span id="infoPaginacionInventario" style="font-size:14px;color:#78716c">Página 1 · máximo ${PAGE_SIZE} productos</span>
          <div style="display:flex;gap:10px">
            <button id="btnInventarioAnterior" type="button" style="width:auto;padding:9px 14px">← Anterior</button>
            <button id="btnInventarioSiguiente" type="button" style="width:auto;padding:9px 14px">Siguiente →</button>
          </div>
        </div>`);
      $('btnInventarioAnterior').addEventListener('click', () => cambiarPagina(-1));
      $('btnInventarioSiguiente').addEventListener('click', () => cambiarPagina(1));
    }
  }

  function construirQueryInventario() {
    let query = firestoreDb.collection(INVENTARIO_COLLECTION).orderBy('nombreNormalizado');
    const cursor = cursoresPagina[paginaActual];
    if (busquedaActual) {
      const fin = `${busquedaActual}\uf8ff`;
      query = cursor ? query.startAfter(cursor).endAt(fin) : query.startAt(busquedaActual).endAt(fin);
    } else if (cursor) {
      query = query.startAfter(cursor);
    }
    // Se consulta un registro adicional como centinela para saber con certeza
    // si existe una página siguiente sin mostrar más de PAGE_SIZE productos.
    return query.limit(PAGE_SIZE + 1);
  }

  async function cargarPaginaInventario(reset = false) {
    if (cargando || !firestoreDisponible || !esGestion()) return;
    cargando = true;
    if (reset) {
      paginaActual = 0;
      cursoresPagina = [null];
      hayPaginaSiguiente = false;
    }
    actualizarPaginacion();

    try {
      actualizarIndicadorDB('verificando', 'Leyendo únicamente la página solicitada...');
      const snap = await construirQueryInventario().get();

      // Con PAGE_SIZE + 1 nunca se habilita Siguiente por aproximación:
      // el documento adicional confirma que realmente existe otra página.
      hayPaginaSiguiente = snap.docs.length > PAGE_SIZE;
      const visibles = snap.docs.slice(0, PAGE_SIZE);

      if (!visibles.length && paginaActual > 0) {
        // Puede ocurrir si se eliminaron productos entre dos clics. Se vuelve
        // automáticamente a la última página válida y se limpia el cursor vacío.
        cursoresPagina.splice(paginaActual);
        paginaActual -= 1;
        cargando = false;
        await cargarPaginaInventario(false);
        return;
      }

      inventario = visibles.map((doc) => normalizarItem({ id: doc.id, ...doc.data() }, doc.id));
      if (hayPaginaSiguiente && visibles.length) {
        cursoresPagina[paginaActual + 1] = visibles[visibles.length - 1];
      } else {
        cursoresPagina.splice(paginaActual + 1);
      }

      guardarInventarioLocal();
      actualizarInventario();
      actualizarIndicadorDB('conectado', `Página ${paginaActual + 1}: ${inventario.length} productos leídos.`);
      console.info(`[Inventario C9.25] Página ${paginaActual + 1} cargada`, {
        visibles: inventario.length,
        hayPaginaSiguiente
      });
    } catch (error) {
      console.error('[Inventario C9.25] No se pudo cargar la página:', error);
      actualizarIndicadorDB('desconectado', String(error?.code || '').includes('failed-precondition') ? 'Falta publicar un índice requerido.' : 'No se pudo consultar el inventario.');
    } finally {
      cargando = false;
      // La versión anterior dejaba los botones deshabilitados porque actualizaba la interfaz
      // mientras cargando todavía era true. Esta actualización final los activa.
      actualizarPaginacion();
    }
  }

  function actualizarPaginacion() {
    if ($('infoPaginacionInventario')) $('infoPaginacionInventario').textContent = `Página ${paginaActual + 1} · ${inventario.length} producto${inventario.length === 1 ? '' : 's'} cargado${inventario.length === 1 ? '' : 's'}`;
    if ($('btnInventarioAnterior')) $('btnInventarioAnterior').disabled = paginaActual === 0 || cargando;
    if ($('btnInventarioSiguiente')) $('btnInventarioSiguiente').disabled = !hayPaginaSiguiente || cargando;
  }

  async function cambiarPagina(delta) {
    if (cargando) return;
    const direccion = Number(delta || 0);
    const destino = paginaActual + direccion;
    if (destino < 0 || (direccion > 0 && !hayPaginaSiguiente)) return;
    if (direccion > 0 && !cursoresPagina[destino]) {
      console.warn('[Inventario C9.25] No existe cursor para la página solicitada.');
      return;
    }
    paginaActual = destino;
    await cargarPaginaInventario(false);
  }

  function filtrarInventario() {
    clearTimeout(temporizadorBusqueda);
    temporizadorBusqueda = setTimeout(async () => {
      busquedaActual = normalizarClaveInventario($('buscadorInventario')?.value);
      await cargarPaginaInventario(true);
    }, 350);
  }

  function actualizarInventario() {
    const lista = $('listaInventario');
    const selector = $('productoSeleccionado');
    if (!lista || !selector) return;
    selector.innerHTML = '<option value="">Selecciona producto de la página actual</option>';
    if (!inventario.length) {
      lista.innerHTML = '<div style="padding:15px;color:#999;font-style:italic">No se encontraron productos.</div>';
      return;
    }
    lista.innerHTML = inventario.map((item, index) => {
      const stockBajo = Number(item.cantidad || 0) < 40;
      const bebida = item.categoria === 'bebida' || Boolean(item.productId);
      return `<div class="producto" style="align-items:flex-start">
        <div style="flex-grow:1">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><strong>${escapeHtml(item.nombre)}</strong>${bebida ? '<span style="background:#dbeafe;color:#1d4ed8;font-size:12px;font-weight:700;padding:3px 8px;border-radius:999px">Bebida del menú</span>' : ''}</div>
          ${Number(item.cantidad || 0).toFixed(2)} ${escapeHtml(item.unidad)}<br>
          <small style="color:#888">📅 Última modificación: ${escapeHtml(item.fecha || 'Sin fecha')}</small>
          ${stockBajo ? '<div style="display:inline-block;margin-top:6px;padding:6px 12px;background:#fee2e2;border:2px solid #dc2626;color:#991b1b;font-weight:bold;border-radius:8px;font-size:14px">⚠️ Bajo stock</div>' : ''}
          <div id="editor-${index}" style="margin-top:10px;display:none">
            <input type="text" id="editar-nombre-${index}" value="${escapeHtml(item.nombre)}" placeholder="Nuevo nombre">
            <input type="date" id="editar-fecha-${index}" value="${escapeHtml(item.fecha || '')}">
            <button type="button" onclick="guardarEdicion(${index})" style="background:#16a34a;color:white">Guardar</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-left:10px">
          <button type="button" onclick="mostrarEditorProducto(${index})" class="btn-eliminar" style="background:#38bdf8" title="Editar">✏️</button>
          <button type="button" onclick="eliminarProducto(${index})" class="btn-eliminar" title="Eliminar">×</button>
        </div>
      </div>`;
    }).join('');
    inventario.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.nombre;
      selector.appendChild(option);
    });
  }

  function limpiarFormularioAgregarProducto(limpiarSelect = true) {
    ['nombreProducto', 'cantidadInicial', 'fechaIngresoProducto'].forEach((id) => { if ($(id)) $(id).value = ''; });
    if ($('unidadMedida')) $('unidadMedida').value = 'unidades';
    if (limpiarSelect && $('bebidaMenuSelect')) $('bebidaMenuSelect').value = '';
  }

  async function agregarBebidaMenuRapida() {
    const bebida = obtenerBebidaSeleccionada();
    if (!bebida) { alert('Selecciona una bebida del menú.'); return; }
    const cantidad = Number($('cantidadInicial')?.value);
    if (!Number.isFinite(cantidad) || cantidad < 0) { alert('Ingresa una cantidad válida.'); return; }
    await crearOIncrementarProducto({ ...bebida, cantidad, unidad: 'unidades', fecha: $('fechaIngresoProducto')?.value || obtenerFechaHoy(), categoria: 'bebida', origen: 'menu-bebidas' });
    limpiarFormularioAgregarProducto();
  }

  async function agregarProducto() {
    const nombre = limpiarTexto($('nombreProducto')?.value, 150);
    const cantidad = Number($('cantidadInicial')?.value);
    if (!nombre || !Number.isFinite(cantidad) || cantidad < 0) { alert('Completa todos los campos correctamente.'); return; }
    const productId = stableProductId('general', nombre);
    const inventoryId = stableInventoryId(productId, nombre);
    await crearOIncrementarProducto({ nombre, productId: '', inventoryId, cantidad, unidad: $('unidadMedida')?.value || 'unidades', fecha: $('fechaIngresoProducto')?.value || obtenerFechaHoy(), categoria: 'general', origen: 'manual' });
    limpiarFormularioAgregarProducto();
  }

  async function crearOIncrementarProducto(item) {
    if (!esGestion()) return;
    const ref = firestoreDb.collection(INVENTARIO_COLLECTION).doc(item.inventoryId);
    try {
      await firestoreDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const actual = snap.exists ? Number(snap.data()?.cantidad || 0) : 0;
        tx.set(ref, {
          inventoryId: item.inventoryId,
          productId: item.productId || '',
          nombre: limpiarTexto(item.nombre, 150),
          nombreNormalizado: normalizarClaveInventario(item.nombre),
          nombreBusqueda: limpiarTexto(item.nombre, 150).toLowerCase(),
          cantidad: actual + Number(item.cantidad || 0),
          unidad: limpiarTexto(item.unidad || 'unidades', 30),
          fecha: item.fecha || obtenerFechaHoy(),
          categoria: item.categoria || 'general',
          origen: item.origen || 'manual',
          version: Number(snap.data()?.version || 0) + 1,
          actualizadoServidor: firebase.firestore.FieldValue.serverTimestamp(),
          actualizadoPor: usuarioAutenticado.email
        }, { merge: true });
      });
      await cargarPaginaInventario(true);
    } catch (error) {
      console.error(error);
      alert('No se pudo guardar el producto en Firebase.');
    }
  }

  async function actualizarStock(tipo) {
    const id = $('productoSeleccionado')?.value;
    const cantidad = Number($('cantidadMovimiento')?.value);
    if (!id || !Number.isFinite(cantidad) || cantidad <= 0) { alert('Selecciona un producto y una cantidad válida.'); return; }
    const ref = firestoreDb.collection(INVENTARIO_COLLECTION).doc(id);
    const movimientoRef = firestoreDb.collection(MOVIMIENTOS_COLLECTION).doc(`manual_${id}_${Date.now()}_${shortHash(usuarioAutenticado.uid)}`);
    const fecha = $('fechaMovimientoStock')?.value || obtenerFechaHoy();
    try {
      await firestoreDb.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('El producto ya no existe.');
        const actual = Number(snap.data()?.cantidad || 0);
        const cambio = tipo === 'salida' ? -cantidad : cantidad;
        const siguiente = actual + cambio;
        if (siguiente < 0) throw new Error(`Stock insuficiente. Disponible: ${actual}.`);
        tx.update(ref, { cantidad: siguiente, fecha, fechaISOCliente: new Date().toISOString(), version: Number(snap.data()?.version || 0) + 1, actualizadoServidor: firebase.firestore.FieldValue.serverTimestamp(), actualizadoPor: usuarioAutenticado.email });
        tx.set(movimientoRef, {
          operacionId: movimientoRef.id,
          tipoOperacion: tipo === 'salida' ? 'salida_manual' : 'ingreso_manual',
          producto: snap.data()?.nombre || id,
          productId: snap.data()?.productId || '',
          inventoryId: snap.data()?.inventoryId || id,
          cantidadAnterior: actual,
          cambio,
          cantidadNueva: siguiente,
          uid: usuarioAutenticado.uid,
          usuario: usuarioAutenticado.email,
          fechaISOCliente: new Date().toISOString(),
          fechaServidor: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      $('cantidadMovimiento').value = '';
      $('fechaMovimientoStock').value = '';
      await cargarPaginaInventario(false);
    } catch (error) {
      console.error(error);
      alert(error.message || 'No se pudo actualizar el stock.');
    }
  }

  async function sincronizarBebidasMenuFaltantes() {
    if (!confirm(`Se comprobarán ${catalogoBebidas.length} bebidas del catálogo. Esta acción realiza lecturas explícitas y crea únicamente las faltantes. ¿Continuar?`)) return;
    let creadas = 0;
    let vinculadas = 0;
    for (const bebida of catalogoBebidas) {
      const refDirecta = firestoreDb.collection(INVENTARIO_COLLECTION).doc(bebida.inventoryId);
      const directa = await refDirecta.get();
      if (directa.exists) continue;

      const porId = await firestoreDb.collection(INVENTARIO_COLLECTION).where('inventoryId', '==', bebida.inventoryId).limit(1).get();
      if (!porId.empty) continue;

      const clave = normalizarClaveInventario(bebida.nombre);
      const legado = await firestoreDb.collection(INVENTARIO_COLLECTION).where('nombreNormalizado', '==', clave).limit(1).get();
      if (!legado.empty) {
        await legado.docs[0].ref.set({
          inventoryId: bebida.inventoryId,
          productId: bebida.productId,
          nombreNormalizado: clave,
          nombreBusqueda: bebida.nombre.toLowerCase(),
          categoria: 'bebida',
          origen: 'menu-bebidas',
          actualizadoServidor: firebase.firestore.FieldValue.serverTimestamp(),
          actualizadoPor: usuarioAutenticado.email
        }, { merge: true });
        vinculadas += 1;
        continue;
      }

      await refDirecta.set({
        inventoryId: bebida.inventoryId,
        productId: bebida.productId,
        nombre: bebida.nombre,
        nombreNormalizado: clave,
        nombreBusqueda: bebida.nombre.toLowerCase(),
        cantidad: 0,
        unidad: 'unidades',
        fecha: obtenerFechaHoy(),
        categoria: 'bebida',
        origen: 'menu-bebidas',
        version: 1,
        actualizadoServidor: firebase.firestore.FieldValue.serverTimestamp(),
        actualizadoPor: usuarioAutenticado.email
      });
      creadas += 1;
    }
    alert(`Bebidas creadas: ${creadas}. Registros antiguos vinculados: ${vinculadas}.`);
    await cargarPaginaInventario(true);
  }

  async function migrarMetadatosInventario() {
    if (!confirm('Esta acción revisará el inventario antiguo por bloques y agregará únicamente los identificadores y campos de búsqueda faltantes. No cambia cantidades. ¿Continuar?')) return;
    let cursor = null;
    let revisados = 0;
    let actualizados = 0;
    while (true) {
      let query = firestoreDb.collection(INVENTARIO_COLLECTION)
        .orderBy(firebase.firestore.FieldPath.documentId())
        .limit(100);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      if (snap.empty) break;
      let batch = firestoreDb.batch();
      let escrituras = 0;
      for (const doc of snap.docs) {
        const data = doc.data() || {};
        const nombre = limpiarTexto(data.nombre || doc.id, 150);
        const clave = normalizarClaveInventario(data.nombreNormalizado || nombre);
        const bebida = catalogoBebidas.find((item) => normalizarClaveInventario(item.nombre) === clave);
        const cambios = {};
        if (!data.nombreNormalizado) cambios.nombreNormalizado = clave;
        if (!data.nombreBusqueda) cambios.nombreBusqueda = nombre.toLowerCase();
        if (!data.inventoryId) cambios.inventoryId = bebida?.inventoryId || doc.id;
        if (bebida && !data.productId) cambios.productId = bebida.productId;
        if (bebida && data.categoria !== 'bebida') cambios.categoria = 'bebida';
        if (bebida && data.origen !== 'menu-bebidas') cambios.origen = 'menu-bebidas';
        if (Object.keys(cambios).length) {
          cambios.actualizadoServidor = firebase.firestore.FieldValue.serverTimestamp();
          cambios.actualizadoPor = usuarioAutenticado.email;
          batch.set(doc.ref, cambios, { merge: true });
          escrituras += 1;
          actualizados += 1;
        }
        revisados += 1;
      }
      if (escrituras) await batch.commit();
      actualizarIndicadorDB('verificando', `Preparando inventario antiguo: ${revisados} revisados...`);
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < 100) break;
    }
    alert(`Migración terminada. Revisados: ${revisados}. Actualizados: ${actualizados}.`);
    await cargarPaginaInventario(true);
  }

  async function eliminarProducto(index) {
    const item = inventario[index];
    if (!item || !confirm(`¿Eliminar "${item.nombre}"?`)) return;
    try {
      await firestoreDb.collection(INVENTARIO_COLLECTION).doc(item.id).delete();
      await cargarPaginaInventario(paginaActual === 0);
    } catch (error) {
      console.error(error);
      alert('No se pudo eliminar el producto.');
    }
  }

  function mostrarEditorProducto(index) {
    const editor = $(`editor-${index}`);
    if (editor) editor.style.display = editor.style.display === 'none' ? 'block' : 'none';
  }

  async function guardarEdicion(index) {
    const item = inventario[index];
    const nuevoNombre = limpiarTexto($(`editar-nombre-${index}`)?.value, 150);
    const nuevaFecha = $(`editar-fecha-${index}`)?.value || item?.fecha || obtenerFechaHoy();
    if (!item || !nuevoNombre) { alert('El nombre no puede estar vacío.'); return; }
    try {
      await firestoreDb.collection(INVENTARIO_COLLECTION).doc(item.id).set({ nombre: nuevoNombre, nombreNormalizado: normalizarClaveInventario(nuevoNombre), nombreBusqueda: nuevoNombre.toLowerCase(), fecha: nuevaFecha, actualizadoServidor: firebase.firestore.FieldValue.serverTimestamp(), actualizadoPor: usuarioAutenticado.email, version: Number(item.version || 0) + 1 }, { merge: true });
      await cargarPaginaInventario(false);
    } catch (error) {
      console.error(error);
      alert('No se pudo editar el producto.');
    }
  }

  async function obtenerTodoInventarioParaExportar() {
    if (!confirm('La exportación consultará todo el inventario por páginas. ¿Continuar?')) return null;
    const data = [];
    let cursor = null;
    while (data.length < EXPORT_LIMIT) {
      let q = firestoreDb.collection(INVENTARIO_COLLECTION).orderBy('nombreNormalizado').limit(EXPORT_PAGE_SIZE);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;
      data.push(...snap.docs.map((doc) => normalizarItem({ id: doc.id, ...doc.data() }, doc.id)));
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < EXPORT_PAGE_SIZE) break;
    }
    if (data.length >= EXPORT_LIMIT) alert(`La exportación fue limitada a ${EXPORT_LIMIT} productos.`);
    return data;
  }

  async function exportarInventarioPDF() {
    const data = await obtenerTodoInventarioParaExportar();
    if (!data?.length) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.text('Inventario de Cocina', 14, 20);
    doc.autoTable({
      head: [['Ingrediente', 'Cantidad', 'Unidad', 'Fecha', 'Tipo', 'Estado']],
      body: data.map((item) => [item.nombre, Number(item.cantidad).toFixed(2), item.unidad, item.fecha || '—', item.categoria === 'bebida' ? 'Bebida menú' : 'General', Number(item.cantidad) < 40 ? 'Bajo stock' : '—']),
      startY: 30,
      styles: { fontSize: 10 }
    });
    doc.save('inventario.pdf');
  }

  Object.assign(window, {
    aplicarBebidaMenuSeleccionada,
    agregarBebidaMenuRapida,
    sincronizarBebidasMenuFaltantes,
    migrarMetadatosInventario,
    agregarProducto,
    actualizarStock,
    filtrarInventario,
    eliminarProducto,
    mostrarEditorProducto,
    guardarEdicion,
    exportarInventarioPDF
  });

  document.addEventListener('DOMContentLoaded', () => {
    crearPaginacion();
    if ($('unidadMedida')) $('unidadMedida').value = 'unidades';
    iniciarFirebaseInventario();
  });
})();
