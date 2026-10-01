import type { StopSyncPhase } from './state'
import type { Arrival, StopFeed } from './types'

/* ------------------------------------------------------------------ *
 * Escapado                                                             *
 * ------------------------------------------------------------------ */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/* ------------------------------------------------------------------ *
 * Iconos (contorno de 24px, heredan currentColor)                      *
 * ------------------------------------------------------------------ */

const ICONS: Record<string, string> = {
  home: '<path d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  star: '<path d="m12 3.5 2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.8l6-.8z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  bus: '<rect x="4" y="3" width="16" height="14" rx="3"/><path d="M4 9h16"/><circle cx="8" cy="13.5" r="1.2"/><circle cx="16" cy="13.5" r="1.2"/><path d="M6 17v2.5M18 17v2.5"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
  bellOff: '<path d="M18 8a6 6 0 0 0-9.3-5"/><path d="M6 9c0 6-2 7-2 7h13"/><path d="m3 3 18 18"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/>',
  pencil: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  map: '<path d="m9 4 6 2 5-2v14l-5 2-6-2-5 2V6z"/><path d="M9 4v14M15 6v14"/>',
  pin: '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  warn: '<path d="M10.3 4 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  skip: '<path d="M6 5.5v13l9-6.5z"/><path d="M18 5v14"/>',
  down: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  up: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  vibrate: '<rect x="9" y="4" width="6" height="16" rx="2"/><path d="M5 9v6M19 9v6M2 11v2M22 11v2"/>',
  /** Punto de mira: "centrar en mi ubicacion". */
  crosshair:
    '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  /** Silueta andando, para los tramos a pie de una ruta. */
  walk: '<circle cx="13" cy="4" r="1.8"/><path d="M11 21l1.5-5.5L10 13l1-5 3 2 2.5 1"/><path d="M10 8 7 10l-1 3"/><path d="m12.5 15.5 3 5.5"/>',
  /** Dos flechas encontradas: intercambiar origen y destino. */
  swap: '<path d="M7 4v16"/><path d="m4 7 3-3 3 3"/><path d="M17 20V4"/><path d="m14 17 3 3 3-3"/>',
}

export function icon(name: keyof typeof ICONS | string, extraClass = ''): string {
  const body = ICONS[name] ?? ICONS.info
  // width/height explicitos: sin ellos un SVG sin dimensionar por CSS se estira
  // hasta romper la maquetacion. Las reglas de CSS los sobrescriben cuando toca.
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${
    extraClass ? ` class="${esc(extraClass)}"` : ''
  }>${body}</svg>`
}

/* ------------------------------------------------------------------ *
 * Distintivo de línea                                                  *
 * ------------------------------------------------------------------ */

export function lineChip(lineId: string, color: string, size: 'sm' | 'md' | 'lg' = 'md'): string {
  const sizeClass = size === 'lg' ? ' is-lg' : size === 'sm' ? ' is-sm' : ''
  return `<span class="line-chip${sizeClass}" style="background:${esc(color)};color:${esc(
    readableTextColor(color),
  )}">${esc(lineId)}</span>`
}

/** Blanco o negro segun el contraste con el color de fondo de la linea. */
export function readableTextColor(background: string): string {
  const hex = background.replace('#', '')
  if (hex.length !== 6) {
    return '#ffffff'
  }

  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)

  // Luminancia relativa aproximada (sRGB).
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.62 ? '#10203d' : '#ffffff'
}

/* ------------------------------------------------------------------ *
 * Formato                                                              *
 * ------------------------------------------------------------------ */

export function formatClock(date: Date): string {
  return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
}

export function formatClockSeconds(date: Date): string {
  return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatLongDate(date: Date): string {
  return date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })
}

/** "hace 12 s" / "hace 3 min" — para envejecer datos en pantalla. */
export function formatAge(fromEpochMs: number | null): string {
  if (!fromEpochMs) {
    return 'sin datos'
  }

  const seconds = Math.max(0, Math.round((Date.now() - fromEpochMs) / 1000))
  if (seconds < 10) {
    return 'ahora mismo'
  }
  if (seconds < 60) {
    return `hace ${seconds} s`
  }

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `hace ${minutes} min`
  }

  return `hace ${Math.round(minutes / 60)} h`
}

/**
 * Los minutos que devuelve la fuente son una foto del momento en que se
 * consultaron. Si el dato tiene 90 s, mostrar el valor original engaña; esta
 * funcion lo descuenta para que la cuenta atras siga siendo veraz.
 */
export function liveMinutes(arrival: Arrival): number {
  const elapsedMinutes = Math.floor((Date.now() - arrival.observedAt) / 60_000)
  return Math.max(0, arrival.minutesUntil - elapsedMinutes)
}

export function renderEta(arrival: Arrival): string {
  const minutes = liveMinutes(arrival)

  if (arrival.status === 'arriving' || minutes <= 0) {
    return `<span class="eta-now">Llegando</span>`
  }

  return `<span class="eta-value">${minutes}</span><span class="eta-unit"> min</span>`
}

export function arrivalTone(arrival: Arrival): string {
  const minutes = liveMinutes(arrival)
  if (arrival.status === 'arriving' || minutes <= 1) {
    return ' is-now'
  }
  if (minutes <= 5) {
    return ' is-soon'
  }
  return ''
}

/* ------------------------------------------------------------------ *
 * Estado del feed de una parada                                        *
 * ------------------------------------------------------------------ */

export function feedPill(feed: StopFeed | undefined): string {
  if (!feed) {
    return `<span class="pill">Sin consultar</span>`
  }

  if (feed.status === 'ok') {
    return `<span class="pill is-ok is-live">En vivo · ${esc(formatAge(feed.fetchedAt))}</span>`
  }

  if (feed.status === 'empty') {
    return `<span class="pill">Sin servicio ahora</span>`
  }

  if (feed.status === 'throttled') {
    return `<span class="pill is-warn">Fuente saturada · dato de ${esc(formatAge(feed.fetchedAt))}</span>`
  }

  return `<span class="pill is-error">Sin conexión</span>`
}

/* ------------------------------------------------------------------ *
 * Estado de sincronizacion de una parada                               *
 * ------------------------------------------------------------------ */

/** A partir de aqui un dato "en vivo" ya no lo es: se marca como envejecido. */
/**
 * Hasta aqui un dato se considera "al dia".
 *
 * Cuarenta segundos: es el doble del ciclo de refresco de un recorrido activo
 * (20 s), asi que una parada al dia es la que ha entrado en uno de los dos
 * ultimos ciclos. Con el minuto de antes, una parada podia haberse saltado dos
 * ciclos enteros y seguir pintada de verde.
 */
const SYNC_FRESH_MS = 40_000

export type SyncTone = 'loading' | 'queued' | 'fresh' | 'aged' | 'idle' | 'warn' | 'error'

/**
 * Resuelve el estado de refresco de una parada combinando la cola de consultas
 * con el resultado ya guardado. Las paradas se piden de una en una, asi que en
 * una lista larga hay siempre varias fases conviviendo en pantalla.
 */
export function syncState(
  feed: StopFeed | undefined,
  phase: StopSyncPhase | undefined,
): { tone: SyncTone, label: string } {
  if (phase === 'loading') {
    return { tone: 'loading', label: 'Consultando ahora' }
  }
  if (phase === 'queued') {
    return { tone: 'queued', label: 'Esperando turno' }
  }
  if (!feed) {
    return { tone: 'idle', label: 'Sin consultar todavía' }
  }
  if (feed.status === 'error') {
    return { tone: 'error', label: 'Sin conexión con la fuente' }
  }
  if (feed.status === 'throttled') {
    return { tone: 'warn', label: `Fuente saturada · dato de ${formatAge(feed.fetchedAt)}` }
  }
  if (feed.status === 'empty') {
    return { tone: 'idle', label: `Sin servicio ahora · ${formatAge(feed.fetchedAt)}` }
  }
  if (Date.now() - feed.fetchedAt <= SYNC_FRESH_MS) {
    return { tone: 'fresh', label: `Al día · ${formatAge(feed.fetchedAt)}` }
  }
  return { tone: 'aged', label: `Dato de ${formatAge(feed.fetchedAt)}` }
}

/** Punto de color con el estado de refresco. Lleva el texto para lectores de pantalla. */
export function syncDot(feed: StopFeed | undefined, phase: StopSyncPhase | undefined): string {
  const { tone, label } = syncState(feed, phase)
  return `<span class="sync-dot is-${tone}" title="${esc(label)}" role="img" aria-label="${esc(
    label,
  )}"></span>`
}

export function emptyState(iconName: string, title: string, description: string, action = ''): string {
  return `
    <div class="empty">
      ${icon(iconName)}
      <strong>${esc(title)}</strong>
      <p>${esc(description)}</p>
      ${action}
    </div>
  `
}

export function notice(tone: 'info' | 'warn' | 'error', message: string): string {
  const toneClass = tone === 'warn' ? ' is-warn' : tone === 'error' ? ' is-error' : ''
  const iconName = tone === 'info' ? 'info' : 'warn'
  return `<div class="notice${toneClass}">${icon(iconName)}<span>${esc(message)}</span></div>`
}
