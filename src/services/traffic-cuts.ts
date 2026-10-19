import { Capacitor, CapacitorHttp } from '@capacitor/core'

/**
 * Cortes de tráfico del Ayuntamiento y líneas a las que pueden afectar.
 *
 * DE DONDE SALEN
 *
 * Del catálogo de datos abiertos del Ayuntamiento de Salamanca: un GeoJSON de
 * `LineString` (coordenadas [lon, lat, 0] en WGS84) con una calle cortada por
 * elemento. Las propiedades son todas texto: `ID`, `Name`, `fecha_inicio` y
 * `fecha_fin` (dd/MM/yyyy, sin hora; el día de fin cuenta entero). El fichero
 * trae cortes ya terminados y futuros, así que se filtra aquí, en cliente, y se
 * actualiza, según el portal, a diario. En la práctica ha pasado semanas
 * sin cambiar, así que la cabecera `Last-Modified` de la descarga se guarda y
 * la app avisa cuando la fuente lleva demasiados días parada (ver
 * `isSourceStale`).
 *
 * Se sirve como `application/octet-stream` y sin cabecera CORS:
 *
 *   - en Android se pide con CapacitorHttp, que no está sujeto a CORS, y se
 *     parsea el TEXTO como JSON (por el tipo de contenido no se deserializa);
 *   - en el navegador el `fetch` falla, y es un fallo esperado: la app sigue sin
 *     datos de cortes, sin ningún error visible.
 *
 * COMO SE ESTIMA LA AFECTACIÓN
 *
 * Sin una fuente que diga qué líneas desvía cada corte, lo único que se puede
 * hacer es cruzar la geometría del corte con el trazado de cada línea
 * (`public/data/line-shapes.json`, que sale del GTFS: ver
 * `tools/build-line-shapes.mjs`). Es una ESTIMACIÓN por cercanía, no un aviso
 * oficial, y así se le dice a quien la lee. Una línea sale como «posiblemente
 * afectada» si se cumple UNA de estas dos cosas:
 *
 *   1. Va por la misma calle. Se recorre el trazado de la línea cada 5 m y se
 *      cuentan los tramos que están a menos de 25 m del corte Y apuntan casi en
 *      su misma dirección (menos de 35° de diferencia, sin importar el sentido
 *      de la marcha). Si esos tramos suman al menos 30 m, el corte cae sobre la
 *      ruta. El umbral de dirección es lo que evita marcar las líneas que solo
 *      cruzan la calle cortada de lado, y contar sobre el trazado de la línea y
 *      no sobre el corte hace que las geometrías que van y vienen sobre sí
 *      mismas no cuenten dos veces. En cortes muy cortos (menos de 60 m) el
 *      umbral baja a la mitad del corte, con un mínimo de 10 m.
 *
 *   2. Cruza por donde está cortado. La calle cortada ATRAVIESA el trazado de la
 *      línea (un tramo del corte y uno de la línea se tocan a menos de 3 m, con
 *      ángulo claro entre ellos). Aquí la calle cortada es la que cruza, y si
 *      el corte pasa por encima de la ruta, el autobús no puede pasar. Un corte
 *      que solo llega hasta la boca de la avenida, sin alcanzar su eje, no
 *      cuenta: la línea que va por la avenida sigue pudiendo pasar.
 *
 * Ninguno de los dos criterios sabe nada de desvíos ni de obras que dejen un
 * carril libre: por eso la palabra es «posiblemente».
 */

/** Fichero de cortes de tráfico del Ayuntamiento. */
export const TRAFFIC_CUTS_URL =
  'https://opendata.aytosalamanca.es/datosabiertos/catalogo/dataset/888e10b0-ec06-4c5c-a09b-d204af56edc6/resource/9d395296-d9a8-4488-8290-d6d7160a141f/download/cortes_trafico.geojson'

/** Trazado de las líneas generado a partir del GTFS. */
export const LINE_SHAPES_URL = '/data/line-shapes.json'

/** Días de antelación con los que se avisa de un corte que aún no ha empezado. */
export const UPCOMING_DAYS = 7

/** Distancia máxima entre el corte y la línea para considerarlos la misma calle. */
export const NEAR_METERS = 25

/** Longitud mínima de trazado de la línea que debe caer sobre el corte. */
export const MIN_ALONG_METERS = 30

/** Diferencia máxima de dirección para considerar que van por la misma calle. */
export const PARALLEL_DEGREES = 35

/** Distancia a la que el corte «toca» el trazado de la línea al cruzarlo. */
export const CROSS_METERS = 3

/**
 * Días sin cambios en la fuente a partir de los cuales se avisa de que los datos
 * están desactualizados. El portal dice actualizarse a diario, pero el fichero ha
 * llegado a pasar semanas sin cambiar.
 */
export const STALE_SOURCE_DAYS = 3

/** Separación de las muestras tomadas sobre el trazado de la línea. */
const SAMPLE_STEP_METERS = 5

const METERS_PER_DEGREE = 111_195

/** [latitud, longitud] */
export type LatLon = [number, number]

export interface TrafficCut {
  id: string
  /** Nombre tal cual lo publica la fuente (en mayúsculas). */
  name: string
  /** Primer día del corte, `YYYY-MM-DD`. */
  start: string
  /** Último día del corte (incluido entero), `YYYY-MM-DD`. */
  end: string
  /** La geometría, en una o varias polilíneas. */
  parts: LatLon[][]
}

export type CutStatus = 'active' | 'upcoming' | 'later' | 'past'

export interface DatedCut {
  cut: TrafficCut
  status: CutStatus
  /** Días hasta que empieza (0 si ya está en marcha o empieza hoy). */
  daysToStart: number
  /** Días que le quedan, contando hoy (1 = acaba hoy). 0 si ya acabó. */
  daysLeft: number
}

/** Trazado de un trayecto de una línea. */
export interface LineShape {
  lineId: string
  /** Sentidos de la red oficial que recorren este trazado (puede no haber ninguno). */
  directionKeys: string[]
  points: LatLon[]
}

export interface LineImpact {
  lineId: string
  directionKeys: string[]
  /** Metros del trazado de la línea que caen sobre el corte. */
  alongMeters: number
  /** El corte atraviesa el trazado de la línea. */
  crossing: boolean
}

/* ------------------------------------------------------------------ *
 * Fechas                                                               *
 * ------------------------------------------------------------------ */

/**
 * "dd/MM/yyyy" -> "YYYY-MM-DD", o null si no es una fecha real.
 *
 * Se comprueba que el día exista (31/02 no vale), porque `Date` lo corregiría
 * en silencio al día 3 de marzo y un corte acabaría en una fecha inventada.
 */
export function parseCutDate(value: unknown): string | null {
  const match = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(value ?? ''))
  if (!match) {
    return null
  }

  const day = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const year = Number.parseInt(match[3], 10)

  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Día civil (sin hora) como número de días, para restar fechas sin husos. */
function dayNumber(iso: string): number {
  const [year, month, day] = iso.split('-').map((part) => Number.parseInt(part, 10))
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000)
}

/**
 * Fecha HTTP (`Last-Modified`: «Thu, 09 Oct 2026 07:28:00 GMT») -> milisegundos
 * desde 1970, o null si no es una fecha real.
 *
 * Se exige el formato de fecha de HTTP completo: `Date.parse` por sí solo acepta
 * cosas como «12345» o «ayer 3», y una fecha de fuente inventada es peor que no
 * tener ninguna.
 */
export function parseHttpDate(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null
  }

  const text = value.trim()
  const match = /^[A-Za-z]{3}, (\d{1,2}) [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.exec(text)
  if (!match) {
    return null
  }

  // `Date.parse` corrige en silencio «31 Feb» al 3 de marzo: se comprueba que
  // el día no se haya movido.
  const time = Date.parse(text)
  return Number.isFinite(time) && new Date(time).getUTCDate() === Number.parseInt(match[1], 10) ? time : null
}

/** Valor de una cabecera sin distinguir mayúsculas (en Android llegan como sea). */
export function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') {
    return null
  }

  // `Headers` de fetch: sus valores no son propiedades del objeto.
  if (typeof (headers as Headers).get === 'function') {
    try {
      return (headers as Headers).get(name)
    } catch {
      return null
    }
  }

  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === wanted) {
      const first = Array.isArray(value) ? value[0] : value
      return typeof first === 'string' ? first : null
    }
  }

  return null
}

/** Cuándo cambió la fuente por última vez, según su `Last-Modified`; null si no lo dice. */
export function sourceModifiedFromHeaders(headers: unknown): number | null {
  return parseHttpDate(headerValue(headers, 'last-modified'))
}

/**
 * Días enteros que lleva la fuente sin cambiar, contados por día civil local
 * (0 = se modificó hoy). Una fecha en el futuro, por un reloj descuadrado, cuenta 0.
 */
export function sourceAgeDays(sourceModified: number, today: Date): number {
  return Math.max(0, dayNumber(localIsoDay(today)) - dayNumber(localIsoDay(new Date(sourceModified))))
}

/** La fuente lleva más de `STALE_SOURCE_DAYS` días sin actualizarse. */
export function isSourceStale(sourceModified: number | null, today: Date): boolean {
  return sourceModified !== null && sourceAgeDays(sourceModified, today) > STALE_SOURCE_DAYS
}

/** Fecha local del dispositivo como `YYYY-MM-DD`. */
export function localIsoDay(at: Date): string {
  return `${String(at.getFullYear()).padStart(4, '0')}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(
    at.getDate(),
  ).padStart(2, '0')}`
}

/**
 * Estado de un corte respecto a un día.
 *
 *   - `active`: hoy está entre el primer y el último día, ambos incluidos.
 *   - `upcoming`: empieza en los próximos `horizonDays` días.
 *   - `later`: empieza más tarde de eso.
 *   - `past`: ya terminó.
 */
export function datedCut(cut: TrafficCut, today: Date, horizonDays = UPCOMING_DAYS): DatedCut {
  const now = dayNumber(localIsoDay(today))
  const start = dayNumber(cut.start)
  const end = dayNumber(cut.end)

  if (end < now) {
    return { cut, status: 'past', daysToStart: 0, daysLeft: 0 }
  }

  if (start <= now) {
    return { cut, status: 'active', daysToStart: 0, daysLeft: end - now + 1 }
  }

  const daysToStart = start - now
  return {
    cut,
    status: daysToStart <= horizonDays ? 'upcoming' : 'later',
    daysToStart,
    daysLeft: end - now + 1,
  }
}

/** Cortes que interesan hoy: primero los activos (por fin) y luego los próximos (por inicio). */
export function relevantCuts(cuts: TrafficCut[], today: Date, horizonDays = UPCOMING_DAYS): DatedCut[] {
  return cuts
    .map((cut) => datedCut(cut, today, horizonDays))
    .filter((item) => item.status === 'active' || item.status === 'upcoming')
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === 'active' ? -1 : 1
      }
      if (left.status === 'active') {
        return left.cut.end.localeCompare(right.cut.end) || left.cut.name.localeCompare(right.cut.name, 'es')
      }
      return left.cut.start.localeCompare(right.cut.start) || left.cut.name.localeCompare(right.cut.name, 'es')
    })
}

/** Días de antelación con los que el icono de aviso de Inicio se ilumina por un corte aún no empezado. */
export const ALERT_SOON_DAYS = 3

/**
 * Cortes que justifican iluminar el aviso de Inicio: los que están en curso y los
 * que empiezan en `soonDays` días o menos (hoy cuenta 0, mañana 1). Los que
 * empiezan más tarde o ya terminaron no entran.
 *
 * Mismo orden que `relevantCuts`: primero los en curso, por fin; luego los
 * próximos, por inicio; y a igualdad, por nombre. Los días se cuentan como días
 * civiles locales, así que ni la zona horaria ni el cambio de hora lo alteran.
 */
export function alertCuts(cuts: TrafficCut[], today: Date, soonDays = ALERT_SOON_DAYS): DatedCut[] {
  // Con `soonDays` como horizonte, `upcoming` ya significa «empieza en ≤ soonDays días».
  return relevantCuts(cuts, today, soonDays)
}

/** Cortes con fecha de inicio más allá del horizonte de aviso, por inicio. */
export function laterCuts(cuts: TrafficCut[], today: Date, horizonDays = UPCOMING_DAYS): DatedCut[] {
  return cuts
    .map((cut) => datedCut(cut, today, horizonDays))
    .filter((item) => item.status === 'later')
    .sort((left, right) => left.cut.start.localeCompare(right.cut.start) || left.cut.name.localeCompare(right.cut.name, 'es'))
}

/* ------------------------------------------------------------------ *
 * Fechas para mostrar                                                  *
 * ------------------------------------------------------------------ */

/*
 * Los nombres de los meses van aquí y no salen de `toLocaleDateString`: así el
 * texto es el mismo en cualquier móvil (y en las pruebas) sin depender del ICU
 * ni del idioma del dispositivo. La fuente solo da días, sin hora, y el último
 * día cuenta entero.
 */
const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

function isoParts(iso: string): { year: number, month: number, day: number } {
  const [year, month, day] = iso.split('-').map((part) => Number.parseInt(part, 10))
  return { year, month, day }
}

/** "2026-09-01" -> "1 de septiembre de 2026" (el año siempre, sin ambigüedad). */
export function formatLongDay(iso: string): string {
  const { year, month, day } = isoParts(iso)
  return `${day} de ${MONTHS[month - 1]} de ${year}`
}

/** "2026-09-01" -> "1 de septiembre" (sin año: para el primer extremo de un rango). */
function formatDayMonth(iso: string): string {
  const { month, day } = isoParts(iso)
  return `${day} de ${MONTHS[month - 1]}`
}

/** "2026-09-30" -> "30 sep" (con el año solo cuando no es el actual). */
export function formatShortDay(iso: string, today: Date): string {
  const { year, month, day } = isoParts(iso)
  const label = `${day} ${MONTHS_SHORT[month - 1]}`
  return year === today.getFullYear() ? label : `${label} ${year}`
}

/**
 * Fechas de un corte con el año siempre en el rango completo:
 *
 *   - «Del 14 de julio al 1 de septiembre de 2026»
 *   - «Del 20 de diciembre de 2026 al 10 de enero de 2027» (si cruza de año)
 *   - «Solo el 28 de agosto de 2026» (inicio = fin); «Solo hoy» / «Solo mañana»
 *   - «Desde hoy hasta el 1 de septiembre de 2026» / «Desde mañana hasta …»
 *   - «Hoy es el último día (desde el 14 de julio de 2026)»
 */
export function describeCutDates(cut: Pick<TrafficCut, 'start' | 'end'>, today: Date): string {
  const now = dayNumber(localIsoDay(today))
  const start = dayNumber(cut.start)
  const end = dayNumber(cut.end)

  if (cut.start === cut.end) {
    if (start === now) {
      return `Solo hoy (${formatLongDay(cut.start)})`
    }
    return start === now + 1 ? `Solo mañana (${formatLongDay(cut.start)})` : `Solo el ${formatLongDay(cut.start)}`
  }

  if (end === now) {
    return `Hoy es el último día (desde el ${formatLongDay(cut.start)})`
  }
  if (start === now) {
    return `Desde hoy hasta el ${formatLongDay(cut.end)}`
  }
  if (start === now + 1) {
    return `Desde mañana hasta el ${formatLongDay(cut.end)}`
  }

  const sameYear = isoParts(cut.start).year === isoParts(cut.end).year
  const sameMonth = sameYear && isoParts(cut.start).month === isoParts(cut.end).month
  const from = sameMonth ? String(isoParts(cut.start).day) : sameYear ? formatDayMonth(cut.start) : formatLongDay(cut.start)
  return `Del ${from} al ${formatLongDay(cut.end)}`
}

/** Etiqueta de estado de un corte: «Termina hoy», «En curso · 5 días», «Empieza mañana», «Empieza en 3 meses». */
export function cutStatusLabel(item: Pick<DatedCut, 'status' | 'daysToStart' | 'daysLeft'>): string {
  if (item.status === 'active') {
    return item.daysLeft <= 1 ? 'Termina hoy' : `En curso · ${item.daysLeft} días`
  }
  if (item.daysToStart === 1) {
    return 'Empieza mañana'
  }
  if (item.daysToStart >= 60) {
    return `Empieza en ${Math.round(item.daysToStart / 30)} meses`
  }
  return `Empieza en ${item.daysToStart} días`
}

/** Fin de un corte para el aviso compacto: «hasta hoy», «hasta mañana», «hasta el 30 sep». */
export function untilLabel(end: string, today: Date): string {
  const days = dayNumber(end) - dayNumber(localIsoDay(today))
  if (days <= 0) {
    return 'hasta hoy'
  }
  return days === 1 ? 'hasta mañana' : `hasta el ${formatShortDay(end, today)}`
}

/** «hoy», «ayer» o «hace N días» según los días civiles que lleva la fuente sin cambiar. */
export function sourceAgeLabel(days: number): string {
  return days <= 0 ? 'hoy' : days === 1 ? 'ayer' : `hace ${days} días`
}

/**
 * Línea de «cuándo se actualizó el documento».
 *
 * Con la fecha de la fuente (`Last-Modified`): «Documento del Ayuntamiento
 * actualizado el 9 de octubre de 2026 (hace 8 días)». Sin ella (el navegador no
 * la ve y el servidor puede no mandarla) solo se puede decir cuándo se consultó.
 */
export function describeSourceUpdate(sourceModified: number | null, fetchedAt: number, today: Date): string {
  if (sourceModified !== null) {
    const date = localIsoDay(new Date(sourceModified))
    const line = `Documento del Ayuntamiento actualizado el ${formatLongDay(date)}`
    // Una fecha de otro día por venir (reloj descuadrado) no es «hoy»: va sin antigüedad.
    return dayNumber(date) > dayNumber(localIsoDay(today))
      ? line
      : `${line} (${sourceAgeLabel(sourceAgeDays(sourceModified, today))})`
  }

  const when = new Date(fetchedAt)
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  return `Consultado el ${formatLongDay(localIsoDay(when))} a las ${time} (la fuente no indica su fecha)`
}

/* ------------------------------------------------------------------ *
 * Descarga y parseo                                                    *
 * ------------------------------------------------------------------ */

/**
 * Convierte el GeoJSON del Ayuntamiento en cortes.
 *
 * Un elemento mal formado (sin fechas reales, sin geometría) se salta sin
 * tirar el resto: la fuente la rellena una persona. Si el documento entero no
 * es un `FeatureCollection` sí falla, porque entonces no es lo que se esperaba
 * y guardarlo como «sin cortes» sería mentir.
 */
export function parseTrafficCuts(body: string): TrafficCut[] {
  const document = JSON.parse(body.replace(/^﻿/, '')) as unknown
  const features = (document as { type?: unknown, features?: unknown } | null)?.features

  if (!document || (document as { type?: unknown }).type !== 'FeatureCollection' || !Array.isArray(features)) {
    throw new Error('La fuente de cortes de tráfico no trae un FeatureCollection.')
  }

  const cuts: TrafficCut[] = []

  for (const [index, feature] of features.entries()) {
    const properties = (feature?.properties ?? {}) as Record<string, unknown>
    const start = parseCutDate(properties.fecha_inicio)
    const end = parseCutDate(properties.fecha_fin)
    const parts = geometryParts(feature?.geometry)

    if (!start || !end || end < start || parts.length === 0) {
      continue
    }

    const name = String(properties.Name ?? '').replace(/\s+/g, ' ').trim()
    cuts.push({
      id: String(properties.ID ?? '').trim() || `corte-${index}`,
      name: name || 'Calle sin nombre',
      start,
      end,
      parts,
    })
  }

  return cuts
}

function geometryParts(geometry: unknown): LatLon[][] {
  const { type, coordinates } = (geometry ?? {}) as { type?: unknown, coordinates?: unknown }
  if (!Array.isArray(coordinates)) {
    return []
  }

  const lists: unknown[] = type === 'LineString' ? [coordinates] : type === 'MultiLineString' ? coordinates : []
  const parts: LatLon[][] = []

  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue
    }

    const points: LatLon[] = []
    for (const position of list) {
      const lon = Array.isArray(position) ? Number(position[0]) : Number.NaN
      const lat = Array.isArray(position) ? Number(position[1]) : Number.NaN
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        points.push([lat, lon])
      }
    }

    if (points.length >= 2) {
      parts.push(points)
    }
  }

  return parts
}

export interface TrafficCutsDownload {
  cuts: TrafficCut[]
  /**
   * Cuándo cambió el fichero en la fuente (`Last-Modified`), o null si no se
   * conoce: en el navegador la cabecera no llega y el servidor puede no mandarla.
   */
  sourceModified: number | null
}

/** Descarga el fichero oficial. Lanza si no se puede (en el navegador, siempre). */
export async function fetchTrafficCuts(): Promise<TrafficCutsDownload> {
  const { body, headers } = await httpGetText(TRAFFIC_CUTS_URL)
  return { cuts: parseTrafficCuts(body), sourceModified: sourceModifiedFromHeaders(headers) }
}

async function httpGetText(url: string): Promise<{ body: string, headers: unknown }> {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      url,
      headers: { Accept: 'application/json, text/plain, */*' },
      // La fuente responde application/octet-stream: se pide como texto y se
      // parsea aquí, sin depender de que el plugin decida deserializarlo.
      responseType: 'text',
      connectTimeout: 15_000,
      readTimeout: 15_000,
    })

    if (response.status !== 200) {
      throw new Error(`La fuente de cortes de tráfico respondió ${response.status}.`)
    }

    return {
      body: typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? null),
      headers: response.headers,
    }
  }

  // Sin CORS en la fuente, este fetch falla en el navegador: es lo esperado.
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`La fuente de cortes de tráfico respondió ${response.status}.`)
  }
  return { body: await response.text(), headers: response.headers }
}

/* ------------------------------------------------------------------ *
 * Caché                                                                *
 * ------------------------------------------------------------------ */

const CACHE_KEY = 'salbus.trafficCuts'

/**
 * Versión 2 añade `sourceModified`. La versión 1 (sin esa fecha) se sigue
 * leyendo: quien la guardó no la conocía y se queda en null hasta la siguiente
 * descarga.
 */
interface CachePayload {
  v: 1 | 2
  /** Cuándo se descargó, en milisegundos desde 1970. */
  fetchedAt: number
  /** Cuándo cambió el fichero en la fuente (`Last-Modified`), o null si no se supo. */
  sourceModified?: number | null
  cuts: TrafficCut[]
}

export interface CachedCuts {
  fetchedAt: number
  sourceModified: number | null
  cuts: TrafficCut[]
}

/** `YYYY-MM-DD`: un corte de la caché con otra cosa se pintaría con fechas imposibles. */
function isIsoDay(value: unknown): value is string {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  return match !== null && parseCutDate(`${match[3]}/${match[2]}/${match[1]}`) === value
}

/** Último resultado bueno guardado, o null si no hay (o no se puede leer). */
export function readCachedCuts(): CachedCuts | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) {
      return null
    }

    const payload = JSON.parse(raw) as Partial<CachePayload> | null
    if (!payload || (payload.v !== 1 && payload.v !== 2) || !Number.isFinite(payload.fetchedAt) || !Array.isArray(payload.cuts)) {
      return null
    }

    const cuts = payload.cuts.filter(
      (cut): cut is TrafficCut =>
        Boolean(cut) && typeof cut.id === 'string' && typeof cut.name === 'string'
        && isIsoDay(cut.start) && isIsoDay(cut.end) && cut.start <= cut.end && Array.isArray(cut.parts),
    )
    const sourceModified = payload.v === 2 && Number.isFinite(payload.sourceModified)
      ? (payload.sourceModified as number)
      : null
    return { fetchedAt: payload.fetchedAt as number, sourceModified, cuts }
  } catch {
    return null
  }
}

/**
 * Guarda el resultado. Los cortes que ya terminaron no se guardan: el fichero
 * los acumula y a la caché no le sirve de nada llevarlos encima.
 */
export function writeCachedCuts(
  cuts: TrafficCut[],
  fetchedAt: number,
  today = new Date(),
  sourceModified: number | null = null,
): void {
  try {
    const payload: CachePayload = {
      v: 2,
      fetchedAt,
      sourceModified,
      cuts: cuts.filter((cut) => datedCut(cut, today).status !== 'past'),
    }
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
  } catch {
    /* cuota agotada o almacenamiento bloqueado */
  }
}

/* ------------------------------------------------------------------ *
 * Trazado de las líneas                                                *
 * ------------------------------------------------------------------ */

interface LineShapesPayload {
  scale?: number
  lines?: Record<string, Array<{ k?: string[], p?: number[] }>>
}

/** Descomprime `line-shapes.json` (ver tools/build-line-shapes.mjs). */
export function decodeLineShapes(payload: LineShapesPayload): LineShape[] {
  const scale = payload.scale || 1e5
  const shapes: LineShape[] = []

  for (const [lineId, list] of Object.entries(payload.lines ?? {})) {
    for (const item of list ?? []) {
      const numbers = item.p ?? []
      const points: LatLon[] = []
      let lat = 0
      let lon = 0

      for (let index = 0; index + 1 < numbers.length; index += 2) {
        lat += numbers[index]
        lon += numbers[index + 1]
        points.push([lat / scale, lon / scale])
      }

      if (points.length >= 2) {
        shapes.push({ lineId, directionKeys: item.k ?? [], points })
      }
    }
  }

  return shapes
}

export async function loadLineShapes(url = LINE_SHAPES_URL): Promise<LineShape[]> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`No se pudo cargar el trazado de las líneas (HTTP ${response.status}).`)
  }
  return decodeLineShapes((await response.json()) as LineShapesPayload)
}

/* ------------------------------------------------------------------ *
 * Líneas afectadas                                                     *
 * ------------------------------------------------------------------ */

interface Xy {
  x: number
  y: number
}

interface Segment {
  a: Xy
  b: Xy
  length: number
  /** Dirección unitaria. */
  ux: number
  uy: number
}

/**
 * Líneas que pueden verse afectadas por un corte (criterio en la cabecera).
 *
 * Devuelve una entrada por línea, ordenadas por número de línea.
 */
export function lineImpacts(cut: TrafficCut, shapes: LineShape[]): LineImpact[] {
  const first = cut.parts[0]?.[0]
  if (!first) {
    return []
  }

  // Plano local en metros alrededor del corte: a 40° de latitud y unos pocos
  // kilómetros, la proyección equirrectangular se equivoca por centímetros.
  const cosLat = Math.cos((first[0] * Math.PI) / 180)
  const project = (point: LatLon): Xy => ({
    x: (point[1] - first[1]) * cosLat * METERS_PER_DEGREE,
    y: (point[0] - first[0]) * METERS_PER_DEGREE,
  })

  const cutSegments = cut.parts.flatMap((part) => toSegments(part.map(project)))
  if (cutSegments.length === 0) {
    return []
  }

  const cutLength = cutSegments.reduce((total, segment) => total + segment.length, 0)
  const minAlong = cutLength >= 2 * MIN_ALONG_METERS
    ? MIN_ALONG_METERS
    : Math.max(10, cutLength / 2)

  const box = boundingBox(cutSegments, NEAR_METERS)
  const cosParallel = Math.cos((PARALLEL_DEGREES * Math.PI) / 180)
  const byLine = new Map<string, LineImpact>()

  for (const shape of shapes) {
    const shapeSegments = toSegments(shape.points.map(project))
    if (!shapeSegments.some((segment) => touchesBox(segment, box))) {
      continue
    }

    let along = 0
    let crossing = false

    for (const segment of shapeSegments) {
      if (!touchesBox(segment, box)) {
        continue
      }

      if (segment.length > 0) {
        const samples = Math.max(1, Math.ceil(segment.length / SAMPLE_STEP_METERS))
        const each = segment.length / samples

        for (let index = 0; index < samples; index += 1) {
          const t = (index + 0.5) / samples
          const point = { x: segment.a.x + (segment.b.x - segment.a.x) * t, y: segment.a.y + (segment.b.y - segment.a.y) * t }

          const onTheCut = cutSegments.some(
            (other) =>
              Math.abs(segment.ux * other.ux + segment.uy * other.uy) >= cosParallel
              && distanceToSegment(point, other) <= NEAR_METERS,
          )
          if (onTheCut) {
            along += each
          }
        }
      }

      if (!crossing) {
        crossing = cutSegments.some(
          (other) =>
            Math.abs(segment.ux * other.ux + segment.uy * other.uy) < cosParallel
            && segmentDistance(segment, other) <= CROSS_METERS,
        )
      }
    }

    if (along < minAlong && !crossing) {
      continue
    }

    const impact = byLine.get(shape.lineId) ?? {
      lineId: shape.lineId,
      directionKeys: [],
      alongMeters: 0,
      crossing: false,
    }

    for (const key of shape.directionKeys) {
      if (!impact.directionKeys.includes(key)) {
        impact.directionKeys.push(key)
      }
    }
    impact.alongMeters = Math.max(impact.alongMeters, Math.round(along))
    impact.crossing = impact.crossing || crossing
    byLine.set(shape.lineId, impact)
  }

  return Array.from(byLine.values()).sort((left, right) =>
    left.lineId.localeCompare(right.lineId, 'es', { numeric: true }),
  )
}

function toSegments(points: Xy[]): Segment[] {
  const segments: Segment[] = []

  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]
    const b = points[index]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    // Un tramo de longitud cero no tiene dirección y no aporta nada.
    if (length > 0) {
      segments.push({ a, b, length, ux: (b.x - a.x) / length, uy: (b.y - a.y) / length })
    }
  }

  return segments
}

function boundingBox(segments: Segment[], margin: number) {
  const xs = segments.flatMap((segment) => [segment.a.x, segment.b.x])
  const ys = segments.flatMap((segment) => [segment.a.y, segment.b.y])
  return {
    minX: Math.min(...xs) - margin,
    maxX: Math.max(...xs) + margin,
    minY: Math.min(...ys) - margin,
    maxY: Math.max(...ys) + margin,
  }
}

function touchesBox(segment: Segment, box: ReturnType<typeof boundingBox>): boolean {
  return Math.max(segment.a.x, segment.b.x) >= box.minX
    && Math.min(segment.a.x, segment.b.x) <= box.maxX
    && Math.max(segment.a.y, segment.b.y) >= box.minY
    && Math.min(segment.a.y, segment.b.y) <= box.maxY
}

function distanceToSegment(point: Xy, segment: Segment): number {
  const dx = segment.b.x - segment.a.x
  const dy = segment.b.y - segment.a.y
  const t = Math.max(0, Math.min(1, ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / (segment.length ** 2)))
  return Math.hypot(point.x - (segment.a.x + t * dx), point.y - (segment.a.y + t * dy))
}

/** Distancia mínima entre dos segmentos (0 si se cortan). */
function segmentDistance(left: Segment, right: Segment): number {
  if (segmentsIntersect(left, right)) {
    return 0
  }

  return Math.min(
    distanceToSegment(left.a, right),
    distanceToSegment(left.b, right),
    distanceToSegment(right.a, left),
    distanceToSegment(right.b, left),
  )
}

function segmentsIntersect(left: Segment, right: Segment): boolean {
  const orient = (p: Xy, q: Xy, r: Xy) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)

  const d1 = orient(right.a, right.b, left.a)
  const d2 = orient(right.a, right.b, left.b)
  const d3 = orient(left.a, left.b, right.a)
  const d4 = orient(left.a, left.b, right.b)

  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/* ------------------------------------------------------------------ *
 * Presentación                                                         *
 * ------------------------------------------------------------------ */

const LOWERCASE_WORDS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en'])

/**
 * "SAN FELIPE (+IGNACIO DE LOYOLA+NAZARET)" -> "San Felipe (+Ignacio de Loyola+Nazaret)".
 *
 * La fuente publica los nombres en mayúsculas y sin tildes; las tildes no se
 * pueden recuperar, pero las mayúsculas sostenidas sí se pueden suavizar.
 */
export function formatCutName(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[\s(+/\-.])([a-zñáéíóúü])/g, (match, before: string, letter: string, offset: number, whole: string) => {
      // Las partículas van en minúscula, salvo la primera palabra del nombre.
      const word = /^[a-zñáéíóúü]+/.exec(whole.slice(offset + before.length))?.[0] ?? ''
      return offset > 0 && LOWERCASE_WORDS.has(word) && before !== '(' && before !== '+'
        ? match
        : `${before}${letter.toUpperCase()}`
    })
}
