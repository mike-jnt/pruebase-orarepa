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
  const COLECCION_NOMINA = 'nomina';
  const EMPLEADOS_KEY = 'empleados';
  const HISTORIAL_KEY = 'historialPagos';
  const EMPLEADOS_PAGE_SIZE = 20;
  const PAGOS_PAGE_SIZE = 10;
  const EXPORT_PAGE_SIZE = 200;
  const EXPORT_LIMIT = 10000;
  const TIMEZONE_CO = 'America/Bogota';

  let firebaseApp = null;
  let firebaseAuth = null;
  let firestoreDb = null;
  let usuarioAutenticado = null;
  let firebaseDisponible = false;
  let empleados = [];
  let historial = [];
  let empleadoActual = null;
  let empleadosPagina = 0;
  let empleadosCursores = [null];
  let empleadosHaySiguiente = false;
  let pagosPagina = 0;
  let pagosCursores = [null];
  let pagosHaySiguiente = false;

  const $ = (id) => document.getElementById(id);
  const form = $('form-empleado');
  const tabla = $('tabla-empleados');
  const estadoDB = $('estadoDB');

  function escapeHtml(valor) {
    return String(valor ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function limpiarTexto(valor, max = 160) {
    return String(valor ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function fechaColombiaISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE_CO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  function setEstadoDB(texto, estado = 'offline') {
    if (!estadoDB) return;
    estadoDB.className = `estado-db-badge ${estado}`;
    estadoDB.innerHTML = `<span class="estado-db-dot"></span><span class="estado-db-texto">${escapeHtml(texto)}</span>`;
  }

  function esGestion(user = usuarioAutenticado) {
    return Boolean(user?.email && MANAGEMENT_EMAILS.has(String(user.email).toLowerCase()));
  }

  function bloquearPagina(mensaje) {
    setEstadoDB(mensaje, 'offline');
    document.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
  }

  function formatearCOP(valor) {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(toNumber(valor));
  }

  function limpiarNumeroCOP(valor) {
    return String(valor || '').replace(/\D/g, '');
  }

  function formatearInputCOP(input) {
    const numero = parseInt(limpiarNumeroCOP(input.value) || '0', 10);
    input.value = numero ? numero.toLocaleString('es-CO') : '';
  }

  function normalizarEmpleado(emp = {}) {
    return {
      id: limpiarTexto(emp.id || emp.employeeId || Date.now(), 100),
      nombre: limpiarTexto(emp.nombre, 150),
      nombreBusqueda: limpiarTexto(emp.nombreBusqueda || emp.nombre, 150).toLowerCase(),
      cargo: limpiarTexto(emp.cargo, 100),
      valorDia: toNumber(emp.valorDia),
      valorHoraExtra: toNumber(emp.valorHoraExtra),
      diasTrabajados: toNumber(emp.diasTrabajados),
      horasExtras: toNumber(emp.horasExtras),
      bonificacion: toNumber(emp.bonificacion),
      prestamo: toNumber(emp.prestamo),
      estadoPago: emp.estadoPago === 'Pagado' ? 'Pagado' : 'Pendiente',
      fechaPago: emp.fechaPago || null,
      version: toNumber(emp.version)
    };
  }

  function normalizarPago(pago = {}) {
    return {
      uid: limpiarTexto(pago.uid || pago.pagoId, 160) || null,
      employeeId: limpiarTexto(pago.employeeId, 100),
      nombre: limpiarTexto(pago.nombre, 150),
      cargo: limpiarTexto(pago.cargo, 100),
      valorDia: toNumber(pago.valorDia),
      diasTrabajados: toNumber(pago.diasTrabajados),
      horasExtras: toNumber(pago.horasExtras),
      valorHoraExtra: toNumber(pago.valorHoraExtra),
      bonificacion: toNumber(pago.bonificacion),
      prestamo: toNumber(pago.prestamo),
      totalPagado: toNumber(pago.totalPagado),
      fechaPago: pago.fechaPago || pago.fecha || null,
      fechaClave: limpiarTexto(pago.fechaClave, 10) || (typeof pago.fechaPago === 'string' ? pago.fechaPago.slice(0, 10) : ''),
      quincena: limpiarTexto(pago.quincena, 120)
    };
  }

  function guardarLocal() {
    const empleadosCache = empleados.slice(0, EMPLEADOS_PAGE_SIZE);
    const historialCache = historial.slice(0, PAGOS_PAGE_SIZE);
    try {
      localStorage.setItem(EMPLEADOS_KEY, JSON.stringify(empleadosCache));
      localStorage.setItem(HISTORIAL_KEY, JSON.stringify(historialCache));
    } catch (error) {
      console.warn('No se pudo guardar la caché local de nómina; se continúa conectado a Firestore.', error);
      try { localStorage.removeItem(EMPLEADOS_KEY); } catch (_) {}
      try { localStorage.removeItem(HISTORIAL_KEY); } catch (_) {}
    }
  }

  function cargarLocalLimitado() {
    try {
      const emp = JSON.parse(localStorage.getItem(EMPLEADOS_KEY) || '[]');
      const pag = JSON.parse(localStorage.getItem(HISTORIAL_KEY) || '[]');
      empleados = Array.isArray(emp) ? emp.map(normalizarEmpleado).slice(0, EMPLEADOS_PAGE_SIZE) : [];
      historial = Array.isArray(pag) ? pag.map(normalizarPago).slice(0, PAGOS_PAGE_SIZE) : [];
    } catch (_) {
      empleados = [];
      historial = [];
    }
  }

  function empleadoDocId(empleado) {
    return `empleado_${limpiarTexto(empleado.id, 100)}`;
  }

  function claveQuincena(fecha) {
    const d = fecha instanceof Date ? fecha : new Date(fecha || Date.now());
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const q = d.getDate() <= 15 ? 'q1' : 'q2';
    return `${yyyy}${mm}_${q}`;
  }

  function pagoDocId(empleado, fechaPago) {
    return `pago_${limpiarTexto(empleado.id, 80)}_${claveQuincena(fechaPago)}`;
  }

  function calcularTotalPagar(empleado) {
    return toNumber(empleado.valorDia) * toNumber(empleado.diasTrabajados)
      + toNumber(empleado.horasExtras) * toNumber(empleado.valorHoraExtra)
      + toNumber(empleado.bonificacion)
      - toNumber(empleado.prestamo);
  }

  function generarRangoQuincena(fechaPago) {
    const base = fechaPago ? new Date(fechaPago) : new Date();
    const mes = base.toLocaleString('es-CO', { month: 'long', timeZone: TIMEZONE_CO });
    const año = base.getFullYear();
    return base.getDate() <= 15 ? `01 al 15 de ${mes} ${año}` : `16 al fin de ${mes} ${año}`;
  }

  function construirPagoDesdeEmpleado(empleado, fechaPago) {
    const emp = normalizarEmpleado(empleado);
    const uid = pagoDocId(emp, fechaPago);
    return normalizarPago({
      uid,
      employeeId: emp.id,
      nombre: emp.nombre,
      cargo: emp.cargo,
      valorDia: emp.valorDia,
      diasTrabajados: emp.diasTrabajados,
      horasExtras: emp.horasExtras,
      valorHoraExtra: emp.valorHoraExtra,
      bonificacion: emp.bonificacion,
      prestamo: emp.prestamo,
      totalPagado: calcularTotalPagar(emp),
      fechaPago,
      fechaClave: fechaColombiaISO(),
      quincena: generarRangoQuincena(fechaPago)
    });
  }

  async function iniciarFirebase() {
    try {
      if (firebase.apps.some((app) => app?.options?.projectId && app.options.projectId !== PROJECT_ID)) throw new Error('Se detectó otro proyecto Firebase.');
      firebaseApp = firebase.apps.find((app) => app?.name === FIREBASE_APP_NAME) || firebase.initializeApp(FIREBASE_CONFIG, FIREBASE_APP_NAME);
      firebaseAuth = firebase.auth(firebaseApp);
      firestoreDb = firebase.firestore(firebaseApp);
      try {
        firestoreDb.settings({
          experimentalAutoDetectLongPolling: false,
          experimentalForceLongPolling: true,
          experimentalLongPollingOptions: { timeoutSeconds: 25 },
          ignoreUndefinedProperties: true
        });
      } catch (error) {
        console.warn('No fue posible aplicar el transporte robusto de Firestore:', error);
      }
      firebaseDisponible = true;
      setEstadoDB('Esperando sesión de Firebase...', 'pending');
    } catch (error) {
      console.error(error);
      firebaseDisponible = false;
      setEstadoDB('Base de datos desconectada', 'offline');
    }
  }

  function crearPaginacion() {
    const tablaEmp = $('tabla-empleados')?.closest('.overflow-x-auto');
    if (tablaEmp && !$('paginacionEmpleados')) {
      tablaEmp.insertAdjacentHTML('afterend', `
        <div id="paginacionEmpleados" class="mt-4 flex items-center justify-between gap-2 flex-wrap">
          <span id="infoPaginacionEmpleados" class="text-sm text-gray-500">Página 1 · máximo ${EMPLEADOS_PAGE_SIZE} empleados</span>
          <div class="flex gap-2"><button id="btnEmpAnterior" type="button" class="bg-gray-200 px-3 py-2 rounded">← Anterior</button><button id="btnEmpSiguiente" type="button" class="bg-blue-600 text-white px-3 py-2 rounded">Siguiente →</button></div>
        </div>`);
      $('btnEmpAnterior').addEventListener('click', () => cambiarPaginaEmpleados(-1));
      $('btnEmpSiguiente').addEventListener('click', () => cambiarPaginaEmpleados(1));
    }
    const tablaPagos = $('tabla-historial')?.closest('.overflow-x-auto');
    if (tablaPagos && !$('paginacionPagos')) {
      tablaPagos.insertAdjacentHTML('afterend', `
        <div id="paginacionPagos" class="mt-4 flex items-center justify-between gap-2 flex-wrap">
          <span id="infoPaginacionPagos" class="text-sm text-gray-500">Página 1 · máximo ${PAGOS_PAGE_SIZE} pagos</span>
          <div class="flex gap-2"><button id="btnPagoAnterior" type="button" class="bg-gray-200 px-3 py-2 rounded">← Anterior</button><button id="btnPagoSiguiente" type="button" class="bg-blue-600 text-white px-3 py-2 rounded">Siguiente →</button></div>
        </div>`);
      $('btnPagoAnterior').addEventListener('click', () => cambiarPaginaPagos(-1));
      $('btnPagoSiguiente').addEventListener('click', () => cambiarPaginaPagos(1));
    }
    const acciones = document.querySelector('section.mt-8 .flex.gap-2');
    if (acciones && !$('btnMigrarNomina')) {
      acciones.insertAdjacentHTML('afterbegin', '<button id="btnMigrarNomina" type="button" class="bg-amber-500 text-white px-4 py-2 rounded hover:bg-amber-600">☁️ Subir datos locales</button>');
      $('btnMigrarNomina').addEventListener('click', migrarLocalStorageAFirestore);
    }
  }

  function queryEmpleados() {
    let q = firestoreDb.collection(COLECCION_NOMINA).where('recordType', '==', 'empleado').orderBy('nombre');
    const cursor = empleadosCursores[empleadosPagina];
    if (cursor) q = q.startAfter(cursor);
    return q.limit(EMPLEADOS_PAGE_SIZE);
  }

  async function cargarEmpleados(reset = false) {
    if (!esGestion()) return;
    if (reset) { empleadosPagina = 0; empleadosCursores = [null]; }
    try {
      const snap = await queryEmpleados().get();
      if (!snap.docs.length && empleadosPagina > 0) {
        empleadosPagina -= 1;
        empleadosHaySiguiente = false;
        actualizarPaginacionEmpleados();
        return;
      }
      empleadosHaySiguiente = snap.docs.length === EMPLEADOS_PAGE_SIZE;
      const visibles = snap.docs;
      empleados = visibles.map((doc) => normalizarEmpleado({ id: doc.data()?.employeeId || doc.id.replace('empleado_', ''), ...doc.data() }));
      if (empleadosHaySiguiente && visibles.length) empleadosCursores[empleadosPagina + 1] = visibles[visibles.length - 1];
      mostrarEmpleados();
      guardarLocal();
      actualizarPaginacionEmpleados();
    } catch (error) {
      console.error(error);
      setEstadoDB(String(error?.code || '').includes('failed-precondition') ? 'Falta publicar un índice para empleados' : 'No se pudieron cargar empleados', 'offline');
    }
  }

  function queryPagos() {
    let q = firestoreDb.collection(COLECCION_NOMINA).where('recordType', '==', 'pago').orderBy('fechaPago', 'desc');
    const cursor = pagosCursores[pagosPagina];
    if (cursor) q = q.startAfter(cursor);
    return q.limit(PAGOS_PAGE_SIZE);
  }

  async function cargarPagos(reset = false) {
    if (!esGestion()) return;
    if (reset) { pagosPagina = 0; pagosCursores = [null]; }
    try {
      const snap = await queryPagos().get();
      if (!snap.docs.length && pagosPagina > 0) {
        pagosPagina -= 1;
        pagosHaySiguiente = false;
        actualizarPaginacionPagos();
        return;
      }
      pagosHaySiguiente = snap.docs.length === PAGOS_PAGE_SIZE;
      const visibles = snap.docs;
      historial = visibles.map((doc) => normalizarPago({ uid: doc.id, ...doc.data() }));
      if (pagosHaySiguiente && visibles.length) pagosCursores[pagosPagina + 1] = visibles[visibles.length - 1];
      mostrarHistorial();
      guardarLocal();
      actualizarPaginacionPagos();
    } catch (error) {
      console.error(error);
      setEstadoDB(String(error?.code || '').includes('failed-precondition') ? 'Falta publicar un índice para pagos' : 'No se pudo cargar el historial', 'offline');
    }
  }

  function actualizarPaginacionEmpleados() {
    if ($('infoPaginacionEmpleados')) $('infoPaginacionEmpleados').textContent = `Página ${empleadosPagina + 1} · ${empleados.length} empleados leídos`;
    if ($('btnEmpAnterior')) $('btnEmpAnterior').disabled = empleadosPagina === 0;
    if ($('btnEmpSiguiente')) $('btnEmpSiguiente').disabled = !empleadosHaySiguiente;
  }

  function actualizarPaginacionPagos() {
    if ($('infoPaginacionPagos')) $('infoPaginacionPagos').textContent = `Página ${pagosPagina + 1} · ${historial.length} pagos leídos`;
    if ($('btnPagoAnterior')) $('btnPagoAnterior').disabled = pagosPagina === 0;
    if ($('btnPagoSiguiente')) $('btnPagoSiguiente').disabled = !pagosHaySiguiente;
  }

  async function cambiarPaginaEmpleados(delta) {
    const destino = empleadosPagina + delta;
    if (destino < 0 || (delta > 0 && !empleadosHaySiguiente)) return;
    empleadosPagina = destino;
    await cargarEmpleados(false);
  }

  async function cambiarPaginaPagos(delta) {
    const destino = pagosPagina + delta;
    if (destino < 0 || (delta > 0 && !pagosHaySiguiente)) return;
    pagosPagina = destino;
    await cargarPagos(false);
  }

  async function guardarEmpleadoEnFirestore(empleado) {
    const emp = normalizarEmpleado(empleado);
    await firestoreDb.collection(COLECCION_NOMINA).doc(empleadoDocId(emp)).set({
      recordType: 'empleado',
      employeeId: emp.id,
      nombre: emp.nombre,
      nombreBusqueda: emp.nombre.toLowerCase(),
      cargo: emp.cargo,
      valorDia: emp.valorDia,
      valorHoraExtra: emp.valorHoraExtra,
      diasTrabajados: emp.diasTrabajados,
      horasExtras: emp.horasExtras,
      bonificacion: emp.bonificacion,
      prestamo: emp.prestamo,
      estadoPago: emp.estadoPago,
      fechaPago: emp.fechaPago || null,
      version: emp.version + 1,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: usuarioAutenticado.email
    }, { merge: true });
  }

  async function guardarPagoEnFirestore(pago) {
    const item = normalizarPago(pago);
    await firestoreDb.collection(COLECCION_NOMINA).doc(item.uid).set({
      recordType: 'pago',
      pagoId: item.uid,
      employeeId: item.employeeId,
      nombre: item.nombre,
      nombreBusqueda: item.nombre.toLowerCase(),
      cargo: item.cargo,
      valorDia: item.valorDia,
      diasTrabajados: item.diasTrabajados,
      horasExtras: item.horasExtras,
      valorHoraExtra: item.valorHoraExtra,
      bonificacion: item.bonificacion,
      prestamo: item.prestamo,
      totalPagado: item.totalPagado,
      fechaPago: item.fechaPago,
      fechaClave: item.fechaClave || fechaColombiaISO(),
      quincena: item.quincena,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: usuarioAutenticado.email
    }, { merge: true });
  }

  async function guardarNuevoEmpleado(event) {
    event.preventDefault();
    const nombre = limpiarTexto($('nombre')?.value, 150);
    const cargo = limpiarTexto($('cargo')?.value, 100);
    const valorDia = parseInt(limpiarNumeroCOP($('valorDia')?.value), 10);
    const valorHoraExtra = parseInt(limpiarNumeroCOP($('valorHoraExtra')?.value), 10) || 0;
    if (!nombre || !cargo || !Number.isFinite(valorDia)) { alert('Completa todos los campos correctamente.'); return; }
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const emp = normalizarEmpleado({ id, nombre, cargo, valorDia, valorHoraExtra, estadoPago: 'Pendiente' });
    try {
      await guardarEmpleadoEnFirestore(emp);
      form.reset();
      await cargarEmpleados(true);
    } catch (error) {
      console.error(error);
      alert('No se pudo guardar el empleado.');
    }
  }

  function mostrarEmpleados() {
    if (!tabla) return;
    if (!empleados.length) {
      tabla.innerHTML = '<tr><td colspan="9" class="p-4 text-center text-gray-500">No hay empleados en esta página.</td></tr>';
      return;
    }
    tabla.innerHTML = empleados.map((emp) => {
      const diasFaltados = Math.max(0, 15 - emp.diasTrabajados);
      const totalTrabajado = emp.valorDia * emp.diasTrabajados;
      const totalQuincena = emp.valorDia * 15;
      const diferencia = totalQuincena - totalTrabajado;
      const extras = emp.horasExtras * emp.valorHoraExtra;
      const total = calcularTotalPagar(emp);
      return `<tr class="hover:bg-gray-50">
        <td class="p-3 border">${escapeHtml(emp.nombre)}</td><td class="p-3 border">${escapeHtml(emp.cargo)}</td><td class="p-3 border">${escapeHtml(formatearCOP(emp.valorDia))}</td>
        <td class="p-3 border">${emp.diasTrabajados}</td><td class="p-3 border">${diasFaltados}</td><td class="p-3 border">${escapeHtml(generarRangoQuincena(emp.fechaPago))}</td>
        <td class="p-3 border"><div>Total base: <strong>${escapeHtml(formatearCOP(totalTrabajado))}</strong></div>${extras > 0 ? `<div class="text-xs text-blue-500">Horas extra: +${escapeHtml(formatearCOP(extras))}</div>` : ''}${emp.bonificacion > 0 ? `<div class="text-xs text-blue-500">Bonificación: +${escapeHtml(formatearCOP(emp.bonificacion))}</div>` : ''}${emp.prestamo > 0 ? `<div class="text-xs text-red-500">Préstamo: -${escapeHtml(formatearCOP(emp.prestamo))}</div>` : ''}<div class="text-sm text-green-700 font-bold">Total a pagar: ${escapeHtml(formatearCOP(total))}</div>${diasFaltados > 0 ? `<div class="text-xs text-red-500">Faltas: -${escapeHtml(formatearCOP(diferencia))}</div>` : ''}</td>
        <td class="p-3 border font-bold ${emp.estadoPago === 'Pagado' ? 'text-green-600' : 'text-red-600'}">${escapeHtml(emp.estadoPago)}</td>
        <td class="p-3 border space-y-1"><button onclick="registrarAsistencia('${escapeHtml(emp.id)}')" class="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs w-full" ${emp.estadoPago === 'Pagado' ? 'disabled' : ''}>Asistencia</button>${emp.estadoPago === 'Pendiente' ? `<button onclick="marcarComoPagado('${escapeHtml(emp.id)}')" class="bg-green-100 text-green-800 px-2 py-1 rounded text-xs w-full">Marcar Pagado</button>` : `<button onclick="desmarcarPagado('${escapeHtml(emp.id)}')" class="bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-xs w-full">Desmarcar Pagado</button>`}<button onclick="generarPDF('${escapeHtml(emp.id)}')" class="bg-purple-100 text-purple-800 px-2 py-1 rounded text-xs w-full">Generar PDF</button><button onclick="eliminarEmpleado('${escapeHtml(emp.id)}')" class="bg-red-100 text-red-800 px-2 py-1 rounded text-xs w-full">Eliminar</button></td>
      </tr>`;
    }).join('');
  }

  function mostrarHistorial() {
    const tbody = $('tabla-historial');
    if (!tbody) return;
    tbody.innerHTML = historial.map((p) => `<tr><td class="p-2 border">${escapeHtml(p.nombre)}</td><td class="p-2 border">${escapeHtml(p.cargo)}</td><td class="p-2 border">${escapeHtml(formatearFecha(p.fechaPago))}</td><td class="p-2 border">${escapeHtml(p.quincena)}</td><td class="p-2 border">${p.diasTrabajados}</td><td class="p-2 border">${escapeHtml(formatearCOP(p.valorDia))}</td><td class="p-2 border">${p.horasExtras}</td><td class="p-2 border">${escapeHtml(formatearCOP(p.bonificacion))}</td><td class="p-2 border font-semibold">${escapeHtml(formatearCOP(p.totalPagado))}</td></tr>`).join('') || '<tr><td colspan="9" class="p-4 text-center text-gray-500">No hay pagos en esta página.</td></tr>';
  }

  function formatearFecha(valor) {
    if (!valor) return '';
    const d = valor?.toDate ? valor.toDate() : new Date(valor);
    return Number.isNaN(d.getTime()) ? String(valor).slice(0, 10) : d.toLocaleDateString('es-CO');
  }

  function registrarAsistencia(id) {
    empleadoActual = empleados.find((emp) => String(emp.id) === String(id));
    if (!empleadoActual) return;
    $('modal-nombre').textContent = empleadoActual.nombre;
    $('inputDias').value = empleadoActual.diasTrabajados;
    $('inputHorasExtras').value = empleadoActual.horasExtras || 0;
    $('inputBonificacion').value = empleadoActual.bonificacion ? formatearCOP(empleadoActual.bonificacion) : '';
    $('inputPrestamo').value = empleadoActual.prestamo ? formatearCOP(empleadoActual.prestamo) : '';
    $('modalAsistencia').classList.remove('hidden');
  }

  async function guardarAsistencia() {
    const dias = parseInt($('inputDias').value, 10);
    if (!Number.isFinite(dias) || dias < 0 || dias > 15) { alert('Ingresa un número entre 0 y 15.'); return; }
    const emp = normalizarEmpleado({ ...empleadoActual, diasTrabajados: dias, horasExtras: parseInt($('inputHorasExtras').value, 10) || 0, bonificacion: parseInt(limpiarNumeroCOP($('inputBonificacion').value), 10) || 0, prestamo: parseInt(limpiarNumeroCOP($('inputPrestamo').value), 10) || 0 });
    try {
      await guardarEmpleadoEnFirestore(emp);
      cerrarModal();
      await cargarEmpleados(false);
    } catch (error) {
      console.error(error);
      alert('No se pudo guardar la asistencia.');
    }
  }

  function cerrarModal() { $('modalAsistencia').classList.add('hidden'); }

  async function marcarComoPagado(id) {
    const emp = empleados.find((item) => String(item.id) === String(id));
    if (!emp) return;
    const fechaPago = new Date().toISOString();
    const actualizado = normalizarEmpleado({ ...emp, estadoPago: 'Pagado', fechaPago });
    const pago = construirPagoDesdeEmpleado(actualizado, fechaPago);
    try {
      const batch = firestoreDb.batch();
      batch.set(firestoreDb.collection(COLECCION_NOMINA).doc(empleadoDocId(actualizado)), {
        recordType: 'empleado', employeeId: actualizado.id, nombre: actualizado.nombre, nombreBusqueda: actualizado.nombre.toLowerCase(), cargo: actualizado.cargo, valorDia: actualizado.valorDia, valorHoraExtra: actualizado.valorHoraExtra, diasTrabajados: actualizado.diasTrabajados, horasExtras: actualizado.horasExtras, bonificacion: actualizado.bonificacion, prestamo: actualizado.prestamo, estadoPago: 'Pagado', fechaPago, version: actualizado.version + 1, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: usuarioAutenticado.email
      }, { merge: true });
      batch.set(firestoreDb.collection(COLECCION_NOMINA).doc(pago.uid), {
        recordType: 'pago', pagoId: pago.uid, employeeId: pago.employeeId, nombre: pago.nombre, nombreBusqueda: pago.nombre.toLowerCase(), cargo: pago.cargo, valorDia: pago.valorDia, diasTrabajados: pago.diasTrabajados, horasExtras: pago.horasExtras, valorHoraExtra: pago.valorHoraExtra, bonificacion: pago.bonificacion, prestamo: pago.prestamo, totalPagado: pago.totalPagado, fechaPago, fechaClave: pago.fechaClave, quincena: pago.quincena, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: usuarioAutenticado.email
      }, { merge: true });
      await batch.commit();
      await Promise.all([cargarEmpleados(false), cargarPagos(true)]);
    } catch (error) {
      console.error(error);
      alert('No se pudo registrar el pago.');
    }
  }

  async function desmarcarPagado(id) {
    const emp = empleados.find((item) => String(item.id) === String(id));
    if (!emp) return;
    try {
      await guardarEmpleadoEnFirestore({ ...emp, estadoPago: 'Pendiente', fechaPago: null });
      await cargarEmpleados(false);
    } catch (error) {
      console.error(error);
      alert('No se pudo cambiar el estado.');
    }
  }

  async function eliminarEmpleado(id) {
    if (!confirm('¿Eliminar este empleado?')) return;
    try {
      await firestoreDb.collection(COLECCION_NOMINA).doc(`empleado_${id}`).delete();
      await cargarEmpleados(empleadosPagina === 0);
    } catch (error) {
      console.error(error);
      alert('No se pudo eliminar el empleado.');
    }
  }

  async function eliminarHistorial() {
    if (!confirm('Esta acción consultará y eliminará todos los pagos por bloques. ¿Continuar?')) return;
    try {
      let eliminados = 0;
      while (true) {
        const snap = await firestoreDb.collection(COLECCION_NOMINA).where('recordType', '==', 'pago').limit(200).get();
        if (snap.empty) break;
        const batch = firestoreDb.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        eliminados += snap.size;
        setEstadoDB(`Eliminando historial: ${eliminados} pagos...`, 'pending');
        if (snap.size < 200) break;
      }
      await cargarPagos(true);
      setEstadoDB('Base de datos conectada', 'online');
      alert(`Historial eliminado: ${eliminados} pagos.`);
    } catch (error) {
      console.error(error);
      alert('No se pudo eliminar todo el historial.');
    }
  }

  async function obtenerTodosPagos() {
    if (!confirm('La exportación consultará todo el historial de pagos por páginas. ¿Continuar?')) return null;
    const data = [];
    let cursor = null;
    while (data.length < EXPORT_LIMIT) {
      let q = firestoreDb.collection(COLECCION_NOMINA).where('recordType', '==', 'pago').orderBy('fechaPago', 'desc').limit(EXPORT_PAGE_SIZE);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;
      data.push(...snap.docs.map((doc) => normalizarPago({ uid: doc.id, ...doc.data() })));
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < EXPORT_PAGE_SIZE) break;
    }
    if (data.length >= EXPORT_LIMIT) alert(`La exportación fue limitada a ${EXPORT_LIMIT} pagos.`);
    return data;
  }

  async function exportarHistorialAExcel() {
    const data = await obtenerTodosPagos();
    if (!data) return;
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Historial de Pagos');
    worksheet.columns = [
      { header: 'Empleado', key: 'empleado', width: 25 }, { header: 'Cargo', key: 'cargo', width: 20 }, { header: 'Fecha', key: 'fecha', width: 20 },
      { header: 'Días trabajados', key: 'dias', width: 16 }, { header: 'Valor día', key: 'valorDia', width: 15 }, { header: 'Horas extras', key: 'extras', width: 15 },
      { header: 'Bonificación', key: 'bonificacion', width: 16 }, { header: 'Préstamo', key: 'prestamo', width: 16 }, { header: 'Total pagado', key: 'total', width: 18 }
    ];
    data.forEach((p) => worksheet.addRow({ empleado: p.nombre, cargo: p.cargo, fecha: p.fechaPago || '', dias: p.diasTrabajados, valorDia: p.valorDia, extras: p.horasExtras, bonificacion: p.bonificacion, prestamo: p.prestamo, total: p.totalPagado }));
    ['E', 'G', 'H', 'I'].forEach((col) => { worksheet.getColumn(col).numFmt = '"$"#,##0'; });
    const buffer = await workbook.xlsx.writeBuffer();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    link.download = `Historial_Pagos_${fechaColombiaISO()}.xlsx`;
    link.click();
  }

  async function migrarLocalStorageAFirestore() {
    if (!esGestion()) return;
    let empleadosLocales = [];
    let pagosLocales = [];
    try {
      empleadosLocales = (JSON.parse(localStorage.getItem(EMPLEADOS_KEY) || '[]') || []).map(normalizarEmpleado);
      pagosLocales = (JSON.parse(localStorage.getItem(HISTORIAL_KEY) || '[]') || []).map(normalizarPago);
    } catch (_) {}
    if (!empleadosLocales.length && !pagosLocales.length) { alert('No hay datos locales por subir.'); return; }
    if (!confirm(`Se subirán ${empleadosLocales.length} empleados y ${pagosLocales.length} pagos locales. ¿Continuar?`)) return;
    try {
      let batch = firestoreDb.batch();
      let count = 0;
      for (const emp of empleadosLocales) {
        const ref = firestoreDb.collection(COLECCION_NOMINA).doc(empleadoDocId(emp));
        batch.set(ref, { recordType: 'empleado', employeeId: emp.id, nombre: emp.nombre, nombreBusqueda: emp.nombre.toLowerCase(), cargo: emp.cargo, valorDia: emp.valorDia, valorHoraExtra: emp.valorHoraExtra, diasTrabajados: emp.diasTrabajados, horasExtras: emp.horasExtras, bonificacion: emp.bonificacion, prestamo: emp.prestamo, estadoPago: emp.estadoPago, fechaPago: emp.fechaPago, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: usuarioAutenticado.email }, { merge: true });
        count++;
        if (count >= 400) { await batch.commit(); batch = firestoreDb.batch(); count = 0; }
      }
      for (const raw of pagosLocales) {
        const employeeId = raw.employeeId || `legacy_${raw.nombre.toLowerCase().replace(/\W+/g, '_')}`;
        const id = raw.uid || `pago_${employeeId}_${claveQuincena(raw.fechaPago)}`;
        const p = { ...raw, uid: id, employeeId };
        batch.set(firestoreDb.collection(COLECCION_NOMINA).doc(id), { recordType: 'pago', pagoId: id, employeeId, nombre: p.nombre, nombreBusqueda: p.nombre.toLowerCase(), cargo: p.cargo, valorDia: p.valorDia, diasTrabajados: p.diasTrabajados, horasExtras: p.horasExtras, valorHoraExtra: p.valorHoraExtra, bonificacion: p.bonificacion, prestamo: p.prestamo, totalPagado: p.totalPagado, fechaPago: p.fechaPago, fechaClave: p.fechaClave || String(p.fechaPago || '').slice(0, 10), quincena: p.quincena, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: usuarioAutenticado.email }, { merge: true });
        count++;
        if (count >= 400) { await batch.commit(); batch = firestoreDb.batch(); count = 0; }
      }
      if (count) await batch.commit();
      alert('Datos locales subidos correctamente.');
      await Promise.all([cargarEmpleados(true), cargarPagos(true)]);
    } catch (error) {
      console.error(error);
      alert('No se pudo completar la migración.');
    }
  }

  async function generarPDF(id) {
    const emp = empleados.find((item) => String(item.id) === String(id));
    if (!emp) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('SEÑOR AREPA · Pago quincenal', 20, 20);
    doc.setFontSize(10);
    doc.text(`Fecha de emisión: ${new Date().toLocaleDateString('es-CO')}`, 20, 28);
    doc.autoTable({ startY: 35, head: [['Empleado', 'Cargo', 'Estado']], body: [[emp.nombre, emp.cargo, emp.estadoPago]], headStyles: { fillColor: [25, 40, 90] } });
    const extras = emp.horasExtras * emp.valorHoraExtra;
    doc.autoTable({ startY: doc.lastAutoTable.finalY + 5, head: [['Días', 'Valor día', 'Horas extra', 'Bonificación', 'Préstamo', 'Total']], body: [[emp.diasTrabajados, formatearCOP(emp.valorDia), formatearCOP(extras), formatearCOP(emp.bonificacion), formatearCOP(emp.prestamo), formatearCOP(calcularTotalPagar(emp))]], headStyles: { fillColor: [0, 150, 50] } });
    doc.save(`Recibo_${emp.nombre.replace(/\s+/g, '_')}.pdf`);
  }

  Object.assign(window, { registrarAsistencia, marcarComoPagado, generarPDF, eliminarEmpleado, guardarAsistencia, cerrarModal, desmarcarPagado, eliminarHistorial, exportarHistorialAExcel });

  if (form) form.addEventListener('submit', guardarNuevoEmpleado);
  ['inputBonificacion', 'valorDia', 'valorHoraExtra', 'inputPrestamo'].forEach((id) => $(id)?.addEventListener('input', function () { formatearInputCOP(this); }));

  (async function init() {
    crearPaginacion();
    cargarLocalLimitado();
    mostrarEmpleados();
    mostrarHistorial();
    actualizarPaginacionEmpleados();
    actualizarPaginacionPagos();
    await iniciarFirebase();
    if (!firebaseDisponible) return;
    firebaseAuth.onAuthStateChanged(async (user) => {
      usuarioAutenticado = user || null;
      if (!user) { bloquearPagina('Sin sesión · vuelve al POS e inicia sesión'); return; }
      if (!esGestion(user)) { bloquearPagina('Nómina solo está disponible para administrador y admin'); return; }
      document.querySelectorAll('input, button').forEach((el) => { el.disabled = false; });
      setEstadoDB(`Conectado como ${user.email}`, 'online');
      await Promise.all([cargarEmpleados(true), cargarPagos(true)]);
      setEstadoDB('Base de datos conectada · consultas paginadas', 'online');
    });
  })();
})();
