let pedido = [];
  let total = 0;
let comandaEnEdicion = null; // conserva la comanda al editar
let reciboEnEdicion = null; // conserva el recibo al editar
const usuariosSistema = {
  admin: { email: "admin@local.io", rol: "admin", nombre: "Administrador" },
  cajero: { email: "cajero@local.io", rol: "cajero", nombre: "Cajero 1" }
};
const usuariosPorEmail = Object.fromEntries(Object.entries(usuariosSistema).map(([usuario, info]) => [String(info.email || '').toLowerCase(), { ...info, usuario }]));
let rolActual = localStorage.getItem("rolActual") || "";
let usuarioActual = localStorage.getItem("usuarioActual") || "";
let sesionActiva = false;
let ventaDocIdEnEdicion = null;
let ventaOriginalEnEdicion = null;
let ventasCache = JSON.parse(localStorage.getItem("ventas") || "[]");
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
let controlCajaCache = JSON.parse(localStorage.getItem(CONTROL_CAJA_STORAGE_KEY) || "{}");
let controlCajaFirebasePermisosDisponibles = true;
let controlCajaFirebasePermisosAvisados = false;
const INVENTARIO_STORAGE_KEY = "inventarioCocina";
const INVENTARIO_COLLECTION = "inventario";
const STOCK_BEBIDA_BAJO_UMBRAL = 5;
let inventarioUnsubscribe = null;
let inventarioBebidasEstado = {};
let inventarioPermisosAvisados = false;


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
      localStorage.setItem(INVENTARIO_STORAGE_KEY, JSON.stringify(items));
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

const PRODUCTOS_BEBIDA_INVENTARIO = new Set([
  'QUATRO', 'COCA COLA 400 ml', 'COCA COLA 250 ml', 'JUGO HIT 500 ml', 'SPRITE', 'COCA COLA ZERO',
  'BRISA LIMON', 'BRISA MANZANA', 'MISTER TEA', 'AGUA CON GAS', 'AGUA SABORISADA', 'POSTOBON 400 ml',
  'POSTOBON 250 ml', 'POSTOBON 1.5', 'SODA BRETAÑA', 'GATORADE', 'PREMIO 400 ml', 'PREMIO 1.5l',
  'QUATRO 1.5L', 'COCA COLA 1.5L', 'JUGO HIT 1.L', 'SPRITE 1.5L', 'COCA COLA ZERO 1.5L', 'AGUA',
  'MILO CALIENTE', 'CAFE CON LECHE', 'TINTO', 'CERVEZA POKER', 'CERVEZA CORONA'
].map(normalizarClaveInventario));

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
      localStorage.setItem(INVENTARIO_STORAGE_KEY, JSON.stringify(inventarioLocal));
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
        const actual = Number(fresh.data()?.cantidad || 0);
        const nuevaCantidad = Math.max(0, actual + Number(ajuste.cantidad || 0));
        transaction.update(doc.ref, {
          cantidad: nuevaCantidad,
          fecha: obtenerFechaLocalISO(new Date())
        });
      });
    } catch (error) {
      console.error(`No se pudo ajustar el inventario en Firebase para ${ajuste.nombre}:`, error);
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
  try {
    const ventaLista = normalizarVenta(venta);
    localStorage.setItem(ULTIMA_VENTA_GUARDADA_KEY, JSON.stringify(ventaLista));
  } catch (error) {
    console.error("No se pudo guardar la referencia de la última venta:", error);
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

function normalizarControlCaja(control = {}, diaClave = "") {
  return {
    diaClave: control.diaClave || diaClave || "",
    aperturaMonto: Number(control.aperturaMonto || 0),
    aperturaHora: control.aperturaHora || "",
    aperturaUsuario: control.aperturaUsuario || "",
    cierreMonto: Number(control.cierreMonto || 0),
    cierreHora: control.cierreHora || "",
    cierreUsuario: control.cierreUsuario || "",
    cierreObservaciones: control.cierreObservaciones || ""
  };
}

function guardarControlCajaEnCache(control = {}) {
  const diaClave = control?.diaClave;
  if (!diaClave) return null;
  controlCajaCache = { ...controlCajaCache, [diaClave]: normalizarControlCaja(control, diaClave) };
  localStorage.setItem(CONTROL_CAJA_STORAGE_KEY, JSON.stringify(controlCajaCache));
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
  controlCajaFirebasePermisosDisponibles = false;
  if (controlCajaFirebasePermisosAvisados) return;
  controlCajaFirebasePermisosAvisados = true;
  console.warn("Control de caja funcionando en modo local. Firebase no tiene permisos para la colección controlCaja.", error);
}

async function obtenerControlCajaDia(diaClave, forzarRemoto = false) {
  const local = obtenerControlCajaLocal(diaClave);
  if (!forzarRemoto && ((local.aperturaHora || local.cierreHora) || !firestoreDisponible || !firestoreDb)) {
    return local;
  }
  if (!firestoreDisponible || !firestoreDb || !controlCajaFirebasePermisosDisponibles) return local;
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
  const control = normalizarControlCaja({ ...payload, diaClave }, diaClave);
  guardarControlCajaEnCache(control);
  if (firestoreDisponible && firestoreDb && controlCajaFirebasePermisosDisponibles) {
    try {
      await firestoreDb.collection("controlCaja").doc(diaClave).set(control, { merge: true });
      controlCajaFirebasePermisosDisponibles = true;
      registrarHeartbeatFirebase();
    } catch (error) {
      if (esErrorPermisoFirestore(error)) {
        desactivarFirebaseCajaPorPermisos(error);
      } else {
        console.error("No se pudo guardar el control de caja en Firebase:", error);
      }
    }
  }
  return control;
}

function obtenerVentasActivasDelDia(diaClave) {
  return filtrarVentasActivas(obtenerVentasNormalizadas().filter(v => v.diaClave === diaClave));
}

function calcularResumenCajaDia(diaClave) {
  const ventasActivas = obtenerVentasActivasDelDia(diaClave);
  const totalVentas = ventasActivas.reduce((acc, venta) => acc + obtenerIngresoRealVenta(venta), 0);
  const totalEfectivo = ventasActivas
    .filter(venta => String(venta.formaPago || "").toLowerCase() === "efectivo")
    .reduce((acc, venta) => acc + obtenerIngresoRealVenta(venta), 0);
  const domicilios = ventasActivas.filter(venta => esPedidoDomicilio(venta)).length;
  const ajusteDomiciliosTransferencia = ventasActivas
    .filter(venta => esPedidoDomicilio(venta) && esPagoTransferencia(venta))
    .reduce((acc, venta) => acc + obtenerValorDomicilio(venta), 0);
  const efectivoNetoSistema = totalEfectivo - ajusteDomiciliosTransferencia;
  return {
    cantidadVentas: ventasActivas.length,
    totalVentas,
    totalEfectivo,
    domicilios,
    ajusteDomiciliosTransferencia,
    efectivoNetoSistema,
    montoEsperado: efectivoNetoSistema
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
  const diferencia = control.cierreHora ? Number(control.cierreMonto || 0) - esperado : 0;

  const aperturaEstadoTexto = document.getElementById('aperturaCajaEstadoTexto');
  const cierreEstadoTexto = document.getElementById('cierreCajaEstadoTexto');
  const dineroEsperadoResumenTexto = document.getElementById('dineroEsperadoResumenTexto');
  const aperturaInfoModal = document.getElementById('aperturaCajaInfoModal');
  const cierreInfoModal = document.getElementById('cierreCajaInfoModal');
  const btnApertura = document.getElementById('btnRegistrarAperturaCaja');
  const btnCierre = document.getElementById('btnRegistrarCierreCaja');
  const btnEliminarCierreActual = document.getElementById('btnEliminarCierreCajaActual');
  const inputApertura = document.getElementById('aperturaCajaMonto');
  const inputCierre = document.getElementById('cierreCajaMonto');
  const inputObs = document.getElementById('cierreCajaObservaciones');

  if (aperturaEstadoTexto) {
    aperturaEstadoTexto.textContent = control.aperturaHora
      ? `Registrada: ${formatearCOP(control.aperturaMonto)}`
      : 'Haz clic para registrar apertura';
  }
  if (cierreEstadoTexto) {
    cierreEstadoTexto.textContent = control.cierreHora
      ? `Registrado: ${formatearCOP(control.cierreMonto)}`
      : 'Haz clic para registrar cierre';
  }
  if (dineroEsperadoResumenTexto) {
    dineroEsperadoResumenTexto.textContent = `${formatearCOP(esperado)} · ajuste domicilios transferencia -${formatearCOP(resumen.ajusteDomiciliosTransferencia || 0)} · ${control.cierreHora ? `diferencia ${formatearCOP(diferencia)}` : 'ver detalle completo'}`;
  }

  if (aperturaInfoModal) aperturaInfoModal.textContent = control.aperturaHora
    ? `Registrada el ${formatearFechaHoraColombia(control.aperturaHora)} por ${control.aperturaUsuario || 'Sin usuario'}`
    : 'Aún no registrada para hoy.';

  if (cierreInfoModal) cierreInfoModal.textContent = control.cierreHora
    ? `Registrado el ${formatearFechaHoraColombia(control.cierreHora)} por ${control.cierreUsuario || 'Sin usuario'}`
    : 'Aún no registrado para hoy.';

  if (btnApertura) btnApertura.textContent = control.aperturaHora ? 'Actualizar apertura' : 'Guardar apertura';
  if (btnCierre) btnCierre.textContent = control.cierreHora ? 'Actualizar cierre' : 'Guardar cierre';
  if (btnEliminarCierreActual) {
    const mostrar = esAdmin() && Boolean(control.cierreHora);
    btnEliminarCierreActual.classList.toggle('hidden', !mostrar);
    btnEliminarCierreActual.style.display = mostrar ? '' : 'none';
  }
  if (inputApertura && document.activeElement !== inputApertura) inputApertura.value = control.aperturaMonto ? String(control.aperturaMonto) : '';
  if (inputCierre && document.activeElement !== inputCierre) inputCierre.value = control.cierreMonto ? String(control.cierreMonto) : '';
  if (inputObs && document.activeElement !== inputObs) inputObs.value = control.cierreObservaciones || '';

  renderContenidoModalDineroEsperado(control, resumen);
  actualizarTarjetasEstadoCaja(control, resumen);
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
  if (!["modalAperturaCaja", "modalCierreCaja", "modalDineroEsperado"].some(modalId => !document.getElementById(modalId)?.classList.contains('hidden'))) {
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
  await renderControlCajaDiaActual(true);
  abrirModalCaja('modalCierreCaja');
}

async function abrirModalDineroEsperado() {
  if (!verificarAcceso(["admin", "cajero"])) return;
  await renderControlCajaDiaActual(true);
  abrirModalCaja('modalDineroEsperado');
}

function renderContenidoModalDineroEsperado(control = {}, resumen = {}) {
  const contenedor = document.getElementById('contenidoModalDineroEsperado');
  if (!contenedor) return;
  const esperado = Number(control.aperturaMonto || 0) + Number(resumen.efectivoNetoSistema || 0);
  const diferencia = control.cierreHora ? Number(control.cierreMonto || 0) - esperado : 0;
  contenedor.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
      <div class="rounded-xl border border-blue-100 bg-blue-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Apertura</p>
        <p class="text-xl font-extrabold text-gray-800 mt-1">${control.aperturaHora ? formatearCOP(control.aperturaMonto) : 'Sin registro'}</p>
        <p class="text-xs text-gray-500 mt-1">${control.aperturaHora ? `${formatearFechaHoraColombia(control.aperturaHora)} · ${control.aperturaUsuario || 'Sin usuario'}` : 'Primero registra la apertura'}</p>
      </div>
      <div class="rounded-xl border border-blue-100 bg-blue-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Efectivo del sistema</p>
        <p class="text-xl font-extrabold text-gray-800 mt-1">${formatearCOP(resumen.totalEfectivo)}</p>
        <p class="text-xs text-gray-500 mt-1">Ventas activas pagadas en efectivo, sin domicilios</p>
      </div>
      <div class="rounded-xl border border-amber-100 bg-amber-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Ajuste domicilios transferencia</p>
        <p class="text-xl font-extrabold text-amber-700 mt-1">-${formatearCOP(resumen.ajusteDomiciliosTransferencia || 0)}</p>
        <p class="text-xs text-gray-500 mt-1">Se descuenta del efectivo esperado porque ese valor queda en transferencias</p>
      </div>
      <div class="rounded-xl border border-blue-100 bg-blue-50 p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Dinero esperado</p>
        <p class="text-xl font-extrabold text-blue-700 mt-1">${formatearCOP(esperado)}</p>
        <p class="text-xs text-gray-500 mt-1">Apertura + efectivo del sistema - domicilios por transferencia</p>
      </div>
      <div class="rounded-xl border ${control.cierreHora ? (diferencia === 0 ? 'border-green-100 bg-green-50' : 'border-red-100 bg-red-50') : 'border-gray-200 bg-gray-50'} p-4">
        <p class="text-xs uppercase tracking-wide text-gray-500">Diferencia al cierre</p>
        <p class="text-xl font-extrabold mt-1 ${control.cierreHora ? (diferencia === 0 ? 'text-green-700' : 'text-red-700') : 'text-gray-700'}">${control.cierreHora ? formatearCOP(diferencia) : 'Pendiente'}</p>
        <p class="text-xs text-gray-500 mt-1">${control.cierreHora ? `Cierre registrado por ${control.cierreUsuario || 'Sin usuario'}` : 'Se calcula cuando registres el cierre'}</p>
      </div>
    </div>
    <div class="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
      <p><strong>Ventas activas del día:</strong> ${resumen.cantidadVentas || 0}</p>
      <p><strong>Domicilios del día:</strong> ${resumen.domicilios || 0}</p>
      <p><strong>Total vendido activo:</strong> ${formatearCOP(resumen.totalVentas || 0)} <span class="text-xs text-gray-500">(sin domicilios)</span></p>
      <p><strong>Ajuste por domicilios pagados por transferencia:</strong> -${formatearCOP(resumen.ajusteDomiciliosTransferencia || 0)}</p>
      ${control.cierreObservaciones ? `<p class="mt-2"><strong>Observaciones del cierre:</strong> ${control.cierreObservaciones}</p>` : ''}
    </div>
  `;
}

async function obtenerTodosLosControlesCaja(forzarRemoto = false) {
  if (forzarRemoto && firestoreDisponible && firestoreDb && controlCajaFirebasePermisosDisponibles) {
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
  return Object.values(controlCajaCache || {})
    .map(control => normalizarControlCaja(control, control?.diaClave || ''))
    .filter(control => control.diaClave)
    .sort((a, b) => String(b.diaClave).localeCompare(String(a.diaClave)));
}

async function renderTablaCierresCaja(forzarRemoto = false) {
  const body = document.getElementById('cierresCajaBody');
  if (!body) return;
  const controles = await obtenerTodosLosControlesCaja(forzarRemoto);
  const cierres = controles.filter(control => control.cierreHora);
  if (!cierres.length) {
    body.innerHTML = '<tr><td colspan="9" class="p-3 text-center text-gray-500">No hay cierres de caja registrados todavía.</td></tr>';
    return;
  }
  body.innerHTML = cierres.map(control => {
    const resumen = calcularResumenCajaDia(control.diaClave);
    const esperado = Number(control.aperturaMonto || 0) + Number(resumen.efectivoNetoSistema || 0);
    const diferencia = Number(control.cierreMonto || 0) - esperado;
    const claseDiferencia = diferencia === 0 ? 'text-green-700' : 'text-red-700';
    const acciones = esAdmin()
      ? `<button type="button" onclick="eliminarCierreCaja('${control.diaClave}')" class="bg-red-100 hover:bg-red-200 text-red-700 px-3 py-1 rounded-lg font-semibold text-xs">🗑️ Borrar cierre</button>`
      : '-';
    return `
      <tr>
        <td class="p-2 border">${control.diaClave}</td>
        <td class="p-2 border">${formatearCOP(control.aperturaMonto)}</td>
        <td class="p-2 border">${formatearCOP(control.cierreMonto)}</td>
        <td class="p-2 border">${formatearCOP(resumen.totalEfectivo)}</td>
        <td class="p-2 border">${formatearCOP(esperado)}<div class="text-[11px] text-gray-500 mt-1">- ${formatearCOP(resumen.ajusteDomiciliosTransferencia || 0)} domicilios transferencia</div></td>
        <td class="p-2 border font-semibold ${claseDiferencia}">${formatearCOP(diferencia)}</td>
        <td class="p-2 border">${control.aperturaUsuario || '-'}</td>
        <td class="p-2 border">${control.cierreUsuario || '-'}</td>
        <td class="p-2 border text-center">${acciones}</td>
      </tr>
    `;
  }).join('');
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
  if (!verificarAcceso(["admin", "cajero"])) return;
  const diaClave = obtenerFechaLocalISO(new Date());
  const actual = await obtenerControlCajaDia(diaClave, true);
  if (!actual.aperturaHora) {
    alert('Primero registra la apertura de caja del día.');
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
  alert('Cierre de caja registrado.');
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
  if (!actual.cierreHora) {
    alert('Ese día no tiene un cierre registrado.');
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
  const diaClave = obtenerFechaLocalISO(new Date());
  await eliminarCierreCaja(diaClave);
}

async function renderResumenCajaFecha(diaClave, forzarRemoto = false) {
  const contenedor = document.getElementById('resumenCajaFechaSeleccionada');
  if (!contenedor) return;
  const control = await obtenerControlCajaDia(diaClave, forzarRemoto);
  const resumen = calcularResumenCajaDia(diaClave);
  const esperado = Number(control.aperturaMonto || 0) + Number(resumen.efectivoNetoSistema || 0);
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
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
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
        <p class="text-xs uppercase tracking-wide text-gray-500">Efectivo del sistema</p>
        <p class="text-lg font-extrabold text-gray-800 mt-1">${formatearCOP(resumen.totalEfectivo)}</p>
        <p class="text-xs text-gray-500 mt-1">${resumen.cantidadVentas} venta(s) activas, sin domicilios</p>
      </div>
      <div class="rounded-xl border border-amber-100 bg-amber-50 p-3">
        <p class="text-xs uppercase tracking-wide text-gray-500">Ajuste domicilios transferencia</p>
        <p class="text-lg font-extrabold text-amber-700 mt-1">-${formatearCOP(resumen.ajusteDomiciliosTransferencia || 0)}</p>
        <p class="text-xs text-gray-500 mt-1">Se descuenta del efectivo esperado porque ese valor queda en transferencias</p>
      </div>
      <div class="rounded-xl border border-yellow-100 bg-yellow-50 p-3">
        <p class="text-xs uppercase tracking-wide text-gray-500">Efectivo esperado</p>
        <p class="text-lg font-extrabold text-gray-800 mt-1">${formatearCOP(esperado)}</p>
        <p class="text-xs text-gray-500 mt-1">Apertura + efectivo del sistema - domicilios transferencia</p>
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

window.addEventListener("online", () => {
  actualizarIndicadorFirebase("verificando", "Reconectando con Firebase...");
});

window.addEventListener("offline", () => {
  actualizarIndicadorFirebase("desconectado", "Sin conexión a internet");
});

const firebaseConfig = {
  apiKey: "AIzaSyDxrAJcH5AAxIAK2rRWD61aSQklaH--dT0",
  authDomain: "prsenorarepa.firebaseapp.com",
  projectId: "prsenorarepa",
  storageBucket: "prsenorarepa.firebasestorage.app",
  messagingSenderId: "55349021122",
  appId: "1:55349021122:web:e4c65b2f2911bd2c4eee5b",
  measurementId: "G-8JGY4PVMMV"
};


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
  return `${valor}@prsenorarepa.com`;
}

function aplicarSesionAutenticada(usuario, rol, email) {
  usuarioActual = usuario || "";
  rolActual = rol || "";
  sesionActiva = Boolean(usuarioActual && rolActual);
  localStorage.setItem("usuarioActual", usuarioActual);
  localStorage.setItem("rolActual", rolActual);
  localStorage.setItem("sesionActiva", String(sesionActiva));
  localStorage.setItem("usuarioEmailActual", email || "");
  aplicarPermisosPorRol();
}

function limpiarSesionLocal() {
  rolActual = "";
  usuarioActual = "";
  sesionActiva = false;
  localStorage.removeItem("rolActual");
  localStorage.removeItem("usuarioActual");
  localStorage.removeItem("usuarioEmailActual");
  localStorage.setItem("sesionActiva", "false");
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
  copia._localId = String(copia._localId || copia._docId || '').trim() || null;
  copia._syncEstado = copia._syncEstado === 'pendiente' ? 'pendiente' : 'sincronizado';
  copia.total = copia.subtotalProductos;
  return copia;
}

function guardarVentasEnCache(ventas) {
  ventasCache = Array.isArray(ventas) ? ventas.map(normalizarVenta) : [];
  localStorage.setItem("ventas", JSON.stringify(ventasCache));
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
    ajustesInventario: item?.ajustesInventario || {}
  }));
  localStorage.setItem(VENTAS_PENDIENTES_SYNC_KEY, JSON.stringify(lista));
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
  actualizarIndicadorFirebase("verificando", "Iniciando conexión con Firebase...");
  iniciarMonitorConexionFirebase();
  if (!window.firebase) {
    actualizarIndicadorFirebase("desconectado", "SDK de Firebase no disponible");
    return;
  }
  try {
    firebaseApp = firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(firebaseConfig);
    firebaseAuth = firebase.auth(firebaseApp);
    firestoreDb = firebase.firestore(firebaseApp);
    authDisponible = Boolean(firebaseAuth);
    firestoreDisponible = Boolean(firestoreDb);
    firebaseAuth.onAuthStateChanged((user) => {
      if (user) {
        const email = String(user.email || '').toLowerCase();
        const registro = resolverRegistroUsuario(email) || resolverRegistroUsuario(user.displayName || '') || { usuario: email.split('@')[0], rol: 'cajero', nombre: user.displayName || email };
        aplicarSesionAutenticada(registro.usuario || email.split('@')[0], registro.rol || 'cajero', user.email || '');
        escucharVentasFirestore();
        escucharInventarioFirestore();
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
        inventarioBebidasEstado = obtenerMapaInventarioLocal();
        actualizarAlertasStockBebidas(inventarioBebidasEstado);
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
  if (!firestoreDisponible || !firestoreDb || !ventasLocales.length) return;
  for (const venta of ventasLocales) {
    const limpia = normalizarVenta(venta);
    delete limpia._docId;
    await firestoreDb.collection("ventas").add(limpia);
  }
}

async function guardarVentaEnFirebase(venta, docId = null) {
  if (!firestoreDisponible || !firestoreDb) {
    throw new Error("Firebase no está disponible.");
  }
  const limpia = normalizarVenta(venta);
  delete limpia._docId;
  delete limpia._syncEstado;

  if (docId) {
    await firestoreDb.collection("ventas").doc(docId).set(limpia, { merge: true });
    registrarHeartbeatFirebase();
    return docId;
  }

  const ref = await firestoreDb.collection("ventas").add(limpia);
  registrarHeartbeatFirebase();
  return ref.id;
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

function esCajero() {
  return rolActual === "cajero";
}

function tieneRolValido() {
  return esAdmin() || esCajero();
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
  limpiarSesionLocal();
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

  const rolLabel = rolActual ? (rolActual === "admin" ? "Admin" : "Cajero") : "Sin rol";
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

  const btnExportarExcel = document.getElementById('btnExportarExcel');
  if (btnExportarExcel) {
    btnExportarExcel.classList.toggle('hidden', !esAdmin());
    btnExportarExcel.style.display = esAdmin() ? '' : 'none';
  }

  const bloqueado = !tieneRolValido();
  document.querySelectorAll('button, input, select').forEach(el => {
    if (el.closest('#loginScreen')) return;
    if (el.id === 'filtroCliente') return;
    if (el.closest('#ventasSeccion')) return;
    if (el.closest('[data-role="admin-only"]') && esAdmin()) return;
    if ((el.textContent || '').includes('Cerrar sesión')) return;
    el.disabled = bloqueado;
    el.classList.toggle('opacity-50', bloqueado);
    el.classList.toggle('cursor-not-allowed', bloqueado);
  });

  const resumen = document.getElementById('resumenProductos');
  if (resumen && !esAdmin()) {
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
  actualizarCampoCostoDomicilio();
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

    try {
      const esVentaNueva = !ventaDocIdEnEdicion;
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
      console.error("Error al guardar la venta:", error);
      alert("No se pudo guardar la venta. Revisa la conexión o la configuración de Firebase.");
    }
  }

  // Muestra las ventas guardadas en la tabla
  const VENTAS_POR_PAGINA = 15;
  let paginaVentasActual = 1;

  function construirFilaVenta(v, i) {
    const resumen = {};
    v.pedido.forEach(p => {
      resumen[p.nombre] = (resumen[p.nombre] || 0) + 1;
    });

    const ventaCancelada = esVentaCancelada(v);
    const productosResumen = Object.entries(resumen)
      .map(([prod, cant]) => `${prod}: ${cant}`)
      .join("<br>");

    const botonesAccion = `
      <button onclick="imprimirVentaCliente(${i})" class="bg-purple-500 text-white px-2 py-1 rounded text-xs">🧾 Cliente</button>
      <button onclick="imprimirVentaCocina(${i})" class="bg-blue-500 text-white px-2 py-1 rounded text-xs">👨‍🍳 Cocina</button>
      ${ventaCancelada ? `<span class="inline-flex items-center px-2 py-1 rounded text-xs font-bold bg-red-100 text-red-700">Cancelada</span>` : `<button onclick="marcarVentaComoCancelada(${i})" class="bg-red-500 text-white px-2 py-1 rounded text-xs">❌ Cancelar</button>`}
      ${esAdmin() ? `<button onclick="editarVenta(${i})" class="bg-yellow-600 text-white px-2 py-1 rounded text-xs">📝 Editar</button>` : ""}
    `;

    return `
      <tr class="${ventaCancelada ? 'bg-red-50 text-gray-500' : ''}">
        <td class='border p-1'>${v.comanda ?? v.recibo ?? (i + 1)}</td>
        <td class='border p-1'>${formatearFechaHoraColombia(v.fechaISO || v.fecha)}</td>
        <td class='border p-1'>${v.cliente}</td>
        <td class='border p-1'>${v.formaPago}</td>
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
      `;
    }

    return `
      <article class="${ventaCancelada ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'} border rounded-2xl p-4 shadow-sm">
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
          <div class="bg-white rounded-xl p-2 border border-yellow-100"><span class="text-gray-500 block text-xs">Pago</span><strong>${v.formaPago || '-'}</strong></div>
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
      : `<tr><td colspan="9" class="border p-3 text-center text-gray-500">No hay ventas del día para mostrar.</td></tr>`;

    const contenedorMobile = document.getElementById("ventasGuardadasMobile");
    if (contenedorMobile) {
      contenedorMobile.innerHTML = ventasPagina.length
        ? ventasPagina.map(({ venta, index }) => construirTarjetaVenta(venta, index)).join("")
        : `<div class="bg-white border border-yellow-200 rounded-2xl p-4 text-center text-gray-500">No hay ventas del día para mostrar.</div>`;
    }

    actualizarControlesPaginacion(ventasFiltradas.length);
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
    if (!verificarAcceso(["admin"])) return;
    if (confirm("¿Estás seguro de borrar todas las ventas?")) {
      try {
        if (firestoreDisponible) {
          await borrarTodasLasVentasEnFirebase();
        }
        guardarVentasEnCache([]);
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
    if (!verificarAcceso(["admin"])) return;
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
          formaPago,
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
    if (!verificarAcceso(["admin"])) return;
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

function abrirVentanaImpresion(contenido, titulo = 'Impresión') {
  const w = window.open('', '_blank', 'width=420,height=720');
  if (!w) {
    alert('No se pudo abrir la ventana de impresión. Revisa el bloqueador de ventanas emergentes.');
    return;
  }
  w.document.open();
  w.document.write(contenido);
  w.document.close();
  w.focus();
  w.print();
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
        <p><strong>Método de pago:</strong> ${venta?.formaPago || '-'}</p>
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
        <p><strong>Método de pago:</strong> ${venta?.formaPago || '-'}</p>
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

  abrirVentanaImpresion(
    generarPlantillaComanda(ultimaVenta, ultimaVenta.comanda ?? ultimaVenta.recibo ?? 1),
    'Pedido Cocina'
  );
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

async function marcarVentaComoCancelada(index) {
  if (!verificarAcceso(["admin", "cajero"])) return;
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
  if (!esAdmin()) return alert("No tienes permiso para acceder a históricos.");
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
      const costoDomicilioInput = document.getElementById("costoDomicilio");
      if (tipoPedidoSelect) tipoPedidoSelect.addEventListener("change", actualizarCampoCostoDomicilio);
      if (costoDomicilioInput) {
        costoDomicilioInput.addEventListener("input", () => {
          actualizarTotal();
          actualizarVistaPedido();
        });
      }
      actualizarCampoCostoDomicilio();
      await inicializarFirebaseVentas();
      await renderControlCajaDiaActual(true);
      renderTablaCierresCaja(false);
      document.querySelectorAll('#modalAperturaCaja, #modalCierreCaja, #modalDineroEsperado').forEach(modal => {
        modal?.addEventListener('click', (event) => {
          if (event.target === modal) cerrarModalCaja(modal.id);
        });
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          ['modalAperturaCaja', 'modalCierreCaja', 'modalDineroEsperado'].forEach(cerrarModalCaja);
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

// --- Numeración diaria e históricos ---
  const TIMEZONE_CO = 'America/Bogota';

  function obtenerPartesColombia(fecha = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE_CO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(fecha)).filter(p => p.type !== 'literal').map(p => [p.type, p.value])
    );
    return parts;
  }

  function obtenerFechaLocalISO(fecha = new Date()) {
    const partes = obtenerPartesColombia(fecha);
    return `${partes.year}-${partes.month}-${partes.day}`;
  }

  function formatearFechaHoraColombia(fecha) {
    const fechaObj = new Date(fecha);
    if (isNaN(fechaObj.getTime())) return String(fecha || '-');
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: TIMEZONE_CO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(fechaObj);
  }

  function formatearHoraColombia(fecha) {
    const fechaObj = new Date(fecha);
    if (isNaN(fechaObj.getTime())) return '-';
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: TIMEZONE_CO,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(fechaObj);
  }

  function obtenerClaveSemana(fecha) {
    const partes = obtenerPartesColombia(fecha);
    const d = new Date(Date.UTC(Number(partes.year), Number(partes.month) - 1, Number(partes.day)));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-S${String(weekNo).padStart(2, '0')}`;
  }

  function formatearDinero(valor) {
    return `$${Number(valor || 0).toLocaleString('es-CO')}`;
  }

  function obtenerSiguienteNumeracionDelDia(diaClave) {
    const key = `numeracionDia_${diaClave}`;
    const actual = JSON.parse(localStorage.getItem(key) || '{"comanda":0,"recibo":0}');
    const siguiente = {
      comanda: Number(actual.comanda || 0) + 1,
      recibo: Number(actual.recibo || 0) + 1
    };
    localStorage.setItem(key, JSON.stringify(siguiente));
    return siguiente;
  }

  function normalizarVenta(v, index) {
    const fechaBase = v.fechaISO ? new Date(v.fechaISO) : new Date(v.fecha);
    const fechaValida = isNaN(fechaBase.getTime()) ? new Date() : fechaBase;
    const diaClave = v.diaClave || obtenerFechaLocalISO(fechaValida);
    const pedidoNormalizado = Array.isArray(v.pedido)
      ? v.pedido.map(p => ({ nombre: p.nombre, precio: Number(p.precio || 0) }))
      : [];
    const subtotalCalculado = pedidoNormalizado.reduce((acc, p) => acc + Number(p.precio || 0), 0);
    const subtotalBase = subtotalCalculado > 0
      ? subtotalCalculado
      : Number(v.subtotalProductos ?? v.total ?? 0);
    const subtotalProductos = Number.isFinite(subtotalBase) && subtotalBase >= 0 ? subtotalBase : 0;
    const costoDomicilio = Number(v.costoDomicilio || 0);
    const numeroDomicilio = Number(v.numeroDomicilio || 0);
    return {
      ...v,
      pedido: pedidoNormalizado,
      estado: obtenerEstadoVenta(v),
      fechaISO: v.fechaISO || fechaValida.toISOString(),
      diaClave,
      comanda: v.comanda ?? v.recibo ?? (index + 1),
      recibo: v.recibo ?? v.comanda ?? (index + 1),
      subtotalProductos,
      numeroDomicilio: Number.isFinite(numeroDomicilio) && numeroDomicilio > 0 ? numeroDomicilio : null,
      costoDomicilio,
      total: subtotalProductos
    };
  }

  function obtenerVentasNormalizadas() {
    const ventas = obtenerVentasStorage();
    return ventas.map((v, i) => normalizarVenta(v, i));
  }

  function esPagoEfectivo(venta = {}) {
    return String(venta?.formaPago || '').trim().toLowerCase() === 'efectivo';
  }

  function esPagoTransferencia(venta = {}) {
    return !esPagoEfectivo(venta);
  }

  function obtenerEtiquetaPagoDomicilio(venta = {}) {
    return esPagoEfectivo(venta) ? 'Efectivo' : 'Transferencia';
  }

  function obtenerValorDomicilio(venta = {}) {
    const valor = Number(venta?.costoDomicilio || 0);
    return Number.isFinite(valor) && valor > 0 ? valor : 0;
  }

  function obtenerIngresoRealVenta(venta = {}) {
    const pedido = Array.isArray(venta?.pedido) ? venta.pedido : [];
    const subtotalCalculado = pedido.reduce((acc, p) => acc + Number(p?.precio || 0), 0);
    if (subtotalCalculado > 0) return subtotalCalculado;
    const subtotalGuardado = Number(venta?.subtotalProductos ?? venta?.total ?? 0);
    return Number.isFinite(subtotalGuardado) && subtotalGuardado > 0 ? subtotalGuardado : 0;
  }

  function refrescarVistasAnaliticasSiEstanAbiertas() {
    const historicosVista = document.getElementById('historicosVista');
    const domiciliosVista = document.getElementById('domiciliosVista');
    if (historicosVista && !historicosVista.classList.contains('hidden')) {
      actualizarHistoricos();
    }
    if (domiciliosVista && !domiciliosVista.classList.contains('hidden')) {
      actualizarDomiciliosVista();
    }
  }

  function renderHistorico(bodyId, filas, etiquetaVacia) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    body.innerHTML = "";
    if (!filas.length) {
      body.innerHTML = `<tr><td colspan="4" class="p-3 text-center text-gray-500">${etiquetaVacia}</td></tr>`;
      return;
    }
    filas.forEach(fila => {
      const pedidosTexto = `${fila.ventas}${fila.canceladas ? ` activas / ${fila.canceladas} canceladas` : ''}`;
      const domiciliosTexto = `${fila.domicilios}${fila.domiciliosCancelados ? ` activos / ${fila.domiciliosCancelados} cancelados` : ''}`;
      body.innerHTML += `
        <tr>
          <td class="p-2 border">${fila.label}</td>
          <td class="p-2 border">${pedidosTexto}</td>
          <td class="p-2 border">${domiciliosTexto}</td>
          <td class="p-2 border">${formatearDinero(fila.total)}</td>
        </tr>
      `;
    });
  }

  function formatearHora(fechaTexto) {
    return formatearHoraColombia(fechaTexto);
  }

  function resumirProductosPedido(pedido = []) {
    const resumen = {};
    pedido.forEach(p => {
      const nombre = p.nombre || 'Producto';
      resumen[nombre] = (resumen[nombre] || 0) + 1;
    });
    return Object.entries(resumen)
      .map(([nombre, cantidad]) => `${nombre} x${cantidad}`)
      .join('<br>');
  }

  function verVentasDetalladasPorFecha() {
    const input = document.getElementById('filtroHistoricoFecha');
    const body = document.getElementById('ventasDiaDetalleBody');
    const resumen = document.getElementById('resumenVentasDiaSeleccionado');
    if (!input || !body || !resumen) return;

    const fechaSeleccionada = input.value || obtenerFechaLocalISO(new Date());
    input.value = fechaSeleccionada;

    const ventas = obtenerVentasNormalizadas()
      .filter(v => v.diaClave === fechaSeleccionada)
      .sort((a, b) => {
        const aTime = new Date(a.fechaISO || a.fecha).getTime() || 0;
        const bTime = new Date(b.fechaISO || b.fecha).getTime() || 0;
        return bTime - aTime;
      });

    const ventasActivas = filtrarVentasActivas(ventas);
    const canceladas = ventas.length - ventasActivas.length;
    const domiciliosActivos = contarDomicilios(ventasActivas, true);
    const domiciliosCancelados = ventas.filter(v => esVentaCancelada(v) && esPedidoDomicilio(v)).length;
    const totalDia = ventasActivas.reduce((acc, v) => acc + obtenerIngresoRealVenta(v), 0);
    resumen.innerHTML = `<strong>Fecha consultada:</strong> ${fechaSeleccionada} &nbsp;|&nbsp; <strong>Pedidos activos:</strong> ${ventasActivas.length} &nbsp;|&nbsp; <strong>Domicilios:</strong> ${domiciliosActivos}${domiciliosCancelados ? ` activos / ${domiciliosCancelados} cancelados` : ''} &nbsp;|&nbsp; <strong>Canceladas:</strong> ${canceladas} &nbsp;|&nbsp; <strong>Total contabilizado:</strong> ${formatearDinero(totalDia)} <span class="text-xs text-gray-500">(sin domicilios)</span>`;

    body.innerHTML = '';
    if (!ventas.length) {
      body.innerHTML = `<tr><td colspan="10" class="p-3 text-center text-gray-500">No hay ventas registradas para esta fecha.</td></tr>`;
      return;
    }

    ventas.forEach(v => {
      const ventaCancelada = esVentaCancelada(v);
      body.innerHTML += `
        <tr class="${ventaCancelada ? 'bg-red-50 text-gray-500' : ''}">
          <td class="p-2 border">${v.recibo ?? '-'}</td>
          <td class="p-2 border">${v.comanda ?? '-'}</td>
          <td class="p-2 border">${formatearHoraColombia(v.fechaISO || v.fecha)}</td>
          <td class="p-2 border">${v.cliente || 'N/A'}</td>
          <td class="p-2 border">${v.formaPago || '-'}</td>
          <td class="p-2 border">${formatearTipoPedidoVisual(v)}</td>
          <td class="p-2 border">${obtenerBadgeEstadoVenta(v)}</td>
          <td class="p-2 border">${v.observaciones || '-'}</td>
          <td class="p-2 border">${resumirProductosPedido(v.pedido || [])}</td>
          <td class="p-2 border font-semibold ${ventaCancelada ? 'text-red-600' : ''}">${formatearDinero(obtenerIngresoRealVenta(v))}</td>
        </tr>
      `;
    });
  }

  async function exportarVentasDelDiaHistorico() {
    if (!verificarAcceso(["admin"])) return;
    const input = document.getElementById('filtroHistoricoFecha');
    const fechaSeleccionada = input?.value || obtenerFechaLocalISO(new Date());
    if (input && !input.value) input.value = fechaSeleccionada;

    const ventas = obtenerVentasNormalizadas().filter(v => v.diaClave === fechaSeleccionada);
    if (ventas.length === 0) {
      alert("No hay ventas registradas para la fecha seleccionada.");
      return;
    }

    await exportarVentasAExcel(ventas, `Ventas_${fechaSeleccionada}.xlsx`, `Ventas ${fechaSeleccionada}`);
  }

  function actualizarHistoricos() {
    const ventas = obtenerVentasNormalizadas();
    const hoy = obtenerFechaLocalISO(new Date());
    const ahora = new Date();
    const semanaActual = obtenerClaveSemana(ahora);
    const mesActual = hoy.slice(0, 7);

    const ventasHoy = ventas.filter(v => v.diaClave === hoy);
    const ventasSemana = ventas.filter(v => {
      const fecha = new Date(v.fechaISO || v.fecha);
      return obtenerClaveSemana(fecha) === semanaActual;
    });
    const ventasMes = ventas.filter(v => (v.diaClave || "").slice(0, 7) === mesActual);

    const ventasHoyActivas = filtrarVentasActivas(ventasHoy);
    const ventasSemanaActivas = filtrarVentasActivas(ventasSemana);
    const ventasMesActivas = filtrarVentasActivas(ventasMes);
    const canceladasHoy = ventasHoy.length - ventasHoyActivas.length;
    const canceladasSemana = ventasSemana.length - ventasSemanaActivas.length;
    const canceladasMes = ventasMes.length - ventasMesActivas.length;
    const domiciliosHoy = contarDomicilios(ventasHoyActivas, true);
    const domiciliosSemana = contarDomicilios(ventasSemanaActivas, true);
    const domiciliosMes = contarDomicilios(ventasMesActivas, true);
    const domiciliosHoyCancelados = ventasHoy.filter(v => esVentaCancelada(v) && esPedidoDomicilio(v)).length;
    const domiciliosSemanaCancelados = ventasSemana.filter(v => esVentaCancelada(v) && esPedidoDomicilio(v)).length;
    const domiciliosMesCancelados = ventasMes.filter(v => esVentaCancelada(v) && esPedidoDomicilio(v)).length;

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    setText("histHoyVentas", `${ventasHoyActivas.length} pedido(s)${canceladasHoy ? ` · ${canceladasHoy} cancelado(s)` : ""}`);
    setText("histHoyTotal", `${formatearDinero(ventasHoyActivas.reduce((acc, v) => acc + obtenerIngresoRealVenta(v), 0))} · ${domiciliosHoy} domicilio(s)${domiciliosHoyCancelados ? ` / ${domiciliosHoyCancelados} cancelado(s)` : ""} · sin domicilios`);
    setText("histSemanaVentas", `${ventasSemanaActivas.length} pedido(s)${canceladasSemana ? ` · ${canceladasSemana} cancelado(s)` : ""}`);
    setText("histSemanaTotal", `${formatearDinero(ventasSemanaActivas.reduce((acc, v) => acc + obtenerIngresoRealVenta(v), 0))} · ${domiciliosSemana} domicilio(s)${domiciliosSemanaCancelados ? ` / ${domiciliosSemanaCancelados} cancelado(s)` : ""} · sin domicilios`);
    setText("histMesVentas", `${ventasMesActivas.length} pedido(s)${canceladasMes ? ` · ${canceladasMes} cancelado(s)` : ""}`);
    setText("histMesTotal", `${formatearDinero(ventasMesActivas.reduce((acc, v) => acc + obtenerIngresoRealVenta(v), 0))} · ${domiciliosMes} domicilio(s)${domiciliosMesCancelados ? ` / ${domiciliosMesCancelados} cancelado(s)` : ""} · sin domicilios`);

    const diario = {};
    const semanal = {};
    const mensual = {};

    ventas.forEach(v => {
      const fecha = new Date(v.fechaISO || v.fecha);
      const dia = v.diaClave;
      const semana = obtenerClaveSemana(fecha);
      const mes = dia.slice(0, 7);

      if (!diario[dia]) diario[dia] = { label: dia, ventas: 0, canceladas: 0, domicilios: 0, domiciliosCancelados: 0, total: 0 };
      if (!semanal[semana]) semanal[semana] = { label: semana, ventas: 0, canceladas: 0, domicilios: 0, domiciliosCancelados: 0, total: 0 };
      if (!mensual[mes]) mensual[mes] = { label: mes, ventas: 0, canceladas: 0, domicilios: 0, domiciliosCancelados: 0, total: 0 };

      if (esVentaCancelada(v)) {
        diario[dia].canceladas += 1;
        semanal[semana].canceladas += 1;
        mensual[mes].canceladas += 1;
        if (esPedidoDomicilio(v)) {
          diario[dia].domiciliosCancelados += 1;
          semanal[semana].domiciliosCancelados += 1;
          mensual[mes].domiciliosCancelados += 1;
        }
      } else {
        diario[dia].ventas += 1;
        diario[dia].total += obtenerIngresoRealVenta(v);
        if (esPedidoDomicilio(v)) diario[dia].domicilios += 1;

        semanal[semana].ventas += 1;
        semanal[semana].total += obtenerIngresoRealVenta(v);
        if (esPedidoDomicilio(v)) semanal[semana].domicilios += 1;

        mensual[mes].ventas += 1;
        mensual[mes].total += obtenerIngresoRealVenta(v);
        if (esPedidoDomicilio(v)) mensual[mes].domicilios += 1;
      }
    });

    const ordenarDesc = data => Object.values(data).sort((a, b) => b.label.localeCompare(a.label));

    renderHistorico("historicoDiaBody", ordenarDesc(diario), "No hay ventas registradas por día.");
    renderHistorico("historicoSemanaBody", ordenarDesc(semanal), "No hay ventas registradas por semana.");
    renderHistorico("historicoMesBody", ordenarDesc(mensual), "No hay ventas registradas por mes.");

    const filtroFecha = document.getElementById("filtroHistoricoFecha");
    if (filtroFecha && !filtroFecha.value) {
      filtroFecha.value = hoy;
    }
    verVentasDetalladasPorFecha();
    renderTablaCierresCaja(false);
  }

  
  function actualizarDomiciliosVista() {
    const ventas = obtenerVentasNormalizadas().map((v, index) => ({ ...v, _index: index }));
    const domicilios = ventas.filter(v => esPedidoDomicilio(v));
    const domiciliosActivos = filtrarVentasActivas(domicilios);
    const hoy = obtenerFechaLocalISO(new Date());

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    const domiciliosHoy = domiciliosActivos.filter(v => v.diaClave === hoy);
    const domiciliosTransferencia = domiciliosActivos.filter(v => esPagoTransferencia(v));
    const domiciliosEfectivo = domiciliosActivos.filter(v => esPagoEfectivo(v));

    setText('domHoyCantidad', `${domiciliosHoy.length} domicilio(s)`);
    setText('domHoyValor', formatearDinero(domiciliosHoy.reduce((acc, v) => acc + obtenerValorDomicilio(v), 0)));
    setText('domTransferenciaCantidad', `${domiciliosTransferencia.length} domicilio(s)`);
    setText('domTransferenciaValor', formatearDinero(domiciliosTransferencia.reduce((acc, v) => acc + obtenerValorDomicilio(v), 0)));
    setText('domEfectivoCantidad', `${domiciliosEfectivo.length} domicilio(s)`);
    setText('domEfectivoValor', formatearDinero(domiciliosEfectivo.reduce((acc, v) => acc + obtenerValorDomicilio(v), 0)));

    const resumenPorDia = {};
    domicilios.forEach(v => {
      const dia = v.diaClave || obtenerFechaLocalISO(new Date(v.fechaISO || v.fecha || Date.now()));
      if (!resumenPorDia[dia]) {
        resumenPorDia[dia] = {
          fecha: dia,
          cantidad: 0,
          cancelados: 0,
          transferenciaCantidad: 0,
          efectivoCantidad: 0,
          transferenciaValor: 0,
          efectivoValor: 0,
          totalValor: 0
        };
      }
      const fila = resumenPorDia[dia];
      if (esVentaCancelada(v)) {
        fila.cancelados += 1;
        return;
      }
      const valorDomicilio = obtenerValorDomicilio(v);
      fila.cantidad += 1;
      fila.totalValor += valorDomicilio;
      if (esPagoEfectivo(v)) {
        fila.efectivoCantidad += 1;
        fila.efectivoValor += valorDomicilio;
      } else {
        fila.transferenciaCantidad += 1;
        fila.transferenciaValor += valorDomicilio;
      }
    });

    const body = document.getElementById('domiciliosDiaBody');
    if (body) {
      const filas = Object.values(resumenPorDia).sort((a, b) => b.fecha.localeCompare(a.fecha));
      body.innerHTML = '';
      if (!filas.length) {
        body.innerHTML = '<tr><td colspan="8" class="p-3 text-center text-gray-500">No hay domicilios registrados.</td></tr>';
      } else {
        filas.forEach(fila => {
          body.innerHTML += `
            <tr>
              <td class="p-2 border">${fila.fecha}</td>
              <td class="p-2 border">${fila.cantidad}</td>
              <td class="p-2 border">${fila.cancelados}</td>
              <td class="p-2 border">${fila.transferenciaCantidad}</td>
              <td class="p-2 border">${fila.efectivoCantidad}</td>
              <td class="p-2 border">${formatearDinero(fila.transferenciaValor)}</td>
              <td class="p-2 border">${formatearDinero(fila.efectivoValor)}</td>
              <td class="p-2 border font-semibold">${formatearDinero(fila.totalValor)}</td>
            </tr>
          `;
        });
      }
    }

    const filtroFecha = document.getElementById('filtroDomiciliosFecha');
    if (filtroFecha && !filtroFecha.value) {
      filtroFecha.value = hoy;
    }
    verDomiciliosDetalladosPorFecha();
  }

  function verDomiciliosDetalladosPorFecha() {
    const input = document.getElementById('filtroDomiciliosFecha');
    const body = document.getElementById('domiciliosDetalleBody');
    const resumen = document.getElementById('resumenDomiciliosDiaSeleccionado');
    if (!input || !body || !resumen) return;

    const fechaSeleccionada = input.value || obtenerFechaLocalISO(new Date());
    input.value = fechaSeleccionada;

    const domicilios = obtenerVentasNormalizadas()
      .map((v, index) => ({ ...v, _index: index }))
      .filter(v => esPedidoDomicilio(v) && v.diaClave === fechaSeleccionada)
      .sort((a, b) => {
        const aTime = new Date(a.fechaISO || a.fecha).getTime() || 0;
        const bTime = new Date(b.fechaISO || b.fecha).getTime() || 0;
        return bTime - aTime;
      });

    const activos = filtrarVentasActivas(domicilios);
    const cancelados = domicilios.length - activos.length;
    const transferencia = activos.filter(v => esPagoTransferencia(v));
    const efectivo = activos.filter(v => esPagoEfectivo(v));
    const valorTransferencia = transferencia.reduce((acc, v) => acc + obtenerValorDomicilio(v), 0);
    const valorEfectivo = efectivo.reduce((acc, v) => acc + obtenerValorDomicilio(v), 0);
    const valorTotalDomicilios = activos.reduce((acc, v) => acc + obtenerValorDomicilio(v), 0);

    resumen.innerHTML = `<strong>Fecha consultada:</strong> ${fechaSeleccionada} &nbsp;|&nbsp; <strong>Domicilios activos:</strong> ${activos.length} &nbsp;|&nbsp; <strong>Transferencia:</strong> ${transferencia.length} (${formatearDinero(valorTransferencia)}) &nbsp;|&nbsp; <strong>Efectivo:</strong> ${efectivo.length} (${formatearDinero(valorEfectivo)}) &nbsp;|&nbsp; <strong>Cancelados:</strong> ${cancelados} &nbsp;|&nbsp; <strong>Total domicilio:</strong> ${formatearDinero(valorTotalDomicilios)}`;

    body.innerHTML = '';
    if (!domicilios.length) {
      body.innerHTML = '<tr><td colspan="11" class="p-3 text-center text-gray-500">No hay domicilios registrados para esta fecha.</td></tr>';
      return;
    }

    domicilios.forEach(v => {
      const ventaCancelada = esVentaCancelada(v);
      body.innerHTML += `
        <tr class="${ventaCancelada ? 'bg-red-50 text-gray-500' : ''}">
          <td class="p-2 border">${v.recibo ?? '-'}</td>
          <td class="p-2 border">${v.comanda ?? '-'}</td>
          <td class="p-2 border">${formatearHoraColombia(v.fechaISO || v.fecha)}</td>
          <td class="p-2 border">${v.cliente || 'N/A'}</td>
          <td class="p-2 border">${v.formaPago || '-'}</td>
          <td class="p-2 border">${obtenerEtiquetaPagoDomicilio(v)}</td>
          <td class="p-2 border font-semibold">${formatearDinero(obtenerValorDomicilio(v))}</td>
          <td class="p-2 border">${formatearDinero(obtenerIngresoRealVenta(v))}</td>
          <td class="p-2 border">${obtenerBadgeEstadoVenta(v)}</td>
          <td class="p-2 border">${resumirProductosPedido(v.pedido || [])}</td>
          <td class="p-2 border text-center">${ventaCancelada ? '<span class="text-xs text-red-600 font-semibold">Sin recibo</span>' : `<button onclick="imprimirVentaCliente(${v._index})" class="bg-purple-500 hover:bg-purple-600 text-white px-3 py-1 rounded-lg text-xs font-semibold">Abrir recibo</button>`}</td>
        </tr>
      `;
    });
  }

  async function abrirDomiciliosVista() {
    if (!esAdmin()) return alert('No tienes permiso para acceder a domicilios.');
    const appMain = document.getElementById('appMain');
    const historicosVista = document.getElementById('historicosVista');
    const cajaVista = document.getElementById('cajaVista');
    const domiciliosVista = document.getElementById('domiciliosVista');
    if (appMain) appMain.classList.add('hidden');
    if (historicosVista) historicosVista.classList.add('hidden');
    if (cajaVista) cajaVista.classList.add('hidden');
    if (domiciliosVista) domiciliosVista.classList.remove('hidden');
    actualizarDomiciliosVista();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }


window.addEventListener('DOMContentLoaded', () => {
  const appContent = document.getElementById('appContent');
  const loginScreen = document.getElementById('loginScreen');
  if (appContent) appContent.classList.add('hidden');
  if (loginScreen) loginScreen.classList.remove('hidden');
  aplicarPermisosPorRol();
});
