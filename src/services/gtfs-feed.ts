import { Capacitor, CapacitorHttp } from '@capacitor/core'
import type JSZip from 'jszip'

import type { Network } from './network'
import {
  BUNDLED_GTFS_URL,
  gtfsDate,
  loadSchedule,
  openGtfsZip,
  readGtfsCsv,
  scheduleFromZip,
  serviceDateRange,
} from './schedule'
import { headerValue, parseHttpDate } from './traffic-cuts'
import type { ScheduleDataset } from '../types'

/**
 * Feed GTFS oficial, descargado y guardado en el teléfono.
 *
 * El GTFS que viaja dentro de la app (`public/data/gtfs.zip`) declara servicio
 * dia a dia y caduca a las dos semanas. Salamanca de Transportes publica el
 * vigente en el Punto de Acceso Nacional, pero ahi hace falta registro y clave;
 * Mobility Database lo replica a diario sin autenticacion, y es de donde se
 * descarga (`GTFS_FEED_URL`). Cada version cubre unas dos semanas.
 *
 * Funcionamiento:
 *   - Al arrancar se elige el mejor horario disponible entre el descargado
 *     (IndexedDB) y el incluido (`pickFeed`), sin tocar la red.
 *   - Despues, y cada vez que la app vuelve a primer plano, se mira si toca
 *     descargar (`downloadDue`): sin feed guardado, si no cubre hoy, si le
 *     quedan menos de `MIN_DAYS_LEFT` dias o si la ultima descarga tiene mas de
 *     `REFRESH_EVERY_MS`. Tras un fallo se espera `RETRY_AFTER_FAILURE_MS`.
 *   - Lo descargado se valida (`validateFeed` + que el horario se pueda
 *     construir) y solo se adopta si es mas util que el que se esta usando
 *     (`isMoreUseful`). Si no, se descarta y se sigue con el anterior.
 *   - Sin red, sin CORS (navegador) o con la fuente caida, la app sigue con lo
 *     que tenga: el descargado de antes o el incluido.
 *
 * El zip pesa varios MB: va en IndexedDB, no en localStorage.
 */

/**
 * De donde se descarga el feed. Si Mobility Database cambia la ruta, o se
 * quiere usar otra replica, basta con cambiar esta constante.
 */
export const GTFS_FEED_URL = 'https://files.mobilitydatabase.org/mdb-2823/latest.zip'

/** Cada cuanto se vuelve a descargar aunque el guardado siga valiendo. */
export const REFRESH_EVERY_MS = 3 * 24 * 60 * 60 * 1000

/** Con menos dias de servicio por delante que estos, se busca uno nuevo. */
export const MIN_DAYS_LEFT = 5

/**
 * Tras un intento fallido (sin red, error, feed rechazado), cuanto se espera
 * antes del siguiente automatico. Evita descargar varios MB cada vez que se
 * vuelve a la app mientras la fuente no publica nada mejor.
 */
export const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000

/** Proporcion minima de paradas y lineas de la red que el feed debe conocer. */
export const MIN_NETWORK_MATCH = 0.6

/** Un zip mayor que esto no es el GTFS de Salamanca (el real ronda 5 MB). */
const MAX_FEED_BYTES = 60 * 1024 * 1024

/* ------------------------------------------------------------------ *
 * Tipos                                                                *
 * ------------------------------------------------------------------ */

/** Rango de servicio en `YYYY-MM-DD`. */
export interface FeedRange {
  validFrom: string
  validTo: string
}

/** Lo que se guarda junto al zip descargado. */
export interface StoredFeedMeta extends FeedRange {
  /** Ultima descarga correcta de esta version (ms). */
  downloadedAt: number
  /** `Last-Modified` de la fuente, si lo mando (ms). */
  lastModified: number | null
  /** Tamaño del zip en bytes. */
  size: number
  url: string
}

/** De donde sale el horario que se esta usando. */
export interface ScheduleOrigin extends FeedRange {
  kind: 'downloaded' | 'bundled'
  downloadedAt: number | null
  lastModified: number | null
}

export type DownloadReason = 'no-feed' | 'not-today' | 'few-days-left' | 'old' | 'forced'

export interface DownloadDecision {
  due: boolean
  reason: DownloadReason | 'fresh' | 'waiting-retry'
}

export interface FeedValidation {
  ok: boolean
  reason: string | null
  range: FeedRange | null
  stopMatch: number
  lineMatch: number
}

export interface FeedCheckResult {
  status: 'not-due' | 'busy' | 'adopted' | 'same' | 'rejected' | 'failed'
  message: string
  schedule?: ScheduleDataset
  origin?: ScheduleOrigin
}

/* ------------------------------------------------------------------ *
 * Logica pura (probada en tools/selftest.mjs)                          *
 * ------------------------------------------------------------------ */

/** `YYYY-MM-DD` del dia local. */
export function isoDay(at: Date): string {
  const compact = gtfsDate(at)
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}

/** `YYYYMMDD` (GTFS) -> `YYYY-MM-DD`. */
export function isoFromGtfs(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function dayIndex(iso: string): number {
  const [year, month, day] = iso.split('-').map((part) => Number.parseInt(part, 10))
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000)
}

/** Dias de `from` a `to` (negativo si `to` es anterior). */
export function daysBetween(from: string, to: string): number {
  return dayIndex(to) - dayIndex(from)
}

export function coversDay(range: FeedRange | null, today: string): boolean {
  return range !== null && range.validFrom <= today && today <= range.validTo
}

/**
 * Si toca descargar.
 *
 * `lastFailureAt` manda primero: tras un fallo o un feed rechazado se espera
 * `RETRY_AFTER_FAILURE_MS` aunque el guardado no cubra hoy, o cada vuelta a la
 * app descargaria otra vez varios MB para nada. Un reloj descuadrado (descarga
 * "en el futuro") cuenta como descarga antigua.
 */
export function downloadDue(
  meta: Pick<StoredFeedMeta, 'validFrom' | 'validTo' | 'downloadedAt'> | null,
  lastFailureAt: number | null,
  now: Date,
): DownloadDecision {
  const time = now.getTime()
  if (lastFailureAt !== null && lastFailureAt <= time && time - lastFailureAt < RETRY_AFTER_FAILURE_MS) {
    return { due: false, reason: 'waiting-retry' }
  }

  if (!meta) {
    return { due: true, reason: 'no-feed' }
  }

  const today = isoDay(now)
  if (!coversDay(meta, today)) {
    return { due: true, reason: 'not-today' }
  }
  if (daysBetween(today, meta.validTo) < MIN_DAYS_LEFT) {
    return { due: true, reason: 'few-days-left' }
  }
  if (meta.downloadedAt > time + 60 * 60 * 1000 || time - meta.downloadedAt >= REFRESH_EVERY_MS) {
    return { due: true, reason: 'old' }
  }

  return { due: false, reason: 'fresh' }
}

/**
 * Cual usar al arrancar.
 *
 * El descargado si cubre hoy; si no, el que cubra hoy de los dos; si ninguno,
 * el que termine mas tarde (a igualdad, el descargado), marcado como caducado.
 */
export function pickFeed(
  downloaded: FeedRange | null,
  bundled: FeedRange | null,
  today: string,
): { use: 'downloaded' | 'bundled' | null, stale: boolean } {
  if (coversDay(downloaded, today)) {
    return { use: 'downloaded', stale: false }
  }
  if (coversDay(bundled, today)) {
    return { use: 'bundled', stale: false }
  }
  if (downloaded && (!bundled || downloaded.validTo >= bundled.validTo)) {
    return { use: 'downloaded', stale: downloaded.validTo < today }
  }
  if (bundled) {
    return { use: 'bundled', stale: bundled.validTo < today }
  }
  return { use: null, stale: true }
}

/** Un feed recien descargado mejora al actual: cubre hoy, o termina mas tarde. */
export function isMoreUseful(candidate: FeedRange, current: FeedRange | null, today: string): boolean {
  if (coversDay(candidate, today)) {
    return true
  }
  return current === null || candidate.validTo > current.validTo
}

/**
 * Comprueba que un feed sea el de Salamanca y sirva.
 *
 * `files` son los nombres del zip; `stopIds` y `lineIds`, los de stops.txt y
 * los `route_short_name` de routes.txt. Se exige que el feed conozca al menos
 * `MIN_NETWORK_MATCH` de las paradas y de las lineas de la red de la app: un
 * feed de otra ciudad, o uno renumerado, daria horarios a paradas que no son.
 */
export function validateFeed(
  input: { files: string[], stopIds: Iterable<string>, lineIds: Iterable<string>, range: FeedRange | null },
  networkStopIds: Iterable<string>,
  networkLineIds: Iterable<string>,
): FeedValidation {
  const files = new Set(input.files.map((name) => name.split('/').pop() ?? name))
  const result = (ok: boolean, reason: string | null, stopMatch = 0, lineMatch = 0): FeedValidation => ({
    ok,
    reason,
    range: input.range,
    stopMatch,
    lineMatch,
  })

  const missing = ['routes.txt', 'trips.txt', 'stop_times.txt', 'stops.txt'].filter((name) => !files.has(name))
  if (!files.has('calendar.txt') && !files.has('calendar_dates.txt')) {
    missing.push('calendar.txt o calendar_dates.txt')
  }
  if (missing.length > 0) {
    return result(false, `Al feed le faltan ficheros: ${missing.join(', ')}.`)
  }
  if (!input.range) {
    return result(false, 'El feed no declara fechas de servicio.')
  }

  const share = (wanted: Iterable<string>, have: Iterable<string>) => {
    const pool = new Set(have)
    const list = Array.from(new Set(wanted))
    return list.length === 0 ? 0 : list.filter((id) => pool.has(id)).length / list.length
  }
  const stopMatch = share(networkStopIds, input.stopIds)
  const lineMatch = share(networkLineIds, input.lineIds)

  if (stopMatch < MIN_NETWORK_MATCH || lineMatch < MIN_NETWORK_MATCH) {
    return result(
      false,
      `El feed no encaja con la red de la app (paradas ${Math.round(stopMatch * 100)} %, líneas ${Math.round(lineMatch * 100)} %).`,
      stopMatch,
      lineMatch,
    )
  }

  return result(true, null, stopMatch, lineMatch)
}

/** Lee del zip lo que necesita `validateFeed`. */
export async function inspectFeedZip(
  zip: JSZip,
  network: Pick<Network, 'stopById' | 'lineById'>,
): Promise<FeedValidation> {
  const [stops, routes, calendar, calendarDates] = await Promise.all([
    readGtfsCsv(zip, 'stops.txt'),
    readGtfsCsv(zip, 'routes.txt'),
    readGtfsCsv(zip, 'calendar.txt'),
    readGtfsCsv(zip, 'calendar_dates.txt'),
  ])
  const range = serviceDateRange(calendar, calendarDates)

  return validateFeed(
    {
      files: Object.keys(zip.files),
      stopIds: stops.map((row) => String(row.stop_id ?? '').trim()),
      lineIds: routes.map((row) => String(row.route_short_name ?? row.route_id ?? '').trim()),
      range: range ? { validFrom: isoFromGtfs(range.from), validTo: isoFromGtfs(range.to) } : null,
    },
    network.stopById.keys(),
    network.lineById.keys(),
  )
}

/* ------------------------------------------------------------------ *
 * Textos                                                               *
 * ------------------------------------------------------------------ */

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]

function parts(iso: string): { year: number, month: number, day: number } {
  const [year, month, day] = iso.split('-').map((part) => Number.parseInt(part, 10))
  return { year, month, day }
}

/** "15 de noviembre", con el año solo si no es el de `today`. */
export function formatFeedDay(iso: string, today: Date): string {
  const { year, month, day } = parts(iso)
  const label = `${day} de ${MONTHS[month - 1]}`
  return year === today.getFullYear() ? label : `${label} de ${year}`
}

/** "del 15 al 30 de noviembre", "del 28 de noviembre al 12 de diciembre", con año si no es el actual. */
export function formatFeedRange(range: FeedRange, today: Date): string {
  const from = parts(range.validFrom)
  const to = parts(range.validTo)
  const end = formatFeedDay(range.validTo, today)
  if (range.validFrom === range.validTo) {
    return `solo el ${end}`
  }
  if (from.year === to.year && from.month === to.month) {
    return `del ${from.day} al ${end}`
  }
  if (from.year === to.year && to.year === today.getFullYear()) {
    return `del ${formatFeedDay(range.validFrom, today)} al ${end}`
  }
  return `del ${from.day} de ${MONTHS[from.month - 1]} de ${from.year} al ${to.day} de ${MONTHS[to.month - 1]} de ${to.year}`
}

/** "hace un momento", "hace 5 min", "hace 2 h", "ayer", "hace 3 días". */
export function formatAge(at: number, now: Date): string {
  const minutes = Math.floor((now.getTime() - at) / 60_000)
  if (minutes < 1) {
    return 'hace un momento'
  }
  if (minutes < 60) {
    return `hace ${minutes} min`
  }
  const days = daysBetween(isoDay(new Date(at)), isoDay(now))
  if (days <= 0) {
    return `hace ${Math.floor(minutes / 60)} h`
  }
  return days === 1 ? 'ayer' : `hace ${days} días`
}

/**
 * Linea de origen del horario: "Horario oficial del 15 al 30 de noviembre ·
 * actualizado hace 2 h" o "Horario incluido en la app, del 16 al 31 de marzo".
 */
export function describeScheduleOrigin(origin: ScheduleOrigin, now: Date): string {
  const range = formatFeedRange(origin, now)
  if (origin.kind === 'downloaded') {
    return origin.downloadedAt !== null
      ? `Horario oficial ${range} · actualizado ${formatAge(origin.downloadedAt, now)}`
      : `Horario oficial ${range}`
  }
  return `Horario incluido en la app, ${range}`
}

/** Aviso si el horario no cubre hoy; null si esta en vigor. */
export function scheduleOriginWarning(origin: ScheduleOrigin, now: Date): string | null {
  const today = isoDay(now)
  if (origin.validTo < today) {
    return `Caducó el ${formatFeedDay(origin.validTo, now)}: las horas programadas son orientativas. La app buscará un horario nuevo en cuanto tenga conexión.`
  }
  if (origin.validFrom > today) {
    return `Empieza a valer el ${formatFeedDay(origin.validFrom, now)}: hasta entonces las horas programadas son orientativas.`
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Almacen (IndexedDB)                                                  *
 * ------------------------------------------------------------------ */

const DB_NAME = 'salbus-gtfs'
const STORE = 'feed'
const META_KEY = 'meta'
const DATA_KEY = 'zip'
/** Ultimo intento fallido o rechazado (ms): dato pequeño, va en localStorage. */
const FAILURE_KEY = 'salbus.gtfsFeed.lastFailureAt'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB no disponible.'))
      return
    }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir IndexedDB.'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest | null): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = work(tx.objectStore(STORE))
      tx.oncomplete = () => resolve((request?.result ?? undefined) as T)
      tx.onerror = () => reject(tx.error ?? new Error('Error de IndexedDB.'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB abortado.'))
    })
  } finally {
    db.close()
  }
}

function isMeta(value: unknown): value is StoredFeedMeta {
  const meta = value as Partial<StoredFeedMeta> | null
  const iso = (text: unknown) => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text)
  return Boolean(meta)
    && iso(meta?.validFrom)
    && iso(meta?.validTo)
    && typeof meta?.downloadedAt === 'number'
}

export async function readStoredMeta(): Promise<StoredFeedMeta | null> {
  try {
    const value = await withStore<unknown>('readonly', (store) => store.get(META_KEY))
    return isMeta(value) ? value : null
  } catch {
    return null
  }
}

async function readStoredData(): Promise<ArrayBuffer | null> {
  try {
    const value = await withStore<unknown>('readonly', (store) => store.get(DATA_KEY))
    return value instanceof ArrayBuffer ? value : null
  } catch {
    return null
  }
}

async function writeStored(meta: StoredFeedMeta, data: ArrayBuffer | null): Promise<void> {
  await withStore<void>('readwrite', (store) => {
    if (data) {
      store.put(data, DATA_KEY)
    }
    return store.put(meta, META_KEY)
  })
}

async function clearStored(): Promise<void> {
  try {
    await withStore<void>('readwrite', (store) => store.clear())
  } catch {
    // Nada que hacer: sin almacen no hay feed que borrar.
  }
}

function readFailureAt(): number | null {
  try {
    const value = Number(window.localStorage.getItem(FAILURE_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function writeFailureAt(at: number | null): void {
  try {
    if (at === null) {
      window.localStorage.removeItem(FAILURE_KEY)
    } else {
      window.localStorage.setItem(FAILURE_KEY, String(at))
    }
  } catch {
    // Sin almacenamiento: se reintentara en la siguiente vuelta, sin mas.
  }
}

/* ------------------------------------------------------------------ *
 * Descarga                                                             *
 * ------------------------------------------------------------------ */

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * Descarga el zip.
 *
 * En Android, con CapacitorHttp: no esta sujeto a CORS y con `responseType`
 * `arraybuffer` el plugin nativo devuelve el cuerpo en base64. En el navegador
 * se intenta un fetch normal; sin CORS en la fuente fallara y se seguira con lo
 * que haya.
 */
async function downloadFeed(url: string): Promise<{ data: ArrayBuffer, lastModified: number | null }> {
  let bytes: Uint8Array
  let headers: unknown

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      url,
      headers: { Accept: 'application/zip, application/octet-stream, */*' },
      responseType: 'arraybuffer',
      connectTimeout: 20_000,
      readTimeout: 60_000,
    })
    if (response.status !== 200) {
      throw new Error(`la fuente respondió ${response.status}`)
    }
    if (typeof response.data !== 'string') {
      throw new Error('la fuente no devolvió un fichero')
    }
    bytes = base64ToBytes(response.data)
    headers = response.headers
  } else {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`la fuente respondió ${response.status}`)
    }
    bytes = new Uint8Array(await response.arrayBuffer())
    headers = response.headers
  }

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FEED_BYTES) {
    throw new Error(`el fichero tiene un tamaño imposible (${bytes.byteLength} bytes)`)
  }

  // Copia a un ArrayBuffer propio: es lo que se guarda en IndexedDB.
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return { data, lastModified: parseHttpDate(headerValue(headers, 'last-modified')) }
}

/* ------------------------------------------------------------------ *
 * Orquestacion                                                         *
 * ------------------------------------------------------------------ */

function originFromSchedule(
  schedule: ScheduleDataset,
  kind: ScheduleOrigin['kind'],
  meta: StoredFeedMeta | null,
): ScheduleOrigin | null {
  if (!schedule.validFrom || !schedule.validTo) {
    return null
  }
  return {
    kind,
    validFrom: schedule.validFrom,
    validTo: schedule.validTo,
    downloadedAt: meta?.downloadedAt ?? null,
    lastModified: meta?.lastModified ?? null,
  }
}

/**
 * Horario con el que arranca la app, sin tocar la red.
 *
 * Si el descargado cubre hoy ni se abre el incluido. Si el guardado esta roto
 * se borra y se usa el incluido. Lanza solo si no hay ninguno utilizable.
 */
export async function loadBestSchedule(
  network: Network,
  now = new Date(),
): Promise<{ schedule: ScheduleDataset, origin: ScheduleOrigin | null }> {
  const today = isoDay(now)
  const meta = await readStoredMeta()

  const loadStored = async () => {
    const data = meta ? await readStoredData() : null
    if (!meta || !data) {
      return null
    }
    try {
      const schedule = await loadSchedule(network, data)
      return schedule.passCount > 0 ? { schedule, origin: originFromSchedule(schedule, 'downloaded', meta) } : null
    } catch {
      return null
    }
  }

  if (meta && coversDay(meta, today)) {
    const stored = await loadStored()
    if (stored) {
      return stored
    }
    await clearStored()
  }

  let bundled: { schedule: ScheduleDataset, origin: ScheduleOrigin | null } | null = null
  try {
    const schedule = await loadSchedule(network, BUNDLED_GTFS_URL)
    bundled = { schedule, origin: originFromSchedule(schedule, 'bundled', null) }
  } catch {
    bundled = null
  }

  const choice = pickFeed(meta && !coversDay(meta, today) ? meta : null, bundled?.origin ?? null, today)
  if (choice.use === 'downloaded') {
    const stored = await loadStored()
    if (stored) {
      return stored
    }
    await clearStored()
  }

  if (!bundled) {
    throw new Error('No se pudo cargar ningún horario programado.')
  }
  return bundled
}

let inFlight: Promise<FeedCheckResult> | null = null

/**
 * Tras una descarga buena: si el feed que queda seguiria pidiendo descarga (la
 * fuente aun no publica uno que cubra hoy, o le quedan pocos dias), se aplica
 * la misma espera que tras un fallo. Si no, cada vuelta a la app volveria a
 * bajar el mismo fichero.
 */
function settleBackoff(meta: StoredFeedMeta, now: Date): void {
  writeFailureAt(downloadDue(meta, null, now).due ? Date.now() : null)
}

/**
 * Busca un feed nuevo si toca (o siempre, con `force`).
 *
 * Nunca lanza: el resultado dice que paso. Con `adopted` trae el horario nuevo
 * ya construido para cambiarlo en caliente.
 */
export function checkForNewFeed(
  network: Network,
  current: ScheduleOrigin | null,
  options: { force?: boolean, url?: string, now?: () => Date } = {},
): Promise<FeedCheckResult> {
  if (inFlight) {
    return options.force
      ? inFlight
      : Promise.resolve({ status: 'busy', message: 'Ya se está buscando un horario nuevo.' })
  }

  inFlight = runCheck(network, current, options).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runCheck(
  network: Network,
  current: ScheduleOrigin | null,
  options: { force?: boolean, url?: string, now?: () => Date },
): Promise<FeedCheckResult> {
  const clock = options.now ?? (() => new Date())
  const meta = await readStoredMeta()

  if (!options.force) {
    const decision = downloadDue(meta, readFailureAt(), clock())
    if (!decision.due) {
      return { status: 'not-due', message: 'Todavía no toca buscar horario nuevo.' }
    }
  }

  const url = options.url ?? GTFS_FEED_URL
  const fail = (status: 'failed' | 'rejected', message: string): FeedCheckResult => {
    writeFailureAt(Date.now())
    return { status, message }
  }

  let download: { data: ArrayBuffer, lastModified: number | null }
  try {
    download = await downloadFeed(url)
  } catch (error) {
    // Un fetch sin red (o sin CORS, en el navegador) falla con TypeError y un
    // texto en ingles que no dice nada a quien lo lee.
    const detail = error instanceof TypeError
      ? 'sin conexión o la fuente no responde'
      : error instanceof Error ? error.message : String(error)
    return fail('failed', `No se pudo descargar el horario: ${detail}.`)
  }

  let zip: JSZip
  try {
    zip = await openGtfsZip(download.data)
  } catch {
    return fail('rejected', 'El fichero descargado no es un zip GTFS válido.')
  }

  const validation = await inspectFeedZip(zip, network)
  if (!validation.ok || !validation.range) {
    return fail('rejected', validation.reason ?? 'El horario descargado no es válido.')
  }
  const range = validation.range
  const today = isoDay(clock())

  // La misma version que ya se tiene: solo se apunta que se ha comprobado.
  if (
    meta
    && meta.validFrom === range.validFrom
    && meta.validTo === range.validTo
    && meta.size === download.data.byteLength
  ) {
    const refreshed: StoredFeedMeta = { ...meta, downloadedAt: Date.now(), lastModified: download.lastModified ?? meta.lastModified }
    try {
      await writeStored(refreshed, null)
    } catch {
      // Si no se puede apuntar, la siguiente vuelta lo intentara otra vez.
    }
    settleBackoff(refreshed, clock())
    return {
      status: 'same',
      message: `Ya tienes el horario más reciente (${formatFeedRange(range, clock())}).`,
      origin: current?.kind === 'downloaded' ? { ...current, downloadedAt: refreshed.downloadedAt } : undefined,
    }
  }

  if (!isMoreUseful(range, current, today)) {
    return fail('rejected', `El horario publicado (${formatFeedRange(range, clock())}) no mejora al que ya tienes.`)
  }

  let schedule: ScheduleDataset
  try {
    schedule = await scheduleFromZip(zip, network)
  } catch {
    return fail('rejected', 'El horario descargado no se ha podido leer.')
  }
  if (schedule.passCount === 0) {
    return fail('rejected', 'El horario descargado no trae ningún paso por parada.')
  }

  const stored: StoredFeedMeta = {
    ...range,
    downloadedAt: Date.now(),
    lastModified: download.lastModified,
    size: download.data.byteLength,
    url,
  }
  try {
    await writeStored(stored, download.data)
  } catch {
    // Sin almacen se usa igualmente en esta sesion; al reabrir se descargara otra vez.
  }
  settleBackoff(stored, clock())

  return {
    status: 'adopted',
    message: `Horario nuevo: ${formatFeedRange(range, clock())}.`,
    schedule,
    origin: originFromSchedule(schedule, 'downloaded', stored) ?? undefined,
  }
}
