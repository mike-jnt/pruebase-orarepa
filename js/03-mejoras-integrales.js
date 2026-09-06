(() => {
  'use strict';

  const SA_CONFIG = Object.freeze({
    version: '2026.09.06-C9.39',
    entorno: 'PRUEBAS',
    exigirCajaAbierta: true,
    diasVentasIniciales: 120,
    diasHistoricos: 365,
    diasDomicilios: 180,
    limiteConsulta: 1800
  });
  const SA_KEYS = Object.freeze({
    cajaPendiente: 'senorArepaCajaPendienteV3',
    auditoriaPendiente: 'senorArepaAuditoriaPendienteV3'
  });
  const SA_ESTADOS_DOMICILIO = ['Pendiente', 'En preparación', 'En camino', 'Entregado', 'Cancelado'];
  let saGuardandoVenta = false;
  let saSincronizandoCaja = false;
  let saPersistenciaIntentada = false;

  // C9.39: una misma cuenta solo puede tener una sesión POS escritora activa.
  // Cada pestaña usa un sessionId distinto (sessionStorage) y Firestore mantiene
  // un lease corto con heartbeat. Si la cuenta ya está activa en otro lugar,
  // esta pestaña queda bloqueada antes de iniciar listeners o guardar ventas.
  const SA_SESSION_COLLECTION = 'sesionesActivas';
  const SA_SESSION_ID_KEY = 'senorArepaExclusiveSessionIdV1';
  const SA_SESSION_DEVICE_KEY = 'senorArepaDeviceIdV1';
  const SA_SESSION_TTL_MS = 120000;
  const SA_SESSION_HEARTBEAT_MS = 30000;
  let saSesionExclusivaAdquirida = false;
  let saSesionBloqueadaPorOtro = false;
  let saSesionHeartbeatTimer = null;
  let saSesionAvisoMostrado = false;
  let saTabLockRelease = null;
  let saTabLockHeldForUid = '';
  let saTabLockPromise = null;

  const SA_BASE_NORMALIZAR_VENTA = normalizarVenta;
  const SA_BASE_NORMALIZAR_CAJA = normalizarControlCaja;
  const SA_BASE_RESUMEN_CAJA_CONTROL = obtenerResumenCajaDiaParaControl;
  const SA_BASE_LIMPIAR_PEDIDO = limpiarPedido;
  const SA_BASE_EDITAR_VENTA = editarVenta;
  const SA_BASE_ACTUALIZAR_CAMPO_DOMICILIO = actualizarCampoCostoDomicilio;
  const SA_BASE_ACTUALIZAR_HISTORICOS = actualizarHistoricos;
  const SA_BASE_ABRIR_HISTORICOS = abrirHistoricos;
  const SA_BASE_ABRIR_DOMICILIOS = abrirDomiciliosVista;
  const SA_BASE_APLICAR_PERMISOS = aplicarPermisosPorRol;
  const SA_BASE_NORMALIZAR_CATALOGO = normalizarCatalogoProductos;
  const SA_BASE_BADGE_ESTADO = obtenerBadgeEstadoVenta;
  const SA_BASE_GUARDAR_CATALOGO = guardarCatalogoDesdeEditor;
  const SA_BASE_RESTAURAR_CATALOGO = restablecerCatalogoBase;
  const SA_BASE_CERRAR_MODAL_CAJA = cerrarModalCaja;
  const SA_BASE_ABRIR_MODAL_CAJA = abrirModalCaja;

  // C9.39: la apertura/base del día es obligatoria antes de usar el POS.
  // Mientras Firestore no confirme aperturaHora para el día actual, el modal
  // permanece bloqueante y no puede cerrarse por X, Cancelar, Escape o fondo.
  let saAperturaObligatoriaActiva = false;
  let saDiaAperturaValidado = '';

  function saConfigurarAperturaObligatoria(activa, mensaje = '') {
    saAperturaObligatoriaActiva = Boolean(activa);
    const modal = document.getElementById('modalAperturaCaja');
    const btnCerrar = document.getElementById('btnCerrarModalAperturaCaja');
    const btnCancelar = document.getElementById('btnCancelarModalAperturaCaja');
    const btnCerrarSesion = document.getElementById('btnCerrarSesionDesdeApertura');
    const aviso = document.getElementById('aperturaCajaBloqueoTexto');
    if (btnCerrar) btnCerrar.classList.toggle('hidden', saAperturaObligatoriaActiva);
    if (btnCancelar) btnCancelar.classList.toggle('hidden', saAperturaObligatoriaActiva);
    if (btnCerrarSesion) btnCerrarSesion.classList.toggle('hidden', !saAperturaObligatoriaActiva);
    ['topNav', 'mobileQuickBar', 'appMain', 'cajaVista', 'historicosVista', 'domiciliosVista', 'modalEditorCatalogo'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      try { el.inert = saAperturaObligatoriaActiva; } catch (_) {}
      if (saAperturaObligatoriaActiva) el.setAttribute('aria-hidden', 'true');
      else el.removeAttribute('aria-hidden');
    });
    if (aviso) {
      aviso.classList.toggle('hidden', !saAperturaObligatoriaActiva);
      aviso.textContent = mensaje || 'Debes registrar la base de caja del día antes de usar el sistema.';
    }
    if (modal) modal.dataset.aperturaObligatoria = saAperturaObligatoriaActiva ? '1' : '0';
    if (saAperturaObligatoriaActiva) {
      SA_BASE_ABRIR_MODAL_CAJA('modalAperturaCaja');
      setTimeout(() => document.getElementById('aperturaCajaMonto')?.focus(), 80);
    }
  }

  cerrarModalCaja = function(id) {
    if (id === 'modalAperturaCaja' && saAperturaObligatoriaActiva) {
      const input = document.getElementById('aperturaCajaMonto');
      input?.focus();
      return;
    }
    return SA_BASE_CERRAR_MODAL_CAJA(id);
  };

  async function saVerificarAperturaObligatoriaDia({ mostrarModal = true } = {}) {
    if (!sesionActiva || !tieneRolValido()) return { ok: false, motivo: 'sin_sesion' };
    const diaClave = obtenerFechaLocalISO(new Date());
    if (!navigator.onLine || !firestoreDb || !firebaseAuth?.currentUser) {
      saDiaAperturaValidado = '';
      if (mostrarModal) saConfigurarAperturaObligatoria(true, 'Se necesita conexión con Firestore para confirmar la base de caja del día.');
      return { ok: false, motivo: 'sin_conexion', diaClave };
    }
    try {
      const snap = await firestoreDb.collection('controlCaja').doc(diaClave).get();
      const control = snap.exists
        ? normalizarControlCaja({ diaClave, ...snap.data(), _syncEstado: 'sincronizado' }, diaClave)
        : null;
      if (control?.aperturaHora) {
        guardarControlCajaEnCache(control);
        saDiaAperturaValidado = diaClave;
        const veniaBloqueandoSistema = saAperturaObligatoriaActiva;
        saConfigurarAperturaObligatoria(false);
        if (veniaBloqueandoSistema) SA_BASE_CERRAR_MODAL_CAJA('modalAperturaCaja');
        return { ok: true, diaClave, control };
      }
      saDiaAperturaValidado = '';
      if (mostrarModal) saConfigurarAperturaObligatoria(true, 'Registra la base de caja de hoy para habilitar el sistema.');
      return { ok: false, motivo: 'sin_apertura', diaClave };
    } catch (error) {
      console.error('[C9.39] No se pudo verificar la apertura obligatoria:', error);
      saDiaAperturaValidado = '';
      if (mostrarModal) saConfigurarAperturaObligatoria(true, 'No fue posible confirmar la base en Firestore. Revisa la conexión e inténtalo nuevamente.');
      return { ok: false, motivo: 'error_firestore', diaClave, error };
    }
  }

  window.verificarAperturaObligatoriaDia = saVerificarAperturaObligatoriaDia;

  function saTexto(valor = '', maximo = 300) {
    return String(valor ?? '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maximo);
  }

  function saHTML(valor = '', maximo = 500) {
    return escaparHTML(saTexto(valor, maximo));
  }

  function saId(valor = '') {
    return String(valor || '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 180) || `id_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function saClonarLimpio(valor) {
    if (Array.isArray(valor)) return valor.map(saClonarLimpio);
    if (valor && typeof valor === 'object') {
      const salida = {};
      Object.entries(valor).forEach(([clave, dato]) => {
        if (dato === undefined || typeof dato === 'function') return;
        salida[clave] = saClonarLimpio(dato);
      });
      return salida;
    }
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : 0;
    return valor;
  }

  function saLeerJSON(clave, defecto) {
    try {
      const dato = JSON.parse(localStorage.getItem(clave) || 'null');
      return dato ?? defecto;
    } catch (_) {
      return defecto;
    }
  }

  function saLimpiarContadoresLocalesLegacy() {
    // C9.39: elimina exclusivamente las claves de numeración del esquema viejo.
    // Las ventas y colas pendientes NO se borran.
    const eliminadas = [];
    try {
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const clave = localStorage.key(i);
        if (clave && /^numeracionDia_/i.test(clave)) {
          localStorage.removeItem(clave);
          eliminadas.push(clave);
        }
      }
    } catch (error) {
      console.warn('[C9.39] No se pudieron limpiar todos los contadores locales heredados:', error);
    }
    if (eliminadas.length) console.info(`[C9.39] Eliminados ${eliminadas.length} contador(es) local(es) heredados. Firestore queda como única fuente de numeración.`);
    return eliminadas;
  }
  window.limpiarContadoresLocalesLegacy = saLimpiarContadoresLocalesLegacy;

  function saEsEnLinea() {
    return Boolean(navigator.onLine && firestoreDisponible && firestoreDb && firebaseAuth?.currentUser);
  }

  function saFechaHaceDias(dias) {
    const fecha = new Date();
    fecha.setDate(fecha.getDate() - Number(dias || 0));
    return fecha.toISOString();
  }

  function saRangoDiaColombia(diaClave) {
    // Colombia permanece en UTC-5. El día local inicia a las 05:00 UTC.
    const inicio = new Date(`${diaClave}T05:00:00.000Z`);
    const fin = new Date(inicio.getTime() + 24 * 60 * 60 * 1000 - 1);
    return { desdeISO: inicio.toISOString(), hastaISO: fin.toISOString() };
  }

  function saIdentidadVenta(venta = {}) {
    return String(venta._docId || venta._localId || `${venta.diaClave || ''}_${venta.comanda || ''}_${venta.fechaISO || ''}`);
  }

  function saMensajeLogin(mensaje = '') {
    const error = document.getElementById('loginError');
    if (!error) return;
    error.textContent = mensaje;
    error.classList.toggle('hidden', !mensaje);
  }

  function saActualizarEstadoCola() {
    const colaVentas = obtenerVentasPendientesSync();
    const ventasBloqueadas = colaVentas.filter(item => item?.bloqueoPermanente).length;
    const ventasPendientes = Math.max(0, colaVentas.length - ventasBloqueadas);
    const colaCaja = saLeerJSON(SA_KEYS.cajaPendiente, []);
    const colaAuditoria = saLeerJSON(SA_KEYS.auditoriaPendiente, []);
    const totalPendiente = ventasPendientes + colaCaja.length + colaAuditoria.length;
    const el = document.getElementById('syncQueueStatus');
    if (el) {
      if (totalPendiente) {
        el.textContent = `${totalPendiente} operación(es) pendiente(s) de sincronizar${ventasBloqueadas ? ` · ${ventasBloqueadas} venta(s) antigua(s) bloqueada(s) para revisión` : ''}`;
        el.className = 'mt-1 text-xs font-semibold text-amber-700';
      } else if (ventasBloqueadas) {
        el.textContent = `Sin pendientes activos · ${ventasBloqueadas} venta(s) antigua(s) bloqueada(s) para revisión`;
        el.className = 'mt-1 text-xs font-semibold text-slate-600';
      } else {
        el.textContent = 'Sin operaciones pendientes';
        el.className = 'mt-1 text-xs font-semibold text-green-700';
      }
    }
    if (totalPendiente && navigator.onLine) {
      actualizarIndicadorFirebase('verificando', `${totalPendiente} operación(es) pendiente(s)`);
    }
  }

  function saGenerarOperacionId(prefijo = 'op') {
    if (globalThis.crypto?.randomUUID) return `${prefijo}_${crypto.randomUUID()}`;
    return `${prefijo}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }

  function saObtenerSesionId() {
    let value = '';
    try { value = sessionStorage.getItem(SA_SESSION_ID_KEY) || ''; } catch (_) {}
    if (!value) {
      value = saGenerarOperacionId('sesion');
      try { sessionStorage.setItem(SA_SESSION_ID_KEY, value); } catch (_) {}
    }
    return saId(value);
  }

  function saRotarSesionId() {
    const value = saGenerarOperacionId('sesion');
    try { sessionStorage.setItem(SA_SESSION_ID_KEY, value); } catch (_) {}
    return saId(value);
  }

  function saObtenerDeviceIdSesion() {
    let value = '';
    try { value = localStorage.getItem(SA_SESSION_DEVICE_KEY) || ''; } catch (_) {}
    if (!value) {
      value = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      guardarLocalStorageSeguro(SA_SESSION_DEVICE_KEY, value, { critico: false });
    }
    return saId(value);
  }

  function saExpiraMs(data = {}) {
    const value = data?.expiraEn;
    try {
      if (value && typeof value.toMillis === 'function') return value.toMillis();
      if (value && typeof value.toDate === 'function') return value.toDate().getTime();
      if (value?.seconds) return Number(value.seconds) * 1000;
      const parsed = new Date(value || 0).getTime();
      return Number.isFinite(parsed) ? parsed : 0;
    } catch (_) { return 0; }
  }

  function saDetenerHeartbeatSesionExclusiva() {
    if (saSesionHeartbeatTimer) clearInterval(saSesionHeartbeatTimer);
    saSesionHeartbeatTimer = null;
  }

  async function saAdquirirBloqueoPestana(uid) {
    const safeUid = saId(uid || 'anon');
    if (saTabLockHeldForUid === safeUid && saTabLockRelease) return { ok: true, existente: true };
    if (!navigator.locks?.request) return { ok: true, noSoportado: true };

    let resolverAdquisicion;
    const adquirida = new Promise(resolve => { resolverAdquisicion = resolve; });
    saTabLockPromise = navigator.locks.request(`senor-arepa-pos-${safeUid}`, { mode: 'exclusive', ifAvailable: true }, lock => {
      if (!lock) {
        resolverAdquisicion(false);
        return undefined;
      }
      saTabLockHeldForUid = safeUid;
      resolverAdquisicion(true);
      return new Promise(resolve => { saTabLockRelease = resolve; });
    }).catch(error => {
      resolverAdquisicion(false);
      console.warn('[Señor Arepa C9.39] Web Lock no disponible:', error?.message || error);
    });

    const ok = await adquirida;
    if (!ok) {
      const error = new Error('Este usuario ya está abierto en otra pestaña de este navegador.');
      error.code = 'tab-session-active';
      throw error;
    }
    return { ok: true };
  }

  function saLiberarBloqueoPestana() {
    try { if (saTabLockRelease) saTabLockRelease(); } catch (_) {}
    saTabLockRelease = null;
    saTabLockHeldForUid = '';
    saTabLockPromise = null;
  }

  function saBloquearInterfazPorSesionDuplicada(mensaje, { rotar = false } = {}) {
    saSesionExclusivaAdquirida = false;
    saSesionBloqueadaPorOtro = true;
    saDetenerHeartbeatSesionExclusiva();
    saLiberarBloqueoPestana();
    saDetenerEscuchas();
    // No limpiamos localStorage porque puede ser compartido con otra pestaña
    // legítima del mismo navegador. Solo bloqueamos esta instancia JS.
    rolActual = '';
    usuarioActual = '';
    sesionActiva = false;
    aplicarPermisosPorRol();
    if (rotar) saRotarSesionId();
    saMensajeLogin(mensaje || 'Esta cuenta ya está activa en otro dispositivo o pestaña.');
    actualizarIndicadorFirebase('desconectado', 'Sesión duplicada bloqueada');
    if (!saSesionAvisoMostrado) {
      saSesionAvisoMostrado = true;
      console.warn('[Señor Arepa C9.39] Sesión duplicada bloqueada:', mensaje || 'Cuenta activa en otro lugar.');
    }
  }

  async function saAdquirirSesionExclusiva(user, registro, { silencioso = false } = {}) {
    if (!firestoreDb || !user?.uid) throw new Error('Firestore no está disponible para validar la sesión exclusiva.');
    await saAdquirirBloqueoPestana(user.uid);
    const sessionId = saObtenerSesionId();
    const deviceId = saObtenerDeviceIdSesion();
    const ref = firestoreDb.collection(SA_SESSION_COLLECTION).doc(user.uid);
    const now = Date.now();
    const expiraEn = firebase.firestore.Timestamp.fromMillis(now + SA_SESSION_TTL_MS);
    let conflicto = null;

    try {
      await firestoreDb.runTransaction(async transaction => {
      const snap = await transaction.get(ref);
      const current = snap.exists ? (snap.data() || {}) : {};
      const currentId = String(current.sessionId || '');
      const active = snap.exists && String(current.estado || 'activa') === 'activa' && saExpiraMs(current) > now;
      if (active && currentId && currentId !== sessionId) {
        conflicto = current;
        const error = new Error('Esta cuenta ya está activa en otro dispositivo o pestaña.');
        error.code = 'session-already-active';
        throw error;
      }
      const payload = {
        uid: user.uid,
        email: String(user.email || '').toLowerCase(),
        usuario: registro?.usuario || '',
        rol: registro?.rol || '',
        sessionId,
        deviceId,
        estado: 'activa',
        expiraEn,
        actualizadoServidor: firebase.firestore.FieldValue.serverTimestamp(),
        versionSesion: 1
      };
      if (!snap.exists || currentId !== sessionId || String(current.estado || '') !== 'activa') {
        payload.inicioServidor = firebase.firestore.FieldValue.serverTimestamp();
      }
      transaction.set(ref, payload, { merge: true });
      });
    } catch (error) {
      saLiberarBloqueoPestana();
      throw error;
    }

    saSesionExclusivaAdquirida = true;
    saSesionBloqueadaPorOtro = false;
    saSesionAvisoMostrado = false;
    saDetenerHeartbeatSesionExclusiva();
    saSesionHeartbeatTimer = setInterval(() => {
      saRenovarSesionExclusiva().catch(error => {
        if (error?.code === 'session-lost') {
          saBloquearInterfazPorSesionDuplicada('La cuenta fue activada en otro lugar. Esta instancia quedó bloqueada para evitar ventas duplicadas.', { rotar: true });
        } else {
          console.warn('[Señor Arepa C9.39] No se pudo renovar el heartbeat de sesión:', error?.message || error);
        }
      });
    }, SA_SESSION_HEARTBEAT_MS);
    if (!silencioso) console.info('[Señor Arepa C9.39] Sesión exclusiva adquirida.', { uid: user.uid, sessionId, deviceId });
    return { ok: true, sessionId, deviceId, conflicto };
  }

  async function saRenovarSesionExclusiva() {
    const user = firebaseAuth?.currentUser;
    if (!user?.uid || !firestoreDb || !navigator.onLine) return { ok: false, offline: true };
    const sessionId = saObtenerSesionId();
    const ref = firestoreDb.collection(SA_SESSION_COLLECTION).doc(user.uid);
    const now = Date.now();
    const expiraEn = firebase.firestore.Timestamp.fromMillis(now + SA_SESSION_TTL_MS);
    await firestoreDb.runTransaction(async transaction => {
      const snap = await transaction.get(ref);
      const current = snap.exists ? (snap.data() || {}) : {};
      if (!snap.exists || String(current.sessionId || '') !== sessionId || String(current.estado || '') !== 'activa') {
        const error = new Error('La sesión exclusiva ya no pertenece a esta instancia.');
        error.code = 'session-lost';
        throw error;
      }
      transaction.update(ref, {
        expiraEn,
        actualizadoServidor: firebase.firestore.FieldValue.serverTimestamp(),
        estado: 'activa'
      });
    });
    saSesionExclusivaAdquirida = true;
    return { ok: true, sessionId };
  }

  async function saLiberarSesionExclusiva() {
    saDetenerHeartbeatSesionExclusiva();
    const user = firebaseAuth?.currentUser;
    if (!user?.uid || !firestoreDb || !saSesionExclusivaAdquirida) return false;
    const sessionId = saObtenerSesionId();
    const ref = firestoreDb.collection(SA_SESSION_COLLECTION).doc(user.uid);
    try {
      await firestoreDb.runTransaction(async transaction => {
        const snap = await transaction.get(ref);
        if (!snap.exists || String(snap.data()?.sessionId || '') !== sessionId) return;
        transaction.update(ref, {
          estado: 'cerrada',
          expiraEn: firebase.firestore.FieldValue.serverTimestamp(),
          actualizadoServidor: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      return true;
    } catch (error) {
      console.warn('[Señor Arepa C9.39] No se pudo liberar inmediatamente la sesión; expirará automáticamente:', error?.message || error);
      return false;
    } finally {
      saSesionExclusivaAdquirida = false;
      saLiberarBloqueoPestana();
    }
  }

  async function saValidarSesionExclusivaActual({ permitirOffline = true } = {}) {
    const user = firebaseAuth?.currentUser;
    if (!user?.uid) return { ok: false, motivo: 'No hay usuario autenticado.' };
    if (!navigator.onLine) {
      return saSesionExclusivaAdquirida && permitirOffline
        ? { ok: true, offline: true, sessionId: saObtenerSesionId() }
        : { ok: false, offline: true, motivo: 'No se ha validado una sesión exclusiva antes de quedar sin conexión.' };
    }
    try {
      const ref = firestoreDb.collection(SA_SESSION_COLLECTION).doc(user.uid);
      const snap = await ref.get();
      const current = snap.exists ? (snap.data() || {}) : {};
      const sessionId = saObtenerSesionId();
      const ok = snap.exists
        && String(current.sessionId || '') === sessionId
        && String(current.estado || '') === 'activa'
        && saExpiraMs(current) > Date.now();
      if (!ok) return { ok: false, motivo: 'La cuenta está activa en otra sesión o el bloqueo exclusivo expiró.' };
      saSesionExclusivaAdquirida = true;
      return { ok: true, sessionId, deviceId: saObtenerDeviceIdSesion() };
    } catch (error) {
      return { ok: false, motivo: error?.message || 'No fue posible validar la sesión exclusiva.' };
    }
  }

  window.obtenerSesionExclusivaActual = () => ({
    sessionId: saObtenerSesionId(),
    deviceId: saObtenerDeviceIdSesion(),
    adquirida: saSesionExclusivaAdquirida,
    bloqueada: saSesionBloqueadaPorOtro
  });
  window.validarSesionExclusivaAntesDeVenta = saValidarSesionExclusivaActual;
  window.diagnosticarSesionExclusiva = async () => {
    const user = firebaseAuth?.currentUser;
    const local = window.obtenerSesionExclusivaActual();
    let remoto = null;
    if (user?.uid && firestoreDb && navigator.onLine) {
      try {
        const snap = await firestoreDb.collection(SA_SESSION_COLLECTION).doc(user.uid).get();
        remoto = snap.exists ? snap.data() : null;
      } catch (error) { remoto = { error: error?.message || String(error) }; }
    }
    const resultado = { version: 'C9.39', uid: user?.uid || '', email: user?.email || '', local, remoto };
    console.table({ localSessionId: local.sessionId, localDeviceId: local.deviceId, adquirida: local.adquirida, bloqueada: local.bloqueada, remoteSessionId: remoto?.sessionId || '', remoteDeviceId: remoto?.deviceId || '', remoteEstado: remoto?.estado || '' });
    return resultado;
  };

  function saObtenerUsuarioSeguro() {
    const email = String(firebaseAuth?.currentUser?.email || '').toLowerCase();
    const registro = usuariosPorEmail[email];
    return registro ? { ...registro, email, uid: firebaseAuth.currentUser.uid } : null;
  }

  // ---------- Normalización y protección de texto ----------
  normalizarVenta = function(venta = {}) {
    const copia = SA_BASE_NORMALIZAR_VENTA(venta);
    copia.cliente = saTexto(copia.cliente, 120);
    copia.observaciones = saTexto(copia.observaciones, 500);
    // Los datos extendidos de entrega ya no forman parte del registro rápido del POS.
    // Solo se conservan y normalizan cuando provienen de un documento histórico.
    const camposDomicilioHistoricos = {
      telefonoCliente: 30,
      direccionDomicilio: 180,
      barrioDomicilio: 80,
      referenciaDomicilio: 180,
      domiciliarioAsignado: 100
    };
    Object.entries(camposDomicilioHistoricos).forEach(([campo, limite]) => {
      if (Object.prototype.hasOwnProperty.call(copia, campo)) copia[campo] = saTexto(copia[campo], limite);
    });
    if (Object.prototype.hasOwnProperty.call(copia, 'estadoDomicilio')) {
      copia.estadoDomicilio = SA_ESTADOS_DOMICILIO.includes(copia.estadoDomicilio)
        ? copia.estadoDomicilio
        : (esPedidoDomicilio(copia) ? 'Pendiente' : '');
    }
    copia.motivoCancelacion = saTexto(copia.motivoCancelacion, 300);
    copia.motivoEliminacion = saTexto(copia.motivoEliminacion, 300);
    copia.motivoEdicion = saTexto(copia.motivoEdicion, 300);
    copia.pedido = (Array.isArray(copia.pedido) ? copia.pedido : []).map(item => ({
      nombre: saTexto(item?.nombre, 150),
      precio: Math.max(0, Number(item?.precio || 0))
    }));
    copia._syncEstado = ['pendiente', 'sincronizado', 'error'].includes(copia._syncEstado)
      ? copia._syncEstado
      : 'sincronizado';
    return copia;
  };

  normalizarCatalogoProductos = function(origen = null) {
    const resultado = SA_BASE_NORMALIZAR_CATALOGO(origen);
    Object.values(resultado || {}).forEach(categoria => {
      if (!Array.isArray(categoria)) return;
      categoria.forEach(producto => {
        producto.nombre = saTexto(producto.nombre, 150);
        producto.icono = saTexto(producto.icono, 10);
        producto.precio = Math.max(0, Number(producto.precio || 0));
      });
    });
    return resultado;
  };

  // ---------- Autenticación estricta ----------
  resolverEmailIngreso = function(entradaUsuario = '') {
    const valor = String(entradaUsuario || '').trim().toLowerCase();
    const registro = resolverRegistroUsuario(valor);
    if (registro?.email) return registro.email;
    if (usuariosPorEmail[valor]) return valor;
    return null;
  };

  aplicarSesionAutenticada = function(usuario, rol, email) {
    const registro = usuariosPorEmail[String(email || '').toLowerCase()];
    if (!registro || registro.usuario !== usuario || registro.rol !== rol) {
      limpiarSesionLocal();
      return false;
    }
    usuarioActual = registro.usuario;
    rolActual = registro.rol;
    sesionActiva = true;
    // C9.39: el estado visual de sesión también es por pestaña. No se guarda
    // en localStorage porque ese almacenamiento es compartido entre pestañas.
    try {
      sessionStorage.setItem('usuarioActual', usuarioActual);
      sessionStorage.setItem('rolActual', rolActual);
      sessionStorage.setItem('usuarioEmailActual', String(email || '').toLowerCase());
      sessionStorage.setItem('sesionActiva', 'true');
    } catch (_) {}
    aplicarPermisosPorRol();
    return true;
  };

  limpiarSesionLocal = function() {
    rolActual = '';
    usuarioActual = '';
    sesionActiva = false;
    try {
      ['rolActual', 'usuarioActual', 'usuarioEmailActual'].forEach(clave => sessionStorage.removeItem(clave));
      sessionStorage.setItem('sesionActiva', 'false');
    } catch (_) {}
    aplicarPermisosPorRol();
  };

  function saDetenerEscuchas() {
    try { if (typeof ventasUnsubscribe === 'function') ventasUnsubscribe(); } catch (_) {}
    try { if (typeof inventarioUnsubscribe === 'function') inventarioUnsubscribe(); } catch (_) {}
    try { if (typeof catalogoUnsubscribe === 'function') catalogoUnsubscribe(); } catch (_) {}
    ventasUnsubscribe = null;
    inventarioUnsubscribe = null;
    catalogoUnsubscribe = null;
  }

  inicializarFirebaseVentas = async function() {
    if (firebaseInicializado) return;
    firebaseInicializado = true;
    actualizarIndicadorFirebase('verificando', 'Conectando exclusivamente con prsenorarepa...');
    iniciarMonitorConexionFirebase();
    if (!window.firebase) {
      actualizarIndicadorFirebase('desconectado', 'SDK de Firebase no disponible');
      return;
    }
    try {
      firebaseApp = await obtenerFirebaseAppAutorizada();
      firebaseAuth = firebase.auth(firebaseApp);
      firestoreDb = configurarFirestoreRedRobusta(firebase.firestore(firebaseApp));
      validarServiciosFirebaseAutorizados();
      // C9.39: la sesión de Authentication queda aislada por pestaña. Esto evita
      // que abrir/cerrar una segunda pestaña propague el login/logout a la caja activa.
      try {
        await firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
      } catch (error) {
        console.warn('[Señor Arepa C9.39] No se pudo cambiar Auth a persistencia SESSION:', error?.message || error);
      }
      authDisponible = Boolean(firebaseAuth);
      firestoreDisponible = Boolean(firestoreDb);
      // C9.39 usa su propia cola local. Se desactiva la persistencia IndexedDB
      // de Firestore para evitar escrituras antiguas atascadas y conflictos entre pestañas.
      saPersistenciaIntentada = true;
      console.info('[Firebase C9.39] Caché persistente del SDK desactivada; cola local propia activa.');
      firebaseAuth.onAuthStateChanged(async user => {
        if (!user) {
          saDetenerEscuchas();
          saDetenerHeartbeatSesionExclusiva();
          saLiberarBloqueoPestana();
          saSesionExclusivaAdquirida = false;
          limpiarSesionLocal();
          guardarVentasEnCache([]);
          inventarioBebidasEstado = obtenerMapaInventarioLocal();
          actualizarAlertasStockBebidas(inventarioBebidasEstado);
          cargarCatalogoProductos();
          saActualizarEstadoCola();
          return;
        }
        const email = String(user.email || '').trim().toLowerCase();
        const registro = usuariosPorEmail[email];
        if (!registro) {
          saMensajeLogin('Esta cuenta existe en Firebase, pero no está autorizada para usar el sistema.');
          saDetenerEscuchas();
          await firebaseAuth.signOut().catch(() => {});
          limpiarSesionLocal();
          return;
        }
        try {
          await saAdquirirSesionExclusiva(user, registro);
        } catch (error) {
          if (error?.code === 'session-already-active') {
            saBloquearInterfazPorSesionDuplicada('Este usuario ya está abierto en otro dispositivo o pestaña. Por seguridad, solo una conexión puede registrar ventas a la vez.');
            return;
          }
          saBloquearInterfazPorSesionDuplicada(`No fue posible validar la sesión exclusiva: ${error?.message || error}`);
          return;
        }
        aplicarSesionAutenticada(registro.usuario, registro.rol, email);
        saMensajeLogin('');
        // Restablece el acceso de caja: una consulta hecha antes de Auth no debe
        // bloquear la sesión que acaba de ser validada.
        controlCajaFirebasePermisosDisponibles = true;
        controlCajaFirebasePermisosAvisados = false;

        const diagnosticoConexion = typeof diagnosticarConexionFirebaseC98 === 'function'
          ? await diagnosticarConexionFirebaseC98({ silencioso: true })
          : { rest: true, sdk: true };

        if (!diagnosticoConexion.rest) {
          firestoreDisponible = false;
          actualizarIndicadorFirebase('desconectado', 'Firestore no responde. Revisa red, API o sesión.');
          console.error('[Firebase C9.39] Diagnóstico de conexión fallido:', diagnosticoConexion);
          saConfigurarAperturaObligatoria(true, 'Se necesita conexión con Firestore para confirmar la base de caja del día.');
          saActualizarEstadoCola();
          return;
        }

        if (!diagnosticoConexion.sdk) {
          actualizarIndicadorFirebase('desconectado', 'Canal Firestore bloqueado por red o antivirus');
          console.error('[Firebase C9.39] REST responde, pero WebChannel no. Abre el sistema desde localhost y desactiva extensiones para probar.', diagnosticoConexion);
          saConfigurarAperturaObligatoria(true, 'No se puede confirmar la base de caja mientras el canal de Firestore esté bloqueado.');
          saActualizarEstadoCola();
          return;
        }

        firestoreDisponible = true;
        await saVerificarAperturaObligatoriaDia({ mostrarModal: true });
        escucharVentasFirestore();
        escucharInventarioFirestore();
        escucharCatalogoFirestore();
        await Promise.allSettled([
          renderControlCajaDiaActual(true),
          renderTablaCierresCaja(true),
          sincronizarVentasPendientesEnSegundoPlano(),
          saSincronizarCajaPendiente(),
          saSincronizarAuditoriaPendiente()
        ]);
        registrarHeartbeatFirebase();
        saActualizarEstadoCola();
      });
    } catch (error) {
      console.error('Error al inicializar Firebase:', error);
      firestoreDisponible = false;
      authDisponible = false;
      actualizarIndicadorFirebase('desconectado', 'No se pudo iniciar Firebase');
    }
  };

  iniciarSesion = async function() {
    const usuario = document.getElementById('loginUsuario')?.value.trim() || '';
    const clave = document.getElementById('loginClave')?.value || '';
    const email = resolverEmailIngreso(usuario);
    if (!usuario || !clave) return saMensajeLogin('Ingresa usuario y contraseña.');
    if (!email || !usuariosPorEmail[email]) return saMensajeLogin('El usuario no está autorizado para ingresar.');
    if (!authDisponible || !firebaseAuth) return saMensajeLogin('Firebase Authentication todavía no está disponible.');
    const boton = document.querySelector('#loginScreen button[onclick="iniciarSesion()"]');
    if (boton) {
      boton.disabled = true;
      boton.textContent = 'Verificando acceso...';
    }
    try {
      const credencial = await firebaseAuth.signInWithEmailAndPassword(email, clave);
      const emailAutenticado = String(credencial?.user?.email || '').toLowerCase();
      if (!usuariosPorEmail[emailAutenticado]) {
        await firebaseAuth.signOut();
        throw new Error('Cuenta no autorizada');
      }
      document.getElementById('loginClave').value = '';
      document.getElementById('loginUsuario').value = '';
      const toggle = document.getElementById('toggleClave');
      if (toggle) toggle.checked = false;
      toggleVerClave();
      saMensajeLogin('');
    } catch (error) {
      const mensajes = {
        'auth/wrong-password': 'La contraseña es incorrecta.',
        'auth/invalid-credential': 'El usuario o la contraseña son incorrectos.',
        'auth/user-not-found': 'El usuario no está registrado.',
        'auth/too-many-requests': 'Se bloquearon temporalmente los intentos. Intenta más tarde.',
        'auth/network-request-failed': 'No hay conexión para verificar el acceso.'
      };
      saMensajeLogin(mensajes[error?.code] || error?.message || 'No fue posible iniciar sesión.');
    } finally {
      if (boton) {
        boton.disabled = false;
        boton.textContent = '🔐 Ingresar';
      }
    }
  };

  cerrarSesionRol = async function() {
    saAperturaObligatoriaActiva = false;
    saDiaAperturaValidado = '';
    saConfigurarAperturaObligatoria(false);
    SA_BASE_CERRAR_MODAL_CAJA('modalAperturaCaja');
    volverAlPOS();
    cerrarMobileMenu();
    document.body.classList.remove('overflow-hidden');
    saDetenerEscuchas();
    await saLiberarSesionExclusiva();
    limpiarSesionLocal();
    guardarVentasEnCache([]);
    try { await firebaseAuth?.signOut(); } catch (error) { console.error(error); }
  };

  // ---------- Auditoría ----------
  function saGuardarAuditoriaPendiente(registro) {
    const lista = saLeerJSON(SA_KEYS.auditoriaPendiente, []);
    if (!lista.some(item => item.id === registro.id)) lista.push(registro);
    guardarLocalStorageSeguro(SA_KEYS.auditoriaPendiente, lista.slice(-500), { critico: true });
    saActualizarEstadoCola();
  }

  async function registrarAuditoria(accion, entidad, entidadId, detalle = {}, idFijo = '') {
    const usuario = saObtenerUsuarioSeguro();
    const registro = {
      id: saId(idFijo || saGenerarOperacionId('aud')),
      accion: saTexto(accion, 80),
      entidad: saTexto(entidad, 80),
      entidadId: saTexto(entidadId, 180),
      usuario: usuario?.usuario || usuarioActual || '',
      rol: usuario?.rol || rolActual || '',
      email: usuario?.email || '',
      uid: usuario?.uid || '',
      fechaISO: new Date().toISOString(),
      diaClave: obtenerFechaLocalISO(new Date()),
      detalle: saClonarLimpio(detalle)
    };
    if (!saEsEnLinea()) {
      saGuardarAuditoriaPendiente(registro);
      return false;
    }
    try {
      await firestoreDb.collection('auditoria').doc(registro.id).set(registro, { merge: false });
      return true;
    } catch (_) {
      saGuardarAuditoriaPendiente(registro);
      return false;
    }
  }
  window.registrarAuditoria = registrarAuditoria;

  async function saSincronizarAuditoriaPendiente() {
    if (!saEsEnLinea()) return;
    const lista = saLeerJSON(SA_KEYS.auditoriaPendiente, []);
    if (!lista.length) return;
    const restantes = [];
    for (const registroOriginal of lista) {
      try {
        const ref = firestoreDb.collection('auditoria').doc(saId(registroOriginal.id));
        const existente = await ref.get();

        // La regla solo permite crear auditorías. Si ya existe, la operación
        // se considera sincronizada y se retira de la cola.
        if (existente.exists) continue;

        const usuario = saObtenerUsuarioSeguro();
        const registro = {
          ...saClonarLimpio(registroOriginal),
          email: String(registroOriginal.email || usuario?.email || '').toLowerCase(),
          uid: String(registroOriginal.uid || usuario?.uid || ''),
          fechaServidor: firebase.firestore.FieldValue.serverTimestamp()
        };
        await ref.set(registro, { merge: false });
      } catch (_) {
        restantes.push(registroOriginal);
      }
    }
    guardarLocalStorageSeguro(SA_KEYS.auditoriaPendiente, restantes, { critico: true });
    saActualizarEstadoCola();
  }

  // ---------- Cola idempotente de ventas ----------
  obtenerVentasPendientesSync = function() {
    const data = saLeerJSON(VENTAS_PENDIENTES_SYNC_KEY, []);
    if (!Array.isArray(data)) return [];
    return data.map((item, index) => ({
      operacionId: saId(item?.operacionId || `legacy_${item?.venta?._localId || index}`),
      tipo: item?.tipo === 'delete' ? 'delete' : 'set',
      venta: normalizarVenta(item?.venta || {}),
      ajustesInventario: item?.ajustesInventario || {},
      creadoEn: item?.creadoEn || new Date().toISOString(),
      intentos: Number(item?.intentos || 0),
      ultimoError: saTexto(item?.ultimoError, 300)
    }));
  };

  guardarVentasPendientesSync = function(items = []) {
    const lista = (Array.isArray(items) ? items : []).map(item => ({
      operacionId: saId(item.operacionId || saGenerarOperacionId('venta')),
      tipo: item.tipo === 'delete' ? 'delete' : 'set',
      venta: normalizarVenta(item.venta || {}),
      ajustesInventario: item.ajustesInventario || {},
      creadoEn: item.creadoEn || new Date().toISOString(),
      intentos: Number(item.intentos || 0),
      ultimoError: saTexto(item.ultimoError, 300)
    }));
    guardarLocalStorageSeguro(VENTAS_PENDIENTES_SYNC_KEY, lista.slice(-1000), { critico: true });
    saActualizarEstadoCola();
    return lista;
  };

  guardarVentaPendienteSync = function(venta, ajustesInventario = {}, tipo = 'set', opciones = {}) {
    const operacion = {
      operacionId: saId(opciones.operacionId || saGenerarOperacionId(tipo === 'delete' ? 'del' : 'set')),
      tipo: tipo === 'delete' ? 'delete' : 'set',
      venta: normalizarVenta(venta),
      ajustesInventario: ajustesInventario || {},
      creadoEn: opciones.creadoEn || new Date().toISOString(),
      intentos: 0,
      ultimoError: ''
    };
    const lista = obtenerVentasPendientesSync();
    if (!lista.some(item => item.operacionId === operacion.operacionId)) lista.push(operacion);
    guardarVentasPendientesSync(lista);
    return operacion;
  };

  quitarVentaPendienteSync = function(identificador = '') {
    const clave = String(identificador || '').trim();
    if (!clave) return;
    const lista = obtenerVentasPendientesSync().filter(item => {
      const idVenta = item.venta?._localId || item.venta?._docId || '';
      return item.operacionId !== clave && idVenta !== clave;
    });
    guardarVentasPendientesSync(lista);
  };

  fusionarVentasRemotasConPendientes = function(ventasRemotas = []) {
    const mapa = new Map((Array.isArray(ventasRemotas) ? ventasRemotas : []).map(v => [saIdentidadVenta(v), normalizarVenta(v)]));
    obtenerVentasPendientesSync()
      .sort((a, b) => String(a.creadoEn).localeCompare(String(b.creadoEn)))
      .forEach(item => {
        const clave = saIdentidadVenta(item.venta);
        if (item.tipo === 'delete') mapa.delete(clave);
        else mapa.set(clave, { ...normalizarVenta(item.venta), _syncEstado: item.intentos >= 3 ? 'error' : 'pendiente' });
      });
    return ordenarVentasDesc(Array.from(mapa.values()));
  };

  function saLimpiarVentaFirestore(venta = {}) {
    const limpia = normalizarVenta(venta);
    delete limpia._docId;
    delete limpia._syncEstado;
    return saClonarLimpio(limpia);
  }

  async function saResolverInventario(ajustes = {}) {
    const resultado = [];
    for (const [clave, ajuste] of Object.entries(ajustes || {})) {
      const snapshot = await firestoreDb.collection(INVENTARIO_COLLECTION)
        .where('nombreNormalizado', '==', clave)
        .limit(1)
        .get();
      if (snapshot.empty) {
        throw new Error(`No existe un registro de inventario para ${ajuste?.nombre || clave}.`);
      }
      resultado.push({ clave, ajuste, ref: snapshot.docs[0].ref });
    }
    return resultado;
  }

  async function saEjecutarOperacionVentaFirebase(item) {
    if (!saEsEnLinea()) throw new Error('Sin conexión con Firebase.');

    const venta = normalizarVenta(item.venta || {});
    const docId = saId(venta._docId || venta._localId || saGenerarOperacionId('venta'));
    const ventaRef = firestoreDb.collection('ventas').doc(docId);
    const inventario = await saResolverInventario(item.ajustesInventario || {});
    const auditoriaRef = firestoreDb.collection('auditoria').doc(saId(`aud_${item.operacionId}`));
    const emailActual = String(firebaseAuth.currentUser?.email || '').toLowerCase();
    const uidActual = String(firebaseAuth.currentUser?.uid || '');

    await firestoreDb.runTransaction(async transaction => {
      const ventaSnap = await transaction.get(ventaRef);
      const ventaRemota = ventaSnap.exists ? { _docId: ventaSnap.id, ...ventaSnap.data() } : null;
      const versionRemota = Number(ventaRemota?.version || 0);
      const versionEsperada = Number(item.versionEsperada ?? Math.max(0, Number(venta.version || 1) - 1));

      if (ventaRemota?._ultimaOperacionId === item.operacionId) return;

      // Permite limpiar colas antiguas cuando la misma venta ya quedó creada.
      if (
        ventaRemota
        && item.tipo !== 'delete'
        && versionEsperada === 0
        && venta._localId
        && ventaRemota._localId === venta._localId
      ) {
        return;
      }

      if (versionRemota !== versionEsperada) {
        throw new Error(`Conflicto de versión: servidor ${versionRemota}, esperado ${versionEsperada}.`);
      }

      if (ventaRemota && item.tipo !== 'delete' && !['admin@local.io', 'administrador@local.io'].includes(emailActual)) {
        throw new Error('El cajero no puede modificar una venta ya sincronizada.');
      }

      if (item.tipo === 'delete' && emailActual !== 'admin@local.io') {
        throw new Error('Solo admin@local.io puede eliminar ventas.');
      }

      const movimientos = [];
      for (const entrada of inventario) {
        const movimientoRef = firestoreDb.collection('movimientosInventario').doc(saId(`${item.operacionId}_${entrada.clave}`));
        const movimientoSnap = await transaction.get(movimientoRef);
        const inventarioSnap = await transaction.get(entrada.ref);
        movimientos.push({ ...entrada, movimientoRef, movimientoSnap, inventarioSnap });
      }

      const timestamp = firebase.firestore.FieldValue.serverTimestamp();

      if (item.tipo === 'delete') {
        if (ventaRemota) transaction.delete(ventaRef);
      } else if (!ventaRemota || ventaRemota._localId !== venta._localId || versionEsperada !== 0) {
        const payload = {
          ...saLimpiarVentaFirestore(venta),
          _localId: venta._localId || docId,
          version: versionRemota + 1,
          _ultimaOperacionId: item.operacionId,
          actualizadoServidor: timestamp
        };
        delete payload.creadoServidor;
        delete payload.fechaServidor;
        if (!ventaRemota) payload.creadoServidor = timestamp;
        transaction.set(ventaRef, payload, { merge: Boolean(ventaRemota) });
      }

      for (const movimiento of movimientos) {
        if (movimiento.movimientoSnap.exists) continue;
        if (!movimiento.inventarioSnap.exists) {
          throw new Error(`No existe inventario para ${movimiento.ajuste?.nombre || movimiento.clave}.`);
        }

        const dataActual = movimiento.inventarioSnap.data() || {};
        const actual = Number(dataActual.cantidad || 0);
        const cambio = Number(movimiento.ajuste?.cantidad || 0);
        const nuevaCantidad = actual + cambio;
        if (nuevaCantidad < 0) {
          throw new Error(`Stock insuficiente para ${movimiento.ajuste?.nombre || movimiento.clave}. Disponible: ${actual}.`);
        }

        transaction.update(movimiento.ref, {
          cantidad: nuevaCantidad,
          inventoryId: String(dataActual.inventoryId || movimiento.ajuste?.inventoryId || movimiento.ref.id),
          productId: String(dataActual.productId || movimiento.ajuste?.productId || ''),
          nombreNormalizado: String(dataActual.nombreNormalizado || movimiento.clave),
          fechaISOCliente: new Date().toISOString(),
          actualizadoServidor: timestamp
        });

        transaction.set(movimiento.movimientoRef, {
          operacionId: item.operacionId,
          ventaId: docId,
          tipoOperacion: item.tipo,
          producto: movimiento.ajuste?.nombre || movimiento.clave,
          nombreNormalizado: movimiento.clave,
          cantidadAnterior: actual,
          cambio,
          cantidadNueva: nuevaCantidad,
          usuario: usuarioActual || '',
          uid: uidActual,
          fechaISOCliente: new Date().toISOString(),
          fechaServidor: timestamp
        }, { merge: false });
      }

      transaction.set(auditoriaRef, {
        id: auditoriaRef.id,
        accion: item.tipo === 'delete' ? 'eliminar_venta' : (ventaRemota ? 'actualizar_venta' : 'crear_venta'),
        entidad: 'ventas',
        entidadId: docId,
        usuario: usuarioActual || '',
        rol: rolActual || '',
        email: emailActual,
        uid: uidActual,
        fechaISOCliente: new Date().toISOString(),
        fechaServidor: timestamp,
        diaClave: obtenerFechaLocalISO(new Date()),
        detalle: {
          operacionId: item.operacionId,
          comanda: venta.comanda || null,
          cliente: venta.cliente || ''
        }
      }, { merge: false });
    });

    registrarHeartbeatFirebase();
    return docId;
  }

  sincronizarVentasPendientesEnSegundoPlano = async function() {
    if (sincronizandoVentasPendientes || !saEsEnLinea()) return { exitosas: 0, fallidas: 0 };
    let lista = obtenerVentasPendientesSync();
    if (!lista.length) return { exitosas: 0, fallidas: 0 };
    sincronizandoVentasPendientes = true;
    let exitosas = 0;
    let fallidas = 0;
    try {
      for (const itemOriginal of [...lista]) {
        const item = { ...itemOriginal };
        try {
          const docId = await saEjecutarOperacionVentaFirebase(item);
          lista = lista.filter(op => op.operacionId !== item.operacionId);
          guardarVentasPendientesSync(lista);
          if (item.tipo !== 'delete') {
            const otras = lista.some(op => saIdentidadVenta(op.venta) === saIdentidadVenta(item.venta));
            const sincronizada = { ...item.venta, _docId: docId, _syncEstado: otras ? 'pendiente' : 'sincronizado' };
            upsertVentaEnCacheLocal(sincronizada);
            guardarReferenciaUltimaVenta(sincronizada);
          }
          exitosas += 1;
        } catch (error) {
          fallidas += 1;
          lista = lista.map(op => op.operacionId === item.operacionId
            ? { ...op, intentos: Number(op.intentos || 0) + 1, ultimoError: saTexto(error?.message || error, 300) }
            : op);
          guardarVentasPendientesSync(lista);
          if (item.tipo !== 'delete') {
            upsertVentaEnCacheLocal({ ...item.venta, _syncEstado: Number(item.intentos || 0) + 1 >= 3 ? 'error' : 'pendiente' });
          }
          console.error('Operación pendiente no sincronizada:', error);
          if (!navigator.onLine) break;
        }
      }
    } finally {
      sincronizandoVentasPendientes = false;
      saActualizarEstadoCola();
      mostrarVentas();
      refrescarVistasAnaliticasSiEstanAbiertas();
    }
    return { exitosas, fallidas };
  };

  guardarVentaEnFirebase = async function(venta, docId = null) {
    if (!saEsEnLinea()) throw new Error('Firebase no está disponible.');

    const limpia = normalizarVenta(venta || {});
    const id = saId(docId || limpia._docId || limpia._localId || saGenerarOperacionId('venta'));
    const ref = firestoreDb.collection('ventas').doc(id);
    const emailActual = String(firebaseAuth.currentUser?.email || '').toLowerCase();
    const timestamp = firebase.firestore.FieldValue.serverTimestamp();

    await firestoreDb.runTransaction(async transaction => {
      const snap = await transaction.get(ref);
      const remoto = snap.exists ? (snap.data() || {}) : null;
      if (remoto && !['admin@local.io', 'administrador@local.io'].includes(emailActual)) {
        throw new Error('El cajero puede crear ventas, pero no modificar una venta ya sincronizada.');
      }

      const payload = {
        ...saLimpiarVentaFirestore(limpia),
        _localId: limpia._localId || id,
        version: remoto ? Number(remoto.version || 0) + 1 : 1,
        actualizadoServidor: timestamp
      };
      delete payload.creadoServidor;
      delete payload.fechaServidor;
      if (!remoto) payload.creadoServidor = timestamp;

      transaction.set(ref, payload, { merge: Boolean(remoto) });
    });

    registrarHeartbeatFirebase();
    return id;
  };

  migrarVentasLocalesAFirebase = async function(ventasLocales = []) {
    for (const venta of ventasLocales) {
      const normalizada = normalizarVenta(venta);
      normalizada._localId = normalizada._localId || generarIdVentaLocal();
      await guardarVentaEnFirebase(normalizada, normalizada._localId);
    }
  };

  escucharVentasFirestore = function() {
    if (!firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser) return;
    if (typeof ventasUnsubscribe === 'function') ventasUnsubscribe();
    const desdeISO = saFechaHaceDias(SA_CONFIG.diasVentasIniciales);
    ventasUnsubscribe = firestoreDb.collection('ventas')
      .where('fechaISO', '>=', desdeISO)
      .orderBy('fechaISO', 'desc')
      .limit(SA_CONFIG.limiteConsulta)
      .onSnapshot(snapshot => {
        registrarHeartbeatFirebase();
        const remotas = snapshot.docs.map(doc => normalizarVenta({ _docId: doc.id, ...doc.data() }));
        const anteriores = obtenerVentasStorage().filter(v => String(v.fechaISO || '') < desdeISO);
        guardarVentasEnCache(fusionarVentasRemotasConPendientes([...remotas, ...anteriores]));
        programarSyncVentasPendientes(80);
        mostrarVentas();
        refrescarVistasAnaliticasSiEstanAbiertas();
        saActualizarEstadoCola();
      }, error => {
        console.error('Error al escuchar ventas:', error);
        actualizarIndicadorFirebase('desconectado', 'No fue posible actualizar las ventas');
        reconectarFirestoreSeguro('listener-ventas');
      });
  };

  async function saCargarVentasRango(desdeISO, hastaISO) {
    if (!saEsEnLinea()) return [];
    try {
      const snapshot = await firestoreDb.collection('ventas')
        .where('fechaISO', '>=', desdeISO)
        .where('fechaISO', '<=', hastaISO)
        .orderBy('fechaISO', 'desc')
        .limit(SA_CONFIG.limiteConsulta)
        .get();
      const nuevas = snapshot.docs.map(doc => normalizarVenta({ _docId: doc.id, ...doc.data() }));
      const mapa = new Map(obtenerVentasStorage().map(v => [saIdentidadVenta(v), v]));
      nuevas.forEach(v => mapa.set(saIdentidadVenta(v), v));
      guardarVentasEnCache(fusionarVentasRemotasConPendientes(Array.from(mapa.values())));
      return nuevas;
    } catch (error) {
      console.error('No se pudo consultar el rango solicitado:', error);
      return [];
    }
  }

  // ---------- Consecutivos únicos ----------
  function saConsecutivoTemporal(diaClave, prefijo) {
    const ahora = new Date();
    const hora = `${String(ahora.getHours()).padStart(2, '0')}${String(ahora.getMinutes()).padStart(2, '0')}${String(ahora.getSeconds()).padStart(2, '0')}`;
    return `${prefijo}${String(diaClave).replaceAll('-', '').slice(2)}${hora}${Math.floor(Math.random() * 90 + 10)}`;
  }

  async function saReservarConsecutivos(diaClave, requiereDomicilio) {
    // C9.39: NO se inventan números en el navegador. Una venta pendiente usa
    // cero como marcador temporal y recibe su 1, 2, 3... únicamente dentro de
    // la transacción global de Firestore. Esto evita duplicados entre equipos.
    return {
      comanda: 0,
      recibo: 0,
      domicilio: requiereDomicilio ? 0 : null,
      temporal: true,
      diaClave
    };
  }

  // ---------- Inventario seguro ----------
  aplicarEstadoVisualBotonBebida = function(btn, infoStock = null) {
    const nombreProducto = btn.dataset.productName || '';
    const original = btn.dataset.originalLabel || btn.textContent.trim();
    const cantidad = Number(infoStock?.cantidad ?? NaN);
    const tieneStock = Number.isFinite(cantidad);
    const agotado = tieneStock && cantidad <= 0;
    const bajo = tieneStock && cantidad > 0 && cantidad <= STOCK_BEBIDA_BAJO_UMBRAL;
    btn.classList.remove('bebida-stock-bajo', 'bebida-stock-agotado');
    btn.disabled = agotado || !tieneRolValido();
    btn.classList.toggle('cursor-not-allowed', agotado);
    btn.classList.toggle('opacity-70', agotado);
    const etiqueta = tieneStock ? (agotado ? 'AGOTADO' : `Stock: ${cantidad}`) : 'Stock sin cargar';
    if (agotado || bajo) btn.classList.add(agotado ? 'bebida-stock-agotado' : 'bebida-stock-bajo');
    btn.title = nombreProducto ? `${nombreProducto} · ${etiqueta}` : etiqueta;
    btn.innerHTML = `<span>${saHTML(original, 180)}</span><span class="stock-alert-badge">${saHTML(etiqueta, 40)}</span>`;
  };

  function saValidarStockPedido(ventaAnterior = null) {
    const conteoNuevo = contarBebidasPedidoInventario(pedido);
    const conteoAnterior = ventaAnterior && !esVentaCancelada(ventaAnterior)
      ? contarBebidasPedidoInventario(ventaAnterior.pedido || [])
      : {};
    for (const [clave, info] of Object.entries(conteoNuevo)) {
      const stock = Number(inventarioBebidasEstado?.[clave]?.cantidad ?? NaN);
      if (!Number.isFinite(stock)) continue;
      const disponibleReal = stock + Number(conteoAnterior?.[clave]?.cantidad || 0);
      if (Number(info.cantidad || 0) > disponibleReal) {
        alert(`No hay suficiente stock de ${info.nombre}. Disponible para este pedido: ${disponibleReal}.`);
        return false;
      }
    }
    return true;
  }

  agregarProducto = function(nombre, precio) {
    const nombreLimpio = saTexto(nombre, 150);
    if (esProductoBebidaInventario(nombreLimpio)) {
      const clave = normalizarClaveInventario(nombreLimpio);
      const stock = Number(inventarioBebidasEstado?.[clave]?.cantidad ?? NaN);
      const yaAgregadas = pedido.filter(item => normalizarClaveInventario(item.nombre) === clave).length;
      if (Number.isFinite(stock) && yaAgregadas >= stock) {
        alert(`No hay más unidades disponibles de ${nombreLimpio}. Stock actual: ${stock}.`);
        return;
      }
    }
    pedido.push({ nombre: nombreLimpio, precio: Math.max(0, Number(precio || 0)) });
    actualizarTotal();
    actualizarVistaPedido();
  };

  // ---------- Caja sincronizada e inmutable ----------
  normalizarControlCaja = function(control = {}, diaClave = '') {
    const base = SA_BASE_NORMALIZAR_CAJA(control, diaClave);
    base.cierreObservaciones = saTexto(base.cierreObservaciones, 500);
    base.cierreAnulado = Boolean(control.cierreAnulado);
    base.cierreAnuladoPor = saTexto(control.cierreAnuladoPor, 100);
    base.cierreAnuladoMotivo = saTexto(control.cierreAnuladoMotivo, 300);
    base.cierreAnuladoFecha = control.cierreAnuladoFecha || '';
    base.resumenCierre = control.resumenCierre && typeof control.resumenCierre === 'object'
      ? saClonarLimpio(control.resumenCierre)
      : null;
    base.historialCambios = Array.isArray(control.historialCambios) ? control.historialCambios.slice(-30) : [];
    base._syncEstado = ['pendiente', 'sincronizado', 'error'].includes(control._syncEstado) ? control._syncEstado : 'sincronizado';
    return base;
  };

  tieneCierreRegistradoControl = function(control = {}) {
    return !control.cierreAnulado && (Boolean(normalizarTextoCaja(control.cierreHora)) || Number(control.cierreMonto || 0) > 0);
  };

  obtenerResumenCajaDiaParaControl = function(diaClave, control = {}) {
    if (tieneCierreRegistradoControl(control) && control.resumenCierre) {
      return { ...calcularResumenCajaDia(diaClave), ...saClonarLimpio(control.resumenCierre) };
    }
    return SA_BASE_RESUMEN_CAJA_CONTROL(diaClave, control);
  };

  function saGuardarCajaPendiente(diaClave, payload) {
    const lista = saLeerJSON(SA_KEYS.cajaPendiente, []);
    const registro = { diaClave, payload: normalizarControlCaja(payload, diaClave), intentos: 0, actualizadoEn: new Date().toISOString() };
    const index = lista.findIndex(item => item.diaClave === diaClave);
    if (index >= 0) lista[index] = registro;
    else lista.push(registro);
    guardarLocalStorageSeguro(SA_KEYS.cajaPendiente, lista.slice(-400), { critico: true });
    saActualizarEstadoCola();
  }

  async function saSincronizarCajaPendiente() {
    // El módulo 05 es el propietario definitivo de la cola V4.
    if (typeof window.sincronizarCajaSegura === 'function') {
      return window.sincronizarCajaSegura();
    }

    if (saSincronizandoCaja || !saEsEnLinea()) return;
    saSincronizandoCaja = true;
    const lista = saLeerJSON(SA_KEYS.cajaPendiente, []);
    const restantes = [];

    try {
      for (const item of lista) {
        try {
          const ref = firestoreDb.collection('controlCaja').doc(saId(item.diaClave));
          const payloadBase = normalizarControlCaja(item.payload, item.diaClave);

          await firestoreDb.runTransaction(async transaction => {
            const snap = await transaction.get(ref);
            const remoto = snap.exists ? normalizarControlCaja({ diaClave: item.diaClave, ...snap.data() }, item.diaClave) : null;
            const timestamp = firebase.firestore.FieldValue.serverTimestamp();
            const payload = saClonarLimpio({
              ...payloadBase,
              diaClave: item.diaClave,
              version: Number(remoto?.version || 0) + 1
            });

            delete payload._syncEstado;
            delete payload.creadoServidor;
            delete payload.actualizadoServidor;
            payload.actualizadoServidor = timestamp;
            if (!remoto) payload.creadoServidor = timestamp;

            transaction.set(ref, payload, { merge: Boolean(remoto) });
          });

          guardarControlCajaEnCache({ ...payloadBase, _syncEstado: 'sincronizado' });
          await registrarAuditoria(
            'sincronizar_caja',
            'controlCaja',
            item.diaClave,
            { cierre: Boolean(payloadBase.cierreHora) },
            `caja_${item.diaClave}_${item.actualizadoEn}`
          );
        } catch (error) {
          restantes.push({
            ...item,
            intentos: Number(item.intentos || 0) + 1,
            ultimoError: saTexto(error?.message || error, 300)
          });
        }
      }
      guardarLocalStorageSeguro(SA_KEYS.cajaPendiente, restantes, { critico: true });
    } finally {
      saSincronizandoCaja = false;
      saActualizarEstadoCola();
    }
  }

  guardarControlCajaDia = async function(diaClave, payload = {}) {
    const control = normalizarControlCaja({ ...payload, diaClave, _syncEstado: 'pendiente' }, diaClave);
    guardarControlCajaEnCache(control);
    saGuardarCajaPendiente(diaClave, control);
    if (saEsEnLinea()) await saSincronizarCajaPendiente();
    return obtenerControlCajaLocal(diaClave);
  };

  registrarAperturaCaja = async function() {
    if (!verificarAcceso(['admin', 'cajero'])) return;
    if (!navigator.onLine || !firestoreDb || !firebaseAuth?.currentUser) {
      saConfigurarAperturaObligatoria(true, 'Conéctate a Firestore para registrar y confirmar la base de caja antes de usar el sistema.');
      return alert('La apertura obligatoria debe quedar confirmada en Firestore. Revisa la conexión e intenta nuevamente.');
    }
    const monto = Number(document.getElementById('aperturaCajaMonto')?.value || 0);
    if (!Number.isFinite(monto) || monto < 0) return alert('Ingresa un monto válido para la apertura.');
    const diaClave = obtenerFechaLocalISO(new Date());
    const actual = await obtenerControlCajaDia(diaClave, true);
    if (tieneCierreRegistradoControl(actual)) {
      return alert('La caja de hoy ya tiene un cierre activo. Debes anular el cierre antes de modificar la apertura.');
    }
    if (actual.aperturaHora) {
      if (!confirm('La caja ya tiene una apertura. ¿Deseas reemplazar el monto de apertura?')) return;
    }
    const esAperturaNueva = !actual.aperturaHora;
    const aperturaHora = actual.aperturaHora || new Date().toISOString();
    const jornadaId = actual.jornadaId
      || (typeof window.obtenerJornadaIdCaja === 'function'
        ? window.obtenerJornadaIdCaja(diaClave, aperturaHora)
        : `J_${diaClave}_${new Date(aperturaHora).getTime() || Date.now()}`);
    if (esAperturaNueva) saLimpiarContadoresLocalesLegacy();

    const nuevo = await guardarControlCajaDia(diaClave, {
      ...actual,
      aperturaMonto: monto,
      aperturaHora,
      aperturaUsuario: usuarioActual || '',
      jornadaId,
      jornadaInicioISO: actual.jornadaInicioISO || aperturaHora,
      cierreAnulado: false
    });

    // C9.39: si estamos en línea, no damos la apertura por confirmada hasta
    // comprobar el documento remoto. Esto evita que el contador intente nacer
    // sobre una apertura que solo quedó en la cola local.
    let aperturaConfirmada = nuevo;
    if (saEsEnLinea()) {
      try {
        const snapApertura = await firestoreDb.collection('controlCaja').doc(diaClave).get();
        if (!snapApertura.exists || !snapApertura.data()?.aperturaHora) {
          throw new Error('La apertura todavía no aparece confirmada en Firestore.');
        }
        aperturaConfirmada = normalizarControlCaja({ diaClave, ...snapApertura.data(), _syncEstado: 'sincronizado' }, diaClave);
        guardarControlCajaEnCache(aperturaConfirmada);
      } catch (error) {
        console.error('[C9.39] Apertura pendiente de sincronización:', error);
        return alert('La apertura quedó pendiente y aún NO está confirmada en Firestore. No registres ventas hasta que la conexión se restablezca y la apertura aparezca sincronizada.');
      }
    }

    // C9.39: la apertura es el punto cero del consecutivo. Si la jornada acaba
    // de iniciar y no tiene ventas confirmadas, el contador queda en 0 para que
    // la primera comanda sea 1. Si ya existen ventas de ESTA jornada, conserva
    // el mayor consecutivo confirmado.
    if (saEsEnLinea() && typeof window.inicializarContadorNuevaJornada === 'function') {
      try {
        const contador = await window.inicializarContadorNuevaJornada(diaClave, aperturaConfirmada);
        console.info(`[C9.39] Jornada ${jornadaId} preparada. Siguiente comanda: ${Number(contador?.ultimoConsecutivo || 0) + 1}.`);
      } catch (error) {
        console.error('[C9.39] La apertura quedó guardada, pero no se pudo inicializar el contador de jornada:', error);
        return alert('La apertura quedó guardada, pero no fue posible preparar el contador de comandas. Revisa la conexión antes de registrar ventas.');
      }
    }

    await registrarAuditoria('registrar_apertura', 'controlCaja', diaClave, { monto, jornadaId });
    saDiaAperturaValidado = diaClave;
    saConfigurarAperturaObligatoria(false);
    alert('Base de caja registrada y confirmada. El sistema ya está habilitado.');
    cerrarModalCaja('modalAperturaCaja');
    await renderControlCajaDiaActual();
    renderTablaCierresCaja(true);
  };

  registrarCierreCaja = async function() {
    const editando = Boolean(cierreCajaEdicionDiaClave);
    if (editando ? !esAdmin() : !verificarAcceso(['admin', 'cajero'])) return;
    const diaClave = obtenerDiaObjetivoCierreCaja();
    const actual = await obtenerControlCajaDia(diaClave, true);
    if (!actual.aperturaHora) return alert('Primero registra la apertura de caja.');
    const monto = Number(document.getElementById('cierreCajaMonto')?.value || 0);
    const observaciones = saTexto(document.getElementById('cierreCajaObservaciones')?.value || '', 500);
    if (!Number.isFinite(monto) || monto < 0) return alert('Ingresa un monto válido para el cierre.');
    const resumen = calcularResumenCajaDia(diaClave);
    const esperado = redondearPago(Number(actual.aperturaMonto || 0) + Number(resumen.efectivoNetoSistema || 0));
    const cambio = {
      fechaISO: new Date().toISOString(),
      usuario: usuarioActual || '',
      accion: editando ? 'editar_cierre' : 'registrar_cierre',
      montoAnterior: Number(actual.cierreMonto || 0),
      montoNuevo: monto
    };
    const nuevo = await guardarControlCajaDia(diaClave, {
      ...actual,
      cierreMonto: monto,
      cierreHora: new Date().toISOString(),
      cierreUsuario: usuarioActual || '',
      cierreObservaciones: observaciones,
      cierreAnulado: false,
      resumenCierre: {
        ...resumen,
        aperturaMonto: Number(actual.aperturaMonto || 0),
        montoEsperadoCaja: esperado,
        montoContado: monto,
        diferencia: redondearPago(monto - esperado),
        congeladoEn: new Date().toISOString()
      },
      historialCambios: [...(actual.historialCambios || []), cambio].slice(-30)
    });
    await registrarAuditoria(editando ? 'editar_cierre' : 'registrar_cierre', 'controlCaja', diaClave, { monto, esperado, diferencia: monto - esperado });
    alert(nuevo._syncEstado === 'sincronizado' ? 'Cierre registrado y sincronizado.' : 'Cierre guardado localmente; queda pendiente de sincronización.');
    cerrarModalCaja('modalCierreCaja');
    await renderControlCajaDiaActual();
    await renderResumenCajaFecha(diaClave, true);
    renderTablaCierresCaja(true);
  };

  eliminarCierreCaja = async function(diaClave) {
    if (!verificarAcceso(['admin'])) return;
    const actual = await obtenerControlCajaDia(diaClave, true);
    if (!tieneCierreRegistradoControl(actual)) return alert('Ese día no tiene un cierre activo.');
    const motivo = saTexto(prompt('Escribe el motivo para anular este cierre:') || '', 300);
    if (!motivo) return alert('Debes registrar un motivo.');
    if (!confirm(`¿Anular el cierre del ${diaClave}? El registro original se conservará para auditoría.`)) return;
    await guardarControlCajaDia(diaClave, {
      ...actual,
      cierreAnulado: true,
      cierreAnuladoPor: usuarioActual || '',
      cierreAnuladoMotivo: motivo,
      cierreAnuladoFecha: new Date().toISOString(),
      historialCambios: [...(actual.historialCambios || []), {
        fechaISO: new Date().toISOString(), usuario: usuarioActual || '', accion: 'anular_cierre', motivo
      }].slice(-30)
    });
    await registrarAuditoria('anular_cierre', 'controlCaja', diaClave, { motivo });
    alert('El cierre fue anulado, pero se conservó su historial.');
    await renderControlCajaDiaActual(true);
    renderTablaCierresCaja(true);
  };

  async function saValidarCajaVenta(diaClave, esNueva) {
    if (!SA_CONFIG.exigirCajaAbierta || !esNueva) return true;
    let control = null;
    if (saEsEnLinea() && firestoreDb) {
      try {
        const snap = await firestoreDb.collection('controlCaja').doc(diaClave).get();
        control = snap.exists ? normalizarControlCaja({ diaClave, ...snap.data(), _syncEstado: 'sincronizado' }, diaClave) : null;
        if (control) guardarControlCajaEnCache(control);
      } catch (error) {
        console.error('[C9.39] No se pudo confirmar la apertura de caja en Firestore:', error);
        alert('No fue posible confirmar la apertura de caja en Firestore. Revisa la conexión antes de vender.');
        return false;
      }
    } else {
      control = await obtenerControlCajaDia(diaClave, false);
    }
    if (!control?.aperturaHora) {
      alert(saEsEnLinea()
        ? 'Debes registrar y sincronizar la apertura de caja antes de vender.'
        : 'La caja no tiene una apertura disponible en este equipo. Conéctate y sincroniza la apertura antes de vender.');
      return false;
    }
    if (tieneCierreRegistradoControl(control)) {
      alert('La caja de hoy ya está cerrada. No se pueden registrar nuevas ventas.');
      return false;
    }
    return true;
  }

  async function saValidarPeriodoCerrado(venta, accion) {
    if (!venta?.diaClave) return '';
    const control = await obtenerControlCajaDia(venta.diaClave, true);
    if (!tieneCierreRegistradoControl(control)) return '';
    if (!esAdmin()) {
      alert(`La caja del ${venta.diaClave} está cerrada. Solo el administrador principal puede ${accion} esta venta.`);
      return null;
    }
    const motivo = saTexto(prompt(`La caja del ${venta.diaClave} está cerrada. Escribe el motivo para ${accion} la venta:`) || '', 300);
    if (!motivo) {
      alert('Debes registrar un motivo para modificar un periodo cerrado.');
      return null;
    }
    return motivo;
  }

  // ---------- Domicilio rápido: el POS solicita únicamente el costo ----------
  actualizarCampoCostoDomicilio = function() {
    SA_BASE_ACTUALIZAR_CAMPO_DOMICILIO();
  };

  limpiarPedido = function() {
    SA_BASE_LIMPIAR_PEDIDO();
  };

  editarVenta = function(index) {
    SA_BASE_EDITAR_VENTA(index);
  };

  // ---------- Guardado de venta mejorado ----------
  guardarVenta = async function() {
    if (saGuardandoVenta) return;
    if (!verificarAcceso(['admin', 'cajero'])) return;
    const aperturaDisponible = saDiaAperturaValidado === obtenerFechaLocalISO(new Date()) && !saAperturaObligatoriaActiva;
    if (!aperturaDisponible) {
      const estadoApertura = await saVerificarAperturaObligatoriaDia({ mostrarModal: true });
      if (!estadoApertura.ok) return;
    }
    const sesionValida = await saValidarSesionExclusivaActual({ permitirOffline: true });
    if (!sesionValida?.ok) {
      if (!sesionValida?.offline) saBloquearInterfazPorSesionDuplicada(sesionValida?.motivo || 'La sesión exclusiva no pertenece a esta instancia.', { rotar: true });
      return alert(sesionValida?.motivo || 'No se puede guardar hasta validar la sesión exclusiva de este usuario.');
    }
    saGuardandoVenta = true;
    const botonesGuardar = document.querySelectorAll('button[onclick*="guardarVenta"]');
    botonesGuardar.forEach(btn => { btn.disabled = true; btn.classList.add('opacity-60'); });
    let popupCocina = null;
    try {
      const cliente = saTexto(document.getElementById('cliente')?.value, 120);
      const formaPago = document.getElementById('formaPago')?.value || '';
      const tipoPedido = document.getElementById('tipoPedido')?.value || '';
      if (!pedido.length) return alert('Agrega productos al pedido.');
      if (!cliente) return alert('Ingresa el nombre del cliente.');
      if (!formaPago) return alert('Selecciona una forma de pago.');
      if (!tipoPedido) return alert('Selecciona un tipo de pedido.');
      if (!saValidarStockPedido(ventaOriginalEnEdicion)) return;

      const costoTexto = String(document.getElementById('costoDomicilio')?.value || '').trim();
      if (tipoPedido === 'Domicilio' && !costoTexto) return alert('Ingresa el valor del domicilio.');
      const costoDomicilio = tipoPedido === 'Domicilio' ? Number(costoTexto || 0) : 0;
      if (!Number.isFinite(costoDomicilio) || costoDomicilio < 0) return alert('Ingresa un valor válido para el domicilio.');

      actualizarTotal();
      const subtotalProductos = obtenerSubtotalPedidoActual();
      const totalCobrado = redondearPago(subtotalProductos + costoDomicilio);
      const detallePagos = construirDetallePagosVentaDesdeFormulario(formaPago, totalCobrado);
      if (formaPago === 'mixto') {
        const suma = redondearPago(detallePagos.reduce((acc, item) => acc + Number(item.valor || 0), 0));
        if (!detallePagos.length || Math.abs(suma - totalCobrado) >= 0.01) {
          abrirModalPagoMixto();
          return alert('El pago mixto debe coincidir exactamente con el total.');
        }
      }

      const ahora = new Date();
      const esNueva = !ventaDocIdEnEdicion && !ventaOriginalEnEdicion?._localId;
      const selloNegocio = esNueva
        ? (typeof obtenerSelloVentaColombia === 'function'
            ? obtenerSelloVentaColombia(ahora)
            : { diaClave: obtenerFechaLocalISO(ahora), fechaISO: ahora.toISOString(), fechaNegocioISO: ahora.toISOString(), mesClave: obtenerFechaLocalISO(ahora).slice(0, 7), semanaClave: obtenerClaveSemana(ahora), zonaHoraria: 'America/Bogota' })
        : null;
      const fechaBase = ventaOriginalEnEdicion?.fechaISO ? new Date(ventaOriginalEnEdicion.fechaISO) : ahora;
      const diaClave = ventaOriginalEnEdicion?.diaClave || selloNegocio?.diaClave || obtenerFechaLocalISO(fechaBase);
      // C9.39: la apertura se valida ANTES de tocar el contador. Si la caja no
      // está abierta/sincronizada, no se crea operación pendiente ni se consume
      // trabajo de numeración.
      if (!(await saValidarCajaVenta(diaClave, esNueva))) return;
      if (esNueva && navigator.onLine && typeof window.asegurarIntegridadVentasDiaAntesDeGuardar === 'function') {
        const preparacion = await window.asegurarIntegridadVentasDiaAntesDeGuardar(diaClave);
        if (!preparacion?.ok) {
          if (preparacion?.requiereApertura) return alert('La apertura de caja todavía no está sincronizada. Espera unos segundos o vuelve a registrar la apertura antes de vender.');
          return alert('No fue posible verificar el consecutivo diario con Firestore. Revisa la conexión e intenta guardar nuevamente para evitar comandas duplicadas.');
        }
      }
      const motivoPeriodoCerrado = esNueva ? '' : await saValidarPeriodoCerrado(ventaOriginalEnEdicion, 'editar');
      if (motivoPeriodoCerrado === null) return;

      const consecutivos = comandaEnEdicion
        ? { comanda: comandaEnEdicion, recibo: reciboEnEdicion ?? comandaEnEdicion, domicilio: ventaOriginalEnEdicion?.numeroDomicilio || null, temporal: false }
        : await saReservarConsecutivos(diaClave, tipoPedido === 'Domicilio');

      const localId = ventaOriginalEnEdicion?._localId || ventaDocIdEnEdicion || generarIdVentaLocal();
      const venta = normalizarVenta({
        ...ventaOriginalEnEdicion,
        _localId: localId,
        _docId: ventaDocIdEnEdicion || ventaOriginalEnEdicion?._docId || null,
        _syncEstado: 'pendiente',
        cliente,
        formaPago,
        tipoPedido,
        numeroDomicilio: tipoPedido === 'Domicilio' ? (ventaOriginalEnEdicion?.numeroDomicilio || consecutivos.domicilio) : null,
        estadoDomicilio: tipoPedido === 'Domicilio' ? 'Entregado' : '',
        estadoDomicilioActualizadoEn: tipoPedido === 'Domicilio' ? ahora.toISOString() : null,
        estadoDomicilioActualizadoPor: tipoPedido === 'Domicilio' ? (usuarioActual || '') : '',
        costoDomicilio,
        subtotalProductos,
        observaciones: saTexto(document.getElementById('observaciones')?.value, 500),
        pedido: pedido.map(item => ({ nombre: saTexto(item.nombre, 150), precio: Number(item.precio || 0), productId: String(item.productId || item.id || ''), inventoryId: String(item.inventoryId || ''), categoria: String(item.categoria || '') })),
        detallePagos,
        totalCobrado,
        total: subtotalProductos,
        estado: ventaOriginalEnEdicion?.estado || ESTADO_VENTA_ACTIVA,
        fecha: ventaOriginalEnEdicion?.fecha || formatearFechaHoraColombia(selloNegocio?.fechaISO || ahora),
        fechaISO: ventaOriginalEnEdicion?.fechaISO || selloNegocio?.fechaISO || ahora.toISOString(),
        fechaNegocioISO: ventaOriginalEnEdicion?.fechaNegocioISO || selloNegocio?.fechaNegocioISO || ahora.toISOString(),
        fechaActualizacion: ahora.toISOString(),
        diaClave,
        mesClave: ventaOriginalEnEdicion?.mesClave || selloNegocio?.mesClave || diaClave.slice(0, 7),
        semanaClave: ventaOriginalEnEdicion?.semanaClave || selloNegocio?.semanaClave || obtenerClaveSemana(fechaBase),
        zonaHoraria: ventaOriginalEnEdicion?.zonaHoraria || selloNegocio?.zonaHoraria || 'America/Bogota',
        numeroVentaDia: ventaOriginalEnEdicion?.numeroVentaDia || null,
        ordenDia: ventaOriginalEnEdicion?.ordenDia || null,
        claveVentaDia: ventaOriginalEnEdicion?.claveVentaDia || '',
        comanda: consecutivos.comanda,
        recibo: consecutivos.recibo,
        consecutivoTemporal: Boolean(consecutivos.temporal),
        usuario: ventaOriginalEnEdicion?.usuario || usuarioActual || '',
        rolUsuario: ventaOriginalEnEdicion?.rolUsuario || rolActual || '',
        editadaPor: esNueva ? '' : usuarioActual || '',
        motivoEdicion: motivoPeriodoCerrado || '',
        version: Number(ventaOriginalEnEdicion?.version || 0) + 1
      });
      const ajustes = calcularAjustesInventarioBebidas(
        ventaOriginalEnEdicion && !esVentaCancelada(ventaOriginalEnEdicion) ? ventaOriginalEnEdicion.pedido || [] : [],
        !esVentaCancelada(venta) ? venta.pedido || [] : []
      );

      if (esNueva) {
        popupCocina = window.open('', '_blank', 'width=420,height=720');
        if (popupCocina) {
          popupCocina.document.write('<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Preparando comanda</title></head><body style="font-family:sans-serif;padding:16px">Preparando comanda para cocina...</body></html>');
          popupCocina.document.close();
        }
      }

      // C9.39: primero se persiste la operación crítica en la cola. Solo si la
      // cola quedó escrita correctamente se refleja la venta/inventario local.
      // Así un localStorage lleno no puede dejar una venta "visible" sin una
      // operación real capaz de llegar a Firestore.
      const operacion = guardarVentaPendienteSync(venta, ajustes, 'set');
      upsertVentaEnCacheLocal(venta);
      aplicarAjustesInventarioLocal(ajustes);
      guardarReferenciaUltimaVenta(venta);
      const resultado = await sincronizarVentasPendientesEnSegundoPlano();
      const ventaFinal = obtenerVentasStorage().find(v => v._localId === localId || v._docId === localId) || venta;
      const numeroOficial = Number(ventaFinal?.numeroVentaDia || ventaFinal?.ordenDia || 0);
      const sincronizadaOficial = ventaFinal?._syncEstado === 'sincronizado'
        && !ventaFinal?.consecutivoTemporal
        && Number.isFinite(numeroOficial)
        && numeroOficial > 0;

      if (esNueva && sincronizadaOficial) {
        if (popupCocina) imprimirComandaVenta(ventaFinal, popupCocina);
        else setTimeout(() => imprimirComandaVenta(ventaFinal), 80);
      } else if (esNueva && popupCocina) {
        try { if (!popupCocina.closed) popupCocina.close(); } catch (_) {}
      }
      await registrarAuditoria(esNueva ? 'crear_venta_local' : 'editar_venta_local', 'ventas', localId, {
        comanda: venta.comanda, totalCobrado, operacionId: operacion.operacionId, motivo: motivoPeriodoCerrado || ''
      });
      limpiarContextoEdicionVenta();
      limpiarPedido();
      mostrarVentas();
      refrescarVistasAnaliticasSiEstanAbiertas();
      document.getElementById('resumenProductos')?.classList.add('hidden');
      if (resultado?.fallidas || !sincronizadaOficial) {
        alert('La venta quedó pendiente de sincronización. No se asignará número de comanda hasta que Firestore confirme el guardado.');
      } else {
        alert(`Venta #${numeroOficial} guardada y sincronizada correctamente.`);
      }
    } catch (error) {
      console.error('Error al guardar la venta:', error);
      try { if (popupCocina && !popupCocina.closed) popupCocina.close(); } catch (_) {}
      alert(error?.message || 'No se pudo guardar la venta.');
    } finally {
      saGuardandoVenta = false;
      botonesGuardar.forEach(btn => { btn.disabled = false; btn.classList.remove('opacity-60'); });
      actualizarAlertasStockBebidas(inventarioBebidasEstado);
      saActualizarEstadoCola();
    }
  };

  marcarVentaComoCancelada = async function(index) {
    if (!verificarAcceso(['admin', 'administrador'])) return;
    const venta = obtenerVentasStorage()[index];
    if (!venta) return alert('Venta no encontrada.');
    if (esVentaCancelada(venta)) return alert('Esta venta ya está cancelada.');
    const motivoPeriodo = await saValidarPeriodoCerrado(venta, 'cancelar');
    if (motivoPeriodo === null) return;
    const motivo = saTexto(prompt('Escribe el motivo de la cancelación:') || '', 300);
    if (!motivo) return alert('Debes registrar un motivo de cancelación.');
    if (!confirm(`¿Cancelar la venta #${venta.comanda || venta.recibo || ''}?`)) return;
    const actualizada = normalizarVenta({
      ...venta,
      estado: ESTADO_VENTA_CANCELADA,
      fechaCancelacion: new Date().toISOString(),
      canceladaPor: usuarioActual || '',
      motivoCancelacion: motivo,
      motivoEdicion: motivoPeriodo || '',
      _syncEstado: 'pendiente',
      version: Number(venta.version || 0) + 1
    });
    const ajustes = calcularAjustesInventarioBebidas(venta.pedido || [], []);
    upsertVentaEnCacheLocal(actualizada);
    aplicarAjustesInventarioLocal(ajustes);
    guardarVentaPendienteSync(actualizada, ajustes, 'set');
    await sincronizarVentasPendientesEnSegundoPlano();
    await registrarAuditoria('cancelar_venta', 'ventas', saIdentidadVenta(venta), { motivo, comanda: venta.comanda || null });
    guardarReferenciaUltimaVenta(actualizada);
    mostrarVentas();
    renderControlCajaDiaActual();
    refrescarVistasAnaliticasSiEstanAbiertas();
    alert('Venta cancelada. Se conserva el registro y el motivo para auditoría.');
  };

  eliminarVentasPorClaves = async function(claves = []) {
    if (!verificarAcceso(['admin'])) return;
    const setClaves = new Set((Array.isArray(claves) ? claves : []).filter(Boolean));
    const registros = obtenerVentasStorage().map((venta, index) => ({ venta, index, clave: obtenerClaveSeleccionVenta(venta, index) })).filter(r => setClaves.has(r.clave));
    if (!registros.length) return alert('No se encontraron las ventas seleccionadas.');
    const motivo = saTexto(prompt(`Escribe el motivo para eliminar ${registros.length} venta(s):`) || '', 300);
    if (!motivo) return alert('Debes registrar un motivo de eliminación.');
    if (!confirm('La venta desaparecerá del listado operativo, pero la acción quedará en auditoría. ¿Continuar?')) return;
    for (const { venta, clave } of registros) {
      const motivoPeriodo = await saValidarPeriodoCerrado(venta, 'eliminar');
      if (motivoPeriodo === null) continue;
      const ajustes = calcularAjustesInventarioBebidas(venta.pedido || [], []);
      aplicarAjustesInventarioLocal(ajustes);
      eliminarVentaDeCacheLocal(venta);
      guardarVentaPendienteSync({ ...venta, motivoEliminacion: motivo, motivoEdicion: motivoPeriodo || '' }, ajustes, 'delete');
      ventasSeleccionadas.delete(clave);
      await registrarAuditoria('solicitar_eliminacion_venta', 'ventas', saIdentidadVenta(venta), { motivo, comanda: venta.comanda || null });
    }
    await sincronizarVentasPendientesEnSegundoPlano();
    actualizarReferenciaUltimaVentaTrasEliminar();
    limpiarSeleccionVentasInexistentes();
    mostrarVentas();
    renderControlCajaDiaActual();
    refrescarVistasAnaliticasSiEstanAbiertas();
    alert('Las ventas fueron retiradas y su eliminación quedó registrada.');
  };

  obtenerBadgeEstadoVenta = function(venta = {}) {
    const base = SA_BASE_BADGE_ESTADO(venta);
    const sync = venta?._syncEstado === 'pendiente'
      ? '<span class="ml-1 inline-flex rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-700">Pendiente sync</span>'
      : venta?._syncEstado === 'error'
        ? '<span class="ml-1 inline-flex rounded-full bg-red-100 px-2 py-1 text-xs font-bold text-red-700">Error sync</span>'
        : '';
    return `${base}${sync}`;
  };

  borrarVentas = function() {
    if (!verificarAcceso(['admin'])) return;
    alert('La eliminación masiva fue desactivada para proteger la contabilidad. Selecciona pedidos específicos y usa “Eliminar seleccionados”.');
  };

  guardarCatalogoDesdeEditor = async function() {
    const resultado = await SA_BASE_GUARDAR_CATALOGO();
    await registrarAuditoria('actualizar_catalogo', 'configuracion', 'catalogoProductos', { version: SA_CONFIG.version });
    return resultado;
  };

  restablecerCatalogoBase = async function() {
    const resultado = await SA_BASE_RESTAURAR_CATALOGO();
    await registrarAuditoria('restablecer_catalogo', 'configuracion', 'catalogoProductos', {});
    return resultado;
  };

  // ---------- Impresión segura y totales correctos ----------
  construirListaProductosImpresion = function(venta = {}, resumido = false) {
    const items = Array.isArray(venta?.pedido) ? venta.pedido : [];
    if (!items.length) return '<li>Sin productos</li>';
    if (resumido) {
      const resumen = {};
      items.forEach(item => {
        const nombre = saTexto(item?.nombre || 'Producto', 150);
        resumen[nombre] = (resumen[nombre] || 0) + 1;
      });
      return Object.entries(resumen).map(([nombre, cantidad]) => `<li>${saHTML(nombre)} x${cantidad}</li>`).join('');
    }
    return items.map(item => `<li>${saHTML(item?.nombre || 'Producto')} - ${formatearCOP(item?.precio || 0)}</li>`).join('');
  };

  function saBloqueDomicilioImpresion() {
    // El recibo muestra el tipo de pedido y el costo del domicilio en el resumen monetario.
    // No imprime teléfono, dirección, barrio, referencia ni datos de repartidor.
    return '';
  }

  function saNumeroVentaImpresion(venta = {}, referencia = 1) {
    if (typeof obtenerNumeroVentaDiaPresentacion === 'function') {
      return obtenerNumeroVentaDiaPresentacion(venta, referencia);
    }
    const persistido = Number(venta?.numeroVentaDia || 0);
    if (Number.isFinite(persistido) && persistido > 0) return Math.floor(persistido);
    return venta?.comanda ?? venta?.recibo ?? referencia;
  }

  generarPlantillaReciboCliente = function(venta = {}, referencia = 1) {
    const subtotal = Number(venta.subtotalProductos ?? venta.total ?? 0);
    const domicilio = Number(venta.costoDomicilio || 0);
    const totalCliente = redondearPago(subtotal + domicilio);
    const observaciones = saTexto(venta.observaciones, 500);
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Recibo Cliente</title><style>
      @page{margin:8mm 6mm}body{font-family:monospace;font-size:14px;width:58mm;margin:0 auto;line-height:1.45;color:#000}h2{text-align:center;font-size:19px;margin:0 0 6px}.sub{text-align:center;font-size:12px}.line{border-top:1px dashed #000;margin:8px 0}p{margin:4px 0}ul{list-style:none;padding:0;margin:0}li{margin-bottom:6px}.num{text-align:center;font-weight:700}.total{text-align:right;font-size:16px;font-weight:700}.thanks{text-align:center;font-weight:700;margin-top:14px}
      </style></head><body>
      <h2>SEÑOR AREPA</h2><div class="sub">Matrícula No 289546<br>CALLE 19#25-03 ESQUINA<br>BARRIO SAN JOSÉ, ARMENIA</div><div class="line"></div>
      <p class="num">RECIBO #${saHTML(saNumeroVentaImpresion(venta, referencia))}</p><p class="num">COMANDA #${saHTML(saNumeroVentaImpresion(venta, referencia))}</p>
      <p><strong>Cliente:</strong> ${saHTML(venta.cliente || 'N/A')}</p><p><strong>Fecha:</strong> ${saHTML(formatearFechaHoraColombia(venta.fechaISO || venta.fecha))}</p>
      <p><strong>Tipo:</strong> ${saHTML(obtenerTipoPedidoImpresion(venta))}</p><p><strong>Pago:</strong> ${saHTML(obtenerEtiquetaFormaPago(venta), 500)}</p>
      ${saBloqueDomicilioImpresion(venta)}${observaciones ? `<p><strong>Observaciones:</strong> ${saHTML(observaciones)}</p>` : ''}
      <div class="line"></div><ul>${construirListaProductosImpresion(venta, false)}</ul><div class="line"></div>
      <p><strong>Subtotal productos:</strong> ${formatearCOP(subtotal)}</p>${domicilio > 0 ? `<p><strong>Domicilio:</strong> ${formatearCOP(domicilio)}</p>` : ''}
      <p class="total">TOTAL PAGADO: ${formatearCOP(totalCliente)}</p><div class="line"></div><p class="thanks">¡Gracias por su compra!</p></body></html>`;
  };

  generarPlantillaComanda = function(venta = {}, referencia = 1) {
    const observaciones = saTexto(venta.observaciones, 500);
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Pedido Cocina</title><style>
      @page{margin:8mm 6mm}body{font-family:monospace;font-size:15px;width:72mm;margin:0 auto;line-height:1.4;color:#000}h2{text-align:center;font-size:19px}.line{border-top:1px dashed #000;margin:8px 0}p{margin:4px 0}ul{list-style:none;padding:0}li{padding:5px 0;border-bottom:1px dashed #000;font-size:18px}.num{text-align:center;font-weight:700}.foot{text-align:center;font-weight:700;margin-top:12px}
      </style></head><body><h2>🧾 PEDIDO A COCINA</h2><div class="line"></div>
      <p class="num">RECIBO #${saHTML(saNumeroVentaImpresion(venta, referencia))}</p><p class="num">COMANDA #${saHTML(saNumeroVentaImpresion(venta, referencia))}</p>
      <p><strong>Cliente:</strong> ${saHTML(venta.cliente || 'Sin nombre')}</p><p><strong>Fecha:</strong> ${saHTML(formatearFechaHoraColombia(venta.fechaISO || venta.fecha))}</p>
      <p><strong>Tipo:</strong> ${saHTML(obtenerTipoPedidoImpresion(venta))}</p>${saBloqueDomicilioImpresion(venta)}${observaciones ? `<p><strong>Observaciones:</strong> ${saHTML(observaciones)}</p>` : ''}
      <div class="line"></div><ul>${construirListaProductosImpresion(venta, true)}</ul><p class="foot">👨‍🍳 Preparar con cuidado</p></body></html>`;
  };

  // ---------- Gestión de domicilios ----------
  async function cambiarEstadoDomicilio(index, nuevoEstado) {
    if (!verificarAcceso(['admin', 'administrador'])) return;
    if (!SA_ESTADOS_DOMICILIO.includes(nuevoEstado)) return;
    const venta = obtenerVentasStorage()[index];
    if (!venta || !esPedidoDomicilio(venta)) return alert('Domicilio no encontrado.');
    const actualizada = normalizarVenta({ ...venta, estadoDomicilio: nuevoEstado, estadoDomicilioActualizadoEn: new Date().toISOString(), estadoDomicilioActualizadoPor: usuarioActual || '', _syncEstado: 'pendiente' });
    upsertVentaEnCacheLocal(actualizada);
    guardarVentaPendienteSync(actualizada, {}, 'set');
    await sincronizarVentasPendientesEnSegundoPlano();
    await registrarAuditoria('cambiar_estado_domicilio', 'ventas', saIdentidadVenta(venta), { anterior: venta.estadoDomicilio || 'Pendiente', nuevo: nuevoEstado });
    verDomiciliosDetalladosPorFecha();
  }
  window.cambiarEstadoDomicilio = cambiarEstadoDomicilio;

  async function asignarDomiciliario(index) {
    if (!verificarAcceso(['admin', 'administrador'])) return;
    const venta = obtenerVentasStorage()[index];
    if (!venta || !esPedidoDomicilio(venta)) return;
    const nombre = saTexto(prompt('Nombre del domiciliario:', venta.domiciliarioAsignado || '') || '', 100);
    if (!nombre) return;
    const actualizada = normalizarVenta({ ...venta, domiciliarioAsignado: nombre, _syncEstado: 'pendiente' });
    upsertVentaEnCacheLocal(actualizada);
    guardarVentaPendienteSync(actualizada, {}, 'set');
    await sincronizarVentasPendientesEnSegundoPlano();
    await registrarAuditoria('asignar_domiciliario', 'ventas', saIdentidadVenta(venta), { domiciliario: nombre });
    verDomiciliosDetalladosPorFecha();
  }
  window.asignarDomiciliario = asignarDomiciliario;

  function saActualizarFiltroDomiciliarios(domicilios = []) {
    const select = document.getElementById('filtroDomiciliosDomiciliario');
    if (!select) return;
    const actual = select.value;
    const nombres = [...new Set(domicilios.map(v => saTexto(v.domiciliarioAsignado || '', 100)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    select.innerHTML = `<option value="">Todos los domiciliarios</option><option value="__SIN_ASIGNAR__">Sin asignar</option>${nombres.map(nombre => `<option value="${saHTML(nombre)}">${saHTML(nombre)}</option>`).join('')}`;
    if (actual === '__SIN_ASIGNAR__' || nombres.includes(actual)) select.value = actual;
  }

  function saFiltrarDomiciliosOperativos(domicilios = []) {
    const estado = document.getElementById('filtroDomiciliosEstado')?.value || '';
    const pago = document.getElementById('filtroDomiciliosPago')?.value || '';
    const domiciliario = document.getElementById('filtroDomiciliosDomiciliario')?.value || '';
    return domicilios
      .filter(v => !estado || (v.estadoDomicilio || 'Pendiente') === estado)
      .filter(v => !pago || obtenerEtiquetaPagoDomicilio(v) === pago)
      .filter(v => !domiciliario || (domiciliario === '__SIN_ASIGNAR__' ? !saTexto(v.domiciliarioAsignado || '', 100) : saTexto(v.domiciliarioAsignado || '', 100) === domiciliario));
  }

  function saObtenerDomiciliosFechaFiltrados(fechaSeleccionada) {
    const todos = obtenerVentasNormalizadas().map((v, index) => ({ ...v, _index: index }))
      .filter(v => esPedidoDomicilio(v) && v.diaClave === fechaSeleccionada)
      .sort((a, b) => String(b.fechaISO || '').localeCompare(String(a.fechaISO || '')));
    saActualizarFiltroDomiciliarios(todos);
    return saFiltrarDomiciliosOperativos(todos);
  }

  async function exportarDomiciliosDelDia() {
    if (!verificarAcceso(['admin', 'administrador'])) return;
    const fecha = document.getElementById('filtroDomiciliosFecha')?.value || obtenerFechaLocalISO(new Date());
    const rango = saRangoDiaColombia(fecha);
    await saCargarVentasRango(rango.desdeISO, rango.hastaISO);
    const domicilios = saObtenerDomiciliosFechaFiltrados(fecha);
    if (!domicilios.length) return alert('No hay domicilios para la fecha y los filtros seleccionados.');
    const workbook = new ExcelJS.Workbook();
    const hoja = workbook.addWorksheet(`Domicilios ${fecha}`.slice(0, 31));
    hoja.columns = [
      { header: 'Recibo', key: 'recibo', width: 12 }, { header: 'Comanda', key: 'comanda', width: 12 },
      { header: 'Fecha y hora', key: 'fecha', width: 22 }, { header: 'Cliente', key: 'cliente', width: 25 },
      { header: 'Teléfono', key: 'telefono', width: 18 }, { header: 'Dirección', key: 'direccion', width: 38 },
      { header: 'Barrio', key: 'barrio', width: 20 }, { header: 'Referencia', key: 'referencia', width: 30 },
      { header: 'Estado domicilio', key: 'estadoDomicilio', width: 20 }, { header: 'Domiciliario', key: 'domiciliario', width: 22 },
      { header: 'Pago pedido', key: 'pago', width: 24 }, { header: 'Pago domicilio', key: 'pagoDomicilio', width: 18 },
      { header: 'Valor domicilio', key: 'valorDomicilio', width: 18 }, { header: 'Valor pedido', key: 'valorPedido', width: 18 },
      { header: 'Estado venta', key: 'estadoVenta', width: 16 }, { header: 'Productos', key: 'productos', width: 48 }
    ];
    domicilios.forEach(v => hoja.addRow({
      recibo: v.recibo ?? '', comanda: v.comanda ?? '', fecha: formatearFechaHoraColombia(v.fechaISO || v.fecha),
      cliente: v.cliente || '', telefono: v.telefonoCliente || '', direccion: v.direccionDomicilio || '', barrio: v.barrioDomicilio || '',
      referencia: v.referenciaDomicilio || '', estadoDomicilio: v.estadoDomicilio || 'Pendiente', domiciliario: v.domiciliarioAsignado || 'Sin asignar',
      pago: obtenerEtiquetaFormaPago(v), pagoDomicilio: obtenerEtiquetaPagoDomicilio(v), valorDomicilio: obtenerValorDomicilio(v),
      valorPedido: obtenerIngresoRealVenta(v), estadoVenta: obtenerEstadoVenta(v),
      productos: (Array.isArray(v.pedido) ? v.pedido : []).map(p => p?.nombre || 'Producto').join(' | ')
    }));
    hoja.getRow(1).font = { bold: true };
    hoja.autoFilter = { from: 'A1', to: 'P1' };
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
    ['M', 'N'].forEach(col => hoja.getColumn(col).numFmt = '$#,##0');
    const buffer = await workbook.xlsx.writeBuffer();
    saveAs(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Domicilios_${fecha}.xlsx`);
    await registrarAuditoria('exportar_domicilios', 'ventas', fecha, { cantidad: domicilios.length });
  }
  window.exportarDomiciliosDelDia = exportarDomiciliosDelDia;

  verDomiciliosDetalladosPorFecha = async function() {
    const input = document.getElementById('filtroDomiciliosFecha');
    const resumen = document.getElementById('resumenDomiciliosDiaSeleccionado');
    if (!input || !resumen) return;
    const fechaSeleccionada = input.value || obtenerFechaLocalISO(new Date());
    input.value = fechaSeleccionada;
    const rangoDia = saRangoDiaColombia(fechaSeleccionada);
    await saCargarVentasRango(rangoDia.desdeISO, rangoDia.hastaISO);
    const domicilios = saObtenerDomiciliosFechaFiltrados(fechaSeleccionada);
    const activos = filtrarVentasActivas(domicilios);
    const totalDom = activos.reduce((acc, v) => acc + obtenerValorDomicilio(v), 0);
    resumen.innerHTML = `<strong>Fecha:</strong> ${saHTML(fechaSeleccionada)} · <strong>Resultados filtrados:</strong> ${domicilios.length} · <strong>Activos:</strong> ${activos.length} · <strong>Cancelados:</strong> ${domicilios.length - activos.length} · <strong>Valor domicilios:</strong> ${formatearDinero(totalDom)}`;
    const filas = domicilios.map(v => {
      const cancelada = esVentaCancelada(v);
      const direccion = [v.direccionDomicilio, v.barrioDomicilio].filter(Boolean).join(' · ');
      const opciones = SA_ESTADOS_DOMICILIO.map(estado => `<option value="${saHTML(estado)}" ${estado === (v.estadoDomicilio || 'Pendiente') ? 'selected' : ''}>${saHTML(estado)}</option>`).join('');
      return `<tr class="${cancelada ? 'bg-red-50 text-gray-500' : ''}">
        <td class="p-2 border">${saHTML(v.recibo ?? '-')}</td><td class="p-2 border">${saHTML(v.comanda ?? '-')}</td><td class="p-2 border">${saHTML(formatearHoraColombia(v.fechaISO || v.fecha))}</td>
        <td class="p-2 border"><strong>${saHTML(v.cliente || 'N/A')}</strong><div class="text-xs">${saHTML(v.telefonoCliente || '-')}</div></td>
        <td class="p-2 border">${saHTML(obtenerEtiquetaFormaPago(v), 500)}</td><td class="p-2 border">${saHTML(obtenerEtiquetaPagoDomicilio(v))}</td>
        <td class="p-2 border font-semibold">${formatearDinero(obtenerValorDomicilio(v))}</td><td class="p-2 border">${formatearDinero(obtenerIngresoRealVenta(v))}</td>
        <td class="p-2 border">${obtenerBadgeEstadoVenta(v)}</td><td class="p-2 border">${saHTML(direccion || '-')}<div class="text-xs">${saHTML(v.referenciaDomicilio || '')}</div></td>
        <td class="p-2 border"><select onchange="cambiarEstadoDomicilio(${v._index}, this.value)" class="p-2 border rounded-lg text-xs" ${cancelada ? 'disabled' : ''}>${opciones}</select></td>
        <td class="p-2 border">${saHTML(v.domiciliarioAsignado || 'Sin asignar')}</td><td class="p-2 border">${resumirProductosPedido(v.pedido || [])}</td>
        <td class="p-2 border"><div class="flex flex-col gap-1">${cancelada ? '' : `<button onclick="imprimirVentaCliente(${v._index})" class="bg-purple-500 text-white px-2 py-1 rounded text-xs">Recibo</button><button onclick="asignarDomiciliario(${v._index})" class="bg-yellow-500 text-white px-2 py-1 rounded text-xs">Asignar</button>`}</div></td>
      </tr>`;
    });
    renderFilasPaginadas({ clave: 'domiciliosDetalle', bodyId: 'domiciliosDetalleBody', filas, colspan: 14, etiquetaVacia: 'No hay domicilios registrados para esta fecha.', infoId: 'infoPaginacionDomiciliosDetalle', pageId: 'paginaDomiciliosDetalleActual', prevId: 'btnPrevDomiciliosDetalle', nextId: 'btnNextDomiciliosDetalle' });
  };

  resumirProductosPedido = function(pedidoLista = []) {
    const resumen = {};
    (Array.isArray(pedidoLista) ? pedidoLista : []).forEach(item => {
      const nombre = saTexto(item?.nombre || 'Producto', 150);
      resumen[nombre] = (resumen[nombre] || 0) + 1;
    });
    return Object.entries(resumen).map(([nombre, cantidad]) => `${saHTML(nombre)} x${cantidad}`).join('<br>');
  };

  // ---------- Históricos y filtros ----------
  function saLlenarFiltrosHistoricos() {
    const ventas = obtenerVentasNormalizadas();
    const usuarios = [...new Set(ventas.map(v => v.usuario).filter(Boolean))].sort();
    const pagos = [...new Set(ventas.flatMap(v => obtenerDetallePagosVenta(v).map(p => p.medio)).filter(Boolean))].sort();
    const productos = [...new Set(ventas.flatMap(v => (Array.isArray(v.pedido) ? v.pedido : []).map(p => saTexto(p?.nombre || '', 150))).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const llenar = (id, valores, etiqueta) => {
      const select = document.getElementById(id);
      if (!select) return;
      const actual = select.value;
      select.innerHTML = `<option value="">${etiqueta}</option>${valores.map(v => `<option value="${saHTML(v)}">${saHTML(v)}</option>`).join('')}`;
      if (valores.includes(actual)) select.value = actual;
    };
    llenar('filtroHistoricoUsuario', usuarios, 'Todos los usuarios');
    llenar('filtroHistoricoPago', pagos, 'Todos los pagos');
    llenar('filtroHistoricoProducto', productos, 'Todos los productos');
  }

  actualizarHistoricos = function() {
    SA_BASE_ACTUALIZAR_HISTORICOS();
    saLlenarFiltrosHistoricos();
  };

  verVentasDetalladasPorFecha = async function() {
    const input = document.getElementById('filtroHistoricoFecha');
    const resumen = document.getElementById('resumenVentasDiaSeleccionado');
    if (!input || !resumen) return;
    const fecha = input.value || obtenerFechaLocalISO(new Date());
    input.value = fecha;
    const rangoDia = saRangoDiaColombia(fecha);
    await saCargarVentasRango(rangoDia.desdeISO, rangoDia.hastaISO);
    const usuario = document.getElementById('filtroHistoricoUsuario')?.value || '';
    const pago = document.getElementById('filtroHistoricoPago')?.value || '';
    const producto = document.getElementById('filtroHistoricoProducto')?.value || '';
    const tipo = document.getElementById('filtroHistoricoTipo')?.value || '';
    const estado = document.getElementById('filtroHistoricoEstado')?.value || '';
    const ventas = obtenerVentasNormalizadas().filter(v => v.diaClave === fecha)
      .filter(v => !usuario || v.usuario === usuario)
      .filter(v => !pago || obtenerDetallePagosVenta(v).some(p => p.medio === pago))
      .filter(v => !producto || (Array.isArray(v.pedido) ? v.pedido : []).some(p => saTexto(p?.nombre || '', 150) === producto))
      .filter(v => !tipo || v.tipoPedido === tipo)
      .filter(v => !estado || obtenerEstadoVenta(v) === estado)
      .sort((a, b) => String(b.fechaISO || '').localeCompare(String(a.fechaISO || '')));
    const activas = filtrarVentasActivas(ventas);
    const totalReal = activas.reduce((acc, v) => acc + obtenerIngresoRealVenta(v), 0);
    const totalCobrado = activas.reduce((acc, v) => acc + obtenerTotalCobradoVenta(v), 0);
    resumen.innerHTML = `<strong>Fecha:</strong> ${saHTML(fecha)} · <strong>Resultados:</strong> ${ventas.length} · <strong>Activas:</strong> ${activas.length} · <strong>Canceladas:</strong> ${ventas.length - activas.length} · <strong>Venta real:</strong> ${formatearDinero(totalReal)} · <strong>Total cobrado:</strong> ${formatearDinero(totalCobrado)}`;
    const filas = ventas.map(v => {
      const cancelada = esVentaCancelada(v);
      return `<tr class="${cancelada ? 'bg-red-50 text-gray-500' : ''}"><td class="p-2 border">${saHTML(v.recibo ?? '-')}</td><td class="p-2 border">${saHTML(v.comanda ?? '-')}</td><td class="p-2 border">${saHTML(formatearHoraColombia(v.fechaISO || v.fecha))}</td><td class="p-2 border">${saHTML(v.cliente || 'N/A')}</td><td class="p-2 border">${saHTML(obtenerEtiquetaFormaPago(v), 500)}</td><td class="p-2 border">${saHTML(formatearTipoPedidoVisual(v))}</td><td class="p-2 border">${obtenerBadgeEstadoVenta(v)}</td><td class="p-2 border">${saHTML(v.observaciones || '-')}</td><td class="p-2 border">${resumirProductosPedido(v.pedido || [])}</td><td class="p-2 border font-semibold">${formatearDinero(obtenerIngresoRealVenta(v))}</td></tr>`;
    });
    renderFilasPaginadas({ clave: 'historicoDetalle', bodyId: 'ventasDiaDetalleBody', filas, colspan: 10, etiquetaVacia: 'No hay ventas para los filtros seleccionados.', infoId: 'infoPaginacionHistoricoDetalle', pageId: 'paginaHistoricoDetalleActual', prevId: 'btnPrevHistoricoDetalle', nextId: 'btnNextHistoricoDetalle' });
    await renderResumenCajaFecha(fecha, true);
  };

  window.exportarVentasDelDiaHistorico = async function() {
    if (!verificarAcceso(['admin', 'administrador'])) return;
    const input = document.getElementById('filtroHistoricoFecha');
    const fecha = input?.value || obtenerFechaLocalISO(new Date());
    if (input && !input.value) input.value = fecha;
    const rango = saRangoDiaColombia(fecha);
    await saCargarVentasRango(rango.desdeISO, rango.hastaISO);
    const usuario = document.getElementById('filtroHistoricoUsuario')?.value || '';
    const pago = document.getElementById('filtroHistoricoPago')?.value || '';
    const producto = document.getElementById('filtroHistoricoProducto')?.value || '';
    const tipo = document.getElementById('filtroHistoricoTipo')?.value || '';
    const estado = document.getElementById('filtroHistoricoEstado')?.value || '';
    const ventas = obtenerVentasNormalizadas()
      .filter(v => v.diaClave === fecha)
      .filter(v => !usuario || v.usuario === usuario)
      .filter(v => !pago || obtenerDetallePagosVenta(v).some(p => p.medio === pago))
      .filter(v => !producto || (Array.isArray(v.pedido) ? v.pedido : []).some(p => saTexto(p?.nombre || '', 150) === producto))
      .filter(v => !tipo || v.tipoPedido === tipo)
      .filter(v => !estado || obtenerEstadoVenta(v) === estado);
    if (!ventas.length) return alert('No hay ventas para la fecha y los filtros seleccionados.');
    await exportarVentasAExcel(ventas, `Ventas_filtradas_${fecha}.xlsx`, `Ventas ${fecha}`);
    await registrarAuditoria('exportar_ventas_filtradas', 'ventas', fecha, { cantidad: ventas.length, usuario, pago, producto, tipo, estado });
  };

  abrirHistoricos = async function() {
    const hasta = new Date().toISOString();
    await saCargarVentasRango(saFechaHaceDias(SA_CONFIG.diasHistoricos), hasta);
    SA_BASE_ABRIR_HISTORICOS();
  };

  abrirDomiciliosVista = async function() {
    await saCargarVentasRango(saFechaHaceDias(SA_CONFIG.diasDomicilios), new Date().toISOString());
    SA_BASE_ABRIR_DOMICILIOS();
  };

  async function exportarRespaldoSistema() {
    if (!verificarAcceso(['admin'])) return;
    const respaldo = {
      tipo: 'senor_arepa_respaldo',
      version: SA_CONFIG.version,
      generadoEn: new Date().toISOString(),
      generadoPor: usuarioActual || '',
      proyectoFirebase: firebaseConfig.projectId,
      ventas: obtenerVentasStorage().map(normalizarVenta),
      controlCaja: saClonarLimpio(controlCajaCache || {}),
      catalogo: saLeerJSON(CATALOGO_PRODUCTOS_STORAGE_KEY, {}),
      inventario: saLeerJSON(INVENTARIO_STORAGE_KEY, []),
      operacionesPendientes: obtenerVentasPendientesSync()
    };
    const blob = new Blob([JSON.stringify(respaldo, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = `Respaldo_Señor_Arepa_${obtenerFechaLocalISO(new Date())}.json`;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(url);
    await registrarAuditoria('exportar_respaldo', 'sistema', 'respaldo', { ventas: respaldo.ventas.length });
  }
  window.exportarRespaldoSistema = exportarRespaldoSistema;

  function seleccionarRespaldoSistema() {
    if (!verificarAcceso(['admin'])) return;
    let input = document.getElementById('inputRestaurarRespaldoSistema');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.id = 'inputRestaurarRespaldoSistema';
      input.className = 'hidden';
      input.addEventListener('change', restaurarRespaldoSistema);
      document.body.appendChild(input);
    }
    input.click();
  }
  window.seleccionarRespaldoSistema = seleccionarRespaldoSistema;

  async function restaurarRespaldoSistema(event) {
    const archivo = event?.target?.files?.[0];
    if (!archivo || !verificarAcceso(['admin'])) return;
    try {
      const respaldo = JSON.parse(await archivo.text());
      if (respaldo?.tipo !== 'senor_arepa_respaldo' || !Array.isArray(respaldo.ventas)) {
        throw new Error('El archivo no corresponde a un respaldo válido de Señor Arepa.');
      }
      if (!confirm(`El respaldo contiene ${respaldo.ventas.length} ventas. Se combinará con la información actual sin borrar registros. ¿Continuar?`)) return;
      const existentes = new Map(obtenerVentasStorage().map(v => [saIdentidadVenta(v), v]));
      for (const ventaOriginal of respaldo.ventas) {
        const venta = normalizarVenta(ventaOriginal);
        venta._localId = venta._localId || generarIdVentaLocal();
        venta._syncEstado = 'pendiente';
        existentes.set(saIdentidadVenta(venta), venta);
        guardarVentaPendienteSync(venta, {}, 'set');
      }
      guardarVentasEnCache(ordenarVentasDesc(Array.from(existentes.values())));
      if (respaldo.controlCaja && typeof respaldo.controlCaja === 'object') {
        Object.entries(respaldo.controlCaja).forEach(([dia, control]) => {
          guardarControlCajaEnCache(normalizarControlCaja(control, dia));
          guardarControlCajaDia(dia, control).catch(error => console.error('No se pudo poner la caja restaurada en cola segura:', error));
        });
      }
      if (respaldo.catalogo && typeof respaldo.catalogo === 'object') {
        guardarLocalStorageSeguro(CATALOGO_PRODUCTOS_STORAGE_KEY, normalizarCatalogoProductos(respaldo.catalogo), { critico: false });
        cargarCatalogoProductos();
        await guardarCatalogoProductosRemoto(false).catch(() => {});
      }
      if (Array.isArray(respaldo.inventario) && saEsEnLinea()) {
        const batch = firestoreDb.batch();
        respaldo.inventario.slice(0, 450).forEach(item => {
          const clave = normalizarClaveInventario(item?.nombreNormalizado || item?.nombre || '');
          if (!clave) return;
          const ref = firestoreDb.collection(INVENTARIO_COLLECTION).doc(saId(clave));
          batch.set(ref, {
            nombre: saTexto(item?.nombre || clave, 150),
            nombreNormalizado: clave,
            cantidad: Math.max(0, Number(item?.cantidad || 0)),
            unidad: saTexto(item?.unidad || 'unidades', 40),
            fecha: new Date().toISOString()
          }, { merge: true });
        });
        await batch.commit();
      }
      await Promise.allSettled([sincronizarVentasPendientesEnSegundoPlano(), saSincronizarCajaPendiente()]);
      await registrarAuditoria('restaurar_respaldo', 'sistema', 'respaldo', { archivo: saTexto(archivo.name, 180), ventas: respaldo.ventas.length });
      mostrarVentas();
      refrescarVistasAnaliticasSiEstanAbiertas();
      alert('El respaldo fue procesado. Revisa el indicador de sincronización.');
    } catch (error) {
      console.error(error);
      alert(error?.message || 'No se pudo restaurar el respaldo.');
    } finally {
      if (event?.target) event.target.value = '';
    }
  }
  window.restaurarRespaldoSistema = restaurarRespaldoSistema;

  // ---------- Permisos e interfaz ----------
  aplicarPermisosPorRol = function() {
    SA_BASE_APLICAR_PERMISOS();
    actualizarAlertasStockBebidas(inventarioBebidasEstado);
    saActualizarEstadoCola();
    const barra = document.getElementById('mobileQuickBar');
    if (barra) barra.classList.toggle('hidden', !(sesionActiva && tieneRolValido()));
  };

  // Repara la función que muestra productos para que todos los nombres queden como texto seguro.
  const SA_BASE_ACTUALIZAR_VISTA_PEDIDO = actualizarVistaPedido;
  actualizarVistaPedido = function() {
    pedido = pedido.map(item => ({ nombre: saTexto(item.nombre, 150), precio: Math.max(0, Number(item.precio || 0)), productId: String(item.productId || item.id || ''), inventoryId: String(item.inventoryId || ''), categoria: String(item.categoria || '') }));
    SA_BASE_ACTUALIZAR_VISTA_PEDIDO();
  };

  window.addEventListener('online', async () => {
    actualizarIndicadorFirebase('verificando', 'Reconectando y validando sesión exclusiva...');
    const user = firebaseAuth?.currentUser;
    const email = String(user?.email || '').toLowerCase();
    const registro = usuariosPorEmail[email];
    if (user && registro) {
      try {
        const validacion = await saValidarSesionExclusivaActual({ permitirOffline: false });
        if (!validacion.ok) await saAdquirirSesionExclusiva(user, registro, { silencioso: true });
      } catch (error) {
        saBloquearInterfazPorSesionDuplicada('Al reconectar se detectó que esta cuenta ya está activa en otro lugar. Las ventas pendientes de esta instancia no se enviarán automáticamente.', { rotar: true });
        return;
      }
    }
    actualizarIndicadorFirebase('verificando', 'Reconectando y verificando apertura de caja...');
    const apertura = await saVerificarAperturaObligatoriaDia({ mostrarModal: true });
    if (!apertura.ok) {
      saActualizarEstadoCola();
      return;
    }
    actualizarIndicadorFirebase('verificando', 'Reconectando y enviando operaciones pendientes...');
    await Promise.allSettled([sincronizarVentasPendientesEnSegundoPlano(), saSincronizarCajaPendiente(), saSincronizarAuditoriaPendiente()]);
    saActualizarEstadoCola();
  });

  window.addEventListener('offline', () => saActualizarEstadoCola());

  window.addEventListener('beforeunload', event => {
    const ventasActivasPendientes = obtenerVentasPendientesSync().filter(item => !item?.bloqueoPermanente).length;
    const pendientes = ventasActivasPendientes + saLeerJSON(SA_KEYS.cajaPendiente, []).length;
    if (!pendientes) return;
    event.preventDefault();
    event.returnValue = '';
  });

  document.addEventListener('DOMContentLoaded', () => {
    saLimpiarContadoresLocalesLegacy();
    document.documentElement.dataset.senorArepaVersion = SA_CONFIG.version;
    const logoFuente = document.getElementById('logoDataSource');
    if (logoFuente?.src) {
      document.querySelectorAll('[data-logo-clone="principal"]').forEach(img => { img.src = logoFuente.src; });
    }
    const nav = document.getElementById('topNav');
    if (nav && !document.getElementById('versionPruebasBadge')) {
      const badge = document.createElement('span');
      badge.id = 'versionPruebasBadge';
      badge.className = 'hidden md:inline-flex rounded-full bg-white/25 border border-white/40 px-2 py-1 text-[11px] font-bold';
      badge.textContent = `PRUEBAS · v${SA_CONFIG.version}`;
      nav.querySelector('.flex.items-center.gap-3')?.appendChild(badge);
    }
    const menuMovil = document.querySelector('#mobileHeaderMenu .pt-4.space-y-1');
    if (menuMovil && !document.getElementById('btnRespaldoMovil')) {
      const exportar = document.createElement('button');
      exportar.id = 'btnRespaldoMovil';
      exportar.type = 'button';
      exportar.dataset.role = 'admin-only';
      exportar.className = 'menu-link-text admin';
      exportar.textContent = '💾 Exportar respaldo completo';
      exportar.onclick = exportarRespaldoSistema;
      const restaurar = document.createElement('button');
      restaurar.type = 'button';
      restaurar.dataset.role = 'admin-only';
      restaurar.className = 'menu-link-text admin';
      restaurar.textContent = '♻️ Restaurar respaldo';
      restaurar.onclick = seleccionarRespaldoSistema;
      menuMovil.append(exportar, restaurar);
    }
    saActualizarEstadoCola();
    actualizarCampoCostoDomicilio();
    aplicarPermisosPorRol();
  });

  setInterval(async () => {
    if (!sesionActiva || !tieneRolValido()) return;
    const diaActual = obtenerFechaLocalISO(new Date());
    if (saDiaAperturaValidado !== diaActual || saAperturaObligatoriaActiva) {
      const apertura = await saVerificarAperturaObligatoriaDia({ mostrarModal: true });
      if (!apertura.ok) return;
    }
    if (!saEsEnLinea()) return;
    Promise.allSettled([sincronizarVentasPendientesEnSegundoPlano(), saSincronizarCajaPendiente(), saSincronizarAuditoriaPendiente()]);
  }, 30000);

  window.SENOR_AREPA_CONFIG = SA_CONFIG;
})();
