import { state } from './state'
import {
  NEAR_METERS,
  datedCut,
  fetchTrafficCuts,
  formatCutName,
  isSourceStale,
  loadLineShapes,
  lineImpacts,
  readCachedCuts,
  relevantCuts,
  sourceAgeDays,
  writeCachedCuts,
  type DatedCut,
  type LineImpact,
  type LineShape,
  type TrafficCut,
} from './services/traffic-cuts'
import { emptyState, esc, icon, lineChip, notice } from './ui'

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

/** Líneas que se pintan en el aviso de Inicio antes de resumir el resto. */
const NOTICE_MAX_LINES = 12

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

/* ------------------------------------------------------------------ *
 * Carga                                                                *
 * ------------------------------------------------------------------ */

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
 * Aviso compacto para Inicio.
 *
 * Solo sale si hay un corte EN CURSO que toca alguna línea: un corte que no
 * afecta a ninguna no es un aviso para quien espera el autobús, y los próximos
 * tienen su sitio en Info.
 */
export function renderTrafficCutsNotice(): string {
  const affecting = relevantCuts(cuts, new Date()).filter(
    (item) => item.status === 'active' && (impactsByCut.get(item.cut.id)?.length ?? 0) > 0,
  )
  if (affecting.length === 0) {
    return ''
  }

  const names = Array.from(new Set(affecting.map((item) => shortName(item.cut.name))))
  const shown = names.slice(0, 2).join(', ')
  const rest = names.length - 2
  const where = rest > 0 ? `${shown} y ${rest} más` : names.length === 2 ? names.join(' y ') : shown

  const lineIds = sortedLineIds(affecting.flatMap((item) => impactsByCut.get(item.cut.id) ?? []))
  const chips = lineIds.slice(0, NOTICE_MAX_LINES).map(chipFor).join('')
  const more = lineIds.length > NOTICE_MAX_LINES ? `<span class="text-tiny">+${lineIds.length - NOTICE_MAX_LINES}</span>` : ''

  return `
    <div class="notice is-warn traffic-notice" role="status">
      ${icon('warn')}
      <div class="traffic-notice-copy">
        <strong>${names.length === 1 ? 'Calle cortada al tráfico' : 'Calles cortadas al tráfico'}: ${esc(where)}</strong>
        <span>Puede afectar a ${lineIds.length === 1 ? 'la línea' : 'las líneas'}:</span>
        <span class="chip-row">${chips}${more}</span>
      </div>
      <button class="btn btn-secondary btn-sm" type="button" data-action="tab" data-tab="info">Detalle</button>
    </div>
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
  const later = cuts.filter((cut) => datedCut(cut, today).status === 'later').length
  const hasActive = items.some((item) => item.status === 'active')

  const body = items.length === 0
    ? `<div class="card-body">${emptyState(
        'check',
        'Sin cortes de tráfico',
        later > 0
          ? `No hay ningún corte en curso ni previsto en los próximos días. Hay ${later === 1 ? '1 programado' : `${later} programados`} para más adelante.`
          : 'No hay ningún corte en curso ni previsto en los próximos días.',
      )}</div>`
    : items.map((item) => renderCut(item, today)).join('')

  // La fecha que cuenta es la de la fuente: la de descarga solo dice cuándo se
  // consultó, y el portal lleva a veces semanas sin cambiar el fichero.
  const stale = isSourceStale(sourceModified, today)
  const staleNotice = stale && sourceModified !== null
    ? notice('warn', `La fuente lleva ${sourceAgeDays(sourceModified, today)} días sin actualizarse: puede haber cortes que no aparecen aquí.`)
    : ''
  const updated = sourceModified !== null
    ? `Datos del Ayuntamiento actualizados por última vez el ${esc(formatSourceDay(sourceModified, today))}.`
    : `Datos abiertos del Ayuntamiento de Salamanca, actualizados el ${esc(formatUpdated(fetchedAt))}.`

  return `
    ${head}
    ${staleNotice}
    <section class="card traffic-card">
      ${body}
    </section>
    ${
      items.length > 0 && !hasActive
        ? '<p class="text-tiny">Ahora mismo no hay ningún corte en curso; los de arriba empiezan en los próximos días.</p>'
        : ''
    }
    <p class="text-tiny">
      ${updated}
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

  const status = item.status === 'active'
    ? `<span class="pill is-warn">${item.daysLeft <= 1 ? 'Termina hoy' : `En curso · ${item.daysLeft} días`}</span>`
    : `<span class="pill">${item.daysToStart === 1 ? 'Empieza mañana' : `Empieza en ${item.daysToStart} días`}</span>`

  return `
    <div class="traffic-cut">
      <div class="traffic-cut-head">
        <strong class="traffic-cut-name">${esc(formatCutName(cut.name))}</strong>
        ${status}
      </div>
      <p class="text-tiny">${esc(formatRange(cut.start, cut.end, today))}</p>
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

/** "SAN FELIPE (+IGNACIO DE LOYOLA+...)" -> "San Felipe": para el aviso basta la calle principal. */
function shortName(name: string): string {
  return formatCutName(name.replace(/\s*\(.*$/, '').trim() || name)
}

/** "14 jul – 1 sep" (con el año solo cuando no es el actual). */
function formatRange(start: string, end: string, today: Date): string {
  return start === end
    ? formatDay(start, today)
    : `${formatDay(start, today)} – ${formatDay(end, today)}`
}

function formatDay(iso: string, today: Date): string {
  const [year, month, day] = iso.split('-').map((part) => Number.parseInt(part, 10))
  const label = new Date(year, month - 1, day).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
  return year === today.getFullYear() ? label : `${label} ${year}`
}

/** "9 de octubre" (con el año solo cuando no es el actual). */
function formatSourceDay(at: number, today: Date): string {
  const date = new Date(at)
  const label = date.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })
  return date.getFullYear() === today.getFullYear() ? label : `${label} de ${date.getFullYear()}`
}

function formatUpdated(at: number): string {
  return new Date(at).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
