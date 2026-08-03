(() => {
  'use strict';

  const VERSION = '2026.08.03-CATALOGO-FIRESTORE-1';
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
      localStorage.setItem(CACHE_OFICIAL_KEY, JSON.stringify(envelope));
      // Se mantiene la clave anterior únicamente por compatibilidad con respaldos,
      // pero ahora solo recibe información confirmada por Firestore.
      localStorage.setItem(CATALOGO_PRODUCTOS_STORAGE_KEY, JSON.stringify(limpio));
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

    actualizarEstadoCatalogoSync('Guardando catálogo oficial en Firestore…', 'info');
    try {
      catalogoProductos = borrador;
      await ref.set(prepararPayloadCatalogoFirestore(), { merge: true });
      registrarHeartbeatFirebase();
      aplicarCatalogoOficial(borrador, 'firestore', 'Catálogo oficial guardado correctamente en Firestore.');
      catalogoAntesDeEditar = null;
      baseCerrarEditorCatalogo();
      if (typeof registrarAuditoria === 'function') {
        await registrarAuditoria('actualizar_catalogo', 'configuracion', CATALOGO_FIRESTORE_DOC_ID, { version: VERSION });
      }
      alert('Catálogo actualizado correctamente en Firestore. La copia offline también fue renovada.');
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
      catalogoProductos = base;
      await obtenerRefCatalogoFirestore().set(prepararPayloadCatalogoFirestore(), { merge: true });
      aplicarCatalogoOficial(base, 'firestore', 'Menú base publicado como catálogo oficial en Firestore.');
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
