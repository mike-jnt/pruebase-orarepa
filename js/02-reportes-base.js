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
    if (typeof guardarLocalStorageSeguro === 'function') guardarLocalStorageSeguro(key, siguiente, { critico: false });
    else localStorage.setItem(key, JSON.stringify(siguiente));
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
    const totalCobrado = redondearPago(Number(v.totalCobrado || 0) || (subtotalProductos + costoDomicilio));
    const detallePagos = normalizarDetallePagos(v.detallePagos || v.pagos || [], totalCobrado);
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
      totalCobrado,
      detallePagos: detallePagos.length ? detallePagos : crearDetallePagoSimple(v.formaPago, totalCobrado),
      total: subtotalProductos
    };
  }

  function obtenerVentasNormalizadas() {
    const ventas = obtenerVentasStorage();
    return ventas.map((v, i) => normalizarVenta(v, i));
  }

  function esPagoEfectivo(venta = {}) {
    return obtenerValorPagoPorMedio(venta, 'efectivo') > 0;
  }

  function esPagoTransferencia(venta = {}) {
    return obtenerTotalOtrosMediosVenta(venta) > 0;
  }

  function obtenerEtiquetaPagoDomicilio(venta = {}) {
    const valorTransferencia = obtenerValorDomicilioCubiertoPorTransferencia(venta);
    const valorEfectivo = obtenerValorDomicilioCubiertoPorEfectivo(venta);
    if (valorTransferencia > 0 && valorEfectivo > 0) return 'Mixto';
    if (valorTransferencia > 0) return 'Transferencia';
    if (valorEfectivo > 0) return 'Efectivo';
    return '-';
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

  function renderHistorico(claveTabla, bodyId, filas, etiquetaVacia) {
    const htmlFilas = (filas || []).map(fila => {
      const pedidosTexto = `${fila.ventas}${fila.canceladas ? ` activas / ${fila.canceladas} canceladas` : ''}`;
      const domiciliosTexto = `${fila.domicilios}${fila.domiciliosCancelados ? ` activos / ${fila.domiciliosCancelados} cancelados` : ''}`;
      return `
        <tr>
          <td class="p-2 border">${fila.label}</td>
          <td class="p-2 border">${pedidosTexto}</td>
          <td class="p-2 border">${domiciliosTexto}</td>
          <td class="p-2 border">${formatearDinero(fila.total)}</td>
        </tr>
      `;
    });

    const mapa = {
      historicoDia: {
        infoId: 'infoPaginacionHistoricoDia',
        pageId: 'paginaHistoricoDiaActual',
        prevId: 'btnPrevHistoricoDia',
        nextId: 'btnNextHistoricoDia'
      },
      historicoSemana: {
        infoId: 'infoPaginacionHistoricoSemana',
        pageId: 'paginaHistoricoSemanaActual',
        prevId: 'btnPrevHistoricoSemana',
        nextId: 'btnNextHistoricoSemana'
      },
      historicoMes: {
        infoId: 'infoPaginacionHistoricoMes',
        pageId: 'paginaHistoricoMesActual',
        prevId: 'btnPrevHistoricoMes',
        nextId: 'btnNextHistoricoMes'
      }
    };

    renderFilasPaginadas({
      clave: claveTabla,
      bodyId,
      filas: htmlFilas,
      colspan: 4,
      etiquetaVacia,
      ...mapa[claveTabla]
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
    const resumen = document.getElementById('resumenVentasDiaSeleccionado');
    if (!input || !resumen) return;

    const fechaSeleccionada = input.value || obtenerFechaLocalISO(new Date());
    input.value = fechaSeleccionada;
    if (ultimaFechaHistoricoDetalle !== fechaSeleccionada) {
      ultimaFechaHistoricoDetalle = fechaSeleccionada;
      reiniciarPaginaTabla('historicoDetalle');
    }

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

    const filas = ventas.map(v => {
      const ventaCancelada = esVentaCancelada(v);
      return `
        <tr class="${ventaCancelada ? 'bg-red-50 text-gray-500' : ''}">
          <td class="p-2 border">${v.recibo ?? '-'}</td>
          <td class="p-2 border">${v.comanda ?? '-'}</td>
          <td class="p-2 border">${formatearHoraColombia(v.fechaISO || v.fecha)}</td>
          <td class="p-2 border">${v.cliente || 'N/A'}</td>
          <td class="p-2 border">${obtenerEtiquetaFormaPago(v)}</td>
          <td class="p-2 border">${formatearTipoPedidoVisual(v)}</td>
          <td class="p-2 border">${obtenerBadgeEstadoVenta(v)}</td>
          <td class="p-2 border">${v.observaciones || '-'}</td>
          <td class="p-2 border">${resumirProductosPedido(v.pedido || [])}</td>
          <td class="p-2 border font-semibold ${ventaCancelada ? 'text-red-600' : ''}">${formatearDinero(obtenerIngresoRealVenta(v))}</td>
        </tr>
      `;
    });

    renderFilasPaginadas({
      clave: 'historicoDetalle',
      bodyId: 'ventasDiaDetalleBody',
      filas,
      colspan: 10,
      etiquetaVacia: 'No hay ventas registradas para esta fecha.',
      infoId: 'infoPaginacionHistoricoDetalle',
      pageId: 'paginaHistoricoDetalleActual',
      prevId: 'btnPrevHistoricoDetalle',
      nextId: 'btnNextHistoricoDetalle'
    });
  }

  function actualizarEstadoImportacionVentasExcel(mensaje = "", tipo = "info") {
    const estado = document.getElementById('estadoImportacionVentasExcel');
    if (!estado) return;
    const clases = {
      info: 'mt-3 text-sm rounded-lg border border-blue-100 bg-white/80 px-3 py-2 text-blue-700',
      success: 'mt-3 text-sm rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-green-700',
      warning: 'mt-3 text-sm rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-yellow-800',
      error: 'mt-3 text-sm rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700'
    };
    estado.className = clases[tipo] || clases.info;
    estado.textContent = mensaje || 'Formato aceptado: #, Fecha, Cliente, Forma de Pago, Tipo de Pedido, Producto, Precio y Total de venta.';
  }

  function abrirSelectorImportacionVentasExcel() {
    if (!verificarAcceso(["admin", "administrador"])) return;
    const input = document.getElementById('archivoImportacionVentasExcel');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function extraerValorCeldaExcelImportacion(celda) {
    const valor = celda?.value;
    if (valor === null || valor === undefined) return '';
    if (valor instanceof Date) return valor;
    if (typeof valor === 'object') {
      if (valor.result !== undefined && valor.result !== null) return valor.result;
      if (valor.text !== undefined && valor.text !== null) return valor.text;
      if (Array.isArray(valor.richText)) return valor.richText.map(item => item.text || '').join('');
      if (valor.hyperlink && valor.text) return valor.text;
    }
    return valor;
  }

  function textoCeldaExcelImportacion(celda) {
    const valor = extraerValorCeldaExcelImportacion(celda);
    if (valor instanceof Date) return valor.toISOString();
    return String(valor ?? '').trim();
  }

  function normalizarTextoImportacion(valor = '') {
    return String(valor || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9#]+/g, ' ')
      .trim();
  }

  function numeroCeldaExcelImportacion(celda) {
    const valor = extraerValorCeldaExcelImportacion(celda);
    if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
    const texto = String(valor ?? '').trim();
    if (!texto) return 0;
    const limpio = texto
      .replace(/\s/g, '')
      .replace(/\$/g, '')
      .replace(/COP/gi, '')
      .replace(/\./g, '')
      .replace(/,/g, '.')
      .replace(/[^\d.-]/g, '');
    const numero = Number(limpio);
    return Number.isFinite(numero) ? numero : 0;
  }

  function crearFechaColombiaImportacion(year, month, day, hour = 0, minute = 0, second = 0) {
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) + 5, Number(minute), Number(second)));
  }

  function convertirFechaExcelImportacion(celda) {
    const valor = extraerValorCeldaExcelImportacion(celda);

    if (valor instanceof Date && !isNaN(valor.getTime())) {
      return crearFechaColombiaImportacion(
        valor.getFullYear(),
        valor.getMonth() + 1,
        valor.getDate(),
        valor.getHours(),
        valor.getMinutes(),
        valor.getSeconds()
      );
    }

    if (typeof valor === 'number' && Number.isFinite(valor)) {
      const totalSegundos = Math.round((valor - 25569) * 86400);
      const fechaSerial = new Date(totalSegundos * 1000);
      if (!isNaN(fechaSerial.getTime())) {
        return crearFechaColombiaImportacion(
          fechaSerial.getUTCFullYear(),
          fechaSerial.getUTCMonth() + 1,
          fechaSerial.getUTCDate(),
          fechaSerial.getUTCHours(),
          fechaSerial.getUTCMinutes(),
          fechaSerial.getUTCSeconds()
        );
      }
    }

    const texto = String(valor ?? '').trim();
    if (!texto) return null;

    const iso = texto.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (iso) {
      return crearFechaColombiaImportacion(
        Number(iso[1]), Number(iso[2]), Number(iso[3]),
        Number(iso[4] || 0), Number(iso[5] || 0), Number(iso[6] || 0)
      );
    }

    const partes = texto.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s*m\.?|am|pm)?)?/i);
    if (partes) {
      let day = Number(partes[1]);
      let month = Number(partes[2]);
      let year = Number(partes[3]);
      let hour = Number(partes[4] || 0);
      const minute = Number(partes[5] || 0);
      const second = Number(partes[6] || 0);
      const meridiano = String(partes[7] || '').toLowerCase().replace(/[.\s]/g, '');
      if (year < 100) year += 2000;
      if (meridiano.includes('p') && hour < 12) hour += 12;
      if (meridiano.includes('a') && hour === 12) hour = 0;
      return crearFechaColombiaImportacion(year, month, day, hour, minute, second);
    }

    const fechaNativa = new Date(texto);
    return isNaN(fechaNativa.getTime()) ? null : fechaNativa;
  }

  function construirMapaColumnasImportacion(worksheet) {
    const mapa = {};
    worksheet.getRow(1).eachCell({ includeEmpty: true }, (celda, colNumber) => {
      const encabezado = normalizarTextoImportacion(textoCeldaExcelImportacion(celda));
      if (!encabezado) return;
      if (encabezado === '#' || encabezado === 'n' || encabezado === 'no' || encabezado.includes('numero')) mapa.numero = colNumber;
      else if (encabezado.includes('fecha')) mapa.fecha = colNumber;
      else if (encabezado.includes('cliente')) mapa.cliente = colNumber;
      else if ((encabezado.includes('forma') && encabezado.includes('pago')) || encabezado === 'pago') mapa.formaPago = colNumber;
      else if (encabezado.includes('tipo') && encabezado.includes('pedido')) mapa.tipoPedido = colNumber;
      else if (encabezado.includes('n domicilio') || (encabezado.includes('numero') && encabezado.includes('domicilio'))) mapa.numeroDomicilio = colNumber;
      else if (encabezado.includes('costo') && encabezado.includes('domicilio')) mapa.costoDomicilio = colNumber;
      else if (encabezado.includes('estado')) mapa.estado = colNumber;
      else if (encabezado.includes('producto') && !encabezado.includes('mas vendido')) mapa.producto = colNumber;
      else if (encabezado.includes('precio')) mapa.precio = colNumber;
      else if (encabezado.includes('total')) mapa.total = colNumber;
    });
    return mapa;
  }

  function validarColumnasImportacion(mapa) {
    const requeridas = [
      ['numero', '#'],
      ['fecha', 'Fecha'],
      ['cliente', 'Cliente'],
      ['formaPago', 'Forma de Pago'],
      ['tipoPedido', 'Tipo de Pedido'],
      ['producto', 'Producto'],
      ['precio', 'Precio (COP)']
    ];
    const faltantes = requeridas.filter(([clave]) => !mapa[clave]).map(([, nombre]) => nombre);
    if (faltantes.length) {
      throw new Error(`El Excel no tiene las columnas requeridas: ${faltantes.join(', ')}.`);
    }
  }

  function normalizarFormaPagoImportada(texto = '') {
    const base = String(texto || '').split('·')[0].trim();
    const normalizado = normalizarTextoImportacion(base);
    if (!normalizado) return 'efectivo';
    if (normalizado.includes('mixto')) return 'mixto';
    const match = MEDIOS_PAGO_DISPONIBLES.find(item => normalizarTextoImportacion(item.value) === normalizado || normalizarTextoImportacion(item.label) === normalizado);
    return match ? match.value : base;
  }

  function normalizarTipoPedidoImportado(texto = '') {
    const original = String(texto || '').trim();
    const normalizado = normalizarTextoImportacion(original);
    if (normalizado.includes('domicilio')) return 'Domicilio';
    if (normalizado.includes('llevar')) return 'Para llevar';
    if (normalizado.includes('aqui')) return 'Aquí';
    return original || 'Aquí';
  }

  function obtenerEstadoImportado(texto = '') {
    const estado = normalizarTextoImportacion(texto);
    return estado.includes('cancel') ? ESTADO_VENTA_CANCELADA : ESTADO_VENTA_ACTIVA;
  }

  function crearDetallePagosImportacion(formaPagoTexto = '', totalCobrado = 0) {
    const formaPago = normalizarFormaPagoImportada(formaPagoTexto);
    const texto = String(formaPagoTexto || '');
    if (formaPago === 'mixto' && texto.includes('·')) {
      const detalleTexto = texto.split('·').slice(1).join('·');
      const detalle = detalleTexto.split('+').map(segmento => {
        const partes = segmento.split(':');
        if (partes.length < 2) return null;
        const medio = normalizarFormaPagoImportada(partes[0]);
        const valor = Number(String(partes.slice(1).join(':')).replace(/\./g, '').replace(/,/g, '.').replace(/[^\d.-]/g, '')) || 0;
        return { medio, valor: redondearPago(valor) };
      }).filter(Boolean);
      const normalizado = normalizarDetallePagos(detalle, totalCobrado);
      if (normalizado.length) return normalizado;
    }
    return crearDetallePagoSimple(formaPago, totalCobrado);
  }

  function extraerFechaBaseDesdeNombreArchivoImportacion(nombreArchivo = '') {
    const texto = String(nombreArchivo || '');
    const matchIso = texto.match(/(20\d{2})[-_. ](\d{1,2})[-_. ](\d{1,2})/);
    if (matchIso) {
      return crearFechaColombiaImportacion(Number(matchIso[1]), Number(matchIso[2]), Number(matchIso[3]));
    }
    const matchCompacto = texto.match(/(20\d{2})(\d{2})(\d{2})/);
    if (matchCompacto) {
      return crearFechaColombiaImportacion(Number(matchCompacto[1]), Number(matchCompacto[2]), Number(matchCompacto[3]));
    }
    return null;
  }

  function obtenerFechaBaseDesdeWorksheetImportacion(worksheet, columnas) {
    const conteoFechas = new Map();
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const fechaObj = convertirFechaExcelImportacion(row.getCell(columnas.fecha));
      if (!fechaObj || isNaN(fechaObj.getTime())) return;
      const diaClave = obtenerFechaLocalISO(fechaObj);
      conteoFechas.set(diaClave, (conteoFechas.get(diaClave) || 0) + 1);
    });

    const fechaMasRepetida = Array.from(conteoFechas.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!fechaMasRepetida) return null;
    const [year, month, day] = fechaMasRepetida.split('-').map(Number);
    return crearFechaColombiaImportacion(year, month, day);
  }

  function combinarFechaBaseConHoraImportacion(fechaBaseObj, fechaConHoraObj) {
    if (!fechaBaseObj || isNaN(fechaBaseObj.getTime())) return fechaConHoraObj;
    const baseColombia = new Date(fechaBaseObj.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    const horaColombia = fechaConHoraObj && !isNaN(fechaConHoraObj.getTime())
      ? new Date(fechaConHoraObj.toLocaleString('en-US', { timeZone: 'America/Bogota' }))
      : new Date(0);

    return crearFechaColombiaImportacion(
      baseColombia.getFullYear(),
      baseColombia.getMonth() + 1,
      baseColombia.getDate(),
      horaColombia.getHours(),
      horaColombia.getMinutes(),
      horaColombia.getSeconds()
    );
  }

  function leerVentasDesdeWorksheetImportacion(worksheet, nombreArchivo = '') {
    const columnas = construirMapaColumnasImportacion(worksheet);
    validarColumnasImportacion(columnas);

    const fechaBaseImportacion = extraerFechaBaseDesdeNombreArchivoImportacion(nombreArchivo) || obtenerFechaBaseDesdeWorksheetImportacion(worksheet, columnas);
    if (!fechaBaseImportacion || isNaN(fechaBaseImportacion.getTime())) {
      throw new Error('No se pudo identificar la fecha base del Excel. Revisa el nombre del archivo o la columna Fecha.');
    }
    const diaBaseImportacion = obtenerFechaLocalISO(fechaBaseImportacion);

    const grupos = new Map();

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;

      const producto = textoCeldaExcelImportacion(row.getCell(columnas.producto));
      const productoNormalizado = normalizarTextoImportacion(producto);
      if (!producto || productoNormalizado.includes('total del dia') || productoNormalizado.includes('total contabilizado') || productoNormalizado.includes('producto mas vendido')) return;

      const fechaOriginalObj = convertirFechaExcelImportacion(row.getCell(columnas.fecha));
      if (!fechaOriginalObj || isNaN(fechaOriginalObj.getTime())) return;
      const fechaObj = combinarFechaBaseConHoraImportacion(fechaBaseImportacion, fechaOriginalObj);

      const numero = Math.trunc(numeroCeldaExcelImportacion(row.getCell(columnas.numero)) || 0);
      const precio = redondearPago(numeroCeldaExcelImportacion(row.getCell(columnas.precio)) || 0);
      if (!numero || precio < 0) return;

      const cliente = textoCeldaExcelImportacion(row.getCell(columnas.cliente)) || 'N/A';
      const formaPagoTexto = textoCeldaExcelImportacion(row.getCell(columnas.formaPago));
      const tipoPedido = normalizarTipoPedidoImportado(textoCeldaExcelImportacion(row.getCell(columnas.tipoPedido)));
      const diaClave = diaBaseImportacion;
      const claveGrupo = `${diaClave}|${numero}|${cliente}|${formaPagoTexto}|${tipoPedido}`;

      if (!grupos.has(claveGrupo)) {
        grupos.set(claveGrupo, {
          numero,
          fechaObj,
          diaClave,
          fechaBaseCorregida: diaBaseImportacion,
          cliente,
          formaPagoTexto,
          tipoPedido,
          numeroDomicilio: columnas.numeroDomicilio ? Math.trunc(numeroCeldaExcelImportacion(row.getCell(columnas.numeroDomicilio)) || 0) : null,
          costoDomicilio: columnas.costoDomicilio ? redondearPago(numeroCeldaExcelImportacion(row.getCell(columnas.costoDomicilio)) || 0) : 0,
          estado: columnas.estado ? obtenerEstadoImportado(textoCeldaExcelImportacion(row.getCell(columnas.estado))) : ESTADO_VENTA_ACTIVA,
          totalExcel: columnas.total ? redondearPago(numeroCeldaExcelImportacion(row.getCell(columnas.total)) || 0) : 0,
          pedido: []
        });
      }

      const grupo = grupos.get(claveGrupo);
      grupo.pedido.push({ nombre: producto, precio });
      if (columnas.total) {
        const totalFila = redondearPago(numeroCeldaExcelImportacion(row.getCell(columnas.total)) || 0);
        if (totalFila > 0) grupo.totalExcel = totalFila;
      }
      if (columnas.estado) {
        const estadoFila = obtenerEstadoImportado(textoCeldaExcelImportacion(row.getCell(columnas.estado)));
        if (estadoFila === ESTADO_VENTA_CANCELADA) grupo.estado = ESTADO_VENTA_CANCELADA;
      }
    });

    return Array.from(grupos.values()).map(grupo => {
      const subtotalProductos = redondearPago(grupo.pedido.reduce((acc, item) => acc + Number(item.precio || 0), 0));
      let costoDomicilio = Number(grupo.costoDomicilio || 0);
      if (!costoDomicilio && grupo.tipoPedido === 'Domicilio' && grupo.totalExcel > subtotalProductos) {
        costoDomicilio = redondearPago(grupo.totalExcel - subtotalProductos);
      }
      const totalCobrado = redondearPago(subtotalProductos + costoDomicilio);
      const formaPago = normalizarFormaPagoImportada(grupo.formaPagoTexto);
      const venta = {
        cliente: grupo.cliente,
        formaPago,
        tipoPedido: grupo.tipoPedido,
        numeroDomicilio: grupo.tipoPedido === 'Domicilio' && Number(grupo.numeroDomicilio || 0) > 0 ? Number(grupo.numeroDomicilio) : null,
        costoDomicilio,
        subtotalProductos,
        observaciones: `Importado desde Excel · fecha corregida a ${grupo.fechaBaseCorregida || grupo.diaClave}`,
        pedido: grupo.pedido,
        detallePagos: crearDetallePagosImportacion(grupo.formaPagoTexto, totalCobrado),
        totalCobrado,
        total: subtotalProductos,
        estado: grupo.estado,
        fechaCancelacion: null,
        canceladaPor: '',
        fecha: formatearFechaHoraColombia(grupo.fechaObj),
        fechaISO: grupo.fechaObj.toISOString(),
        diaClave: grupo.diaClave,
        comanda: grupo.numero,
        recibo: grupo.numero,
        usuario: usuarioActual || '',
        rolUsuario: rolActual || '',
        importadoDesdeExcel: true,
        fechaImportacionISO: new Date().toISOString(),
        usuarioImportacion: usuarioActual || ''
      };
      venta._localId = `import_excel_${venta.diaClave}_${venta.comanda}_${Math.random().toString(36).slice(2, 8)}`;
      return normalizarVenta(venta);
    }).sort((a, b) => {
      const fechaA = new Date(a.fechaISO || a.fecha).getTime() || 0;
      const fechaB = new Date(b.fechaISO || b.fecha).getTime() || 0;
      if (fechaA !== fechaB) return fechaA - fechaB;
      return Number(a.comanda || 0) - Number(b.comanda || 0);
    });
  }

  function obtenerClavesVentasExistentesParaImportacion() {
    const claves = new Set();
    obtenerVentasStorage().forEach(ventaOriginal => {
      const venta = normalizarVenta(ventaOriginal);
      const dia = venta.diaClave || obtenerFechaLocalISO(new Date(venta.fechaISO || venta.fecha || Date.now()));
      if (venta.comanda !== undefined && venta.comanda !== null) claves.add(`${dia}|${venta.comanda}`);
      if (venta.recibo !== undefined && venta.recibo !== null) claves.add(`${dia}|${venta.recibo}`);
    });
    return claves;
  }

  function actualizarNumeracionLocalDesdeVentasImportadas(ventas = []) {
    const dias = new Set((ventas || []).map(venta => venta.diaClave).filter(Boolean));
    dias.forEach(dia => {
      const ventasDia = obtenerVentasStorage().filter(venta => venta.diaClave === dia);
      const maximo = ventasDia.reduce((max, venta) => Math.max(max, Number(venta.comanda || 0), Number(venta.recibo || 0)), 0);
      const key = `numeracionDia_${dia}`;
      const actual = JSON.parse(localStorage.getItem(key) || '{"comanda":0,"recibo":0}');
      if (maximo > Number(actual.comanda || 0) || maximo > Number(actual.recibo || 0)) {
        const numeracionActualizada = {
          comanda: Math.max(maximo, Number(actual.comanda || 0)),
          recibo: Math.max(maximo, Number(actual.recibo || 0))
        };
        if (typeof guardarLocalStorageSeguro === 'function') guardarLocalStorageSeguro(key, numeracionActualizada, { critico: false });
        else localStorage.setItem(key, JSON.stringify(numeracionActualizada));
      }
    });
  }

  async function subirVentasImportadasAFirebase(ventas = []) {
    if (!firestoreDisponible || !firestoreDb) {
      throw new Error('Firebase no está disponible para importar ventas.');
    }
    const guardadas = [];
    const coleccion = firestoreDb.collection('ventas');
    const TAMANO_LOTE = 450;

    for (let i = 0; i < ventas.length; i += TAMANO_LOTE) {
      const loteVentas = ventas.slice(i, i + TAMANO_LOTE);
      const batch = firestoreDb.batch();
      loteVentas.forEach(ventaOriginal => {
        const ref = coleccion.doc();
        const ventaConId = normalizarVenta({ ...ventaOriginal, _docId: ref.id, _syncEstado: 'sincronizado' });
        const limpia = { ...ventaConId };
        delete limpia._docId;
        delete limpia._syncEstado;
        batch.set(ref, limpia);
        guardadas.push(ventaConId);
      });
      await batch.commit();
      registrarHeartbeatFirebase();
    }

    const combinadas = obtenerVentasStorage();
    guardadas.forEach(ventaGuardada => {
      const index = combinadas.findIndex(item =>
        (ventaGuardada._docId && item._docId === ventaGuardada._docId) ||
        (ventaGuardada._localId && item._localId === ventaGuardada._localId)
      );
      if (index >= 0) combinadas[index] = { ...combinadas[index], ...ventaGuardada };
      else combinadas.push(ventaGuardada);
    });
    guardarVentasEnCache(ordenarVentasDesc(combinadas));
    return guardadas;
  }

  async function importarVentasDesdeExcel(event) {
    const input = event?.target;
    const archivo = input?.files?.[0];
    if (!archivo) return;

    if (!verificarAcceso(["admin", "administrador"])) {
      input.value = '';
      return;
    }

    if (!window.ExcelJS) {
      actualizarEstadoImportacionVentasExcel('No se encontró la librería ExcelJS para leer el archivo.', 'error');
      input.value = '';
      return;
    }

    if (!firestoreDisponible || !firestoreDb || !firebaseAuth?.currentUser) {
      actualizarEstadoImportacionVentasExcel('Debes estar conectado a Firebase para importar ventas históricas.', 'error');
      alert('Debes estar conectado a Firebase para importar el Excel.');
      input.value = '';
      return;
    }

    try {
      actualizarEstadoImportacionVentasExcel(`Leyendo archivo: ${archivo.name}...`, 'info');
      const workbook = new ExcelJS.Workbook();
      const buffer = await archivo.arrayBuffer();
      await workbook.xlsx.load(buffer);
      const worksheet = workbook.worksheets[0];
      if (!worksheet) throw new Error('El archivo no tiene hojas disponibles.');

      const ventasLeidas = leerVentasDesdeWorksheetImportacion(worksheet, archivo.name);
      if (!ventasLeidas.length) {
        actualizarEstadoImportacionVentasExcel('No se encontraron ventas válidas para importar.', 'warning');
        alert('No se encontraron ventas válidas para importar.');
        return;
      }

      const clavesExistentes = obtenerClavesVentasExistentesParaImportacion();
      const ventasNuevas = ventasLeidas.filter(venta => !clavesExistentes.has(`${venta.diaClave}|${venta.comanda}`) && !clavesExistentes.has(`${venta.diaClave}|${venta.recibo}`));
      const duplicadas = ventasLeidas.length - ventasNuevas.length;
      const dias = Array.from(new Set(ventasLeidas.map(venta => venta.diaClave))).sort().join(', ');
      const totalProductos = ventasNuevas.reduce((acc, venta) => acc + (venta.pedido || []).length, 0);
      const totalVentas = ventasNuevas.reduce((acc, venta) => acc + obtenerIngresoRealVenta(venta), 0);

      if (!ventasNuevas.length) {
        actualizarEstadoImportacionVentasExcel(`El Excel tiene ${ventasLeidas.length} pedido(s), pero todos ya existen en Firebase/local por fecha y número.`, 'warning');
        alert('No se importó nada porque esas ventas ya existen por fecha y número de pedido.');
        return;
      }

      const mensajeConfirmacion = `Se van a subir ${ventasNuevas.length} pedido(s) a Firebase.\nFecha(s): ${dias}.\nProductos: ${totalProductos}.\nTotal productos: ${formatearDinero(totalVentas)}.\n${duplicadas ? `Se omitirán ${duplicadas} pedido(s) duplicado(s).\n` : ''}\n¿Deseas continuar?`;
      if (!confirm(mensajeConfirmacion)) {
        actualizarEstadoImportacionVentasExcel('Importación cancelada por el usuario.', 'warning');
        return;
      }

      actualizarEstadoImportacionVentasExcel(`Subiendo ${ventasNuevas.length} pedido(s) a Firebase...`, 'info');
      const guardadas = await subirVentasImportadasAFirebase(ventasNuevas);
      actualizarNumeracionLocalDesdeVentasImportadas(guardadas);

      mostrarVentas();
      actualizarHistoricos();
      refrescarVistasAnaliticasSiEstanAbiertas();

      const resumen = `Importación lista: ${guardadas.length} pedido(s) subidos a Firebase. Fecha(s): ${dias}. Total productos: ${formatearDinero(totalVentas)}.${duplicadas ? ` Omitidos por duplicado: ${duplicadas}.` : ''}`;
      actualizarEstadoImportacionVentasExcel(resumen, 'success');
      alert(resumen);
    } catch (error) {
      console.error('Error al importar ventas desde Excel:', error);
      actualizarEstadoImportacionVentasExcel(error?.message || 'No se pudo importar el Excel.', 'error');
      alert(error?.message || 'No se pudo importar el Excel. Revisa el formato.');
    } finally {
      if (input) input.value = '';
    }
  }

  async function exportarVentasDelDiaHistorico() {
    if (!verificarAcceso(["admin", "administrador"])) return;
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

    renderHistorico("historicoDia", "historicoDiaBody", ordenarDesc(diario), "No hay ventas registradas por día.");
    renderHistorico("historicoSemana", "historicoSemanaBody", ordenarDesc(semanal), "No hay ventas registradas por semana.");
    renderHistorico("historicoMes", "historicoMesBody", ordenarDesc(mensual), "No hay ventas registradas por mes.");

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
    const domiciliosTransferencia = domiciliosActivos.filter(v => obtenerValorDomicilioCubiertoPorTransferencia(v) > 0);
    const domiciliosEfectivo = domiciliosActivos.filter(v => obtenerValorDomicilioCubiertoPorEfectivo(v) > 0);

    setText('domHoyCantidad', `${domiciliosHoy.length} domicilio(s)`);
    setText('domHoyValor', formatearDinero(domiciliosHoy.reduce((acc, v) => acc + obtenerValorDomicilio(v), 0)));
    setText('domTransferenciaCantidad', `${domiciliosTransferencia.length} domicilio(s)`);
    setText('domTransferenciaValor', formatearDinero(domiciliosTransferencia.reduce((acc, v) => acc + obtenerValorDomicilioCubiertoPorTransferencia(v), 0)));
    setText('domEfectivoCantidad', `${domiciliosEfectivo.length} domicilio(s)`);
    setText('domEfectivoValor', formatearDinero(domiciliosEfectivo.reduce((acc, v) => acc + obtenerValorDomicilioCubiertoPorEfectivo(v), 0)));

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
      const valorDomicilioTransferencia = obtenerValorDomicilioCubiertoPorTransferencia(v);
      const valorDomicilioEfectivo = obtenerValorDomicilioCubiertoPorEfectivo(v);
      fila.cantidad += 1;
      fila.totalValor += valorDomicilio;
      if (valorDomicilioTransferencia > 0) {
        fila.transferenciaCantidad += 1;
        fila.transferenciaValor += valorDomicilioTransferencia;
      }
      if (valorDomicilioEfectivo > 0) {
        fila.efectivoCantidad += 1;
        fila.efectivoValor += valorDomicilioEfectivo;
      }
    });

    const filasResumenDomicilios = Object.values(resumenPorDia)
      .sort((a, b) => b.fecha.localeCompare(a.fecha))
      .map(fila => `
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
      `);

    renderFilasPaginadas({
      clave: 'domiciliosDia',
      bodyId: 'domiciliosDiaBody',
      filas: filasResumenDomicilios,
      colspan: 8,
      etiquetaVacia: 'No hay domicilios registrados.',
      infoId: 'infoPaginacionDomiciliosDia',
      pageId: 'paginaDomiciliosDiaActual',
      prevId: 'btnPrevDomiciliosDia',
      nextId: 'btnNextDomiciliosDia'
    });

    const filtroFecha = document.getElementById('filtroDomiciliosFecha');
    if (filtroFecha && !filtroFecha.value) {
      filtroFecha.value = hoy;
    }
    verDomiciliosDetalladosPorFecha();
  }

  function verDomiciliosDetalladosPorFecha() {
    const input = document.getElementById('filtroDomiciliosFecha');
    const resumen = document.getElementById('resumenDomiciliosDiaSeleccionado');
    if (!input || !resumen) return;

    const fechaSeleccionada = input.value || obtenerFechaLocalISO(new Date());
    input.value = fechaSeleccionada;
    if (ultimaFechaDomiciliosDetalle !== fechaSeleccionada) {
      ultimaFechaDomiciliosDetalle = fechaSeleccionada;
      reiniciarPaginaTabla('domiciliosDetalle');
    }

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
    const transferencia = activos.filter(v => obtenerValorDomicilioCubiertoPorTransferencia(v) > 0);
    const efectivo = activos.filter(v => obtenerValorDomicilioCubiertoPorEfectivo(v) > 0);
    const valorTransferencia = transferencia.reduce((acc, v) => acc + obtenerValorDomicilioCubiertoPorTransferencia(v), 0);
    const valorEfectivo = efectivo.reduce((acc, v) => acc + obtenerValorDomicilioCubiertoPorEfectivo(v), 0);
    const valorTotalDomicilios = activos.reduce((acc, v) => acc + obtenerValorDomicilio(v), 0);

    resumen.innerHTML = `<strong>Fecha consultada:</strong> ${fechaSeleccionada} &nbsp;|&nbsp; <strong>Domicilios activos:</strong> ${activos.length} &nbsp;|&nbsp; <strong>Transferencia:</strong> ${transferencia.length} (${formatearDinero(valorTransferencia)}) &nbsp;|&nbsp; <strong>Efectivo:</strong> ${efectivo.length} (${formatearDinero(valorEfectivo)}) &nbsp;|&nbsp; <strong>Cancelados:</strong> ${cancelados} &nbsp;|&nbsp; <strong>Total domicilio:</strong> ${formatearDinero(valorTotalDomicilios)}`;

    const filas = domicilios.map(v => {
      const ventaCancelada = esVentaCancelada(v);
      return `
        <tr class="${ventaCancelada ? 'bg-red-50 text-gray-500' : ''}">
          <td class="p-2 border">${v.recibo ?? '-'}</td>
          <td class="p-2 border">${v.comanda ?? '-'}</td>
          <td class="p-2 border">${formatearHoraColombia(v.fechaISO || v.fecha)}</td>
          <td class="p-2 border">${v.cliente || 'N/A'}</td>
          <td class="p-2 border">${obtenerEtiquetaFormaPago(v)}</td>
          <td class="p-2 border">${obtenerEtiquetaPagoDomicilio(v)}</td>
          <td class="p-2 border font-semibold">${formatearDinero(obtenerValorDomicilio(v))}</td>
          <td class="p-2 border">${formatearDinero(obtenerIngresoRealVenta(v))}</td>
          <td class="p-2 border">${obtenerBadgeEstadoVenta(v)}</td>
          <td class="p-2 border">${resumirProductosPedido(v.pedido || [])}</td>
          <td class="p-2 border text-center">${ventaCancelada ? '<span class="text-xs text-red-600 font-semibold">Sin recibo</span>' : `<button onclick="imprimirVentaCliente(${v._index})" class="bg-purple-500 hover:bg-purple-600 text-white px-3 py-1 rounded-lg text-xs font-semibold">Abrir recibo</button>`}</td>
        </tr>
      `;
    });

    renderFilasPaginadas({
      clave: 'domiciliosDetalle',
      bodyId: 'domiciliosDetalleBody',
      filas,
      colspan: 11,
      etiquetaVacia: 'No hay domicilios registrados para esta fecha.',
      infoId: 'infoPaginacionDomiciliosDetalle',
      pageId: 'paginaDomiciliosDetalleActual',
      prevId: 'btnPrevDomiciliosDetalle',
      nextId: 'btnNextDomiciliosDetalle'
    });
  }

  async function abrirDomiciliosVista() {
    if (!verificarAcceso(["admin", "administrador"])) return;
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
  cargarCatalogoProductos();
  aplicarPermisosPorRol();

  const modalEditor = document.getElementById('modalEditorCatalogo');
  if (modalEditor) {
    modalEditor.addEventListener('click', (event) => {
      if (event.target === modalEditor) cerrarEditorCatalogo();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.getElementById('modalEditorCatalogo')?.classList.contains('hidden')) {
      cerrarEditorCatalogo();
    }
  });
});
