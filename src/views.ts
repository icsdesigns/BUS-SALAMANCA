import { getClientHealth, MIN_REQUEST_SPACING_MS } from './services/arrivals'
import {
  nearestStops,
  type BusLeg,
  type Itinerary,
  type NearbyStop,
  type RouteLeg,
} from './services/routing'
import {
  describeStopsAway,
  locateBus,
  ROUTE_SCAN_MAX_MINUTES,
  ROUTE_FIX_MAX_AGE_MS,
  ROUTE_WINDOW_STOPS,
  stopsAwayFrom,
} from './services/bus-position'
import {
  currentDayType,
  estimateArrivalsFromSchedule,
  SCHEDULE_ESTIMATE_ERROR_MINUTES,
} from './services/schedule'
import {
  activeJobCount,
  APP_VERSION,
  AUTO_CYCLE_MS,
  FRESHNESS,
  ARRIVALS_PREVIEW,
  ARRIVALS_STALE_MS,
  favouriteLabel,
  formatMinutesClock,
  isFavourite,
  isWithinWindow,
  MAX_ACTIVE_JOBS,
  MAX_TRACKING_JOBS,
  parseClockToMinutes,
  state,
  TRACKING_INTERVAL_SECONDS,
  type MonitorTrace,
  summariseMonitor,
  trackingBusTarget,
  TRACKING_BUS_TARGET_MAX,
  TRACKING_WARN_MINUTES,
  type InfoSection,
  type MonitorJob,
  type MonitorRow,
  type RoutePoint,
  type SettingsSection,
  type TabId,
  type TrackingJob,
} from './state'
import type {
  Arrival,
  LineDirection,
  NetworkStop,
  ServiceDayType,
  StopFeed,
  TransitLine,
} from './types'
import {
  arrivalTone,
  emptyState,
  esc,
  feedPill,
  formatAge,
  formatClock,
  formatLongDate,
  icon,
  lineChip,
  liveMinutes,
  notice,
  renderEta,
  syncDot,
} from './ui'

/* ------------------------------------------------------------------ *
 * Ayudantes de dominio                                                 *
 * ------------------------------------------------------------------ */

export function stopName(stopId: string): string {
  return state.network?.stopById.get(stopId)?.stopName ?? `Parada ${stopId}`
}

export function lineColor(lineId: string): string {
  return state.network?.getLineColor(lineId) ?? '#173764'
}

export function lineOf(lineId: string): TransitLine | null {
  return state.network?.lineById.get(lineId) ?? null
}

/**
 * La fuente de llegadas solo dice "Línea N", no el sentido. Se resuelve con la
 * red oficial: si por esa parada solo pasa un sentido de la linea, se muestra su
 * destino; si pasan varios, se muestra el nombre de la linea para no inventar.
 */
export function describeArrival(stopId: string, lineId: string): string {
  const network = state.network
  if (!network) {
    return `Línea ${lineId}`
  }

  const directions = network
    .getDirectionsThroughStop(stopId, lineId)
    .filter((direction) => !direction.partial)

  if (directions.length === 1) {
    return `Hacia ${directions[0].destination}`
  }

  const line = network.lineById.get(lineId)
  if (line) {
    return line.title
  }

  return `Línea ${lineId}`
}

function feedOf(stopId: string): StopFeed | undefined {
  return state.feeds[stopId]
}

/**
 * Sentidos entre los que puede venir el autobús de un aviso en esa parada.
 *
 * Con uno solo no hay nada que preguntar. Con varios sí, y hay que preguntarlo:
 * la fuente oficial dice "Línea 4, 7 minutos" y nunca hacia dónde va, así que la
 * única forma de saber por qué recorrido viene es que lo diga quien está
 * esperando —que lo sabe, porque es el autobús que quiere coger—.
 *
 * Los trayectos parciales son variantes del mismo sentido, no otro sentido: si
 * al quitarlos queda uno solo, no hay ambigüedad ninguna.
 */
export function trackingDirectionOptions(stopId: string, lineId: string): LineDirection[] {
  const through = state.network?.getDirectionsThroughStop(stopId, lineId) ?? []

  if (through.length <= 1) {
    return through
  }

  const complete = through.filter((direction) => !direction.partial)
  return complete.length > 0 ? complete : through
}

/* ------------------------------------------------------------------ *
 * Por donde viene el autobus                                           *
 * ------------------------------------------------------------------ */

/**
 * En cual de las paradas de la ventana esta el autobus.
 *
 * La fuente oficial NUNCA dice donde esta un autobus: por cada parada solo
 * publica "linea N, M minutos". Lo unico que delata una presencia es que ese
 * contador caiga a cero o uno, o que la fuente diga "LLEGANDO A PARADA". Asi
 * que se mira eso mismo en las paradas anteriores del recorrido —que vienen ya
 * en el orden real del trayecto— y, dentro del tramo mas avanzado que lo
 * cumpla, se toma su parada MAS LEJANA.
 *
 * El tramo mas avanzado porque los datos de la ventana NO son del mismo
 * instante (se consultan en serie, una cada dos segundos) y puede quedar un
 * "llegando" rezagado varias paradas atras. La mas lejana de ese tramo porque,
 * con paradas seguidas y cercanas, el mismo autobus sale "llegando" en dos o
 * tres a la vez, y la mas avanzada lo adelantaba respecto a donde esta.
 * La regla vive en `locateBus` (services/bus-position.ts).
 *
 * Devuelve el indice dentro de `window`, o -1 si no consta en ninguna.
 *
 * Esta funcion es la que comparten "ver por donde viene" y el aviso de proximo
 * bus. Tenerla una sola vez es lo que impide que las dos pantallas acaben
 * diciendo que el autobus esta en dos sitios distintos.
 */
export function locateBusInWindow(window: NetworkStop[], lineId: string): number {
  return locateBus(
    window.map((stop) => {
      const arrival = feedOf(stop.stopId)
        ?.arrivals.filter((item) => item.lineId === lineId)
        .sort((left, right) => liveMinutes(left) - liveMinutes(right))[0]

      // `liveMinutes` envejece el contador con lo que ha pasado desde que se
      // obtuvo: sin eso, la parada consultada hace catorce segundos seguiria
      // diciendo el numero de hace catorce segundos.
      return arrival ? liveMinutes(arrival) : null
    }),
  )
}

/**
 * El autobus que sigue un aviso: el proximo de la linea o, si hay que dejar
 * pasar uno, el que viene detras. `null` si la fuente no lo publica.
 */
export function trackingArrival(job: TrackingJob): Arrival | null {
  const line = (feedOf(job.stopId)?.arrivals ?? [])
    .filter((item) => item.lineId === job.lineId)
    .sort((left, right) => liveMinutes(left) - liveMinutes(right))
  return line[job.skip] ?? null
}

/** "2º autobús · " mientras el aviso deja pasar el primero; vacío si no. */
function skipLabel(job: TrackingJob): string {
  return job.skip > 0 ? '2º autobús · ' : ''
}

/**
 * A cuantas paradas viene el autobus de un aviso.
 *
 * `null` cuando no se puede afirmar: el aviso no tiene sentido resuelto (por su
 * parada pasa mas de un sentido de la linea), el autobus todavia esta lejos y no
 * se le busca, o simplemente no consta en ninguna de las paradas miradas.
 * Callarse es la respuesta correcta a las tres: un recuento inventado manda a
 * mirar a la calle equivocada.
 */
export function trackingStopsAway(job: TrackingJob): number | null {
  // El que se deja pasar es el más adelantado, y es a ese al que encuentra la
  // búsqueda: contar paradas diría dónde está el autobús que NO se sigue.
  if (job.skip > 0) {
    return null
  }

  // Con la app cerrada quien mira las paradas anteriores es el servicio nativo,
  // así que al volver a abrirla su recuento es más nuevo que cualquier cosa que
  // se pueda deducir aquí. Se descarta en cuanto envejece: un autobús en marcha
  // deja de estar donde estaba, y repetir "a dos paradas" pasado ese tiempo es
  // afirmar algo que ya no consta.
  const fromService = state.trackingStopsAway[job.id]
  if (fromService && Date.now() - fromService.at <= ROUTE_FIX_MAX_AGE_MS) {
    return fromService.stopsAway
  }

  if (!job.directionKey || !state.network) {
    return null
  }

  const window = state.network.getDirectionWindow(
    job.directionKey,
    job.stopId,
    ROUTE_WINDOW_STOPS + 1,
  )

  if (window.length === 0) {
    return null
  }

  return stopsAwayFrom(window.length, locateBusInWindow(window, job.lineId))
}

export { describeStopsAway } from './services/bus-position'

/* ------------------------------------------------------------------ *
 * Cascarón                                                             *
 * ------------------------------------------------------------------ */

interface TabDefinition {
  id: TabId
  label: string
  iconName: string
}

/**
 * Barra inferior. "Mis paradas" ya no es una pestaña propia —vive dentro de
 * Inicio— y Ajustes se abre desde el icono de la barra superior, junto al de
 * actualizar: son dos destinos menos que elegir cada vez que se mira abajo.
 */
const TABS: TabDefinition[] = [
  { id: 'inicio', label: 'Inicio', iconName: 'home' },
  { id: 'buscar', label: 'Buscar', iconName: 'search' },
  { id: 'seguimiento', label: 'Seguir', iconName: 'route' },
  { id: 'monitor', label: 'Puntualidad', iconName: 'chart' },
  { id: 'info', label: 'Info', iconName: 'info' },
]

/**
 * Pestañas que se ven ahora mismo.
 *
 * "Info" está SIEMPRE, al contrario que la antigua "Mapas": recoge los horarios
 * oficiales de cada línea, que salen del GTFS que ya viaja dentro de la app y no
 * dependen de nada experimental. Lo que sigue detrás del interruptor de Ajustes
 * es su apartado "Cómo llegar" —el planificador de rutas—, y se anuncia DENTRO
 * de la pestaña en vez de hacer desaparecer la pestaña entera: quien viene a
 * mirar un horario no tiene por qué enterarse de que existe un experimento.
 */
function visibleTabs(): TabDefinition[] {
  return TABS
}

/** Ajustes no esta en la barra, pero su pantalla tambien necesita titulo. */
const TAB_TITLES: Record<TabId, string> = {
  inicio: 'Inicio',
  buscar: 'Buscar',
  seguimiento: 'Seguir',
  monitor: 'Puntualidad',
  info: 'Info',
  ajustes: 'Ajustes',
}

export function renderApp(): string {
  return `
    <div class="app-shell">
      ${renderTopbar()}
      <main class="screen" id="screen">${renderScreen()}</main>
      ${renderTabbar()}
    </div>
    ${renderSheet()}
    ${renderTour()}
    ${renderStopDialog()}
    ${renderUpdateDialog()}
    ${renderToast()}
  `
}

function renderTopbar(): string {
  const health = getClientHealth()
  const busy = state.refreshing || health.queued > 0

  const subtitle = state.refreshQueueLabel
    ?? (state.lastRefreshAt ? `Actualizado ${formatAge(state.lastRefreshAt)}` : 'Sin datos todavía')

  return `
    <header class="topbar">
      <div class="topbar-mark"><img src="/favicon.svg" alt="" /></div>
      <div class="topbar-copy">
        <h1 class="topbar-title">${esc(TAB_TITLES[state.tab] ?? 'SALBUS')}</h1>
        <p class="topbar-sub">${esc(subtitle)}</p>
      </div>
      <div class="topbar-actions">
        <button
          class="icon-btn${busy ? ' is-spinning' : ''}"
          type="button"
          data-action="refresh"
          aria-label="Actualizar ahora"
          ${busy ? 'disabled' : ''}
        >${icon('refresh')}</button>
        <button
          class="icon-btn${state.tab === 'ajustes' ? ' is-current' : ''}"
          type="button"
          data-action="tab"
          data-tab="ajustes"
          aria-label="Ajustes"
          ${state.tab === 'ajustes' ? 'aria-current="page"' : ''}
        >${icon('settings')}</button>
      </div>
    </header>
  `
}

function renderTabbar(): string {
  const trackingActive = state.trackings.some((job) => job.active)

  return `
    <nav class="tabbar" aria-label="Secciones">
      ${visibleTabs().map((tab) => {
        const isCurrent = tab.id === state.tab
        const dot = tab.id === 'seguimiento' && trackingActive ? '<span class="tab-dot"></span>' : ''
        return `
          <button
            class="tabbar-item"
            type="button"
            data-action="tab"
            data-tab="${tab.id}"
            ${isCurrent ? 'aria-current="page"' : ''}
          >${icon(tab.iconName)}${dot}<span>${esc(tab.label)}</span></button>
        `
      }).join('')}
    </nav>
  `
}

function renderToast(): string {
  if (!state.toast) {
    return ''
  }

  const toneClass = state.toast.tone === 'error' ? ' is-error' : state.toast.tone === 'success' ? ' is-success' : ''
  return `<div class="toast${toneClass}" role="status">${esc(state.toast.message)}</div>`
}

function renderScreen(): string {
  if (!state.ready) {
    return renderBooting()
  }

  switch (state.tab) {
    case 'inicio':
      return renderInicio()
    case 'buscar':
      return renderBuscar()
    case 'seguimiento':
      return renderSeguimiento()
    case 'monitor':
      return renderMonitor()
    case 'info':
      return renderInfo()
    case 'ajustes':
      return renderAjustes()
    default:
      return renderInicio()
  }
}

/**
 * Aviso de version nueva. Ventana centrada, por encima de todo: es lo primero
 * que hay que decidir al abrir la app. Ensena lo minimo: que la hay, cual es,
 * que va a pasar y los botones. Nada de notas de la version ni tamano del
 * descargable: son datos que nadie lee en un aviso y que solo alargan la
 * decision.
 *
 * «Ahora no» solo vale para esta sesion (`dismissed` no se guarda en disco):
 * mientras la actualizacion siga pendiente, la ventana vuelve en cada arranque.
 */
function renderUpdateDialog(): string {
  const update = state.update
  const active = update.phase === 'available'
    || update.phase === 'downloading'
    || update.phase === 'ready'
    || update.phase === 'installing'
    || (update.phase === 'error' && update.release !== null)

  // El tour manda mientras esta abierto: dos ventanas apiladas no se leen.
  if (!active || update.dismissed || !update.release || !state.ready || state.tour.open) {
    return ''
  }

  const needsPermission = update.phase === 'ready' && !update.canInstall
  /** Una descarga o una instalacion en curso no se dejan cerrar a medias. */
  const busy = update.phase === 'downloading' || update.phase === 'installing'

  return `
    <div class="modal-backdrop"></div>
    <section class="modal" role="dialog" aria-modal="true" aria-label="Hay una versión nueva">
      <div class="update-head">
        ${icon('refresh')}
        <div class="update-copy">
          <strong>Hay una versión nueva</strong>
          <span>SALBUS v${esc(update.release.versionName)} · compilación ${update.release.versionCode}</span>
          <span>Tienes la v${esc(state.installed.versionName)} · compilación ${state.installed.versionCode}</span>
        </div>
        <button class="mini-btn" type="button" data-action="dismiss-update" aria-label="Ahora no" ${
          busy ? 'disabled' : ''
        }>${icon('close')}</button>
      </div>

      ${
        needsPermission
          ? `<p class="update-hint">Android pide tu permiso para instalar aplicaciones fuera de Play Store.
             Se concede una sola vez, desde los ajustes del sistema.</p>`
          : `<p class="update-hint">Al instalar, Android enseña una pantalla de advertencia: pulsa
             <strong>Instalar de todos modos</strong>. Es segura, va firmada con la misma clave.
             Tus paradas, avisos e historial se conservan.</p>`
      }

      ${update.error ? notice('error', update.error) : ''}

      <div class="update-actions">
        ${
          needsPermission
            ? `<button class="btn btn-primary btn-block" type="button" data-action="open-install-settings">
                 Conceder permiso
               </button>`
            : `<button class="btn btn-primary btn-block" type="button" data-action="run-update" ${
                busy ? 'disabled' : ''
              }>${esc(updateButtonLabel())}</button>`
        }
      </div>

      ${
        busy
          ? ''
          : `<button class="btn btn-secondary btn-block" type="button" data-action="dismiss-update">
               Ahora no
             </button>`
      }

      ${
        update.phase === 'downloading'
          ? `<div class="update-bar"><span style="width:${
              update.percent >= 0 ? update.percent : 100
            }%" class="${update.percent < 0 ? 'is-indeterminate' : ''}"></span></div>`
          : ''
      }
    </section>
  `
}

/** El boton principal absorbe el estado en su etiqueta, sin anadir elementos. */
function updateButtonLabel(): string {
  const update = state.update

  switch (update.phase) {
    case 'downloading':
      return update.percent >= 0 ? `Descargando… ${update.percent} %` : 'Descargando…'
    case 'ready':
      return 'Instalar'
    case 'installing':
      return 'Abriendo el instalador…'
    case 'error':
      return 'Reintentar'
    default:
      return 'Actualizar'
  }
}

function renderBooting(): string {
  if (state.bootError) {
    return `
      ${notice('error', state.bootError)}
      <button class="btn btn-primary btn-block" type="button" data-action="retry-boot">Reintentar</button>
    `
  }

  return `
    <p class="text-muted">${esc(state.bootPhase)}</p>
    <div class="skeleton skeleton-row"></div>
    <div class="skeleton skeleton-row"></div>
    <div class="skeleton skeleton-row"></div>
  `
}

/* ================================================================== *
 * 1 · INICIO                                                          *
 * ================================================================== */

/**
 * Inicio absorbe "Mis paradas".
 *
 * Antes la pantalla abria con "Proximos autobuses" —una mezcla de llegadas de
 * todas las paradas guardadas— y las paradas en si vivian en otra pestaña. Eran
 * los mismos datos contados dos veces, y la lista mezclada no dejaba ver a que
 * parada pertenecia cada autobus. Ahora manda la parada: cada una con lo suyo,
 * en el mismo sitio donde se administran.
 */
function renderInicio(): string {
  const now = new Date()
  const favourites = state.favourites

  return `
    <section class="hero">
      <div class="hero-top">
        <div>
          <p class="hero-clock" data-live-clock>${esc(formatClock(now))}</p>
          <p class="hero-date">${esc(formatLongDate(now))}</p>
        </div>
        ${icon('bus')}
      </div>
      <div class="hero-stats">
        <div class="hero-stat"><strong>${favourites.length}</strong><span>Paradas</span></div>
        <div class="hero-stat"><strong>${state.trackings.length}</strong><span>Seguimientos</span></div>
        <div class="hero-stat"><strong>${state.monitors.length}</strong><span>Monitorizaciones</span></div>
      </div>
    </section>

    ${state.trackings
      .filter((job) => job.active)
      .map((job) => renderTrackingBanner(job))
      .join('')}

    ${renderFavourites()}
  `
}

function renderFavourites(): string {
  if (state.favourites.length === 0) {
    return `
      <section class="card"><div class="card-body">
        ${emptyState(
          'star',
          'Todavía no tienes paradas',
          'Guarda las paradas que más uses y las verás aquí con sus tiempos.',
          '<button class="btn btn-primary" type="button" data-action="tab" data-tab="buscar">Buscar una parada</button>',
        )}
      </div></section>
    `
  }

  return `
    <div class="section-head">
      <h2>Mis paradas</h2>
      <button class="btn btn-secondary btn-sm" type="button" data-action="tab" data-tab="buscar">
        ${icon('plus')} Añadir
      </button>
    </div>
    ${state.favourites.map((favourite) => renderFavouriteCard(favourite.stopId)).join('')}
  `
}

/**
 * Un aviso de proximo bus.
 *
 * Lleva interruptor de pausa. Pausar NO es lo mismo que quitar: el aviso se
 * conserva entero —parada, línea, autobuses ya vistos— y vuelve de un toque,
 * mientras que quitarlo obliga a montarlo otra vez desde la parada. Lo que sí
 * desaparece al pausar es la notificación, y por eso desaparece: una
 * notificación persistente que ya no se actualiza es peor que ninguna, porque
 * se queda enseñando una hora que dejó de ser verdad.
 */
function renderTrackingBanner(tracking: TrackingJob): string {
  const arrival = trackingArrival(tracking)
  const target = trackingBusTarget()

  // Con un solo autobus por aviso el contador no dice nada: sobra.
  const progress = skipLabel(tracking) + (target > 1
    ? `Autobús ${Math.min(tracking.busesSeen + 1, target)} de ${target} · `
    : '')

  // Dónde viene el autobús, con la misma detección que dibuja el recorrido.
  // Solo mientras el aviso trabaja: en pausa nadie está mirando las paradas
  // anteriores, así que el número que hubiera es de hace rato.
  const stopsAway = tracking.active ? describeStopsAway(trackingStopsAway(tracking)) : ''

  return `
    <section class="card${tracking.active ? '' : ' is-paused'}" data-key="tracking-${esc(tracking.id)}">
      ${renderTrackingHead(tracking, arrival, progress, stopsAway)}
    </section>
  `
}

/**
 * Cabecera de un aviso: parada, sentido, tiempo que falta y los dos botones.
 *
 * La comparten la tarjeta compacta de Inicio y la completa de Seguir. Inicio es
 * un vistazo —cuánto falta— y no dibuja el recorrido; la pestaña Seguir es donde
 * se va a mirar por dónde viene, y ahí sí.
 */
function renderTrackingHead(
  tracking: TrackingJob,
  arrival: Arrival | null,
  progress: string,
  stopsAway: string,
  /**
   * El subtitulo puede ocupar dos lineas.
   *
   * En la tarjeta completa si, porque ahi sobra sitio y el subtitulo lleva tres
   * cosas —el contador de autobuses, el sentido y por donde viene— que juntas no
   * caben en una linea: se quedaba en "Autobus 1 de 3 · Haci…", que es
   * justamente perder el unico dato que dice hacia donde va. En el vistazo de
   * Inicio no, porque alli lo que manda es que cada aviso ocupe poco.
   */
  wrap = false,
): string {
  return `
    <div class="card-head">
      ${lineChip(tracking.lineId, lineColor(tracking.lineId), 'lg')}
      <div class="card-head-copy">
        <h2 class="card-title">${esc(tracking.stopName)}</h2>
        <p class="card-sub${wrap ? ' is-wrap' : ''}">${esc(
          progress + describeArrival(tracking.stopId, tracking.lineId),
        )}</p>
        ${
          // Por dónde viene va en su propia línea, no pegado al final del
          // sentido. Como cola de un texto que puede ocupar dos líneas, acababa
          // colgando solo en una tercera y a media altura: parecía un cartel
          // suelto en medio de la tarjeta. En su línea se alinea con el título y
          // el sentido, y cada tarjeta lo lleva en el mismo sitio.
          stopsAway ? `<span class="stops-away">${icon('bus')}${esc(stopsAway)}</span>` : ''
        }
      </div>
      <div class="card-actions">
        <div class="arrival-eta">${
          !tracking.active
            ? '<span class="eta-unit">en pausa</span>'
            : arrival
              ? renderEta(arrival)
              : '<span class="eta-unit">buscando…</span>'
        }</div>
        ${renderJobToggle(tracking.id, tracking.active)}
        ${
          /*
           * Una X de cierre, no una campana tachada.
           *
           * La campana tachada se lee como "silenciar", que es justo lo que hace
           * el botón de al lado —el de pausa— y no lo que hace este: este BORRA
           * el seguimiento entero, con su parada, su línea, su sentido y los
           * autobuses ya contados. Dos acciones que no se parecen en nada,
           * pegadas la una a la otra, no pueden dibujarse casi igual.
           */
          ''
        }
        <button class="mini-btn is-danger" type="button" data-action="stop-tracking" data-tracking="${esc(
          tracking.id,
        )}" aria-label="Cerrar el seguimiento">${icon('close')}</button>
      </div>
    </div>
  `
}

/**
 * Un aviso entero, tal y como se ve en la pestaña Seguir.
 *
 * Es la fusión de lo que antes eran dos funciones: el aviso decía cuánto falta y
 * "ver por dónde viene" dibujaba el recorrido. Eran la misma pregunta partida en
 * dos, y encima competían por el único turno disponible en la cola de consultas.
 */
function renderTrackingCard(tracking: TrackingJob): string {
  const arrival = trackingArrival(tracking)
  const target = trackingBusTarget()
  const progress = skipLabel(tracking) + (target > 1
    ? `Autobús ${Math.min(tracking.busesSeen + 1, target)} de ${target} · `
    : '')
  const stopsAway = tracking.active ? describeStopsAway(trackingStopsAway(tracking)) : ''

  return `
    <section class="card${tracking.active ? '' : ' is-paused'}" data-key="tracking-${esc(tracking.id)}">
      ${renderTrackingHead(tracking, arrival, progress, stopsAway, true)}
      <div class="card-body">
        ${
          // En pausa NO se dibuja el recorrido. Un aviso en reposo no consulta,
          // así que la fila de cada parada solo podría enseñar un guion: ocho
          // renglones vacíos que ocupan media pantalla y no dicen nada. Se
          // sustituyen por la única frase que sí informa, que es por qué está
          // vacío y cómo se llena.
          tracking.active
            ? (tracking.skip > 0
                ? '<p class="text-tiny">Sigues al segundo autobús: el que se ve en el recorrido es el primero, que dejarás pasar.</p>'
                : '') + renderTrackingRoute(tracking)
            : '<p class="text-tiny">En pausa: no consulta ni avisa. Reanúdalo para ver por dónde viene; solo un aviso se mantiene actualizado a la vez.</p>'
        }
      </div>
    </section>
  `
}

/**
 * Las paradas anteriores, con el autobús situado en una de ellas.
 *
 * Solo se puede dibujar sabiendo el sentido, porque las paradas anteriores solo
 * existen dentro de un recorrido concreto. Un aviso creado antes de la fusión en
 * una parada por la que la línea pasa en los dos sentidos puede no tenerlo:
 * entonces se dice, en vez de dejar un hueco que parece un fallo.
 */
function renderTrackingRoute(tracking: TrackingJob): string {
  const network = state.network
  if (!network) {
    return ''
  }

  if (!tracking.directionKey) {
    return notice(
      'info',
      'Por esta parada pasa la línea en los dos sentidos y este aviso no fijó ninguno, así que no se puede saber por dónde viene. Vuelve a crearlo para elegir el sentido.',
    )
  }

  const windowStops = network.getDirectionWindow(
    tracking.directionKey,
    tracking.stopId,
    ROUTE_WINDOW_STOPS,
  )

  if (windowStops.length === 0) {
    return notice('warn', 'No se pudo reconstruir el recorrido de esta línea.')
  }

  // Misma regla que usa la notificación para contar paradas: una sola
  // implementación, o la tarjeta y el aviso situarían el autobús en sitios
  // distintos con los mismos datos delante.
  const busIndex = locateBusInWindow(windowStops, tracking.lineId)

  return `
    <div class="timeline">
      ${windowStops
        .map((stop, index) => {
          const feed = feedOf(stop.stopId)
          const arrival = feed?.arrivals
            .filter((item) => item.lineId === tracking.lineId)
            .sort((left, right) => liveMinutes(left) - liveMinutes(right))[0]

          const isTarget = stop.stopId === tracking.stopId
          const isBus = index === busIndex
          const classes = [isTarget ? 'is-target' : '', isBus ? 'is-bus' : ''].filter(Boolean).join(' ')

          // Un hueco en el recorrido puede significar dos cosas MUY distintas, y
          // hasta ahora las dos se pintaban con la misma raya:
          //
          //  - «todavía no se ha mirado esa parada», que es un dato que falta;
          //  - «ya se ha mirado y por ahí no viene ningún autobús de esta línea
          //    ahora mismo», que es una respuesta completa.
          //
          // Confundirlas hace leer un recorrido correcto como una app rota: de
          // noche, o en una línea con poca frecuencia, lo normal es que casi
          // todas las paradas estén miradas y vacías. La raya se queda para eso
          // —hay respuesta, no hay paso— y lo no consultado se marca aparte.
          const consultada = feed !== undefined && feed.status !== 'error'
          const eta = arrival
            ? liveMinutes(arrival) <= 0
              ? 'aquí'
              : `${liveMinutes(arrival)} min`
            : consultada
              ? '—'
              : '·'
          const porQue = arrival
            ? ''
            : consultada
              ? 'Consultada: ahora mismo no consta ningún autobús de esta línea'
              : 'Todavía sin consultar'

          return `
            <div class="timeline-stop ${classes}">
              <div class="timeline-rail"><span class="timeline-dot"></span></div>
              <span class="timeline-name">${esc(stop.stopName)}</span>
              <span class="timeline-eta${arrival ? '' : consultada ? ' is-none' : ' is-pending'}"${
                porQue ? ` title="${esc(porQue)}" aria-label="${esc(porQue)}"` : ''
              }>${esc(eta)}</span>
              ${syncDot(feed, state.stopSync[stop.stopId])}
            </div>
          `
        })
        .join('')}
    </div>
    ${renderSyncLegend()}
  `
}

/**
 * Interruptor de un aviso.
 *
 * Un aviso en reposo no se borra: sigue creado y con su parada, su línea, su
 * sentido y los autobuses ya contados, pero no consulta ni publica
 * notificación. Es lo que permite tener montados el de la ida y el de la vuelta
 * y alternar de un toque sin volver a configurarlos.
 *
 * Solo uno se mantiene actualizado a la vez: reanudar uno pausa automáticamente
 * el otro. No hay nada que elegir ni ningún error que leer, y el botón lo avisa
 * antes de pulsarlo.
 */
function renderJobToggle(id: string, active: boolean): string {
  const swaps = !active && activeJobCount() >= MAX_ACTIVE_JOBS

  return `
    <button
      class="mini-btn${active ? ' is-on' : ''}"
      type="button"
      data-action="toggle-job"
      data-job="${esc(id)}"
      aria-label="${active ? 'Pausar' : 'Reanudar'}"
      title="${swaps ? 'Se pausará el otro aviso: solo uno se mantiene actualizado a la vez' : ''}"
    >${icon(active ? 'pause' : 'play')}</button>
  `
}

/* ================================================================== *
 * 2 · BUSCAR                                                          *
 * ================================================================== */

function renderBuscar(): string {
  const network = state.network
  if (!network) {
    return notice('error', 'La red oficial no está disponible.')
  }

  return `
    <div class="screen-intro">
      <h2>Buscar parada</h2>
      <p>Por su nombre o su línea, por cercanía a donde estás, o señalándola en el mapa.</p>
    </div>

    <div class="segmented" role="tablist">
      ${renderSegment('parada', 'Parada', 'search')}
      ${renderSegment('mapa', 'Mapa', 'map')}
      ${renderSegment('cerca', 'Cerca', 'pin')}
    </div>

    ${state.search.mode === 'parada' ? renderSearchByStop() : ''}
    ${state.search.mode === 'mapa' ? renderSearchByMap() : ''}
    ${state.search.mode === 'cerca' ? renderSearchNearby() : ''}

  `
}

function renderSegment(mode: string, label: string, iconName: string): string {
  return `
    <button
      class="segmented-item"
      type="button"
      role="tab"
      data-action="search-mode"
      data-mode="${mode}"
      aria-selected="${state.search.mode === mode}"
    >${icon(iconName)}<span>${esc(label)}</span></button>
  `
}

/**
 * El buscador de paradas, con el texto y la línea en la MISMA pantalla.
 *
 * Antes eran dos modos separados, "Nombre" y "Línea", y había que decidir cuál
 * antes de escribir nada: quien sabía el nombre no podía acotar por línea, y
 * quien elegía línea se comía el recorrido entero sin poder filtrarlo. Son la
 * misma búsqueda —encontrar una parada— así que ahora es una sola y los dos
 * campos se combinan:
 *
 *  - Solo texto → paradas de toda la red que casan con lo escrito.
 *  - Solo línea (y sentido) → su recorrido, numerado en orden.
 *  - Los dos → ese recorrido, filtrado por el texto y CONSERVANDO el número de
 *    orden real, que es lo que dice si la parada va antes o después.
 */
function renderSearchByStop(): string {
  const network = state.network
  if (!network) {
    return ''
  }

  const query = state.search.query.trim()
  const line = network.lineById.get(state.search.lineId) ?? null
  const direction = line?.directions.find((item) => item.key === state.search.directionKey) ?? null

  return `
    <label class="field">
      <span class="sr-only">Nombre o código de parada</span>
      <input
        class="input"
        id="stop-query"
        type="search"
        inputmode="search"
        placeholder="Ej. Gran Vía, Canalejas, 103…"
        value="${esc(state.search.query)}"
        autocomplete="off"
      />
    </label>

    ${renderLineFilter(line, direction)}
    ${renderSearchResults(query, line, direction)}
  `
}

/**
 * El filtro de línea, plegado mientras no se use.
 *
 * Desplegado siempre eran dos desplegables ocupando sitio por delante de los
 * resultados para la búsqueda más común, que es escribir un nombre. Plegado
 * ocupa una línea y dice en ella qué filtro hay puesto, así que nunca se filtra
 * sin saberlo.
 *
 * Que esté abierto o cerrado lo lleva el estado y no un `<details>` del
 * navegador: el repintado es incremental y quita los atributos que ya no están
 * en el HTML nuevo, así que un `open` puesto por el navegador se perdía en el
 * siguiente latido del reloj y el panel se cerraba solo cada segundo.
 */
function renderLineFilter(line: TransitLine | null, direction: LineDirection | null): string {
  const open = state.search.lineFilterOpen || Boolean(line)
  const summary = direction
    ? `Línea ${line?.lineId ?? ''} · ${directionLabel(direction)}`
    : line
      ? `Línea ${line.lineId} · elige sentido`
      : 'Acotar por línea'

  return `
    <div class="line-filter${open ? ' is-open' : ''}">
      <button class="line-filter-head" type="button" data-action="toggle-line-filter" aria-expanded="${open}">
        ${icon('route')}
        <span class="line-filter-label${line ? ' is-on' : ''}">${esc(summary)}</span>
        ${icon('chevronDown')}
      </button>
      ${
        open
          ? `<div class="line-filter-body">
              ${renderLineSelect()}
              ${renderDirectionSelect()}
              ${
                line
                  ? `<button class="btn btn-secondary btn-sm btn-block" type="button" data-action="clear-line-filter">
                       ${icon('close')} Quitar el filtro de línea
                     </button>`
                  : ''
              }
            </div>`
          : ''
      }
    </div>
  `
}

/** Lo que sale de combinar el texto escrito con la línea y el sentido elegidos. */
function renderSearchResults(
  query: string,
  line: TransitLine | null,
  direction: LineDirection | null,
): string {
  const network = state.network
  if (!network) {
    return ''
  }

  // Con sentido elegido manda el ORDEN del recorrido, y el número de parada se
  // conserva aunque el texto deje huecos: ese "12" es justamente lo que dice si
  // el autobús pasa por ahí antes o después.
  if (direction) {
    const matches = direction.stops
      .map((stop, index) => ({ stop, order: index + 1 }))
      .filter((entry) => stopMatches(entry.stop, query))

    return matches.length === 0
      ? emptyState(
          'search',
          'Sin resultados en este recorrido',
          'Ninguna parada de este sentido casa con lo que has escrito. Prueba con otro texto o quita el filtro de línea.',
        )
      : `<div class="result-list">${matches
          .map((entry) => renderStopResult(entry.stop, entry.order))
          .join('')}</div>`
  }

  // Línea elegida pero sin sentido: valen las paradas de cualquiera de sus
  // sentidos, y sin numerar, porque dos recorridos no comparten un mismo orden.
  if (line) {
    const seen = new Set<string>()
    const stops: NetworkStop[] = []

    for (const item of line.directions) {
      for (const stop of item.stops) {
        if (!seen.has(stop.stopId) && stopMatches(stop, query)) {
          seen.add(stop.stopId)
          stops.push(stop)
        }
      }
    }

    return stops.length === 0
      ? emptyState('search', 'Sin resultados en esta línea', 'Prueba con otro texto o quita el filtro de línea.')
      : `<div class="result-list">${stops.map((stop) => renderStopResult(stop)).join('')}</div>`
  }

  const results = network.findStops(query, 40)

  return results.length === 0
    ? emptyState('search', 'Sin resultados', 'Prueba con otro nombre o con el número de parada.')
    : `<div class="result-list">${results.map((stop) => renderStopResult(stop)).join('')}</div>`
}

/** Sin texto casan todas: entonces el filtro de línea manda por sí solo. */
function stopMatches(stop: NetworkStop, query: string): boolean {
  if (query.length === 0) {
    return true
  }

  const needle = query.toLowerCase()
  return stop.stopId.toLowerCase().includes(needle) || stop.stopName.toLowerCase().includes(needle)
}

/**
 * Paradas cercanas, ya dentro de Buscar y con su mapa.
 *
 * Vivía en la pestaña experimental Mapas, y de allí venía la queja: al tocar
 * una parada, su ficha se abría con los mandos del mapa montados encima
 * —ampliar, centrar, el zoom de Leaflet—, porque flotan sobre el mapa y no
 * sabían nada de la ficha. Eso está arreglado en el propio mapa (ver
 * `.map-shell` en la hoja de estilos: `isolation: isolate`), así que el mapa se
 * conserva aquí, que es donde más dice: una lista de metros no sitúa, y saber
 * si la parada está en tu acera o al otro lado de la avenida sí.
 *
 * Reutiliza el MISMO contenedor y la misma instancia de Leaflet que el modo
 * "Mapa" (`#stop-map`): son dos vistas de la misma pantalla, y dos instancias
 * obligarían a mantener dos encuadres de acuerdo entre sí.
 */
function renderSearchNearby(): string {
  const geo = state.geo

  // Comprobando si la ubicación del teléfono está encendida. Es un paso previo y
  // corto, distinto de localizar: decir aquí "buscando tu ubicación…" prometía
  // una búsqueda que puede no llegar a empezar.
  if (geo.checkingService && !geo.location) {
    return `
      <section class="card"><div class="card-body">
        <div class="skeleton skeleton-row"></div>
        <p class="text-tiny">Comprobando el servicio de ubicación del dispositivo…</p>
      </div></section>
    `
  }

  if (geo.locating && !geo.location) {
    return `
      <section class="card"><div class="card-body">
        <div class="skeleton skeleton-row"></div>
        <div class="skeleton skeleton-row"></div>
        <p class="text-tiny">Buscando tu ubicación…</p>
      </div></section>
    `
  }

  if (!geo.location) {
    return renderLocationPrompt()
  }

  const nearby = nearestStopsForView()

  if (nearby.length === 0) {
    return `
      <section class="card"><div class="card-body">
        ${emptyState(
          'pin',
          'Ninguna parada cerca',
          'No hay paradas de la red a menos de 900 m de donde estás.',
        )}
      </div></section>
    `
  }

  return `
    ${renderMapShell('Paradas más cercanas')}
    <p class="text-tiny">
      Tú eres el punto azul, con su margen de error. Toca una parada del mapa o de
      la lista para ver sus tiempos.
    </p>

    <div class="section-head">
      <h2>Paradas más cercanas</h2>
      <button class="btn btn-secondary btn-sm" type="button" data-action="locate">
        ${icon('crosshair')} ${geo.locating ? 'Localizando…' : 'Actualizar'}
      </button>
    </div>
    <p class="text-tiny">${esc(locationAgeLabel())}</p>

    <div class="result-list">

      ${nearby
        .map((entry, index) => {
          const lines = state.network?.getLinesForStop(entry.stop.stopId) ?? []
          return `
            <button class="result-item" type="button" data-action="select-stop" data-stop="${esc(
              entry.stop.stopId,
            )}" aria-selected="${state.search.selectedStopId === entry.stop.stopId}">
              <span class="nearby-rank">${index + 1}</span>
              <span class="result-copy">
                <span class="result-name">${esc(entry.stop.stopName)}</span>
                <span class="result-meta">${esc(formatMeters(entry.meters))} · ${esc(
                  formatWalk(entry.minutes),
                )} andando · parada ${esc(entry.stop.stopId)}</span>
                <span class="chip-row">
                  ${lines
                    .slice(0, 8)
                    .map((line) => lineChip(line.lineId, line.color, 'sm'))
                    .join('')}
                </span>
              </span>
              ${icon('chevron')}
            </button>
          `
        })
        .join('')}
    </div>
  `
}

/**
 * Qué hacer cuando no hay ubicación.
 *
 * El interruptor de ubicación del teléfono y el permiso de SALBUS son dos cosas
 * distintas que desde aquí se ven igual —no llega la posición— y se arreglan en
 * pantallas distintas del sistema. Decir "activa la ubicación" sin llevar hasta
 * donde se activa deja el problema donde estaba.
 */
function renderLocationPrompt(): string {
  const geo = state.geo
  const blocked = geo.blocked

  // El interruptor de ubicación del teléfono se comprueba ANTES de buscar nada,
  // así que este caso ya no se descubre por un fallo de la búsqueda: se sabe de
  // antemano y se dice de antemano. La búsqueda arranca sola en cuanto se
  // enciende, al volver a la app; el botón de reintentar está por si el sistema
  // tarda en dar el interruptor por encendido.
  if (blocked === 'service') {
    return `
      <section class="card"><div class="card-body">
        ${notice(
          'warn',
          geo.error
            ?? 'La ubicación del teléfono está apagada. Es un interruptor del sistema, no de SALBUS: hasta que se encienda no hay forma de saber qué paradas tienes al lado.',
        )}
        <button class="btn btn-primary btn-block" type="button" data-action="open-location-settings">
          ${icon('pin')} Activar la ubicación del teléfono
        </button>
        <button class="btn btn-secondary btn-block" type="button" data-action="locate">
          ${icon('crosshair')} Ya está activada, buscar paradas
        </button>
        <p class="text-tiny">
          Al volver a SALBUS con la ubicación encendida, la búsqueda empieza sola.
        </p>
      </div></section>
    `
  }

  return `
    <section class="card"><div class="card-body">
      ${
        geo.error
          ? notice('error', geo.error)
          : `<p class="card-sub is-wrap">Para enseñarte las paradas que tienes al lado, la aplicación
               necesita saber dónde estás. La ubicación no sale del teléfono ni se guarda.</p>`
      }
      ${
        blocked === 'permission'
          ? `<button class="btn btn-primary btn-block" type="button" data-action="open-location-settings">
               ${icon('pin')} Abrir los permisos de SALBUS
             </button>
             <button class="btn btn-secondary btn-block" type="button" data-action="locate">
               ${icon('crosshair')} Volver a intentarlo
             </button>`
          : `<button class="btn btn-primary btn-block" type="button" data-action="locate">
               ${icon('crosshair')} Usar mi ubicación
             </button>`
      }
    </div></section>
  `
}

/**
 * Desplegable de línea. Arranca SIEMPRE en "Seleccionar": preseleccionar la
 * primera línea del listado hacía creer que ya se había elegido algo, y en el
 * mapa disparaba la pantalla completa sin que nadie la hubiera pedido.
 */
function renderLineSelect(): string {
  const network = state.network
  if (!network) {
    return ''
  }

  return `
    <label class="field">
      <span>Línea</span>
      <select class="select" data-action="pick-search-line">
        <option value="" ${state.search.lineId ? '' : 'selected'}>Seleccionar</option>
        ${network.lines
          .map(
            (line) =>
              `<option value="${esc(line.lineId)}" ${
                line.lineId === state.search.lineId ? 'selected' : ''
              }>${esc(line.name)}</option>`,
          )
          .join('')}
      </select>
    </label>
  `
}

function renderDirectionSelect(): string {
  const line = state.network?.lineById.get(state.search.lineId) ?? null

  return `
    <label class="field">
      <span>Sentido</span>
      <select class="select" data-action="pick-search-direction" ${line ? '' : 'disabled'}>
        <option value="" ${state.search.directionKey ? '' : 'selected'}>Seleccionar</option>
        ${(line?.directions ?? [])
          .map(
            (item) =>
              `<option value="${esc(item.key)}" ${
                item.key === state.search.directionKey ? 'selected' : ''
              }>${esc(directionLabel(item))}</option>`,
          )
          .join('')}
      </select>
    </label>
  `
}

function renderSearchByMap(): string {
  const network = state.network
  if (!network) {
    return ''
  }

  const direction = network.directionByKey.get(state.search.directionKey) ?? null
  const ready = Boolean(state.search.lineId && state.search.directionKey && direction)
  const expanded = state.search.mapExpanded

  return `
    ${renderLineSelect()}
    ${renderDirectionSelect()}

    ${renderMapShell(direction ? directionLabel(direction) : 'Todas las paradas de la red')}
    <p class="text-tiny">
      ${
        !ready
          ? 'Las paradas de la red van AGRUPADAS: cada círculo dice cuántas hay dentro y se abre al tocarlo o al acercar el mapa. Dibujar las 349 de golpe dejaba el mapa arrastrándose al moverlo.'
          : expanded
            ? 'Toca una parada para ver su ficha; cierra el mapa con la ✕ para volver al buscador.'
            : 'Toca una parada del mapa para ver su ficha, o pulsa “Ampliar” para verlo a pantalla completa.'
      }
    </p>
  `
}

/**
 * El contenedor del mapa es SIEMPRE el mismo nodo, tanto encajado como a
 * pantalla completa: Leaflet vive dentro (`data-morph="skip"`) y moverlo de
 * sitio obligaria a reconstruir el mapa entero en cada cambio.
 */
function renderMapShell(caption: string): string {
  const expanded = state.search.mapExpanded

  return `
    <div class="map-shell${expanded ? ' is-expanded' : ''}${
      state.search.selectedStopId ? ' is-behind-dialog' : ''
    }">
      <div id="stop-map" data-morph="skip"></div>
      <button class="map-locate${state.geo.locating ? ' is-busy' : ''}" type="button"
        data-action="locate" aria-label="Centrar en mi ubicación">${icon('crosshair')}</button>
      ${
        expanded
          ? `
        <div class="map-caption">${esc(caption)}</div>
        <button class="map-close" type="button" data-action="collapse-map" aria-label="Cerrar el mapa">
          ${icon('close')}
        </button>
      `
          : `<button class="map-expand" type="button" data-action="expand-map">${icon(
              'map',
            )} Ampliar</button>`
      }
    </div>
  `
}

export function directionLabel(direction: LineDirection): string {
  if (direction.circular) {
    return `${direction.origin} · circular`
  }

  const suffix = direction.partial ? ' · recorrido parcial' : ''
  return `${direction.origin} → ${direction.destination}${suffix}`
}

function renderStopResult(stop: NetworkStop, order?: number): string {
  const lines = state.network?.getLinesForStop(stop.stopId) ?? []

  return `
    <button
      class="result-item"
      type="button"
      data-action="select-stop"
      data-stop="${esc(stop.stopId)}"
      aria-selected="${state.search.selectedStopId === stop.stopId}"
    >
      <span class="stop-code">${esc(order ? String(order) : stop.stopId)}</span>
      <span class="result-copy">
        <span class="result-name">${esc(stop.stopName)}</span>
        <span class="chip-row">
          ${order ? `<span class="result-meta">Parada ${esc(stop.stopId)}</span>` : ''}
          ${lines
            .slice(0, 7)
            .map((line) => lineChip(line.lineId, line.color, 'sm'))
            .join('')}
          ${lines.length > 7 ? `<span class="result-meta">+${lines.length - 7}</span>` : ''}
        </span>
      </span>
      ${icon('chevron')}
    </button>
  `
}

/**
 * Ficha de la parada tocada en el buscador.
 *
 * Es una ventana y no un bloque al final de la pantalla: encajada abajo quedaba
 * por debajo del listado (y del mapa, que ocupa la pantalla entera), asi que
 * tocar una parada parecia no hacer nada hasta que se bajaba a buscarla.
 */
function renderStopDialog(): string {
  const stopId = state.search.selectedStopId
  if (!stopId || !state.ready) {
    return ''
  }

  const feed = feedOf(stopId)
  const saved = isFavourite(stopId)

  return `
    <button class="modal-backdrop" type="button" data-action="close-stop" aria-label="Cerrar"></button>
    <section class="modal stop-modal" role="dialog" aria-modal="true" aria-label="${esc(stopName(stopId))}">
      <div class="modal-head">
        <span class="stop-code">${esc(stopId)}</span>
        <div class="card-head-copy">
          <h2 class="card-title">${esc(stopName(stopId))}</h2>
          <p class="card-sub">${feedPill(feed)}</p>
        </div>
        <button class="mini-btn" type="button" data-action="close-stop" aria-label="Cerrar">${icon(
          'close',
        )}</button>
      </div>

      ${renderArrivals(stopId, feed)}

      <div class="btn-row">
        <button class="btn ${saved ? 'btn-secondary' : 'btn-primary'}" type="button" data-action="toggle-favourite" data-stop="${esc(
          stopId,
        )}">
          ${icon('star')} ${saved ? 'Quitar' : 'Guardar'}
        </button>
        <button class="btn btn-secondary" type="button" data-action="stop-actions" data-stop="${esc(stopId)}">
          ${icon('bell')} Avisos
        </button>
      </div>
    </section>
  `
}

/* ------------------------------------------------------------------ *
 * Tarjeta de parada guardada (dentro de Inicio)                        *
 * ------------------------------------------------------------------ */

/**
 * Una parada guardada.
 *
 * Plegada tiene que enseñar TODAS las líneas que pasan por ella —son lo que
 * identifica la parada de un vistazo— y todas las tarjetas plegadas tienen que
 * medir lo mismo, o la lista se lee como si estuviera rota. Las dos cosas a la
 * vez no caben en el hueco que dejaba la cabecera: entre el código, el nombre y
 * los tres botones quedaban unos 90 px, y trece distintivos ahí solo podían
 * salir cortados o con barra de desplazamiento.
 *
 * Por eso los distintivos bajan a una FRANJA PROPIA de ancho completo, con
 * hueco fijo para dos filas: entran con sitio de sobra los trece de la parada
 * más concurrida de la red, y una parada de una sola línea ocupa exactamente lo
 * mismo que una de trece.
 *
 * El botón de actualizar solo aparece desplegada: plegada no se enseña ni un
 * tiempo, así que refrescar era pedirle a la fuente —que limita por IP— un dato
 * que nadie iba a ver.
 */
function renderFavouriteCard(stopId: string): string {
  const feed = feedOf(stopId)
  const expanded = state.expandedStopId === stopId
  const label = favouriteLabel(stopId, stopName(stopId))
  const lines = state.network?.getLinesForStop(stopId) ?? []
  const syncing = state.stopSync[stopId] !== undefined
  // El nombre oficial solo aporta algo si la parada se ha renombrado, y como
  // solo hace falta para comprobar CUÁL es, va dentro: en la cabecera obligaba a
  // reservarle sitio en las cinco tarjetas para usarlo en una.
  const official = label === stopName(stopId) ? '' : stopName(stopId)

  return `
    <section class="card stop-card${expanded ? ' is-expanded' : ''}" data-key="stop-${esc(stopId)}">
      <button
        class="stop-open"
        type="button"
        data-action="expand-stop"
        data-stop="${esc(stopId)}"
        aria-expanded="${expanded}"
      >
        <span class="stop-code">${esc(stopId)}</span>
        <span class="stop-name">${esc(label)}</span>
        <span class="stop-chevron">${icon('chevron')}</span>
      </button>

      <div class="stop-meta">
        ${renderStopLines(stopId, lines)}
        <span class="stop-tools">
          <button class="mini-btn" type="button" data-action="rename-stop" data-stop="${esc(
            stopId,
          )}" aria-label="Cambiar nombre">${icon('pencil')}</button>
          <button class="mini-btn is-danger" type="button" data-action="remove-favourite" data-stop="${esc(
            stopId,
          )}" aria-label="Quitar parada">${icon('trash')}</button>
        </span>
      </div>

      ${
        /*
         * El cuerpo se dibuja SIEMPRE, plegado o no, y lo único que cambia al
         * desplegar es una clase.
         *
         * Es lo que quita los parpadeos. Antes el cuerpo se añadía y se quitaba
         * del HTML, así que al plegar desaparecía de golpe —no había nada que
         * animar— y al desplegar aparecía entero de una vez, empujando de un
         * salto todo lo que tenía debajo. Con los nodos ya puestos, la altura la
         * anima el CSS (`grid-template-rows: 0fr → 1fr`) en las dos direcciones
         * y ningún elemento nace ni muere a mitad de la transición.
         *
         * Plegado queda `inert`: fuera del tabulador, fuera del lector de
         * pantalla y sin recibir toques. Sin eso, media pantalla de botones
         * invisibles seguiría siendo alcanzable.
         */ ''
      }
      <div class="stop-body"${expanded ? '' : ' inert'}>
        <div class="stop-body-inner">
          <div class="card-divider"></div>
          <div class="card-body">
            ${official ? `<p class="stop-official">Nombre oficial: ${esc(official)}</p>` : ''}

            <div class="stop-status">
              ${feedPill(feed)}
              <button class="mini-btn${syncing ? ' is-spinning' : ''}" type="button" data-action="refresh-stop" data-stop="${esc(
                stopId,
              )}" aria-label="Actualizar esta parada">${icon('refresh')}</button>
            </div>

            ${renderArrivals(stopId, feed)}

            <button class="btn btn-secondary btn-block" type="button" data-action="stop-actions" data-stop="${esc(stopId)}">
              ${icon('bell')} Avisos y seguimiento
            </button>
          </div>
        </div>
      </div>
    </section>
  `
}

/**
 * Huecos de distintivo que caben en la franja de líneas.
 *
 * Son HUECOS, no distintivos: el "+N" ocupa uno igual que una línea, y contarlo
 * aparte era el fallo. Con doce líneas y un "+1" se pedían trece huecos, y en
 * una pantalla de 320 px solo caben doce: el decimotercero se iba a una tercera
 * fila que la franja —de alto fijo— recortaba en silencio. Justo lo que este
 * número existe para impedir.
 *
 * Doce es lo que entra en las dos filas fijas a 320 px, la pantalla más estrecha
 * que se contempla (a 360 px caben catorce, y sobra sitio). La parada con más
 * líneas de toda la red tiene trece y solo tres pasan de nueve, así que el "+N"
 * aparece en una sola parada de las 349.
 *
 * Y existe igualmente por dos motivos. Uno, que la red se regenera desde la web
 * oficial (`npm run data:network`) y una parada nueva con veinte líneas no puede
 * romper la maquetación. Y dos, que un recorte silencioso —un `overflow: hidden`
 * comiéndose líneas— es peor que un número: quien lo lee da por hecho que ha
 * visto todas las líneas de su parada.
 */
const STOP_LINES_SLOTS = 12

/**
 * La franja de líneas de una parada.
 *
 * Alto FIJO de dos filas, siempre, tenga la parada una línea o trece. Es la
 * mitad de "todas las tarjetas miden lo mismo": con el alto pegado al contenido,
 * la lista de paradas guardadas subía y bajaba de escalón en escalón según
 * cuántas líneas tuviera cada una, y la vista era un serrucho.
 *
 * Y es un alto que NO recorta, que es la otra mitad: doce distintivos entran en
 * esas dos filas, y lo que pasara de ahí se cuenta con un "+N" que lleva en su
 * `title` las líneas que resume.
 *
 * Es un botón, y no un bloque, porque ocupa el ancho entero justo debajo del
 * nombre: tocar ahí y que no pase nada se lee como un fallo. Despliega la
 * parada, igual que la cabecera, y se queda fuera del recorrido del tabulador
 * (`tabindex="-1"`) para no obligar a pasar dos veces por el mismo destino.
 */
function renderStopLines(stopId: string, lines: TransitLine[]): string {
  if (lines.length === 0) {
    return `
      <button class="stop-lines" type="button" data-action="expand-stop" data-stop="${esc(
        stopId,
      )}" tabindex="-1" aria-hidden="true">
        <span class="stop-lines-empty">Sin líneas registradas</span>
      </button>
    `
  }

  // Si sobra una sola línea, el "+1" ocuparía el hueco de esa línea y no se
  // ganaría nada: solo se resume cuando de verdad no caben, y entonces el
  // resumen se queda con el último hueco.
  const fits = lines.length <= STOP_LINES_SLOTS
  const visible = fits ? lines : lines.slice(0, STOP_LINES_SLOTS - 1)
  const hidden = fits ? [] : lines.slice(STOP_LINES_SLOTS - 1)

  return `
    <button class="stop-lines" type="button" data-action="expand-stop" data-stop="${esc(
      stopId,
    )}" tabindex="-1" aria-hidden="true">
      ${visible.map((line) => lineChip(line.lineId, line.color, 'sm')).join('')}
      ${
        hidden.length > 0
          ? `<span class="line-chip is-sm is-more" title="${esc(
              `${hidden.length} línea(s) más: ${hidden.map((line) => line.lineId).join(', ')}`,
            )}">+${hidden.length}</span>`
          : ''
      }
    </button>
  `
}

/* ------------------------------------------------------------------ *
 * Lista de llegadas reutilizable                                       *
 * ------------------------------------------------------------------ */

/**
 * ¿Hay que enseñar que se está trabajando en esta parada?
 *
 * Sí en dos casos, y los dos significan lo mismo para quien mira: lo que hay en
 * pantalla no es lo definitivo.
 *
 *  - La parada está en la cola de consultas (esperando turno o ya pidiendo).
 *    Las consultas van de una en una contra una fuente que admite una cada dos
 *    segundos, así que "esperando turno" puede durar bastante y sin decirlo
 *    parece que la app se ha quedado colgada.
 *  - El dato en pantalla ya tiene más de un minuto. Un tiempo de hace minuto y
 *    medio ya no es el tiempo: toca refresco, y avisarlo antes de que llegue
 *    evita leer como bueno un número que está a punto de cambiar.
 */
function arrivalsBusy(stopId: string, feed: StopFeed | undefined): boolean {
  if (state.stopSync[stopId] !== undefined) {
    return true
  }

  return Boolean(feed) && Date.now() - (feed as StopFeed).fetchedAt >= ARRIVALS_STALE_MS
}

function renderArrivals(stopId: string, feed: StopFeed | undefined): string {
  const busy = arrivalsBusy(stopId, feed)

  if (!feed) {
    return `
      <div class="arrivals-loading" role="status" aria-live="polite">
        <span class="arrivals-loading-bar"></span>
        <div class="skeleton skeleton-row"></div>
        <div class="skeleton skeleton-row"></div>
        <p class="text-tiny">${esc(
          state.stopSync[stopId] === 'queued'
            ? 'Esperando turno en la cola de consultas…'
            : 'Consultando los tiempos de esta parada…',
        )}</p>
      </div>
    `
  }

  if (feed.status === 'error') {
    return `
      ${notice('error', feed.message ?? 'No se pudo consultar la fuente oficial.')}
      ${renderScheduleFallback(stopId)}
    `
  }

  // Saturada y sin ningun dato anterior que enseñar es lo mismo que un fallo:
  // no hay tiempos, y el horario es lo unico que se puede ofrecer.
  if (feed.status === 'throttled' && feed.arrivals.length === 0) {
    return `
      ${notice('warn', feed.message ?? 'La fuente oficial está limitando las consultas.')}
      ${renderScheduleFallback(stopId)}
    `
  }

  if (feed.arrivals.length === 0) {
    return emptyState(
      'clock',
      'Sin autobuses ahora',
      feed.message ?? 'La fuente oficial no devuelve llegadas para esta parada en este momento.',
    )
  }

  const staleClass = feed.status === 'throttled' ? ' stale' : ''

  // Solo las primeras ARRIVALS_PREVIEW, y la vista compacta VUELVE SOLA: hay un
  // único hueco de "desplegada" en todo el estado, así que desplegar una parada
  // no deja desplegadas las que se abran después.
  const expanded = state.arrivalsExpandedStopId === stopId
  const hidden = feed.arrivals.length - ARRIVALS_PREVIEW
  const visible = expanded ? feed.arrivals : feed.arrivals.slice(0, ARRIVALS_PREVIEW)

  return `
    <div class="arrivals${staleClass}${busy ? ' is-busy' : ''}">
      ${busy ? '<span class="arrivals-loading-bar" role="status" aria-label="Actualizando los tiempos"></span>' : ''}
      ${visible.map((arrival) => renderArrivalRow(arrival, stopId, false)).join('')}
    </div>
    ${
      hidden > 0
        ? `<button class="btn btn-secondary btn-block btn-sm" type="button" data-action="${
            expanded ? 'collapse-arrivals' : 'expand-arrivals'
          }" data-stop="${esc(stopId)}">
             ${icon(expanded ? 'up' : 'down')} ${
              expanded ? 'Ver menos' : `Ver más (${hidden})`
            }
           </button>`
        : ''
    }
  `
}

/**
 * Lo que se ofrece cuando no hay tiempos reales: un boton para ver los pasos del
 * horario GTFS y, una vez pulsado, esos pasos marcados como estimados.
 *
 * No se cargan solos. Un horario puede parecer un tiempo real y no lo es —el
 * GTFS incluido es teorico y puede ir varios minutos desviado—, asi que tiene
 * que pedirlo quien mira y leer el aviso. Y tampoco se quedan: en cuanto la
 * fuente vuelve a contestar, `renderArrivals` enseña los datos reales y el
 * resto de la app olvida la peticion (`applyFeed`).
 *
 * Se calculan al dibujar, con el reloj de ese momento, para que la cuenta atras
 * avance sola sin guardar nada.
 */
function renderScheduleFallback(stopId: string): string {
  const schedule = state.schedule
  if (!schedule) {
    return ''
  }

  if (!state.scheduleFallbackStops[stopId]) {
    return `
      <div class="schedule-fallback">
        <button class="btn btn-secondary btn-block btn-sm" type="button" data-action="show-schedule-estimate" data-stop="${esc(
          stopId,
        )}">
          ${icon('clock')} Ver tiempos estimados por horario
        </button>
      </div>
    `
  }

  const lineIds = (state.network?.getLinesForStop(stopId) ?? []).map((line) => line.lineId)
  const estimates = estimateArrivalsFromSchedule(schedule, stopId, lineIds).slice(0, ARRIVALS_PREVIEW * 2)
  const warning = notice(
    'warn',
    `Tiempos estimados por el horario programado (GTFS), no en tiempo real: pueden desviarse ±${SCHEDULE_ESTIMATE_ERROR_MINUTES} min. Se sustituirán solos cuando vuelva la información actualizada.`,
  )

  if (estimates.length === 0) {
    return `
      <div class="schedule-fallback">
        ${warning}
        ${emptyState('clock', 'Sin pasos programados', 'El horario no trae ningún paso por esta parada en la próxima hora y media.')}
      </div>
    `
  }

  return `
    <div class="schedule-fallback">
      ${warning}
      <div class="arrivals is-estimated">
        ${estimates.map((arrival) => renderEstimatedRow(arrival, stopId)).join('')}
      </div>
    </div>
  `
}

function renderEstimatedRow(arrival: Arrival, stopId: string): string {
  return `
    <article class="arrival is-estimated">
      ${lineChip(arrival.lineId, lineColor(arrival.lineId))}
      <div class="arrival-copy">
        <p class="arrival-dest">${esc(lineOf(arrival.lineId)?.title ?? `Línea ${arrival.lineId}`)}</p>
        <p class="arrival-meta">${esc(`${describeArrival(stopId, arrival.lineId)} · horario ${arrival.estimatedClock}`)}</p>
      </div>
      <div class="arrival-eta"><span class="eta-value">≈${arrival.minutesUntil}</span><span class="eta-unit"> min</span></div>
    </article>
  `
}

function renderArrivalRow(arrival: Arrival, stopId: string, showStop: boolean): string {
  const meta = showStop
    ? `${stopName(stopId)} · ${arrival.estimatedClock}`
    : `${describeArrival(stopId, arrival.lineId)} · ${arrival.estimatedClock}`

  return `
    <article class="arrival${arrivalTone(arrival)}">
      ${lineChip(arrival.lineId, lineColor(arrival.lineId))}
      <div class="arrival-copy">
        <p class="arrival-dest">${esc(
          showStop ? describeArrival(stopId, arrival.lineId) : lineOf(arrival.lineId)?.title ?? `Línea ${arrival.lineId}`,
        )}</p>
        <p class="arrival-meta">${esc(meta)}</p>
      </div>
      <div class="arrival-eta">${renderEta(arrival)}</div>
    </article>
  `
}

/* ================================================================== *
 * 4 · SEGUIMIENTO                                                     *
 * ================================================================== */

/**
 * Seguir un autobus.
 *
 * La pantalla se ha vaciado de explicaciones a proposito: antes abria con un
 * parrafo, seguia con un aviso de cuantas funciones estaban activas y cada
 * tarjeta cerraba con otro parrafo sobre el ritmo de consulta. Con cuatro
 * tarjetas en pantalla era mas texto que datos. Lo que habia que saber (los
 * limites, como funciona) esta en Ajustes; aqui solo estan las funciones.
 */
function renderSeguimiento(): string {
  // Mientras hay una franja de puntualidad abierta esta pestaña está apagada.
  // No es una restricción de adorno: medir a qué hora pasa de verdad un autobús
  // obliga a no perderse una sola consulta de ESA parada, y dibujar el recorrido
  // pide ocho paradas por ciclo contra una fuente que admite una cada dos
  // segundos. El aviso NO se pausa —es una notificación que alguien espera— pero
  // sí deja de rastrear el recorrido mientras dura la franja.
  const measuring = state.monitors.filter((monitor) => isWithinWindow(monitor))

  if (state.trackings.length === 0) {
    return `
      <section class="card"><div class="card-body">
        ${emptyState(
          'bell',
          'Sin avisos',
          'Abre una parada guardada y elige “Avisos y seguimiento”: verás los minutos que faltan y por dónde viene el autobús.',
          '<button class="btn btn-primary" type="button" data-action="tab" data-tab="inicio">Ir a mis paradas</button>',
        )}
      </div></section>
    `
  }

  return `
    ${
      measuring.length > 0
        ? notice(
            'warn',
            `Hay ${measuring.length === 1 ? 'un control' : `${measuring.length} controles`} de puntualidad midiendo hasta las ${formatMinutesClock(
              Math.max(...measuring.map((monitor) => monitor.endMinutes)),
            )}. El aviso sigue dando la hora, pero hasta entonces no rastrea por dónde viene: esas consultas van a la parada que se está midiendo.`,
          )
        : ''
    }

    ${renderJobGroup(
      'Avisos de próximo bus',
      `${state.trackings.length} de ${MAX_TRACKING_JOBS}`,
      'bell',
      state.trackings.map((job) => renderTrackingCard(job)).join(''),
      '',
    )}
  `
}

/** Agrupa las funciones por modalidad, con el margen que queda en el titulo. */
function renderJobGroup(
  title: string,
  subtitle: string,
  iconName: string,
  body: string,
  emptyMessage: string,
): string {
  return `
    <section class="job-group">
      <header class="job-group-head">
        ${icon(iconName)}
        <div class="job-group-copy">
          <h3>${esc(title)}</h3>
        </div>
        <span class="job-group-count">${esc(subtitle)}</span>
      </header>
      ${emptyMessage ? `<p class="job-group-empty">${esc(emptyMessage)}</p>` : body}
    </section>
  `
}

/**
 * Los tiempos de una parada y de la siguiente pueden llevar medio minuto de
 * diferencia porque no se piden todos a la vez. La leyenda explica el codigo de
 * color para que esa diferencia no se lea como un error.
 *
 * Y explica tambien la raya, que es la duda que de verdad trae a la gente aqui:
 * un recorrido lleno de rayas parece la app rota, y casi siempre es la
 * respuesta correcta —de noche, o en una linea de poca frecuencia, por casi
 * ninguna parada viene nada—.
 */
function renderSyncLegend(): string {
  const items: Array<[string, string]> = [
    ['loading', 'Consultando'],
    ['queued', 'En cola'],
    ['fresh', 'Al día'],
    ['aged', 'Dato antiguo'],
    ['error', 'Sin datos'],
  ]

  return `
    <div class="sync-legend">
      ${items
        .map(([tone, label]) => `<span class="sync-legend-item"><span class="sync-dot is-${tone}"></span>${esc(
          label,
        )}</span>`)
        .join('')}
    </div>
    <p class="text-tiny">
      <strong>—</strong> es una respuesta: esa parada está consultada y ahora mismo no consta
      ningún autobús de esta línea por ahí. <strong>·</strong> es que todavía no se ha mirado.
    </p>
  `
}

/* ================================================================== *
 * 5 · PUNTUALIDAD (monitorización)                                    *
 * ================================================================== */

function renderMonitor(): string {
  if (state.monitors.length === 0) {
    return `
      <div class="screen-intro">
        <h2>Puntualidad</h2>
        <p>Compara el horario oficial con la hora real a la que pasa tu autobús.</p>
      </div>
      ${renderMonitorCostNotice()}
      <section class="card"><div class="card-body">
        ${emptyState(
          'chart',
          'Sin controles de puntualidad',
          'Elige una parada guardada, una línea y una franja horaria; la app irá anotando a qué hora pasa realmente.',
          '<button class="btn btn-primary" type="button" data-action="tab" data-tab="inicio">Ir a mis paradas</button>',
        )}
      </div></section>
    `
  }

  return `
    <div class="screen-intro">
      <h2>Puntualidad</h2>
      <p>Media de paso real observada frente al horario programado.</p>
    </div>
    ${renderMonitorCostNotice()}
    ${state.schedule?.stale ? notice('warn', scheduleStaleMessage()) : ''}
    ${state.monitors.map((monitor) => renderMonitorCard(monitor)).join('')}
  `
}

/**
 * Lo que MEDIR le cuesta al resto de la aplicación.
 *
 * No es una advertencia de cortesía: dentro de su franja, un control se queda
 * con el turno de la cola de consultas, que es una sola y admite una petición
 * cada dos segundos contra la fuente oficial. Mientras dura, los tiempos de las
 * demás paradas tardan más en refrescarse y el seguimiento de próximo bus deja
 * de rastrear por dónde viene el autobús —sigue dando la hora, eso no se toca—.
 *
 * Callarlo convertía una regla en un fallo aparente: quien tenía un control a
 * las ocho veía la app "lenta" a las ocho y no tenía forma de relacionar las dos
 * cosas. Dicho aquí, en la pantalla que lo provoca, es una decisión informada.
 */
function renderMonitorCostNotice(): string {
  const open = state.monitors.filter((monitor) => isWithinWindow(monitor))

  if (open.length > 0) {
    const until = Math.max(...open.map((monitor) => monitor.endMinutes))
    return notice(
      'warn',
      `Midiendo hasta las ${formatMinutesClock(until)}. Mientras dure, los tiempos del resto de líneas y paradas se actualizan más despacio y el seguimiento no rastrea por dónde viene el autobús: la cola de consultas es una sola y ahora la ocupa la parada que se está midiendo.`,
    )
  }

  return notice(
    'info',
    'Mientras un control está dentro de su franja, se queda con el turno de consultas: los tiempos del resto de líneas y paradas se actualizan más despacio y el seguimiento deja de rastrear por dónde viene el autobús, aunque siga avisando de los minutos que faltan.',
  )
}

function scheduleStaleMessage(): string {
  const validTo = state.schedule?.validTo
  return validTo
    ? `El horario oficial incluido caduca el ${validTo}. Las horas programadas son orientativas hasta actualizar el GTFS.`
    : 'El horario oficial incluido no declara fechas de validez; las horas programadas son orientativas.'
}

function renderMonitorCard(monitor: MonitorJob): string {
  const dayType = state.monitorDayView[monitor.id] ?? currentDayType()
  const summary = summariseMonitor(monitor, dayType)
  const active = isWithinWindow(monitor)
  const seenAt = state.monitorSeenAt[monitor.id] ?? null
  const runtime = state.monitorRuntime[monitor.id]
  const directions = state.network?.getDirectionsThroughStop(monitor.stopId, monitor.lineId) ?? []
  const direction = monitor.directionKey
    ? state.network?.directionByKey.get(monitor.directionKey) ?? null
    : null

  const statusPill = active
    ? runtime?.armed
      ? '<span class="pill is-warn is-live">Autobús entrando</span>'
      : `<span class="pill is-ok is-live">Observando · ${esc(formatAge(seenAt))}</span>`
    : `<span class="pill">Empieza a las ${esc(formatMinutesClock(monitor.startMinutes))}</span>`

  return `
    <section class="card" data-key="monitor-${esc(monitor.id)}">
      <div class="card-head">
        ${lineChip(monitor.lineId, lineColor(monitor.lineId), 'lg')}
        <div class="card-head-copy">
          <h2 class="card-title">${esc(monitor.stopName)}</h2>
          <p class="card-sub is-wrap">${esc(formatMinutesClock(monitor.startMinutes))} – ${esc(
            formatMinutesClock(monitor.endMinutes),
          )} · ${esc(direction ? `hacia ${direction.destination}` : 'todos los sentidos')}</p>
        </div>
        <div class="card-actions">
          ${statusPill}
          <button class="mini-btn is-danger" type="button" data-action="remove-monitor" data-monitor="${esc(
            monitor.id,
          )}" aria-label="Quitar control">${icon('trash')}</button>
        </div>
      </div>
      <div class="card-body">
        <label class="field">
          <span>Tipo de día</span>
          <select class="select" data-action="monitor-day" data-monitor="${esc(monitor.id)}">
            <option value="weekday" ${dayType === 'weekday' ? 'selected' : ''}>Laborable (L–V)</option>
            <option value="saturday" ${dayType === 'saturday' ? 'selected' : ''}>Sábado</option>
            <option value="sunday" ${dayType === 'sunday' ? 'selected' : ''}>Domingo y festivos</option>
          </select>
        </label>

        ${
          !monitor.directionKey && directions.filter((item) => !item.partial).length > 1
            ? notice(
                'warn',
                'Por esta parada pasan varios sentidos de la línea y este control no fijó ninguno: el horario programado los mezcla. Crea otro control eligiendo el sentido para una medición fiable.',
              )
            : ''
        }

        ${
          summary.rows.length === 0
            ? emptyState(
                'clock',
                'Sin pasos programados',
                'El horario oficial no recoge salidas de esta línea por esta parada en la franja elegida. Los pasos que se detecten se guardarán igualmente más abajo.',
              )
            : `
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr><th>Programado</th><th>Real medio</th><th>Desvío</th></tr>
              </thead>
              <tbody>
                ${summary.rows.map((row) => renderMonitorRow(row)).join('')}
              </tbody>
            </table>
          </div>
        `
        }

        ${renderMonitorPasses(summary.unmatched)}

        ${renderMonitorTrace(monitor)}

        <p class="text-tiny">
          ${esc(monitorFootnote(monitor, summary.passes.length, summary.days, active))}
        </p>
      </div>
    </section>
  `
}

/** Explica en una línea qué se ha recogido y qué falta para que la tabla se llene. */
function monitorFootnote(monitor: MonitorJob, passes: number, days: number, active: boolean): string {
  if (passes === 0) {
    return active
      ? 'Todavía sin pasos registrados. La app está consultando esta parada cada 30 s; abre el registro para ver qué está encontrando.'
      : `Todavía sin pasos registrados. La medición ocurre entre las ${formatMinutesClock(
          monitor.startMinutes,
        )} y las ${formatMinutesClock(
          monitor.endMinutes,
        )}; fuera de esa franja no se consulta nada.`
  }

  return `${passes} paso${passes === 1 ? '' : 's'} registrado${passes === 1 ? '' : 's'} en ${days} día${
    days === 1 ? '' : 's'
  }. Cada día cuenta una sola vez por salida programada.`
}

function renderMonitorRow(row: MonitorRow): string {
  if (row.average === null || row.delta === null) {
    return `<tr data-key="slot-${esc(row.slot)}"><td class="is-num">${esc(
      row.slot,
    )}</td><td class="text-muted">sin datos</td><td>—</td></tr>`
  }

  const deltaClass = row.delta > 1 ? 'is-late' : row.delta < -1 ? 'is-early' : 'is-ontime'
  const deltaText = row.delta === 0 ? 'en hora' : `${row.delta > 0 ? '+' : ''}${row.delta} min`

  return `
    <tr data-key="slot-${esc(row.slot)}">
      <td class="is-num">${esc(row.slot)}</td>
      <td class="is-num">${esc(formatMinutesClock(row.average))}<span class="sample-count">${
        row.samples
      }</span></td>
      <td><span class="delta ${deltaClass}">${esc(deltaText)}</span></td>
    </tr>
  `
}

/**
 * Registro de un control: qué ha visto y qué ha decidido con ello.
 *
 * Es la respuesta a la única pregunta que se hace mirando una tabla vacía: por
 * qué no se está apuntando ninguna hora. La fuente oficial no publica "el
 * autobús ha pasado" —solo cuántos minutos faltan—, así que el paso se deduce, y
 * una deducción que no llega a producirse no deja rastro por sí sola. Los
 * motivos reales son varios y ninguno se ve desde fuera: la línea no figura en
 * el panel de esa parada, la fuente está limitando por IP, el móvil se durmió
 * entre consulta y consulta, o el paso sí se detectó pero el horario oficial no
 * tenía ninguna salida cerca a la que atribuirlo.
 *
 * Va cerrado de fábrica: quien mira la pantalla quiere ver la tabla, no el
 * registro. Se abre cuando la tabla no cuenta lo que se esperaba.
 */
function renderMonitorTrace(monitor: MonitorJob): string {
  const trace = state.monitorTrace[monitor.id] ?? []
  const open = state.monitorTraceOpen[monitor.id] === true

  if (trace.length === 0 && !open) {
    return ''
  }

  const warnings = trace.filter((entry) => entry.level !== 'info').length

  return `
    <div class="stack-sm">
      <button class="btn btn-secondary btn-block btn-sm" type="button"
        data-action="toggle-monitor-trace" data-monitor="${esc(monitor.id)}">
        ${icon(open ? 'up' : 'down')} Registro de la medición (${trace.length}${
          warnings > 0 ? ` · ${warnings} con aviso` : ''
        })
      </button>
      ${
        open
          ? `<div class="trace-list">${[...trace]
              .reverse()
              .map((entry) => renderMonitorTraceRow(entry))
              .join('')}</div>
             <button class="btn btn-secondary btn-block btn-sm" type="button"
               data-action="clear-monitor-trace" data-monitor="${esc(monitor.id)}">
               ${icon('trash')} Vaciar el registro
             </button>`
          : ''
      }
    </div>
  `
}

function renderMonitorTraceRow(entry: MonitorTrace): string {
  return `
    <div class="trace-item is-${entry.level}" data-key="trace-${entry.at}">
      <span class="trace-time">${esc(formatClock(new Date(entry.at)))}</span>
      <span class="trace-copy">
        <span class="trace-note">${esc(entry.note)}</span>
        <span class="trace-meta">${esc(
          entry.minutes === null ? 'sin dato de esa línea' : `${entry.minutes} min`,
        )}${entry.armed ? ' · autobús entrando' : ''}</span>
      </span>
    </div>
  `
}

/**
 * Pasos detectados que no encajan con ninguna salida programada de la franja.
 * Se enseñan en vez de descartarlos: son la prueba de que la app está midiendo y
 * la señal más clara de que el horario oficial se ha quedado atrás.
 */
function renderMonitorPasses(passes: Array<{ at: number, minutes: number }>): string {
  if (passes.length === 0) {
    return ''
  }

  return `
    <div class="stack-sm">
      <h4 class="section-title">Pasos sin horario programado</h4>
      <ul class="chip-list">
        ${passes
          .map(
            (pass) =>
              `<li class="chip" data-key="pass-${pass.at}">${esc(
                formatMinutesClock(pass.minutes),
              )}<span class="chip-note">${esc(
                new Date(pass.at).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }),
              )}</span></li>`,
          )
          .join('')}
      </ul>
    </div>
  `
}

/* ================================================================== *
 * Tour de bienvenida                                                  *
 * ================================================================== */

interface TourStep {
  iconName: string
  title: string
  body: string
}

/**
 * Recorrido mínimo por las pestañas inferiores.
 *
 * Se abre solo la primera vez que se arranca cada versión: es el único momento
 * en que hay algo nuevo que contar, y termina en los permisos porque sin ellos
 * los avisos no funcionan y nada en la pantalla principal lo delata.
 */
const TOUR: TourStep[] = [
  {
    iconName: 'home',
    title: 'Inicio',
    body: 'El reloj, tus seguimientos en marcha y tus paradas guardadas. Toca una parada para ver sus llegadas; los botones de abajo la renombran o la quitan.',
  },
  {
    iconName: 'search',
    title: 'Buscar',
    body: 'Encuentra una parada por su nombre o su línea, por las que tienes más cerca, o tocándola en el mapa.',
  },
  {
    iconName: 'bell',
    title: 'Seguir',
    body: 'El aviso de próximo bus: te dice los minutos que faltan, por cuántas paradas viene y te llega aunque cierres la app.',
  },
  {
    iconName: 'chart',
    title: 'Puntualidad',
    body: 'Elige una parada, una línea y una franja: la app anota a qué hora pasa de verdad y la compara con el horario.',
  },
  {
    iconName: 'info',
    title: 'Info',
    body: 'Los horarios oficiales de cada línea, por sentido y por día, con la primera salida, la última y los descansos señalados. Y, si lo enciendes en Ajustes, el cálculo de rutas entre dos puntos.',
  },
  {
    iconName: 'settings',
    title: 'Ajustes',
    body: 'Desde el engranaje de arriba. En "Funciones", permisos, seguimiento y actualizaciones; en "Información", los ritmos de consulta y el registro.',
  },
  {
    iconName: 'bell',
    title: 'Permisos que hay que conceder',
    body: 'Notificaciones, para que el aviso pueda mostrarse; y sin optimización de batería, para que siga actualizándose con la pantalla apagada.',
  },
]

/** Pasos del tour; `main.ts` lo necesita para saber cuándo se ha acabado. */
export const TOUR_STEPS = TOUR.length

function renderTour(): string {
  if (!state.tour.open || !state.ready) {
    return ''
  }

  const index = Math.min(state.tour.step, TOUR.length - 1)
  const step = TOUR[index]
  const last = index === TOUR.length - 1

  return `
    <div class="tour-backdrop"></div>
    <section class="tour" role="dialog" aria-modal="true" aria-label="Novedades de SALBUS">
      <header class="tour-head">
        <span class="tour-badge">${esc(APP_VERSION)}</span>
        <button class="mini-btn" type="button" data-action="tour-close" aria-label="Cerrar el tour">
          ${icon('close')}
        </button>
      </header>

      <div class="tour-body">
        <div class="tour-icon">${icon(step.iconName)}</div>
        <h3>${esc(step.title)}</h3>
        <p>${esc(step.body)}</p>
      </div>

      ${
        last
          ? `<div class="tour-perms">
              ${renderPermissionRow(
                'Notificaciones',
                'Permite mostrar el aviso con los minutos que faltan.',
                state.permissions.notifications,
                'request-notifications',
              )}
              ${renderPermissionRow(
                'Sin optimización de batería',
                'Evita que Android detenga las actualizaciones.',
                state.permissions.battery,
                'request-battery',
              )}
            </div>`
          : ''
      }

      <div class="tour-dots">
        ${TOUR.map(
          (_, position) =>
            `<span class="tour-dot${position === index ? ' is-current' : ''}"></span>`,
        ).join('')}
      </div>

      <div class="btn-row">
        <button class="btn btn-secondary" type="button" data-action="tour-back" ${
          index === 0 ? 'disabled' : ''
        }>Atrás</button>
        <button class="btn btn-primary" type="button" data-action="tour-next">
          ${last ? 'Empezar' : 'Siguiente'}
        </button>
      </div>
    </section>
  `
}

/* ================================================================== *
 * 6 · MAPAS (experimental)                                            *
 * ================================================================== */

/**
 * Pestaña experimental: el planificador de rutas.
 *
 * Vive aparte del resto a propósito. No consulta la fuente oficial de llegadas
 * (esa fuente limita por IP y su cola es para el aviso de próximo bus), no
 * guarda nada en disco y no toca el estado de ninguna otra pantalla. Lo único
 * que comparte es la red de líneas ya cargada y la ubicación.
 *
 * Las paradas cercanas ya no están aquí: se buscan en Buscar, junto al resto de
 * formas de encontrar una parada.
 */
/**
 * La pestaña Info: dos apartados, uno debajo del selector.
 *
 * Lo que tienen en común no es la tecnología —uno calcula rutas y el otro lee un
 * GTFS— sino el momento en que se usan: son las dos preguntas que se hacen ANTES
 * de salir de casa, no las que se hacen en la marquesina. Por eso viven juntas y
 * lejos de Inicio, Buscar y Seguir, que son las tres pantallas de "estoy
 * esperando el autobús ahora mismo".
 */
function renderInfo(): string {
  const section = state.info.section

  return `
    <div class="segmented" role="tablist" aria-label="Apartados de información">
      ${renderInfoSegment('llegar', 'Cómo llegar', 'route')}
      ${renderInfoSegment('lineas', 'Información de líneas', 'clock')}
    </div>

    ${section === 'llegar' ? renderComoLlegar() : renderLineInfo()}
  `
}

function renderInfoSegment(section: InfoSection, label: string, iconName: string): string {
  return `
    <button
      class="segmented-item"
      type="button"
      role="tab"
      aria-selected="${state.info.section === section}"
      data-action="info-section"
      data-section="${section}"
    >${icon(iconName)}<span>${esc(label)}</span></button>
  `
}

/**
 * "Cómo llegar": el planificador de rutas, que sigue siendo experimental.
 *
 * Apagado en Ajustes NO se dibuja el mapa ni se pide la ubicación ni se calcula
 * nada: lo experimental no puede gastar recursos de quien no lo ha pedido. Lo
 * que sí queda es una explicación de qué hay aquí y cómo encenderlo, porque una
 * pestaña con un apartado que no dice nada se lee como una app rota.
 */
function renderComoLlegar(): string {
  if (!state.settings.experimentalMaps) {
    return `
      <section class="card"><div class="card-body">
        ${emptyState(
          'route',
          'Cómo llegar está apagado',
          'Calcula la ruta en autobús entre dos puntos. Está en pruebas, así que viene apagado: encendido consulta tu ubicación y dibuja un mapa.',
          '<button class="btn btn-primary" type="button" data-action="tab" data-tab="ajustes">Abrir Ajustes</button>',
        )}
      </div></section>
    `
  }

  return renderMapas()
}

function renderMapas(): string {
  const maps = state.maps

  return `
    <div class="lab-banner">
        ${icon('info')}
        <div>
          <strong>Función experimental</strong>
          <span>Los tiempos de ruta son estimaciones a partir del recorrido oficial, no horarios en firme.</span>
        </div>
      </div>

      <!-- El contenedor es SIEMPRE el mismo nodo, encajado o a pantalla
           completa: solo cambia cómo se coloca. Moverlo de sitio en el árbol
           obligaría a reconstruir Leaflet en cada apertura. -->
      <div class="map-shell maps-shell${maps.expanded ? ' is-expanded' : ''}">
        <!-- data-morph="skip": dentro manda Leaflet. Sin esto, el repintado
             incremental le borraba los hijos en cada latido del reloj y el mapa
             se quedaba en un rectangulo vacio. -->
        <div id="maps-map" data-morph="skip"></div>
        ${
          maps.expanded
            ? `<button class="map-close" type="button" data-action="maps-collapse" aria-label="Cerrar el mapa">
                 ${icon('close')}
               </button>`
            : `<button class="map-expand" type="button" data-action="maps-expand">
                 ${icon('map')} Ampliar
               </button>`
        }
      </div>

    ${renderRoutePanel()}
  `
}

/* ---------------------- Información de líneas -------------------------- */

/**
 * Un hueco a partir del cual dejamos de hablar de "frecuencia" y empezamos a
 * hablar de "descanso".
 *
 * Cuarenta y cinco minutos: la línea urbana más floja de Salamanca pasa cada 30,
 * así que por debajo de ese hueco lo que se está viendo es una frecuencia mala,
 * no una parada del servicio. Por encima, el autobús ha dejado de circular un
 * rato —la comida, o el vacío de media tarde— y eso SÍ cambia lo que hace quien
 * lo lee: significa que no merece la pena bajar a la parada.
 */
const BREAK_GAP_MINUTES = 45

/** Los tres tipos de día, en el orden en que se leen. */
const DAY_TYPES: Array<{ dayType: ServiceDayType, label: string }> = [
  { dayType: 'weekday', label: 'lunes a viernes' },
  { dayType: 'saturday', label: 'sábados' },
  { dayType: 'sunday', label: 'domingos y festivos' },
]

/**
 * Horarios oficiales de una línea, por sentido y por tipo de día.
 *
 * Es el horario de CABECERA —a qué hora sale cada expedición del principio del
 * recorrido—, que es lo que se publica en las marquesinas y lo que se busca
 * cuando la pregunta es "¿a qué hora es el último?". No se mezcla con los
 * tiempos en vivo: esos son de una parada concreta y de ahora mismo, y viven en
 * Inicio y en Buscar.
 */
function renderLineInfo(): string {
  const network = state.network
  if (!network) {
    return notice('error', 'La red oficial no está disponible.')
  }

  if (!state.schedule) {
    return notice(
      'warn',
      state.scheduleError
        ?? 'El horario oficial no se ha podido cargar, así que no hay horarios de línea que enseñar.',
    )
  }

  const line = state.info.lineId ? network.lineById.get(state.info.lineId) ?? null : null
  const direction = state.info.directionKey
    ? network.directionByKey.get(state.info.directionKey) ?? null
    : null

  return `
    <section class="card">
      <div class="card-body">
        <label class="field">
          <span>Línea</span>
          <select class="select" data-action="info-line">
            <option value="" ${line ? '' : 'selected'}>Seleccionar línea</option>
            ${network.lines
              .map(
                (item) =>
                  `<option value="${esc(item.lineId)}" ${
                    item.lineId === state.info.lineId ? 'selected' : ''
                  }>${esc(item.shortName)} · ${esc(item.title)}</option>`,
              )
              .join('')}
          </select>
        </label>

        ${
          line
            ? `<label class="field">
                 <span>Sentido</span>
                 <select class="select" data-action="info-direction">
                   <option value="" ${direction ? '' : 'selected'}>Seleccionar sentido</option>
                   ${line.directions
                     .map(
                       (item) =>
                         `<option value="${esc(item.key)}" ${
                           item.key === state.info.directionKey ? 'selected' : ''
                         }>${esc(directionLabel(item))}</option>`,
                     )
                     .join('')}
                 </select>
               </label>`
            : ''
        }
      </div>
    </section>

    ${state.schedule.stale ? notice('warn', scheduleStaleMessage()) : ''}

    ${
      line && direction
        ? renderDirectionSchedule(line, direction)
        : `<section class="card"><div class="card-body">${emptyState(
            'clock',
            'Elige una línea y un sentido',
            'Verás las horas de salida de cabecera para cada día, con el primero, el último y los descansos señalados.',
          )}</div></section>`
    }
  `
}

/**
 * El horario de UN sentido, con los días de horario idéntico agrupados.
 *
 * Agruparlos no es un adorno: en la mayoría de líneas el horario de lunes a
 * viernes y el del sábado son el mismo, y pintar dos tablas gemelas una debajo
 * de otra obliga a compararlas hora a hora para descubrir que no hacía falta
 * compararlas. Cuando de verdad se diferencian, cada bloque se lee solo.
 */
function renderDirectionSchedule(line: TransitLine, direction: LineDirection): string {
  const schedule = state.schedule
  if (!schedule) {
    return ''
  }

  const byDayType = DAY_TYPES.map((entry) => ({
    ...entry,
    times: schedule.getDirectionDepartures(direction.key, entry.dayType),
  }))

  if (byDayType.every((entry) => entry.times.length === 0)) {
    return `
      <section class="card"><div class="card-body">
        ${emptyState(
          'clock',
          'Sin horario para este sentido',
          'El GTFS oficial no trae expediciones de este trayecto. Suele pasar con las variantes parciales, que solo circulan algunos días.',
        )}
      </div></section>
    `
  }

  // Días con exactamente el mismo horario van juntos. La firma es la lista de
  // horas: dos días con las mismas horas son, para quien lee, el mismo día.
  const groups = new Map<string, { labels: string[], dayTypes: ServiceDayType[], times: string[] }>()

  for (const entry of byDayType) {
    if (entry.times.length === 0) {
      continue
    }

    const signature = entry.times.join(',')
    const group = groups.get(signature)

    if (group) {
      group.labels.push(entry.label)
      group.dayTypes.push(entry.dayType)
    } else {
      groups.set(signature, { labels: [entry.label], dayTypes: [entry.dayType], times: entry.times })
    }
  }

  const today = currentDayType()

  return `
    <section class="card">
      <div class="card-head">
        ${lineChip(line.lineId, line.color, 'lg')}
        <div class="card-head-copy">
          <h2 class="card-title">${esc(direction.label)}</h2>
          <p class="card-sub is-wrap">Salidas desde ${esc(direction.origin)} · ${direction.stopCount} paradas</p>
        </div>
      </div>
      <div class="card-body">
        ${Array.from(groups.values())
          .map((group) => renderScheduleGroup(group, group.dayTypes.includes(today)))
          .join('')}
        ${renderScheduleLegend()}
        <p class="text-tiny">
          Son las salidas de cabecera del horario oficial, no tiempos en vivo: por una parada
          intermedia el autobús pasa más tarde, y el retraso real no está aquí. Para eso están los
          tiempos de Inicio y Buscar, y la pestaña Puntualidad.
        </p>
      </div>
    </section>
  `
}

/**
 * Un bloque de días con el mismo horario.
 *
 * Se resaltan tres cosas y solo tres, porque son las tres que cambian una
 * decisión: la primera salida, la última y los bordes de un descanso. El resto
 * de horas son la frecuencia, y la frecuencia se lee de un vistazo sin ayuda.
 */
function renderScheduleGroup(
  group: { labels: string[], times: string[] },
  isToday: boolean,
): string {
  const marks = markSchedule(group.times)

  return `
    <div class="schedule-group${isToday ? ' is-today' : ''}">
      <div class="schedule-head">
        <strong>${esc(joinDayLabels(group.labels))}</strong>
        <span class="pill">${group.times.length} ${group.times.length === 1 ? 'salida' : 'salidas'}</span>
        ${isToday ? '<span class="pill is-ok">Hoy</span>' : ''}
      </div>
      <div class="schedule-times">
        ${group.times
          .map((clock, index) => {
            const mark = marks[index]
            return `<span class="schedule-time${mark.className}"${
              mark.title ? ` title="${esc(mark.title)}" aria-label="${esc(`${clock}. ${mark.title}`)}"` : ''
            }>${esc(clock)}</span>`
          })
          .join('')}
      </div>
    </div>
  `
}

/**
 * Qué es cada hora dentro de su jornada.
 *
 * Se calcula sobre la lista ya ordenada: la primera es el inicio, la última la
 * finalización, y un hueco de más de BREAK_GAP_MINUTES parte la jornada en dos,
 * de modo que la hora anterior al hueco es "última antes del descanso" y la
 * siguiente es "vuelta del descanso".
 *
 * Una misma hora puede ser dos cosas a la vez (la primera del día y también la
 * vuelta de un descanso en una línea que solo circula en dos franjas sueltas);
 * gana el papel más informativo, que es el del descanso.
 */
function markSchedule(times: string[]): Array<{ className: string, title: string }> {
  const marks = times.map(() => ({ className: '', title: '' }))
  if (times.length === 0) {
    return marks
  }

  marks[0] = { className: ' is-first', title: 'Primera salida del día' }
  const last = times.length - 1
  marks[last] = { className: ' is-last', title: 'Última salida del día' }

  for (let index = 1; index < times.length; index += 1) {
    const gap = parseClockToMinutes(times[index]) - parseClockToMinutes(times[index - 1])
    if (gap < BREAK_GAP_MINUTES) {
      continue
    }

    const length = formatGap(Math.round(gap))
    marks[index - 1] = {
      className: ' is-break-out',
      title: `Última salida antes de un descanso de ${length}`,
    }
    marks[index] = {
      className: ' is-break-in',
      title: `Primera salida tras el descanso de ${length}`,
    }
  }

  return marks
}

/**
 * La duración de un descanso, dicha como se dice.
 *
 * En minutos sueltos funciona para el hueco de la comida, pero los trayectos
 * parciales tienen dos salidas al día —una por la mañana y otra de noche— y ahí
 * salía "un descanso de 880 min", que nadie convierte mentalmente a catorce
 * horas y media. A partir de la hora se cuenta en horas.
 */
function formatGap(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`
  }

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function renderScheduleLegend(): string {
  const items: Array<[string, string]> = [
    ['is-first', 'Primera'],
    ['is-last', 'Última'],
    ['is-break-out', 'Antes del descanso'],
    ['is-break-in', 'Tras el descanso'],
  ]

  return `
    <div class="schedule-legend">
      ${items
        .map(
          ([tone, label]) =>
            `<span class="schedule-legend-item"><span class="schedule-time ${tone}">00:00</span>${esc(
              label,
            )}</span>`,
        )
        .join('')}
    </div>
  `
}

/** "lunes a viernes" + "sábados" → "Lunes a viernes y sábados". */
function joinDayLabels(labels: string[]): string {
  if (labels.length === DAY_TYPES.length) {
    return 'Todos los días'
  }

  // Caso frecuente y con nombre propio: de lunes a sábado, festivos aparte.
  if (labels.length === 2 && labels[0] === 'lunes a viernes' && labels[1] === 'sábados') {
    return 'De lunes a sábado'
  }

  const joined =
    labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`

  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

/* -------------------------------- Rutas ------------------------------- */

function renderRoutePanel(): string {
  const maps = state.maps

  if (maps.picking) {
    return renderRoutePicker(maps.picking)
  }

  return `
    <section class="card">
      <div class="card-body">
        <div class="route-form">
          ${renderRouteField('origin', 'Desde', maps.origin)}
          <button class="mini-btn route-swap" type="button" data-action="maps-swap"
            aria-label="Intercambiar origen y destino">${icon('swap')}</button>
          ${renderRouteField('destination', 'Hasta', maps.destination)}
        </div>

        <button
          class="btn btn-primary btn-block"
          type="button"
          data-action="maps-plan"
          ${!maps.origin || !maps.destination || maps.planning ? 'disabled' : ''}
        >${icon('route')} ${maps.planning ? 'Calculando…' : 'Calcular ruta'}</button>
      </div>
    </section>

    ${renderPlanResult()}
  `
}

function renderRouteField(field: 'origin' | 'destination', label: string, point: RoutePoint | null): string {
  return `
    <button class="route-field" type="button" data-action="maps-pick" data-field="${field}">
      <span class="route-field-dot${field === 'destination' ? ' is-end' : ''}"></span>
      <span class="route-field-copy">
        <span class="route-field-label">${esc(label)}</span>
        <span class="route-field-value${point ? '' : ' is-empty'}">${esc(
          point ? point.label : 'Elegir en la lista de paradas',
        )}</span>
      </span>
      ${icon('chevron')}
    </button>
  `
}

/**
 * Buscador de un extremo de la ruta.
 *
 * Se abre DENTRO de la pestaña y no en la hoja inferior compartida: así esta
 * función experimental no toca la maquinaria que usan el resto de pantallas.
 */
function renderRoutePicker(field: 'origin' | 'destination'): string {
  const results = state.network?.findStops(state.maps.query, 25) ?? []

  return `
    <section class="card">
      <div class="card-head">
        <div class="card-head-copy">
          <h2 class="card-title">${field === 'origin' ? 'Punto de salida' : 'Punto de llegada'}</h2>
          <p class="card-sub">Tu ubicación o una parada de la red</p>
        </div>
        <button class="mini-btn" type="button" data-action="maps-pick-cancel" aria-label="Cerrar">
          ${icon('close')}
        </button>
      </div>
      <div class="card-body">
        <button class="btn btn-secondary btn-block" type="button" data-action="maps-pick-here">
          ${icon('crosshair')} Mi ubicación
        </button>

        <input
          class="input"
          id="maps-query"
          type="search"
          placeholder="Buscar una parada por su nombre"
          value="${esc(state.maps.query)}"
          autocomplete="off"
        />

        <div class="result-list">
          ${
            results.length === 0
              ? emptyState('search', 'Sin resultados', 'Ninguna parada coincide con lo que has escrito.')
              : results
                  .map(
                    (stop) => `
                      <button class="result-item" type="button" data-action="maps-pick-stop" data-stop="${esc(
                        stop.stopId,
                      )}">
                        <span class="stop-code">${esc(stop.stopId)}</span>
                        <span class="result-copy">
                          <span class="result-name is-wrap">${esc(stop.stopName)}</span>
                        </span>
                        ${icon('chevron')}
                      </button>
                    `,
                  )
                  .join('')
          }
        </div>
      </div>
    </section>
  `
}

function renderPlanResult(): string {
  const plan = state.maps.plan

  if (!plan) {
    return ''
  }

  if (plan.status === 'unreachable') {
    return `<section class="card"><div class="card-body">${notice('warn', plan.reason)}</div></section>`
  }

  if (plan.status === 'walk') {
    return `
      <section class="card">
        <div class="card-head"><div class="card-head-copy">
          <h2 class="card-title">Se llega antes andando</h2>
          <p class="card-sub">${esc(formatWalk(plan.walking.totalMinutes))} · ${esc(
            formatMeters(walkingMeters(plan.walking)),
          )}</p>
        </div></div>
        <div class="card-body">
          <p class="text-tiny">Ningún autobús te deja antes que tus pies para esa distancia.</p>
        </div>
      </section>
    `
  }

  return `
    <div id="ruta-resultado" class="stack-sm">
      ${renderItinerary(plan.best, true)}
      ${plan.alternatives.map((itinerary) => renderItinerary(itinerary, false)).join('')}
    </div>
  `
}

function renderItinerary(itinerary: Itinerary, best: boolean): string {
  const lines = itinerary.legs.filter((leg): leg is BusLeg => leg.kind === 'bus')

  return `
    <section class="card itinerary${best ? ' is-best' : ''}">
      <div class="card-head">
        <div class="card-head-copy">
          <h2 class="card-title">${esc(formatWalk(itinerary.totalMinutes))}${
            best ? ' · la más rápida' : ''
          }</h2>
          <p class="card-sub is-wrap">${esc(
            `${itinerary.transfers === 0 ? 'Sin transbordos' : itinerary.transfers === 1 ? 'Un transbordo' : `${itinerary.transfers} transbordos`} · ${formatWalk(
              itinerary.walkMinutes,
            )} a pie · espera ${formatWalk(itinerary.waitMinutes)}`,
          )}</p>
        </div>
        <span class="itinerary-lines">
          ${lines.map((leg) => lineChip(leg.lineId, lineColor(leg.lineId), 'sm')).join('')}
        </span>
      </div>
      <div class="card-body">
        <ol class="itinerary-legs">
          ${itinerary.legs.map((leg, index) => renderLeg(leg, index)).join('')}
        </ol>
      </div>
    </section>
  `
}

function renderLeg(leg: RouteLeg, index: number): string {
  if (leg.kind === 'walk') {
    // Un transbordo de treinta metros no es "andar", es cruzar; decirlo así
    // evita que parezca una caminata y, sobre todo, deja claro que la parada
    // de subida NO es la misma en la que te has bajado.
    const verb = leg.meters < 80 ? 'Cruzar a' : 'Andar hasta'

    return `
      <li class="leg is-walk">
        <span class="leg-mark">${icon('walk')}</span>
        <div class="leg-copy">
          <strong>${esc(verb)} ${esc(leg.toName)}</strong>
          <span>${esc(formatMeters(leg.meters))} · ${esc(formatWalk(leg.minutes))}${
            // Sin callejero el paseo se mide en linea recta y se queda corto
            // siempre. Decirlo es la diferencia entre un dato y una promesa.
            leg.onStreets ? '' : ' · en línea recta'
          }</span>
        </div>
      </li>
    `
  }

  const color = lineColor(leg.lineId)

  return `
    <li class="leg is-bus">
      <span class="leg-mark" style="--leg:${esc(color)}">${lineChip(leg.lineId, color, 'sm')}</span>
      <div class="leg-copy">
        <strong>Hacia ${esc(leg.headsign)}</strong>
        <span>Sube en ${esc(leg.from.stopName)}</span>
        <span>Baja en ${esc(leg.to.stopName)}</span>
        <span class="leg-meta">${leg.stops.length - 1} paradas · ${esc(
          formatWalk(leg.minutes),
        )} · espera ~${esc(formatWalk(leg.waitMinutes))}</span>
      </div>
      <button class="mini-btn" type="button" data-action="maps-focus-leg" data-leg="${index}"
        aria-label="Ver este tramo en el mapa">${icon('eye')}</button>
    </li>
  `
}

/* ---------------------------- Ayudas de la pestaña -------------------- */

export function nearestStopsForView(): NearbyStop[] {
  const location = state.geo.location
  if (!location || !state.network) {
    return []
  }

  return nearestStops(location.point, state.network.stops, 8)
}

function locationAgeLabel(): string {
  const location = state.geo.location
  if (!location) {
    return ''
  }

  const accuracy = Number.isFinite(location.accuracy) ? Math.round(location.accuracy) : null
  return accuracy ? `Precisión aproximada de ${accuracy} m` : 'Ubicación aproximada'
}

function walkingMeters(itinerary: Itinerary): number {
  return itinerary.legs.reduce((total, leg) => (leg.kind === 'walk' ? total + leg.meters : total), 0)
}

export function formatMeters(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters / 10) * 10} m`
  }
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`
}

/** Minutos redondeados hacia arriba: prometer menos de lo que se tarda molesta. */
export function formatWalk(minutes: number): string {
  const total = Math.max(1, Math.ceil(minutes))
  if (total < 60) {
    return `${total} min`
  }
  return `${Math.floor(total / 60)} h ${total % 60} min`
}

/* ================================================================== *
 * 7 · AJUSTES                                                         *
 * ================================================================== */

/**
 * Ajustes, partido en dos apartados.
 *
 * La distinción no es temática sino de uso: hay paneles que HACEN algo —un
 * interruptor, un permiso, un botón que descarga una versión— y paneles que solo
 * CUENTAN algo —cada cuánto se pide cada cosa, cuántas consultas van, qué ha
 * pasado—. Mezclados obligaban a recorrer nueve tarjetas para llegar al único
 * interruptor que se venía a tocar, y los paneles de datos, que son largos, se
 * llevaban la mitad del recorrido sin que nadie los hubiera pedido.
 *
 * Se abre en "Funciones" porque a Ajustes se entra a cambiar algo. Lo que se
 * lee está a un toque, y ese toque solo lo da quien lo quiere.
 */
function renderAjustes(): string {
  return `
    <div class="segmented" role="tablist" aria-label="Apartados de ajustes">
      ${renderSettingsSegment('funciones', 'Funciones', 'settings')}
      ${renderSettingsSegment('informacion', 'Información', 'info')}
    </div>

    ${state.settingsSection === 'funciones' ? renderSettingsActions() : renderSettingsFacts()}

    <p class="text-tiny" style="text-align:center">SALBUS ${esc(APP_VERSION)}</p>
  `
}

function renderSettingsSegment(section: SettingsSection, label: string, iconName: string): string {
  return `
    <button
      class="segmented-item"
      type="button"
      role="tab"
      aria-selected="${state.settingsSection === section}"
      data-action="settings-section"
      data-section="${section}"
    >${icon(iconName)}<span>${esc(label)}</span></button>
  `
}

/** Lo que se puede TOCAR: permisos, interruptores y la actualización. */
function renderSettingsActions(): string {
  return `
    <div class="screen-intro">
      <h2>Funciones</h2>
      <p>Permisos, comportamiento del seguimiento y actualizaciones.</p>
    </div>

    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Permisos</h3>
        <p class="card-sub">Necesarios para los avisos en segundo plano</p>
      </div></div>
      <div class="card-body">
        ${renderPermissionRow(
          'Notificaciones',
          'Permite mostrar el aviso persistente con los minutos que faltan.',
          state.permissions.notifications,
          'request-notifications',
        )}
        ${renderPermissionRow(
          'Sin optimización de batería',
          'Evita que Android detenga las actualizaciones con la pantalla apagada.',
          state.permissions.battery,
          'request-battery',
        )}
      </div>
    </section>

    ${renderTrackingRulesCard()}

    ${renderExperimentalCard()}

    ${renderUpdateCard()}
  `
}

/** Lo que solo se LEE: frecuencias, origen de los datos, cola y registro. */
function renderSettingsFacts(): string {
  const health = getClientHealth()
  const network = state.network

  return `
    <div class="screen-intro">
      <h2>Información</h2>
      <p>Cómo funciona por dentro: ritmos de consulta, origen de los datos y registro.</p>
    </div>

    ${renderRefreshRulesCard()}

    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Origen de los datos</h3>
        <p class="card-sub">Todo procede de Salamanca de Transportes</p>
      </div></div>
      <div class="card-body">
        <dl class="kv">
          <dt>Llegadas en tiempo real</dt><dd>Web oficial</dd>
          <dt>Líneas y recorridos</dt><dd>${network?.lineCount ?? 0} líneas · ${network?.directionCount ?? 0} sentidos</dd>
          <dt>Red descargada</dt><dd>${esc(network ? new Date(network.generatedAt).toLocaleDateString('es-ES') : '—')}</dd>
          <dt>Horario programado</dt><dd>${esc(
            state.schedule?.validFrom && state.schedule?.validTo
              ? `${state.schedule.validFrom} → ${state.schedule.validTo}`
              : 'no disponible',
          )}</dd>
        </dl>
        ${state.scheduleError ? notice('warn', state.scheduleError) : ''}
        ${state.schedule?.stale ? notice('warn', scheduleStaleMessage()) : ''}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Consultas a la fuente</h3>
        <p class="card-sub">La app espacia las peticiones para no ser bloqueada</p>
      </div></div>
      <div class="card-body">
        <dl class="kv">
          <dt>Espaciado sostenido</dt><dd>${(health.spacingMs / 1000).toFixed(1)} s</dd>
          <dt>Consultas listas ya</dt><dd>${health.tokens}</dd>
          <dt>En cola</dt><dd>${health.queued}</dd>

          <dt>Consultas realizadas</dt><dd>${health.requestCount}</dd>
          <dt>Bloqueos recibidos</dt><dd>${health.throttleEvents}</dd>
          <dt>Errores de red</dt><dd>${health.errorCount}</dd>
        </dl>
        <p class="text-tiny">
          La web oficial no limita con un cronómetro sino con un cupo: admite unas 6–8 consultas
          seguidas y luego va reponiendo. SALBUS lleva su propia cuenta, más corta que la medida,
          para poder aprovechar esa ráfaga sin llegar al bloqueo: las primeras salen enseguida y
          después se sostiene el ritmo de una cada ${(MIN_REQUEST_SPACING_MS / 1000).toFixed(0)} s.
          Siempre queda una consulta apartada para la parada que estés mirando, que nunca hace cola.
        </p>

      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div class="card-head-copy">
          <h3 class="card-title">Registro</h3>
          <p class="card-sub">Últimos eventos de la aplicación</p>
        </div>
        <div class="card-actions">
          <button class="mini-btn" type="button" data-action="clear-logs" aria-label="Vaciar registro">${icon(
            'trash',
          )}</button>
        </div>
      </div>
      <div class="card-body">
        ${
          state.logs.length === 0
            ? '<p class="text-muted">Sin eventos registrados.</p>'
            : `<div class="log-list">${state.logs
                .slice(0, 60)
                .map(
                  (entry) => `
                    <div class="log-item is-${entry.level}">
                      <span class="log-time">${esc(formatClock(new Date(entry.at)))}</span>
                      <span><span class="log-scope">${esc(entry.scope)}</span> · ${esc(entry.message)}</span>
                    </div>
                  `,
                )
                .join('')}</div>`
        }
      </div>
    </section>
  `
}

/**
 * Comprobacion MANUAL. La automatica del arranque se calla los errores para no
 * molestar, y el precio de ese diseno es que un fallo real (repositorio
 * privado, sin cobertura, GitHub limitando) se ve exactamente igual que «no hay
 * novedades». Esta es la unica forma de distinguir «no hay nada» de «está roto».
 */
function renderUpdateCard(): string {
  const update = state.update
  const message = update.manualMessage

  return `
    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Actualizaciones</h3>
        <p class="card-sub">Se publican solas en cada cambio del proyecto</p>
      </div></div>
      <div class="card-body">
        <dl class="kv">
          <dt>Versión instalada</dt><dd>v${esc(state.installed.versionName)} · compilación ${state.installed.versionCode}</dd>
          <dt>Instalar apps desconocidas</dt><dd>${update.canInstall ? 'concedido' : 'sin conceder'}</dd>
        </dl>
        ${message ? notice(message.tone, message.text) : ''}
        <div class="btn-row">
          <button class="btn btn-secondary" type="button" data-action="check-update" ${
            update.manualChecking ? 'disabled' : ''
          }>
            ${icon('refresh')} ${update.manualChecking ? 'Comprobando…' : 'Buscar actualización'}
          </button>
          ${
            update.canInstall
              ? ''
              : `<button class="btn btn-secondary" type="button" data-action="open-install-settings">
                   ${icon('settings')} Permiso de instalación
                 </button>`
          }
        </div>
        <p class="text-tiny">
          Android no permite que una aplicación se instale sola: SALBUS comprueba, descarga y prepara
          la versión nueva, y el último paso lo confirmas tú en el diálogo del sistema.
        </p>
      </div>
    </section>
  `
}

/**
 * Cada cuánto se actualiza cada cosa, y con qué condición.
 *
 * Ninguna de estas frecuencias es un capricho: todas salen de repartir una sola
 * cola de consultas —una petición cada 2 s, que es el máximo que la fuente
 * oficial sostiene sin bloquear por IP— entre funciones que la necesitan a la
 * vez. Por eso la columna que de verdad importa no es "cada cuánto", sino
 * "cuándo": casi todo lo que aquí aparece está apagado la mayor parte del
 * tiempo, y ese es el motivo de que lo que queda encendido llegue a tiempo.
 */
function renderRefreshRulesCard(): string {
  const seconds = (ms: number) => `${Math.round(ms / 1000)} s`

  const rows: Array<[string, string, string]> = [
    [
      'Paradas guardadas',
      'una vez al abrir la app',
      'Una pasada por todas, en serie, para que la primera que despliegues ya tenga sus tiempos.',
    ],
    [
      'Parada desplegada',
      seconds(FRESHNESS.focused),
      'Solo la que esté abierta, y solo mientras lo esté. Plegada no enseña tiempos: pedirlos sería gastar cola para nada.',
    ],
    [
      'Ficha de una parada',
      seconds(FRESHNESS.focused),
      'La del buscador y la del mapa. Tocar una parada en el mapa ya lanza la consulta, antes de pulsar “Ver tiempos”.',
    ],
    [
      'Aviso de próximo bus',
      seconds(FRESHNESS.focused),
      `Solo si está activo. Con la app cerrada lo lleva el servicio en segundo plano, que consulta cada ${TRACKING_INTERVAL_SECONDS} s.`,
    ],
    [
      'Por dónde viene · mirándolo',
      seconds(FRESHNESS.routeVisible),
      `El recorrido entero (${ROUTE_WINDOW_STOPS} paradas) mientras la pestaña Seguir está delante. Son ${ROUTE_WINDOW_STOPS * 2} s de cola por vuelta: solo se sostiene con la pantalla puesta.`,
    ],
    [
      'Por dónde viene · de fondo',
      seconds(FRESHNESS.routeBackground),
      `Fuera de la pestaña solo se busca el "a N paradas" del aviso: con el autobús a menos de ${ROUTE_SCAN_MAX_MINUTES} min, hasta donde puede estar, y parando en la primera parada que lo tenga encima.`,
    ],
    [
      'Puntualidad',
      seconds(FRESHNESS.monitor),
      `Solo dentro de la franja del control. Con un autobús ya entrando se aprieta a ${seconds(
        FRESHNESS.focused,
      )}; fuera de la franja no se consulta nada.`,
    ],
  ]

  return `
    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Frecuencias de actualización</h3>
        <p class="card-sub">Cada cuánto se pide cada cosa, y con qué condición</p>
      </div></div>
      <div class="card-body">
        <div class="rule-list">
          ${rows
            .map(
              ([title, rate, condition]) => `
                <div class="rule-item">
                  <div class="rule-head">
                    <strong>${esc(title)}</strong>
                    <span class="pill">${esc(rate)}</span>
                  </div>
                  <span class="rule-when">${esc(condition)}</span>
                </div>
              `,
            )
            .join('')}
        </div>

        <dl class="kv">
          <dt>Entre peticiones</dt><dd>ráfaga corta y luego ${(MIN_REQUEST_SPACING_MS / 1000).toFixed(0)} s</dd>
          <dt>Lo que estás mirando</dt><dd>tiene consulta reservada: no hace cola</dd>
          <dt>Revisión del plan</dt><dd>cada segundo</dd>
          <dt>Lote automático</dt><dd>como mucho uno cada ${Math.round(AUTO_CYCLE_MS / 1000)} s</dd>
          <dt>“Al día” en pantalla</dt><dd>dato de hace menos de 40 s</dd>
          <dt>App en segundo plano</dt><dd>solo siguen el aviso activo y la puntualidad en franja</dd>
        </dl>

        <p class="text-tiny">
          Una parada solo se vuelve a pedir cuando su dato pasa del tiempo indicado, así que esos
          segundos son un máximo, no un reloj: si la cola está ocupada por algo más urgente, se
          espera. Lo que nunca ocurre es que dos consultas salgan a la vez.
        </p>
      </div>
    </section>
  `
}

/**
 * Cómo funcionan las funciones de seguimiento, en esquema.
 *
 * Los límites (dos por modalidad, dos activas) se notan al chocar con ellos, y
 * sin explicarlos en alguna parte la ventana que pide sustituir una función
 * parece un fallo en vez de una regla.
 */
function renderTrackingRulesCard(): string {
  return `
    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Seguimiento</h3>
        <p class="card-sub">Cuántas funciones puedes tener y cuántas trabajan a la vez</p>
      </div></div>
      <div class="card-body">
        <label class="field">
          <span>Autobuses por aviso</span>
          <select class="select" data-action="pick-bus-target">
            ${Array.from({ length: TRACKING_BUS_TARGET_MAX }, (_, index) => index + 1)
              .map(
                (value) =>
                  `<option value="${value}" ${value === trackingBusTarget() ? 'selected' : ''}>${
                    value === 1 ? 'Solo el próximo' : `${value} autobuses seguidos`
                  }</option>`,
              )
              .join('')}
          </select>
        </label>
        <p class="text-tiny">
          El aviso termina solo cuando ha visto pasar esa cantidad. Los avisos ya creados
          siguen con el número que haya elegido aquí.
        </p>

        <dl class="kv">
          <dt>Avisos creados</dt><dd>máximo ${MAX_TRACKING_JOBS}</dd>
          <dt>Actualizándose a la vez</dt><dd>${MAX_ACTIVE_JOBS}</dd>
          <dt>Al reanudar uno</dt><dd>se pausa automáticamente el otro</dd>
          <dt>Al crear uno de más</dt><dd>se pide cuál se sustituye</dd>
          <dt>Fuera de la pestaña Seguir</dt><dd>sigue avisando, sin dibujar el recorrido</dd>
          <dt>Midiendo puntualidad</dt><dd>sigue avisando, sin rastrear por dónde viene</dd>
        </dl>

        <p class="text-tiny">
          Un aviso hace las dos cosas que antes estaban separadas: la notificación con los minutos
          que faltan y el recorrido parada a parada con el autobús situado en una de ellas. Para lo
          segundo hace falta saber por qué sentido viene, y la fuente oficial nunca lo dice: cuando
          por tu parada pasa la línea en los dos sentidos, se pregunta al crear el aviso. Por el
          resto de paradas pasa uno solo y no hay nada que elegir.
        </p>

        ${renderSettingRow(
          'vibrate',
          'Vibración al acercarse',
          `Tres toques cortos cuando faltan ${TRACKING_WARN_MINUTES} minutos, una sola vez por autobús.`,
          state.settings.vibrateOnApproach,
          'toggle-vibration',
        )}

        <button class="btn btn-secondary btn-block" type="button" data-action="tour-open">
          ${icon('info')} Ver el tour de la aplicación
        </button>
      </div>
    </section>
  `
}

/**
 * Funciones en pruebas.
 *
 * Van en su propia tarjeta y no mezcladas con los ajustes de siempre: encender
 * algo experimental tiene que ser una decisión consciente, y apagarlo tiene que
 * ser fácil de encontrar cuando estorbe.
 */
function renderExperimentalCard(): string {
  return `
    <section class="card">
      <div class="card-head"><div class="card-head-copy">
        <h3 class="card-title">Experimental</h3>
        <p class="card-sub">En pruebas: puede cambiar o desaparecer</p>
      </div></div>
      <div class="card-body">
        ${renderSettingRow(
          'map',
          'Cómo llegar',
          'Cálculo de rutas en autobús entre dos puntos, dentro de la pestaña Info. Apagado no consume nada.',
          state.settings.experimentalMaps,
          'toggle-maps',
        )}
        <p class="text-tiny">
          Las rutas se calculan con el recorrido oficial de las líneas, así que los minutos son
          estimaciones y no horarios en firme. No consulta los tiempos de llegada en tiempo real:
          esa cola es para los seguimientos de próximo bus. El otro apartado de Info, los horarios
          de cada línea, no depende de este interruptor: sale del horario oficial que ya viaja
          dentro de la aplicación.
        </p>
      </div>
    </section>
  `
}

function renderSettingRow(
  iconName: string,
  title: string,
  description: string,
  enabled: boolean,
  action: string,
): string {
  return `
    <div class="perm-row">
      <div class="perm-copy">
        <strong>${esc(title)}</strong>
        <span>${esc(description)}</span>
      </div>
      <button
        class="switch${enabled ? ' is-on' : ''}"
        type="button"
        role="switch"
        aria-checked="${enabled}"
        data-action="${action}"
        aria-label="${esc(title)}"
      ><span class="switch-knob">${icon(iconName, 'switch-icon')}</span></button>
    </div>
  `
}

function renderPermissionRow(title: string, description: string, granted: string, action: string): string {
  const pill =
    granted === 'granted'
      ? '<span class="pill is-ok">Concedido</span>'
      : granted === 'denied'
        ? '<span class="pill is-error">Denegado</span>'
        : '<span class="pill is-warn">Pendiente</span>'

  return `
    <div class="perm-row">
      <div class="perm-copy">
        <strong>${esc(title)}</strong>
        <span>${esc(description)}</span>
      </div>
      ${
        granted === 'granted'
          ? pill
          : `<button class="btn btn-secondary btn-sm" type="button" data-action="${action}">Permitir</button>`
      }
    </div>
  `
}

/* ================================================================== *
 * Hojas inferiores                                                    *
 * ================================================================== */

function renderSheet(): string {
  const sheet = state.sheet
  if (!sheet) {
    return ''
  }

  const body =
    sheet.kind === 'stop-actions'
      ? renderStopActionsSheet(sheet.stopId)
      : sheet.kind === 'pick-line'
        ? renderPickLineSheet(sheet.stopId, sheet.purpose)
        : sheet.kind === 'replace-job'
          ? renderReplaceJobSheet(sheet.stopId)
          : renderRenameSheet(sheet.stopId)

  return `
    <button class="sheet-backdrop" type="button" data-action="close-sheet" aria-label="Cerrar"></button>
    <section class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-grip"></div>
      ${body}
    </section>
  `
}

function renderStopActionsSheet(stopId: string): string {
  return `
    <div class="sheet-head">
      <h3>${esc(stopName(stopId))}</h3>
      <p>Parada ${esc(stopId)}</p>
    </div>
    <div class="sheet-options">
      <button class="sheet-option" type="button" data-action="pick-line" data-stop="${esc(
        stopId,
      )}" data-purpose="tracking">
        ${icon('bell')}
        <span class="sheet-option-copy">
          <strong>Avisarme del próximo bus</strong>
          <span>Notificación fija con los minutos que faltan y por dónde viene · ${state.trackings.length} de ${MAX_TRACKING_JOBS} creados.</span>
        </span>
      </button>
      <button class="sheet-option" type="button" data-action="pick-line" data-stop="${esc(
        stopId,
      )}" data-purpose="monitor">
        ${icon('chart')}
        <span class="sheet-option-copy">
          <strong>Medir puntualidad</strong>
          <span>Anota a qué hora pasa realmente en una franja horaria.</span>
        </span>
      </button>
    </div>
  `
}

/**
 * Se ha alcanzado el tope de avisos creados.
 *
 * En vez de rechazar la acción con un error, se enseña lo que ya hay y se pide
 * cuál se sustituye: quien lo pide ya ha decidido que quiere este aviso nuevo, y
 * lo único que falta por saber es a costa de cuál.
 */
function renderReplaceJobSheet(stopId: string): string {
  return `
    <div class="sheet-head">
      <h3>Avisarme del próximo bus</h3>
      <p>Ya tienes ${MAX_TRACKING_JOBS} de ${MAX_TRACKING_JOBS}. Elige cuál se sustituye por el de ${esc(
        stopName(stopId),
      )}.</p>
    </div>

    <div class="sheet-options">
      ${state.trackings
        .map(
          (job) => `
        <button class="sheet-option" type="button" data-action="replace-job" data-stop="${esc(
          stopId,
        )}" data-job="${esc(job.id)}">
          ${lineChip(job.lineId, lineColor(job.lineId))}
          <span class="sheet-option-copy">
            <strong>${esc(job.stopName)}</strong>
            <span>${esc(describeArrival(job.stopId, job.lineId))} · ${job.active ? 'activo' : 'en pausa'}</span>
          </span>
          ${icon('chevron')}
        </button>
      `,
        )
        .join('')}
    </div>

    <button class="btn btn-secondary btn-block" type="button" data-action="close-sheet">
      Dejarlo como está
    </button>
  `
}

function renderPickLineSheet(stopId: string, purpose: 'tracking' | 'monitor'): string {
  const network = state.network
  const lines = network?.getLinesForStop(stopId) ?? []
  const selectedLineId = state.draft.lineId || lines[0]?.lineId || ''
  const directions = selectedLineId ? network?.getDirectionsThroughStop(stopId, selectedLineId) ?? [] : []

  const title = purpose === 'tracking' ? 'Avisarme del próximo bus' : 'Medir puntualidad'

  if (lines.length === 0) {
    return `
      <div class="sheet-head"><h3>${esc(title)}</h3></div>
      ${notice('warn', 'La red oficial no registra líneas para esta parada.')}
    `
  }

  return `
    <div class="sheet-head">
      <h3>${esc(title)}</h3>
      <p>${esc(stopName(stopId))}</p>
    </div>

    <label class="field">
      <span>Línea</span>
      <select class="select" data-action="draft-line" data-stop="${esc(stopId)}">
        ${lines
          .map(
            (line) =>
              `<option value="${esc(line.lineId)}" ${line.lineId === selectedLineId ? 'selected' : ''}>${esc(
                line.name,
              )}</option>`,
          )
          .join('')}
      </select>
    </label>

    ${
      // El sentido se pregunta cuando de verdad hay algo que elegir. En un
      // aviso no sirve para filtrar —la fuente no distingue sentidos, así que
      // sonará con cualquier autobús de la línea— sino para saber por dónde
      // viene y poder contar las paradas que faltan. Por el 93 % de las paradas
      // pasa un solo sentido de cada línea: ahí preguntar sería una pregunta
      // sin respuestas.
      purpose === 'tracking' && trackingDirectionOptions(stopId, selectedLineId).length < 2
        ? ''
        : `
      <label class="field">
        <span>Sentido</span>
        <select class="select" data-action="draft-direction">
          ${(purpose === 'tracking' ? trackingDirectionOptions(stopId, selectedLineId) : directions)
            .map(
              (direction) =>
                `<option value="${esc(direction.key)}" ${
                  direction.key === state.draft.directionKey ? 'selected' : ''
                }>${esc(directionLabel(direction))}</option>`,
            )
            .join('')}
          ${
            purpose === 'monitor'
              ? `<option value="" ${state.draft.directionKey ? '' : 'selected'}>Todos los sentidos</option>`
              : ''
          }
        </select>
      </label>
      ${
        purpose === 'monitor'
          ? '<span class="text-tiny">El horario programado se filtra por el sentido elegido; sin él las salidas de ida y vuelta se mezclan.</span>'
          : purpose === 'tracking'
            ? '<span class="text-tiny">Por esta parada pasa la línea en los dos sentidos. Sirve para decirte a cuántas paradas viene el autobús: el aviso sonará igual con cualquiera de los dos, porque la fuente oficial no los distingue.</span>'
            : ''
      }
    `
    }

    ${
      // Qué autobús: el próximo, o el de detrás para quien ya sabe que no llega
      // al primero. Con el segundo el aviso deja pasar uno y sigue al otro.
      purpose === 'tracking'
        ? `
      <label class="field">
        <span>Qué autobús</span>
        <select class="select" data-action="draft-skip">
          <option value="0" ${state.draft.skip === 1 ? '' : 'selected'}>El próximo</option>
          <option value="1" ${state.draft.skip === 1 ? 'selected' : ''}>El segundo (dejar pasar el próximo)</option>
        </select>
      </label>
    `
        : ''
    }

    ${
      purpose === 'monitor'
        ? `
      <div class="field">
        <span>Franja horaria</span>
        <div class="input-group">
          <input class="input" type="time" step="900" value="${esc(
            formatMinutesClock(state.draft.startMinutes),
          )}" data-action="draft-start" />
          <input class="input" type="time" step="900" value="${esc(
            formatMinutesClock(state.draft.endMinutes),
          )}" data-action="draft-end" />
        </div>
        <span class="text-tiny">Entre 15 minutos y 2 horas.</span>
      </div>
    `
        : ''
    }

    <button class="btn btn-primary btn-block" type="button" data-action="confirm-sheet" data-stop="${esc(
      stopId,
    )}" data-purpose="${purpose}">
      ${icon('check')} Confirmar
    </button>
  `
}

function renderRenameSheet(stopId: string): string {
  return `
    <div class="sheet-head">
      <h3>Nombre de la parada</h3>
      <p>${esc(stopName(stopId))}</p>
    </div>
    <label class="field">
      <span>Nombre personalizado</span>
      <input class="input" id="alias-input" type="text" maxlength="40" placeholder="${esc(
        stopName(stopId),
      )}" value="${esc(state.draft.alias)}" />
      <span class="text-tiny">Déjalo vacío para usar el nombre oficial.</span>
    </label>
    <button class="btn btn-primary btn-block" type="button" data-action="confirm-rename" data-stop="${esc(stopId)}">
      ${icon('check')} Guardar
    </button>
  `
}

