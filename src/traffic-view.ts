import { state } from './state'
import {
  ALERT_SOON_DAYS,
  NEAR_METERS,
  STALE_SOURCE_DAYS,
  UPCOMING_DAYS,
  alertCuts,
  cutStatusLabel,
  describeCutDates,
  describeSourceUpdate,
  fetchTrafficCuts,
  formatCutName,
  isSourceStale,
  laterCuts,
  loadLineShapes,
  lineImpacts,
  readCachedCuts,
  relevantCuts,
  writeCachedCuts,
  type DatedCut,
  type LineImpact,
  type LineShape,
  type TrafficCut,
} from './services/traffic-cuts'
import { emptyState, esc, icon, lineChip } from './ui'

/**
 * Cortes de tráfico del Ayuntamiento: carga, refresco y pintado.
 *
 * Aquí vive el estado (cortes, trazado de las líneas, línea afectada por cada
 * corte); la lógica pura —parseo, fechas, cruce con el trazado— está en
 * `services/traffic-cuts.ts` y es la que cubren las pruebas.
 *
 * La carga nunca falla de cara a quien usa la app. En el navegador la fuente no
 * se puede leer (no tiene CORS) y en el móvil puede no haber conexión: en los
 * dos casos se enseñan los últimos datos buenos de la caché o, si no hay, un
 * estado vacío. Nada se registra como error ni se avisa con un aviso emergente.
 */

/**
 * Cada cuánto se vuelve a descargar el fichero.
 *
 * El Ayuntamiento lo actualiza más o menos una vez al día: pedirlo cada vez que
 * se abre la app sería gastar datos y trabajar su servidor por nada.
 */
const MIN_REFRESH_MS = 3 * 60 * 60 * 1000

/** Tras un fallo, cuánto se espera para intentarlo otra vez. */
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000

type Phase = 'idle' | 'loading' | 'ok' | 'error'

let cuts: TrafficCut[] = []
let fetchedAt: number | null = null
/** Cuándo cambió el fichero en la fuente (`Last-Modified`); null si no se conoce. */
let sourceModified: number | null = null
let phase: Phase = 'idle'
let notify: () => void = () => {}
let started = false
let inFlight = false
let lastAttemptAt = 0

let shapes: LineShape[] | null = null
let shapesPromise: Promise<LineShape[] | null> | null = null
let impactsByCut = new Map<string, LineImpact[]>()

/** Panel de cortes de Inicio desplegado. Solo en memoria: al reabrir la app vuelve plegado. */
let panelOpen = false

/* ------------------------------------------------------------------ *
 * Carga                                                                *
 * ------------------------------------------------------------------ */

/** Pliega o despliega el panel de cortes de Inicio; quien lo llama repinta. */
export function toggleTrafficCutsPanel(): void {
  panelOpen = !panelOpen
}

/** Arranca la carga: primero la caché, luego la red. Se llama una vez al arrancar. */
export function initTrafficCuts(onChange: () => void): void {
  notify = onChange
  if (started) {
    return
  }
  started = true

  void (async () => {
    const cached = readCachedCuts()
    if (cached) {
      cuts = cached.cuts
      fetchedAt = cached.fetchedAt
      sourceModified = cached.sourceModified
      await recomputeImpacts()
      notify()
    }

    await refresh()
  })()
}

/** Al volver la app a primer plano: descarga de nuevo solo si ya toca. */
export function refreshTrafficCuts(): void {
  void refresh()
}

async function refresh(): Promise<void> {
  if (inFlight) {
    return
  }

  const now = Date.now()
  const fresh = fetchedAt !== null && fetchedAt <= now && now - fetchedAt < MIN_REFRESH_MS
  if (fresh || now - lastAttemptAt < RETRY_AFTER_FAILURE_MS) {
    return
  }

  inFlight = true
  lastAttemptAt = now
  const failedBefore = phase === 'error'
  phase = 'loading'

  try {
    const downloaded = await fetchTrafficCuts()
    cuts = downloaded.cuts
    fetchedAt = Date.now()
    sourceModified = downloaded.sourceModified
    writeCachedCuts(downloaded.cuts, fetchedAt, new Date(fetchedAt), sourceModified)
    await recomputeImpacts()
    phase = 'ok'
    notify()
  } catch {
    // Sin conexión, o navegador sin CORS: se sigue con lo que hubiera.
    phase = 'error'
    if (!failedBefore && fetchedAt === null) {
      notify()
    }
  } finally {
    inFlight = false
  }
}

/** El trazado de las líneas pesa poco, pero solo se pide una vez por sesión. */
function ensureShapes(): Promise<LineShape[] | null> {
  if (shapes) {
    return Promise.resolve(shapes)
  }

  shapesPromise ??= loadLineShapes()
    .then((loaded) => {
      shapes = loaded
      return loaded
    })
    .catch(() => {
      // Se vuelve a intentar la próxima vez que haga falta.
      shapesPromise = null
      return null
    })

  return shapesPromise
}

async function recomputeImpacts(): Promise<void> {
  const loaded = await ensureShapes()
  const next = new Map<string, LineImpact[]>()

  if (loaded) {
    for (const cut of cuts) {
      next.set(cut.id, lineImpacts(cut, loaded))
    }
  }

  impactsByCut = next
}

/* ------------------------------------------------------------------ *
 * Pintado                                                              *
 * ------------------------------------------------------------------ */

/**
 * Icono de aviso de Inicio, con el panel de cortes que se despliega debajo.
 *
 * El icono está siempre. Apagado cuando no hay ningún corte en curso ni previsto
 * en los próximos `ALERT_SOON_DAYS` días; iluminado, con el número de cortes,
 * cuando los hay. Cuentan todos, afecten o no al trazado de alguna línea: lo que
 * se quiere saber es si la ciudad tiene calles cortadas. Plegado por defecto.
 */
export function renderTrafficCutsNotice(): string {
  const today = new Date()
  const alerts = alertCuts(cuts, today)
  const lit = alerts.length > 0
  const count = alerts.length

  // Sin datos todavía (cargando o sin red), apagado no puede decir «sin cortes».
  const unknown = fetchedAt === null
  const caption = lit
    ? `${count} ${count === 1 ? 'corte' : 'cortes'} de tráfico`
    : unknown
      ? phase === 'idle' || phase === 'loading' ? 'Consultando cortes de tráfico' : 'Cortes de tráfico: sin datos'
      : 'Sin cortes de tráfico'
  const label = lit
    ? `${caption}, en curso o ${count === 1 ? 'previsto' : 'previstos'} en los próximos ${ALERT_SOON_DAYS} días`
    : unknown
      ? caption
      : `${caption} activos ni previstos en los próximos ${ALERT_SOON_DAYS} días`

  return `
    <div class="traffic-alert${lit ? ' is-lit' : ''}">
      <button
        class="traffic-alert-toggle"
        type="button"
        data-action="toggle-traffic-cuts"
        aria-expanded="${panelOpen ? 'true' : 'false'}"
        ${panelOpen ? 'aria-controls="traffic-cuts-panel"' : ''}
        aria-label="${esc(`${label}. ${panelOpen ? 'Ocultar' : 'Ver'} información de cortes`)}"
      >
        <span class="traffic-alert-icon">
          ${icon('warn')}
          ${lit ? `<span class="traffic-alert-badge" aria-hidden="true">${count}</span>` : ''}
        </span>
        <span class="traffic-alert-caption">${esc(caption)}</span>
        ${icon('chevronDown', 'traffic-alert-chevron')}
      </button>
      ${panelOpen ? renderAlertPanel(alerts, today) : ''}
    </div>
  `
}

/** Panel desplegado: los cortes que encienden el icono o, si no hay, por qué está apagado. */
function renderAlertPanel(alerts: DatedCut[], today: Date): string {
  let body: string

  if (alerts.length > 0) {
    body = alerts.map((item) => renderCut(item, today)).join('')
  } else if (fetchedAt === null) {
    // Sin datos nunca: un icono apagado no puede pasar por «no hay cortes».
    body = `<p class="traffic-alert-empty">${
      phase === 'idle' || phase === 'loading'
        ? 'Consultando los cortes de tráfico del Ayuntamiento…'
        : 'No se han podido consultar los cortes de tráfico del Ayuntamiento. Se volverá a intentar cuando haya conexión.'
    }</p>`
  } else {
    body = `<p class="traffic-alert-empty">No hay cortes activos ni previstos en los próximos ${ALERT_SOON_DAYS} días.</p>`
  }

  // El dato con el que se ha decidido: sin él, «apagado» no dice cuán fiable es.
  let source = ''
  if (fetchedAt !== null) {
    const stale = isSourceStale(sourceModified, today)
    source = `
      <div class="traffic-alert-source${stale ? ' is-warn' : ''}">
        ${icon(stale ? 'warn' : 'clock')}
        <span>
          ${esc(describeSourceUpdate(sourceModified, fetchedAt, today))}.
          ${stale ? `Lleva más de ${STALE_SOURCE_DAYS} días sin cambios: puede haber cortes recientes que aún no aparecen aquí.` : ''}
        </span>
      </div>
    `
  }

  return `
    <section class="traffic-alert-panel" id="traffic-cuts-panel" aria-label="Cortes de tráfico">
      ${body}
      ${source}
      <div class="traffic-alert-foot">
        <button class="btn btn-secondary btn-sm" type="button" data-action="tab" data-tab="info">Ver detalle</button>
      </div>
    </section>
  `
}

/** Sección para la pestaña Info: cortes en curso y de los próximos días. */
export function renderTrafficCutsSection(): string {
  const head = `
    <div class="section-head">
      <h2>Cortes de tráfico</h2>
    </div>
  `

  // Nunca ha habido datos: navegador (la fuente no se puede leer) o sin conexión.
  if (fetchedAt === null) {
    if (phase === 'idle' || phase === 'loading') {
      return `${head}<p class="text-tiny">Consultando los cortes de tráfico del Ayuntamiento…</p>`
    }

    return `
      ${head}
      <section class="card"><div class="card-body">
        ${emptyState(
          'warn',
          'Sin datos de cortes',
          'No se han podido consultar los cortes de tráfico del Ayuntamiento. Se volverá a intentar cuando haya conexión.',
        )}
      </div></section>
    `
  }

  const today = new Date()
  const items = relevantCuts(cuts, today)
  const later = laterCuts(cuts, today)
  const hasActive = items.some((item) => item.status === 'active')

  // La fecha que cuenta es la de la fuente: la de descarga solo dice cuándo se
  // consultó, y el portal lleva a veces semanas sin cambiar el fichero. El aviso
  // de fuente antigua va dentro de este mismo bloque para no repetir la fecha.
  const stale = isSourceStale(sourceModified, today)
  const updated = `
    <div class="traffic-updated${stale ? ' is-warn' : ''}" role="status">
      ${icon(stale ? 'warn' : 'clock')}
      <div class="traffic-updated-copy">
        <strong>${esc(describeSourceUpdate(sourceModified, fetchedAt, today))}</strong>
        ${
          stale
            ? `<span>Lleva más de ${STALE_SOURCE_DAYS} días sin cambios: puede haber cortes recientes que aún no aparecen aquí.</span>`
            : ''
        }
      </div>
    </div>
  `

  const soon = items.length === 0
    ? `<section class="card traffic-card"><div class="card-body">${emptyState(
        'check',
        'Sin cortes en curso ni próximos',
        'No hay ningún corte en curso ni previsto en los próximos días.',
      )}</div></section>`
    : `<section class="card traffic-card">${items.map((item) => renderCut(item, today)).join('')}</section>`

  const soonGroup = later.length > 0 && items.length > 0
    ? `<h3 class="traffic-group">En curso y próximos ${UPCOMING_DAYS} días</h3>${soon}`
    : soon

  const laterGroup = later.length > 0
    ? `
      <h3 class="traffic-group">Programados más adelante</h3>
      <section class="card traffic-card">${later.map((item) => renderCut(item, today)).join('')}</section>
    `
    : ''

  return `
    ${head}
    ${updated}
    ${soonGroup}
    ${
      items.length > 0 && !hasActive
        ? '<p class="text-tiny">Ahora mismo no hay ningún corte en curso; los de arriba empiezan en los próximos días.</p>'
        : ''
    }
    ${laterGroup}
    <p class="text-tiny">
      Las fechas son días completos: la fuente no indica la hora de inicio ni de fin.
      Las líneas se estiman por cercanía de su trazado al corte (a menos de ${NEAR_METERS} m de la calle): no es un
      aviso oficial de desvíos y un corte puede dejar un carril libre.
    </p>
  `
}

function renderCut(item: DatedCut, today: Date): string {
  const { cut } = item
  const impacts = impactsByCut.get(cut.id)

  let lines: string
  if (!impacts) {
    lines = '<p class="text-tiny">No se ha podido estimar qué líneas pasan por aquí.</p>'
  } else if (impacts.length === 0) {
    lines = '<p class="text-tiny">No parece afectar al trazado de ninguna línea.</p>'
  } else {
    lines = `
      <p class="text-tiny">Líneas posiblemente afectadas:</p>
      <span class="chip-row">${sortedLineIds(impacts).map(chipFor).join('')}</span>
    `
  }

  const status = `<span class="pill${item.status === 'active' ? ' is-warn' : ''}">${esc(cutStatusLabel(item))}</span>`

  return `
    <div class="traffic-cut">
      <div class="traffic-cut-head">
        <strong class="traffic-cut-name">${esc(formatCutName(cut.name))}</strong>
        ${status}
      </div>
      <p class="traffic-cut-dates">${esc(describeCutDates(cut, today))}</p>
      ${lines}
    </div>
  `
}

/* ------------------------------------------------------------------ *
 * Utilidades de pintado                                                *
 * ------------------------------------------------------------------ */

function chipFor(lineId: string): string {
  return lineChip(lineId, state.network?.getLineColor(lineId) ?? '#173764', 'sm')
}

function sortedLineIds(impacts: LineImpact[]): string[] {
  return Array.from(new Set(impacts.map((impact) => impact.lineId))).sort((left, right) =>
    left.localeCompare(right, 'es', { numeric: true }),
  )
}
