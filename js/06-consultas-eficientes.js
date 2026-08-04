(() => {
  'use strict';

  const VERSION = '2026.08.04-C9.12-HISTORICOS';
  const PAGE_SIZE = 10;
  const SEARCH_PAGE_SIZE = 10;
  const EXPORT_BATCH_SIZE = 200;
  const MAX_EXPORT_DOCS = 10000;
  const INVENTORY_LIMIT = 100;

  const baseExportarVentasExcel = typeof exportarVentasExcelConEstilo === 'function' ? exportarVentasExcelConEstilo : null;
  const baseGenerarResumenProductos = typeof generarResumenProductos === 'function' ? generarResumenProductos : null;
  const baseExportarVentasDia = typeof exportarVentasAExcel === 'function' ? exportarVentasAExcel : null;

  const state = {
    today: { docs: [], cursor: null, hasMore: true, unsubscribe: null, search: '', loading: false },
    summaries: {
      historicoDia: createPageState('resumenVentasDiario'),
      historicoSemana: createPageState('resumenVentasSemanal'),
      historicoMes: createPageState('resumenVentasMensual'),
      domiciliosDia: createPageState('resumenVentasDiario')
    },
    details: {
      historicoDetalle: createPageState('ventas'),
      domiciliosDetalle: createPageState('ventas')
    },
    cash: createPageState('controlCaja')
  };

  function createPageState(collection) {
    return { collection, docs: [], cursor: null, hasMore: true, loading: false, key: '' };
  }

  function online() {
    return Boolean(navigator.onLine && firestoreDisponible && firestoreDb && firebaseAuth?.currentUser);
  }

  function notify(message, type = 'info') {
    if (typeof notificarSistema === 'function') return notificarSistema(message, type);
    console[type === 'error' ? 'error' : 'log'](message);
  }

  function money(value) {
    if (typeof formatearDinero === 'function') return formatearDinero(value);
    return `$${Number(value || 0).toLocaleString('es-CO')}`;
  }

  function dayKey(date = new Date()) {
    if (typeof obtenerFechaLocalISO === 'function') return obtenerFechaLocalISO(date);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(date);
  }

  function weekKey(date = new Date()) {
    if (typeof obtenerClaveSemana === 'function') return obtenerClaveSemana(date);
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const n = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - n);
    const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return `${d.getUTCFullYear()}-S${String(Math.ceil((((d - start) / 86400000) + 1) / 7)).padStart(2, '0')}`;
  }

  function dayRange(day) {
    const start = new Date(`${day}T05:00:00.000Z`);
    return { start: start.toISOString(), end: new Date(start.getTime() + 86400000 - 1).toISOString() };
  }

  function normalizeSale(doc) {
    const raw = doc?.data ? { _docId: doc.id, ...doc.data() } : doc;
    return typeof normalizarVenta === 'function' ? normalizarVenta(raw || {}) : (raw || {});
  }

  function saleId(sale = {}) {
    return String(sale._docId || sale._localId || `${sale.diaClave || ''}|${sale.comanda || ''}|${sale.fechaISO || ''}`);
  }

  function mergeSalesIntoCache(sales, replaceToday = false) {
    const current = typeof obtenerVentasStorage === 'function' ? obtenerVentasStorage() : [];
    const today = dayKey();
    const base = replaceToday ? current.filter(sale => String(sale.diaClave || '') !== today || sale._syncEstado === 'pendiente') : current;
    const map = new Map(base.map(sale => [saleId(sale), sale]));
    sales.forEach(sale => map.set(saleId(sale), sale));
    let merged = Array.from(map.values());
    if (typeof fusionarVentasRemotasConPendientes === 'function') merged = fusionarVentasRemotasConPendientes(merged);
    if (typeof ordenarVentasDesc === 'function') merged = ordenarVentasDesc(merged);
    if (typeof guardarVentasEnCache === 'function') guardarVentasEnCache(merged);
    return merged;
  }

  function loadedTodayCount() {
    return (typeof obtenerVentasStorage === 'function' ? obtenerVentasStorage() : [])
      .filter(sale => String(sale.diaClave || '') === dayKey()).length;
  }

  function updateMainPaginationControls(totalLoaded) {
    const pagesLoaded = Math.max(1, Math.ceil(totalLoaded / PAGE_SIZE));
    const start = totalLoaded === 0 ? 0 : (paginaVentasActual - 1) * PAGE_SIZE + 1;
    const end = Math.min(paginaVentasActual * PAGE_SIZE, totalLoaded);
    const info = document.getElementById('ventasPaginacionInfo');
    const page = document.getElementById('ventasPaginaActual');
    const prev = document.getElementById('btnPrevVentas');
    const next = document.getElementById('btnNextVentas');
    if (info) info.textContent = `Mostrando ${start}-${end} de ${totalLoaded} venta(s) cargada(s)${state.today.hasMore && !state.today.search ? ' · hay más en la base' : ''}`;
    if (page) page.textContent = `Página ${paginaVentasActual}${state.today.hasMore && !state.today.search ? '+' : ` de ${pagesLoaded}`}`;
    if (prev) {
      prev.disabled = paginaVentasActual <= 1 || state.today.loading;
      prev.classList.toggle('opacity-50', prev.disabled);
    }
    if (next) {
      const canUseLoaded = paginaVentasActual < pagesLoaded;
      next.disabled = state.today.loading || (!canUseLoaded && !state.today.hasMore);
      next.classList.toggle('opacity-50', next.disabled);
    }
  }

  async function fetchTodayNextPage() {
    if (!online() || state.today.loading || !state.today.hasMore || state.today.search) return;
    state.today.loading = true;
    try {
      const range = dayRange(dayKey());
      let query = firestoreDb.collection('ventas')
        .where('fechaISO', '>=', range.start)
        .where('fechaISO', '<=', range.end)
        .orderBy('fechaISO', 'desc');
      if (state.today.cursor) query = query.startAfter(state.today.cursor);
      const snapshot = await query.limit(PAGE_SIZE).get();
      const sales = snapshot.docs.map(normalizeSale);
      state.today.docs.push(...sales);
      state.today.cursor = snapshot.docs.at(-1) || state.today.cursor;
      state.today.hasMore = snapshot.size === PAGE_SIZE;
      mergeSalesIntoCache(sales, false);
    } finally {
      state.today.loading = false;
    }
  }

  escucharVentasFirestore = function() {
    if (!online()) return;
    if (typeof ventasUnsubscribe === 'function') ventasUnsubscribe();
    if (typeof state.today.unsubscribe === 'function') state.today.unsubscribe();
    const range = dayRange(dayKey());
    const query = firestoreDb.collection('ventas')
      .where('fechaISO', '>=', range.start)
      .where('fechaISO', '<=', range.end)
      .orderBy('fechaISO', 'desc')
      .limit(PAGE_SIZE);
    state.today.unsubscribe = query.onSnapshot(snapshot => {
      if (typeof registrarHeartbeatFirebase === 'function') registrarHeartbeatFirebase();
      const sales = snapshot.docs.map(normalizeSale);
      state.today.docs = sales;
      state.today.cursor = snapshot.docs.at(-1) || null;
      state.today.hasMore = snapshot.size === PAGE_SIZE;
      state.today.search = '';
      mergeSalesIntoCache(sales, true);
      paginaVentasActual = 1;
      renderVentasTabla();
      updateMainPaginationControls(loadedTodayCount());
      if (typeof programarSyncVentasPendientes === 'function') programarSyncVentasPendientes(80);
    }, error => {
      console.error('Error en consulta mínima de ventas:', error);
      if (typeof actualizarIndicadorFirebase === 'function') actualizarIndicadorFirebase('desconectado', 'No se pudieron cargar las ventas actuales');
      if (typeof reconectarFirestoreSeguro === 'function') reconectarFirestoreSeguro('consulta-ventas');
    });
    ventasUnsubscribe = state.today.unsubscribe;
  };
  window.escucharVentasFirestore = escucharVentasFirestore;

  mostrarVentas = function() {
    renderVentasTabla();
    updateMainPaginationControls(loadedTodayCount());
    if (typeof renderControlCajaDiaActual === 'function') renderControlCajaDiaActual(false);
  };
  window.mostrarVentas = mostrarVentas;

  cambiarPaginaVentas = async function(direction) {
    const desired = Math.max(1, paginaVentasActual + Number(direction || 0));
    const loadedPages = Math.max(1, Math.ceil(loadedTodayCount() / PAGE_SIZE));
    if (direction > 0 && desired > loadedPages && state.today.hasMore && !state.today.search) {
      await fetchTodayNextPage();
    }
    const newLoadedPages = Math.max(1, Math.ceil(loadedTodayCount() / PAGE_SIZE));
    paginaVentasActual = Math.min(desired, newLoadedPages);
    renderVentasTabla();
    updateMainPaginationControls(loadedTodayCount());
  };
  window.cambiarPaginaVentas = cambiarPaginaVentas;

  let searchTimer = null;
  filtrarVentasPorCliente = function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const term = String(document.getElementById('filtroCliente')?.value || '').trim().toLowerCase();
      paginaVentasActual = 1;
      if (!term) {
        state.today.search = '';
        escucharVentasFirestore();
        return;
      }
      state.today.search = term;
      if (!online()) {
        renderVentasTabla();
        updateMainPaginationControls(loadedTodayCount());
        return;
      }
      state.today.loading = true;
      try {
        const snapshot = await firestoreDb.collection('ventas')
          .where('diaClave', '==', dayKey())
          .where('clienteBusqueda', '>=', term)
          .where('clienteBusqueda', '<=', `${term}\uf8ff`)
          .orderBy('clienteBusqueda')
          .limit(SEARCH_PAGE_SIZE)
          .get();
        const sales = snapshot.docs.map(normalizeSale);
        mergeSalesIntoCache(sales, false);
        state.today.hasMore = false;
        renderVentasTabla();
      } catch (error) {
        console.warn('La búsqueda remota no estuvo disponible; se filtrarán los datos ya cargados.', error);
        renderVentasTabla();
      } finally {
        state.today.loading = false;
        updateMainPaginationControls(loadedTodayCount());
      }
    }, 350);
  };
  window.filtrarVentasPorCliente = filtrarVentasPorCliente;

  async function fetchSummaryPage(key, reset = false) {
    const target = state.summaries[key];
    if (!target || target.loading || (!reset && !target.hasMore) || !online()) return;
    if (reset) Object.assign(target, createPageState(target.collection));
    target.loading = true;
    try {
      let query = firestoreDb.collection(target.collection).orderBy('periodo', 'desc');
      if (target.cursor) query = query.startAfter(target.cursor);
      const snapshot = await query.limit(PAGE_SIZE + 1).get();
      const pageDocs = snapshot.docs.slice(0, PAGE_SIZE);
      target.docs.push(...pageDocs.map(doc => ({ id: doc.id, ...doc.data() })));
      target.cursor = pageDocs.at(-1) || target.cursor;
      target.hasMore = snapshot.size > PAGE_SIZE;
    } finally {
      target.loading = false;
    }
  }

  function summaryRow(summary = {}) {
    return {
      label: summary.periodo || summary.id || '-',
      ventas: Math.max(0, Number(summary.pedidosActivos || 0)),
      canceladas: Math.max(0, Number(summary.pedidosCancelados || 0)),
      domicilios: Math.max(0, Number(summary.domiciliosActivos || 0)),
      domiciliosCancelados: Math.max(0, Number(summary.domiciliosCancelados || 0)),
      total: Math.max(0, Number(summary.totalVentas || 0))
    };
  }

  function renderSummaryTable(key) {
    const target = state.summaries[key];
    const mapping = {
      historicoDia: ['historicoDiaBody', 'infoPaginacionHistoricoDia', 'paginaHistoricoDiaActual', 'btnPrevHistoricoDia', 'btnNextHistoricoDia'],
      historicoSemana: ['historicoSemanaBody', 'infoPaginacionHistoricoSemana', 'paginaHistoricoSemanaActual', 'btnPrevHistoricoSemana', 'btnNextHistoricoSemana'],
      historicoMes: ['historicoMesBody', 'infoPaginacionHistoricoMes', 'paginaHistoricoMesActual', 'btnPrevHistoricoMes', 'btnNextHistoricoMes']
    };
    const ids = mapping[key];
    if (!ids) return;
    const rows = target.docs.map(summaryRow).map(row => `<tr><td><strong>${row.label}</strong></td><td class="sa-number">${row.ventas}${row.canceladas ? ` <span class="text-xs text-red-600">· ${row.canceladas} cancelada(s)</span>` : ''}</td><td class="sa-number">${row.domicilios}${row.domiciliosCancelados ? ` <span class="text-xs text-red-600">· ${row.domiciliosCancelados} cancelado(s)</span>` : ''}</td><td class="sa-money">${money(row.total)}</td></tr>`);
    renderFilasPaginadas({
      clave: key, bodyId: ids[0], filas: rows, colspan: 4,
      etiquetaVacia: 'No hay resúmenes disponibles. Los nuevos movimientos crearán resúmenes automáticos.',
      infoId: ids[1], pageId: ids[2], prevId: ids[3], nextId: ids[4]
    });
    patchGenericNextButton(key, target);
  }

  const PAGINATION_IDS = Object.freeze({
    historicoDia: { prev: 'btnPrevHistoricoDia', next: 'btnNextHistoricoDia', info: 'infoPaginacionHistoricoDia' },
    historicoSemana: { prev: 'btnPrevHistoricoSemana', next: 'btnNextHistoricoSemana', info: 'infoPaginacionHistoricoSemana' },
    historicoMes: { prev: 'btnPrevHistoricoMes', next: 'btnNextHistoricoMes', info: 'infoPaginacionHistoricoMes' },
    domiciliosDia: { prev: 'btnPrevDomiciliosDia', next: 'btnNextDomiciliosDia', info: 'infoPaginacionDomiciliosDia' },
    historicoDetalle: { prev: 'btnPrevHistoricoDetalle', next: 'btnNextHistoricoDetalle', info: 'infoPaginacionHistoricoDetalle' },
    domiciliosDetalle: { prev: 'btnPrevDomiciliosDetalle', next: 'btnNextDomiciliosDetalle', info: 'infoPaginacionDomiciliosDetalle' },
    cierresCaja: { prev: 'btnPrevCierresCaja', next: 'btnNextCierresCaja', info: 'infoPaginacionCierresCaja' }
  });

  function aplicarEstadoBotonPaginacion(button, disabled, loading = false) {
    if (!button) return;
    button.disabled = Boolean(disabled);
    button.dataset.loading = loading ? 'true' : 'false';
    button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
    button.setAttribute('aria-busy', loading ? 'true' : 'false');
    button.classList.toggle('opacity-50', button.disabled);
  }

  function patchGenericNextButton(key, target) {
    const ids = PAGINATION_IDS[key];
    if (!ids || !target) return;
    const prev = document.getElementById(ids.prev);
    const next = document.getElementById(ids.next);
    const info = document.getElementById(ids.info);
    const pagesLoaded = Math.max(1, Math.ceil(target.docs.length / PAGE_SIZE));
    const current = Math.max(1, Number(obtenerEstadoPaginacionTabla(key).pagina || 1));
    const hasLoadedNextPage = current < pagesLoaded;
    const canFetchNextPage = Boolean(target.hasMore);

    aplicarEstadoBotonPaginacion(prev, target.loading || current <= 1, target.loading);
    aplicarEstadoBotonPaginacion(next, target.loading || (!hasLoadedNextPage && !canFetchNextPage), target.loading);

    if (next) {
      next.title = next.disabled
        ? (target.loading ? 'Cargando registros…' : 'No hay más páginas disponibles')
        : (hasLoadedNextPage ? 'Mostrar la siguiente página cargada' : 'Cargar los siguientes 10 registros desde Firestore');
    }
    if (prev) prev.title = current <= 1 ? 'Ya estás en la primera página' : 'Volver a la página anterior';
    if (info && target.hasMore && !info.textContent.includes('hay más registros en la base')) {
      info.textContent += ' · hay más registros en la base';
    }
  }

  function marcarPaginacionCargando(key, loading) {
    const ids = PAGINATION_IDS[key];
    if (!ids) return;
    const pagination = obtenerEstadoPaginacionTabla(key);
    const prev = document.getElementById(ids.prev);
    const next = document.getElementById(ids.next);
    if (loading) {
      aplicarEstadoBotonPaginacion(prev, true, true);
      aplicarEstadoBotonPaginacion(next, true, true);
    } else {
      const target = key === 'cierresCaja' ? state.cash : (state.summaries[key] || state.details[key]);
      if (target) patchGenericNextButton(key, target);
      else aplicarEstadoBotonPaginacion(prev, Number(pagination.pagina || 1) <= 1, false);
    }
  }

  async function readSummaryDoc(collection, id) {
    if (!online()) return null;
    const snapshot = await firestoreDb.collection(collection).doc(id).get();
    return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
  }

  async function renderHistoryCards() {
    const today = dayKey();
    const [daily, weekly, monthly] = await Promise.all([
      readSummaryDoc('resumenVentasDiario', today),
      readSummaryDoc('resumenVentasSemanal', weekKey(new Date())),
      readSummaryDoc('resumenVentasMensual', today.slice(0, 7))
    ]);
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const apply = (summary, salesId, totalId) => {
      set(salesId, `${Math.max(0, Number(summary?.pedidosActivos || 0))} pedido(s)${Number(summary?.pedidosCancelados || 0) ? ` · ${summary.pedidosCancelados} cancelado(s)` : ''}`);
      set(totalId, `${money(summary?.totalVentas || 0)} · ${Math.max(0, Number(summary?.domiciliosActivos || 0))} domicilio(s) · sin domicilios`);
    };
    apply(daily, 'histHoyVentas', 'histHoyTotal');
    apply(weekly, 'histSemanaVentas', 'histSemanaTotal');
    apply(monthly, 'histMesVentas', 'histMesTotal');
  }

  actualizarHistoricos = async function() {
    if (!online()) {
      notify('Sin conexión: se muestran únicamente los datos ya cargados.', 'warning');
      return;
    }
    await Promise.all([
      fetchSummaryPage('historicoDia', true),
      fetchSummaryPage('historicoSemana', true),
      fetchSummaryPage('historicoMes', true),
      renderHistoryCards()
    ]);
    renderSummaryTable('historicoDia');
    renderSummaryTable('historicoSemana');
    renderSummaryTable('historicoMes');
    const input = document.getElementById('filtroHistoricoFecha');
    if (input && !input.value) input.value = dayKey();
    const detailBody = document.getElementById('ventasDiaDetalleBody');
    if (detailBody) detailBody.innerHTML = '<tr><td colspan="10" class="p-3 text-center text-gray-500">Selecciona una fecha y pulsa “Ver ventas del día”.</td></tr>';
    const detailSummary = document.getElementById('resumenVentasDiaSeleccionado');
    if (detailSummary) detailSummary.textContent = 'La consulta detallada solo se ejecutará cuando selecciones una fecha.';
  };
  window.actualizarHistoricos = actualizarHistoricos;

  abrirHistoricos = async function() {
    if (!verificarAcceso(['admin', 'administrador'])) return;
    document.getElementById('appMain')?.classList.add('hidden');
    document.getElementById('cajaVista')?.classList.add('hidden');
    document.getElementById('domiciliosVista')?.classList.add('hidden');
    document.getElementById('historicosVista')?.classList.remove('hidden');
    await actualizarHistoricos();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  window.abrirHistoricos = abrirHistoricos;

  function detailSignature(kind) {
    if (kind === 'historicoDetalle') {
      return [
        document.getElementById('filtroHistoricoFecha')?.value || dayKey(),
        document.getElementById('filtroHistoricoUsuario')?.value || '',
        document.getElementById('filtroHistoricoPago')?.value || '',
        document.getElementById('filtroHistoricoProducto')?.value || '',
        document.getElementById('filtroHistoricoTipo')?.value || '',
        document.getElementById('filtroHistoricoEstado')?.value || ''
      ].join('|');
    }
    return [
      document.getElementById('filtroDomiciliosFecha')?.value || dayKey(),
      document.getElementById('filtroDomiciliosEstado')?.value || '',
      document.getElementById('filtroDomiciliosPago')?.value || '',
      document.getElementById('filtroDomiciliosDomiciliario')?.value || ''
    ].join('|');
  }

  async function fetchDetailPage(kind, reset = false) {
    const target = state.details[kind];
    if (!target || target.loading || (!reset && !target.hasMore) || !online()) return;
    const signature = detailSignature(kind);
    const day = signature.split('|')[0];
    if (reset && target.key === day && target.docs.length) return;
    if (reset || target.key !== day) Object.assign(target, createPageState('ventas'), { key: day });
    target.loading = true;
    try {
      const range = dayRange(day);
      let query = firestoreDb.collection('ventas')
        .where('fechaISO', '>=', range.start)
        .where('fechaISO', '<=', range.end);
      if (kind === 'domiciliosDetalle') query = query.where('tipoPedido', '==', 'Domicilio');
      query = query.orderBy('fechaISO', 'desc');
      if (target.cursor) query = query.startAfter(target.cursor);
      const snapshot = await query.limit(PAGE_SIZE + 1).get();
      const pageDocs = snapshot.docs.slice(0, PAGE_SIZE);
      const sales = pageDocs.map(normalizeSale);
      target.docs.push(...sales);
      target.cursor = pageDocs.at(-1) || target.cursor;
      target.hasMore = snapshot.size > PAGE_SIZE;
      mergeSalesIntoCache(sales, false);
    } finally {
      target.loading = false;
    }
  }

  function matchesHistoryFilters(sale) {
    const user = document.getElementById('filtroHistoricoUsuario')?.value || '';
    const payment = document.getElementById('filtroHistoricoPago')?.value || '';
    const product = document.getElementById('filtroHistoricoProducto')?.value || '';
    const type = document.getElementById('filtroHistoricoTipo')?.value || '';
    const status = document.getElementById('filtroHistoricoEstado')?.value || '';
    if (user && String(sale.usuario || '') !== user) return false;
    if (payment && String(sale.formaPago || '') !== payment) return false;
    if (product && !(sale.pedido || []).some(item => String(item.nombre || '') === product)) return false;
    if (type && String(sale.tipoPedido || '') !== type) return false;
    if (status && String(sale.estado || 'activa').toLowerCase() !== status.toLowerCase()) return false;
    return true;
  }

  function cacheIndex(sale) {
    const sales = typeof obtenerVentasStorage === 'function' ? obtenerVentasStorage() : [];
    const id = saleId(sale);
    return sales.findIndex(item => saleId(item) === id);
  }

  function fillSelectOptions(id, values, label) {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    const unique = [...new Set(values.filter(Boolean).map(value => String(value)))].sort((a, b) => a.localeCompare(b, 'es'));
    const escape = value => typeof saHTML === 'function' ? saHTML(value) : String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    select.innerHTML = `<option value="">${escape(label)}</option>${unique.map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join('')}`;
    if (unique.includes(current)) select.value = current;
  }

  function updateHistoryFilterOptions(sales) {
    fillSelectOptions('filtroHistoricoUsuario', sales.map(sale => sale.usuario), 'Todos los usuarios');
    fillSelectOptions('filtroHistoricoPago', sales.map(sale => sale.formaPago), 'Todos los pagos');
    fillSelectOptions('filtroHistoricoProducto', sales.flatMap(sale => (sale.pedido || []).map(product => product?.nombre)), 'Todos los productos');
  }

  function renderHistoryDetail() {
    const target = state.details.historicoDetalle;
    updateHistoryFilterOptions(target.docs);
    const sales = target.docs.filter(matchesHistoryFilters);
    const rows = sales.map(sale => {
      const cancelled = String(sale.estado || '').toLowerCase() === 'cancelada';
      const products = typeof resumirProductosPedido === 'function' ? resumirProductosPedido(sale.pedido || []) : (sale.pedido || []).map(p => p.nombre).join(', ');
      const escape = value => typeof saHTML === 'function' ? saHTML(String(value ?? '')) : String(value ?? '').replace(/[&<>\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[char]));
      const observations = String(sale.observaciones || '-');
      const productsText = String(products || '-').replace(/<br\s*\/?\s*>/gi, ' · ').replace(/<[^>]+>/g, '');
      return `<tr class="${cancelled ? 'bg-red-50 text-gray-500' : ''}"><td><strong>${escape(sale.recibo ?? '-')}</strong></td><td>${escape(sale.comanda ?? '-')}</td><td>${escape(typeof formatearHoraColombia === 'function' ? formatearHoraColombia(sale.fechaISO || sale.fecha) : '-')}</td><td>${escape(sale.cliente || 'N/A')}</td><td>${typeof obtenerEtiquetaFormaPago === 'function' ? obtenerEtiquetaFormaPago(sale) : escape(sale.formaPago || '-')}</td><td>${escape(sale.tipoPedido || '-')}</td><td>${typeof obtenerBadgeEstadoVenta === 'function' ? obtenerBadgeEstadoVenta(sale) : escape(sale.estado || 'activa')}</td><td class="sa-cell-observations" title="${escape(observations)}">${escape(observations)}</td><td class="sa-cell-products" title="${escape(productsText)}">${escape(productsText)}</td><td class="sa-money">${money(typeof obtenerIngresoRealVenta === 'function' ? obtenerIngresoRealVenta(sale) : sale.total)}</td></tr>`;
    });
    renderFilasPaginadas({ clave: 'historicoDetalle', bodyId: 'ventasDiaDetalleBody', filas: rows, colspan: 10, etiquetaVacia: 'No hay ventas en la página cargada para estos filtros.', infoId: 'infoPaginacionHistoricoDetalle', pageId: 'paginaHistoricoDetalleActual', prevId: 'btnPrevHistoricoDetalle', nextId: 'btnNextHistoricoDetalle' });
    const active = sales.filter(s => String(s.estado || '').toLowerCase() !== 'cancelada');
    const summary = document.getElementById('resumenVentasDiaSeleccionado');
    if (summary) summary.innerHTML = `<strong>Ventas visibles en las páginas cargadas:</strong> ${sales.length} &nbsp;|&nbsp; <strong>Activos:</strong> ${active.length} &nbsp;|&nbsp; <strong>Total cargado:</strong> ${money(active.reduce((sum, sale) => sum + Number(typeof obtenerIngresoRealVenta === 'function' ? obtenerIngresoRealVenta(sale) : sale.total || 0), 0))}${target.hasMore ? ' &nbsp;|&nbsp; <span class="text-amber-700">Hay más registros; usa Siguiente.</span>' : ''}`;
    patchGenericNextButton('historicoDetalle', target);
  }

  verVentasDetalladasPorFecha = async function() {
    reiniciarPaginaTabla('historicoDetalle');
    await fetchDetailPage('historicoDetalle', true);
    renderHistoryDetail();
  };
  window.verVentasDetalladasPorFecha = verVentasDetalladasPorFecha;

  function renderDomicileSummary() {
    const target = state.summaries.domiciliosDia;
    const rows = target.docs.map(summary => `<tr><td class="p-2 border">${summary.periodo || summary.id}</td><td class="p-2 border">${Math.max(0, Number(summary.domiciliosActivos || 0))}</td><td class="p-2 border">${Math.max(0, Number(summary.domiciliosCancelados || 0))}</td><td class="p-2 border">${Math.max(0, Number(summary.domiciliosTransferenciaCantidad || 0))}</td><td class="p-2 border">${Math.max(0, Number(summary.domiciliosEfectivoCantidad || 0))}</td><td class="p-2 border">${money(summary.domiciliosTransferenciaValor || 0)}</td><td class="p-2 border">${money(summary.domiciliosEfectivoValor || 0)}</td><td class="p-2 border font-semibold">${money(summary.totalDomicilios || 0)}</td></tr>`);
    renderFilasPaginadas({ clave: 'domiciliosDia', bodyId: 'domiciliosDiaBody', filas: rows, colspan: 8, etiquetaVacia: 'No hay resúmenes de domicilios.', infoId: 'infoPaginacionDomiciliosDia', pageId: 'paginaDomiciliosDiaActual', prevId: 'btnPrevDomiciliosDia', nextId: 'btnNextDomiciliosDia' });
    patchGenericNextButton('domiciliosDia', target);
  }

  async function renderDomicileCards() {
    const summary = await readSummaryDoc('resumenVentasDiario', dayKey());
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('domHoyCantidad', `${Math.max(0, Number(summary?.domiciliosActivos || 0))} domicilio(s)`);
    set('domHoyValor', money(summary?.totalDomicilios || 0));
    set('domTransferenciaCantidad', `${Math.max(0, Number(summary?.domiciliosTransferenciaCantidad || 0))} domicilio(s)`);
    set('domTransferenciaValor', money(summary?.domiciliosTransferenciaValor || 0));
    set('domEfectivoCantidad', `${Math.max(0, Number(summary?.domiciliosEfectivoCantidad || 0))} domicilio(s)`);
    set('domEfectivoValor', money(summary?.domiciliosEfectivoValor || 0));
  }

  actualizarDomiciliosVista = async function() {
    await Promise.all([fetchSummaryPage('domiciliosDia', true), renderDomicileCards()]);
    renderDomicileSummary();
    const input = document.getElementById('filtroDomiciliosFecha');
    if (input && !input.value) input.value = dayKey();
    const body = document.getElementById('domiciliosDetalleBody');
    if (body) body.innerHTML = '<tr><td colspan="14" class="p-3 text-center text-gray-500">Selecciona una fecha y pulsa “Ver domicilios”.</td></tr>';
    const summary = document.getElementById('resumenDomiciliosDiaSeleccionado');
    if (summary) summary.textContent = 'La consulta detallada solo se ejecutará cuando selecciones una fecha.';
  };
  window.actualizarDomiciliosVista = actualizarDomiciliosVista;

  abrirDomiciliosVista = async function() {
    if (!verificarAcceso(['admin', 'administrador'])) return;
    document.getElementById('appMain')?.classList.add('hidden');
    document.getElementById('historicosVista')?.classList.add('hidden');
    document.getElementById('cajaVista')?.classList.add('hidden');
    document.getElementById('domiciliosVista')?.classList.remove('hidden');
    await actualizarDomiciliosVista();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  window.abrirDomiciliosVista = abrirDomiciliosVista;

  function matchesDomicileFilters(sale) {
    const status = document.getElementById('filtroDomiciliosEstado')?.value || '';
    const payment = document.getElementById('filtroDomiciliosPago')?.value || '';
    const courier = document.getElementById('filtroDomiciliosDomiciliario')?.value || '';
    if (status && String(sale.estadoDomicilio || '') !== status) return false;
    if (payment && String(typeof obtenerEtiquetaPagoDomicilio === 'function' ? obtenerEtiquetaPagoDomicilio(sale) : sale.formaPago || '') !== payment) return false;
    if (courier && String(sale.domiciliarioAsignado || '') !== courier) return false;
    return true;
  }

  function renderDomicileDetail() {
    const target = state.details.domiciliosDetalle;
    fillSelectOptions('filtroDomiciliosDomiciliario', target.docs.map(sale => sale.domiciliarioAsignado), 'Todos los domiciliarios');
    const sales = target.docs.filter(matchesDomicileFilters);
    const rows = sales.map(sale => {
      const index = cacheIndex(sale);
      const cancelled = String(sale.estado || '').toLowerCase() === 'cancelada';
      const products = typeof resumirProductosPedido === 'function' ? resumirProductosPedido(sale.pedido || []) : (sale.pedido || []).map(p => p.nombre).join(', ');
      const states = (typeof SA_ESTADOS_DOMICILIO !== 'undefined' && Array.isArray(SA_ESTADOS_DOMICILIO)) ? SA_ESTADOS_DOMICILIO : ['Pendiente', 'En preparación', 'En camino', 'Entregado', 'Cancelado'];
      const stateSelect = index < 0 ? (sale.estadoDomicilio || 'Pendiente') : `<select onchange="cambiarEstadoDomicilio(${index}, this.value)" class="p-2 border rounded-lg text-xs" ${cancelled ? 'disabled' : ''}>${states.map(value => `<option value="${value}" ${value === (sale.estadoDomicilio || 'Pendiente') ? 'selected' : ''}>${value}</option>`).join('')}</select>`;
      const actions = cancelled || index < 0 ? '<span class="text-xs text-gray-500">No disponible</span>' : `<div class="flex flex-col gap-1"><button onclick="imprimirVentaCliente(${index})" class="bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded text-xs">Recibo</button><button onclick="asignarDomiciliario(${index})" class="bg-yellow-500 hover:bg-yellow-600 text-white px-2 py-1 rounded text-xs">Asignar</button></div>`;
      return `<tr class="${cancelled ? 'bg-red-50 text-gray-500' : ''}"><td class="p-2 border">${sale.recibo ?? '-'}</td><td class="p-2 border">${sale.comanda ?? '-'}</td><td class="p-2 border">${typeof formatearHoraColombia === 'function' ? formatearHoraColombia(sale.fechaISO || sale.fecha) : '-'}</td><td class="p-2 border">${sale.cliente || 'N/A'}</td><td class="p-2 border">${typeof obtenerEtiquetaFormaPago === 'function' ? obtenerEtiquetaFormaPago(sale) : sale.formaPago || '-'}</td><td class="p-2 border">${typeof obtenerEtiquetaPagoDomicilio === 'function' ? obtenerEtiquetaPagoDomicilio(sale) : '-'}</td><td class="p-2 border font-semibold">${money(sale.costoDomicilio || 0)}</td><td class="p-2 border">${money(typeof obtenerIngresoRealVenta === 'function' ? obtenerIngresoRealVenta(sale) : sale.total || 0)}</td><td class="p-2 border">${sale.estado || 'activa'}</td><td class="p-2 border">${sale.direccionDomicilio || '-'}</td><td class="p-2 border">${stateSelect}</td><td class="p-2 border">${sale.domiciliarioAsignado || '-'}</td><td class="p-2 border">${products}</td><td class="p-2 border text-center">${actions}</td></tr>`;
    });
    renderFilasPaginadas({ clave: 'domiciliosDetalle', bodyId: 'domiciliosDetalleBody', filas: rows, colspan: 14, etiquetaVacia: 'No hay domicilios en la página cargada para estos filtros.', infoId: 'infoPaginacionDomiciliosDetalle', pageId: 'paginaDomiciliosDetalleActual', prevId: 'btnPrevDomiciliosDetalle', nextId: 'btnNextDomiciliosDetalle' });
    const active = sales.filter(s => String(s.estado || '').toLowerCase() !== 'cancelada');
    const summary = document.getElementById('resumenDomiciliosDiaSeleccionado');
    if (summary) summary.innerHTML = `<strong>Ventas visibles en las páginas cargadas:</strong> ${sales.length} &nbsp;|&nbsp; <strong>Activos:</strong> ${active.length} &nbsp;|&nbsp; <strong>Valor de domicilios cargado:</strong> ${money(active.reduce((sum, sale) => sum + Number(sale.costoDomicilio || 0), 0))}${target.hasMore ? ' &nbsp;|&nbsp; <span class="text-amber-700">Hay más registros; usa Siguiente.</span>' : ''}`;
    patchGenericNextButton('domiciliosDetalle', target);
  }

  verDomiciliosDetalladosPorFecha = async function() {
    reiniciarPaginaTabla('domiciliosDetalle');
    await fetchDetailPage('domiciliosDetalle', true);
    renderDomicileDetail();
  };
  window.verDomiciliosDetalladosPorFecha = verDomiciliosDetalladosPorFecha;

  async function fetchCashPage(reset = false) {
    const target = state.cash;
    if (target.loading || (!reset && !target.hasMore) || !online()) return;
    if (reset) Object.assign(target, createPageState('controlCaja'));
    target.loading = true;
    try {
      let query = firestoreDb.collection('controlCaja').orderBy(firebase.firestore.FieldPath.documentId(), 'desc');
      if (target.cursor) query = query.startAfter(target.cursor);
      const snapshot = await query.limit(PAGE_SIZE).get();
      target.docs.push(...snapshot.docs.map(doc => ({ diaClave: doc.id, ...doc.data() })));
      target.cursor = snapshot.docs.at(-1) || target.cursor;
      target.hasMore = snapshot.size === PAGE_SIZE;
      target.docs.forEach(control => { if (typeof guardarControlCajaEnCache === 'function') guardarControlCajaEnCache(control); });
    } finally {
      target.loading = false;
    }
  }

  function renderCashRows() {
    const rows = state.cash.docs.map(control => {
      const opening = Number(control.aperturaMonto || 0);
      const closing = Number(control.cierreMonto || 0);
      const expected = Number(control.dineroEsperado ?? control.cajaEsperada ?? control.efectivoEsperado ?? 0);
      const cash = Number(control.efectivoSistema ?? control.totalEfectivo ?? 0);
      const transfers = Number(control.transferencias ?? control.totalTransferencias ?? 0);
      const deliveries = Number(control.domiciliosDescontados ?? control.ajusteDomiciliosTransferencia ?? 0);
      const real = Number(control.cierreRealDia ?? control.totalSistemaReal ?? 0);
      const difference = closing ? closing - expected : 0;
      const actions = `<div class="flex flex-wrap items-center justify-center gap-2"><button type="button" onclick="abrirModalDesgloseCierreDia('${control.diaClave}')" class="bg-slate-800 hover:bg-slate-900 text-white px-3 py-1 rounded-lg font-semibold text-xs">📊 Desglose</button>${typeof esAdmin === 'function' && esAdmin() ? `<button type="button" onclick="abrirModalEditarCierreCaja('${control.diaClave}')" class="bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-1 rounded-lg font-semibold text-xs">✏️ Editar</button>` : ''}</div>`;
      return `<tr><td class="p-2 border">${control.diaClave}</td><td class="p-2 border">${opening ? money(opening) : 'Sin apertura'}</td><td class="p-2 border">${closing ? money(closing) : 'Sin cierre'}</td><td class="p-2 border">${money(cash)}</td><td class="p-2 border">${money(transfers)}</td><td class="p-2 border">${money(deliveries)}</td><td class="p-2 border">${money(expected)}</td><td class="p-2 border">${money(real)}</td><td class="p-2 border">${closing ? money(difference) : 'Pendiente'}</td><td class="p-2 border">${control.aperturaUsuario || '-'}</td><td class="p-2 border">${control.cierreUsuario || '-'}</td><td class="p-2 border text-center">${actions}</td></tr>`;
    });
    renderFilasPaginadas({ clave: 'cierresCaja', bodyId: 'cierresCajaBody', filas: rows, colspan: 12, etiquetaVacia: 'No hay registros de caja.', infoId: 'infoPaginacionCierresCaja', pageId: 'paginaCierresCajaActual', prevId: 'btnPrevCierresCaja', nextId: 'btnNextCierresCaja' });
    patchGenericNextButton('cierresCaja', state.cash);
  }

  renderTablaCierresCaja = async function(forceRemote = false) {
    if (forceRemote || !state.cash.docs.length) await fetchCashPage(true);
    renderCashRows();
  };
  window.renderTablaCierresCaja = renderTablaCierresCaja;

  cambiarPaginaTabla = async function(key, direction) {
    const step = Number(direction || 0);
    if (!Number.isFinite(step) || step === 0) return;
    const pagination = obtenerEstadoPaginacionTabla(key);
    const target = key === 'cierresCaja' ? state.cash : (state.summaries[key] || state.details[key]);
    if (target?.loading) return;

    const current = Math.max(1, Number(pagination.pagina || 1));
    const desired = Math.max(1, current + step);
    marcarPaginacionCargando(key, true);

    try {
      if (target) {
        let loadedPages = Math.max(1, Math.ceil(target.docs.length / PAGE_SIZE));
        if (step > 0 && desired > loadedPages && target.hasMore) {
          if (key === 'cierresCaja') await fetchCashPage(false);
          else if (state.summaries[key]) await fetchSummaryPage(key, false);
          else if (state.details[key]) await fetchDetailPage(key, false);
          loadedPages = Math.max(1, Math.ceil(target.docs.length / PAGE_SIZE));
        }
        pagination.pagina = Math.min(desired, loadedPages);
      } else {
        pagination.pagina = desired;
      }
    } catch (error) {
      pagination.pagina = current;
      console.error(`No se pudo cambiar la página de ${key}:`, error);
      notify('No se pudo cargar la siguiente página. Revisa la conexión e inténtalo nuevamente.', 'error');
    } finally {
      if (key === 'cierresCaja') renderCashRows();
      else if (['historicoDia', 'historicoSemana', 'historicoMes'].includes(key)) renderSummaryTable(key);
      else if (key === 'domiciliosDia') renderDomicileSummary();
      else if (key === 'historicoDetalle') renderHistoryDetail();
      else if (key === 'domiciliosDetalle') renderDomicileDetail();
      marcarPaginacionCargando(key, false);
    }
  };
  window.cambiarPaginaTabla = cambiarPaginaTabla;

  function compactSaleContribution(sale = {}) {
    const cancelled = String(sale.estado || '').toLowerCase() === 'cancelada';
    const delivery = String(sale.tipoPedido || '').toLowerCase() === 'domicilio';
    const total = Number(typeof obtenerIngresoRealVenta === 'function' ? obtenerIngresoRealVenta(sale) : (sale.subtotalProductos ?? sale.total ?? 0)) || 0;
    const deliveryValue = Math.max(0, Number(sale.costoDomicilio || 0));
    const cash = Number(typeof obtenerValorPagoPorMedio === 'function' ? obtenerValorPagoPorMedio(sale, 'efectivo') : 0) || 0;
    const deliveryTransfer = !cancelled && delivery && typeof obtenerValorDomicilioCubiertoPorTransferencia === 'function' ? Number(obtenerValorDomicilioCubiertoPorTransferencia(sale) || 0) : 0;
    const deliveryCash = !cancelled && delivery && typeof obtenerValorDomicilioCubiertoPorEfectivo === 'function' ? Number(obtenerValorDomicilioCubiertoPorEfectivo(sale) || 0) : Math.max(0, deliveryValue - deliveryTransfer);
    const charged = Math.max(0, Number(sale.totalCobrado || 0) || total + deliveryValue);
    return {
      pedidosActivos: cancelled ? 0 : 1,
      pedidosCancelados: cancelled ? 1 : 0,
      domiciliosActivos: !cancelled && delivery ? 1 : 0,
      domiciliosCancelados: cancelled && delivery ? 1 : 0,
      domiciliosTransferenciaCantidad: deliveryTransfer > 0 ? 1 : 0,
      domiciliosEfectivoCantidad: deliveryCash > 0 ? 1 : 0,
      domiciliosTransferenciaValor: Math.max(0, deliveryTransfer),
      domiciliosEfectivoValor: Math.max(0, deliveryCash),
      totalVentas: cancelled ? 0 : total,
      totalDomicilios: !cancelled && delivery ? deliveryValue : 0,
      totalCobrado: cancelled ? 0 : charged,
      efectivo: cancelled ? 0 : cash,
      transferencias: cancelled ? 0 : Math.max(0, charged - cash)
    };
  }

  function addContribution(target, contribution) {
    Object.entries(contribution).forEach(([key, value]) => { target[key] = Number(target[key] || 0) + Number(value || 0); });
  }

  function safeDocumentId(value = '') {
    return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 180) || `doc_${Date.now()}`;
  }

  function addSummaryIncrementsToBatch(batch, sale, timestamp) {
    const contribution = compactSaleContribution(sale);
    const day = String(sale.diaClave || dayKey(new Date(sale.fechaISO || Date.now())));
    const periods = [
      ['resumenVentasDiario', day],
      ['resumenVentasSemanal', weekKey(new Date(`${day}T12:00:00-05:00`))],
      ['resumenVentasMensual', day.slice(0, 7)]
    ];
    periods.forEach(([collection, period]) => {
      const payload = {
        periodo: period,
        schemaVersion: 1,
        actualizadoServidor: timestamp,
        actualizadoPor: usuarioActual || '',
        actualizadoUid: firebaseAuth?.currentUser?.uid || ''
      };
      Object.entries(contribution).forEach(([key, value]) => { payload[key] = firebase.firestore.FieldValue.increment(Number(value || 0)); });
      batch.set(firestoreDb.collection(collection).doc(period), payload, { merge: true });
    });
  }

  subirVentasImportadasAFirebase = async function(sales = []) {
    if (!online()) throw new Error('Firebase no está disponible para importar ventas.');
    const saved = [];
    const SALES_PER_BATCH = 100;
    for (let offset = 0; offset < sales.length; offset += SALES_PER_BATCH) {
      const batch = firestoreDb.batch();
      const timestamp = firebase.firestore.FieldValue.serverTimestamp();
      sales.slice(offset, offset + SALES_PER_BATCH).forEach((original, index) => {
        const sale = normalizeSale(original);
        const identity = safeDocumentId(sale._localId || `import_${sale.diaClave}_${sale.comanda || sale.recibo || offset + index + 1}`);
        const ref = firestoreDb.collection('ventas').doc(identity);
        const payload = { ...sale };
        delete payload._docId;
        delete payload._syncEstado;
        payload._localId = sale._localId || identity;
        payload.version = Math.max(1, Number(sale.version || 1));
        payload.schemaVersion = 4;
        payload.clienteBusqueda = String(sale.cliente || '').trim().toLowerCase().slice(0, 160);
        payload.creadoServidor = timestamp;
        payload.actualizadoServidor = timestamp;
        payload.fechaClienteISO = sale.fechaISO || new Date().toISOString();
        batch.set(ref, payload, { merge: false });
        addSummaryIncrementsToBatch(batch, sale, timestamp);
        saved.push(normalizeSale({ ...payload, _docId: identity, _syncEstado: 'sincronizado' }));
      });
      await batch.commit();
      if (typeof registrarHeartbeatFirebase === 'function') registrarHeartbeatFirebase();
    }
    mergeSalesIntoCache(saved, false);
    return saved;
  };
  window.subirVentasImportadasAFirebase = subirVentasImportadasAFirebase;

  const reconstruirResumenesHistoricos = async function reconstruirResumenesHistoricos() {
    if (!verificarAcceso(['admin'])) return;
    if (!online()) return alert('Se necesita conexión con Firebase para crear los resúmenes.');
    if (!confirm('Esta tarea leerá las ventas históricas por bloques y creará documentos de resumen. Solo debe ejecutarse una vez para migrar los registros antiguos. ¿Continuar?')) return;
    const status = document.getElementById('estadoImportacionVentasExcel');
    const setStatus = text => { if (status) status.textContent = text; };
    const daily = new Map();
    const weekly = new Map();
    const monthly = new Map();
    let cursor = null;
    let read = 0;
    try {
      do {
        let query = firestoreDb.collection('ventas').orderBy('fechaISO', 'desc');
        if (cursor) query = query.startAfter(cursor);
        const snapshot = await query.limit(EXPORT_BATCH_SIZE).get();
        snapshot.docs.forEach(doc => {
          const sale = normalizeSale(doc);
          const day = String(sale.diaClave || dayKey(new Date(sale.fechaISO || Date.now())));
          const week = weekKey(new Date(`${day}T12:00:00-05:00`));
          const month = day.slice(0, 7);
          const contribution = compactSaleContribution(sale);
          if (!daily.has(day)) daily.set(day, {});
          if (!weekly.has(week)) weekly.set(week, {});
          if (!monthly.has(month)) monthly.set(month, {});
          addContribution(daily.get(day), contribution);
          addContribution(weekly.get(week), contribution);
          addContribution(monthly.get(month), contribution);
        });
        read += snapshot.size;
        setStatus(`Construyendo resúmenes: ${read.toLocaleString('es-CO')} ventas leídas...`);
        cursor = snapshot.docs.at(-1) || null;
        if (snapshot.size < EXPORT_BATCH_SIZE || read >= MAX_EXPORT_DOCS) break;
      } while (cursor);

      const timestamp = firebase.firestore.FieldValue.serverTimestamp();
      const writes = [];
      for (const [collection, map] of [['resumenVentasDiario', daily], ['resumenVentasSemanal', weekly], ['resumenVentasMensual', monthly]]) {
        for (const [period, totals] of map) {
          writes.push({ collection, period, data: { periodo: period, ...totals, schemaVersion: 1, actualizadoServidor: timestamp, actualizadoPor: usuarioActual || '', actualizadoUid: firebaseAuth?.currentUser?.uid || '' } });
        }
      }
      for (let offset = 0; offset < writes.length; offset += 400) {
        const batch = firestoreDb.batch();
        writes.slice(offset, offset + 400).forEach(item => batch.set(firestoreDb.collection(item.collection).doc(item.period), item.data, { merge: false }));
        await batch.commit();
        setStatus(`Guardando resúmenes: ${Math.min(offset + 400, writes.length)} de ${writes.length}...`);
      }
      setStatus(`Resúmenes creados: ${daily.size} días, ${weekly.size} semanas y ${monthly.size} meses, a partir de ${read.toLocaleString('es-CO')} ventas.`);
      await actualizarHistoricos();
    } catch (error) {
      console.error('No se pudieron reconstruir los resúmenes:', error);
      setStatus(`Error al crear resúmenes: ${error?.message || error}`);
      alert('No se pudieron crear los resúmenes históricos. Revisa permisos e índices.');
    }
  };
  window.reconstruirResumenesHistoricos = reconstruirResumenesHistoricos;

  async function fetchAllForDay(day, domicileOnly = false) {
    if (!online()) return [];
    const range = dayRange(day);
    const result = [];
    let cursor = null;
    while (result.length < MAX_EXPORT_DOCS) {
      let query = firestoreDb.collection('ventas')
        .where('fechaISO', '>=', range.start)
        .where('fechaISO', '<=', range.end);
      if (domicileOnly) query = query.where('tipoPedido', '==', 'Domicilio');
      query = query.orderBy('fechaISO', 'desc');
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.limit(EXPORT_BATCH_SIZE).get();
      result.push(...snapshot.docs.map(normalizeSale));
      if (snapshot.size < EXPORT_BATCH_SIZE) break;
      cursor = snapshot.docs.at(-1);
    }
    return result;
  }

  exportarVentasDelDiaHistorico = async function() {
    if (!verificarAcceso(['admin', 'administrador'])) return;
    const day = document.getElementById('filtroHistoricoFecha')?.value || dayKey();
    const sales = await fetchAllForDay(day, false);
    if (!sales.length) return alert('No hay ventas registradas para la fecha seleccionada.');
    if (baseExportarVentasDia) await baseExportarVentasDia(sales, `Ventas_${day}.xlsx`, `Ventas ${day}`);
  };
  window.exportarVentasDelDiaHistorico = exportarVentasDelDiaHistorico;

  exportarDomiciliosDelDia = async function() {
    if (!verificarAcceso(['admin', 'administrador'])) return;
    const day = document.getElementById('filtroDomiciliosFecha')?.value || dayKey();
    const sales = await fetchAllForDay(day, true);
    if (!sales.length) return alert('No hay domicilios para la fecha seleccionada.');
    if (baseExportarVentasDia) return baseExportarVentasDia(sales, `Domicilios_${day}.xlsx`, `Domicilios ${day}`);
  };
  window.exportarDomiciliosDelDia = exportarDomiciliosDelDia;

  exportarVentasExcelConEstilo = async function() {
    const sales = await fetchAllForDay(dayKey(), false);
    mergeSalesIntoCache(sales, false);
    if (baseExportarVentasExcel) return baseExportarVentasExcel();
  };
  window.exportarVentasExcelConEstilo = exportarVentasExcelConEstilo;

  generarResumenProductos = async function() {
    const sales = await fetchAllForDay(dayKey(), false);
    mergeSalesIntoCache(sales, false);
    if (baseGenerarResumenProductos) return baseGenerarResumenProductos();
  };
  window.generarResumenProductos = generarResumenProductos;

  async function fetchWholeCollection(collectionName, orderField, useDocumentId = false) {
    const result = [];
    let cursor = null;
    while (result.length < 50000) {
      const field = useDocumentId ? firebase.firestore.FieldPath.documentId() : orderField;
      let query = firestoreDb.collection(collectionName).orderBy(field, 'desc');
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.limit(EXPORT_BATCH_SIZE).get();
      result.push(...snapshot.docs.map(doc => ({ _docId: doc.id, ...doc.data() })));
      if (snapshot.size < EXPORT_BATCH_SIZE) break;
      cursor = snapshot.docs.at(-1);
    }
    return result;
  }

  exportarRespaldoSistema = async function() {
    if (!verificarAcceso(['admin'])) return;
    if (!online()) return alert('Se necesita conexión para crear un respaldo completo.');
    if (!confirm('El respaldo completo consultará todas las colecciones por bloques. ¿Continuar?')) return;
    notify('Creando respaldo completo por bloques...', 'info');
    const [sales, cash, inventory, catalogSnapshot] = await Promise.all([
      fetchWholeCollection('ventas', 'fechaISO', false),
      fetchWholeCollection('controlCaja', null, true),
      fetchWholeCollection(INVENTARIO_COLLECTION, null, true),
      firestoreDb.collection(CATALOGO_FIRESTORE_COLLECTION).doc(CATALOGO_FIRESTORE_DOC_ID).get()
    ]);
    const backup = {
      tipo: 'senor_arepa_respaldo',
      version: VERSION,
      generadoEn: new Date().toISOString(),
      generadoPor: usuarioActual || '',
      proyectoFirebase: firebaseConfig.projectId,
      ventas: sales.map(normalizeSale),
      controlCaja: Object.fromEntries(cash.map(item => [item.diaClave || item._docId, item])),
      catalogo: catalogSnapshot.exists ? catalogSnapshot.data() : {},
      inventario: inventory,
      operacionesPendientes: typeof obtenerVentasPendientesSync === 'function' ? obtenerVentasPendientesSync() : []
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Respaldo_Señor_Arepa_${dayKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    if (typeof registrarAuditoria === 'function') await registrarAuditoria('exportar_respaldo', 'sistema', 'respaldo', { ventas: sales.length, cajas: cash.length, inventario: inventory.length });
  };
  window.exportarRespaldoSistema = exportarRespaldoSistema;

  escucharInventarioFirestore = function() {
    if (!online()) return;
    if (typeof inventarioUnsubscribe === 'function') inventarioUnsubscribe();
    inventarioUnsubscribe = firestoreDb.collection(INVENTARIO_COLLECTION)
      .limit(INVENTORY_LIMIT)
      .onSnapshot(snapshot => {
        if (typeof registrarHeartbeatFirebase === 'function') registrarHeartbeatFirebase();
        const rows = snapshot.docs.map(doc => ({ _docId: doc.id, ...doc.data() }));
        if (typeof guardarLocalStorageSeguro === 'function') guardarLocalStorageSeguro(INVENTARIO_STORAGE_KEY, rows, { critico: false });
        else localStorage.setItem(INVENTARIO_STORAGE_KEY, JSON.stringify(rows));
        if (typeof obtenerMapaInventarioDesdeArray === 'function') inventarioBebidasEstado = obtenerMapaInventarioDesdeArray(rows);
        if (typeof actualizarAlertasStockBebidas === 'function') actualizarAlertasStockBebidas(inventarioBebidasEstado);
      }, error => console.error('No se pudo cargar el inventario mínimo:', error));
  };
  window.escucharInventarioFirestore = escucharInventarioFirestore;

  refrescarVistasAnaliticasSiEstanAbiertas = function() {
    // No se relanzan consultas históricas después de cada cambio. El usuario usa Actualizar o la paginación.
    const historyOpen = document.getElementById('historicosVista') && !document.getElementById('historicosVista').classList.contains('hidden');
    const deliveryOpen = document.getElementById('domiciliosVista') && !document.getElementById('domiciliosVista').classList.contains('hidden');
    if (historyOpen || deliveryOpen) notify('Hay cambios nuevos. Pulsa “Actualizar” para consultar los resúmenes.', 'info');
  };
  window.refrescarVistasAnaliticasSiEstanAbiertas = refrescarVistasAnaliticasSiEstanAbiertas;

  function init() {
    document.documentElement.dataset.consultasEficientes = VERSION;
    window.SENOR_AREPA_CONSULTAS_EFICIENTES = Object.freeze({
      version: VERSION,
      pageSize: PAGE_SIZE,
      initialSalesReads: PAGE_SIZE,
      serverPagination: true,
      aggregateSummaries: true,
      automaticFullHistoryReads: false,
      automaticInventoryMigrationReads: false
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
