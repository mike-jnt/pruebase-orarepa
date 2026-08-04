let pedido = [];
  let total = 0;
let comandaEnEdicion = null; // conserva la comanda al editar
let reciboEnEdicion = null; // conserva el recibo al editar
const usuariosSistema = {
  admin: { email: "admin@local.io", rol: "admin", nombre: "Administrador" },
  administrador: { email: "administrador@local.io", rol: "administrador", nombre: "Administrador" },
  cajero: { email: "cajero@local.io", rol: "cajero", nombre: "Cajero 1" }
};
const usuariosPorEmail = Object.fromEntries(Object.entries(usuariosSistema).map(([usuario, info]) => [String(info.email || '').toLowerCase(), { ...info, usuario }]));
let rolActual = "";
let usuarioActual = "";
let sesionActiva = false;
let ventaDocIdEnEdicion = null;
let ventaOriginalEnEdicion = null;
let ventasCache = leerLocalStorageJSONSeguro("ventas", []);
let firebaseApp = null;
let firebaseAuth = null;
let firestoreDb = null;
let firestoreDisponible = false;
let authDisponible = false;
let ventasUnsubscribe = null;
let firebaseInicializado = false;
let firebaseConexionEstado = "desconectado";
let ultimoHeartbeatFirebase = 0;
let monitorFirebaseInterval = null;
const ULTIMA_VENTA_GUARDADA_KEY = "ultimaVentaGuardada";
const VENTAS_PENDIENTES_SYNC_KEY = "ventasPendientesSync";
const ESTADO_VENTA_ACTIVA = "activa";
const ESTADO_VENTA_CANCELADA = "cancelada";
let sincronizandoVentasPendientes = false;
let temporizadorSyncVentasPendientes = null;
const CONTROL_CAJA_STORAGE_KEY = "controlCajaPorDia";
let controlCajaCache = leerLocalStorageJSONSeguro(CONTROL_CAJA_STORAGE_KEY, {});
let controlCajaFirebasePermisosDisponibles = true;
let controlCajaFirebasePermisosAvisados = false;
let cierreCajaEdicionDiaClave = "";
let catalogoUnsubscribe = null;
let catalogoFirestorePermisosDisponibles = true;
let catalogoGuardandoRemoto = false;
const CATALOGO_FIRESTORE_COLLECTION = "configuracion";
const CATALOGO_FIRESTORE_DOC_ID = "catalogoProductos";
const INVENTARIO_STORAGE_KEY = "inventarioCocina";
const INVENTARIO_COLLECTION = "inventario";
const STOCK_BEBIDA_BAJO_UMBRAL = 5;
let inventarioUnsubscribe = null;
let inventarioBebidasEstado = {};
let inventarioPermisosAvisados = false;
const CATALOGO_PRODUCTOS_STORAGE_KEY = 'senor_arepa_catalogo_productos_v2';

const SENOR_AREPA_STORAGE_VERSION = 'C9.8';
const MAX_VENTAS_CACHE_LOCAL = 300;
const CLAVES_CACHE_OBSOLETAS = Object.freeze([
  'movimientos_finanzas_cache_v2',
  'movimientos_finanzas_cache_v3',
  'movimientos',
  'senorArepaCajaPendienteV1',
  'senorArepaCajaPendienteV2',
  'senorArepaAuditoriaPendienteV1',
  'senorArepaAuditoriaPendienteV2',
  'senor_arepa_catalogo_firestore_cache_v1',
  'senor_arepa_catalogo_firestore_cache_v2'
]);

function leerLocalStorageJSONSeguro(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === '') return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[Storage C9.8] Se descartó una copia local dañada: ${key}.`, error);
    try { localStorage.removeItem(key); } catch (_) {}
    return fallback;
  }
}

function esErrorCuotaStorage(error) {
  return Boolean(
    error &&
    (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014
    )
  );
}

function estimarUsoLocalStorage() {
  let caracteres = 0;
  const detalle = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      const value = key ? (localStorage.getItem(key) || '') : '';
      const bytes = (String(key || '').length + value.length) * 2;
      caracteres += bytes;
      detalle.push({ key, bytes });
    }
  } catch (_) {}
  detalle.sort((a, b) => b.bytes - a.bytes);
  return {
    bytes: caracteres,
    megabytes: Number((caracteres / 1024 / 1024).toFixed(2)),
    clavesGrandes: detalle.slice(0, 10)
  };
}

function limpiarCachesObsoletasLocalStorage() {
  let eliminadas = 0;
  for (const key of CLAVES_CACHE_OBSOLETAS) {
    try {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        eliminadas += 1;
      }
    } catch (_) {}
  }
  return eliminadas;
}

function guardarLocalStorageSeguro(key, value, opciones = {}) {
  const critico = Boolean(opciones.critico);
  let texto = '';
  try {
    texto = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (error) {
    console.error(`[Storage C9.8] No se pudo serializar ${key}:`, error);
    return false;
  }
  try {
    localStorage.setItem(key, texto);
    return true;
  } catch (error) {
    if (!esErrorCuotaStorage(error)) {
      console.error(`[Storage C9.8] No se pudo guardar ${key}:`, error);
      return false;
    }

    const antes = estimarUsoLocalStorage();
    const eliminadas = limpiarCachesObsoletasLocalStorage();

    if (key !== ULTIMA_VENTA_GUARDADA_KEY) {
      try { localStorage.removeItem(ULTIMA_VENTA_GUARDADA_KEY); } catch (_) {}
    }

    try {
      localStorage.setItem(key, texto);
      console.warn(
        `[Storage C9.8] Se liberó espacio automáticamente para ${key}.`,
        { eliminadas, antes, despues: estimarUsoLocalStorage() }
      );
      return true;
    } catch (segundoError) {
      const mensaje = `El almacenamiento local está lleno y no se pudo guardar ${key}.`;
      if (critico) {
        console.error(`[Storage C9.8] ${mensaje}`, segundoError);
        try {
          if (typeof notificarSistema === 'function') {
            notificarSistema(
              'El navegador tiene el almacenamiento local lleno. La venta seguirá intentando sincronizarse con Firebase.',
              'warning'
            );
          }
        } catch (_) {}
      } else {
        console.warn(`[Storage C9.8] ${mensaje}`, segundoError);
      }
      return false;
    }
  }
}

function compactarReferenciaVenta(venta = {}) {
  const normalizada = normalizarVenta(venta || {});
  return {
    _docId: String(normalizada._docId || ''),
    _localId: String(normalizada._localId || ''),
    fechaISO: String(normalizada.fechaISO || ''),
    diaClave: String(normalizada.diaClave || ''),
    comanda: Number(normalizada.comanda || 0),
    recibo: Number(normalizada.recibo || 0),
    tipoPedido: String(normalizada.tipoPedido || ''),
    numeroDomicilio: Number(normalizada.numeroDomicilio || 0)
  };
}

function podarVentasParaCacheLocal(ventas = []) {
  const lista = (Array.isArray(ventas) ? ventas : []).map(normalizarVenta);
  const pendientes = lista.filter(venta =>
    ['pendiente', 'error'].includes(String(venta?._syncEstado || '').toLowerCase())
  );
  const pendientesIds = new Set(
    pendientes.map(venta => String(venta._localId || venta._docId || ''))
  );
  const recientes = ordenarVentasDesc(lista)
    .filter(venta => !pendientesIds.has(String(venta._localId || venta._docId || '')))
    .slice(0, MAX_VENTAS_CACHE_LOCAL);
  return [...pendientes, ...recientes];
}

function migrarAlmacenamientoLocalC95() {
  try {
    limpiarCachesObsoletasLocalStorage();

    const ventasGuardadas = JSON.parse(localStorage.getItem('ventas') || '[]');
    if (Array.isArray(ventasGuardadas) && ventasGuardadas.length) {
      const podadas = podarVentasParaCacheLocal(ventasGuardadas);
      guardarLocalStorageSeguro('ventas', podadas, { critico: true });
      ventasCache = podadas;
    }

    const ultima = JSON.parse(localStorage.getItem(ULTIMA_VENTA_GUARDADA_KEY) || 'null');
    if (ultima) {
      guardarLocalStorageSeguro(
        ULTIMA_VENTA_GUARDADA_KEY,
        compactarReferenciaVenta(ultima),
        { critico: false }
      );
    }

    guardarLocalStorageSeguro('senorArepaStorageVersion', SENOR_AREPA_STORAGE_VERSION, { critico: false });
    console.info('[Señor Arepa C9.8] Almacenamiento local optimizado.', estimarUsoLocalStorage());
  } catch (error) {
    console.warn('[Señor Arepa C9.8] No se pudo completar la migración de almacenamiento:', error);
  }
}

window.diagnosticarAlmacenamientoSenorArepa = estimarUsoLocalStorage;
window.limpiarCacheLocalSenorArepa = function limpiarCacheLocalSenorArepa() {
  limpiarCachesObsoletasLocalStorage();
  const ventas = JSON.parse(localStorage.getItem('ventas') || '[]');
  if (Array.isArray(ventas)) {
    const podadas = podarVentasParaCacheLocal(ventas);
    guardarLocalStorageSeguro('ventas', podadas, { critico: true });
    ventasCache = podadas;
  }
  try { localStorage.removeItem(ULTIMA_VENTA_GUARDADA_KEY); } catch (_) {}
  console.info('[Señor Arepa C9.8] Limpieza manual terminada.', estimarUsoLocalStorage());
  return estimarUsoLocalStorage();
};
const DEFINICIONES_CATALOGO = {
  comida: {
    id: 'comida',
    titulo: 'Comida',
    descripcion: 'Productos principales del menú.',
    selectorGrid: '#categoriaComida .grid',
    iconoDefecto: '⚪',
    claseBoton: 'bg-yellow-300 hover:bg-yellow-400 p-3 rounded-xl shadow-sm'
  },
  adiciones: {
    id: 'adiciones',
    titulo: 'Adiciones',
    descripcion: 'Complementos opcionales para el pedido.',
    selectorGrid: '#categoriaAdiciones .grid',
    iconoDefecto: '🧀',
    claseBoton: 'bg-yellow-300 hover:bg-yellow-400 p-3 rounded-xl shadow-sm'
  },
  bebidas: {
    id: 'bebidas',
    titulo: 'Bebidas',
    descripcion: 'Bebidas disponibles en el menú.',
    selectorGrid: '#categoriaBebidas .grid',
    iconoDefecto: '🥤',
    claseBoton: 'bg-yellow-300 hover:bg-yellow-400 p-3 rounded-xl shadow-sm'
  }
};
let catalogoProductos = { comida: [], adiciones: [], bebidas: [] };
let catalogoBaseProductos = null;
let ultimoProductoEditorCreado = null;
let contadorProductoCatalogo = 0;

function obtenerRefCatalogoFirestore() {
  if (!firestoreDisponible || !firestoreDb) return null;
  return firestoreDb.collection(CATALOGO_FIRESTORE_COLLECTION).doc(CATALOGO_FIRESTORE_DOC_ID);
}

function tienePermisoGestionCatalogoRemoto() {
  return tieneAccesoGestion();
}

function actualizarEstadoCatalogoSync(mensaje = 'Catálogo cargado en modo local', tipo = 'info') {
  const el = document.getElementById('estadoCatalogoSync');
  if (!el) return;
  const clases = {
    info: 'bg-blue-50 text-blue-700 border-blue-100',
    ok: 'bg-green-50 text-green-700 border-green-100',
    warn: 'bg-amber-50 text-amber-700 border-amber-100',
    error: 'bg-red-50 text-red-700 border-red-100',
    neutral: 'bg-gray-100 text-gray-700 border-gray-200'
  };
  el.className = `mt-2 inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold border ${clases[tipo] || clases.info}`;
  el.textContent = mensaje;
}

function prepararPayloadCatalogoFirestore() {
  const limpio = normalizarCatalogoProductos(catalogoProductos);
  return {
    comida: (limpio.comida || []).map(item => ({ id: item.id, nombre: String(item.nombre || '').trim(), precio: Number(item.precio || 0), icono: item.icono || DEFINICIONES_CATALOGO.comida.iconoDefecto })),
    adiciones: (limpio.adiciones || []).map(item => ({ id: item.id, nombre: String(item.nombre || '').trim(), precio: Number(item.precio || 0), icono: item.icono || DEFINICIONES_CATALOGO.adiciones.iconoDefecto })),
    bebidas: (limpio.bebidas || []).map(item => ({ id: item.id, nombre: String(item.nombre || '').trim(), precio: Number(item.precio || 0), icono: item.icono || DEFINICIONES_CATALOGO.bebidas.iconoDefecto })),
    updatedAt: window.firebase?.firestore?.FieldValue?.serverTimestamp ? window.firebase.firestore.FieldValue.serverTimestamp() : new Date(),
    updatedBy: String(localStorage.getItem('usuarioEmailActual') || '')
  };
}

async function guardarCatalogoProductosRemoto(mostrarEstado = true) {
  if (!tienePermisoGestionCatalogoRemoto()) {
    throw new Error('No tienes permisos para guardar el catálogo en Firebase.');
  }
  const ref = obtenerRefCatalogoFirestore();
  if (!ref) {
    throw new Error('Firebase no está disponible en este momento.');
  }
  catalogoGuardandoRemoto = true;
  if (mostrarEstado) actualizarEstadoCatalogoSync('Guardando catálogo en Firebase...', 'info');
  try {
    await ref.set(prepararPayloadCatalogoFirestore(), { merge: true });
    registrarHeartbeatFirebase();
    catalogoFirestorePermisosDisponibles = true;
    if (mostrarEstado) actualizarEstadoCatalogoSync('Catálogo sincronizado con Firebase.', 'ok');
  } catch (error) {
    if (String(error?.message || '').toLowerCase().includes('missing or insufficient permissions')) {
      catalogoFirestorePermisosDisponibles = false;
      actualizarEstadoCatalogoSync('Sin permisos en Firebase para el catálogo. Se guardó solo en este equipo.', 'warn');
    } else {
      actualizarEstadoCatalogoSync('No se pudo guardar el catálogo en Firebase. Se conservó la copia local.', 'error');
    }
    throw error;
  } finally {
    catalogoGuardandoRemoto = false;
  }
}

async function sembrarCatalogoRemotoSiNoExiste() {
  if (!tienePermisoGestionCatalogoRemoto()) return;
  const ref = obtenerRefCatalogoFirestore();
  if (!ref) return;
  try {
    const doc = await ref.get();
    registrarHeartbeatFirebase();
    if (!doc.exists) {
      await guardarCatalogoProductosRemoto(false);
      actualizarEstadoCatalogoSync('Catálogo base publicado en Firebase.', 'ok');
    }
  } catch (error) {
    console.error('No se pudo sembrar el catálogo remoto:', error);
  }
}

function aplicarCatalogoRemoto(data = null, origen = 'firebase') {
  const remoto = normalizarCatalogoProductos(data || {});
  const tieneItems = Object.values(remoto).some(lista => Array.isArray(lista) && lista.length);
  if (!tieneItems) return false;
  catalogoProductos = remoto;
  guardarCatalogoProductosLocal();
  renderizarCatalogoProductosUI();
  actualizarEstadoCatalogoSync(origen === 'firebase' ? 'Catálogo sincronizado desde Firebase.' : 'Catálogo actualizado.', 'ok');
  return true;
}

function escucharCatalogoFirestore() {
  if (!firestoreDisponible || !firestoreDb) {
    actualizarEstadoCatalogoSync('Catálogo en modo local. Firebase no disponible.', 'warn');
    return;
  }
  if (typeof catalogoUnsubscribe === 'function') {
    catalogoUnsubscribe();
    catalogoUnsubscribe = null;
  }
  const ref = obtenerRefCatalogoFirestore();
  if (!ref) return;
  catalogoUnsubscribe = ref.onSnapshot(async (doc) => {
    registrarHeartbeatFirebase();
    catalogoFirestorePermisosDisponibles = true;
    const aplicado = aplicarCatalogoRemoto(doc.exists ? doc.data() : null, 'firebase');
    if (!aplicado) {
      actualizarEstadoCatalogoSync('Catálogo remoto vacío. Usando copia local por ahora.', 'warn');
      await sembrarCatalogoRemotoSiNoExiste();
    }
  }, (error) => {
    console.error('Error al escuchar el catálogo desde Firebase:', error);
    if (String(error?.message || '').toLowerCase().includes('missing or insufficient permissions')) {
      catalogoFirestorePermisosDisponibles = false;
      actualizarEstadoCatalogoSync('Firebase no tiene permisos para leer el catálogo. Se usa la copia local.', 'warn');
    } else {
      actualizarEstadoCatalogoSync('No se pudo sincronizar el catálogo. Se usa la copia local.', 'error');
    }
  });
}

function clonarJSON(data) {
  return JSON.parse(JSON.stringify(data));
}

function generarIdProductoCatalogo(categoriaId = 'producto') {
  contadorProductoCatalogo += 1;
  return `${categoriaId}-${Date.now()}-${contadorProductoCatalogo}`;
}

function limpiarNumeroEntero(valor = '') {
  return String(valor || '').replace(/\D+/g, '');
}

function formatearNumeroConPuntosEntrada(valor = 0) {
  const numero = Number(limpiarNumeroEntero(valor));
  if (!numero) return '';
  return numero.toLocaleString('es-CO');
}

function obtenerIconoDesdeTexto(texto = '', iconoDefecto = '•') {
  const limpio = String(texto || '').trim();
  const primerToken = limpio.split(/\s+/)[0] || '';
  if (!primerToken) return iconoDefecto;
  const tieneSimbolo = /[^A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ]/.test(primerToken) || Array.from(primerToken).some(ch => (ch.codePointAt(0) || 0) > 255);
  return tieneSimbolo ? primerToken : iconoDefecto;
}

function normalizarCatalogoProductos(origen = null) {
  const base = origen && typeof origen === 'object' ? origen : {};
  const salida = { comida: [], adiciones: [], bebidas: [] };
  Object.keys(DEFINICIONES_CATALOGO).forEach(categoriaId => {
    const iconoDefecto = DEFINICIONES_CATALOGO[categoriaId].iconoDefecto;
    const lista = Array.isArray(base[categoriaId]) ? base[categoriaId] : [];
    salida[categoriaId] = lista.map((producto, index) => ({
      id: producto?.id || generarIdProductoCatalogo(categoriaId),
      nombre: String(producto?.nombre || '').trim() || `${DEFINICIONES_CATALOGO[categoriaId].titulo} ${index + 1}`,
      precio: Number(producto?.precio || 0),
      icono: producto?.icono || iconoDefecto
    })).filter(producto => producto.nombre);
  });
  return salida;
}

function extraerCatalogoBaseDesdeDOM() {
  const salida = { comida: [], adiciones: [], bebidas: [] };
  Object.keys(DEFINICIONES_CATALOGO).forEach(categoriaId => {
    const def = DEFINICIONES_CATALOGO[categoriaId];
    const grid = document.querySelector(def.selectorGrid);
    if (!grid) return;
    grid.querySelectorAll('button').forEach(btn => {
      const onclick = btn.getAttribute('onclick') || '';
      const match = onclick.match(/agregarProducto\('([^']+)'\s*,\s*([0-9.]+)/);
      if (!match) return;
      salida[categoriaId].push({
        id: generarIdProductoCatalogo(categoriaId),
        nombre: String(match[1] || '').trim(),
        precio: Number(match[2] || 0),
        icono: obtenerIconoDesdeTexto(btn.textContent || '', def.iconoDefecto)
      });
    });
  });
  return salida;
}

function guardarCatalogoProductosLocal() {
  try {
    guardarLocalStorageSeguro(CATALOGO_PRODUCTOS_STORAGE_KEY, catalogoProductos, { critico: false });
  } catch (error) {
    console.error('No se pudo guardar el catálogo de productos:', error);
  }
}

function cargarCatalogoProductos() {
  catalogoBaseProductos = normalizarCatalogoProductos(extraerCatalogoBaseDesdeDOM());
  let guardado = null;
  try {
    guardado = JSON.parse(localStorage.getItem(CATALOGO_PRODUCTOS_STORAGE_KEY) || 'null');
  } catch (error) {
    console.error('No se pudo leer el catálogo guardado:', error);
  }
  catalogoProductos = normalizarCatalogoProductos(guardado || catalogoBaseProductos);
  guardarCatalogoProductosLocal();
  renderizarCatalogoProductosUI();
  actualizarEstadoCatalogoSync('Catálogo cargado desde este equipo. Esperando sincronización...', 'info');
}

function obtenerEtiquetaBotonProducto(producto, categoriaId) {
  const icono = producto?.icono || DEFINICIONES_CATALOGO[categoriaId]?.iconoDefecto || '•';
  return `${icono} ${producto?.nombre || 'Producto'} - ${formatearCOP(Number(producto?.precio || 0))}`;
}

function renderizarCategoriaCatalogo(categoriaId) {
  const def = DEFINICIONES_CATALOGO[categoriaId];
  const grid = document.querySelector(def.selectorGrid);
  if (!grid) return;
  const fragment = document.createDocumentFragment();
  (catalogoProductos[categoriaId] || []).forEach(producto => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = def.claseBoton;
    btn.dataset.productName = producto.nombre;
    btn.dataset.originalLabel = obtenerEtiquetaBotonProducto(producto, categoriaId);
    btn.innerHTML = `<span>${btn.dataset.originalLabel}</span>`;
    btn.addEventListener('click', () => agregarProducto(producto.nombre, Number(producto.precio || 0)));
    fragment.appendChild(btn);
  });
  grid.innerHTML = '';
  grid.appendChild(fragment);
}

function actualizarProductosBebidaInventarioDesdeCatalogo() {
  PRODUCTOS_BEBIDA_INVENTARIO = new Set((catalogoProductos.bebidas || []).map(item => normalizarClaveInventario(item?.nombre || '')));
}

function renderizarCatalogoProductosUI() {
  Object.keys(DEFINICIONES_CATALOGO).forEach(renderizarCategoriaCatalogo);
  actualizarProductosBebidaInventarioDesdeCatalogo();
  actualizarAlertasStockBebidas();
  if (!document.getElementById('modalEditorCatalogo')?.classList.contains('hidden')) {
    renderizarEditorCatalogo();
  }
}

function abrirEditorCatalogo() {
  if (!verificarAcceso(['admin', 'administrador'])) return;
  const modal = document.getElementById('modalEditorCatalogo');
  if (!modal) return;
  renderizarEditorCatalogo();
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.classList.add('overflow-hidden');
}

function cerrarEditorCatalogo() {
  const modal = document.getElementById('modalEditorCatalogo');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  document.body.classList.remove('overflow-hidden');
}

function renderizarEditorCatalogo() {
  const contenedor = document.getElementById('editorCatalogoContenido');
  if (!contenedor) return;
  contenedor.innerHTML = Object.keys(DEFINICIONES_CATALOGO).map(categoriaId => {
    const def = DEFINICIONES_CATALOGO[categoriaId];
    const filas = (catalogoProductos[categoriaId] || []).map((producto, index) => `
      <tr id="fila-editor-${categoriaId}-${producto.id}">
        <td class="p-2 border text-center text-sm text-gray-500">${index + 1}</td>
        <td class="p-2 border">
          <input type="text" id="input-nombre-editor-${categoriaId}-${producto.id}" value="${escaparHTML(producto.nombre)}" oninput="actualizarNombreProductoEditor('${categoriaId}', '${producto.id}', this.value)" class="w-full border border-yellow-200 rounded-lg px-3 py-2 text-sm" placeholder="Nombre del producto">
        </td>
        <td class="p-2 border w-[180px]">
          <input type="text" value="${formatearNumeroConPuntosEntrada(producto.precio)}" oninput="actualizarPrecioProductoEditor('${categoriaId}', '${producto.id}', this)" class="w-full border border-yellow-200 rounded-lg px-3 py-2 text-sm text-right" placeholder="0">
        </td>
        <td class="p-2 border text-center w-[90px]">
          <button type="button" onclick="eliminarProductoEditor('${categoriaId}', '${producto.id}')" class="bg-red-100 hover:bg-red-200 text-red-700 px-3 py-2 rounded-lg text-xs font-semibold">Eliminar</button>
        </td>
      </tr>
    `).join('');
    return `
      <section class="bg-white border border-yellow-100 rounded-2xl shadow-sm overflow-hidden">
        <div class="px-4 py-4 border-b border-yellow-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h4 class="text-lg font-bold text-gray-800">${def.titulo}</h4>
            <p class="text-sm text-gray-500">${def.descripcion}</p>
          </div>
          <button type="button" onclick="agregarProductoEditor('${categoriaId}')" class="bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-2 rounded-xl text-sm font-semibold">+ Agregar ${def.titulo.toLowerCase()}</button>
        </div>
        <div class="overflow-auto">
          <table class="min-w-full text-sm bg-white">
            <thead class="bg-yellow-50 text-gray-600">
              <tr>
                <th class="p-2 border w-16">#</th>
                <th class="p-2 border text-left">Nombre</th>
                <th class="p-2 border text-right">Precio</th>
                <th class="p-2 border text-center">Acción</th>
              </tr>
            </thead>
            <tbody>
              ${filas || `<tr><td colspan="4" class="p-4 text-center text-gray-500">Todavía no hay productos en esta sección.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }).join('');
  enfocarUltimoProductoCreadoEditor();
}

function enfocarUltimoProductoCreadoEditor() {
  if (!ultimoProductoEditorCreado?.categoriaId || !ultimoProductoEditorCreado?.productoId) return;
  const { categoriaId, productoId } = ultimoProductoEditorCreado;
  requestAnimationFrame(() => {
    const fila = document.getElementById(`fila-editor-${categoriaId}-${productoId}`);
    const inputNombre = document.getElementById(`input-nombre-editor-${categoriaId}-${productoId}`);
    if (fila) {
      fila.scrollIntoView({ behavior: 'smooth', block: 'center' });
      fila.classList.add('bg-yellow-50');
      setTimeout(() => fila.classList.remove('bg-yellow-50'), 1800);
    }
    if (inputNombre) {
      inputNombre.focus();
      inputNombre.select();
    }
    ultimoProductoEditorCreado = null;
  });
}

function agregarProductoEditor(categoriaId) {
  if (!catalogoProductos[categoriaId]) return;
  const nuevoProducto = {
    id: generarIdProductoCatalogo(categoriaId),
    nombre: '',
    precio: 0,
    icono: DEFINICIONES_CATALOGO[categoriaId]?.iconoDefecto || '•'
  };
  catalogoProductos[categoriaId].push(nuevoProducto);
  ultimoProductoEditorCreado = { categoriaId, productoId: nuevoProducto.id };
  renderizarEditorCatalogo();
}

function actualizarNombreProductoEditor(categoriaId, productoId, valor) {
  const producto = (catalogoProductos[categoriaId] || []).find(item => item.id === productoId);
  if (!producto) return;
  producto.nombre = String(valor || '').trimStart();
}

function actualizarPrecioProductoEditor(categoriaId, productoId, input) {
  const producto = (catalogoProductos[categoriaId] || []).find(item => item.id === productoId);
  if (!producto || !input) return;
  const limpio = limpiarNumeroEntero(input.value);
  producto.precio = Number(limpio || 0);
  input.value = formatearNumeroConPuntosEntrada(limpio);
}

function eliminarProductoEditor(categoriaId, productoId) {
  catalogoProductos[categoriaId] = (catalogoProductos[categoriaId] || []).filter(item => item.id !== productoId);
  renderizarEditorCatalogo();
}

function validarCatalogoProductos() {
  const errores = [];
  Object.keys(DEFINICIONES_CATALOGO).forEach(categoriaId => {
    (catalogoProductos[categoriaId] || []).forEach((producto, index) => {
      if (!String(producto?.nombre || '').trim()) {
        errores.push(`${DEFINICIONES_CATALOGO[categoriaId].titulo} ${index + 1}: falta el nombre.`);
      }
      if (Number(producto?.precio || 0) < 0) {
        errores.push(`${DEFINICIONES_CATALOGO[categoriaId].titulo} ${index + 1}: el precio no puede ser negativo.`);
      }
    });
  });
  return errores;
}

async function guardarCatalogoDesdeEditor() {
  const errores = validarCatalogoProductos();
  if (errores.length) {
    alert('Corrige esto antes de guardar\n\n- ' + errores.join('\n- '));
    return;
  }
  catalogoProductos = normalizarCatalogoProductos(catalogoProductos);
  guardarCatalogoProductosLocal();
  renderizarCatalogoProductosUI();

  let mensajeFinal = 'Catálogo actualizado correctamente en este equipo.';
  if (tienePermisoGestionCatalogoRemoto() && firestoreDisponible && firestoreDb) {
    try {
      await guardarCatalogoProductosRemoto(true);
      mensajeFinal = 'Catálogo actualizado y sincronizado con Firebase correctamente.';
    } catch (error) {
      console.error('No se pudo guardar el catálogo en Firebase:', error);
      mensajeFinal = 'Catálogo guardado en este equipo, pero Firebase no lo pudo sincronizar. Revisa permisos o conexión.';
    }
  } else if (tienePermisoGestionCatalogoRemoto()) {
    actualizarEstadoCatalogoSync('Firebase no disponible. Catálogo guardado solo en este equipo.', 'warn');
    mensajeFinal = 'Catálogo guardado en este equipo. Firebase no estaba disponible para compartirlo.';
  }

  cerrarEditorCatalogo();
  alert(mensajeFinal);
}

async function restablecerCatalogoBase() {
  if (!confirm('¿Seguro que quieres volver al menú base original?')) return;
  catalogoProductos = clonarJSON(catalogoBaseProductos || { comida: [], adiciones: [], bebidas: [] });
  catalogoProductos = normalizarCatalogoProductos(catalogoProductos);
  guardarCatalogoProductosLocal();
  renderizarCatalogoProductosUI();
  renderizarEditorCatalogo();
  if (tienePermisoGestionCatalogoRemoto() && firestoreDisponible && firestoreDb) {
    try {
      await guardarCatalogoProductosRemoto(true);
    } catch (error) {
      console.error('No se pudo restablecer el catálogo en Firebase:', error);
    }
  } else {
    actualizarEstadoCatalogoSync('Menú base restablecido solo en este equipo.', 'warn');
  }
}

function escaparHTML(valor = '') {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function normalizarClaveInventario(nombre = "") {
  return String(nombre || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .trim();
}

function obtenerMapaInventarioDesdeArray(items = []) {
  const mapa = {};
  (Array.isArray(items) ? items : []).forEach(item => {
    const clave = normalizarClaveInventario(item?.nombreNormalizado || item?.nombre || "");
    if (!clave) return;
    mapa[clave] = {
      nombre: item?.nombre || clave,
      cantidad: Number(item?.cantidad || 0),
      unidad: item?.unidad || "unidades"
    };
  });
  return mapa;
}

function obtenerMapaInventarioLocal() {
  try {
    return obtenerMapaInventarioDesdeArray(JSON.parse(localStorage.getItem(INVENTARIO_STORAGE_KEY) || "[]"));
  } catch (error) {
    console.error("No se pudo leer el inventario local:", error);
    return {};
  }
}

function prepararBotonesBebidaParaAlertas() {
  document.querySelectorAll('#categoriaBebidas button').forEach(btn => {
    if (!btn.dataset.originalLabel) {
      btn.dataset.originalLabel = btn.textContent.trim();
    }
    if (!btn.dataset.productName) {
      const onclick = btn.getAttribute('onclick') || '';
      const match = onclick.match(/agregarProducto\('([^']+)'\s*,/);
      if (match) btn.dataset.productName = match[1];
    }
  });
}

function aplicarEstadoVisualBotonBebida(btn, infoStock = null) {
  const nombreProducto = btn.dataset.productName || "";
  const original = btn.dataset.originalLabel || btn.textContent.trim();
  const cantidad = Number(infoStock?.cantidad ?? NaN);
  const tieneStock = Number.isFinite(cantidad);
  const agotado = tieneStock && cantidad <= 0;
  const bajo = tieneStock && cantidad > 0 && cantidad <= STOCK_BEBIDA_BAJO_UMBRAL;

  btn.classList.remove('bebida-stock-bajo', 'bebida-stock-agotado');
  btn.removeAttribute('title');
  btn.innerHTML = `<span>${original}</span>`;

  if (!nombreProducto || (!agotado && !bajo)) return;

  const etiqueta = agotado ? 'AGOTADO' : `POCO STOCK (${cantidad})`;
  btn.classList.add(agotado ? 'bebida-stock-agotado' : 'bebida-stock-bajo');
  btn.title = `${nombreProducto} · ${etiqueta}`;
  btn.innerHTML = `<span>${original}</span><span class="stock-alert-badge">${etiqueta}</span>`;
}

function actualizarAlertasStockBebidas(origen = null) {
  prepararBotonesBebidaParaAlertas();
  const mapa = (origen && Object.keys(origen).length) ? origen : (Object.keys(inventarioBebidasEstado).length ? inventarioBebidasEstado : obtenerMapaInventarioLocal());
  document.querySelectorAll('#categoriaBebidas button').forEach(btn => {
    const clave = normalizarClaveInventario(btn.dataset.productName || "");
    aplicarEstadoVisualBotonBebida(btn, mapa[clave] || null);
  });
}

function escucharInventarioFirestore() {
  if (!firestoreDisponible || !firestoreDb) {
    actualizarAlertasStockBebidas();
    return;
  }
  if (typeof inventarioUnsubscribe === 'function') inventarioUnsubscribe();

  inventarioUnsubscribe = firestoreDb.collection(INVENTARIO_COLLECTION).onSnapshot((snapshot) => {
    inventarioPermisosAvisados = false;
    const items = snapshot.docs.map(doc => ({ _docId: doc.id, ...doc.data() }));
    inventarioBebidasEstado = obtenerMapaInventarioDesdeArray(items);
    try {
      guardarLocalStorageSeguro(INVENTARIO_STORAGE_KEY, items, { critico: false });
    } catch (error) {
      console.error("No se pudo actualizar el inventario local desde Firebase:", error);
    }
    actualizarAlertasStockBebidas(inventarioBebidasEstado);
  }, (error) => {
    if (!inventarioPermisosAvisados) {
      console.error("No se pudo sincronizar el inventario de bebidas desde Firebase:", error);
      inventarioPermisosAvisados = true;
    }
    inventarioBebidasEstado = obtenerMapaInventarioLocal();
    actualizarAlertasStockBebidas(inventarioBebidasEstado);
  });
}

let PRODUCTOS_BEBIDA_INVENTARIO = new Set();

function esProductoBebidaInventario(nombre = "") {
  return PRODUCTOS_BEBIDA_INVENTARIO.has(normalizarClaveInventario(nombre));
}

function contarBebidasPedidoInventario(pedido = []) {
  const conteo = {};
  (Array.isArray(pedido) ? pedido : []).forEach(item => {
    const nombre = String(item?.nombre || "").trim();
    if (!esProductoBebidaInventario(nombre)) return;
    const clave = normalizarClaveInventario(nombre);
    if (!conteo[clave]) conteo[clave] = { nombre, cantidad: 0 };
    conteo[clave].cantidad += 1;
  });
  return conteo;
}

function calcularAjustesInventarioBebidas(pedidoAnterior = [], pedidoNuevo = []) {
  const anterior = contarBebidasPedidoInventario(pedidoAnterior);
  const nuevo = contarBebidasPedidoInventario(pedidoNuevo);
  const claves = new Set([...Object.keys(anterior), ...Object.keys(nuevo)]);
  const ajustes = {};
  claves.forEach(clave => {
    const cantidadAnterior = Number(anterior[clave]?.cantidad || 0);
    const cantidadNueva = Number(nuevo[clave]?.cantidad || 0);
    const diferencia = cantidadAnterior - cantidadNueva;
    if (diferencia !== 0) {
      ajustes[clave] = {
        nombre: nuevo[clave]?.nombre || anterior[clave]?.nombre || clave,
        cantidad: diferencia
      };
    }
  });
  return ajustes;
}

function aplicarAjustesInventarioLocal(ajustes = {}) {
  const entradas = Object.entries(ajustes || {});
  if (!entradas.length) return;
  try {
    const inventarioLocal = JSON.parse(localStorage.getItem(INVENTARIO_STORAGE_KEY) || "[]");
    let cambio = false;
    entradas.forEach(([clave, ajuste]) => {
      const index = inventarioLocal.findIndex(item => normalizarClaveInventario(item?.nombreNormalizado || item?.nombre || "") === clave);
      if (index < 0) return;
      const actual = Number(inventarioLocal[index].cantidad || 0);
      inventarioLocal[index].cantidad = Math.max(0, actual + Number(ajuste.cantidad || 0));
      inventarioLocal[index].fecha = obtenerFechaLocalISO(new Date());
      inventarioLocal[index].nombreNormalizado = inventarioLocal[index].nombreNormalizado || clave;
      cambio = true;
    });
    if (cambio) {
      guardarLocalStorageSeguro(INVENTARIO_STORAGE_KEY, inventarioLocal, { critico: false });
      inventarioBebidasEstado = obtenerMapaInventarioDesdeArray(inventarioLocal);
      actualizarAlertasStockBebidas(inventarioBebidasEstado);
    }
  } catch (error) {
    console.error("No se pudo actualizar el inventario local de bebidas:", error);
  }
}

async function aplicarAjustesInventarioFirestore(ajustes = {}) {
  const entradas = Object.entries(ajustes || {});
  if (!entradas.length || !firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser) return;

  const timestampServidor = firebase.firestore.FieldValue.serverTimestamp;
  for (const [clave, ajuste] of entradas) {
    try {
      const snapshot = await firestoreDb.collection(INVENTARIO_COLLECTION)
        .where('nombreNormalizado', '==', clave)
        .limit(1)
        .get();

      if (snapshot.empty) {
        console.warn(`No se encontró stock en Firebase para la bebida: ${ajuste.nombre}`);
        continue;
      }

      const doc = snapshot.docs[0];
      await firestoreDb.runTransaction(async (transaction) => {
        const fresh = await transaction.get(doc.ref);
        if (!fresh.exists) throw new Error(`El inventario de ${ajuste.nombre || clave} ya no existe.`);

        const actualData = fresh.data() || {};
        const actual = Number(actualData.cantidad || 0);
        const nuevaCantidad = actual + Number(ajuste.cantidad || 0);
        if (nuevaCantidad < 0) {
          throw new Error(`Stock insuficiente para ${ajuste.nombre || clave}. Disponible: ${actual}.`);
        }

        // Estos son exactamente los campos permitidos al cajero por firestore.rules.
        transaction.update(doc.ref, {
          cantidad: nuevaCantidad,
          inventoryId: String(actualData.inventoryId || ajuste.inventoryId || doc.id),
          productId: String(actualData.productId || ajuste.productId || ''),
          nombreNormalizado: String(actualData.nombreNormalizado || clave),
          fechaISOCliente: new Date().toISOString(),
          actualizadoServidor: timestampServidor()
        });
      });
    } catch (error) {
      console.error(`No se pudo ajustar el inventario en Firebase para ${ajuste.nombre}:`, error);
      throw error;
    }
  }
}

async function sincronizarInventarioBebidasPorCambio(ventaNueva = null, ventaAnterior = null) {
  const pedidoAnterior = ventaAnterior && !esVentaCancelada(ventaAnterior) ? (ventaAnterior.pedido || []) : [];
  const pedidoNuevo = ventaNueva && !esVentaCancelada(ventaNueva) ? (ventaNueva.pedido || []) : [];
  const ajustes = calcularAjustesInventarioBebidas(pedidoAnterior, pedidoNuevo);
  if (!Object.keys(ajustes).length) return;
  aplicarAjustesInventarioLocal(ajustes);
  await aplicarAjustesInventarioFirestore(ajustes);
}

function obtenerEstadoVenta(venta = {}) {
  return String(venta?.estado || ESTADO_VENTA_ACTIVA).toLowerCase() === ESTADO_VENTA_CANCELADA
    ? ESTADO_VENTA_CANCELADA
    : ESTADO_VENTA_ACTIVA;
}

function esVentaCancelada(venta = {}) {
  return obtenerEstadoVenta(venta) === ESTADO_VENTA_CANCELADA;
}

function filtrarVentasActivas(ventas = []) {
  return (Array.isArray(ventas) ? ventas : []).filter(venta => !esVentaCancelada(venta));
}

function esPedidoDomicilio(venta = {}) {
  return String(venta?.tipoPedido || '').toLowerCase() === 'domicilio';
}

function obtenerNumeroDomicilio(venta = {}) {
  const numero = Number(venta?.numeroDomicilio || 0);
  return Number.isFinite(numero) && numero > 0 ? numero : 0;
}

function contarDomicilios(ventas = [], incluirCanceladas = false) {
  const base = incluirCanceladas ? (Array.isArray(ventas) ? ventas : []) : filtrarVentasActivas(ventas);
  return base.filter(venta => esPedidoDomicilio(venta)).length;
}

function obtenerSiguienteNumeroDomicilioDelDia(diaClave) {
  const ventasDelDia = obtenerVentasStorage().filter(venta => {
    const fechaBase = venta.fechaISO ? new Date(venta.fechaISO) : new Date(venta.fecha || Date.now());
    const diaVenta = venta.diaClave || obtenerFechaLocalISO(fechaBase);
    return diaVenta === diaClave && esPedidoDomicilio(venta);
  });
  const maximoRegistrado = ventasDelDia.reduce((max, venta) => Math.max(max, obtenerNumeroDomicilio(venta)), 0);
  return Math.max(maximoRegistrado, ventasDelDia.length) + 1;
}

function obtenerBadgeEstadoVenta(venta = {}) {
  return esVentaCancelada(venta)
    ? '<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700">Cancelado</span>'
    : '<span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-bold bg-green-100 text-green-700">Activa</span>';
}

function limpiarContextoEdicionVenta() {
  comandaEnEdicion = null;
  reciboEnEdicion = null;
  ventaDocIdEnEdicion = null;
  ventaOriginalEnEdicion = null;
}

function guardarReferenciaUltimaVenta(venta = {}) {
  const referenciaCompacta = compactarReferenciaVenta(venta);
  const guardada = guardarLocalStorageSeguro(
    ULTIMA_VENTA_GUARDADA_KEY,
    referenciaCompacta,
    { critico: false }
  );
  if (!guardada) {
    console.warn(
      'No se pudo guardar la referencia local de la última venta. La venta principal no se pierde por este motivo.'
    );
  }
}

function obtenerUltimaVentaGuardada() {
  const ventas = obtenerVentasStorage();
  try {
    const guardada = JSON.parse(localStorage.getItem(ULTIMA_VENTA_GUARDADA_KEY) || "null");
    if (guardada) {
      if (guardada._docId) {
        const matchDoc = ventas.find(v => v._docId === guardada._docId);
        if (matchDoc) return normalizarVenta(matchDoc);
      }

      const matchNumeracion = ventas.find(v =>
        String(v.fechaISO || "") === String(guardada.fechaISO || "") &&
        Number(v.comanda || 0) === Number(guardada.comanda || 0) &&
        Number(v.recibo || 0) === Number(guardada.recibo || 0)
      );
      if (matchNumeracion) return normalizarVenta(matchNumeracion);

      return normalizarVenta(guardada);
    }
  } catch (error) {
    console.error("No se pudo leer la referencia de la última venta guardada:", error);
  }

  const ventasOrdenadas = ordenarVentasDesc(ventas);
  return ventasOrdenadas.length ? normalizarVenta(ventasOrdenadas[0]) : null;
}

function esValorTextoCajaVacio(valor) {
  const texto = String(valor ?? '').trim().toLowerCase();
  return !texto || texto === '-' || texto === '--' || texto === '—' || texto === 'null' || texto === 'undefined' || texto === 'sin registro' || texto === 'pendiente';
}

function normalizarTextoCaja(valor) {
  return esValorTextoCajaVacio(valor) ? '' : String(valor).trim();
}

function obtenerNumeroCaja(...valores) {
  for (const valor of valores) {
    if (valor === undefined || valor === null || valor === '') continue;
    const numero = Number(valor);
    if (Number.isFinite(numero)) return numero;
  }
  return 0;
}

function normalizarControlCaja(control = {}, diaClave = "") {
  return {
    ...control,
    diaClave: normalizarTextoCaja(control.diaClave) || diaClave || "",
    aperturaMonto: obtenerNumeroCaja(control.aperturaMonto),
    aperturaHora: normalizarTextoCaja(control.aperturaHora),
    aperturaUsuario: normalizarTextoCaja(control.aperturaUsuario),
    cierreMonto: obtenerNumeroCaja(control.cierreMonto),
    cierreHora: normalizarTextoCaja(control.cierreHora),
    cierreUsuario: normalizarTextoCaja(control.cierreUsuario),
    cierreObservaciones: control.cierreObservaciones || ""
  };
}

function tieneCierreRegistradoControl(control = {}) {
  return Boolean(normalizarTextoCaja(control.cierreHora)) || Number(control.cierreMonto || 0) > 0;
}

function tieneResumenGuardadoControl(control = {}) {
  const campos = [
    'cantidadVentas', 'cantidadVentasActivas', 'cantidadDomiciliosActivos',
    'totalVentas', 'totalCobrado', 'totalCobradoClientes', 'ventaRealNegocio',
    'totalEfectivo', 'efectivoBrutoSistema', 'totalTransferencias', 'totalOtrosMedios',
    'ajusteDomiciliosTransferencia', 'ajusteDomiciliosDigitales', 'ajusteDomiciliosEfectivo',
    'efectivoNetoSistema', 'totalSistemaReal', 'montoEsperadoCaja'
  ];
  return campos.some(campo => Number(control?.[campo] || 0) !== 0);
}

function tieneDatosControlCaja(control = {}) {
  return Boolean(control.diaClave) && (
    Boolean(control.aperturaHora) || Boolean(control.cierreHora) ||
    Number(control.aperturaMonto || 0) > 0 || Number(control.cierreMonto || 0) > 0 ||
    tieneResumenGuardadoControl(control)
  );
}

function primeroConValorNumerico(calculado, ...guardados) {
  for (const valor of guardados) {
    if (valor === undefined || valor === null || valor === '') continue;
    const numero = Number(valor);
    if (Number.isFinite(numero) && numero !== 0) return numero;
  }
  return Number(calculado || 0);
}

function obtenerResumenCajaDiaParaControl(diaClave, control = {}) {
  const calculado = calcularResumenCajaDia(diaClave);
  if (!tieneResumenGuardadoControl(control)) return calculado;

  const totalCobrado = primeroConValorNumerico(calculado.totalCobrado, control.totalCobradoClientes, control.totalCobrado, control.totalCobradoDia);
  const totalVentas = primeroConValorNumerico(calculado.totalVentas, control.ventaRealNegocio, control.totalVentasReales, control.totalVentas, control.totalProductosVendidos);
  const totalEfectivo = primeroConValorNumerico(calculado.totalEfectivo, control.totalEfectivo, control.efectivoBrutoSistema, control.efectivoSistema, control.ingresoEfectivo);
  const totalTransferencias = primeroConValorNumerico(calculado.totalTransferencias, control.totalTransferencias, control.totalOtrosMedios, control.transferenciasSistema, control.ingresoDigital);
  const ajusteDomiciliosTransferencia = primeroConValorNumerico(calculado.ajusteDomiciliosTransferencia, control.ajusteDomiciliosTransferencia, control.ajusteDomiciliosDigitales, control.domiciliosTransferencia);
  const efectivoNetoSistema = primeroConValorNumerico(
    calculado.efectivoNetoSistema,
    control.efectivoNetoSistema,
    control.montoEsperadoCaja,
    redondearPago(totalEfectivo - ajusteDomiciliosTransferencia)
  );
  const totalSistemaReal = primeroConValorNumerico(
    calculado.totalSistemaReal,
    control.totalSistemaReal,
    control.cierreRealDia,
    redondearPago(efectivoNetoSistema + totalTransferencias)
  );
  const totalDomiciliosGuardado = primeroConValorNumerico(0, control.totalDomicilios, control.domiciliosTotales, Number(control.ajusteDomiciliosDigitales || 0) + Number(control.ajusteDomiciliosEfectivo || 0));
  const totalCobradoAjustado = totalCobrado || redondearPago(totalVentas + totalDomiciliosGuardado);

  return {
    ...calculado,
    cantidadVentas: primeroConValorNumerico(calculado.cantidadVentas, control.cantidadVentasActivas, control.cantidadVentas),
    totalVentas,
    totalCobrado: totalCobradoAjustado,
    totalEfectivo,
    totalOtrosMedios: totalTransferencias,
    totalTransferencias,
    domicilios: primeroConValorNumerico(calculado.domicilios, control.cantidadDomiciliosActivos, control.domicilios),
    ajusteDomiciliosTransferencia,
    ajusteDomiciliosEfectivo: primeroConValorNumerico(0, control.ajusteDomiciliosEfectivo),
    efectivoBrutoSistema: totalEfectivo,
    efectivoNetoSistema,
    totalSistemaReal,
    montoEsperado: totalSistemaReal,
    montoEsperadoCaja: efectivoNetoSistema
  };
}

function guardarControlCajaEnCache(control = {}) {
  const diaClave = control?.diaClave;
  if (!diaClave) return null;
  controlCajaCache = { ...controlCajaCache, [diaClave]: normalizarControlCaja(control, diaClave) };
  guardarLocalStorageSeguro(CONTROL_CAJA_STORAGE_KEY, controlCajaCache, { critico: true });
  return controlCajaCache[diaClave];
}

function obtenerControlCajaLocal(diaClave) {
  if (!diaClave) return normalizarControlCaja({}, diaClave);
  return normalizarControlCaja(controlCajaCache?.[diaClave] || {}, diaClave);
}

function esErrorPermisoFirestore(error) {
  const codigo = String(error?.code || '');
  const mensaje = String(error?.message || '');
  return codigo.includes('permission-denied') || mensaje.includes('insufficient permissions') || mensaje.includes('Missing or insufficient permissions');
}

function desactivarFirebaseCajaPorPermisos(error) {
  if (!firebaseAuth?.currentUser) {
    console.info('[Firebase C9.8] Se omitió una consulta de controlCaja porque la sesión todavía no estaba autenticada.');
    return;
  }
  controlCajaFirebasePermisosDisponibles = false;
  const emailSesion = String(firebaseAuth.currentUser.email || 'correo no disponible').toLowerCase();
  const projectIdSesion = String(firestoreDb?.app?.options?.projectId || 'sin proyecto');
  if (!controlCajaFirebasePermisosAvisados) {
    controlCajaFirebasePermisosAvisados = true;
    console.warn(
      `Control de caja funcionando temporalmente en modo local. Firestore rechazó controlCaja para ${emailSesion} en ${projectIdSesion}. Publica firestore.rules C9.8.`,
      error
    );
    if (typeof window.notificarSistema === 'function') {
      window.notificarSistema(`Firestore rechazó controlCaja para ${emailSesion}. Publica las reglas C9.8.`, 'error');
    }
  }

  // No se bloquea la caja para toda la sesión. Después de un breve intervalo
  // se vuelve a comprobar automáticamente, útil cuando las reglas se publican
  // mientras el POS permanece abierto.
  setTimeout(() => {
    controlCajaFirebasePermisosDisponibles = true;
    controlCajaFirebasePermisosAvisados = false;
  }, 30000);
}

async function obtenerControlCajaDia(diaClave, forzarRemoto = false) {
  const local = obtenerControlCajaLocal(diaClave);
  if (!forzarRemoto && ((local.aperturaHora || local.cierreHora) || !firestoreDisponible || !firestoreDb)) {
    return local;
  }
  if (!firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser || !controlCajaFirebasePermisosDisponibles) return local;
  try {
    const doc = await firestoreDb.collection("controlCaja").doc(diaClave).get();
    if (doc.exists) {
      controlCajaFirebasePermisosDisponibles = true;
      return guardarControlCajaEnCache({ diaClave, ...doc.data() });
    }
  } catch (error) {
    if (esErrorPermisoFirestore(error)) {
      desactivarFirebaseCajaPorPermisos(error);
    } else {
      console.error("No se pudo consultar el control de caja:", error);
    }
  }
  return local;
}

async function guardarControlCajaDia(diaClave, payload = {}) {
  const controlLocal = normalizarControlCaja({ ...payload, diaClave }, diaClave);
  guardarControlCajaEnCache(controlLocal);

  if (!firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser || !controlCajaFirebasePermisosDisponibles) {
    return controlLocal;
  }

  try {
    const ref = firestoreDb.collection('controlCaja').doc(diaClave);
    let controlSincronizado = controlLocal;

    await firestoreDb.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const remoto = snap.exists ? normalizarControlCaja({ diaClave, ...snap.data() }, diaClave) : null;
      const versionRemota = Number(remoto?.version || 0);
      const timestamp = firebase.firestore.FieldValue.serverTimestamp();

      const limpio = normalizarControlCaja({
        ...controlLocal,
        diaClave,
        version: versionRemota + 1
      }, diaClave);

      delete limpio._syncEstado;
      delete limpio.creadoServidor;
      delete limpio.actualizadoServidor;
      limpio.actualizadoServidor = timestamp;
      if (!remoto) limpio.creadoServidor = timestamp;

      transaction.set(ref, limpio, { merge: Boolean(remoto) });
      controlSincronizado = { ...limpio, version: versionRemota + 1, _syncEstado: 'sincronizado' };
    });

    controlCajaFirebasePermisosDisponibles = true;
    registrarHeartbeatFirebase();
    return guardarControlCajaEnCache(controlSincronizado);
  } catch (error) {
    if (esErrorPermisoFirestore(error)) {
      desactivarFirebaseCajaPorPermisos(error);
    } else {
      console.error('No se pudo guardar el control de caja en Firebase:', error);
    }
    return controlLocal;
  }
}

function obtenerVentasActivasDelDia(diaClave) {
  return filtrarVentasActivas(obtenerVentasNormalizadas().filter(v => v.diaClave === diaClave));
}

function calcularResumenCajaDia(diaClave) {
  const ventasActivas = obtenerVentasActivasDelDia(diaClave);
  const totalVentas = ventasActivas.reduce((acc, venta) => acc + obtenerIngresoRealVenta(venta), 0);
  const totalCobrado = ventasActivas.reduce((acc, venta) => acc + obtenerTotalCobradoVenta(venta), 0);
  const totalEfectivo = ventasActivas.reduce((acc, venta) => acc + obtenerValorPagoPorMedio(venta, "efectivo"), 0);
  const totalOtrosMedios = ventasActivas.reduce((acc, venta) => acc + obtenerTotalOtrosMediosVenta(venta), 0);
  const domicilios = ventasActivas.filter(venta => esPedidoDomicilio(venta)).length;

  // Domicilios cubiertos por medios digitales: este dinero no debe quedar como utilidad
  // y, operativamente, se descuenta del efectivo esperado en caja cuando se paga al domiciliario.
  const ajusteDomiciliosTransferencia = redondearPago(
    ventasActivas.reduce((acc, venta) => acc + obtenerValorDomicilioCubiertoPorTransferencia(venta), 0)
  );

  const efectivoBrutoSistema = redondearPago(totalEfectivo);
  const efectivoNetoSistema = redondearPago(efectivoBrutoSistema - ajusteDomiciliosTransferencia);
  const totalTransferencias = redondearPago(totalOtrosMedios);
  const totalSistemaReal = redondearPago(efectivoNetoSistema + totalTransferencias);

  return {
    cantidadVentas: ventasActivas.length,
    totalVentas,
    totalCobrado,
    totalEfectivo: efectivoBrutoSistema,
    totalOtrosMedios: totalTransferencias,
    totalTransferencias,
    domicilios,
    ajusteDomiciliosTransferencia,
    efectivoBrutoSistema,
    efectivoNetoSistema,
    totalSistemaReal,
    montoEsperado: totalSistemaReal,
    montoEsperadoCaja: efectivoNetoSistema
  };
}

function actualizarTarjetasEstadoCaja(control = {}, resumen = {}) {
  const cards = [
    {
      label: 'Hoy',
      value: control.diaClave || obtenerFechaLocalISO(new Date()),
      extra: `${resumen.cantidadVentas || 0} pedidos · ${resumen.domicilios || 0} domicilios`,
      tone: 'bg-white border-yellow-200 text-gray-800'
    },
    {
      label: 'Apertura',
      value: control.aperturaHora ? formatearCOP(control.aperturaMonto) : 'Pendiente',
      extra: control.aperturaHora ? `${formatearFechaHoraColombia(control.aperturaHora)} · ${control.aperturaUsuario || 'Sin usuario'}` : 'Sin registro todavía',
      tone: control.aperturaHora ? 'bg-white border-green-200 text-green-700' : 'bg-white border-gray-200 text-gray-700'
    },
    {
      label: 'Cierre',
      value: control.cierreHora ? formatearCOP(control.cierreMonto) : 'Pendiente',
      extra: control.cierreHora ? `${formatearFechaHoraColombia(control.cierreHora)} · ${control.cierreUsuario || 'Sin usuario'}` : 'Sin registro todavía',
      tone: control.cierreHora ? 'bg-white border-blue-200 text-blue-700' : 'bg-white border-gray-200 text-gray-700'
    }
  ];
  const contenedor = document.getElementById('controlCajaEstadoActual');
  if (!contenedor) return;
  contenedor.innerHTML = cards.map(card => `
    <div class="rounded-2xl border p-3 ${card.tone}">
      <p class="text-xs font-semibold uppercase tracking-wide opacity-70">${card.label}</p>
      <p class="text-lg font-extrabold mt-1">${card.value}</p>
      <p class="text-xs mt-1 opacity-80">${card.extra}</p>
    </div>
  `).join('');
}

async function renderControlCajaDiaActual(forzarRemoto = false) {
  const diaClave = obtenerFechaLocalISO(new Date());
  const control = await obtenerControlCajaDia(diaClave, forzarRemoto);
  const resumen = calcularResumenCajaDia(diaClave);
  const esperado = Number(control.aperturaMonto || 0) + Number(resumen.efectivoNetoSistema || 0);
  const cierreRealDia = Number(resumen.totalSistemaReal || 0);
  const tieneCierre = tieneCierreRegistradoControl(control);
  const diferencia = tieneCierre ? Number(control.cierreMonto || 0) - esperado : 0;

  const aperturaEstadoTexto = document.getElementById('aperturaCajaEstadoTexto');
  const cierreEstadoTexto = document.getElementById('cierreCajaEstadoTexto');
  const dineroEsperadoResumenTexto = document.getElementById('dineroEsperadoResumenTexto');
  const desgloseCierreResumenTexto = document.getElementById('desgloseCierreResumenTexto');
  const aperturaInfoModal = document.getElementById('aperturaCajaInfoModal');
  const btnApertura = document.getElementById('btnRegistrarAperturaCaja');
  const inputApertura = document.getElementById('aperturaCajaMonto');
  const editandoOtraFecha = Boolean(cierreCajaEdicionDiaClave && cierreCajaEdicionDiaClave !== diaClave);

  if (aperturaEstadoTexto) {
    aperturaEstadoTexto.textContent = control.aperturaHora
      ? `Registrada: ${formatearCOP(control.aperturaMonto)}`
      : 'Haz clic para registrar apertura';
  }
  if (cierreEstadoTexto) {
    cierreEstadoTexto.textContent = tieneCierre
      ? `Registrado: ${formatearCOP(control.cierreMonto)}`
      : 'Haz clic para registrar cierre';
  }
  if (dineroEsperadoResumenTexto) {
    dineroEsperadoResumenTexto.textContent = `${formatearCOP(cierreRealDia)} real del día · caja esperada ${formatearCOP(esperado)} · ${tieneCierre ? `diferencia ${formatearCOP(diferencia)}` : 'ver detalle completo'}`;
  }

  if (desgloseCierreResumenTexto) {
    desgloseCierreResumenTexto.textContent = tieneCierre
      ? `Cierre contado ${formatearCOP(control.cierreMonto)} · diferencia ${formatearCOP(diferencia)}`
      : `Caja esperada ${formatearCOP(esperado)} · cierre pendiente`;
  }

  if (aperturaInfoModal) aperturaInfoModal.textContent = control.aperturaHora
    ? `Registrada el ${formatearFechaHoraColombia(control.aperturaHora)} por ${control.aperturaUsuario || 'Sin usuario'}`
    : 'Aún no registrada para hoy.';

  if (btnApertura) btnApertura.textContent = control.aperturaHora ? 'Actualizar apertura' : 'Guardar apertura';
  if (inputApertura && document.activeElement !== inputApertura) inputApertura.value = control.aperturaMonto ? String(control.aperturaMonto) : '';

  if (!editandoOtraFecha) {
    aplicarEstadoModalCierreCaja(control, diaClave, false);
  }

  renderContenidoModalDineroEsperado(control, resumen);
  renderContenidoModalDesgloseCierre(control, resumen);
  actualizarTarjetasEstadoCaja(control, resumen);
}

function limpiarEstadoEdicionCierreCaja() {
  cierreCajaEdicionDiaClave = "";
}

function obtenerDiaObjetivoCierreCaja() {
  return cierreCajaEdicionDiaClave || obtenerFechaLocalISO(new Date());
}

function aplicarEstadoModalCierreCaja(control = {}, diaClave = "", esEdicionHistorica = false) {
  const titulo = document.getElementById('tituloModalCierreCaja');
  const cierreInfoModal = document.getElementById('cierreCajaInfoModal');
  const btnCierre = document.getElementById('btnRegistrarCierreCaja');
  const btnEliminarCierreActual = document.getElementById('btnEliminarCierreCajaActual');
  const inputCierre = document.getElementById('cierreCajaMonto');
  const inputObs = document.getElementById('cierreCajaObservaciones');
  const tieneCierre = tieneCierreRegistradoControl(control);

  if (titulo) {
    titulo.textContent = esEdicionHistorica ? `Editar cierre de ${diaClave}` : 'Cierre de caja';
  }
  if (cierreInfoModal) {
    if (tieneCierre) {
      const detalleFecha = esEdicionHistorica ? `del ${diaClave}` : 'de hoy';
      cierreInfoModal.textContent = `Registrado ${detalleFecha} el ${(control.cierreHora ? formatearFechaHoraColombia(control.cierreHora) : 'fecha no registrada')} por ${control.cierreUsuario || 'Sin usuario'}`;
    } else {
      cierreInfoModal.textContent = esEdicionHistorica ? `Aún no hay cierre registrado para ${diaClave}.` : 'Aún no registrado para hoy.';
    }
  }
  if (btnCierre) {
    btnCierre.textContent = tieneCierre ? (esEdicionHistorica ? 'Guardar cambios' : 'Actualizar cierre') : 'Guardar cierre';
  }
  if (btnEliminarCierreActual) {
    const mostrar = esAdmin() && tieneCierre;
    btnEliminarCierreActual.classList.toggle('hidden', !mostrar);
    btnEliminarCierreActual.style.display = mostrar ? '' : 'none';
    btnEliminarCierreActual.textContent = esEdicionHistorica ? `🗑️ Borrar cierre ${diaClave}` : '🗑️ Borrar cierre de hoy';
  }
  if (inputCierre && document.activeElement !== inputCierre) inputCierre.value = control.cierreMonto ? String(control.cierreMonto) : '';
  if (inputObs && document.activeElement !== inputObs) inputObs.value = control.cierreObservaciones || '';
}

async function abrirModalEditarCierreCaja(diaClave) {
  if (!esAdmin()) return;
  if (!diaClave) return;
  const control = await obtenerControlCajaDia(diaClave, true);
  if (!tieneCierreRegistradoControl(control)) {
    alert('Ese día todavía no tiene cierre físico registrado. Puedes verlo en Desglose o registrar el cierre desde el botón principal.');
    return;
  }
  cierreCajaEdicionDiaClave = diaClave;
  aplicarEstadoModalCierreCaja(control, diaClave, true);
  abrirModalCaja('modalCierreCaja');
}

async function manejarEliminarDesdeModalCierreCaja() {
  const diaClave = obtenerDiaObjetivoCierreCaja();
  if (!diaClave) return;
  await eliminarCierreCaja(diaClave);
  cerrarModalCaja('modalCierreCaja');
}

function abrirModalCaja(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');
}

function cerrarModalCaja(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('hidden');
  if (id === 'modalCierreCaja') {
    limpiarEstadoEdicionCierreCaja();
  }
  if (!["modalAperturaCaja", "modalCierreCaja", "modalDineroEsperado", "modalDesgloseCierre", "modalPagoMixto"].some(modalId => !document.getElementById(modalId)?.classList.contains('hidden'))) {
    document.body.classList.remove('overflow-hidden');
  }
}

async function abrirModalAperturaCaja() {
  if (!verificarAcceso(["admin", "cajero"])) return;
  await renderControlCajaDiaActual(true);
  abrirModalCaja('modalAperturaCaja');
}

async function abrirModalCierreCaja() {
  if (!verificarAcceso(["admin", "cajero"])) return;
  limpiarEstadoEdicionCierreCaja();
  await renderControlCajaDiaActual(true);
  abrirModalCaja('modalCierreCaja');
}

async function abrirModalDineroEsperado() {
  if (!verificarAcceso(["admin", "cajero"])) return;
  await renderControlCajaDiaActual(true);
  abrirModalCaja('modalDineroEsperado');
}

async function abrirModalDesgloseCierre() {
  if (!verificarAcceso(["admin", "cajero"])) return;
  await renderControlCajaDiaActual(true);
  abrirModalCaja('modalDesgloseCierre');
}

async function abrirModalDesgloseCierreDia(diaClave) {
  if (!verificarAcceso(["admin"])) return;
  const dia = String(diaClave || '').trim();
  if (!dia) return alert('No se encontró la fecha del cierre.');

  const control = await obtenerControlCajaDia(dia, true);
  const resumen = obtenerResumenCajaDiaParaControl(dia, control);

  renderContenidoModalDesgloseCierre(control, resumen, { origen: 'historico' });
  abrirModalCaja('modalDesgloseCierre');
}

function renderContenidoModalDineroEsperado(control = {}, resumen = {}) {
  const contenedor = document.getElementById('contenidoModalDineroEsperado');
  if (!contenedor) return;
  const esperado = Number(control.aperturaMonto || 0) + Number(resumen.efectivoNetoSistema || 0);
  const cierreRealDia = Number(resumen.totalSistemaReal || 0);
  const tieneCierre = tieneCierreRegistradoControl(control);
  const diferencia = tieneCierre ? Number(control.cierreMonto || 0) - esperado : 0;
  contenedor.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
      <div class="rounded-xl border border-blue-100 bg-blue-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Apertura</p>
        <p class="text-xl font-extrabold text-gray-800 mt-1">${control.aperturaHora ? formatearCOP(control.aperturaMonto) : 'Sin registro'}</p>
        <p class="text-xs text-gray-500 mt-1">${control.aperturaHora ? `${formatearFechaHoraColombia(control.aperturaHora)} · ${control.aperturaUsuario || 'Sin usuario'}` : 'Primero registra la apertura'}</p>
      </div>
      <div class="rounded-xl border border-blue-100 bg-blue-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Efectivo del día</p>
        <p class="text-xl font-extrabold text-gray-800 mt-1">${formatearCOP(resumen.totalEfectivo || 0)}</p>
        <p class="text-xs text-gray-500 mt-1">Incluye ventas en efectivo y la parte en efectivo de pagos mixtos</p>
      </div>
      <div class="rounded-xl border border-amber-100 bg-amber-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Transferencias del día</p>
        <p class="text-xl font-extrabold text-amber-700 mt-1">${formatearCOP(resumen.totalTransferencias || 0)}</p>
        <p class="text-xs text-gray-500 mt-1">QR, Bre-B, daviplata, nequi y la parte no en efectivo de pagos mixtos</p>
      </div>
      <div class="rounded-xl border border-red-100 bg-red-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Domicilios pagados por transferencia</p>
        <p class="text-xl font-extrabold text-red-700 mt-1">${formatearCOP(resumen.ajusteDomiciliosTransferencia || 0)}</p>
        <p class="text-xs text-gray-500 mt-1">Se descuenta del efectivo esperado en caja</p>
      </div>
      <div class="rounded-xl border border-green-100 bg-green-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Cierre real del día</p>
        <p class="text-xl font-extrabold text-green-700 mt-1">${formatearCOP(cierreRealDia)}</p>
        <p class="text-xs text-gray-500 mt-1">Efectivo neto + transferencias</p>
      </div>
      <div class="rounded-xl border ${tieneCierre ? (diferencia === 0 ? 'border-green-100 bg-green-50' : 'border-red-100 bg-red-50') : 'border-gray-200 bg-gray-50'} p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Diferencia en caja</p>
        <p class="text-xl font-extrabold mt-1 ${tieneCierre ? (diferencia === 0 ? 'text-green-700' : 'text-red-700') : 'text-gray-700'}">${tieneCierre ? formatearCOP(diferencia) : 'Pendiente'}</p>
        <p class="text-xs text-gray-500 mt-1">${tieneCierre ? `Comparado contra la caja esperada · cierre por ${control.cierreUsuario || 'Sin usuario'}` : 'Se calcula cuando registres el cierre físico de caja'}</p>
      </div>
    </div>
    <div class="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 space-y-1">
      <p><strong>Ventas activas del día:</strong> ${resumen.cantidadVentas || 0}</p>
      <p><strong>Domicilios del día:</strong> ${resumen.domicilios || 0}</p>
      <p><strong>Total vendido activo:</strong> ${formatearCOP(resumen.totalVentas || 0)} <span class="text-xs text-gray-500">(solo productos)</span></p>
      <p><strong>Total cobrado real:</strong> ${formatearCOP(resumen.totalCobrado || 0)} <span class="text-xs text-gray-500">(productos + domicilios)</span></p>
      <p><strong>Caja esperada:</strong> ${formatearCOP(esperado)} <span class="text-xs text-gray-500">(apertura + efectivo recibido - domicilios por transferencia)</span></p>
      <p><strong>Efectivo neto esperado:</strong> ${formatearCOP(resumen.efectivoNetoSistema || 0)} <span class="text-xs text-gray-500">(efectivo recibido - domicilios por transferencia)</span></p>
      <p><strong>Cierre real del día:</strong> ${formatearCOP(cierreRealDia)} <span class="text-xs text-gray-500">(efectivo + transferencias - domicilios por transferencia)</span></p>
      ${control.cierreObservaciones ? `<p class="mt-2"><strong>Observaciones del cierre:</strong> ${control.cierreObservaciones}</p>` : ''}
    </div>
  `;
}


function renderContenidoModalDesgloseCierre(control = {}, resumen = {}) {
  const contenedor = document.getElementById('contenidoModalDesgloseCierre');
  if (!contenedor) return;

  const diaAnalizado = control.diaClave || obtenerFechaLocalISO(new Date());
  const esDiaActual = diaAnalizado === obtenerFechaLocalISO(new Date());
  const apertura = Number(control.aperturaMonto || 0);
  const efectivoBruto = Number(resumen.totalEfectivo || resumen.efectivoBrutoSistema || 0);
  const transferencias = Number(resumen.totalTransferencias || 0);
  const domiciliosTransferencia = Number(resumen.ajusteDomiciliosTransferencia || 0);
  const efectivoNeto = Number(resumen.efectivoNetoSistema || 0);
  const ventaRealNegocio = Number(resumen.totalVentas || 0);
  const totalCobradoClientes = Number(resumen.totalCobrado || 0);
  const cajaEsperada = redondearPago(apertura + efectivoNeto);
  const cierreContado = Number(control.cierreMonto || 0);
  const cierreRealDia = Number(resumen.totalSistemaReal || 0);
  const tieneCierre = tieneCierreRegistradoControl(control);
  const diferencia = tieneCierre ? redondearPago(cierreContado - cajaEsperada) : 0;
  const totalDomicilios = redondearPago(Math.max(0, totalCobradoClientes - ventaRealNegocio));
  const domiciliosEfectivo = redondearPago(Math.max(0, totalDomicilios - domiciliosTransferencia));

  let estadoDiferencia = {
    titulo: 'Cierre pendiente',
    detalle: 'Registra el monto contado al final del día para comparar la caja física contra lo esperado por el software.',
    clase: 'border-gray-200 bg-gray-50 text-gray-700'
  };
  if (tieneCierre) {
    if (diferencia === 0) {
      estadoDiferencia = {
        titulo: 'Caja cuadrada',
        detalle: 'El dinero contado coincide exactamente con la caja esperada según las ventas registradas.',
        clase: 'border-green-200 bg-green-50 text-green-800'
      };
    } else if (diferencia > 0) {
      estadoDiferencia = {
        titulo: 'Sobra dinero en caja',
        detalle: `Hay ${formatearCOP(diferencia)} por encima de lo esperado. Revisa pagos no registrados, cambio inicial o movimientos manuales.`,
        clase: 'border-amber-200 bg-amber-50 text-amber-800'
      };
    } else {
      estadoDiferencia = {
        titulo: 'Falta dinero en caja',
        detalle: `Faltan ${formatearCOP(Math.abs(diferencia))} frente a lo esperado. Revisa domicilios pagados, ventas en efectivo, cambios o retiros no registrados.`,
        clase: 'border-red-200 bg-red-50 text-red-800'
      };
    }
  }

  const filaConciliacion = (concepto, operacion, valor, nota = '', resaltado = '') => `
    <tr class="${resaltado}">
      <td class="p-3 border text-gray-700 font-semibold">${concepto}</td>
      <td class="p-3 border text-center text-gray-500 font-bold">${operacion}</td>
      <td class="p-3 border text-right font-extrabold text-gray-800">${formatearCOP(valor)}</td>
      <td class="p-3 border text-xs text-gray-500">${nota}</td>
    </tr>
  `;

  contenedor.innerHTML = `
    <div class="mb-4 rounded-2xl border border-slate-200 bg-white p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
      <div>
        <p class="text-xs uppercase tracking-wide text-slate-500 font-bold">Día analizado</p>
        <p class="text-xl font-black text-slate-800 mt-1">${diaAnalizado}</p>
        <p class="text-xs text-slate-500 mt-1">${esDiaActual ? 'Desglose del cierre actual' : 'Desglose histórico abierto desde la tabla de cierres'}</p>
      </div>
      <div class="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        <strong>Comparación:</strong> cierre contado vs. caja esperada por el software.
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
      <div class="rounded-2xl border border-yellow-100 bg-yellow-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Venta real del negocio</p>
        <p class="text-2xl font-black text-gray-800 mt-1">${formatearCOP(ventaRealNegocio)}</p>
        <p class="text-xs text-gray-500 mt-1">Solo productos. No incluye domicilio.</p>
      </div>
      <div class="rounded-2xl border border-blue-100 bg-blue-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Caja esperada física</p>
        <p class="text-2xl font-black text-blue-800 mt-1">${formatearCOP(cajaEsperada)}</p>
        <p class="text-xs text-gray-500 mt-1">Apertura + efectivo neto del día.</p>
      </div>
      <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Cierre contado</p>
        <p class="text-2xl font-black text-slate-800 mt-1">${tieneCierre ? formatearCOP(cierreContado) : 'Pendiente'}</p>
        <p class="text-xs text-gray-500 mt-1">Valor registrado al contar la caja.</p>
      </div>
      <div class="rounded-2xl border ${estadoDiferencia.clase} p-4">
        <p class="text-xs uppercase tracking-wide font-bold opacity-80">Resultado</p>
        <p class="text-xl font-black mt-1">${tieneCierre ? formatearCOP(diferencia) : 'Pendiente'}</p>
        <p class="text-xs mt-1">${estadoDiferencia.titulo}</p>
      </div>
    </div>

    <div class="mt-5 rounded-2xl border ${estadoDiferencia.clase} p-4">
      <p class="font-extrabold">${estadoDiferencia.titulo}</p>
      <p class="text-sm mt-1">${estadoDiferencia.detalle}</p>
    </div>

    <div class="mt-5 rounded-2xl border border-emerald-200 overflow-hidden bg-white">
      <div class="px-4 py-3 bg-emerald-50 border-b border-emerald-200">
        <h4 class="font-extrabold text-emerald-900">1. Cálculo de venta real del negocio</h4>
        <p class="text-xs text-emerald-800 mt-1">Aquí se ve claramente cómo el sistema resta los domicilios del total cobrado para dejar solo la venta real de productos.</p>
      </div>
      <div class="overflow-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-slate-100 text-gray-600">
            <tr>
              <th class="p-3 border text-left">Concepto</th>
              <th class="p-3 border text-center">Operación</th>
              <th class="p-3 border text-right">Valor</th>
              <th class="p-3 border text-left">Explicación</th>
            </tr>
          </thead>
          <tbody>
            ${filaConciliacion('Total cobrado a clientes', '+', totalCobradoClientes, 'Todo el dinero cobrado en el día: productos + domicilios. No todo es utilidad.')}
            ${filaConciliacion('Domicilios cobrados', '-', totalDomicilios, 'Valor de envíos. Este dinero no pertenece a la ganancia del negocio.')}
            ${filaConciliacion('Venta real del negocio', '=', ventaRealNegocio, 'Resultado real de productos vendidos. Este es el dato correcto para medir ventas/utilidad bruta.', 'bg-emerald-50')}
          </tbody>
        </table>
      </div>
      <div class="px-4 py-3 bg-white border-t border-emerald-100 text-sm text-gray-700">
        <strong>Fórmula:</strong> ${formatearCOP(totalCobradoClientes)} total cobrado - ${formatearCOP(totalDomicilios)} domicilios = <strong>${formatearCOP(ventaRealNegocio)} venta real</strong>.
      </div>
    </div>

    <div class="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="rounded-2xl border border-gray-200 overflow-hidden bg-white">
        <div class="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h4 class="font-extrabold text-gray-800">2. Conciliación de caja física</h4>
          <p class="text-xs text-gray-500 mt-1">Esto responde cuánto dinero debería existir físicamente en la caja al cerrar.</p>
        </div>
        <div class="overflow-auto">
          <table class="min-w-full text-sm">
            <thead class="bg-slate-100 text-gray-600">
              <tr>
                <th class="p-3 border text-left">Concepto</th>
                <th class="p-3 border text-center">Operación</th>
                <th class="p-3 border text-right">Valor</th>
                <th class="p-3 border text-left">Explicación</th>
              </tr>
            </thead>
            <tbody>
              ${filaConciliacion('Apertura de caja', '+', apertura, 'Base inicial registrada antes de vender.')}
              ${filaConciliacion('Efectivo recibido por ventas', '+', efectivoBruto, 'Dinero que entró en efectivo, incluyendo pagos mixtos.')}
              ${filaConciliacion('Domicilios pagados por transferencia', '-', domiciliosTransferencia, 'Se descuenta porque entró digital, pero normalmente se paga al domiciliario desde caja.')}
              ${filaConciliacion('Caja esperada al cierre', '=', cajaEsperada, 'Este es el efectivo que debería aparecer al contar la caja.', 'bg-blue-50')}
              ${tieneCierre ? filaConciliacion('Cierre contado registrado', '↔', cierreContado, 'Monto físico que se ingresó al cerrar la caja.', 'bg-slate-50') : ''}
              ${tieneCierre ? filaConciliacion('Diferencia final', '=', diferencia, 'Cierre contado menos caja esperada.', diferencia === 0 ? 'bg-green-50' : (diferencia > 0 ? 'bg-amber-50' : 'bg-red-50')) : ''}
            </tbody>
          </table>
        </div>
      </div>

      <div class="rounded-2xl border border-gray-200 overflow-hidden bg-white">
        <div class="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h4 class="font-extrabold text-gray-800">3. Lectura operativa del día</h4>
          <p class="text-xs text-gray-500 mt-1">Separa venta real, medios de pago y domicilios para no confundir utilidad con dinero recibido.</p>
        </div>
        <div class="p-4 space-y-3 text-sm">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="rounded-xl border border-yellow-100 bg-yellow-50 p-3">
              <p class="text-xs uppercase tracking-wide text-gray-500">Pedidos activos</p>
              <p class="text-lg font-black text-gray-800">${resumen.cantidadVentas || 0}</p>
            </div>
            <div class="rounded-xl border border-yellow-100 bg-yellow-50 p-3">
              <p class="text-xs uppercase tracking-wide text-gray-500">Domicilios activos</p>
              <p class="text-lg font-black text-gray-800">${resumen.domicilios || 0}</p>
            </div>
            <div class="rounded-xl border border-green-100 bg-green-50 p-3">
              <p class="text-xs uppercase tracking-wide text-gray-500">Efectivo neto esperado</p>
              <p class="text-lg font-black text-green-800">${formatearCOP(efectivoNeto)}</p>
            </div>
            <div class="rounded-xl border border-amber-100 bg-amber-50 p-3">
              <p class="text-xs uppercase tracking-wide text-gray-500">Transferencias recibidas</p>
              <p class="text-lg font-black text-amber-800">${formatearCOP(transferencias)}</p>
            </div>
          </div>

          <div class="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-2">
            <p><strong>Total cobrado a clientes:</strong> ${formatearCOP(totalCobradoClientes)} <span class="text-xs text-gray-500">(productos + domicilios)</span></p>
            <p><strong>Menos domicilios totales:</strong> ${formatearCOP(totalDomicilios)} <span class="text-xs text-gray-500">(se excluyen de la venta real)</span></p>
            <p><strong>Venta real del negocio:</strong> ${formatearCOP(ventaRealNegocio)} <span class="text-xs text-gray-500">(total cobrado - domicilios)</span></p>
            <hr class="border-gray-200">
            <p><strong>Domicilios por transferencia:</strong> ${formatearCOP(domiciliosTransferencia)} <span class="text-xs text-gray-500">(se descuentan del efectivo esperado en caja)</span></p>
            <p><strong>Domicilios en efectivo:</strong> ${formatearCOP(domiciliosEfectivo)} <span class="text-xs text-gray-500">(no se suman como venta real; solo explican dinero recibido)</span></p>
            <p><strong>Cierre real operativo:</strong> ${formatearCOP(cierreRealDia)} <span class="text-xs text-gray-500">(efectivo neto + transferencias)</span></p>
          </div>
        </div>
      </div>
    </div>

    <div class="mt-5 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
      <p class="font-extrabold">Regla aplicada para Señor Arepa</p>
      <p class="mt-1">El domicilio nunca se cuenta como utilidad. Primero se calcula la venta real así: total cobrado a clientes menos domicilios. Luego se calcula la caja física así: apertura + efectivo recibido - domicilios pagados por transferencia. Si el domicilio entra en efectivo, no aumenta la venta real; solo queda reflejado dentro del efectivo recibido.</p>
    </div>

    ${control.cierreObservaciones ? `<div class="mt-5 rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-700"><strong>Observaciones del cierre:</strong> ${control.cierreObservaciones}</div>` : ''}
  `;
}

async function obtenerTodosLosControlesCaja(forzarRemoto = false) {
  if (forzarRemoto && firestoreDisponible && firestoreDb && firebaseAuth?.currentUser) {
    controlCajaFirebasePermisosDisponibles = true;
    try {
      const snapshot = await firestoreDb.collection('controlCaja').get();
      controlCajaFirebasePermisosDisponibles = true;
      snapshot.forEach(doc => guardarControlCajaEnCache({ diaClave: doc.id, ...doc.data() }));
    } catch (error) {
      if (esErrorPermisoFirestore(error)) {
        desactivarFirebaseCajaPorPermisos(error);
      } else {
        console.error('No se pudo actualizar la lista de cierres desde Firebase:', error);
      }
    }
  }
  return Object.entries(controlCajaCache || {})
    .map(([diaClaveCache, control]) => normalizarControlCaja(control, control?.diaClave || diaClaveCache))
    .filter(control => tieneDatosControlCaja(control))
    .sort((a, b) => String(b.diaClave).localeCompare(String(a.diaClave)));
}

async function renderTablaCierresCaja(forzarRemoto = false) {
  const controles = await obtenerTodosLosControlesCaja(forzarRemoto);
  const cierres = controles.filter(control => tieneDatosControlCaja(control));
  const filas = cierres.map(control => {
    const resumen = obtenerResumenCajaDiaParaControl(control.diaClave, control);
    const esperado = Number(control.aperturaMonto || 0) + Number(resumen.efectivoNetoSistema || 0);
    const cierreRealDia = Number(resumen.totalSistemaReal || 0);
    const transferencias = Number(resumen.totalTransferencias || 0);
    const domiciliosDescontados = Number(resumen.ajusteDomiciliosTransferencia || 0);
    const tieneCierre = tieneCierreRegistradoControl(control);
    const diferencia = tieneCierre ? Number(control.cierreMonto || 0) - esperado : 0;
    const claseDiferencia = !tieneCierre ? 'text-gray-500' : (diferencia === 0 ? 'text-green-700' : 'text-red-700');
    const botonDesglose = `<button type="button" title="Ver desglose profesional de ${control.diaClave}" onclick="abrirModalDesgloseCierreDia('${control.diaClave}')" class="inline-flex items-center gap-1 bg-slate-800 hover:bg-slate-900 text-white px-3 py-1 rounded-lg font-semibold text-xs">📊 Desglose</button>`;
    const accionesAdmin = esAdmin()
      ? `<button type="button" onclick="abrirModalEditarCierreCaja('${control.diaClave}')" class="bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-1 rounded-lg font-semibold text-xs">✏️ Editar</button><button type="button" onclick="eliminarCierreCaja('${control.diaClave}')" class="bg-red-100 hover:bg-red-200 text-red-700 px-3 py-1 rounded-lg font-semibold text-xs">🗑️ Borrar cierre</button>`
      : '';
    const acciones = `<div class="flex flex-wrap items-center justify-center gap-2">${botonDesglose}${accionesAdmin}</div>`;
    return `
      <tr>
        <td class="p-2 border">${control.diaClave}</td>
        <td class="p-2 border">${control.aperturaHora || Number(control.aperturaMonto || 0) > 0 ? formatearCOP(control.aperturaMonto) : '<span class="text-gray-400">Sin apertura</span>'}</td>
        <td class="p-2 border">${tieneCierre ? formatearCOP(control.cierreMonto) : '<span class="text-gray-400">Sin cierre físico</span>'}</td>
        <td class="p-2 border">${formatearCOP(resumen.totalEfectivo || 0)}<div class="text-[11px] text-gray-500 mt-1">Solo efectivo del sistema</div></td>
        <td class="p-2 border">${formatearCOP(transferencias)}<div class="text-[11px] text-gray-500 mt-1">Sección aparte de transferencias</div></td>
        <td class="p-2 border text-red-700 font-semibold">${formatearCOP(domiciliosDescontados)}<div class="text-[11px] text-gray-500 mt-1">Restado por domicilios en transferencia</div></td>
        <td class="p-2 border">${formatearCOP(esperado)}<div class="text-[11px] text-gray-500 mt-1">Apertura + efectivo - domicilios transferencia</div></td>
        <td class="p-2 border text-green-700 font-semibold">${formatearCOP(cierreRealDia)}<div class="text-[11px] text-gray-500 mt-1">Efectivo + transferencias - domicilios</div></td>
        <td class="p-2 border font-semibold ${claseDiferencia}">${tieneCierre ? formatearCOP(diferencia) : 'Pendiente'}</td>
        <td class="p-2 border">${control.aperturaUsuario || '-'}</td>
        <td class="p-2 border">${control.cierreUsuario || (tieneCierre ? '-' : 'Pendiente')}</td>
        <td class="p-2 border text-center">${acciones}</td>
      </tr>
    `;
  });

  renderFilasPaginadas({
    clave: 'cierresCaja',
    bodyId: 'cierresCajaBody',
    filas,
    colspan: 12,
    etiquetaVacia: 'No hay registros de caja guardados todavía.',
    infoId: 'infoPaginacionCierresCaja',
    pageId: 'paginaCierresCajaActual',
    prevId: 'btnPrevCierresCaja',
    nextId: 'btnNextCierresCaja'
  });
}

async function registrarAperturaCaja() {
  if (!verificarAcceso(["admin", "cajero"])) return;
  const input = document.getElementById('aperturaCajaMonto');
  const monto = Number(input?.value || 0);
  if (!Number.isFinite(monto) || monto < 0) {
    alert('Ingresa un monto válido para la apertura.');
    return;
  }
  const diaClave = obtenerFechaLocalISO(new Date());
  const actual = await obtenerControlCajaDia(diaClave, true);
  await guardarControlCajaDia(diaClave, {
    ...actual,
    aperturaMonto: monto,
    aperturaHora: new Date().toISOString(),
    aperturaUsuario: usuarioActual || ''
  });
  alert('Apertura de caja registrada.');
  cerrarModalCaja('modalAperturaCaja');
  await renderControlCajaDiaActual();
  const filtro = document.getElementById('filtroHistoricoFecha');
  if (filtro && filtro.value === diaClave) await renderResumenCajaFecha(diaClave, true);
  renderTablaCierresCaja(true);
}

async function registrarCierreCaja() {
  const editandoHistorico = Boolean(cierreCajaEdicionDiaClave);
  if (editandoHistorico) {
    if (!esAdmin()) return;
  } else {
    if (!verificarAcceso(["admin", "cajero"])) return;
  }
  const diaClave = obtenerDiaObjetivoCierreCaja();
  const actual = await obtenerControlCajaDia(diaClave, true);
  if (!actual.aperturaHora) {
    alert('Primero registra la apertura de caja de esa fecha.');
    return;
  }
  const monto = Number(document.getElementById('cierreCajaMonto')?.value || 0);
  const observaciones = String(document.getElementById('cierreCajaObservaciones')?.value || '').trim();
  if (!Number.isFinite(monto) || monto < 0) {
    alert('Ingresa un monto válido para el cierre.');
    return;
  }
  await guardarControlCajaDia(diaClave, {
    ...actual,
    cierreMonto: monto,
    cierreHora: new Date().toISOString(),
    cierreUsuario: usuarioActual || '',
    cierreObservaciones: observaciones
  });
  alert(editandoHistorico ? `Cierre de caja actualizado para ${diaClave}.` : 'Cierre de caja registrado.');
  cerrarModalCaja('modalCierreCaja');
  await renderControlCajaDiaActual();
  const filtro = document.getElementById('filtroHistoricoFecha');
  if (filtro && filtro.value === diaClave) await renderResumenCajaFecha(diaClave, true);
  renderTablaCierresCaja(true);
}

async function eliminarCierreCaja(diaClave) {
  if (!verificarAcceso(["admin"])) return;
  if (!diaClave) return;
  const confirmar = confirm(`¿Seguro que quieres borrar el cierre de caja del día ${diaClave}? Se conservará la apertura.`);
  if (!confirmar) return;
  const actual = await obtenerControlCajaDia(diaClave, true);
  if (!tieneCierreRegistradoControl(actual)) {
    alert('Ese día no tiene un cierre físico registrado.');
    return;
  }
  await guardarControlCajaDia(diaClave, {
    ...actual,
    cierreMonto: 0,
    cierreHora: '',
    cierreUsuario: '',
    cierreObservaciones: ''
  });
  alert('Cierre de caja eliminado correctamente.');
  const diaActual = obtenerFechaLocalISO(new Date());
  if (diaClave === diaActual) {
    await renderControlCajaDiaActual(true);
  }
  const filtro = document.getElementById('filtroHistoricoFecha');
  if (filtro && filtro.value === diaClave) await renderResumenCajaFecha(diaClave, true);
  renderTablaCierresCaja(true);
}

async function eliminarCierreCajaActual() {
  await manejarEliminarDesdeModalCierreCaja();
}

async function renderResumenCajaFecha(diaClave, forzarRemoto = false) {
  const contenedor = document.getElementById('resumenCajaFechaSeleccionada');
  if (!contenedor) return;
  const control = await obtenerControlCajaDia(diaClave, forzarRemoto);
  const resumen = calcularResumenCajaDia(diaClave);
  const esperado = Number(control.aperturaMonto || 0) + Number(resumen.efectivoNetoSistema || 0);
  const cierreRealDia = Number(resumen.totalSistemaReal || 0);
  const diferencia = control.cierreHora ? Number(control.cierreMonto || 0) - esperado : 0;
  contenedor.innerHTML = `
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-3">
      <div>
        <p class="text-xs uppercase tracking-wide text-yellow-700 font-bold">Caja de la fecha consultada</p>
        <h5 class="text-base font-extrabold text-gray-800">${diaClave}</h5>
      </div>
      <div class="text-sm ${control.cierreHora ? (diferencia === 0 ? 'text-green-700' : 'text-red-700') : 'text-gray-600'}">
        ${control.cierreHora ? `<strong>Diferencia:</strong> ${formatearCOP(diferencia)}` : 'Cierre pendiente'}
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
      <div class="rounded-xl border border-yellow-100 bg-yellow-50 p-3">
        <p class="text-xs uppercase tracking-wide text-gray-500">Apertura</p>
        <p class="text-lg font-extrabold text-gray-800 mt-1">${control.aperturaHora ? formatearCOP(control.aperturaMonto) : 'Sin registro'}</p>
        <p class="text-xs text-gray-500 mt-1">${control.aperturaHora ? `${formatearFechaHoraColombia(control.aperturaHora)} · ${control.aperturaUsuario || 'Sin usuario'}` : 'No registrada'}</p>
      </div>
      <div class="rounded-xl border border-yellow-100 bg-yellow-50 p-3">
        <p class="text-xs uppercase tracking-wide text-gray-500">Cierre</p>
        <p class="text-lg font-extrabold text-gray-800 mt-1">${control.cierreHora ? formatearCOP(control.cierreMonto) : 'Sin registro'}</p>
        <p class="text-xs text-gray-500 mt-1">${control.cierreHora ? `${formatearFechaHoraColombia(control.cierreHora)} · ${control.cierreUsuario || 'Sin usuario'}` : 'No registrado'}</p>
      </div>
      <div class="rounded-xl border border-yellow-100 bg-yellow-50 p-3">
        <p class="text-xs uppercase tracking-wide text-gray-500">Efectivo recibido</p>
        <p class="text-lg font-extrabold text-gray-800 mt-1">${formatearCOP(resumen.totalEfectivo || 0)}</p>
        <p class="text-xs text-gray-500 mt-1">${resumen.cantidadVentas} venta(s) activas con dinero real en caja</p>
      </div>
      <div class="rounded-xl border border-amber-100 bg-amber-50 p-3">
        <p class="text-xs uppercase tracking-wide text-gray-500">Transferencias del día</p>
        <p class="text-lg font-extrabold text-amber-700 mt-1">${formatearCOP(resumen.totalTransferencias || 0)}</p>
        <p class="text-xs text-gray-500 mt-1">Pagos fuera de caja, incluidos los mixtos</p>
      </div>
      <div class="rounded-xl border border-red-100 bg-red-50 p-3">
        <p class="text-xs uppercase tracking-wide text-gray-500">Domicilios por transferencia</p>
        <p class="text-lg font-extrabold text-red-700 mt-1">${formatearCOP(resumen.ajusteDomiciliosTransferencia || 0)}</p>
        <p class="text-xs text-gray-500 mt-1">Se descuenta del efectivo esperado en caja</p>
      </div>
      <div class="rounded-xl border border-green-100 bg-green-50 p-3">
        <p class="text-xs uppercase tracking-wide text-gray-500">Cierre real del día</p>
        <p class="text-lg font-extrabold text-green-700 mt-1">${formatearCOP(cierreRealDia)}</p>
        <p class="text-xs text-gray-500 mt-1">Efectivo + transferencias - domicilios por transferencia</p>
      </div>
      <div class="rounded-xl border border-yellow-100 bg-yellow-50 p-3">
        <p class="text-xs uppercase tracking-wide text-gray-500">Caja esperada</p>
        <p class="text-lg font-extrabold text-gray-800 mt-1">${formatearCOP(esperado)}</p>
        <p class="text-xs text-gray-500 mt-1">Apertura + efectivo - domicilios por transferencia</p>
      </div>
    </div>
    ${control.cierreObservaciones ? `<p class="mt-3 text-sm text-gray-600"><strong>Observaciones:</strong> ${control.cierreObservaciones}</p>` : ''}
  `;
}

function actualizarIndicadorFirebase(estado, detalle = "") {
  firebaseConexionEstado = estado;
  const dot = document.getElementById("firebaseStatusDot");
  const text = document.getElementById("firebaseStatusText");
  const sub = document.getElementById("firebaseStatusSubtext");
  if (!dot || !text || !sub) return;

  const estados = {
    conectado: {
      dot: "inline-flex w-3 h-3 rounded-full bg-green-500",
      textClass: "font-bold text-green-600",
      text: "Conectado",
      sub: detalle || "Base de datos sincronizada con Firebase"
    },
    verificando: {
      dot: "inline-flex w-3 h-3 rounded-full bg-yellow-400 animate-pulse",
      textClass: "font-bold text-yellow-600",
      text: "Verificando",
      sub: detalle || "Validando conexión con Firebase"
    },
    desconectado: {
      dot: "inline-flex w-3 h-3 rounded-full bg-red-500",
      textClass: "font-bold text-red-600",
      text: "Desconectado",
      sub: detalle || "Sin conexión con Firebase"
    }
  };

  const conf = estados[estado] || estados.desconectado;
  dot.className = conf.dot;
  text.className = conf.textClass;
  text.textContent = conf.text;
  sub.textContent = conf.sub;
}

function registrarHeartbeatFirebase() {
  ultimoHeartbeatFirebase = Date.now();
  if (firebaseConexionEstado !== "conectado") {
    actualizarIndicadorFirebase("conectado", "Base de datos sincronizada con Firebase");
  }
}

function iniciarMonitorConexionFirebase() {
  if (monitorFirebaseInterval) return;
  monitorFirebaseInterval = setInterval(() => {
    if (!navigator.onLine) {
      actualizarIndicadorFirebase("desconectado", "Sin conexión a internet");
      return;
    }
    if (!firestoreDisponible || !firestoreDb) {
      actualizarIndicadorFirebase("desconectado", "Firebase no está inicializado");
      return;
    }
    if (!ultimoHeartbeatFirebase) {
      actualizarIndicadorFirebase("verificando", "Esperando respuesta de Firebase");
      return;
    }
    const segundosSinRespuesta = (Date.now() - ultimoHeartbeatFirebase) / 1000;
    if (segundosSinRespuesta > 20) {
      actualizarIndicadorFirebase("desconectado", "Firebase no responde en este momento");
    }
  }, 5000);
}

function programarMigracionAlmacenamientoC98() {
  const ejecutar = () => {
    try {
      migrarAlmacenamientoLocalC95();
    } catch (error) {
      console.warn('[Señor Arepa C9.8] La migración local se omitió sin bloquear el sistema:', error);
    }
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(ejecutar);
  else setTimeout(ejecutar, 0);
}

programarMigracionAlmacenamientoC98();

window.addEventListener("online", () => {
  actualizarIndicadorFirebase("verificando", "Reconectando con Firebase...");
  setTimeout(async () => {
    await reconectarFirestoreSeguro('evento-online');
    if (!firebaseAuth?.currentUser) return;
    const diagnostico = await diagnosticarConexionFirebaseC98({ silencioso: true });
    if (diagnostico.rest && diagnostico.sdk) {
      firestoreDisponible = true;
      actualizarIndicadorFirebase('conectado', 'Firebase conectado');
      try { escucharVentasFirestore(); } catch (_) {}
      try { escucharInventarioFirestore(); } catch (_) {}
      try { escucharCatalogoFirestore(); } catch (_) {}
      try { programarSyncVentasPendientes(100); } catch (_) {}
    } else {
      firestoreDisponible = false;
      actualizarIndicadorFirebase('desconectado', diagnostico.rest
        ? 'Canal Firestore bloqueado por red o antivirus'
        : 'Firestore no responde');
    }
  }, 500);
});

window.addEventListener("offline", () => {
  actualizarIndicadorFirebase("desconectado", "Sin conexión a internet");
});

const FIREBASE_PROJECT_ID_AUTORIZADO = "prsenorarepa";
const FIREBASE_APP_NAME_AUTORIZADA = "senorArepaPOS_prsenorarepa";

const firebaseConfig = {
  apiKey: "AIzaSyDxrAJcH5AAxIAK2rRWD61aSQklaH--dT0",
  authDomain: "prsenorarepa.firebaseapp.com",
  projectId: "prsenorarepa",
  storageBucket: "prsenorarepa.firebasestorage.app",
  messagingSenderId: "55349021122",
  appId: "1:55349021122:web:e4c65b2f2911bd2c4eee5b",
  measurementId: "G-8JGY4PVMMV"
};

let firestoreAjustesRedAplicados = false;
let firestoreReconectando = false;
let ultimoReinicioRedFirestore = 0;

function configurarFirestoreRedRobusta(db) {
  if (!db || firestoreAjustesRedAplicados) return db;
  try {
    db.settings({
      experimentalAutoDetectLongPolling: false,
      experimentalForceLongPolling: true,
      experimentalLongPollingOptions: { timeoutSeconds: 25 },
      ignoreUndefinedProperties: true,
      merge: true
    });
    firestoreAjustesRedAplicados = true;
    console.info('[Firebase C9.8] Transporte robusto activado (long polling).');
  } catch (error) {
    const mensaje = String(error?.message || error || '');
    if (/already been started|settings can no longer be changed|failed-precondition/i.test(mensaje)) {
      console.warn('[Firebase C9.8] Firestore ya estaba iniciado; se conservaron sus ajustes actuales.');
    } else {
      console.warn('[Firebase C9.8] No fue posible aplicar los ajustes de red:', error);
    }
  }
  return db;
}

async function reconectarFirestoreSeguro(motivo = 'manual') {
  const ahora = Date.now();
  if (
    firestoreReconectando ||
    !firestoreDb ||
    !firebaseAuth?.currentUser ||
    !navigator.onLine ||
    ahora - ultimoReinicioRedFirestore < 12000
  ) return false;

  firestoreReconectando = true;
  ultimoReinicioRedFirestore = ahora;
  try {
    actualizarIndicadorFirebase('verificando', 'Restableciendo conexión con Firebase...');
    await firestoreDb.disableNetwork();
    await new Promise(resolve => setTimeout(resolve, 450));
    await firestoreDb.enableNetwork();
    registrarHeartbeatFirebase();
    console.info(`[Firebase C9.8] Conexión restablecida (${motivo}).`);
    return true;
  } catch (error) {
    console.warn(`[Firebase C9.8] No se pudo restablecer la conexión (${motivo}):`, error);
    return false;
  } finally {
    firestoreReconectando = false;
  }
}

window.reconectarFirestoreSeguro = reconectarFirestoreSeguro;

async function diagnosticarConexionFirebaseC98(opciones = {}) {
  const silencioso = Boolean(opciones.silencioso);
  const resultado = {
    version: '2026.08.04-C9.8',
    projectId: firebaseConfig.projectId,
    online: navigator.onLine !== false,
    auth: false,
    email: '',
    rest: false,
    restStatus: null,
    restDocumentExists: null,
    sdk: false,
    sdkDocumentExists: null,
    sdkError: '',
    restError: ''
  };

  try {
    const user = firebaseAuth?.currentUser || null;
    resultado.auth = Boolean(user);
    resultado.email = String(user?.email || '');
    if (!user) throw new Error('No existe una sesión autenticada en Firebase.');

    const token = await user.getIdToken(false);
    const uid = String(user.uid || '');
    const projectId = String(firebaseConfig.projectId || '');
    const databaseRoot = `projects/${projectId}/databases/(default)`;
    const documentName = `${databaseRoot}/documents/usuarios/${uid}`;
    const url = `https://firestore.googleapis.com/v1/${databaseRoot}/documents:batchGet?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      // batchGet responde HTTP 200 incluso cuando el documento aún no existe.
      // De esta manera el diagnóstico comprueba conexión y permisos sin generar
      // un 404 engañoso en la consola del navegador.
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ documents: [documentName] }),
        cache: 'no-store',
        signal: controller.signal
      });
      resultado.restStatus = response.status;
      const body = await response.text().catch(() => '');
      resultado.rest = response.ok;
      if (response.ok) {
        resultado.restDocumentExists = body.includes('"found"');
      } else {
        resultado.restError = body.slice(0, 500) || `HTTP ${response.status}`;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (firestoreDb) {
      const sdkTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo agotado en Firestore SDK.')), 12000));
      const snapshot = await Promise.race([
        firestoreDb.collection('usuarios').doc(uid).get({ source: 'server' }),
        sdkTimeout
      ]);
      resultado.sdk = true;
      resultado.sdkDocumentExists = Boolean(snapshot?.exists);
    }
  } catch (error) {
    const message = String(error?.message || error || 'Error desconocido');
    if (!resultado.rest) resultado.restError = resultado.restError || message;
    if (!resultado.sdk) resultado.sdkError = message;
  }

  if (!silencioso) {
    console.table(resultado);
    if (resultado.rest && resultado.sdk) {
      console.info('[Firebase C9.8] Conexión completa verificada.',
        resultado.sdkDocumentExists === false
          ? 'El documento de perfil del usuario todavía no existe, pero esto no impide la conexión.'
          : '');
    } else if (resultado.rest && !resultado.sdk) {
      console.error('[Firebase C9.8] Firebase responde por REST, pero el canal del SDK está bloqueado por red, antivirus, proxy o extensión.', resultado);
    } else {
      console.error('[Firebase C9.8] No se pudo verificar Firestore.', resultado);
    }
  }
  return resultado;
}
window.diagnosticarConexionFirebaseC98 = diagnosticarConexionFirebaseC98;
// Alias para accesos directos creados en versiones anteriores.
window.diagnosticarConexionFirebaseC97 = diagnosticarConexionFirebaseC98;
window.diagnosticarConexionFirebaseC96 = diagnosticarConexionFirebaseC98;

/**
 * Fuerza al POS a utilizar exclusivamente el proyecto prsenorarepa.
 * Elimina aplicaciones Firebase activas de otros proyectos, crea una
 * aplicación con nombre propio y valida Auth y Firestore antes de continuar.
 */
async function obtenerFirebaseAppAutorizada() {
  if (!window.firebase) {
    throw new Error("SDK de Firebase no disponible");
  }

  const aplicaciones = Array.isArray(firebase.apps) ? [...firebase.apps] : [];

  for (const appExistente of aplicaciones) {
    const proyectoExistente = String(appExistente?.options?.projectId || "");

    if (proyectoExistente && proyectoExistente !== FIREBASE_PROJECT_ID_AUTORIZADO) {
      console.warn(
        `[Seguridad Firebase] Eliminando conexión no autorizada al proyecto ${proyectoExistente}.`
      );

      try {
        await appExistente.delete();
      } catch (error) {
        console.error(
          `[Seguridad Firebase] No fue posible eliminar la app del proyecto ${proyectoExistente}:`,
          error
        );
        throw new Error(
          `Se detectó una conexión Firebase no autorizada a ${proyectoExistente}.`
        );
      }
    }
  }

  let appAutorizada = firebase.apps.find(
    app => app.name === FIREBASE_APP_NAME_AUTORIZADA
  );

  if (!appAutorizada) {
    appAutorizada = firebase.initializeApp(
      firebaseConfig,
      FIREBASE_APP_NAME_AUTORIZADA
    );
  }

  const proyectoActivo = String(appAutorizada?.options?.projectId || "");

  if (proyectoActivo !== FIREBASE_PROJECT_ID_AUTORIZADO) {
    throw new Error(
      `Proyecto Firebase incorrecto: se esperaba ${FIREBASE_PROJECT_ID_AUTORIZADO} y se encontró ${proyectoActivo || "ninguno"}.`
    );
  }

  return appAutorizada;
}

function validarServiciosFirebaseAutorizados() {
  const proyectosActivos = [
    firebaseApp?.options?.projectId,
    firebaseAuth?.app?.options?.projectId,
    firestoreDb?.app?.options?.projectId
  ].filter(Boolean);

  const proyectosNoAutorizados = proyectosActivos.filter(
    projectId => projectId !== FIREBASE_PROJECT_ID_AUTORIZADO
  );

  if (proyectosNoAutorizados.length) {
    firestoreDisponible = false;
    authDisponible = false;
    throw new Error(
      `Conexión bloqueada: se detectó un proyecto no autorizado (${[...new Set(proyectosNoAutorizados)].join(", ")}).`
    );
  }

  if (
    proyectosActivos.length < 3 ||
    proyectosActivos.some(projectId => projectId !== FIREBASE_PROJECT_ID_AUTORIZADO)
  ) {
    throw new Error("No fue posible validar el proyecto Firebase autorizado.");
  }

  console.info(
    `[Señor Arepa POS] Firebase bloqueado exclusivamente a ${FIREBASE_PROJECT_ID_AUTORIZADO}.`
  );

  return true;
}


function resolverRegistroUsuario(entradaUsuario = "") {
  const valor = String(entradaUsuario || "").trim().toLowerCase();
  if (!valor) return null;
  if (usuariosSistema[valor]) return { usuario: valor, ...usuariosSistema[valor] };
  if (usuariosPorEmail[valor]) return usuariosPorEmail[valor];
  return null;
}

function resolverEmailIngreso(entradaUsuario = "") {
  const valor = String(entradaUsuario || "").trim();
  const registro = resolverRegistroUsuario(valor);
  if (registro?.email) return registro.email;
  if (valor.includes('@')) return valor;
  return null;
}

function aplicarSesionAutenticada(usuario, rol, email) {
  usuarioActual = usuario || "";
  rolActual = rol || "";
  sesionActiva = Boolean(usuarioActual && rolActual);
  guardarLocalStorageSeguro('usuarioActual', usuarioActual, { critico: false });
  guardarLocalStorageSeguro('rolActual', rolActual, { critico: false });
  guardarLocalStorageSeguro('sesionActiva', String(sesionActiva), { critico: false });
  guardarLocalStorageSeguro('usuarioEmailActual', email || '', { critico: false });
  aplicarPermisosPorRol();
}

function limpiarSesionLocal() {
  rolActual = "";
  usuarioActual = "";
  sesionActiva = false;
  localStorage.removeItem("rolActual");
  localStorage.removeItem("usuarioActual");
  localStorage.removeItem("usuarioEmailActual");
  guardarLocalStorageSeguro('sesionActiva', 'false', { critico: false });
  aplicarPermisosPorRol();
}

function normalizarVenta(venta = {}) {
  const copia = JSON.parse(JSON.stringify(venta));
  copia.estado = obtenerEstadoVenta(copia);
  copia.pedido = Array.isArray(copia.pedido)
    ? copia.pedido.map(p => ({ nombre: p.nombre, precio: Number(p.precio || 0) }))
    : [];
  const subtotalCalculado = copia.pedido.reduce((acc, p) => acc + Number(p.precio || 0), 0);
  const subtotalBase = subtotalCalculado > 0
    ? subtotalCalculado
    : Number(copia.subtotalProductos ?? copia.total ?? 0);
  copia.subtotalProductos = Number.isFinite(subtotalBase) && subtotalBase >= 0 ? subtotalBase : 0;
  copia.costoDomicilio = Number(copia.costoDomicilio || 0);
  const numeroDomicilio = Number(copia.numeroDomicilio || 0);
  copia.numeroDomicilio = Number.isFinite(numeroDomicilio) && numeroDomicilio > 0 ? numeroDomicilio : null;
  copia.totalCobrado = redondearPago(Number(copia.totalCobrado || 0) || (copia.subtotalProductos + copia.costoDomicilio));
  copia.detallePagos = normalizarDetallePagos(copia.detallePagos || copia.pagos || [], copia.totalCobrado);
  if (!copia.detallePagos.length) copia.detallePagos = crearDetallePagoSimple(copia.formaPago, copia.totalCobrado);
  copia._localId = String(copia._localId || copia._docId || '').trim() || null;
  copia._syncEstado = copia._syncEstado === 'pendiente' ? 'pendiente' : 'sincronizado';
  copia.total = copia.subtotalProductos;
  return copia;
}


const MEDIOS_PAGO_DISPONIBLES = [
  { value: "QR Señor arepa", label: "QR Señor arepa" },
  { value: "QR Señora arepa", label: "QR Señora arepa" },
  { value: "Bre-B", label: "Bre-B" },
  { value: "daviplata", label: "daviplata" },
  { value: "nequi", label: "nequi" },
  { value: "efectivo", label: "efectivo" }
];
let detallePagoMixtoActual = [];

function redondearPago(valor) {
  const numero = Number(valor || 0);
  if (!Number.isFinite(numero)) return 0;
  return Math.round(numero * 100) / 100;
}

function obtenerTotalCobradoVenta(venta = {}) {
  return redondearPago(obtenerIngresoRealVenta(venta) + obtenerValorDomicilio(venta));
}

function crearDetallePagoSimple(medio = "", valor = 0) {
  const medioLimpio = String(medio || "").trim();
  const monto = redondearPago(valor);
  if (!medioLimpio || monto <= 0) return [];
  return [{ medio: medioLimpio, valor: monto }];
}

function normalizarDetallePagos(detalle = [], totalEsperado = 0) {
  if (!Array.isArray(detalle)) return [];
  const permitidos = new Set(MEDIOS_PAGO_DISPONIBLES.map(item => item.value));
  const acumulado = new Map();
  detalle.forEach(item => {
    const medio = String(item?.medio || item?.metodo || item?.formaPago || "").trim();
    const valor = redondearPago(item?.valor);
    if (!permitidos.has(medio) || valor <= 0) return;
    acumulado.set(medio, redondearPago((acumulado.get(medio) || 0) + valor));
  });
  let salida = Array.from(acumulado.entries()).map(([medio, valor]) => ({ medio, valor }));
  const esperado = redondearPago(totalEsperado);
  const suma = redondearPago(salida.reduce((acc, item) => acc + item.valor, 0));
  if (esperado > 0 && salida.length && Math.abs(suma - esperado) <= 1) {
    const diferencia = redondearPago(esperado - suma);
    if (Math.abs(diferencia) > 0) {
      salida[salida.length - 1].valor = redondearPago(salida[salida.length - 1].valor + diferencia);
    }
  }
  return salida.filter(item => item.valor > 0);
}

function obtenerDetallePagosVenta(venta = {}) {
  const totalCobrado = obtenerTotalCobradoVenta(venta);
  const detalleNormalizado = normalizarDetallePagos(venta?.detallePagos || venta?.pagos || [], totalCobrado);
  if (detalleNormalizado.length) return detalleNormalizado;
  return crearDetallePagoSimple(venta?.formaPago, totalCobrado);
}

function obtenerValorPagoPorMedio(venta = {}, medio = "") {
  const medioLimpio = String(medio || "").trim().toLowerCase();
  return redondearPago(obtenerDetallePagosVenta(venta)
    .filter(item => String(item.medio || "").trim().toLowerCase() === medioLimpio)
    .reduce((acc, item) => acc + Number(item.valor || 0), 0));
}

function obtenerTotalOtrosMediosVenta(venta = {}) {
  return redondearPago(obtenerDetallePagosVenta(venta)
    .filter(item => String(item.medio || "").trim().toLowerCase() !== "efectivo")
    .reduce((acc, item) => acc + Number(item.valor || 0), 0));
}

function obtenerValorDomicilioCubiertoPorTransferencia(venta = {}) {
  const valorDomicilio = obtenerValorDomicilio(venta);
  if (valorDomicilio <= 0) return 0;
  const totalTransferido = obtenerTotalOtrosMediosVenta(venta);
  return redondearPago(Math.min(valorDomicilio, totalTransferido));
}

function obtenerValorDomicilioCubiertoPorEfectivo(venta = {}) {
  const valorDomicilio = obtenerValorDomicilio(venta);
  if (valorDomicilio <= 0) return 0;
  return redondearPago(Math.max(0, valorDomicilio - obtenerValorDomicilioCubiertoPorTransferencia(venta)));
}

function esPagoMixto(venta = {}) {
  return String(venta?.formaPago || "").trim().toLowerCase() === "mixto" || obtenerDetallePagosVenta(venta).length > 1;
}

function obtenerEtiquetaFormaPago(venta = {}) {
  const detalle = obtenerDetallePagosVenta(venta);
  if (!detalle.length) return venta?.formaPago || "-";
  if (detalle.length === 1) return detalle[0].medio;
  return `mixto · ${detalle.map(item => `${item.medio}: ${formatearCOP(item.valor)}`).join(" + ")}`;
}

function obtenerTotalCobradoActual() {
  return redondearPago(obtenerSubtotalPedidoActual() + obtenerCostoDomicilioActual());
}

function normalizarDetallePagoMixtoActual(totalEsperado = obtenerTotalCobradoActual()) {
  detallePagoMixtoActual = normalizarDetallePagos(detallePagoMixtoActual, totalEsperado);
  return detallePagoMixtoActual;
}

function obtenerMontoAsignadoPagoMixtoActual(totalEsperado = obtenerTotalCobradoActual()) {
  return redondearPago(normalizarDetallePagoMixtoActual(totalEsperado).reduce((acc, item) => acc + Number(item.valor || 0), 0));
}

function obtenerDiferenciaPagoMixtoActual(totalEsperado = obtenerTotalCobradoActual()) {
  return redondearPago(totalEsperado - obtenerMontoAsignadoPagoMixtoActual(totalEsperado));
}

function limpiarTextoMontoConPuntos(valor = "") {
  return String(valor || "").replace(/\D+/g, "");
}

function convertirTextoMontoConPuntosANumero(valor = "") {
  const limpio = limpiarTextoMontoConPuntos(valor);
  return limpio ? Number(limpio) : 0;
}

function formatearTextoMontoConPuntos(valor = "") {
  const numero = convertirTextoMontoConPuntosANumero(valor);
  return numero > 0 ? numero.toLocaleString('es-CO') : "";
}

function aplicarFormatoMontoInput(input) {
  if (!input) return 0;
  const numero = convertirTextoMontoConPuntosANumero(input.value);
  input.value = numero > 0 ? numero.toLocaleString('es-CO') : "";
  return numero;
}

function manejarInputMontoPagoMixto(event) {
  aplicarFormatoMontoInput(event?.target);
  actualizarTotalesModalPagoMixto();
}

function leerDetallePagoMixtoDesdeModal() {
  const detalle = MEDIOS_PAGO_DISPONIBLES.map(item => {
    const input = document.getElementById(`pagoMixto_${item.value}`);
    return { medio: item.value, valor: redondearPago(convertirTextoMontoConPuntosANumero(input?.value || 0)) };
  });
  return normalizarDetallePagos(detalle, obtenerTotalCobradoActual());
}

function renderInputsPagoMixto() {
  const contenedor = document.getElementById("pagoMixtoInputs");
  if (!contenedor) return;
  contenedor.innerHTML = MEDIOS_PAGO_DISPONIBLES.map(item => `
    <label class="rounded-2xl border border-blue-100 bg-white px-4 py-3">
      <span class="block text-sm font-bold text-gray-700 mb-2">${item.label}</span>
      <input type="text" inputmode="numeric" autocomplete="off" id="pagoMixto_${item.value}" data-medio-pago="${item.value}" class="w-full p-3 border border-blue-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400" placeholder="0">
    </label>
  `).join("");
  MEDIOS_PAGO_DISPONIBLES.forEach(item => {
    const input = document.getElementById(`pagoMixto_${item.value}`);
    if (!input) return;
    input.addEventListener("input", manejarInputMontoPagoMixto);
    input.addEventListener("blur", (event) => aplicarFormatoMontoInput(event.target));
  });
}

function poblarModalPagoMixto() {
  const totalEsperado = obtenerTotalCobradoActual();
  const detalle = normalizarDetallePagoMixtoActual(totalEsperado);
  MEDIOS_PAGO_DISPONIBLES.forEach(item => {
    const input = document.getElementById(`pagoMixto_${item.value}`);
    if (!input) return;
    const encontrado = detalle.find(det => det.medio === item.value);
    input.value = encontrado?.valor ? formatearTextoMontoConPuntos(encontrado.valor) : "";
  });
  actualizarTotalesModalPagoMixto();
}

function actualizarTotalesModalPagoMixto() {
  const totalEsperado = obtenerTotalCobradoActual();
  const detalle = leerDetallePagoMixtoDesdeModal();
  const asignado = redondearPago(detalle.reduce((acc, item) => acc + Number(item.valor || 0), 0));
  const diferencia = redondearPago(totalEsperado - asignado);
  const totalEl = document.getElementById("pagoMixtoTotal");
  const asignadoEl = document.getElementById("pagoMixtoAsignado");
  const diferenciaEl = document.getElementById("pagoMixtoDiferencia");
  if (totalEl) totalEl.textContent = formatearCOP(totalEsperado);
  if (asignadoEl) asignadoEl.textContent = formatearCOP(asignado);
  if (diferenciaEl) {
    diferenciaEl.textContent = formatearCOP(Math.abs(diferencia));
    diferenciaEl.className = `text-xl font-extrabold mt-1 ${Math.abs(diferencia) < 0.01 ? "text-green-700" : "text-amber-700"}`;
  }
}

function actualizarResumenPagoMixtoUI() {
  const formaPago = document.getElementById("formaPago")?.value || "";
  const bloque = document.getElementById("bloquePagoMixtoResumen");
  const texto = document.getElementById("textoPagoMixtoResumen");
  if (!bloque || !texto) return;
  const esMixto = formaPago === "mixto";
  bloque.classList.toggle("hidden", !esMixto);
  if (!esMixto) return;
  const totalEsperado = obtenerTotalCobradoActual();
  const detalle = normalizarDetallePagoMixtoActual(totalEsperado);
  const asignado = redondearPago(detalle.reduce((acc, item) => acc + Number(item.valor || 0), 0));
  const diferencia = redondearPago(totalEsperado - asignado);
  if (!detalle.length) {
    texto.textContent = "Configura cómo se reparte el pago entre los medios disponibles.";
    return;
  }
  const resumen = detalle.map(item => `${item.medio}: ${formatearCOP(item.valor)}`).join(" + ");
  texto.textContent = Math.abs(diferencia) < 0.01
    ? `${resumen} · total configurado correctamente`
    : `${resumen} · faltan/ sobran ${formatearCOP(Math.abs(diferencia))} para completar el total`;
}

function abrirModalPagoMixto() {
  if ((document.getElementById("formaPago")?.value || "") !== "mixto") return;
  renderInputsPagoMixto();
  poblarModalPagoMixto();
  abrirModalCaja("modalPagoMixto");
}

function cerrarModalPagoMixto() {
  cerrarModalCaja("modalPagoMixto");
}

function confirmarPagoMixto() {
  const totalEsperado = obtenerTotalCobradoActual();
  const detalle = leerDetallePagoMixtoDesdeModal();
  const asignado = redondearPago(detalle.reduce((acc, item) => acc + Number(item.valor || 0), 0));
  const diferencia = redondearPago(totalEsperado - asignado);
  if (!detalle.length) {
    alert("Ingresa al menos un valor en los medios de pago.");
    return;
  }
  if (Math.abs(diferencia) >= 0.01) {
    alert("La suma del pago mixto debe coincidir exactamente con el total a cobrar.");
    return;
  }
  detallePagoMixtoActual = detalle;
  actualizarResumenPagoMixtoUI();
  cerrarModalPagoMixto();
}

function limpiarPagoMixtoActual() {
  detallePagoMixtoActual = [];
  MEDIOS_PAGO_DISPONIBLES.forEach(item => {
    const input = document.getElementById(`pagoMixto_${item.value}`);
    if (input) input.value = "";
  });
  actualizarTotalesModalPagoMixto();
  actualizarResumenPagoMixtoUI();
}

function manejarCambioFormaPago() {
  const formaPago = document.getElementById("formaPago")?.value || "";
  if (formaPago !== "mixto") {
    detallePagoMixtoActual = [];
    actualizarResumenPagoMixtoUI();
    return;
  }
  actualizarResumenPagoMixtoUI();
  abrirModalPagoMixto();
}

function construirDetallePagosVentaDesdeFormulario(formaPago, totalCobrado) {
  if (String(formaPago || "").trim().toLowerCase() !== "mixto") {
    return crearDetallePagoSimple(formaPago, totalCobrado);
  }
  return normalizarDetallePagoMixtoActual(totalCobrado);
}

function guardarVentasEnCache(ventas) {
  ventasCache = Array.isArray(ventas) ? ventas.map(normalizarVenta) : [];
  const cachePersistente = podarVentasParaCacheLocal(ventasCache);
  guardarLocalStorageSeguro('ventas', cachePersistente, { critico: true });
  return ventasCache;
}

function obtenerVentasStorage() {
  return Array.isArray(ventasCache) ? ventasCache.map(normalizarVenta) : [];
}

function generarIdVentaLocal() {
  return `venta_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function obtenerVentasPendientesSync() {
  try {
    const data = JSON.parse(localStorage.getItem(VENTAS_PENDIENTES_SYNC_KEY) || '[]');
    return Array.isArray(data) ? data.map(item => ({
      venta: normalizarVenta(item?.venta || {}),
      ajustesInventario: item?.ajustesInventario || {}
    })) : [];
  } catch (error) {
    console.error("No se pudieron leer las ventas pendientes de sincronización:", error);
    return [];
  }
}

function guardarVentasPendientesSync(items = []) {
  const lista = (Array.isArray(items) ? items : []).map(item => ({
    venta: normalizarVenta(item?.venta || {}),
    ajustesInventario: item?.ajustesInventario || {},
    operacionId: item?.operacionId || '',
    tipo: item?.tipo || 'create',
    intentos: Number(item?.intentos || 0),
    ultimoError: String(item?.ultimoError || '')
  }));
  guardarLocalStorageSeguro(VENTAS_PENDIENTES_SYNC_KEY, lista, { critico: true });
  return lista;
}

function guardarVentaPendienteSync(venta, ajustesInventario = {}) {
  const pendiente = { venta: normalizarVenta(venta), ajustesInventario: ajustesInventario || {} };
  const lista = obtenerVentasPendientesSync();
  const clave = pendiente.venta._localId || pendiente.venta._docId;
  const index = lista.findIndex(item => (item.venta._localId || item.venta._docId) === clave);
  if (index >= 0) lista[index] = pendiente;
  else lista.push(pendiente);
  guardarVentasPendientesSync(lista);
}

function quitarVentaPendienteSync(localId = "") {
  const clave = String(localId || "").trim();
  if (!clave) return;
  const lista = obtenerVentasPendientesSync().filter(item => (item.venta._localId || item.venta._docId) !== clave);
  guardarVentasPendientesSync(lista);
}

function upsertVentaEnCacheLocal(venta) {
  const ventaLista = normalizarVenta(venta);
  const ventas = obtenerVentasStorage();
  const index = ventas.findIndex(item =>
    (ventaLista._docId && item._docId === ventaLista._docId) ||
    (ventaLista._localId && item._localId === ventaLista._localId)
  );
  if (index >= 0) ventas[index] = { ...ventas[index], ...ventaLista };
  else ventas.push(ventaLista);
  guardarVentasEnCache(ordenarVentasDesc(ventas));
  return ventaLista;
}

function fusionarVentasRemotasConPendientes(ventasRemotas = []) {
  const remotas = Array.isArray(ventasRemotas) ? ventasRemotas.map(normalizarVenta) : [];
  const pendientes = obtenerVentasPendientesSync().map(item => normalizarVenta(item.venta));
  if (!pendientes.length) return remotas;

  const clavesRemotas = new Set();
  remotas.forEach(venta => {
    if (venta._docId) clavesRemotas.add(`doc:${venta._docId}`);
    if (venta._localId) clavesRemotas.add(`local:${venta._localId}`);
  });

  const extras = pendientes.filter(venta => {
    const claveDoc = venta._docId ? `doc:${venta._docId}` : "";
    const claveLocal = venta._localId ? `local:${venta._localId}` : "";
    return !(claveDoc && clavesRemotas.has(claveDoc)) && !(claveLocal && clavesRemotas.has(claveLocal));
  });

  return ordenarVentasDesc([...remotas, ...extras]);
}

function programarSyncVentasPendientes(delay = 200) {
  if (temporizadorSyncVentasPendientes) clearTimeout(temporizadorSyncVentasPendientes);
  temporizadorSyncVentasPendientes = setTimeout(() => {
    temporizadorSyncVentasPendientes = null;
    sincronizarVentasPendientesEnSegundoPlano();
  }, delay);
}

async function sincronizarVentasPendientesEnSegundoPlano() {
  if (sincronizandoVentasPendientes) return;
  if (!firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser) return;

  const pendientes = obtenerVentasPendientesSync();
  if (!pendientes.length) return;

  sincronizandoVentasPendientes = true;
  try {
    for (const item of pendientes) {
      const ventaPendiente = normalizarVenta(item.venta);
      const localId = ventaPendiente._localId || ventaPendiente._docId;
      try {
        const docId = await guardarVentaEnFirebase(ventaPendiente, ventaPendiente._docId || null);
        await aplicarAjustesInventarioFirestore(item.ajustesInventario || {});
        const ventaSincronizada = { ...ventaPendiente, _docId: docId, _syncEstado: 'sincronizado' };
        upsertVentaEnCacheLocal(ventaSincronizada);
        quitarVentaPendienteSync(localId);
        guardarReferenciaUltimaVenta(ventaSincronizada);
      } catch (error) {
        console.error("No se pudo sincronizar una venta pendiente con Firebase:", error);
      }
    }
  } finally {
    sincronizandoVentasPendientes = false;
  }
}

function ordenarVentasDesc(ventas) {
  return [...ventas].sort((a, b) => {
    const fechaA = a.fechaISO || a.fecha || "";
    const fechaB = b.fechaISO || b.fecha || "";
    return String(fechaB).localeCompare(String(fechaA));
  });
}

async function inicializarFirebaseVentas() {
  if (firebaseInicializado) return;
  firebaseInicializado = true;
  actualizarIndicadorFirebase("verificando", "Conectando exclusivamente con prsenorarepa...");
  iniciarMonitorConexionFirebase();
  if (!window.firebase) {
    actualizarIndicadorFirebase("desconectado", "SDK de Firebase no disponible");
    return;
  }
  try {
    firebaseApp = await obtenerFirebaseAppAutorizada();
    firebaseAuth = firebase.auth(firebaseApp);
    firestoreDb = configurarFirestoreRedRobusta(firebase.firestore(firebaseApp));
    validarServiciosFirebaseAutorizados();
    authDisponible = Boolean(firebaseAuth);
    firestoreDisponible = Boolean(firestoreDb);
    firebaseAuth.onAuthStateChanged((user) => {
      if (user) {
        const email = String(user.email || '').toLowerCase();
        const registro = resolverRegistroUsuario(email) || resolverRegistroUsuario(user.displayName || '') || { usuario: email.split('@')[0], rol: 'cajero', nombre: user.displayName || email };
        aplicarSesionAutenticada(registro.usuario || email.split('@')[0], registro.rol || 'cajero', user.email || '');
        escucharVentasFirestore();
        escucharInventarioFirestore();
        escucharCatalogoFirestore();
        programarSyncVentasPendientes(50);
      } else {
        if (typeof ventasUnsubscribe === 'function') {
          ventasUnsubscribe();
          ventasUnsubscribe = null;
        }
        if (typeof inventarioUnsubscribe === 'function') {
          inventarioUnsubscribe();
          inventarioUnsubscribe = null;
        }
        if (typeof catalogoUnsubscribe === 'function') {
          catalogoUnsubscribe();
          catalogoUnsubscribe = null;
        }
        inventarioBebidasEstado = obtenerMapaInventarioLocal();
        actualizarAlertasStockBebidas(inventarioBebidasEstado);
        cargarCatalogoProductos();
        actualizarEstadoCatalogoSync('Catálogo cargado en modo local', 'neutral');
        limpiarSesionLocal();
        guardarVentasEnCache([]);
      }
    });
  } catch (error) {
    console.error("Error al inicializar Firebase:", error);
    firestoreDisponible = false;
    authDisponible = false;
    actualizarIndicadorFirebase("desconectado", "No se pudo iniciar Firebase");
  }
}

function escucharVentasFirestore() {
  if (!firestoreDisponible || !firestoreDb) return;
  if (typeof ventasUnsubscribe === 'function') ventasUnsubscribe();

  let primeraCarga = true;
  ventasUnsubscribe = firestoreDb.collection("ventas")
    .orderBy("fechaISO", "desc")
    .onSnapshot(async (snapshot) => {
      registrarHeartbeatFirebase();
      const ventasRemotas = snapshot.docs.map(doc => normalizarVenta({ _docId: doc.id, ...doc.data() }));
      guardarVentasEnCache(fusionarVentasRemotasConPendientes(ventasRemotas));

      if (primeraCarga && ventasRemotas.length === 0) {
        const pendientes = obtenerVentasPendientesSync();
        const clavesPendientes = new Set(pendientes.map(item => item.venta?._localId).filter(Boolean));
        const ventasLocales = JSON.parse(localStorage.getItem("ventas") || "[]").map(normalizarVenta).filter(venta => !venta._docId && !(venta._localId && clavesPendientes.has(venta._localId)));
        if (ventasLocales.length > 0) {
          await migrarVentasLocalesAFirebase(ventasLocales);
        }
      }

      programarSyncVentasPendientes(50);
      primeraCarga = false;

      mostrarVentas();
      refrescarVistasAnaliticasSiEstanAbiertas();
    }, (error) => {
      console.error("Error al escuchar ventas de Firebase:", error);
      actualizarIndicadorFirebase("desconectado", "Error al sincronizar con Firebase");
    });
}

async function migrarVentasLocalesAFirebase(ventasLocales) {
  if (!firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser || !ventasLocales.length) return;

  for (const venta of ventasLocales) {
    const normalizada = normalizarVenta(venta);
    normalizada._localId = normalizada._localId || generarIdVentaLocal();
    await guardarVentaEnFirebase(normalizada, normalizada._localId);
  }
}

async function guardarVentaEnFirebase(venta, docId = null) {
  if (!firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser) {
    throw new Error('Firebase no está disponible o no existe una sesión autenticada.');
  }

  const limpia = normalizarVenta(venta || {});
  const id = String(docId || limpia._docId || limpia._localId || firestoreDb.collection('ventas').doc().id)
    .replaceAll('/', '_');
  const ref = firestoreDb.collection('ventas').doc(id);
  const emailActual = String(firebaseAuth.currentUser.email || '').toLowerCase();
  const puedeActualizar = ['admin@local.io', 'administrador@local.io'].includes(emailActual);
  const timestamp = firebase.firestore.FieldValue.serverTimestamp();

  await firestoreDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const remoto = snap.exists ? (snap.data() || {}) : null;

    if (remoto && !puedeActualizar) {
      throw new Error('El cajero puede crear ventas, pero no modificar una venta ya sincronizada.');
    }

    const versionRemota = Number(remoto?.version || 0);
    const payload = normalizarVenta({
      ...limpia,
      _localId: limpia._localId || id,
      version: remoto ? versionRemota + 1 : 1
    });

    delete payload._docId;
    delete payload._syncEstado;
    delete payload.creadoServidor;
    delete payload.actualizadoServidor;
    delete payload.fechaServidor;

    payload.actualizadoServidor = timestamp;
    if (!remoto) payload.creadoServidor = timestamp;

    transaction.set(ref, payload, { merge: Boolean(remoto) });
  });

  registrarHeartbeatFirebase();
  return id;
}

async function borrarTodasLasVentasEnFirebase() {
  if (!firestoreDisponible || !firestoreDb) return;
  const snapshot = await firestoreDb.collection("ventas").get();
  for (const doc of snapshot.docs) {
    await doc.ref.delete();
  }
}

async function borrarVentaEnFirebase(docId) {
  if (!firestoreDisponible || !firestoreDb || !docId) return;
  await firestoreDb.collection("ventas").doc(docId).delete();
}

function eliminarVentaDeCacheLocal(venta = {}) {
  const ventasActuales = obtenerVentasStorage();
  const ventasRestantes = ventasActuales.filter(item => {
    const coincideDoc = venta._docId && item._docId === venta._docId;
    const coincideLocal = venta._localId && item._localId === venta._localId;
    return !(coincideDoc || coincideLocal);
  });
  guardarVentasEnCache(ordenarVentasDesc(ventasRestantes));
  return ventasRestantes;
}

function actualizarReferenciaUltimaVentaTrasEliminar() {
  const ventasRestantes = ordenarVentasDesc(obtenerVentasStorage());
  if (ventasRestantes.length) {
    guardarReferenciaUltimaVenta(ventasRestantes[0]);
  } else {
    localStorage.removeItem(ULTIMA_VENTA_GUARDADA_KEY);
  }
}


function toggleVerClave() {
  const input = document.getElementById("loginClave");
  const check = document.getElementById("toggleClave");
  if (!input || !check) return;
  input.type = check.checked ? "text" : "password";
}

async function iniciarSesion() {
  const usuario = document.getElementById("loginUsuario")?.value.trim();
  const clave = document.getElementById("loginClave")?.value || "";
  const error = document.getElementById("loginError");

  if (!usuario || !clave) {
    if (error) {
      error.textContent = "Ingresa usuario/correo y contraseña.";
      error.classList.remove("hidden");
    }
    return;
  }

  if (!authDisponible || !firebaseAuth) {
    if (error) {
      error.textContent = "Firebase Auth aún no está listo. Revisa la conexión.";
      error.classList.remove("hidden");
    }
    return;
  }

  const email = resolverEmailIngreso(usuario);

  try {
    await firebaseAuth.signInWithEmailAndPassword(email, clave);
    if (error) error.classList.add("hidden");
    const campoClave = document.getElementById("loginClave");
    const campoUsuario = document.getElementById("loginUsuario");
    const toggle = document.getElementById("toggleClave");
    if (campoClave) campoClave.value = "";
    if (campoUsuario) campoUsuario.value = "";
    if (toggle) toggle.checked = false;
    toggleVerClave();
  } catch (err) {
    console.error("Error al iniciar sesión con Firebase Auth:", err);
    if (error) {
      error.textContent = "No fue posible iniciar sesión. Verifica el usuario/correo y la contraseña en Firebase Auth.";
      error.classList.remove("hidden");
    }
  }
}

function esAdmin() {
  return rolActual === "admin";
}

function esAdministrador() {
  return rolActual === "administrador";
}

function tieneAccesoGestion() {
  return esAdmin() || esAdministrador();
}

function puedeVerFinanzas() {
  return esAdmin();
}

function esCajero() {
  return rolActual === "cajero";
}

function tieneRolValido() {
  return tieneAccesoGestion() || esCajero();
}

function verificarAcceso(rolesPermitidos) {
  if (!rolesPermitidos.includes(rolActual)) {
    alert("No tienes permiso para realizar esta acción.");
    return false;
  }
  return true;
}

async function cerrarSesionRol() {
  volverAlPOS();
  cerrarMobileMenu();
  document.body.classList.remove('overflow-hidden');
  if (typeof ventasUnsubscribe === 'function') {
    ventasUnsubscribe();
    ventasUnsubscribe = null;
  }
  if (typeof catalogoUnsubscribe === 'function') {
    catalogoUnsubscribe();
    catalogoUnsubscribe = null;
  }
  limpiarSesionLocal();
  actualizarEstadoCatalogoSync('Catálogo cargado en modo local', 'neutral');
  guardarVentasEnCache([]);
  try {
    if (firebaseAuth) {
      await firebaseAuth.signOut();
    }
  } catch (error) {
    console.error("Error al cerrar sesión:", error);
  }
}

function toggleMobileMenu(forceOpen = null) {
  const menu = document.getElementById('mobileHeaderMenu');
  const button = document.getElementById('mobileMenuButton');
  const iconOpen = document.getElementById('mobileMenuIconOpen');
  const iconClose = document.getElementById('mobileMenuIconClose');
  if (!menu || !button) return;

  const willOpen = forceOpen === null ? menu.classList.contains('hidden') : !!forceOpen;
  menu.classList.toggle('hidden', !willOpen);
  button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if (iconOpen) iconOpen.classList.toggle('hidden', willOpen);
  if (iconClose) iconClose.classList.toggle('hidden', !willOpen);
  document.body.classList.toggle('overflow-hidden', willOpen && window.innerWidth < 768);
}

function cerrarMobileMenu() {
  toggleMobileMenu(false);
}

function aplicarPermisosPorRol() {
  const loginScreen = document.getElementById("loginScreen");
  const appContent = document.getElementById("appContent");
  if (loginScreen) loginScreen.classList.toggle("hidden", sesionActiva && tieneRolValido());
  if (appContent) appContent.classList.toggle("hidden", !(sesionActiva && tieneRolValido()));

  const rolLabel = rolActual ? (rolActual === "admin" ? "Admin" : rolActual === "administrador" ? "Administrador" : "Cajero") : "Sin rol";
  ["rolActualTexto", "rolActualTextoDesktop"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = rolLabel;
  });
  ["usuarioActualTexto", "usuarioActualTextoDesktop"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = usuarioActual || "Sin usuario";
  });
  const loginError = document.getElementById("loginError");
  if (loginError && sesionActiva && tieneRolValido()) {
    loginError.classList.add("hidden");
  }

  document.querySelectorAll('[data-role="admin-only"]').forEach(el => {
    el.classList.toggle('hidden', !esAdmin());
    el.style.display = esAdmin() ? '' : 'none';
  });

  document.querySelectorAll('[data-role="gestion-only"]').forEach(el => {
    el.classList.toggle('hidden', !tieneAccesoGestion());
    el.style.display = tieneAccesoGestion() ? '' : 'none';
  });

  document.querySelectorAll('[data-role="finanzas-only"]').forEach(el => {
    el.classList.toggle('hidden', !puedeVerFinanzas());
    el.style.display = puedeVerFinanzas() ? '' : 'none';
  });

  const btnExportarExcel = document.getElementById('btnExportarExcel');
  if (btnExportarExcel) {
    btnExportarExcel.classList.toggle('hidden', !tieneAccesoGestion());
    btnExportarExcel.style.display = tieneAccesoGestion() ? '' : 'none';
  }

  const bloqueado = !tieneRolValido();
  document.querySelectorAll('button, input, select, textarea').forEach(el => {
    if (el.closest('#loginScreen')) return;
    if ((el.textContent || '').includes('Cerrar sesión')) return;

    const requiereAdmin = Boolean(el.closest('[data-role="admin-only"]'));
    const requiereGestion = Boolean(el.closest('[data-role="gestion-only"]'));
    const requiereFinanzas = Boolean(el.closest('[data-role="finanzas-only"]'));
    const sinPermiso = bloqueado
      || (requiereAdmin && !esAdmin())
      || (requiereGestion && !tieneAccesoGestion())
      || (requiereFinanzas && !puedeVerFinanzas());

    if (sinPermiso) {
      // Solo marcamos los controles que este sistema de permisos bloqueó.
      // Así, al iniciar sesión podemos rehabilitarlos sin alterar controles
      // deshabilitados por inventario, paginación o flujo de caja.
      if (!el.disabled) el.dataset.saBloqueadoPorRol = '1';
      el.disabled = true;
      el.classList.add('opacity-50', 'cursor-not-allowed');
      el.setAttribute('aria-disabled', 'true');
      return;
    }

    if (el.dataset.saBloqueadoPorRol === '1') {
      el.disabled = false;
      delete el.dataset.saBloqueadoPorRol;
    }
    if (!el.disabled) {
      el.classList.remove('opacity-50', 'cursor-not-allowed');
      el.removeAttribute('aria-disabled');
    }
  });

  const resumen = document.getElementById('resumenProductos');
  if (resumen && !tieneAccesoGestion()) {
    resumen.classList.add('hidden');
  }

  mostrarVentas();
  actualizarIndicadoresPasoVenta();
  actualizarResumenPasosVenta();
  const historicosVista = document.getElementById("historicosVista");
  if (historicosVista) historicosVista.classList.add("hidden");
  const domiciliosVista = document.getElementById("domiciliosVista");
  if (domiciliosVista) domiciliosVista.classList.add("hidden");

  if (!sesionActiva || !tieneRolValido()) {
    const campoClave = document.getElementById("loginClave");
    const toggle = document.getElementById("toggleClave");
    if (campoClave) campoClave.value = "";
    if (toggle) toggle.checked = false;
    toggleVerClave();
  }
}


  let ventaPasoActual = 1;
  let categoriaProductoActual = 1;

  function esVistaMovil() {
    return window.innerWidth < 768;
  }

  function actualizarCategoriasProducto() {
    const categorias = [
      { id: 'categoriaComida', titulo: '1. Comida', indicador: 'Paso 1 de 3' },
      { id: 'categoriaAdiciones', titulo: '2. Adiciones', indicador: 'Paso 2 de 3' },
      { id: 'categoriaBebidas', titulo: '3. Bebidas', indicador: 'Paso 3 de 3' }
    ];

    const esMovil = esVistaMovil();

    categorias.forEach((cat, index) => {
      const el = document.getElementById(cat.id);
      if (!el) return;
      if (esMovil) {
        el.classList.toggle('hidden', categoriaProductoActual !== index + 1);
      } else {
        el.classList.remove('hidden');
      }
    });

    const titulo = document.getElementById('tituloCategoriaProducto');
    const indicador = document.getElementById('indicadorCategoriaProducto');
    const btnVolver = document.getElementById('btnVolverCategoriaProducto');
    const btnSiguiente = document.getElementById('btnSiguienteCategoriaProducto');

    const actual = categorias[categoriaProductoActual - 1];
    if (titulo && actual) titulo.textContent = actual.titulo;
    if (indicador && actual) indicador.textContent = actual.indicador;
    if (btnVolver) btnVolver.classList.toggle('hidden', !esMovil || categoriaProductoActual === 1);
    if (btnSiguiente) {
      if (categoriaProductoActual === 1) btnSiguiente.textContent = 'Continuar con adiciones →';
      else if (categoriaProductoActual === 2) btnSiguiente.textContent = 'Continuar con bebidas →';
      else btnSiguiente.textContent = 'Continuar con datos del cliente →';
    }
  }

  function siguienteCategoriaProducto() {
    if (categoriaProductoActual === 1 && pedido.length === 0) {
      alert('Primero agrega al menos un producto de comida.');
      return;
    }
    if (categoriaProductoActual < 3) {
      categoriaProductoActual += 1;
      actualizarCategoriasProducto();
      const main = document.getElementById('appMain');
      if (main) main.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    categoriaProductoActual = 1;
    irAPasoVenta(2);
  }

  function anteriorCategoriaProducto() {
    if (categoriaProductoActual > 1) {
      categoriaProductoActual -= 1;
      actualizarCategoriasProducto();
      const main = document.getElementById('appMain');
      if (main) main.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function actualizarIndicadoresPasoVenta() {
    const textoPaso = document.getElementById("ventaPasoActualTexto");
    if (textoPaso) textoPaso.textContent = String(ventaPasoActual);
    const esMovil = esVistaMovil();
    [1,2,3].forEach(num => {
      const section = document.getElementById(`ventaPaso${num}`);
      const btn = document.getElementById(`stepBtn${num}`);
      if (section) {
        if (esMovil) section.classList.toggle('hidden', num !== ventaPasoActual);
        else section.classList.remove('hidden');
      }
      if (btn) {
        const activo = num === ventaPasoActual;
        btn.classList.toggle('bg-yellow-500', activo);
        btn.classList.toggle('text-white', activo);
        btn.classList.toggle('shadow-sm', activo);
        btn.classList.toggle('bg-white', !activo);
        btn.classList.toggle('text-gray-600', !activo);
        btn.classList.toggle('border', !activo);
        btn.classList.toggle('border-yellow-200', !activo);
      }
    });
    actualizarCategoriasProducto();
  }

  function validarPasoVenta(paso) {
    if (paso === 1 && pedido.length === 0) {
      alert('Agrega productos al pedido.');
      return false;
    }
    if (paso === 2) {
      if (pedido.length === 0) {
        alert('Agrega productos al pedido.');
        irAPasoVenta(1);
        return false;
      }
      const cliente = document.getElementById('cliente').value.trim();
      const formaPago = document.getElementById('formaPago').value;
      const tipoPedido = document.getElementById('tipoPedido').value;
      if (!cliente) {
        alert('Por favor ingresa el nombre del cliente.');
        return false;
      }
      if (!formaPago) {
        alert('Por favor selecciona una forma de pago.');
        return false;
      }
      if (!tipoPedido) {
        alert('Por favor selecciona un tipo de pedido.');
        return false;
      }
      if (tipoPedido === 'Domicilio') {
        const costoTexto = String(document.getElementById('costoDomicilio')?.value || '').trim();
        const costo = Number(costoTexto || 0);
        if (costoTexto === '' || !Number.isFinite(costo) || costo < 0) {
          alert('Ingresa un valor válido para el domicilio.');
          return false;
        }
      }
    }
    return true;
  }

  function irAPasoVenta(paso) {
    if (paso < 1 || paso > 3) return;
    if (paso > ventaPasoActual) {
      for (let p = ventaPasoActual; p < paso; p++) {
        if (!validarPasoVenta(p)) return;
      }
    }
    ventaPasoActual = paso;
    if (ventaPasoActual === 1 && pedido.length === 0) categoriaProductoActual = 1;
    actualizarIndicadoresPasoVenta();
    const main = document.getElementById('appMain');
    if (main) main.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function siguientePasoVenta() {
    irAPasoVenta(ventaPasoActual + 1);
  }

  function anteriorPasoVenta() {
    irAPasoVenta(ventaPasoActual - 1);
  }

  function actualizarResumenPasosVenta() {
    const resumen = `${pedido.length} ${pedido.length === 1 ? 'producto' : 'productos'} · ${formatearCOP(total)}`;
    ['resumenPaso1','resumenPaso2','resumenPaso3'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = resumen;
    });
  }

  // Agrega un producto al pedido y actualiza la vista
  function agregarProducto(nombre, precio) {
    pedido.push({ nombre, precio });
    actualizarTotal();
    actualizarVistaPedido();
  }

  // Quita un producto del pedido por índice
  function quitarProducto(index) {
    if (index >= 0 && index < pedido.length) {
      pedido.splice(index, 1);
      actualizarTotal();
      actualizarVistaPedido();
    }
  }

  function obtenerSubtotalPedidoActual() {
    return pedido.reduce((acc, p) => acc + Number(p.precio || 0), 0);
  }

  function obtenerCostoDomicilioActual() {
    const tipoPedido = document.getElementById("tipoPedido")?.value || "";
    if (tipoPedido !== "Domicilio") return 0;
    const valor = Number(document.getElementById("costoDomicilio")?.value || 0);
    return Number.isFinite(valor) && valor >= 0 ? valor : 0;
  }

  function actualizarCampoCostoDomicilio() {
    const tipoPedido = document.getElementById("tipoPedido")?.value || "";
    const grupo = document.getElementById("grupoCostoDomicilio");
    const input = document.getElementById("costoDomicilio");
    const mostrar = tipoPedido === "Domicilio";
    if (grupo) grupo.classList.toggle("hidden", !mostrar);
    if (!mostrar && input) input.value = "";
    actualizarTotal();
    actualizarVistaPedido();
  }

  function actualizarDetalleTotalPedido() {
    const subtotalProductos = obtenerSubtotalPedidoActual();
    const costoDomicilio = obtenerCostoDomicilioActual();
    const detalleTexto = costoDomicilio > 0
      ? `Venta: ${formatearCOP(subtotalProductos)} · Domicilio: ${formatearCOP(costoDomicilio)}`
      : "";
    const detallePaso1 = document.getElementById("detalleTotalPaso1");
    const detallePedido = document.getElementById("detalleTotalPedido");
    [detallePaso1, detallePedido].forEach(el => {
      if (!el) return;
      el.textContent = detalleTexto;
      el.classList.toggle("hidden", !detalleTexto);
    });
    actualizarResumenPagoMixtoUI();
  }

  // Recalcula el total usando solo los productos.
  function actualizarTotal() {
    total = obtenerSubtotalPedidoActual();
  }

  // Actualiza la lista del pedido en la interfaz
  function actualizarVistaPedido() {
    const lista = document.getElementById("listaPedido");
    const listaPaso1 = document.getElementById("listaPedidoPaso1");
    if (lista) lista.innerHTML = "";
    if (listaPaso1) listaPaso1.innerHTML = "";

    if (pedido.length === 0) {
      if (lista) {
        const liVacio = document.createElement("li");
        liVacio.className = "list-none text-gray-400";
        liVacio.textContent = "Aún no has agregado productos.";
        lista.appendChild(liVacio);
      }
      if (listaPaso1) {
        const liVacioPaso1 = document.createElement("li");
        liVacioPaso1.className = "text-gray-400";
        liVacioPaso1.textContent = "Aún no has agregado productos.";
        listaPaso1.appendChild(liVacioPaso1);
      }
    }

    pedido.forEach((p, i) => {
      if (lista) {
        const li = document.createElement("li");
        li.innerHTML = `${p.nombre} - $${p.precio.toLocaleString('es-CO')} <button onclick="quitarProducto(${i})" class='text-red-600 ml-2'>❌</button>`;
        lista.appendChild(li);
      }
      if (listaPaso1) {
        const liPaso1 = document.createElement("li");
        liPaso1.className = "flex items-center justify-between gap-3 border border-yellow-100 rounded-xl px-3 py-2";
        liPaso1.innerHTML = `
          <div>
            <p class="font-medium text-gray-800">${p.nombre}</p>
            <p class="text-xs text-gray-500">$${p.precio.toLocaleString('es-CO')}</p>
          </div>
          <button type="button" onclick="quitarProducto(${i})" class="shrink-0 bg-red-50 text-red-600 hover:bg-red-100 px-3 py-2 rounded-xl font-semibold">Quitar</button>
        `;
        listaPaso1.appendChild(liPaso1);
      }
    });

    if (document.getElementById("total")) {
      document.getElementById("total").textContent = `Total: $${total.toLocaleString('es-CO')}`;
    }
    if (document.getElementById("totalPaso1")) {
      document.getElementById("totalPaso1").textContent = `Total: $${total.toLocaleString('es-CO')}`;
    }
    if (document.getElementById("contadorItemsPaso1")) {
      document.getElementById("contadorItemsPaso1").textContent = `${pedido.length} item${pedido.length === 1 ? '' : 's'}`;
    }
    actualizarDetalleTotalPedido();
    actualizarResumenMovil();
    actualizarResumenPasosVenta();
  }

  // Limpia el pedido y el formulario cliente/pago
 function limpiarPedido() {
  pedido = [];
  total = 0;
  document.getElementById("cliente").value = "";
  document.getElementById("formaPago").value = "";
  document.getElementById("tipoPedido").value = "";
  const costoDomicilioInput = document.getElementById("costoDomicilio");
  if (costoDomicilioInput) costoDomicilioInput.value = "";
  document.getElementById("observaciones").value = "";
  limpiarPagoMixtoActual();
  actualizarCampoCostoDomicilio();
  actualizarResumenPagoMixtoUI();
  actualizarVistaPedido();
  irAPasoVenta(1);
}

function cancelarPedidoActual() {
  if (!verificarAcceso(["admin"])) return;

  if (pedido.length === 0) {
    alert("No hay productos agregados para cancelar.");
    return;
  }

  const ultimoProducto = pedido[pedido.length - 1];
  const nombreProducto = ultimoProducto?.nombre || "este producto";
  if (!confirm(`¿Quitar el último producto agregado?\n\n${nombreProducto}`)) return;

  pedido.pop();
  actualizarTotal();
  actualizarVistaPedido();

  if (pedido.length === 0) {
    irAPasoVenta(1);
  }

  alert(`Se quitó del pedido: ${nombreProducto}`);
}


  // Guarda la venta en localStorage y actualiza la vista de ventas
  async function guardarVenta() {
    if (!verificarAcceso(["admin", "cajero"])) return;
    const cliente = document.getElementById("cliente").value.trim();
    const formaPago = document.getElementById("formaPago").value;
    const tipoPedido = document.getElementById("tipoPedido").value;

    if (pedido.length === 0) {
      alert("Agrega productos al pedido.");
      return;
    }
    if (!cliente) {
      alert("Por favor ingresa el nombre del cliente.");
      return;
    }
    if (!formaPago) {
      alert("Por favor selecciona una forma de pago.");
      return;
    }
    if (!tipoPedido) {
      alert("Por favor selecciona un tipo de pedido.");
      return;
    }

    const costoDomicilioInput = document.getElementById("costoDomicilio");
    const costoDomicilioTexto = String(costoDomicilioInput?.value || "").trim();
    if (tipoPedido === "Domicilio" && costoDomicilioTexto === "") {
      alert("Por favor ingresa el valor del domicilio.");
      return;
    }
    const costoDomicilio = tipoPedido === "Domicilio" ? Number(costoDomicilioTexto || 0) : 0;
    if (!Number.isFinite(costoDomicilio) || costoDomicilio < 0) {
      alert("Ingresa un valor válido para el domicilio.");
      return;
    }

    actualizarTotal();
    const subtotalProductos = obtenerSubtotalPedidoActual();
    const observaciones = document.getElementById("observaciones").value.trim();
    const totalCobrado = redondearPago(subtotalProductos + costoDomicilio);
    const detallePagos = construirDetallePagosVentaDesdeFormulario(formaPago, totalCobrado);

    if (formaPago === "mixto") {
      const sumaDetalle = redondearPago(detallePagos.reduce((acc, item) => acc + Number(item.valor || 0), 0));
      if (!detallePagos.length || Math.abs(sumaDetalle - totalCobrado) >= 0.01) {
        alert("Configura el pago mixto para que coincida exactamente con el total a cobrar.");
        abrirModalPagoMixto();
        return;
      }
    }

    const ahora = new Date();
    const fechaBase = ventaOriginalEnEdicion?.fechaISO ? new Date(ventaOriginalEnEdicion.fechaISO) : ahora;
    const diaClave = ventaOriginalEnEdicion?.diaClave || obtenerFechaLocalISO(fechaBase);
    const numeracionDia = comandaEnEdicion
      ? { comanda: comandaEnEdicion, recibo: reciboEnEdicion ?? comandaEnEdicion }
      : obtenerSiguienteNumeracionDelDia(diaClave);
    const numeroDomicilio = tipoPedido === "Domicilio"
      ? ((ventaOriginalEnEdicion?.tipoPedido === "Domicilio" && Number(ventaOriginalEnEdicion?.numeroDomicilio || 0) > 0)
          ? Number(ventaOriginalEnEdicion.numeroDomicilio)
          : obtenerSiguienteNumeroDomicilioDelDia(diaClave))
      : null;

    const venta = {
      cliente,
      formaPago,
      tipoPedido,
      numeroDomicilio,
      costoDomicilio,
      subtotalProductos,
      observaciones,
      pedido: [...pedido],
      detallePagos,
      totalCobrado,
      total: subtotalProductos,
      estado: ventaOriginalEnEdicion?.estado || ESTADO_VENTA_ACTIVA,
      fechaCancelacion: ventaOriginalEnEdicion?.fechaCancelacion || null,
      canceladaPor: ventaOriginalEnEdicion?.canceladaPor || "",
      fecha: ventaOriginalEnEdicion?.fecha || formatearFechaHoraColombia(ahora),
      fechaISO: ventaOriginalEnEdicion?.fechaISO || ahora.toISOString(),
      diaClave,
      comanda: numeracionDia.comanda,
      recibo: numeracionDia.recibo,
      usuario: usuarioActual || "",
      rolUsuario: rolActual || ""
    };

    const esVentaNueva = !ventaDocIdEnEdicion;
    const popupImpresionCocina = esVentaNueva
      ? window.open('', '_blank', 'width=420,height=720')
      : null;

    if (popupImpresionCocina) {
      try {
        popupImpresionCocina.document.write('<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Preparando impresión</title></head><body style="font-family:sans-serif;padding:16px;">Preparando comanda de cocina...</body></html>');
        popupImpresionCocina.document.close();
      } catch (_) {}
    }

    try {
      venta._localId = venta._localId || ventaOriginalEnEdicion?._localId || generarIdVentaLocal();

      if (esVentaNueva) {
        const ajustesInventario = calcularAjustesInventarioBebidas([], venta.pedido || []);
        const ventaLocal = { ...venta, _syncEstado: firestoreDisponible ? 'pendiente' : 'sincronizado' };

        upsertVentaEnCacheLocal(ventaLocal);
        aplicarAjustesInventarioLocal(ajustesInventario);

        if (firestoreDisponible) {
          guardarVentaPendienteSync(ventaLocal, ajustesInventario);
          programarSyncVentasPendientes(50);
        }

        guardarReferenciaUltimaVenta(ventaLocal);
        limpiarContextoEdicionVenta();
        alert(firestoreDisponible ? "Venta guardada al instante. Se está sincronizando con la base de datos." : "Venta guardada exitosamente.");
        if (popupImpresionCocina) {
          imprimirComandaVenta(ventaLocal, popupImpresionCocina);
        } else {
          setTimeout(() => imprimirComandaVenta(ventaLocal), 80);
        }
      } else {
        if (firestoreDisponible) {
          const docIdGuardado = await guardarVentaEnFirebase(venta, ventaDocIdEnEdicion);
          venta._docId = docIdGuardado;
        } else {
          upsertVentaEnCacheLocal({ ...venta, _docId: ventaDocIdEnEdicion || venta._docId || null, _syncEstado: 'sincronizado' });
        }

        await sincronizarInventarioBebidasPorCambio(venta, ventaOriginalEnEdicion);
        guardarReferenciaUltimaVenta(venta);
        limpiarContextoEdicionVenta();
        alert("Venta guardada exitosamente.");
      }

      limpiarPedido();
      mostrarVentas();
      refrescarVistasAnaliticasSiEstanAbiertas();
      document.getElementById("resumenProductos").classList.add("hidden");
    } catch (error) {
      try {
        if (popupImpresionCocina && !popupImpresionCocina.closed) popupImpresionCocina.close();
      } catch (_) {}
      console.error("Error al guardar la venta:", error);
      alert("No se pudo guardar la venta. Revisa la conexión o la configuración de Firebase.");
    }
  }

  // Muestra las ventas guardadas en la tabla
  const VENTAS_POR_PAGINA = 10;
  let paginaVentasActual = 1;
  const ventasSeleccionadas = new Set();

  function obtenerClaveSeleccionVenta(venta = {}, index = -1) {
    return venta._localId || venta._docId || `${venta.diaClave || ''}|${venta.fechaISO || venta.fecha || ''}|${venta.comanda || venta.recibo || index}`;
  }

  function limpiarSeleccionVentasInexistentes() {
    const clavesDisponibles = new Set(
      obtenerVentasStorage().map((venta, index) => obtenerClaveSeleccionVenta(venta, index))
    );
    Array.from(ventasSeleccionadas).forEach(clave => {
      if (!clavesDisponibles.has(clave)) ventasSeleccionadas.delete(clave);
    });
  }

  function actualizarUISeleccionVentas() {
    const contenedorAcciones = document.getElementById('accionesLoteVentas');
    const btnEliminar = document.getElementById('btnEliminarVentasSeleccionadas');
    const colSeleccion = document.getElementById('colSeleccionVentas');
    const habilitado = esAdmin();
    const total = ventasSeleccionadas.size;

    if (contenedorAcciones) contenedorAcciones.classList.toggle('hidden', !habilitado);
    if (colSeleccion) colSeleccion.style.display = habilitado ? 'table-cell' : 'none';
    if (btnEliminar) {
      btnEliminar.disabled = !habilitado || total === 0;
      btnEliminar.textContent = `🗑️ Eliminar seleccionados (${total})`;
    }
  }

  function toggleSeleccionVenta(clave, marcada) {
    if (!esAdmin() || !clave) return;
    if (marcada) ventasSeleccionadas.add(clave);
    else ventasSeleccionadas.delete(clave);
    actualizarUISeleccionVentas();
  }

  function obtenerVentasFiltradasPaginaActual() {
    const filtro = document.getElementById('filtroCliente')?.value.toLowerCase().trim() || '';
    const ventasDelDia = obtenerVentasDelDiaActualConIndices();
    const ventasFiltradas = ventasDelDia.filter(({ venta }) => (venta.cliente || '').toLowerCase().includes(filtro));
    const inicio = (paginaVentasActual - 1) * VENTAS_POR_PAGINA;
    return ventasFiltradas.slice(inicio, inicio + VENTAS_POR_PAGINA);
  }

  function toggleSeleccionTodasVentasFiltradas(seleccionar = true) {
    if (!verificarAcceso(['admin'])) return;
    const ventasVisibles = obtenerVentasFiltradasPaginaActual();
    ventasVisibles.forEach(({ venta, index }) => {
      const clave = obtenerClaveSeleccionVenta(venta, index);
      if (seleccionar) ventasSeleccionadas.add(clave);
      else ventasSeleccionadas.delete(clave);
    });
    renderVentasTabla();
  }

  async function eliminarVentasPorClaves(claves = []) {
    if (!verificarAcceso(['admin'])) return;
    const clavesSet = new Set((Array.isArray(claves) ? claves : []).filter(Boolean));
    if (!clavesSet.size) {
      alert('Selecciona al menos un pedido para eliminar.');
      return;
    }

    const ventasActuales = obtenerVentasStorage();
    const registros = ventasActuales
      .map((venta, index) => ({ venta, index, clave: obtenerClaveSeleccionVenta(venta, index) }))
      .filter(registro => clavesSet.has(registro.clave));

    if (!registros.length) {
      alert('No se encontraron los pedidos seleccionados.');
      ventasSeleccionadas.clear();
      actualizarUISeleccionVentas();
      renderVentasTabla();
      return;
    }

    const requiereConexion = registros.some(({ venta }) => Boolean(venta._docId));
    if (requiereConexion && (!firestoreDisponible || !firestoreDb)) {
      alert('No se puede eliminar en este momento porque uno o más pedidos están guardados en la base de datos y no hay conexión.');
      return;
    }

    const mensajeConfirmacion = registros.length === 1
      ? `¿Eliminar definitivamente la venta #${registros[0].venta.comanda ?? registros[0].venta.recibo ?? (registros[0].index + 1)}? Esta acción la borrará del local y de la base de datos.`
      : `¿Eliminar definitivamente ${registros.length} pedidos seleccionados? Esta acción los borrará del local y de la base de datos.`;

    if (!confirm(mensajeConfirmacion)) return;

    try {
      let seEliminoVentaEnEdicion = false;

      for (const { venta, clave } of registros) {
        if (venta._docId) {
          await borrarVentaEnFirebase(venta._docId);
        }
        await sincronizarInventarioBebidasPorCambio(null, venta);
        eliminarVentaDeCacheLocal(venta);
        quitarVentaPendienteSync(venta._localId || venta._docId || '');
        ventasSeleccionadas.delete(clave);

        const esVentaEnEdicion =
          (ventaDocIdEnEdicion && venta._docId && ventaDocIdEnEdicion === venta._docId) ||
          (ventaOriginalEnEdicion?._localId && venta._localId && ventaOriginalEnEdicion._localId === venta._localId);

        if (esVentaEnEdicion) seEliminoVentaEnEdicion = true;
      }

      actualizarReferenciaUltimaVentaTrasEliminar();

      if (seEliminoVentaEnEdicion) {
        limpiarContextoEdicionVenta();
        limpiarPedido();
      }

      alert(registros.length === 1 ? 'Venta eliminada definitivamente.' : 'Pedidos eliminados definitivamente.');
      mostrarVentas();
      renderControlCajaDiaActual();
      const resumen = document.getElementById('resumenProductos');
      if (resumen && !resumen.classList.contains('hidden')) {
        generarResumenProductos();
      }
      refrescarVistasAnaliticasSiEstanAbiertas();
    } catch (error) {
      console.error('Error al eliminar pedidos:', error);
      alert('No se pudieron eliminar los pedidos seleccionados.');
    }
  }

  async function eliminarVentasSeleccionadas() {
    await eliminarVentasPorClaves(Array.from(ventasSeleccionadas));
  }

  function construirFilaVenta(v, i) {
    const resumen = {};
    v.pedido.forEach(p => {
      resumen[p.nombre] = (resumen[p.nombre] || 0) + 1;
    });

    const ventaCancelada = esVentaCancelada(v);
    const ventaKey = obtenerClaveSeleccionVenta(v, i);
    const ventaSeleccionada = ventasSeleccionadas.has(ventaKey);
    const productosResumen = Object.entries(resumen)
      .map(([prod, cant]) => `${prod}: ${cant}`)
      .join("<br>");

    const botonesAccion = `
      <button onclick="imprimirVentaCliente(${i})" class="bg-purple-500 text-white px-2 py-1 rounded text-xs">🧾 Cliente</button>
      <button onclick="imprimirVentaCocina(${i})" class="bg-blue-500 text-white px-2 py-1 rounded text-xs">👨‍🍳 Cocina</button>
      ${ventaCancelada ? `<span class="inline-flex items-center px-2 py-1 rounded text-xs font-bold bg-red-100 text-red-700">Cancelada</span>` : (tieneAccesoGestion() ? `<button onclick="marcarVentaComoCancelada(${i})" class="bg-red-500 text-white px-2 py-1 rounded text-xs">❌ Cancelar</button>` : "")}
      ${esAdmin() ? `<button onclick="editarVenta(${i})" class="bg-yellow-600 text-white px-2 py-1 rounded text-xs">📝 Editar</button>` : ""}
      ${esAdmin() ? `<button onclick="eliminarVentaPermanentemente(${i})" class="bg-red-800 text-white px-2 py-1 rounded text-xs">🗑️ Eliminar</button>` : ""}
    `;

    return `
      <tr class="${ventaCancelada ? 'bg-red-50 text-gray-500' : ''}">
        <td class='border p-1 text-center' style="display:${esAdmin() ? 'table-cell' : 'none'}">
          <input type="checkbox" ${ventaSeleccionada ? 'checked' : ''} onchange="toggleSeleccionVenta('${ventaKey}', this.checked)" class="w-4 h-4 accent-red-700 cursor-pointer" />
        </td>
        <td class='border p-1'>${v.comanda ?? v.recibo ?? (i + 1)}</td>
        <td class='border p-1'>${formatearFechaHoraColombia(v.fechaISO || v.fecha)}</td>
        <td class='border p-1'>${v.cliente}</td>
        <td class='border p-1'>${obtenerEtiquetaFormaPago(v)}</td>
        <td class='border p-1'>${formatearTipoPedidoVisual(v)}</td>
        <td class='border p-1'>${obtenerBadgeEstadoVenta(v)}</td>
        <td class='border p-1'>${productosResumen}</td>
        <td class='border p-1 font-semibold ${ventaCancelada ? 'text-red-600' : ''}'>$${v.total.toLocaleString('es-CO')}</td>
        <td class='border p-1 space-y-1 space-x-1'>${botonesAccion}</td>
      </tr>
    `;
  }

  function formatearCOP(valor) {
    return `$${Number(valor || 0).toLocaleString('es-CO')}`;
  }

  function formatearTipoPedidoVisual(venta = {}) {
    const tipo = venta?.tipoPedido || '-';
    const costoDomicilio = Number(venta?.costoDomicilio || 0);
    const numeroDomicilio = obtenerNumeroDomicilio(venta);
    if (tipo === 'Domicilio') {
      const partes = [numeroDomicilio > 0 ? `${tipo} #${numeroDomicilio}` : tipo];
      if (costoDomicilio > 0) partes.push(formatearCOP(costoDomicilio));
      return partes.join(' · ');
    }
    return tipo;
  }

  function actualizarResumenMovil() {
    const items = document.getElementById("mobileResumenItems");
    const totalEl = document.getElementById("mobileResumenTotal");
    if (items) {
      items.textContent = `${pedido.length} ${pedido.length === 1 ? 'producto' : 'productos'}`;
    }
    if (totalEl) {
      totalEl.textContent = `Total: ${formatearCOP(total)}`;
    }
  }

  function scrollToPedido() {
    const destino = document.getElementById("pedidoActualCard");
    if (destino) destino.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function construirTarjetaVenta(v, i) {
    const resumen = {};
    (v.pedido || []).forEach(p => {
      resumen[p.nombre] = (resumen[p.nombre] || 0) + 1;
    });
    const ventaCancelada = esVentaCancelada(v);
    const ventaKey = obtenerClaveSeleccionVenta(v, i);
    const ventaSeleccionada = ventasSeleccionadas.has(ventaKey);
    const productosResumen = Object.entries(resumen)
      .map(([prod, cant]) => `<li class="flex justify-between gap-3"><span>${prod}</span><strong>x${cant}</strong></li>`)
      .join("");

    let botonesAccion = `
      <div class="grid grid-cols-2 gap-2 mt-3">
        <button onclick="imprimirVentaCliente(${i})" class="bg-purple-500 text-white px-3 py-2 rounded-lg text-sm font-semibold">🧾 Cliente</button>
        <button onclick="imprimirVentaCocina(${i})" class="bg-blue-500 text-white px-3 py-2 rounded-lg text-sm font-semibold">👨‍🍳 Cocina</button>
      </div>
    `;

    if (!ventaCancelada) {
      botonesAccion += `
        <button onclick="marcarVentaComoCancelada(${i})" class="bg-red-100 text-red-700 px-3 py-2 rounded-lg text-sm font-semibold w-full mt-2">❌ Marcar como cancelada</button>
      `;
    } else {
      botonesAccion += `
        <div class="mt-2">${obtenerBadgeEstadoVenta(v)}</div>
      `;
    }

    if (esAdmin()) {
      botonesAccion += `
        <button onclick="editarVenta(${i})" class="bg-yellow-600 text-white px-3 py-2 rounded-lg text-sm font-semibold w-full mt-2">📝 Editar</button>
        <button onclick="eliminarVentaPermanentemente(${i})" class="bg-red-800 text-white px-3 py-2 rounded-lg text-sm font-semibold w-full mt-2">🗑️ Eliminar</button>
      `;
    }

    return `
      <article class="${ventaCancelada ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'} border rounded-2xl p-4 shadow-sm">
        ${esAdmin() ? `<label class="inline-flex items-center gap-2 text-sm font-semibold text-gray-700 mb-3"><input type="checkbox" ${ventaSeleccionada ? 'checked' : ''} onchange="toggleSeleccionVenta('${ventaKey}', this.checked)" class="w-4 h-4 accent-red-700 cursor-pointer" /> Seleccionar pedido</label>` : ''}
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-xs text-gray-500">Venta #${v.comanda ?? v.recibo ?? (i + 1)}</p>
            <h4 class="font-bold text-gray-800">${v.cliente || 'Sin cliente'}</h4>
          </div>
          <div class="text-right">
            <p class="text-sm font-bold ${ventaCancelada ? 'text-red-600' : 'text-gray-800'}">${formatearCOP(obtenerIngresoRealVenta(v))}</p>
            <div class="mt-1">${obtenerBadgeEstadoVenta(v)}</div>
          </div>
        </div>
        <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div class="bg-white rounded-xl p-2 border border-yellow-100"><span class="text-gray-500 block text-xs">Fecha</span><strong>${formatearFechaHoraColombia(v.fechaISO || v.fecha)}</strong></div>
          <div class="bg-white rounded-xl p-2 border border-yellow-100"><span class="text-gray-500 block text-xs">Pago</span><strong>${obtenerEtiquetaFormaPago(v)}</strong></div>
          <div class="bg-white rounded-xl p-2 border border-yellow-100 col-span-2"><span class="text-gray-500 block text-xs">Tipo de pedido</span><strong>${formatearTipoPedidoVisual(v)}</strong></div>
          ${Number(v.costoDomicilio || 0) > 0 ? `<div class="bg-white rounded-xl p-2 border border-yellow-100 col-span-2"><span class="text-gray-500 block text-xs">Costo domicilio</span><strong>${formatearCOP(v.costoDomicilio)}</strong></div>` : ''}
          ${(v.observaciones || '').trim() ? `<div class="bg-white rounded-xl p-2 border border-yellow-100 col-span-2"><span class="text-gray-500 block text-xs">Observaciones</span><strong>${v.observaciones}</strong></div>` : ''}
        </div>
        <div class="mt-3 bg-white rounded-xl p-3 border border-yellow-100">
          <p class="text-xs text-gray-500 mb-2">Productos</p>
          <ul class="space-y-2 text-sm text-gray-700">${productosResumen}</ul>
        </div>
        ${botonesAccion}
      </article>
    `;
  }

  function actualizarControlesPaginacion(totalVentasFiltradas) {
    const totalPaginas = Math.max(1, Math.ceil(totalVentasFiltradas / VENTAS_POR_PAGINA));
    const inicio = totalVentasFiltradas === 0 ? 0 : ((paginaVentasActual - 1) * VENTAS_POR_PAGINA) + 1;
    const fin = Math.min(paginaVentasActual * VENTAS_POR_PAGINA, totalVentasFiltradas);

    document.getElementById("ventasPaginacionInfo").textContent = `Mostrando ${inicio}-${fin} de ${totalVentasFiltradas} ventas`;
    document.getElementById("ventasPaginaActual").textContent = `Página ${paginaVentasActual} de ${totalPaginas}`;
    document.getElementById("btnPrevVentas").disabled = paginaVentasActual <= 1;
    document.getElementById("btnNextVentas").disabled = paginaVentasActual >= totalPaginas;
    document.getElementById("btnPrevVentas").classList.toggle("opacity-50", paginaVentasActual <= 1);
    document.getElementById("btnNextVentas").classList.toggle("opacity-50", paginaVentasActual >= totalPaginas);
  }


  const FILAS_POR_PAGINA_TABLAS = 10;
  const estadoPaginacionTablas = {
    cierresCaja: { pagina: 1 },
    historicoDia: { pagina: 1 },
    historicoSemana: { pagina: 1 },
    historicoMes: { pagina: 1 },
    historicoDetalle: { pagina: 1 },
    domiciliosDia: { pagina: 1 },
    domiciliosDetalle: { pagina: 1 }
  };
  let ultimaFechaHistoricoDetalle = '';
  let ultimaFechaDomiciliosDetalle = '';

  function obtenerEstadoPaginacionTabla(clave) {
    if (!estadoPaginacionTablas[clave]) estadoPaginacionTablas[clave] = { pagina: 1 };
    return estadoPaginacionTablas[clave];
  }

  function reiniciarPaginaTabla(clave) {
    obtenerEstadoPaginacionTabla(clave).pagina = 1;
  }

  function cambiarPaginaTabla(clave, direccion) {
    const estado = obtenerEstadoPaginacionTabla(clave);
    estado.pagina = Math.max(1, Number(estado.pagina || 1) + Number(direccion || 0));
    if (clave === 'cierresCaja') {
      renderTablaCierresCaja(false);
      return;
    }
    if (['historicoDia', 'historicoSemana', 'historicoMes'].includes(clave)) {
      actualizarHistoricos();
      return;
    }
    if (clave === 'historicoDetalle') {
      verVentasDetalladasPorFecha();
      return;
    }
    if (clave === 'domiciliosDia') {
      actualizarDomiciliosVista();
      return;
    }
    if (clave === 'domiciliosDetalle') {
      verDomiciliosDetalladosPorFecha();
    }
  }

  function renderFilasPaginadas(config = {}) {
    const {
      clave,
      bodyId,
      filas = [],
      colspan = 1,
      etiquetaVacia = 'No hay registros.',
      infoId,
      pageId,
      prevId,
      nextId
    } = config;
    const body = document.getElementById(bodyId);
    if (!body) return;

    const estado = obtenerEstadoPaginacionTabla(clave);
    const total = Array.isArray(filas) ? filas.length : 0;
    const totalPaginas = Math.max(1, Math.ceil(total / FILAS_POR_PAGINA_TABLAS));
    if (estado.pagina > totalPaginas) estado.pagina = totalPaginas;
    if (estado.pagina < 1) estado.pagina = 1;

    const inicioIndex = (estado.pagina - 1) * FILAS_POR_PAGINA_TABLAS;
    const finIndex = inicioIndex + FILAS_POR_PAGINA_TABLAS;
    const filasPagina = (filas || []).slice(inicioIndex, finIndex);

    body.innerHTML = filasPagina.length
      ? filasPagina.join('')
      : `<tr><td colspan="${colspan}" class="p-3 text-center text-gray-500">${etiquetaVacia}</td></tr>`;

    const inicioVisible = total === 0 ? 0 : inicioIndex + 1;
    const finVisible = total === 0 ? 0 : Math.min(finIndex, total);
    const info = document.getElementById(infoId);
    const pagina = document.getElementById(pageId);
    const prev = document.getElementById(prevId);
    const next = document.getElementById(nextId);

    if (info) info.textContent = `Mostrando ${inicioVisible}-${finVisible} de ${total} registros`;
    if (pagina) pagina.textContent = `Página ${estado.pagina} de ${totalPaginas}`;
    if (prev) {
      prev.disabled = estado.pagina <= 1;
      prev.classList.toggle('opacity-50', estado.pagina <= 1);
    }
    if (next) {
      next.disabled = estado.pagina >= totalPaginas;
      next.classList.toggle('opacity-50', estado.pagina >= totalPaginas);
    }
  }

  function obtenerClaveDiaActual() {
    return obtenerFechaLocalISO(new Date());
  }

  function obtenerVentasDelDiaActualConIndices() {
    const hoy = obtenerClaveDiaActual();
    const ventas = obtenerVentasStorage();
    return ventas
      .map((venta, index) => ({ venta, index }))
      .filter(({ venta }) => {
        const fechaBase = venta.fechaISO ? new Date(venta.fechaISO) : new Date(venta.fecha || Date.now());
        const diaVenta = venta.diaClave || obtenerFechaLocalISO(fechaBase);
        return diaVenta === hoy;
      });
  }

  function renderVentasTabla() {
    limpiarSeleccionVentasInexistentes();
    const filtro = document.getElementById("filtroCliente").value.toLowerCase().trim();
    const ventasDelDia = obtenerVentasDelDiaActualConIndices();
    const ventasFiltradas = ventasDelDia
      .filter(({ venta }) => (venta.cliente || "").toLowerCase().includes(filtro));

    const totalPaginas = Math.max(1, Math.ceil(ventasFiltradas.length / VENTAS_POR_PAGINA));
    if (paginaVentasActual > totalPaginas) paginaVentasActual = totalPaginas;
    if (paginaVentasActual < 1) paginaVentasActual = 1;

    const inicio = (paginaVentasActual - 1) * VENTAS_POR_PAGINA;
    const ventasPagina = ventasFiltradas.slice(inicio, inicio + VENTAS_POR_PAGINA);

    const contenedor = document.getElementById("ventasGuardadas");
    contenedor.innerHTML = ventasPagina.length
      ? ventasPagina.map(({ venta, index }) => construirFilaVenta(venta, index)).join("")
      : `<tr><td colspan="10" class="border p-3 text-center text-gray-500">No hay ventas del día para mostrar.</td></tr>`;

    const contenedorMobile = document.getElementById("ventasGuardadasMobile");
    if (contenedorMobile) {
      contenedorMobile.innerHTML = ventasPagina.length
        ? ventasPagina.map(({ venta, index }) => construirTarjetaVenta(venta, index)).join("")
        : `<div class="bg-white border border-yellow-200 rounded-2xl p-4 text-center text-gray-500">No hay ventas del día para mostrar.</div>`;
    }

    actualizarControlesPaginacion(ventasFiltradas.length);
    actualizarUISeleccionVentas();
  }

  function mostrarVentas() {
    document.getElementById("filtroCliente").value = "";
    paginaVentasActual = 1;
    renderVentasTabla();
    renderControlCajaDiaActual();
  }

  function cambiarPaginaVentas(direccion) {
    paginaVentasActual += direccion;
    renderVentasTabla();
  }

  // Borra todas las ventas guardadas
  async function borrarVentas() {
    if (!verificarAcceso(["admin", "administrador"])) return;
    if (confirm("¿Estás seguro de borrar todas las ventas?")) {
      try {
        if (firestoreDisponible) {
          await borrarTodasLasVentasEnFirebase();
        }
        guardarVentasEnCache([]);
        ventasSeleccionadas.clear();
        localStorage.removeItem(ULTIMA_VENTA_GUARDADA_KEY);
        alert("Todas las ventas han sido eliminadas.");
        mostrarVentas();
        const resumen = document.getElementById("resumenProductos");
        if (resumen) resumen.classList.add("hidden");
      } catch (error) {
        console.error("Error al borrar ventas:", error);
        alert("No se pudieron borrar las ventas.");
      }
    }
  }

  // Genera resumen de productos vendidos
  function generarResumenProductos() {
    if (!verificarAcceso(["admin", "administrador"])) return;
    const ventas = filtrarVentasActivas(obtenerVentasStorage());
    const resumen = {};
    ventas.forEach(v => {
      v.pedido.forEach(p => {
        resumen[p.nombre] = (resumen[p.nombre] || 0) + 1;
      });
    });
    const lista = document.getElementById("listaResumen");
    lista.innerHTML = "";
    Object.entries(resumen).forEach(([producto, cantidad]) => {
      const li = document.createElement("li");
      li.textContent = `${producto}: ${cantidad}`;
      lista.appendChild(li);
    });
    document.getElementById("resumenProductos").classList.remove("hidden");
    document.getElementById("resumenProductos").scrollIntoView({ behavior: "smooth" });
  }

  async function exportarVentasAExcel(ventas, nombreArchivo, nombreHoja = "Ventas") {
    const ventasNormalizadas = Array.isArray(ventas) ? ventas : [];
    if (!ventasNormalizadas.length) {
      alert("No hay ventas para exportar.");
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(nombreHoja);

    const headers = [
      "#", "Fecha", "Cliente", "Forma de Pago", "Tipo de Pedido", "N° domicilio", "Costo domicilio (COP)", "Estado", "Producto", "Precio (COP)", "Total Pedido (COP)"
    ];
    sheet.addRow(headers);

    let totalGlobal = 0;
    const conteoProductos = {};

    ventasNormalizadas.forEach((venta, i) => {
      const { fecha, cliente, formaPago, tipoPedido, pedido, costoDomicilio } = venta;
      const formaPagoTexto = obtenerEtiquetaFormaPago(venta);
      const total = obtenerIngresoRealVenta(venta);
      const ventaCancelada = esVentaCancelada(venta);
      if (!ventaCancelada) {
        totalGlobal += parseFloat(total) || 0;
      }

      (pedido || []).forEach(producto => {
        sheet.addRow([
          venta.comanda ?? venta.recibo ?? (i + 1),
          formatearFechaHoraColombia(venta.fechaISO || fecha),
          cliente,
          formaPagoTexto,
          tipoPedido,
          obtenerNumeroDomicilio(venta) || '',
          parseFloat(costoDomicilio || 0),
          ventaCancelada ? "Cancelada" : "Activa",
          producto.nombre,
          parseFloat(producto.precio),
          parseFloat(total)
        ]);
        if (!ventaCancelada) {
          conteoProductos[producto.nombre] = (conteoProductos[producto.nombre] || 0) + 1;
        }
      });
    });

    sheet.getRow(1).eachCell(cell => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1F4E78" }
      };
      cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = {
        top: { style: "thin" }, bottom: { style: "thin" },
        left: { style: "thin" }, right: { style: "thin" }
      };
    });

    for (let i = 2; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      const isEven = i % 2 === 0;
      row.eachCell(cell => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: isEven ? "FFF2F2F2" : "FFFFFFFF" }
        };
        cell.border = {
          top: { style: "thin" }, bottom: { style: "thin" },
          left: { style: "thin" }, right: { style: "thin" }
        };
      });
    }

    for (let i = 2; i <= sheet.rowCount; i++) {
      sheet.getRow(i).getCell(10).numFmt = '"$"#,##0';
      sheet.getRow(i).getCell(11).numFmt = '"$"#,##0';
    }

    sheet.addRow([]);
    const totalRow = sheet.addRow(["", "", "", "", "", "", "", "TOTAL CONTABILIZADO:", "", "", totalGlobal]);
    totalRow.getCell(11).numFmt = '"$"#,##0';
    totalRow.font = { bold: true };

    let productoMasVendido = "";
    let maxCantidad = 0;
    for (const [prod, cantidad] of Object.entries(conteoProductos)) {
      if (cantidad > maxCantidad) {
        maxCantidad = cantidad;
        productoMasVendido = prod;
      }
    }
    const resumenRow = sheet.addRow(["", "", "", "", "", "", "", "Producto más vendido:", "", productoMasVendido ? `${productoMasVendido} (${maxCantidad})` : "-"]);
    resumenRow.font = { italic: true };

    sheet.columns.forEach(col => {
      col.width = 18;
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nombreArchivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Exportar ventas a Excel con estilo y toda la info incluida
  async function exportarVentasExcelConEstilo() {
    if (!verificarAcceso(["admin", "administrador"])) return;
    const hoy = obtenerClaveDiaActual();
    const ventas = obtenerVentasStorage().filter(venta => {
      const fechaBase = venta.fechaISO ? new Date(venta.fechaISO) : new Date(venta.fecha || Date.now());
      const diaVenta = venta.diaClave || obtenerFechaLocalISO(fechaBase);
      return diaVenta === hoy;
    });

    if (ventas.length === 0) {
      alert("No hay ventas registradas para el día actual.");
      return;
    }

    await exportarVentasAExcel(ventas, `Ventas_del_dia_${hoy}.xlsx`, `Ventas ${hoy}`);
  }
    // Borra todas las ventas guardadas
  function obtenerTipoPedidoImpresion(venta = {}) {
  const tipoBase = String(venta?.tipoPedido || '-');
  const numeroDomicilio = obtenerNumeroDomicilio(venta);
  if (tipoBase === 'Domicilio') {
    return numeroDomicilio > 0 ? `${tipoBase} #${numeroDomicilio}` : tipoBase;
  }
  return tipoBase;
}

function construirListaProductosImpresion(venta = {}, resumido = false) {
  const pedidoImpresion = Array.isArray(venta?.pedido) ? venta.pedido : [];
  if (!pedidoImpresion.length) return '<li>Sin productos</li>';

  if (resumido) {
    const resumen = {};
    pedidoImpresion.forEach(item => {
      const nombre = item?.nombre || 'Producto';
      resumen[nombre] = (resumen[nombre] || 0) + 1;
    });
    return Object.entries(resumen)
      .map(([producto, cantidad]) => `<li>${producto} x${cantidad}</li>`)
      .join('');
  }

  return pedidoImpresion
    .map(item => `<li>${item?.nombre || 'Producto'} - ${formatearCOP(item?.precio || 0)}</li>`)
    .join('');
}

function abrirVentanaImpresion(contenido, titulo = 'Impresión', ventanaDestino = null) {
  const w = ventanaDestino && !ventanaDestino.closed
    ? ventanaDestino
    : window.open('', '_blank', 'width=420,height=720');
  if (!w) {
    alert('No se pudo abrir la ventana de impresión. Revisa el bloqueador de ventanas emergentes.');
    return null;
  }
  try {
    w.document.open();
    w.document.write(contenido);
    w.document.close();
    setTimeout(() => {
      try {
        w.focus();
        w.print();
      } catch (error) {
        console.warn('No se pudo lanzar la impresión automática.', error);
      }
    }, 120);
  } catch (error) {
    console.error('No se pudo preparar la ventana de impresión.', error);
    try { w.close(); } catch (_) {}
    return null;
  }
  return w;
}

function imprimirComandaVenta(venta, ventanaDestino = null) {
  if (!venta) return null;
  if (esVentaCancelada(venta)) return null;
  if (!Array.isArray(venta.pedido) || !venta.pedido.length) return null;
  return abrirVentanaImpresion(
    generarPlantillaComanda(venta, venta.comanda ?? venta.recibo ?? 1),
    'Pedido Cocina',
    ventanaDestino
  );
}

function generarPlantillaReciboCliente(venta = {}, referencia = 1) {
  const observaciones = venta?.observaciones || '';
  const costoDomicilio = Number(venta?.costoDomicilio || 0);
  const fechaTexto = formatearFechaHoraColombia(venta?.fechaISO || venta?.fecha);
  return `<!DOCTYPE html>
  <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Recibo Cliente</title>
      <style>
        @page { margin: 8mm 6mm; }
        body {
          font-family: monospace;
          font-size: 14px;
          width: 58mm;
          margin: 0 auto;
          padding: 0;
          line-height: 1.45;
          color: #000;
        }
        h2 {
          text-align: center;
          font-size: 19px;
          margin: 0 0 6px;
          font-weight: 700;
        }
        .sub-info {
          text-align: center;
          font-size: 12px;
          margin-bottom: 10px;
          line-height: 1.3;
        }
        .line {
          border-top: 1px dashed #000;
          margin: 8px 0;
        }
        .info p,
        .totales p {
          margin: 4px 0;
        }
        .numero {
          text-align: center;
          font-weight: 700;
          margin: 4px 0;
        }
        ul {
          list-style: none;
          padding: 0;
          margin: 0;
        }
        li {
          margin-bottom: 6px;
        }
        .total {
          text-align: right;
          font-weight: 700;
          font-size: 16px;
          margin-top: 8px;
        }
        .thanks {
          text-align: center;
          margin-top: 14px;
          font-weight: 700;
          font-size: 15px;
        }
      </style>
    </head>
    <body>
      <h2>SEÑOR AREPA</h2>
      <div class="sub-info">
        Matrícula No 289546<br>
        CALLE 19#25-03 ESQUINA<br>
        BARRIO SAN JOSÉ, ARMENIA
      </div>
      <div class="line"></div>
      <div class="info">
        <p class="numero">RECIBO #${venta?.recibo ?? venta?.comanda ?? referencia}</p>
        <p class="numero">COMANDA #${venta?.comanda ?? venta?.recibo ?? referencia}</p>
        <p><strong>Cliente:</strong> ${venta?.cliente || 'N/A'}</p>
        <p><strong>Fecha:</strong> ${fechaTexto}</p>
        <p><strong>Tipo de pedido:</strong> ${obtenerTipoPedidoImpresion(venta)}</p>
        <p><strong>Método de pago:</strong> ${obtenerEtiquetaFormaPago(venta)}</p>
        ${observaciones ? `<p><strong>Observaciones:</strong> ${observaciones}</p>` : ''}
      </div>
      <div class="line"></div>
      <ul>
        ${construirListaProductosImpresion(venta, false)}
      </ul>
      <div class="line"></div>
      <div class="totales">
        ${costoDomicilio > 0 ? `<p><strong>Domicilio:</strong> ${formatearCOP(costoDomicilio)}</p>` : ''}
        <p class="total">Total venta: ${formatearCOP(venta?.total || 0)}</p>
      </div>
      <div class="line"></div>
      <p class="thanks">¡Gracias por su compra!</p>
    </body>
  </html>`;
}

function generarPlantillaComanda(venta = {}, referencia = 1) {
  const observaciones = venta?.observaciones || '';
  const costoDomicilio = Number(venta?.costoDomicilio || 0);
  const fechaTexto = formatearFechaHoraColombia(venta?.fechaISO || venta?.fecha);
  return `<!DOCTYPE html>
  <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Pedido Cocina</title>
      <style>
        @page { margin: 8mm 6mm; }
        body {
          font-family: monospace;
          font-size: 15px;
          width: 72mm;
          margin: 0 auto;
          padding: 0;
          line-height: 1.4;
          color: #000;
        }
        h2 {
          text-align: center;
          font-size: 19px;
          margin: 0 0 8px;
          font-weight: 700;
        }
        .line {
          border-top: 1px dashed #000;
          margin: 8px 0;
        }
        .info p,
        .extra p {
          margin: 4px 0;
        }
        .numero {
          text-align: center;
          font-weight: 700;
          margin: 4px 0;
        }
        ul {
          list-style: none;
          padding: 0;
          margin: 0;
        }
        li {
          padding: 5px 0;
          border-bottom: 1px dashed #000;
          font-size: 18px;
        }
        .footer-note {
          text-align: center;
          margin-top: 12px;
          font-weight: 700;
        }
      </style>
    </head>
    <body>
      <h2>🧾 PEDIDO A COCINA</h2>
      <div class="line"></div>
      <div class="info">
        <p class="numero">RECIBO #${venta?.recibo ?? venta?.comanda ?? referencia}</p>
        <p class="numero">COMANDA #${venta?.comanda ?? venta?.recibo ?? referencia}</p>
        <p><strong>Cliente:</strong> ${venta?.cliente || 'Sin nombre'}</p>
        <p><strong>Fecha:</strong> ${fechaTexto}</p>
        <p><strong>Tipo de pedido:</strong> ${obtenerTipoPedidoImpresion(venta)}</p>
        <p><strong>Método de pago:</strong> ${obtenerEtiquetaFormaPago(venta)}</p>
        ${observaciones ? `<p><strong>Observaciones:</strong> ${observaciones}</p>` : ''}
      </div>
      <div class="line"></div>
      <ul>
        ${construirListaProductosImpresion(venta, true)}
      </ul>
      ${costoDomicilio > 0 ? `<div class="line"></div><div class="extra"><p><strong>Costo domicilio:</strong> ${formatearCOP(costoDomicilio)}</p></div>` : ''}
      <p class="footer-note">👨‍🍳 Preparar con cuidado</p>
    </body>
  </html>`;
}

function imprimirUltimaCocinero() {
  if (!verificarAcceso(["admin", "cajero"])) return;
  const ultimaVenta = obtenerUltimaVentaGuardada();
  if (!ultimaVenta) {
    alert("No hay ventas para imprimir.");
    return;
  }
  if (esVentaCancelada(ultimaVenta)) {
    alert("La última venta guardada está cancelada y no se puede imprimir.");
    return;
  }
  if (!ultimaVenta.pedido || !Array.isArray(ultimaVenta.pedido)) {
    alert("La última venta no tiene productos válidos.");
    return;
  }

  imprimirComandaVenta(ultimaVenta);
}

// Imprimir último recibo para cliente (simple)
function imprimirUltimaCliente() {
  if (!verificarAcceso(["admin", "cajero"])) return;
  const ultimaVenta = obtenerUltimaVentaGuardada();
  if (!ultimaVenta) {
    alert("No hay ventas para imprimir.");
    return;
  }
  if (esVentaCancelada(ultimaVenta)) {
    alert("La última venta guardada está cancelada y no se puede imprimir.");
    return;
  }

  abrirVentanaImpresion(
    generarPlantillaReciboCliente(ultimaVenta, ultimaVenta.recibo ?? ultimaVenta.comanda ?? 1),
    'Recibo Cliente'
  );
}


// Imprimir cualquier recibo de la seccion ventas guardadas (simple)

function imprimirVentaCliente(index) {
  if (!verificarAcceso(["admin", "cajero"])) return;
  const ventas = obtenerVentasStorage();
  const venta = ventas[index];
  if (!venta) return alert("Venta no encontrada.");
  if (esVentaCancelada(venta)) return alert("Esta venta está cancelada y no se puede imprimir.");

  abrirVentanaImpresion(
    generarPlantillaReciboCliente(venta, venta.recibo ?? venta.comanda ?? (index + 1)),
    'Recibo Cliente'
  );
}

function imprimirVentaCocina(index) {
  if (!verificarAcceso(["admin", "cajero"])) return;
  const ventas = obtenerVentasStorage();
  const venta = ventas[index];
  if (!venta) return alert("Venta no encontrada.");
  if (esVentaCancelada(venta)) return alert("Esta venta está cancelada y no se puede imprimir.");
  if (!venta.pedido || !Array.isArray(venta.pedido)) return alert("Esta venta no tiene productos válidos.");

  abrirVentanaImpresion(
    generarPlantillaComanda(venta, venta.comanda ?? venta.recibo ?? (index + 1)),
    'Pedido Cocina'
  );
}

async function eliminarVentaPermanentemente(index) {
  if (!verificarAcceso(["admin"])) return;
  const ventas = obtenerVentasStorage();
  const venta = ventas[index];
  if (!venta) return alert("Venta no encontrada.");
  await eliminarVentasPorClaves([obtenerClaveSeleccionVenta(venta, index)]);
}

async function marcarVentaComoCancelada(index) {
  if (!verificarAcceso(["admin", "administrador"])) return;
  const ventas = obtenerVentasStorage();
  const venta = ventas[index];
  if (!venta) return alert("Venta no encontrada.");
  if (esVentaCancelada(venta)) {
    alert("Esta venta ya está cancelada.");
    return;
  }

  if (!confirm(`¿Cancelar la venta #${venta.comanda ?? venta.recibo ?? (index + 1)}? Seguirá visible, pero no sumará dinero en los reportes.`)) {
    return;
  }

  const ventaActualizada = {
    ...venta,
    estado: ESTADO_VENTA_CANCELADA,
    fechaCancelacion: new Date().toISOString(),
    canceladaPor: usuarioActual || ""
  };

  try {
    if (firestoreDisponible) {
      const docIdGuardado = await guardarVentaEnFirebase(ventaActualizada, venta._docId || null);
      ventaActualizada._docId = docIdGuardado;
    } else {
      ventas[index] = ventaActualizada;
      guardarVentasEnCache(ordenarVentasDesc(ventas));
    }

    await sincronizarInventarioBebidasPorCambio(ventaActualizada, venta);
    guardarReferenciaUltimaVenta(ventaActualizada);
    alert("Venta marcada como cancelada. Ya no suma dinero en los totales.");
    mostrarVentas();
    renderControlCajaDiaActual();
    const resumen = document.getElementById("resumenProductos");
    if (resumen && !resumen.classList.contains("hidden")) {
      generarResumenProductos();
    }
    refrescarVistasAnaliticasSiEstanAbiertas();
  } catch (error) {
    console.error("Error al cancelar la venta:", error);
    alert("No se pudo cancelar la venta.");
  }
}

function editarVenta(index) {
  if (!verificarAcceso(["admin"])) return;
  const ventas = obtenerVentasStorage();
  const venta = ventas[index];
  if (!venta) return alert("Venta no encontrada.");

  // Cargar datos al formulario
  document.getElementById("cliente").value = venta.cliente;
  document.getElementById("formaPago").value = venta.formaPago;
  detallePagoMixtoActual = normalizarDetallePagos(venta.detallePagos || venta.pagos || [], obtenerTotalCobradoVenta(venta));
  document.getElementById("tipoPedido").value = venta.tipoPedido;
  const costoDomicilioInput = document.getElementById("costoDomicilio");
  if (costoDomicilioInput) costoDomicilioInput.value = Number(venta.costoDomicilio || 0) > 0 ? Number(venta.costoDomicilio || 0) : "";
  document.getElementById("observaciones").value = venta.observaciones || "";

  actualizarCampoCostoDomicilio();

  // Cargar productos
  pedido = [...venta.pedido];
  actualizarTotal();
  actualizarVistaPedido();

    // Conservar la venta original para actualizarla sin duplicar
  comandaEnEdicion = venta.comanda ?? null;
  reciboEnEdicion = venta.recibo ?? venta.comanda ?? null;
  ventaDocIdEnEdicion = venta._docId ?? null;
  ventaOriginalEnEdicion = { ...venta };

  mostrarVentas();
  irAPasoVenta(3);
  alert("Venta cargada para edición. Haz los cambios y presiona 'Guardar Venta'.");
}


function filtrarVentasPorCliente() {
  paginaVentasActual = 1;
  renderVentasTabla();
}

async function abrirHistoricos() {
  if (!verificarAcceso(["admin", "administrador"])) return;
  const appMain = document.getElementById("appMain");
  const historicosVista = document.getElementById("historicosVista");
  const cajaVista = document.getElementById("cajaVista");
  const domiciliosVista = document.getElementById("domiciliosVista");
  if (appMain) appMain.classList.add("hidden");
  if (cajaVista) cajaVista.classList.add("hidden");
  if (domiciliosVista) domiciliosVista.classList.add("hidden");
  if (historicosVista) historicosVista.classList.remove("hidden");
  actualizarHistoricos();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function abrirCajaVista() {
  if (!tieneRolValido()) return alert("No tienes permiso para acceder al cierre del día.");
  const appMain = document.getElementById("appMain");
  const historicosVista = document.getElementById("historicosVista");
  const cajaVista = document.getElementById("cajaVista");
  const domiciliosVista = document.getElementById("domiciliosVista");
  if (appMain) appMain.classList.add("hidden");
  if (historicosVista) historicosVista.classList.add("hidden");
  if (domiciliosVista) domiciliosVista.classList.add("hidden");
  if (cajaVista) cajaVista.classList.remove("hidden");
  await renderControlCajaDiaActual(true);
  await renderTablaCierresCaja(true);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function volverAlPOS() {
  const appMain = document.getElementById("appMain");
  const historicosVista = document.getElementById("historicosVista");
  const cajaVista = document.getElementById("cajaVista");
  const domiciliosVista = document.getElementById("domiciliosVista");
  if (historicosVista) historicosVista.classList.add("hidden");
  if (cajaVista) cajaVista.classList.add("hidden");
  if (domiciliosVista) domiciliosVista.classList.add("hidden");
  if (appMain) appMain.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}


    window.onload = async () => {
      mostrarVentas();
      actualizarResumenMovil();
      aplicarPermisosPorRol();
      prepararBotonesBebidaParaAlertas();
      inventarioBebidasEstado = obtenerMapaInventarioLocal();
      actualizarAlertasStockBebidas(inventarioBebidasEstado);
      window.addEventListener('storage', (event) => {
        if (event.key === INVENTARIO_STORAGE_KEY) {
          inventarioBebidasEstado = obtenerMapaInventarioLocal();
          actualizarAlertasStockBebidas(inventarioBebidasEstado);
        }
      });
      const tipoPedidoSelect = document.getElementById("tipoPedido");
      const formaPagoSelect = document.getElementById("formaPago");
      const costoDomicilioInput = document.getElementById("costoDomicilio");
      if (tipoPedidoSelect) tipoPedidoSelect.addEventListener("change", actualizarCampoCostoDomicilio);
      if (formaPagoSelect) formaPagoSelect.addEventListener("change", manejarCambioFormaPago);
      if (costoDomicilioInput) {
        costoDomicilioInput.addEventListener("input", () => {
          actualizarTotal();
          actualizarVistaPedido();
        });
      }
      actualizarCampoCostoDomicilio();
      await inicializarFirebaseVentas();
      await renderControlCajaDiaActual(false);
      renderTablaCierresCaja(false);
      document.querySelectorAll('#modalAperturaCaja, #modalCierreCaja, #modalDineroEsperado, #modalPagoMixto').forEach(modal => {
        modal?.addEventListener('click', (event) => {
          if (event.target === modal) cerrarModalCaja(modal.id);
        });
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          ['modalAperturaCaja', 'modalCierreCaja', 'modalDineroEsperado'].forEach(cerrarModalCaja);
          cerrarModalPagoMixto();
        }
      });
      const loginUsuario = document.getElementById("loginUsuario");
      const loginClave = document.getElementById("loginClave");
      [loginUsuario, loginClave].forEach(campo => {
        if (!campo) return;
        campo.addEventListener("keydown", (event) => {
          if (event.key === "Enter") iniciarSesion();
        });
      });
    };
