(() => {
  'use strict';

  const F5_VERSION = '2026.08.03-C9.4';
  let f5BusyCount = 0;
  let f5VistaTimer = 0;

  function f5AsegurarInfraestructura() {
    if (!document.getElementById('saGlobalProgress')) {
      const progress = document.createElement('div');
      progress.id = 'saGlobalProgress';
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', 'Operación en curso');
      document.body.appendChild(progress);
    }
    if (!document.getElementById('saToastRegion')) {
      const region = document.createElement('div');
      region.id = 'saToastRegion';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'false');
      document.body.appendChild(region);
    }
    if (!document.getElementById('saAnnouncer')) {
      const announcer = document.createElement('div');
      announcer.id = 'saAnnouncer';
      announcer.className = 'sa-sr-only';
      announcer.setAttribute('aria-live', 'polite');
      announcer.setAttribute('aria-atomic', 'true');
      document.body.appendChild(announcer);
    }
  }

  function notificarSistema(mensaje, tipo = 'info', duracion = 3200) {
    f5AsegurarInfraestructura();
    const texto = String(mensaje || '').trim();
    if (!texto) return;
    const toast = document.createElement('div');
    toast.className = 'sa-toast';
    toast.dataset.type = ['success','warning','error','info'].includes(tipo) ? tipo : 'info';
    toast.textContent = texto;
    document.getElementById('saToastRegion')?.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('sa-visible'));
    const announcer = document.getElementById('saAnnouncer');
    if (announcer) announcer.textContent = texto;
    setTimeout(() => {
      toast.classList.remove('sa-visible');
      setTimeout(() => toast.remove(), 220);
    }, Math.max(1400, Number(duracion || 0)));
  }
  window.notificarSistema = notificarSistema;

  function f5SetBusy(activo, etiqueta = '') {
    f5BusyCount = Math.max(0, f5BusyCount + (activo ? 1 : -1));
    document.body.classList.toggle('sa-busy', f5BusyCount > 0);
    document.body.setAttribute('aria-busy', f5BusyCount > 0 ? 'true' : 'false');
    const progress = document.getElementById('saGlobalProgress');
    if (progress && etiqueta) progress.setAttribute('aria-label', etiqueta);
  }
  window.saSetBusy = f5SetBusy;

  async function f5EjecutarConEstado(fn, etiqueta = 'Procesando...') {
    f5SetBusy(true, etiqueta);
    try { return await fn(); }
    finally { f5SetBusy(false); }
  }
  window.saEjecutarConEstado = f5EjecutarConEstado;

  function f5ElementoVisible(id) {
    const el = document.getElementById(id);
    return Boolean(el && !el.classList.contains('hidden') && el.getClientRects().length);
  }

  function f5ActualizarClasesVista() {
    window.clearTimeout(f5VistaTimer);
    f5VistaTimer = window.setTimeout(() => {
      const sesion = Boolean(typeof sesionActiva !== 'undefined' && sesionActiva && typeof tieneRolValido === 'function' && tieneRolValido());
      const posVisible = sesion && f5ElementoVisible('appMain');
      document.body.classList.toggle('sa-session-active', sesion);
      document.body.classList.toggle('sa-pos-visible', posVisible);
      document.body.classList.toggle('sa-report-view', sesion && !posVisible);
      const barra = document.getElementById('mobileQuickBar');
      if (barra) {
        const mostrar = sesion && posVisible && window.innerWidth < 768;
        barra.classList.toggle('hidden', !mostrar);
        barra.setAttribute('aria-hidden', mostrar ? 'false' : 'true');
      }
    }, 0);
  }
  window.saActualizarClasesVista = f5ActualizarClasesVista;

  function f5AplicarPermisosARIA() {
    const reglas = [
      ['admin-only', typeof window.esAdmin === 'function' && window.esAdmin()],
      ['gestion-only', typeof window.tieneAccesoGestion === 'function' && window.tieneAccesoGestion()],
      ['finanzas-only', typeof window.puedeVerFinanzas === 'function' && window.puedeVerFinanzas()]
    ];
    reglas.forEach(([rol, permitido]) => {
      document.querySelectorAll(`[data-role="${rol}"]`).forEach(el => {
        el.setAttribute('aria-hidden', permitido ? 'false' : 'true');
        if ('disabled' in el) el.disabled = !permitido;
        if (!permitido) el.setAttribute('tabindex', '-1');
        else if (el.getAttribute('tabindex') === '-1') el.removeAttribute('tabindex');
      });
    });
  }

  function f5MejorarTablas() {
    document.querySelectorAll('table').forEach((table, indice) => {
      const padre = table.parentElement;
      if (!padre) return;
      if (!padre.classList.contains('sa-table-scroll') && /(overflow-x-auto|overflow-auto)/.test(padre.className)) {
        padre.classList.add('sa-table-scroll');
      }
      if (!table.getAttribute('aria-label')) {
        const titulo = table.closest('section, main, div')?.querySelector('h2,h3,h4')?.textContent?.trim();
        table.setAttribute('aria-label', titulo || `Tabla de datos ${indice + 1}`);
      }
      table.querySelectorAll('thead th').forEach(th => th.setAttribute('scope', 'col'));
    });
  }

  function f5MejorarControles() {
    const etiquetas = new Map([
      ['mobileMenuButton', 'Abrir menú principal'],
      ['mobileMenuHeaderClose', 'Cerrar menú principal'],
      ['btnPrevVentas', 'Página anterior de ventas'],
      ['btnNextVentas', 'Página siguiente de ventas'],
      ['btnPrevHistoricoDetalle', 'Página anterior del histórico'],
      ['btnNextHistoricoDetalle', 'Página siguiente del histórico'],
      ['btnPrevDomiciliosDetalle', 'Página anterior de domicilios'],
      ['btnNextDomiciliosDetalle', 'Página siguiente de domicilios']
    ]);
    etiquetas.forEach((label, id) => {
      const el = document.getElementById(id);
      if (el && !el.getAttribute('aria-label')) el.setAttribute('aria-label', label);
    });
    document.querySelectorAll('input, select, textarea').forEach(el => {
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return;
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const placeholder = el.getAttribute('placeholder');
      if (!label && placeholder) el.setAttribute('aria-label', placeholder);
    });
    ['firebaseStatusText','firebaseStatusSubtext','syncQueueStatus','catalogoSyncStatus'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.setAttribute('aria-live', 'polite');
    });
  }

  function f5OptimizarImagenes() {
    document.querySelectorAll('img').forEach((img, index) => {
      img.decoding = 'async';
      if (index > 0) img.loading = 'lazy';
    });
  }

  function f5InstalarObservador() {
    const ids = ['appContent','appMain','cajaVista','historicosVista','domiciliosVista','mobileHeaderMenu'];
    const observer = new MutationObserver(() => f5ActualizarClasesVista());
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { attributes: true, attributeFilter: ['class','style'] });
    });
    window.addEventListener('resize', f5ActualizarClasesVista, { passive: true });
    window.addEventListener('orientationchange', f5ActualizarClasesVista, { passive: true });
  }

  function f5AtajosTeclado(event) {
    if (typeof sesionActiva === 'undefined' || !sesionActiva || event.defaultPrevented) return;
    const tag = String(event.target?.tagName || '').toLowerCase();
    const escribiendo = ['input','textarea','select'].includes(tag) || event.target?.isContentEditable;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !escribiendo) {
      event.preventDefault();
      if (typeof window.guardarVenta === 'function' && f5ElementoVisible('appMain')) window.guardarVenta();
    }
    if (event.key === 'Escape') {
      if (typeof window.cerrarMobileMenu === 'function') window.cerrarMobileMenu();
    }
  }

  function f5EnvolverFuncion(nombre, etiqueta, mensajeExito = '') {
    const original = window[nombre];
    if (typeof original !== 'function' || original.__saF5Wrapped) return;
    const envuelta = async function(...args) {
      return f5EjecutarConEstado(async () => {
        const resultado = await original.apply(this, args);
        if (mensajeExito && resultado !== false) notificarSistema(mensajeExito, 'success');
        return resultado;
      }, etiqueta);
    };
    envuelta.__saF5Wrapped = true;
    window[nombre] = envuelta;
  }

  function f5ConectarEstadosOperativos() {
    // Solo funciones explícitamente iniciadas por el usuario. No se envuelven renderizados ni listeners.
    f5EnvolverFuncion('exportarVentasFiltradasExcel', 'Preparando Excel...');
    f5EnvolverFuncion('exportarDomiciliosFiltradosExcel', 'Preparando domicilios...');
    f5EnvolverFuncion('exportarRespaldoSistema', 'Preparando respaldo...');
  }

  function f5ActualizarBadge() {
    const badge = document.getElementById('versionPruebasBadge');
    if (badge) badge.textContent = `PRUEBAS · v${F5_VERSION}`;
    document.documentElement.dataset.senorArepaVersion = F5_VERSION;
  }

  function f5Inicializar() {
    f5AsegurarInfraestructura();
    f5ActualizarBadge();
    f5MejorarTablas();
    f5MejorarControles();
    f5OptimizarImagenes();
    f5InstalarObservador();
    f5ConectarEstadosOperativos();
    f5AplicarPermisosARIA();
    f5ActualizarClasesVista();
    document.addEventListener('keydown', f5AtajosTeclado);

    // Reaplica accesibilidad cuando cambie el rol o se rendericen tablas nuevas.
    const basePermisos = window.aplicarPermisosPorRol;
    if (typeof basePermisos === 'function' && !basePermisos.__saF5Wrapped) {
      const permisosF5 = function(...args) {
        const resultado = basePermisos.apply(this, args);
        f5AplicarPermisosARIA();
        f5ActualizarClasesVista();
        return resultado;
      };
      permisosF5.__saF5Wrapped = true;
      window.aplicarPermisosPorRol = permisosF5;
    }

    const renderObserver = new MutationObserver(() => {
      f5MejorarTablas();
      f5MejorarControles();
    });
    ['ventasSeccion','historicosVista','domiciliosVista','cajaVista'].forEach(id => {
      const el = document.getElementById(id);
      if (el) renderObserver.observe(el, { childList: true, subtree: true });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', f5Inicializar, { once: true });
  else f5Inicializar();

  window.SENOR_AREPA_FASE5 = Object.freeze({ version: F5_VERSION });
})();
