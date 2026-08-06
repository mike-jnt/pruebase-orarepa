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
  const ADMIN_EMAILS = new Set(['admin@local.io']);
  const COLECCION_MOVIMIENTOS = 'finanzas_movimientos';
  const COLECCION_COMPROBANTES = 'finanzas_comprobantes';
  const COLECCION_EXCLUSIONES = 'finanzas_exclusiones';
  const COLECCION_CONTROL_CAJA = 'controlCaja';
  const COLECCION_RESUMEN_DIARIO = 'resumenVentasDiario';
  const COLECCION_NOMINA = 'nomina';
  const CACHE_KEY = 'movimientos_finanzas_cache_v4';
  const CACHE_PREVIA_KEY = 'movimientos_finanzas_cache_v3';
  const CACHE_ANTERIOR_KEY = 'movimientos_finanzas_cache_v2';
  const CACHE_LEGACY_KEY = 'movimientos';
  const PAGE_SIZE = 10;
  const NOMINA_PAGE_SIZE = 10;
  const SYNC_PAGE_SIZE = 100;
  const EXPORT_PAGE_SIZE = 200;
  const EXPORT_LIMIT = 50000;
  const ANALYTICS_PAGE_SIZE = 500;
  const ANALYTICS_LIMIT = 50000;
  const PREFIJO_MOVIMIENTO_CIERRE = 'cierre_caja_';
  const PREFIJO_MOVIMIENTO_NOMINA = 'nomina_pago_';

  let firebaseApp = null;
  let firestoreDb = null;
  let firebaseAuth = null;
  let usuarioAutenticado = null;
  let firebaseDisponible = false;
  let movimientos = [];
  let movimientosAnalitica = [];
  let analiticaCargando = false;
  let analiticaTruncada = false;
  let ultimaActualizacionFuentes = null;
  let indiceEdicion = null;
  let filtrosActivos = { desde: '', hasta: '', categoria: '', tipo: '' };
  let paginaActual = 0;
  let cursoresPagina = [null];
  let hayPaginaSiguiente = false;
  let cargandoMovimientos = false;
  let pagosNomina = [];
  let nominaPaginaActual = 0;
  let nominaCursores = [null];
  let nominaHaySiguiente = false;
  let empleadoNominaSeleccionado = '';
  let grafico = null;
  let graficoCategorias = null;

  const $ = (id) => document.getElementById(id);
  const formulario = $('formulario');
  const fotoInput = $('foto');
  const vistaFoto = $('vistaFoto');
  const botonGuardar = formulario?.querySelector('button[type="submit"]');
  const estadoFirebase = $('estadoFirebase');
  const btnMigrarLocalStorage = $('btnMigrarLocalStorage');
  const filtroEmpleadoNomina = $('filtroEmpleadoNomina');

  function escapeHtml(valor) {
    return String(valor ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
  }

  function limpiarTexto(valor, max = 300) {
    return String(valor ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function numero(valor) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : 0;
  }

  function dinero(valor) {
    return numero(valor).toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
  }

  function setEstadoFirebase(texto, online = false) {
    if (!estadoFirebase) return;
    estadoFirebase.textContent = texto;
    estadoFirebase.classList.remove('online', 'offline');
    estadoFirebase.classList.add(online ? 'online' : 'offline');
  }

  function esAdmin(user = usuarioAutenticado) {
    return Boolean(user?.email && ADMIN_EMAILS.has(String(user.email).toLowerCase()));
  }

  function bloquearPagina(mensaje) {
    setEstadoFirebase(mensaje, false);
    formulario?.querySelectorAll('input, select, textarea, button').forEach((el) => { el.disabled = true; });
    document.querySelectorAll('button').forEach((el) => {
      if (!el.classList.contains('dark-toggle')) el.disabled = true;
    });
  }

  function normalizarMovimiento(item = {}) {
    return {
      id: item.id || null,
      tipo: item.tipo === 'ingreso' ? 'ingreso' : 'gasto',
      monto: numero(item.monto),
      categoria: limpiarTexto(item.categoria, 80),
      fecha: limpiarTexto(item.fecha, 10),
      descripcion: limpiarTexto(item.descripcion, 500),
      imagen: item.imagen || null,
      tieneImagen: Boolean(item.tieneImagen || item.imagen),
      origen: limpiarTexto(item.origen || 'manual', 50),
      origenColeccion: limpiarTexto(item.origenColeccion, 80) || null,
      origenDiaClave: limpiarTexto(item.origenDiaClave, 20) || null,
      sourceKey: limpiarTexto(item.sourceKey, 180) || null,
      bloqueoEdicion: Boolean(item.bloqueoEdicion),
      detalleControlCaja: item.detalleControlCaja || null,
      detalleNomina: item.detalleNomina || null,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null
    };
  }

  function esMovimientoAutomaticoCierre(m) {
    return Boolean(m && (m.origen === 'cierre_caja' || String(m.sourceKey || '').startsWith(PREFIJO_MOVIMIENTO_CIERRE)));
  }

  function esMovimientoAutomaticoNomina(m) {
    return Boolean(m && (m.origen === 'nomina' || String(m.sourceKey || '').startsWith(PREFIJO_MOVIMIENTO_NOMINA)));
  }

  function esMovimientoAutomatico(m) {
    return Boolean(m && (m.bloqueoEdicion || esMovimientoAutomaticoCierre(m) || esMovimientoAutomaticoNomina(m)));
  }

  function movimientoParaCache(item = {}) {
    const m = normalizarMovimiento(item);
    return {
      id: m.id,
      tipo: m.tipo,
      monto: m.monto,
      categoria: m.categoria,
      fecha: m.fecha,
      descripcion: m.descripcion,
      // Los comprobantes nunca se guardan en localStorage.
      imagen: null,
      tieneImagen: Boolean(m.tieneImagen || m.imagen),
      origen: m.origen,
      origenColeccion: m.origenColeccion,
      origenDiaClave: m.origenDiaClave,
      sourceKey: m.sourceKey,
      bloqueoEdicion: m.bloqueoEdicion
    };
  }

  function guardarCache() {
    const cacheLiviana = movimientos.slice(0, PAGE_SIZE).map(movimientoParaCache);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cacheLiviana));
      return true;
    } catch (error) {
      // Una caché llena nunca debe impedir consultar Firestore ni renderizar la página.
      console.warn('La caché local de Finanzas está llena; se continúa sin guardar caché.', error);
      try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
      return false;
    }
  }

  function cargarCache() {
    for (const key of [CACHE_KEY, CACHE_PREVIA_KEY, CACHE_ANTERIOR_KEY, CACHE_LEGACY_KEY]) {
      try {
        const data = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(data) && data.length) {
          return data.slice(0, PAGE_SIZE).map((item) => movimientoParaCache(item));
        }
      } catch (_) {}
    }
    return [];
  }

  function formatearComoCOP(input) {
    const limpio = String(input?.value || '').replace(/\D/g, '');
    input.value = limpio ? Number(limpio).toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }) : '';
  }

  function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    try { localStorage.setItem('darkMode', document.body.classList.contains('dark-mode') ? 'true' : 'false'); } catch (_) {}
  }

  function resetFormulario() {
    formulario?.reset();
    if ($('monto')) $('monto').value = '';
    if (vistaFoto) vistaFoto.innerHTML = '';
    if (fotoInput) fotoInput.value = '';
    indiceEdicion = null;
    if (botonGuardar) botonGuardar.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i>Guardar Movimiento';
  }

  function mostrarVistaFoto(src) {
    if (!vistaFoto) return;
    vistaFoto.innerHTML = src
      ? `<img src="${escapeHtml(src)}" alt="Comprobante" style="max-width:100%;max-height:180px;border-radius:8px">`
      : '';
  }

  async function comprimirImagen(archivo) {
    if (!archivo) return null;
    if (!String(archivo.type || '').startsWith('image/')) throw new Error('El comprobante debe ser una imagen.');
    if (archivo.size > 12 * 1024 * 1024) throw new Error('La imagen supera 12 MB.');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      reader.readAsDataURL(archivo);
    });
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('La imagen no es válida.'));
      img.src = dataUrl;
    });
    const max = 1280;
    const scale = Math.min(1, max / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    let result = canvas.toDataURL('image/jpeg', 0.76);
    if (result.length > 900000) result = canvas.toDataURL('image/jpeg', 0.58);
    if (result.length > 950000) throw new Error('La imagen sigue siendo demasiado pesada. Usa una foto más pequeña.');
    return result;
  }

  async function iniciarFirebase() {
    try {
      const appsCorrectas = firebase.apps.filter((app) => app?.options?.projectId === PROJECT_ID);
      if (firebase.apps.some((app) => app?.options?.projectId && app.options.projectId !== PROJECT_ID)) {
        throw new Error('Se detectó una aplicación Firebase de otro proyecto.');
      }
      firebaseApp = firebase.apps.find((app) => app?.name === FIREBASE_APP_NAME) || firebase.initializeApp(FIREBASE_CONFIG, FIREBASE_APP_NAME);
      if (firebaseApp.options.projectId !== PROJECT_ID) throw new Error('Proyecto Firebase no autorizado.');
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
      firebaseAuth = firebase.auth(firebaseApp);
      firebaseDisponible = true;
      setEstadoFirebase('Esperando sesión de Firebase...', false);
    } catch (error) {
      console.error('Error iniciando Firebase:', error);
      firebaseDisponible = false;
      setEstadoFirebase('Base de datos desconectada', false);
    }
  }

  function crearControlesPaginacion() {
    const tabla = $('tablaMovimientos')?.closest('.tabla-container');
    if (tabla && !$('paginacionFinanzas')) {
      tabla.insertAdjacentHTML('afterend', `
        <div id="paginacionFinanzas" class="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-3">
          <span id="infoPaginacionFinanzas" class="small text-muted">Página 1 · máximo ${PAGE_SIZE} registros</span>
          <div class="d-flex gap-2">
            <button id="btnFinanzasAnterior" class="btn btn-outline-secondary btn-sm" type="button">← Anterior</button>
            <button id="btnFinanzasSiguiente" class="btn btn-outline-primary btn-sm" type="button">Siguiente →</button>
          </div>
        </div>`);
      $('btnFinanzasAnterior').addEventListener('click', () => cambiarPaginaMovimientos(-1));
      $('btnFinanzasSiguiente').addEventListener('click', () => cambiarPaginaMovimientos(1));
    }

    const detalleNomina = $('tablaDetalleNomina')?.closest('.tabla-container');
    if (detalleNomina && !$('paginacionNominaFinanzas')) {
      detalleNomina.insertAdjacentHTML('afterend', `
        <div id="paginacionNominaFinanzas" class="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-3">
          <span id="infoPaginacionNominaFinanzas" class="small text-muted">Página 1 · máximo ${NOMINA_PAGE_SIZE} pagos</span>
          <div class="d-flex gap-2">
            <button id="btnNominaFinAnterior" class="btn btn-outline-secondary btn-sm" type="button">← Anterior</button>
            <button id="btnNominaFinSiguiente" class="btn btn-outline-primary btn-sm" type="button">Siguiente →</button>
          </div>
        </div>`);
      $('btnNominaFinAnterior').addEventListener('click', () => cambiarPaginaNomina(-1));
      $('btnNominaFinSiguiente').addEventListener('click', () => cambiarPaginaNomina(1));
    }

    const resumenTitulo = document.querySelector('.resumen h5');
    if (resumenTitulo) resumenTitulo.innerHTML = '<i class="bi bi-graph-up-arrow"></i> Resumen completo';
    const mensualTitulo = Array.from(document.querySelectorAll('.titulo-seccion')).find((el) => el.textContent.includes('Resumen Mensual'));
    if (mensualTitulo) mensualTitulo.innerHTML = '<i class="bi bi-calendar3"></i> Resumen mensual completo';
  }

  function aplicarFiltrosAQueryMovimientos(query, filtros = filtrosActivos) {
    if (filtros.tipo) query = query.where('tipo', '==', filtros.tipo);
    if (filtros.categoria) query = query.where('categoria', '==', filtros.categoria);
    if (filtros.desde) query = query.where('fecha', '>=', filtros.desde);
    if (filtros.hasta) query = query.where('fecha', '<=', filtros.hasta);
    return query.orderBy('fecha', 'desc');
  }

  function construirQueryMovimientos() {
    let query = aplicarFiltrosAQueryMovimientos(firestoreDb.collection(COLECCION_MOVIMIENTOS));
    const cursor = cursoresPagina[paginaActual];
    if (cursor) query = query.startAfter(cursor);
    return query.limit(PAGE_SIZE + 1);
  }

  async function cargarPaginaMovimientos(reset = false) {
    if (cargandoMovimientos || !firebaseDisponible || !firestoreDb || !esAdmin()) return;
    cargandoMovimientos = true;
    actualizarControlesPaginacion();
    try {
      if (reset) {
        paginaActual = 0;
        cursoresPagina = [null];
      }
      setEstadoFirebase('Cargando movimientos financieros...', true);
      let snapshot = await construirQueryMovimientos().get();
      if (!snapshot.docs.length && paginaActual > 0) {
        paginaActual -= 1;
        snapshot = await construirQueryMovimientos().get();
      }
      hayPaginaSiguiente = snapshot.docs.length > PAGE_SIZE;
      const visibles = snapshot.docs.slice(0, PAGE_SIZE);
      movimientos = visibles
        .map((doc) => normalizarMovimiento({ id: doc.id, ...doc.data() }))
        .filter((item) => item.fecha && !String(item.id || '').startsWith('exclusion_finanzas_'));
      if (hayPaginaSiguiente && visibles.length) cursoresPagina[paginaActual + 1] = visibles[visibles.length - 1];
      guardarCache();
      actualizarTabla(movimientos);
      actualizarControlesPaginacion();
      setEstadoFirebase(`Conectado · página ${paginaActual + 1} · ${movimientos.length} de ${PAGE_SIZE} registros`, true);
    } catch (error) {
      console.error('[C9.25] Error cargando movimientos:', error);
      if (String(error?.code || '').includes('failed-precondition')) {
        setEstadoFirebase('Falta publicar un índice de Firestore para este filtro', false);
      } else {
        setEstadoFirebase('No se pudo consultar la página solicitada', false);
      }
    } finally {
      cargandoMovimientos = false;
      actualizarControlesPaginacion();
    }
  }

  function actualizarControlesPaginacion() {
    if ($('infoPaginacionFinanzas')) $('infoPaginacionFinanzas').textContent = `Página ${paginaActual + 1} · ${movimientos.length} movimiento${movimientos.length === 1 ? '' : 's'} · 10 por página`;
    if ($('btnFinanzasAnterior')) $('btnFinanzasAnterior').disabled = paginaActual === 0 || cargandoMovimientos;
    if ($('btnFinanzasSiguiente')) $('btnFinanzasSiguiente').disabled = !hayPaginaSiguiente || cargandoMovimientos;
  }

  async function cambiarPaginaMovimientos(delta) {
    const destino = paginaActual + delta;
    if (destino < 0 || (delta > 0 && !hayPaginaSiguiente) || cargandoMovimientos) return;
    paginaActual = destino;
    await cargarPaginaMovimientos(false);
  }

  function leerFiltros() {
    return {
      desde: $('desde')?.value || '',
      hasta: $('hasta')?.value || '',
      categoria: limpiarTexto($('filtroCategoria')?.value, 80),
      tipo: $('filtroTipo')?.value || ''
    };
  }

  async function filtrarMovimientos() {
    filtrosActivos = leerFiltros();
    if (filtrosActivos.desde && filtrosActivos.hasta && filtrosActivos.desde > filtrosActivos.hasta) {
      alert('La fecha inicial no puede ser posterior a la fecha final.');
      return;
    }
    await Promise.all([cargarPaginaMovimientos(true), cargarAnaliticaCompleta()]);
  }

  async function limpiarFiltros() {
    ['desde', 'hasta', 'filtroCategoria'].forEach((id) => { if ($(id)) $(id).value = ''; });
    if ($('filtroTipo')) $('filtroTipo').value = '';
    filtrosActivos = { desde: '', hasta: '', categoria: '', tipo: '' };
    await Promise.all([cargarPaginaMovimientos(true), cargarAnaliticaCompleta()]);
  }

  function actualizarTabla(data = movimientos) {
    const tabla = $('tablaMovimientos');
    if (!tabla) return;

    tabla.innerHTML = '';
    if (!Array.isArray(data) || !data.length) {
      tabla.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No hay movimientos en esta página.</td></tr>';
      return;
    }

    data.forEach((movimiento, index) => {
      const m = normalizarMovimiento(movimiento);
      const automatico = esMovimientoAutomatico(m);
      const fuente = esMovimientoAutomaticoNomina(m)
        ? 'Nómina'
        : (esMovimientoAutomaticoCierre(m) ? 'Cierre de caja' : 'Manual');
      const tipoIngreso = m.tipo === 'ingreso';
      const fila = document.createElement('tr');
      fila.className = tipoIngreso ? 'movimiento-ingreso' : 'movimiento-gasto';
      fila.innerHTML = `
        <td>
          <span class="badge ${tipoIngreso ? 'text-bg-success' : 'text-bg-danger'}">
            ${escapeHtml(tipoIngreso ? 'Ingreso' : 'Gasto')}
          </span>
        </td>
        <td class="fw-semibold ${tipoIngreso ? 'text-success' : 'text-danger'}">${escapeHtml(dinero(m.monto))}</td>
        <td>
          <span class="fw-medium">${escapeHtml(m.categoria || 'Sin categoría')}</span>
          ${automatico ? `<div><span class="badge text-bg-warning mt-1">${escapeHtml(fuente)}</span></div>` : ''}
        </td>
        <td class="text-nowrap">${escapeHtml(m.fecha || '-')}</td>
        <td><span title="${escapeHtml(m.descripcion || '')}">${escapeHtml(m.descripcion || '-')}</span></td>
        <td>
          ${m.tieneImagen
            ? `<button class="btn btn-sm btn-outline-primary" type="button" onclick="verComprobanteFinanzas('${escapeHtml(m.id)}')">Ver</button>`
            : '<span class="text-muted small">Sin imagen</span>'}
        </td>
        <td>
          ${automatico
            ? `<button class="btn btn-outline-danger btn-sm" type="button" onclick="eliminarMovimiento(${index})"><i class="bi bi-trash"></i> Eliminar</button>`
            : `<div class="d-flex flex-wrap gap-1">
                <button class="btn btn-warning btn-sm" type="button" onclick="editarMovimiento(${index})" aria-label="Editar movimiento"><i class="bi bi-pencil"></i></button>
                <button class="btn btn-danger btn-sm" type="button" onclick="eliminarMovimiento(${index})" aria-label="Eliminar movimiento"><i class="bi bi-trash"></i></button>
              </div>`}
        </td>`;
      tabla.appendChild(fila);
    });
  }

  function actualizarTodo() {
    actualizarTabla(movimientos);
    const base = movimientosAnalitica.length || analiticaCargando ? movimientosAnalitica : movimientos;
    actualizarResumen(base);
    actualizarGrafico(base);
    generarResumenMensual(base);
    actualizarEstimaciones(base);
  }

  function actualizarResumen(data = movimientosAnalitica) {
    const ingresos = data.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);
    const gastos = data.filter((m) => m.tipo === 'gasto').reduce((a, m) => a + m.monto, 0);
    if ($('totalIngresos')) $('totalIngresos').textContent = dinero(ingresos);
    if ($('totalGastos')) $('totalGastos').textContent = dinero(gastos);
    if ($('balance')) $('balance').textContent = dinero(ingresos - gastos);
    if ($('cantidadDatosAnalizados')) $('cantidadDatosAnalizados').textContent = `${data.length}${analiticaTruncada ? '+' : ''}`;
    if ($('cantidadCierresAnalizados')) $('cantidadCierresAnalizados').textContent = String(data.filter(esMovimientoAutomaticoCierre).length);
    if ($('cantidadGastosAnalizados')) $('cantidadGastosAnalizados').textContent = String(data.filter((m) => m.tipo === 'gasto').length);
  }

  function prepararCanvasFinanzas(id) {
    const canvas = $(id);
    if (!canvas) return null;
    // Chart.js calcula el tamaño usando el contenedor padre. Mantener el canvas
    // sin dimensiones intrínsecas evita ciclos de crecimiento vertical.
    canvas.removeAttribute('width');
    canvas.removeAttribute('height');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    return canvas;
  }

  function actualizarGrafico(data = movimientosAnalitica) {
    if (typeof Chart === 'undefined') return;
    const ingresos = data.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);
    const gastos = data.filter((m) => m.tipo === 'gasto').reduce((a, m) => a + m.monto, 0);
    const canvas = prepararCanvasFinanzas('grafico');
    if (canvas) {
      if (grafico) grafico.destroy();
      grafico = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: ['Ingresos', 'Gastos'],
          datasets: [{
            data: [ingresos, gastos],
            backgroundColor: ['#22c55e', '#ef4444'],
            borderWidth: 0,
            hoverOffset: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          resizeDelay: 120,
          animation: { duration: 250 },
          cutout: '62%',
          layout: { padding: 4 },
          plugins: {
            legend: {
              position: 'bottom',
              labels: { boxWidth: 12, boxHeight: 12, padding: 12, font: { size: 11 } }
            }
          }
        }
      });
    }
    const categorias = {};
    data.filter((m) => m.tipo === 'gasto').forEach((m) => {
      categorias[m.categoria || 'Sin categoría'] = numero(categorias[m.categoria || 'Sin categoría']) + m.monto;
    });
    // Se muestran las categorías principales para conservar una gráfica compacta.
    const ordenadas = Object.entries(categorias).sort((a, b) => b[1] - a[1]).slice(0, 7);
    const canvasCat = prepararCanvasFinanzas('graficoCategorias');
    if (canvasCat) {
      if (graficoCategorias) graficoCategorias.destroy();
      graficoCategorias = new Chart(canvasCat.getContext('2d'), {
        type: 'bar',
        data: {
          labels: ordenadas.map(([categoria]) => categoria),
          datasets: [{
            label: 'Gastos por categoría',
            data: ordenadas.map(([, total]) => total),
            backgroundColor: '#f59e0b',
            borderRadius: 6,
            borderSkipped: false,
            maxBarThickness: 22
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          resizeDelay: 120,
          animation: { duration: 250 },
          layout: { padding: { left: 2, right: 8, top: 2, bottom: 2 } },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (context) => dinero(context.raw || 0) } }
          },
          scales: {
            x: {
              beginAtZero: true,
              ticks: {
                maxTicksLimit: 5,
                font: { size: 10 },
                callback: (value) => Number(value).toLocaleString('es-CO', { notation: 'compact', maximumFractionDigits: 1 })
              },
              grid: { color: 'rgba(120,113,108,0.12)' }
            },
            y: {
              ticks: { autoSkip: false, font: { size: 10 } },
              grid: { display: false }
            }
          }
        }
      });
    }
  }

  function generarResumenMensual(data = movimientosAnalitica) {
    const cuerpo = $('tablaResumenMensual');
    if (!cuerpo) return;
    const resumen = {};
    data.forEach((m) => {
      if (!m.fecha) return;
      const mes = m.fecha.slice(0, 7);
      resumen[mes] ||= { ingresos: 0, gastos: 0, cierres: 0, movimientos: 0 };
      resumen[mes][m.tipo === 'ingreso' ? 'ingresos' : 'gastos'] += m.monto;
      resumen[mes].movimientos += 1;
      if (esMovimientoAutomaticoCierre(m)) resumen[mes].cierres += 1;
    });
    cuerpo.innerHTML = Object.entries(resumen)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([mes, r]) => `<tr><td>${escapeHtml(mes)}</td><td>${escapeHtml(dinero(r.ingresos))}</td><td>${escapeHtml(dinero(r.gastos))}</td><td class="${r.ingresos - r.gastos < 0 ? 'text-danger' : 'text-success'} fw-bold">${escapeHtml(dinero(r.ingresos - r.gastos))}</td><td class="text-center">${r.cierres}</td><td class="text-center">${r.movimientos}</td></tr>`)
      .join('') || '<tr><td colspan="6" class="text-center text-muted py-4">Sin información para el periodo seleccionado.</td></tr>';
  }

  function obtenerRangoAnalizado(data = []) {
    const fechas = data.map((m) => m.fecha).filter(Boolean).sort();
    if (!fechas.length) return { desde: '', hasta: '', dias: 0 };
    const inicio = new Date(`${fechas[0]}T00:00:00`);
    const fin = new Date(`${fechas[fechas.length - 1]}T00:00:00`);
    const dias = Math.max(1, Math.floor((fin - inicio) / 86400000) + 1);
    return { desde: fechas[0], hasta: fechas[fechas.length - 1], dias };
  }

  function actualizarEstimaciones(data = movimientosAnalitica) {
    const hoy = new Date();
    const mesActual = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
    const datosMes = data.filter((m) => String(m.fecha || '').startsWith(mesActual));
    const ingresosMes = datosMes.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);
    const gastosMes = datosMes.filter((m) => m.tipo === 'gasto').reduce((a, m) => a + m.monto, 0);
    const diasTranscurridos = Math.max(1, hoy.getDate());
    const diasMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
    const factor = diasMes / diasTranscurridos;
    const ingresosProyectados = ingresosMes * factor;
    const gastosProyectados = gastosMes * factor;
    const rango = obtenerRangoAnalizado(data);
    const diasRegistrados = Math.max(1, new Set(data.map((m) => m.fecha).filter(Boolean)).size);
    const ingresosTotales = data.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);
    const gastosTotales = data.filter((m) => m.tipo === 'gasto').reduce((a, m) => a + m.monto, 0);

    if ($('promedioIngresoDiario')) $('promedioIngresoDiario').textContent = dinero(data.length ? ingresosTotales / diasRegistrados : 0);
    if ($('promedioGastoDiario')) $('promedioGastoDiario').textContent = dinero(data.length ? gastosTotales / diasRegistrados : 0);
    if ($('proyeccionIngresosMes')) $('proyeccionIngresosMes').textContent = dinero(ingresosProyectados);
    if ($('proyeccionGastosMes')) $('proyeccionGastosMes').textContent = dinero(gastosProyectados);
    if ($('proyeccionBalanceMes')) $('proyeccionBalanceMes').textContent = dinero(ingresosProyectados - gastosProyectados);
    if ($('periodoAnalizado')) $('periodoAnalizado').textContent = rango.desde ? `${rango.desde} → ${rango.hasta}` : 'Sin datos';
    if ($('diasConDatosMes')) $('diasConDatosMes').textContent = `${new Set(datosMes.map((m) => m.fecha)).size} día(s) con registros · día ${diasTranscurridos} de ${diasMes}`;
    if ($('notaEstimacionFinanzas')) $('notaEstimacionFinanzas').textContent = datosMes.length
      ? 'Proyección lineal del mes actual basada en los ingresos y gastos registrados hasta hoy.'
      : 'No hay movimientos del mes actual; la proyección permanece en cero.';
  }

  async function cargarAnaliticaCompleta() {
    if (analiticaCargando || !firebaseDisponible || !firestoreDb || !esAdmin()) return;
    analiticaCargando = true;
    analiticaTruncada = false;
    if ($('estadoAnaliticaFinanzas')) $('estadoAnaliticaFinanzas').textContent = 'Calculando con todos los registros de Firestore...';
    try {
      const acumulados = [];
      let cursor = null;
      while (acumulados.length < ANALYTICS_LIMIT) {
        let query = aplicarFiltrosAQueryMovimientos(firestoreDb.collection(COLECCION_MOVIMIENTOS)).limit(ANALYTICS_PAGE_SIZE);
        if (cursor) query = query.startAfter(cursor);
        const snapshot = await query.get();
        if (snapshot.empty) break;
        acumulados.push(...snapshot.docs.map((doc) => normalizarMovimiento({ id: doc.id, ...doc.data() })).filter((m) => m.fecha));
        cursor = snapshot.docs[snapshot.docs.length - 1];
        if (snapshot.size < ANALYTICS_PAGE_SIZE) break;
      }
      analiticaTruncada = acumulados.length >= ANALYTICS_LIMIT;
      movimientosAnalitica = acumulados.slice(0, ANALYTICS_LIMIT);
      actualizarTodo();
      if ($('estadoAnaliticaFinanzas')) $('estadoAnaliticaFinanzas').textContent = `${movimientosAnalitica.length}${analiticaTruncada ? '+' : ''} registros analizados desde Firestore`;
    } catch (error) {
      console.error('[C9.25] No se pudo cargar la analítica completa:', error);
      if ($('estadoAnaliticaFinanzas')) $('estadoAnaliticaFinanzas').textContent = 'No se pudo calcular la analítica completa. Revisa los índices de Firestore.';
    } finally {
      analiticaCargando = false;
    }
  }

  async function guardarMovimientoEnFirebase({ tipo, monto, categoria, fecha, descripcion, archivo }) {
    if (!esAdmin()) throw new Error('Sin permisos de administrador.');
    const anterior = indiceEdicion !== null ? movimientos[indiceEdicion] : null;
    if (anterior && esMovimientoAutomatico(anterior)) throw new Error('Los movimientos automáticos no se editan.');
    const ref = anterior?.id ? firestoreDb.collection(COLECCION_MOVIMIENTOS).doc(anterior.id) : firestoreDb.collection(COLECCION_MOVIMIENTOS).doc();
    const imagen = archivo ? await comprimirImagen(archivo) : null;
    const payload = {
      tipo,
      monto: numero(monto),
      categoria: limpiarTexto(categoria, 80),
      fecha,
      descripcion: limpiarTexto(descripcion, 500),
      origen: anterior?.origen || 'manual',
      origenColeccion: anterior?.origenColeccion || null,
      origenDiaClave: anterior?.origenDiaClave || null,
      sourceKey: anterior?.sourceKey || null,
      bloqueoEdicion: Boolean(anterior?.bloqueoEdicion),
      detalleControlCaja: anterior?.detalleControlCaja || null,
      detalleNomina: anterior?.detalleNomina || null,
      tieneImagen: Boolean(imagen || anterior?.tieneImagen),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: usuarioAutenticado.email
    };
    if (!anterior) {
      payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      payload.createdBy = usuarioAutenticado.email;
    }
    const batch = firestoreDb.batch();
    batch.set(ref, payload, { merge: true });
    if (imagen) {
      batch.set(firestoreDb.collection(COLECCION_COMPROBANTES).doc(ref.id), { imagen, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: usuarioAutenticado.email }, { merge: true });
    }
    await batch.commit();
    return ref.id;
  }

  async function guardarFormulario(event) {
    event.preventDefault();
    const tipo = $('tipo')?.value || 'gasto';
    const monto = Number(String($('monto')?.value || '').replace(/\D/g, '')) || 0;
    const categoria = $('categoria')?.value || '';
    const fecha = $('fecha')?.value || '';
    const descripcion = $('descripcion')?.value || '';
    const archivo = fotoInput?.files?.[0] || null;
    if (!fecha || monto <= 0) {
      alert('Ingresa una fecha y un monto mayor que cero.');
      return;
    }
    botonGuardar.disabled = true;
    botonGuardar.innerHTML = '<i class="bi bi-hourglass-split me-1"></i>Guardando...';
    try {
      await guardarMovimientoEnFirebase({ tipo, monto, categoria, fecha, descripcion, archivo });
      resetFormulario();
      await Promise.all([cargarPaginaMovimientos(true), cargarAnaliticaCompleta()]);
    } catch (error) {
      console.error(error);
      alert(error.message || 'No se pudo guardar el movimiento.');
    } finally {
      botonGuardar.disabled = false;
      if (indiceEdicion === null) botonGuardar.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i>Guardar Movimiento';
    }
  }

  async function verComprobanteFinanzas(id) {
    const movimiento = movimientos.find((m) => m.id === id);
    if (movimiento?.imagen) {
      window.open(movimiento.imagen, '_blank', 'noopener');
      return;
    }
    try {
      const snap = await firestoreDb.collection(COLECCION_COMPROBANTES).doc(id).get();
      const imagen = snap.data()?.imagen;
      if (!imagen) throw new Error('Este movimiento no tiene comprobante disponible.');
      const ventana = window.open('', '_blank', 'noopener');
      if (ventana) ventana.document.write(`<img src="${escapeHtml(imagen)}" alt="Comprobante" style="max-width:100%;height:auto">`);
    } catch (error) {
      alert(error.message || 'No se pudo cargar el comprobante.');
    }
  }

  function editarMovimiento(index) {
    const m = movimientos[index];
    if (!m || esMovimientoAutomatico(m)) {
      alert('Este movimiento automático no puede editarse desde Finanzas.');
      return;
    }
    indiceEdicion = index;
    $('tipo').value = m.tipo;
    $('monto').value = dinero(m.monto);
    $('categoria').value = m.categoria;
    $('fecha').value = m.fecha;
    $('descripcion').value = m.descripcion;
    mostrarVistaFoto(m.tieneImagen ? 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="320" height="90"%3E%3Ctext x="10" y="50" font-size="18"%3EComprobante guardado en Firebase%3C/text%3E%3C/svg%3E' : null);
    botonGuardar.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i>Actualizar Movimiento';
    formulario.scrollIntoView({ behavior: 'smooth' });
  }

  async function eliminarMovimiento(index) {
    const m = movimientos[index];
    if (!m || !confirm(`¿Eliminar ${m.categoria} por ${dinero(m.monto)}?`)) return;
    try {
      const batch = firestoreDb.batch();
      if (esMovimientoAutomatico(m)) {
        const sourceKey = limpiarTexto(m.sourceKey || m.id, 180);
        batch.set(firestoreDb.collection(COLECCION_EXCLUSIONES).doc(sourceKey), { sourceKey, origen: m.origen, createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: usuarioAutenticado.email }, { merge: true });
      }
      batch.delete(firestoreDb.collection(COLECCION_MOVIMIENTOS).doc(m.id));
      batch.delete(firestoreDb.collection(COLECCION_COMPROBANTES).doc(m.id));
      await batch.commit();
      await Promise.all([cargarPaginaMovimientos(paginaActual === 0), cargarAnaliticaCompleta()]);
    } catch (error) {
      console.error(error);
      alert('No se pudo eliminar el movimiento.');
    }
  }

  async function estaExcluido(sourceKey) {
    const snap = await firestoreDb.collection(COLECCION_EXCLUSIONES).doc(sourceKey).get();
    return snap.exists;
  }

  function primerNumeroValido(...valores) {
    for (const valor of valores) {
      if (valor === undefined || valor === null || valor === '') continue;
      const n = Number(valor);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  function extraerResumenGuardadoCierre(control = {}) {
    return [control.resumenCierre, control.resumenCaja, control.cierreResumen, control.resumen]
      .find((valor) => valor && typeof valor === 'object' && !Array.isArray(valor)) || {};
  }

  function resolverValoresCierreFinanzas(control = {}, resumenDiario = null) {
    const resumen = extraerResumenGuardadoCierre(control);
    const diario = resumenDiario && typeof resumenDiario === 'object' ? resumenDiario : {};
    const apertura = primerNumeroValido(control.aperturaMonto, resumen.aperturaMonto);
    const cierreContado = primerNumeroValido(control.cierreMonto, resumen.montoContado, resumen.cierreMonto);
    const efectivo = primerNumeroValido(
      resumen.totalEfectivo, resumen.efectivoBrutoSistema, resumen.efectivoSistema,
      control.totalEfectivo, control.efectivoBrutoSistema, control.efectivoSistema,
      diario.efectivo, diario.totalEfectivo, diario.efectivoBrutoSistema
    );
    const transferencias = primerNumeroValido(
      resumen.totalTransferencias, resumen.totalOtrosMedios, resumen.transferencias,
      control.totalTransferencias, control.totalOtrosMedios, control.transferencias,
      diario.transferencias, diario.totalTransferencias, diario.totalOtrosMedios
    );
    const domicilios = primerNumeroValido(
      resumen.totalDomicilios, resumen.domiciliosTotales, resumen.domiciliosDescontados,
      control.totalDomicilios, control.domiciliosTotales, control.domiciliosDescontados,
      diario.totalDomicilios, diario.domiciliosTotales, diario.domiciliosDescontados,
      Number(diario.domiciliosTransferenciaValor || 0) + Number(diario.domiciliosEfectivoValor || 0),
      Number(resumen.ajusteDomiciliosTransferencia || 0) + Number(resumen.ajusteDomiciliosEfectivo || 0),
      resumen.ajusteDomiciliosTransferencia, control.ajusteDomiciliosTransferencia
    );
    const efectivoNeto = primerNumeroValido(
      resumen.efectivoNetoSistema, resumen.efectivoNeto,
      control.efectivoNetoSistema, control.efectivoNeto,
      efectivo - domicilios
    );
    const cierreOperativo = primerNumeroValido(
      resumen.totalSistemaReal, resumen.cierreRealDia,
      control.totalSistemaReal, control.cierreRealDia,
      diario.totalSistemaReal, diario.cierreRealDia, diario.totalCobrado,
      efectivoNeto + transferencias,
      Math.max(0, cierreContado - apertura)
    );
    const cajaEsperada = primerNumeroValido(
      resumen.montoEsperadoCaja, resumen.dineroEsperado, resumen.cajaEsperada,
      control.montoEsperadoCaja, control.dineroEsperado, control.cajaEsperada,
      apertura + efectivoNeto
    );
    return {
      apertura,
      cierreContado,
      efectivo,
      transferencias,
      domicilios,
      efectivoNeto,
      cierreOperativo,
      cajaEsperada,
      diferencia: primerNumeroValido(resumen.diferencia, control.diferencia, cierreContado - cajaEsperada)
    };
  }

  async function obtenerResumenDiarioFinanzas(diaClave) {
    try {
      const snap = await firestoreDb.collection(COLECCION_RESUMEN_DIARIO).doc(String(diaClave)).get();
      return snap.exists ? (snap.data() || {}) : null;
    } catch (error) {
      console.warn(`[C9.25] No se pudo consultar resumenVentasDiario/${diaClave}:`, error);
      return null;
    }
  }

  async function movimientoDesdeCierre(doc) {
    const c = { diaClave: doc.id, ...doc.data() };
    if (!c.cierreHora && numero(c.cierreMonto) <= 0) return null;
    const resumenGuardado = extraerResumenGuardadoCierre(c);
    const tieneResumen = Object.keys(resumenGuardado).length > 0
      || ['totalSistemaReal', 'cierreRealDia', 'totalEfectivo', 'totalTransferencias'].some((campo) => c[campo] !== undefined);
    const resumenDiario = tieneResumen ? null : await obtenerResumenDiarioFinanzas(c.diaClave || doc.id);
    const valores = resolverValoresCierreFinanzas(c, resumenDiario);
    const sourceKey = `${PREFIJO_MOVIMIENTO_CIERRE}${doc.id}`;
    return {
      id: sourceKey,
      sourceKey,
      tipo: 'ingreso',
      monto: Math.max(0, valores.cierreOperativo),
      categoria: 'Ventas',
      fecha: c.diaClave || doc.id,
      descripcion: `Ventas operativas del día · cierre de caja ${c.diaClave || doc.id}`,
      origen: 'cierre_caja',
      origenColeccion: COLECCION_CONTROL_CAJA,
      origenDiaClave: c.diaClave || doc.id,
      bloqueoEdicion: true,
      detalleControlCaja: {
        aperturaMonto: valores.apertura,
        cierreMonto: valores.cierreContado,
        efectivoSistema: valores.efectivo,
        transferenciasSistema: valores.transferencias,
        domiciliosDescontados: valores.domicilios,
        cierreOperativo: valores.cierreOperativo,
        cajaEsperada: valores.cajaEsperada,
        diferencia: valores.diferencia,
        cierreHora: c.cierreHora || null,
        cierreUsuario: c.cierreUsuario || '',
        cierreObservaciones: c.cierreObservaciones || '',
        fuenteResumen: tieneResumen ? 'controlCaja' : (resumenDiario ? 'resumenVentasDiario' : 'cierreFisico')
      }
    };
  }

  function movimientoDesdePago(doc) {
    const p = doc.data() || {};
    if (p.recordType !== 'pago' || numero(p.totalPagado) <= 0) return null;
    const sourceKey = `${PREFIJO_MOVIMIENTO_NOMINA}${doc.id}`;
    const fecha = p.fechaClave || (typeof p.fechaPago === 'string' ? p.fechaPago.slice(0, 10) : '') || new Date().toISOString().slice(0, 10);
    return {
      id: sourceKey,
      sourceKey,
      tipo: 'gasto',
      monto: numero(p.totalPagado),
      categoria: 'Empleados',
      fecha,
      descripcion: `Pago de nómina · ${limpiarTexto(p.nombre || 'Empleado', 120)}${p.quincena ? ` · ${limpiarTexto(p.quincena, 100)}` : ''}`,
      origen: 'nomina',
      origenColeccion: COLECCION_NOMINA,
      origenDiaClave: fecha,
      bloqueoEdicion: true,
      detalleNomina: { pagoId: doc.id, employeeId: p.employeeId || '', nombre: p.nombre || '', cargo: p.cargo || '', quincena: p.quincena || '', fechaPago: p.fechaPago || null, totalPagado: numero(p.totalPagado) }
    };
  }

  async function obtenerExclusionesPorLote(items) {
    const claves = [...new Set(items.map((item) => limpiarTexto(item?.sourceKey, 180)).filter(Boolean))];
    const excluidas = new Set();
    for (let i = 0; i < claves.length; i += 30) {
      const lote = claves.slice(i, i + 30);
      const [nuevas, antiguas] = await Promise.all([
        firestoreDb.collection(COLECCION_EXCLUSIONES)
          .where(firebase.firestore.FieldPath.documentId(), 'in', lote)
          .get(),
        firestoreDb.collection(COLECCION_MOVIMIENTOS)
          .where(firebase.firestore.FieldPath.documentId(), 'in', lote.map((key) => `exclusion_finanzas_${key}`))
          .get()
      ]);
      nuevas.docs.forEach((doc) => excluidas.add(doc.id));
      antiguas.docs.forEach((doc) => {
        const sourceKey = limpiarTexto(doc.data()?.sourceKey || doc.data()?.exclusionSourceKey, 180);
        if (sourceKey) excluidas.add(sourceKey);
      });
    }
    return excluidas;
  }

  async function guardarAutomaticos(items) {
    const validos = items.filter(Boolean);
    const excluidas = await obtenerExclusionesPorLote(validos);
    let batch = firestoreDb.batch();
    let count = 0;
    let guardados = 0;
    for (const item of validos) {
      if (excluidas.has(item.sourceKey)) continue;
      batch.set(firestoreDb.collection(COLECCION_MOVIMIENTOS).doc(item.id), {
        ...item,
        tieneImagen: false,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: usuarioAutenticado.email
      }, { merge: true });
      count += 1;
      guardados += 1;
      if (count >= 350) {
        await batch.commit();
        batch = firestoreDb.batch();
        count = 0;
      }
    }
    if (count) await batch.commit();
    return guardados;
  }

  async function recorrerConsultaPaginada(baseQuery, mapFn, etiqueta) {
    let cursor = null;
    let total = 0;
    while (true) {
      let q = baseQuery.limit(SYNC_PAGE_SIZE);
      if (cursor) q = q.startAfter(cursor);
      const snapshot = await q.get();
      if (snapshot.empty) break;
      setEstadoFirebase(`${etiqueta}: procesando ${total + snapshot.size} registros...`, true);
      const convertidos = await Promise.all(snapshot.docs.map((doc) => mapFn(doc)));
      total += await guardarAutomaticos(convertidos.filter(Boolean));
      cursor = snapshot.docs[snapshot.docs.length - 1];
      if (snapshot.size < SYNC_PAGE_SIZE) break;
    }
    return total;
  }

  async function sincronizarCierresCajaEnFinanzas(forzarRecarga = true, silencioso = false) {
    if (!esAdmin()) return 0;
    try {
      const total = await recorrerConsultaPaginada(
        firestoreDb.collection(COLECCION_CONTROL_CAJA).orderBy('diaClave', 'asc'),
        movimientoDesdeCierre,
        'Sincronizando cierres de caja'
      );
      if (forzarRecarga) await Promise.all([cargarPaginaMovimientos(true), cargarAnaliticaCompleta()]);
      if (!silencioso) alert(`Cierres sincronizados: ${total}`);
      return total;
    } catch (error) {
      console.error('[C9.25] No se pudieron sincronizar los cierres:', error);
      if (!silencioso) alert('No se pudieron sincronizar los cierres. Revisa la conexión y los índices de Firestore.');
      return 0;
    }
  }

  async function sincronizarPagosNominaEnFinanzas(forzarRecarga = true, silencioso = false) {
    if (!esAdmin()) return 0;
    try {
      const total = await recorrerConsultaPaginada(
        firestoreDb.collection(COLECCION_NOMINA).where('recordType', '==', 'pago').orderBy('fechaPago', 'desc'),
        movimientoDesdePago,
        'Sincronizando pagos de nómina'
      );
      if (forzarRecarga) await Promise.all([cargarPaginaMovimientos(true), cargarAnaliticaCompleta(), cargarPaginaNomina(true)]);
      if (!silencioso) alert(`Pagos sincronizados: ${total}`);
      return total;
    } catch (error) {
      console.error('[C9.25] No se pudo sincronizar la nómina:', error);
      if (!silencioso) alert('No se pudo sincronizar la nómina. Revisa los índices de Firestore.');
      return 0;
    }
  }

  async function actualizarFuentesFinancieras(mostrarMensaje = true) {
    if (!esAdmin() || !firestoreDb) return;
    const boton = $('btnActualizarFuentesFinanzas');
    if (boton) boton.disabled = true;
    try {
      setEstadoFirebase('Actualizando cierres, gastos y nómina...', true);
      const [cierres, nomina] = await Promise.all([
        sincronizarCierresCajaEnFinanzas(false, true),
        sincronizarPagosNominaEnFinanzas(false, true)
      ]);
      ultimaActualizacionFuentes = new Date();
      await Promise.all([cargarPaginaMovimientos(true), cargarAnaliticaCompleta(), cargarPaginaNomina(true)]);
      if ($('ultimaActualizacionFinanzas')) $('ultimaActualizacionFinanzas').textContent = ultimaActualizacionFuentes.toLocaleString('es-CO');
      if (mostrarMensaje) alert(`Finanzas actualizadas. Cierres procesados: ${cierres}. Pagos de nómina procesados: ${nomina}. Los gastos manuales se cargaron directamente desde Firestore.`);
    } finally {
      if (boton) boton.disabled = false;
    }
  }

  function construirQueryNomina() {
    let q = firestoreDb.collection(COLECCION_NOMINA).where('recordType', '==', 'pago').orderBy('fechaPago', 'desc');
    const cursor = nominaCursores[nominaPaginaActual];
    if (cursor) q = q.startAfter(cursor);
    return q.limit(NOMINA_PAGE_SIZE);
  }

  async function cargarPaginaNomina(reset = false) {
    if (!esAdmin()) return;
    if (reset) {
      nominaPaginaActual = 0;
      nominaCursores = [null];
    }
    try {
      const snap = await construirQueryNomina().get();
      if (!snap.docs.length && nominaPaginaActual > 0) {
        nominaPaginaActual -= 1;
        nominaHaySiguiente = false;
        return;
      }
      nominaHaySiguiente = snap.docs.length === NOMINA_PAGE_SIZE;
      const visibles = snap.docs;
      pagosNomina = visibles.map((doc) => ({ id: doc.id, ...doc.data() }));
      if (nominaHaySiguiente && visibles.length) nominaCursores[nominaPaginaActual + 1] = visibles[visibles.length - 1];
      actualizarVistaNomina();
      if ($('infoPaginacionNominaFinanzas')) $('infoPaginacionNominaFinanzas').textContent = `Página ${nominaPaginaActual + 1} · ${pagosNomina.length} pagos leídos`;
      if ($('btnNominaFinAnterior')) $('btnNominaFinAnterior').disabled = nominaPaginaActual === 0;
      if ($('btnNominaFinSiguiente')) $('btnNominaFinSiguiente').disabled = !nominaHaySiguiente;
    } catch (error) {
      console.error('Error cargando nómina:', error);
      const body = $('tablaDetalleNomina');
      if (body) body.innerHTML = '<tr><td colspan="5" class="text-center text-danger">No se pudo consultar la nómina.</td></tr>';
    }
  }

  async function cambiarPaginaNomina(delta) {
    const destino = nominaPaginaActual + delta;
    if (destino < 0 || (delta > 0 && !nominaHaySiguiente)) return;
    nominaPaginaActual = destino;
    await cargarPaginaNomina(false);
  }

  function actualizarVistaNomina() {
    const nombres = [...new Set(pagosNomina.map((p) => limpiarTexto(p.nombre, 120)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    if (filtroEmpleadoNomina) {
      filtroEmpleadoNomina.innerHTML = '<option value="">Todos los empleados de esta página</option>' + nombres.map((n) => `<option value="${escapeHtml(n)}"${n === empleadoNominaSeleccionado ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    }
    const filtrados = empleadoNominaSeleccionado ? pagosNomina.filter((p) => limpiarTexto(p.nombre, 120) === empleadoNominaSeleccionado) : pagosNomina;
    const resumenMap = new Map();
    filtrados.forEach((p) => {
      const nombre = limpiarTexto(p.nombre || 'Sin nombre', 120);
      const r = resumenMap.get(nombre) || { nombre, cargo: limpiarTexto(p.cargo, 100), pagos: 0, total: 0, ultimo: p.fechaPago || null };
      r.pagos += 1;
      r.total += numero(p.totalPagado);
      resumenMap.set(nombre, r);
    });
    const resumenRows = [...resumenMap.values()];
    if ($('tablaResumenNomina')) $('tablaResumenNomina').innerHTML = resumenRows.map((r) => `<tr><td>${escapeHtml(r.nombre)}</td><td>${escapeHtml(r.cargo || '-')}</td><td class="text-center">${r.pagos}</td><td>${escapeHtml(dinero(r.total))}</td><td>${escapeHtml(formatearFechaSolo(r.ultimo) || '-')}</td><td><button class="btn btn-outline-primary btn-sm" type="button" onclick="seleccionarEmpleadoNomina('${encodeURIComponent(r.nombre)}')">Ver pagos</button></td></tr>`).join('') || '<tr><td colspan="6" class="text-center text-muted">Sin pagos en esta página.</td></tr>';
    if ($('tablaDetalleNomina')) $('tablaDetalleNomina').innerHTML = filtrados.map((p) => `<tr><td>${escapeHtml(formatearFechaSolo(p.fechaPago) || '-')}</td><td>${escapeHtml(p.nombre || '-')}</td><td>${escapeHtml(p.quincena || '-')}</td><td>${escapeHtml(p.cargo || '-')}</td><td>${escapeHtml(dinero(p.totalPagado))}</td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-muted">Sin pagos en esta página.</td></tr>';
    if ($('resumenNominaEmpleados')) $('resumenNominaEmpleados').textContent = String(resumenRows.length);
    if ($('resumenNominaPagos')) $('resumenNominaPagos').textContent = String(filtrados.length);
    if ($('resumenNominaTotal')) $('resumenNominaTotal').textContent = dinero(filtrados.reduce((a, p) => a + numero(p.totalPagado), 0));
    if ($('resumenNominaEmpleadoActivo')) $('resumenNominaEmpleadoActivo').textContent = empleadoNominaSeleccionado || 'Página actual';
  }

  function seleccionarEmpleadoNomina(nombreCodificado) {
    empleadoNominaSeleccionado = decodeURIComponent(nombreCodificado || '');
    actualizarVistaNomina();
  }

  function formatearFechaSolo(valor) {
    if (!valor) return '';
    const d = valor?.toDate ? valor.toDate() : new Date(valor);
    return Number.isNaN(d.getTime()) ? String(valor).slice(0, 10) : d.toLocaleDateString('es-CO');
  }

  async function obtenerTodosMovimientosFiltrados() {
    if (!confirm('Esta exportación consultará todos los movimientos que coincidan con los filtros actuales. ¿Continuar?')) return null;
    const resultado = [];
    let cursor = null;
    while (resultado.length < EXPORT_LIMIT) {
      let q = firestoreDb.collection(COLECCION_MOVIMIENTOS);
      if (filtrosActivos.tipo) q = q.where('tipo', '==', filtrosActivos.tipo);
      if (filtrosActivos.categoria) q = q.where('categoria', '==', filtrosActivos.categoria);
      if (filtrosActivos.desde) q = q.where('fecha', '>=', filtrosActivos.desde);
      if (filtrosActivos.hasta) q = q.where('fecha', '<=', filtrosActivos.hasta);
      q = q.orderBy('fecha', 'desc').limit(EXPORT_PAGE_SIZE);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;
      resultado.push(...snap.docs.map((d) => normalizarMovimiento({ id: d.id, ...d.data() })).filter((m) => m.fecha));
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < EXPORT_PAGE_SIZE) break;
    }
    if (resultado.length >= EXPORT_LIMIT) alert(`La exportación se limitó a ${EXPORT_LIMIT} registros.`);
    return resultado;
  }

  async function guardarExcelBasico(data, nombre = 'movimientos') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Movimientos');
    sheet.columns = [
      { header: 'Tipo', key: 'tipo', width: 15 },
      { header: 'Monto', key: 'monto', width: 18 },
      { header: 'Categoría', key: 'categoria', width: 20 },
      { header: 'Fecha', key: 'fecha', width: 15 },
      { header: 'Descripción', key: 'descripcion', width: 45 }
    ];
    data.forEach((m) => sheet.addRow(m));
    sheet.getColumn('monto').numFmt = '"$"#,##0';
    const buffer = await workbook.xlsx.writeBuffer();
    saveAs(new Blob([buffer]), `${nombre}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function exportarExcel() {
    const data = await obtenerTodosMovimientosFiltrados();
    if (!data) return;
    await guardarExcelBasico(data, 'movimientos');
  }

  async function obtenerComprobante(m) {
    if (m.imagen) return m.imagen;
    if (!m.tieneImagen) return null;
    const snap = await firestoreDb.collection(COLECCION_COMPROBANTES).doc(m.id).get();
    return snap.data()?.imagen || null;
  }

  async function exportarExcelConImagenes() {
    const data = await obtenerTodosMovimientosFiltrados();
    if (!data) return;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Movimientos');
    sheet.addRow(['Tipo', 'Monto', 'Categoría', 'Fecha', 'Descripción', 'Foto']);
    for (const m of data) {
      const row = sheet.addRow([m.tipo, m.monto, m.categoria, m.fecha, m.descripcion, '']);
      const imagen = await obtenerComprobante(m);
      if (imagen) {
        try {
          const extension = imagen.includes('image/png') ? 'png' : 'jpeg';
          const imageId = workbook.addImage({ base64: imagen, extension });
          sheet.addImage(imageId, { tl: { col: 5, row: row.number - 1 }, ext: { width: 100, height: 80 } });
          row.height = 60;
        } catch (_) {}
      }
    }
    sheet.columns = [{ width: 14 }, { width: 16 }, { width: 20 }, { width: 14 }, { width: 40 }, { width: 18 }];
    const buffer = await workbook.xlsx.writeBuffer();
    saveAs(new Blob([buffer]), `movimientos_con_fotos_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function exportarExcelYZip() {
    const data = await obtenerTodosMovimientosFiltrados();
    if (!data) return;
    await guardarExcelBasico(data, 'movimientos');
    const zip = new JSZip();
    const carpeta = zip.folder('imagenes_movimientos');
    let cantidad = 0;
    for (const m of data) {
      const imagen = await obtenerComprobante(m);
      if (!imagen) continue;
      const base64 = imagen.split(',')[1];
      if (!base64) continue;
      const extension = imagen.includes('image/png') ? 'png' : 'jpg';
      carpeta.file(`${m.fecha}_${m.id}.${extension}`, base64, { base64: true });
      cantidad += 1;
    }
    if (cantidad) saveAs(await zip.generateAsync({ type: 'blob' }), 'imagenes_movimientos.zip');
    else alert('El Excel fue exportado. No había comprobantes para incluir en el ZIP.');
  }

  async function migrarLocalStorageManual() {
    if (!esAdmin()) return;
    const locales = [];
    for (const key of [CACHE_ANTERIOR_KEY, CACHE_LEGACY_KEY]) {
      try {
        const arr = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(arr)) locales.push(...arr.map(normalizarMovimiento));
      } catch (_) {}
    }
    if (!locales.length) {
      alert('No hay movimientos locales por subir.');
      return;
    }
    if (!confirm(`Se subirán hasta ${locales.length} movimientos locales. ¿Continuar?`)) return;
    let batch = firestoreDb.batch();
    let count = 0;
    for (const m of locales) {
      const id = m.sourceKey || `migrado_${hashSimple([m.tipo, m.monto, m.categoria, m.fecha, m.descripcion].join('|'))}`;
      batch.set(firestoreDb.collection(COLECCION_MOVIMIENTOS).doc(id), { ...m, imagen: firebase.firestore.FieldValue.delete(), tieneImagen: Boolean(m.imagen), updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: usuarioAutenticado.email }, { merge: true });
      if (m.imagen) batch.set(firestoreDb.collection(COLECCION_COMPROBANTES).doc(id), { imagen: m.imagen, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
      count += m.imagen ? 2 : 1;
      if (count >= 350) {
        await batch.commit();
        batch = firestoreDb.batch();
        count = 0;
      }
    }
    if (count) await batch.commit();
    // Después de confirmar la subida, se eliminan únicamente las cachés antiguas pesadas.
    // La caché actual conserva como máximo 10 registros sin imágenes.
    for (const key of [CACHE_PREVIA_KEY, CACHE_ANTERIOR_KEY, CACHE_LEGACY_KEY]) {
      try { localStorage.removeItem(key); } catch (_) {}
    }
    guardarCache();
    alert('Migración local terminada y caché antigua liberada.');
    await Promise.all([cargarPaginaMovimientos(true), cargarAnaliticaCompleta()]);
  }

  function hashSimple(texto) {
    let hash = 2166136261;
    for (const ch of String(texto)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }

  if (fotoInput) fotoInput.addEventListener('change', async function () {
    try { mostrarVistaFoto(this.files?.[0] ? await comprimirImagen(this.files[0]) : null); } catch (error) { alert(error.message); this.value = ''; }
  });
  if (formulario) formulario.addEventListener('submit', guardarFormulario);
  if (filtroEmpleadoNomina) filtroEmpleadoNomina.addEventListener('change', function () { empleadoNominaSeleccionado = this.value || ''; actualizarVistaNomina(); });

  Object.assign(window, {
    formatearComoCOP,
    toggleDarkMode,
    filtrarMovimientos,
    limpiarFiltros,
    editarMovimiento,
    eliminarMovimiento,
    verComprobanteFinanzas,
    exportarExcel,
    exportarExcelYZip,
    exportarExcelConImagenes,
    sincronizarCierresCajaEnFinanzas,
    sincronizarPagosNominaEnFinanzas,
    actualizarFuentesFinancieras,
    seleccionarEmpleadoNomina,
    migrarLocalStorageManual
  });

  (async function init() {
    if (localStorage.getItem('darkMode') === 'true') document.body.classList.add('dark-mode');
    movimientos = cargarCache();
    crearControlesPaginacion();
    actualizarTodo();
    actualizarControlesPaginacion();
    await iniciarFirebase();
    if (!firebaseDisponible) return;
    firebaseAuth.onAuthStateChanged(async (user) => {
      usuarioAutenticado = user || null;
      if (!user) {
        bloquearPagina('Sin sesión de Firebase · vuelve al POS e inicia sesión');
        return;
      }
      if (!esAdmin(user)) {
        bloquearPagina('Acceso restringido: Finanzas solo está disponible para admin@local.io');
        return;
      }
      setEstadoFirebase(`Conectado como ${user.email}`, true);
      formulario?.querySelectorAll('input, select, textarea, button').forEach((el) => { el.disabled = false; });
      await actualizarFuentesFinancieras(false);
      if (btnMigrarLocalStorage) btnMigrarLocalStorage.disabled = false;
    });
  })();
})();
