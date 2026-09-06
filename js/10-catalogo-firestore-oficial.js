(() => {
  'use strict';

  const VERSION = 'C9.39-CATALOGO-INVENTARIO-SINCRONIZADO';
  const CACHE_OFICIAL_KEY = 'senor_arepa_catalogo_firestore_cache_v3';
  const PROYECTO_ESPERADO = 'prsenorarepa';

  let fuenteCatalogoActual = '';
  let catalogoOficialConfirmado = null;
  let catalogoAntesDeEditar = null;
  let reconectandoCatalogo = false;

  const baseRenderizarCatalogo = renderizarCatalogoProductosUI;
  const baseAbrirEditorCatalogo = abrirEditorCatalogo;
  const baseCerrarEditorCatalogo = cerrarEditorCatalogo;

  function copiarPlano(valor) {
    return JSON.parse(JSON.stringify(valor || { comida: [], adiciones: [], bebidas: [] }));
  }

  function catalogoTieneProductos(valor) {
    const normalizado = normalizarCatalogoProductos(valor || {});
    return ['comida', 'adiciones', 'bebidas'].some((categoria) => Array.isArray(normalizado[categoria]) && normalizado[categoria].length > 0);
  }


  function limpiarTextoInventario(valor = '', max = 160) {
    return String(valor ?? '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  function claveInventarioCatalogo(valor = '') {
    return String(valor || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .trim();
  }

  function aliasesInventarioCatalogo(...valores) {
    const aliases = new Set();
    valores.flat().forEach((valor) => {
      const clave = claveInventarioCatalogo(valor);
      if (!clave) return;
      aliases.add(clave);
      // Compatibilidad de volumen histórico: COCA COLA 400 <-> COCA COLA 400 ML.
      if (/\d+$/.test(clave)) aliases.add(`${clave}ML`);
      if (/\d+ML$/.test(clave)) aliases.add(clave.replace(/ML$/, ''));
      if (/\d+L$/.test(clave)) aliases.add(clave.replace(/L$/, ''));
    });
    return Array.from(aliases).filter(Boolean).slice(0, 30);
  }

  function validarBebidasCatalogoParaInventario(catalogo = {}) {
    const errores = [];
    const nombres = new Set();
    const productIds = new Set();
    const inventoryIds = new Set();
    (catalogo?.bebidas || []).forEach((bebida, index) => {
      const nombre = limpiarTextoInventario(bebida?.nombre, 150);
      const clave = claveInventarioCatalogo(nombre);
      const productId = limpiarTextoInventario(bebida?.productId || bebida?.id, 100);
      const inventoryId = limpiarTextoInventario(bebida?.inventoryId, 100);
      if (!nombre || !clave) errores.push(`Bebida ${index + 1}: nombre inválido para inventario.`);
      if (!productId) errores.push(`Bebida ${index + 1}: falta productId estable.`);
      if (!inventoryId) errores.push(`Bebida ${index + 1}: falta inventoryId estable.`);
      if (clave && nombres.has(clave)) errores.push(`Bebida duplicada: ${nombre}.`);
      if (productId && productIds.has(productId)) errores.push(`Dos bebidas comparten productId: ${productId}.`);
      if (inventoryId && inventoryIds.has(inventoryId)) errores.push(`Dos bebidas comparten inventoryId: ${inventoryId}.`);
      if (clave) nombres.add(clave);
      if (productId) productIds.add(productId);
      if (inventoryId) inventoryIds.add(inventoryId);
    });
    return errores;
  }

  function bebidaAnteriorCorrespondiente(bebida, catalogoAnterior = {}) {
    const anteriores = Array.isArray(catalogoAnterior?.bebidas) ? catalogoAnterior.bebidas : [];
    const productId = limpiarTextoInventario(bebida?.productId || bebida?.id, 100);
    const inventoryId = limpiarTextoInventario(bebida?.inventoryId, 100);
    return anteriores.find((item) => {
      const prevProductId = limpiarTextoInventario(item?.productId || item?.id, 100);
      const prevInventoryId = limpiarTextoInventario(item?.inventoryId, 100);
      return (productId && prevProductId === productId) || (inventoryId && prevInventoryId === inventoryId);
    }) || null;
  }

  async function buscarDocumentoInventarioBebida(bebida, anterior = null) {
    const collection = firestoreDb.collection('inventario');
    const inventoryId = limpiarTextoInventario(bebida?.inventoryId, 100);
    const productId = limpiarTextoInventario(bebida?.productId || bebida?.id, 100);
    const prevInventoryId = limpiarTextoInventario(anterior?.inventoryId, 100);
    const prevProductId = limpiarTextoInventario(anterior?.productId || anterior?.id, 100);

    for (const docId of [inventoryId, prevInventoryId]) {
      if (!docId) continue;
      const ref = collection.doc(docId.replaceAll('/', '_'));
      const snap = await ref.get();
      if (snap.exists) return { ref, snap, encontradoPor: 'documentId' };
    }

    for (const value of [inventoryId, prevInventoryId]) {
      if (!value) continue;
      const snap = await collection.where('inventoryId', '==', value).limit(2).get();
      if (!snap.empty) return { ref: snap.docs[0].ref, snap: snap.docs[0], encontradoPor: 'inventoryId', duplicados: snap.size > 1 };
    }

    for (const value of [productId, prevProductId]) {
      if (!value) continue;
      const snap = await collection.where('productId', '==', value).limit(2).get();
      if (!snap.empty) return { ref: snap.docs[0].ref, snap: snap.docs[0], encontradoPor: 'productId', duplicados: snap.size > 1 };
    }

    const aliases = aliasesInventarioCatalogo(anterior?.nombre, bebida?.nombre);
    for (const alias of aliases) {
      let snap = await collection.where('nombreNormalizado', '==', alias).limit(2).get();
      if (!snap.empty) return { ref: snap.docs[0].ref, snap: snap.docs[0], encontradoPor: 'nombreNormalizado', duplicados: snap.size > 1 };
      snap = await collection.where('aliasNombres', 'array-contains', alias).limit(2).get();
      if (!snap.empty) return { ref: snap.docs[0].ref, snap: snap.docs[0], encontradoPor: 'aliasNombres', duplicados: snap.size > 1 };
    }
    return null;
  }

  async function prepararSincronizacionInventarioBebidas(catalogoNuevo, catalogoAnterior = {}) {
    const actuales = Array.isArray(catalogoNuevo?.bebidas) ? catalogoNuevo.bebidas : [];
    const anteriores = Array.isArray(catalogoAnterior?.bebidas) ? catalogoAnterior.bebidas : [];
    if (actuales.length + anteriores.length > 450) {
      throw new Error('Hay demasiadas bebidas para sincronizar en una sola operación.');
    }

    const operaciones = [];
    const advertencias = [];
    const refsUsadas = new Set();
    let creadas = 0;
    let actualizadas = 0;
    let renombradas = 0;
    let desactivadas = 0;

    for (const bebida of actuales) {
      const anterior = bebidaAnteriorCorrespondiente(bebida, catalogoAnterior);
      const encontrado = await buscarDocumentoInventarioBebida(bebida, anterior);
      const inventoryId = limpiarTextoInventario(bebida.inventoryId, 100);
      const productId = limpiarTextoInventario(bebida.productId || bebida.id, 100);
      const nombre = limpiarTextoInventario(bebida.nombre, 150);
      const existente = encontrado?.snap?.exists ? (encontrado.snap.data() || {}) : {};
      const aliasNombres = aliasesInventarioCatalogo(
        anterior?.nombre,
        ...(Array.isArray(existente.aliasNombres) ? existente.aliasNombres : []),
        existente.nombre,
        nombre
      );
      const ref = encontrado?.ref || firestoreDb.collection('inventario').doc(inventoryId.replaceAll('/', '_'));
      if (refsUsadas.has(ref.path)) throw new Error(`Dos bebidas intentan usar el mismo inventario: ${nombre}.`);
      refsUsadas.add(ref.path);

      const nombreAnterior = limpiarTextoInventario(existente.nombre || anterior?.nombre, 150);
      if (nombreAnterior && claveInventarioCatalogo(nombreAnterior) !== claveInventarioCatalogo(nombre)) renombradas += 1;
      if (encontrado?.duplicados) advertencias.push(`${nombre}: se detectaron registros duplicados; se vinculó ${ref.id}.`);

      const metadata = {
        inventoryId,
        productId,
        nombre,
        nombreNormalizado: claveInventarioCatalogo(nombre),
        nombreBusqueda: nombre.toLowerCase(),
        aliasNombres,
        categoria: 'bebida',
        origen: 'menu-bebidas',
        menuActivo: true,
        catalogoActivo: true,
        sincronizadoDesdeCatalogo: true,
        actualizadoServidor: firebase.firestore.FieldValue.serverTimestamp(),
        actualizadoPor: limpiarTextoInventario(firebaseAuth?.currentUser?.email || '', 150)
      };
      if (encontrado) {
        // No reescribir cantidad/unidad/fecha con una lectura previa: una venta
        // simultánea podría haber cambiado el stock entre la lectura y el commit.
        metadata.version = firebase.firestore.FieldValue.increment(1);
      } else {
        metadata.cantidad = 0;
        metadata.unidad = 'unidades';
        metadata.fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
        metadata.version = 1;
      }
      operaciones.push({ ref, data: metadata });
      if (encontrado) actualizadas += 1; else creadas += 1;
    }

    const actualesProduct = new Set(actuales.map((item) => limpiarTextoInventario(item?.productId || item?.id, 100)).filter(Boolean));
    const actualesInventory = new Set(actuales.map((item) => limpiarTextoInventario(item?.inventoryId, 100)).filter(Boolean));
    for (const anterior of anteriores) {
      const prevProductId = limpiarTextoInventario(anterior?.productId || anterior?.id, 100);
      const prevInventoryId = limpiarTextoInventario(anterior?.inventoryId, 100);
      if ((prevProductId && actualesProduct.has(prevProductId)) || (prevInventoryId && actualesInventory.has(prevInventoryId))) continue;
      const encontrado = await buscarDocumentoInventarioBebida(anterior, anterior);
      if (!encontrado || refsUsadas.has(encontrado.ref.path)) continue;
      refsUsadas.add(encontrado.ref.path);
      operaciones.push({
        ref: encontrado.ref,
        data: {
          menuActivo: false,
          catalogoActivo: false,
          sincronizadoDesdeCatalogo: true,
          actualizadoServidor: firebase.firestore.FieldValue.serverTimestamp(),
          actualizadoPor: limpiarTextoInventario(firebaseAuth?.currentUser?.email || '', 150)
        }
      });
      desactivadas += 1;
    }

    return { operaciones, creadas, actualizadas, renombradas, desactivadas, advertencias };
  }

  async function guardarCatalogoEInventarioAtomico(catalogoNuevo, catalogoAnterior = {}) {
    const erroresBebidas = validarBebidasCatalogoParaInventario(catalogoNuevo);
    if (erroresBebidas.length) throw new Error(erroresBebidas.join('\n'));
    const sincronizacion = await prepararSincronizacionInventarioBebidas(catalogoNuevo, catalogoAnterior);
    if (sincronizacion.operaciones.length + 1 > 500) throw new Error('La sincronización supera el máximo de 500 escrituras de Firestore.');

    const batch = firestoreDb.batch();
    const catalogoRef = obtenerRefCatalogoFirestore();
    batch.set(catalogoRef, prepararPayloadCatalogoFirestore(), { merge: true });
    sincronizacion.operaciones.forEach(({ ref, data }) => batch.set(ref, data, { merge: true }));
    await batch.commit();
    return sincronizacion;
  }

  window.sincronizarInventarioConCatalogoBebidas = async function(catalogo = catalogoProductos, anterior = catalogoOficialConfirmado || {}) {
    const limpio = normalizarCatalogoProductos(catalogo || {});
    const previo = normalizarCatalogoProductos(anterior || {});
    const sync = await prepararSincronizacionInventarioBebidas(limpio, previo);
    if (!sync.operaciones.length) return sync;
    const batch = firestoreDb.batch();
    sync.operaciones.forEach(({ ref, data }) => batch.set(ref, data, { merge: true }));
    await batch.commit();
    return sync;
  };

  function gridsCatalogo() {
    return Object.values(DEFINICIONES_CATALOGO || {})
      .map((definicion) => document.querySelector(definicion.selectorGrid))
      .filter(Boolean);
  }

  function liberarPrimerPintadoCatalogo() {
    document.documentElement.classList.remove('catalogo-pendiente');
  }

  function mostrarEstadoEnGrids(mensaje, tipo = 'cargando') {
    const clases = tipo === 'error'
      ? 'border-red-200 bg-red-50 text-red-700'
      : tipo === 'offline'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-blue-200 bg-blue-50 text-blue-700';

    gridsCatalogo().forEach((grid) => {
      grid.innerHTML = `<div class="col-span-full rounded-xl border ${clases} px-4 py-5 text-center text-sm font-semibold">${escaparHTML(mensaje)}</div>`;
    });
    liberarPrimerPintadoCatalogo();
  }

  function leerCacheOficial() {
    try {
      const envelope = JSON.parse(localStorage.getItem(CACHE_OFICIAL_KEY) || 'null');
      if (!envelope || envelope.source !== 'firestore' || envelope.projectId !== PROYECTO_ESPERADO) return null;
      if (!catalogoTieneProductos(envelope.catalogo)) return null;
      return normalizarCatalogoProductos(envelope.catalogo);
    } catch (error) {
      console.warn('No se pudo leer la copia oficial del catálogo:', error);
      return null;
    }
  }

  function escribirCacheOficial(catalogo) {
    if (!catalogoTieneProductos(catalogo)) return false;
    const limpio = normalizarCatalogoProductos(catalogo);
    const envelope = {
      source: 'firestore',
      projectId: PROYECTO_ESPERADO,
      schemaVersion: 3,
      savedAt: new Date().toISOString(),
      catalogo: limpio
    };
    try {
      if (typeof guardarLocalStorageSeguro === 'function') guardarLocalStorageSeguro(CACHE_OFICIAL_KEY, envelope, { critico: false });
      else localStorage.setItem(CACHE_OFICIAL_KEY, JSON.stringify(envelope));
      // Se mantiene la clave anterior únicamente por compatibilidad con respaldos,
      // pero ahora solo recibe información confirmada por Firestore.
      if (typeof guardarLocalStorageSeguro === 'function') guardarLocalStorageSeguro(CATALOGO_PRODUCTOS_STORAGE_KEY, limpio, { critico: false });
      else localStorage.setItem(CATALOGO_PRODUCTOS_STORAGE_KEY, JSON.stringify(limpio));
      return true;
    } catch (error) {
      console.warn('No se pudo guardar la copia offline del catálogo oficial:', error);
      return false;
    }
  }

  function aplicarCatalogoOficial(catalogo, fuente = 'firestore', mensaje = '') {
    const limpio = normalizarCatalogoProductos(catalogo || {});
    if (!catalogoTieneProductos(limpio)) return false;

    catalogoProductos = limpio;
    catalogoOficialConfirmado = copiarPlano(limpio);
    fuenteCatalogoActual = fuente;

    if (fuente === 'firestore') escribirCacheOficial(limpio);

    liberarPrimerPintadoCatalogo();
    baseRenderizarCatalogo();

    if (mensaje) {
      actualizarEstadoCatalogoSync(mensaje, fuente === 'firestore' ? 'ok' : 'warn');
    }
    document.documentElement.dataset.catalogoFuente = fuente;
    document.documentElement.dataset.catalogoVersion = VERSION;
    return true;
  }

  function usarCacheOficial(motivo = 'Sin conexión') {
    const cache = leerCacheOficial();
    if (!cache) {
      fuenteCatalogoActual = '';
      catalogoProductos = { comida: [], adiciones: [], bebidas: [] };
      mostrarEstadoEnGrids('No hay una copia offline del catálogo oficial disponible.', 'error');
      actualizarEstadoCatalogoSync(`${motivo}. No existe una copia oficial guardada en este equipo.`, 'error');
      return false;
    }
    return aplicarCatalogoOficial(cache, 'cache', `${motivo}. Usando la última versión oficial guardada en este equipo.`);
  }

  // Solo se permite guardar en localStorage cuando el origen fue confirmado por Firestore.
  guardarCatalogoProductosLocal = function() {
    if (fuenteCatalogoActual !== 'firestore' || !catalogoOficialConfirmado) return false;
    return escribirCacheOficial(catalogoOficialConfirmado);
  };
  window.guardarCatalogoProductosLocal = guardarCatalogoProductosLocal;

  renderizarCatalogoProductosUI = function() {
    if (!catalogoOficialConfirmado || !['firestore', 'cache'].includes(fuenteCatalogoActual)) {
      mostrarEstadoEnGrids('Cargando catálogo oficial desde Firestore…', 'cargando');
      return;
    }
    liberarPrimerPintadoCatalogo();
    baseRenderizarCatalogo();
  };
  window.renderizarCatalogoProductosUI = renderizarCatalogoProductosUI;

  cargarCatalogoProductos = function() {
    // El catálogo fijo del HTML se conserva únicamente como herramienta manual
    // de recuperación del administrador. Nunca se muestra automáticamente.
    if (!catalogoBaseProductos || !catalogoTieneProductos(catalogoBaseProductos)) {
      catalogoBaseProductos = normalizarCatalogoProductos(extraerCatalogoBaseDesdeDOM());
    }

    if (navigator.onLine === false) {
      usarCacheOficial('Equipo sin conexión');
      return;
    }

    fuenteCatalogoActual = '';
    catalogoProductos = { comida: [], adiciones: [], bebidas: [] };
    mostrarEstadoEnGrids('Cargando catálogo oficial desde Firestore…', 'cargando');
    actualizarEstadoCatalogoSync('Consultando el catálogo oficial en Firestore…', 'info');
  };
  window.cargarCatalogoProductos = cargarCatalogoProductos;

  aplicarCatalogoRemoto = function(data = null) {
    if (!catalogoTieneProductos(data)) return false;
    return aplicarCatalogoOficial(data, 'firestore', 'Catálogo oficial sincronizado desde Firestore.');
  };
  window.aplicarCatalogoRemoto = aplicarCatalogoRemoto;

  // Se desactiva la publicación automática del catálogo fijo del HTML.
  sembrarCatalogoRemotoSiNoExiste = async function() {
    actualizarEstadoCatalogoSync('El catálogo oficial no existe en Firestore. No se creó una copia automática.', 'error');
    return false;
  };
  window.sembrarCatalogoRemotoSiNoExiste = sembrarCatalogoRemotoSiNoExiste;

  escucharCatalogoFirestore = function() {
    if (!firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser) {
      usarCacheOficial('Firebase no está disponible');
      return;
    }

    if (typeof catalogoUnsubscribe === 'function') {
      try { catalogoUnsubscribe(); } catch (_) {}
      catalogoUnsubscribe = null;
    }

    const ref = obtenerRefCatalogoFirestore();
    if (!ref) {
      usarCacheOficial('No se pudo abrir el catálogo en Firestore');
      return;
    }

    actualizarEstadoCatalogoSync('Conectando con el catálogo oficial de Firestore…', 'info');

    catalogoUnsubscribe = ref.onSnapshot({ includeMetadataChanges: true }, (doc) => {
      registrarHeartbeatFirebase();
      catalogoFirestorePermisosDisponibles = true;

      if (doc.exists && catalogoTieneProductos(doc.data())) {
        const desdeCacheFirestore = Boolean(doc.metadata?.fromCache);
        aplicarCatalogoOficial(
          doc.data(),
          'firestore',
          desdeCacheFirestore
            ? 'Catálogo oficial disponible desde la caché de Firestore; verificando conexión…'
            : 'Catálogo oficial conectado y actualizado desde Firestore.'
        );
        return;
      }

      if (doc.metadata?.fromCache && navigator.onLine !== false) {
        mostrarEstadoEnGrids('Esperando respuesta del catálogo oficial de Firestore…', 'cargando');
        actualizarEstadoCatalogoSync('Esperando confirmación del catálogo oficial…', 'info');
        return;
      }

      if (!usarCacheOficial('El documento oficial de Firestore está vacío o no existe')) {
        actualizarEstadoCatalogoSync('No hay catálogo oficial disponible. Un administrador debe crearlo desde Firestore.', 'error');
      }
    }, (error) => {
      console.error('Error al consultar el catálogo oficial desde Firestore:', error);
      const sinPermiso = String(error?.code || '').includes('permission-denied') || String(error?.message || '').toLowerCase().includes('insufficient permissions');
      if (sinPermiso) catalogoFirestorePermisosDisponibles = false;
      usarCacheOficial(sinPermiso ? 'Sin permisos para leer el catálogo oficial' : 'No se pudo conectar con Firestore');
    });
  };
  window.escucharCatalogoFirestore = escucharCatalogoFirestore;

  abrirEditorCatalogo = function() {
    if (!catalogoOficialConfirmado) {
      alert('Primero debe cargarse el catálogo oficial de Firestore.');
      return;
    }
    catalogoAntesDeEditar = copiarPlano(catalogoOficialConfirmado);
    catalogoProductos = copiarPlano(catalogoOficialConfirmado);
    baseAbrirEditorCatalogo();
  };
  window.abrirEditorCatalogo = abrirEditorCatalogo;

  cerrarEditorCatalogo = function() {
    if (catalogoAntesDeEditar) {
      catalogoProductos = copiarPlano(catalogoOficialConfirmado || catalogoAntesDeEditar);
      catalogoAntesDeEditar = null;
      renderizarCatalogoProductosUI();
    }
    baseCerrarEditorCatalogo();
  };
  window.cerrarEditorCatalogo = cerrarEditorCatalogo;

  guardarCatalogoDesdeEditor = async function() {
    if (!tienePermisoGestionCatalogoRemoto()) {
      alert('No tienes permisos para modificar el catálogo oficial.');
      return false;
    }
    if (navigator.onLine === false || !firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser) {
      catalogoProductos = copiarPlano(catalogoOficialConfirmado || { comida: [], adiciones: [], bebidas: [] });
      renderizarCatalogoProductosUI();
      actualizarEstadoCatalogoSync('No se guardaron cambios: se necesita conexión con Firestore.', 'warn');
      alert('El catálogo oficial solo puede modificarse con conexión a Firestore. No se guardaron cambios locales.');
      return false;
    }

    const errores = validarCatalogoProductos();
    if (errores.length) {
      alert('Corrige esto antes de guardar\n\n- ' + errores.join('\n- '));
      return false;
    }

    const borrador = normalizarCatalogoProductos(catalogoProductos);
    const ref = obtenerRefCatalogoFirestore();
    if (!ref) return false;

    actualizarEstadoCatalogoSync('Guardando catálogo e inventario de bebidas en Firestore…', 'info');
    try {
      const anterior = copiarPlano(catalogoOficialConfirmado || catalogoAntesDeEditar || { comida: [], adiciones: [], bebidas: [] });
      catalogoProductos = borrador;
      const syncInventario = await guardarCatalogoEInventarioAtomico(borrador, anterior);
      registrarHeartbeatFirebase();
      aplicarCatalogoOficial(borrador, 'firestore', 'Catálogo e inventario de bebidas sincronizados correctamente.');
      catalogoAntesDeEditar = null;
      baseCerrarEditorCatalogo();
      if (typeof registrarAuditoria === 'function') {
        await registrarAuditoria('actualizar_catalogo_inventario', 'configuracion', CATALOGO_FIRESTORE_DOC_ID, {
          version: VERSION,
          bebidasCreadasInventario: syncInventario.creadas,
          bebidasActualizadasInventario: syncInventario.actualizadas,
          bebidasRenombradasInventario: syncInventario.renombradas,
          bebidasDesactivadasInventario: syncInventario.desactivadas
        });
      }
      const detalle = `Inventario: ${syncInventario.creadas} creado(s), ${syncInventario.actualizadas} actualizado(s), ${syncInventario.renombradas} renombrado(s).`;
      if (syncInventario.advertencias.length) console.warn('[C9.39] Advertencias al sincronizar catálogo e inventario:', syncInventario.advertencias);
      alert(`Catálogo actualizado correctamente.\n\n${detalle}\n\nLas bebidas conservaron sus cantidades de inventario.`);
      return true;
    } catch (error) {
      console.error('No se pudo guardar el catálogo oficial:', error);
      catalogoProductos = copiarPlano(catalogoOficialConfirmado || { comida: [], adiciones: [], bebidas: [] });
      renderizarCatalogoProductosUI();
      actualizarEstadoCatalogoSync('No se guardaron cambios. Se conserva el último catálogo oficial.', 'error');
      alert('No fue posible guardar en Firestore. Se restauró el último catálogo oficial y no se creó una versión local diferente.');
      return false;
    }
  };
  window.guardarCatalogoDesdeEditor = guardarCatalogoDesdeEditor;

  restablecerCatalogoBase = async function() {
    if (!tienePermisoGestionCatalogoRemoto()) return false;
    if (!confirm('¿Deseas reemplazar el catálogo oficial de Firestore por el menú base incluido en el sistema?')) return false;
    if (navigator.onLine === false || !firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser) {
      alert('Esta acción requiere conexión con Firestore. No se realizó ningún cambio local.');
      return false;
    }

    const base = normalizarCatalogoProductos(catalogoBaseProductos || {});
    if (!catalogoTieneProductos(base)) {
      alert('No se encontró un menú base válido para restablecer.');
      return false;
    }

    const anterior = copiarPlano(catalogoOficialConfirmado || catalogoProductos);
    try {
      const previo = copiarPlano(catalogoOficialConfirmado || anterior || { comida: [], adiciones: [], bebidas: [] });
      catalogoProductos = base;
      await guardarCatalogoEInventarioAtomico(base, previo);
      aplicarCatalogoOficial(base, 'firestore', 'Menú base e inventario de bebidas sincronizados en Firestore.');
      catalogoAntesDeEditar = null;
      renderizarEditorCatalogo();
      if (typeof registrarAuditoria === 'function') {
        await registrarAuditoria('restablecer_catalogo', 'configuracion', CATALOGO_FIRESTORE_DOC_ID, { version: VERSION });
      }
      return true;
    } catch (error) {
      console.error('No se pudo restablecer el catálogo oficial:', error);
      aplicarCatalogoOficial(anterior, fuenteCatalogoActual || 'cache', 'No se modificó el catálogo oficial.');
      alert('No fue posible restablecer el catálogo en Firestore.');
      return false;
    }
  };
  window.restablecerCatalogoBase = restablecerCatalogoBase;

  window.addEventListener('offline', () => {
    actualizarEstadoCatalogoSync('Sin conexión. Se mantiene la última versión oficial disponible.', 'warn');
    if (!catalogoOficialConfirmado) usarCacheOficial('Equipo sin conexión');
  });

  window.addEventListener('online', () => {
    if (reconectandoCatalogo) return;
    reconectandoCatalogo = true;
    try {
      if (firebaseAuth?.currentUser && firestoreDisponible) {
        actualizarEstadoCatalogoSync('Conexión recuperada. Verificando el catálogo oficial…', 'info');
        escucharCatalogoFirestore();
      }
    } finally {
      setTimeout(() => { reconectandoCatalogo = false; }, 800);
    }
  });

  function iniciarCapaCatalogoOficial() {
    cargarCatalogoProductos();
    document.documentElement.dataset.catalogoFirestoreOnly = 'true';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarCapaCatalogoOficial, { once: true });
  } else {
    iniciarCapaCatalogoOficial();
  }
})();
