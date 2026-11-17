import JSZip from 'jszip'
import Papa from 'papaparse'

import type { Network } from './network'
import type { Arrival, ScheduleDataset, ServiceDayType } from '../types'

/**
 * Horario programado a partir del GTFS estatico (`public/data/gtfs.zip`).
 *
 * Se usa como REFERENCIA de horario teorico (columna "hora prevista" de la
 * monitorizacion). Los tiempos que se muestran como llegadas provienen de la
 * fuente en tiempo real; solo cuando esta no contesta, y a peticion, la parada
 * enseña los pasos del horario marcados como estimados
 * (`estimateArrivalsFromSchedule`). Nunca se mezclan ambos origenes.
 *
 * Origen: `gtfs-feed.ts` descarga cada pocos dias el feed oficial vigente y
 * lo guarda; el GTFS incluido en la app queda de reserva. El incluido declara
 * servicio dia a dia en `calendar_dates.txt` (un `service_id` por fecha), por lo
 * que caduca: `stale` avisa de ello. Se leen tanto `calendar.txt` como
 * `calendar_dates.txt`, por si el feed descargado usa el primero.
 *
 * Sentidos: cada `route_id` del GTFS es en realidad UN sentido ("Cementerio (295)
 * > Puente Ladrillo (309)"), con el mismo rotulo que publica la red oficial. Se
 * emparejan por ese rotulo, de modo que el horario se puede filtrar por sentido.
 * Sin ese filtro, en una parada por la que pasan los dos sentidos de la linea las
 * salidas de ambos se mezclaban y cualquier paso observado encontraba una hora
 * programada a uno o dos minutos: el desvio salia siempre "en hora" y la medicion
 * no valia para nada.
 */

type CsvRow = Record<string, string | undefined>

interface StopTimeRow {
  tripId: string
  stopId: string
  clock: string
}

/** Lo que acepta `loadSchedule`: la URL del zip incluido o el zip ya descargado. */
export type ScheduleSource = string | ArrayBuffer | Uint8Array | Blob

/**
 * Carga el horario desde una URL (el GTFS incluido, `/data/gtfs.zip`) o desde
 * los bytes de un zip ya en memoria (el feed descargado y guardado por
 * `gtfs-feed.ts`).
 */
export async function loadSchedule(
  network: Network | null = null,
  source: ScheduleSource = BUNDLED_GTFS_URL,
): Promise<ScheduleDataset> {
  return scheduleFromZip(await openGtfsZip(source), network)
}

/** GTFS que viaja dentro de la app: la reserva cuando no hay uno descargado mejor. */
export const BUNDLED_GTFS_URL = '/data/gtfs.zip'

/** Abre un zip GTFS desde una URL o desde sus bytes. */
export async function openGtfsZip(source: ScheduleSource): Promise<JSZip> {
  if (typeof source === 'string') {
    const response = await fetch(source)
    if (!response.ok) {
      throw new Error(`No se pudo descargar el GTFS estatico (HTTP ${response.status}).`)
    }
    return JSZip.loadAsync(await response.arrayBuffer())
  }

  return JSZip.loadAsync(source)
}

/** Construye el horario a partir de un zip GTFS ya abierto. */
export async function scheduleFromZip(zip: JSZip, network: Network | null = null): Promise<ScheduleDataset> {
  const [routes, trips, stopTimes, calendar, calendarDates] = await Promise.all([
    readCsv(zip, 'routes.txt'),
    readCsv(zip, 'trips.txt'),
    readCsv(zip, 'stop_times.txt'),
    readCsv(zip, 'calendar.txt'),
    readCsv(zip, 'calendar_dates.txt'),
  ])

  // route_id -> route_short_name (el numero de linea que usa la app).
  const lineIdByRouteId = new Map<string, string>()
  for (const row of routes) {
    const routeId = text(row.route_id)
    const shortName = text(row.route_short_name) || routeId
    if (routeId) {
      lineIdByRouteId.set(routeId, shortName)
    }
  }

  // route_id -> sentido de la red oficial (`${lineId}|uno`), cuando se reconoce.
  const directionKeyByRouteId = mapRoutesToDirections(routes, network)

  // trip_id -> { lineId, serviceId, directionKey }
  const tripInfo = new Map<string, { lineId: string, serviceId: string, directionKey: string | null }>()
  for (const row of trips) {
    const tripId = text(row.trip_id)
    const routeId = text(row.route_id)
    const lineId = lineIdByRouteId.get(routeId)
    if (tripId && lineId) {
      tripInfo.set(tripId, {
        lineId,
        serviceId: text(row.service_id),
        directionKey: directionKeyByRouteId.get(routeId) ?? null,
      })
    }
  }

  // Tipos de dia de cada service_id: de los dias de la semana de calendar.txt
  // y de las fechas sueltas de calendar_dates.txt. El feed incluido solo trae
  // lo segundo (un service_id por fecha); otros feeds traen lo primero.
  const dayTypesByServiceId = serviceDayTypes(calendar, calendarDates)
  const range = serviceDateRange(calendar, calendarDates)
  const validFrom = range?.from ?? null
  const validTo = range?.to ?? null

  // Indice parada -> pasos, ya filtrado a lo minimo necesario.
  const byStop = new Map<string, StopTimeRow[]>()
  let passCount = 0
  for (const row of stopTimes) {
    const tripId = text(row.trip_id)
    const stopId = text(row.stop_id)
    if (!tripId || !stopId || !tripInfo.has(tripId)) {
      continue
    }

    const clock = toClock(text(row.departure_time) || text(row.arrival_time))
    if (!clock) {
      continue
    }

    passCount += 1
    const list = byStop.get(stopId)
    if (list) {
      list.push({ tripId, stopId, clock })
    } else {
      byStop.set(stopId, [{ tripId, stopId, clock }])
    }
  }

  // Con nombre propio para poder llamarse a si mismo: las salidas de cabecera de
  // un sentido son las horas programadas en su primera parada, asi que
  // `getDirectionDepartures` no es mas que `getScheduledTimes` con la parada ya
  // resuelta. Una sola implementacion, o las dos respuestas podrian discrepar.
  const dataset: ScheduleDataset = {
    validFrom: formatIsoDate(validFrom),
    validTo: formatIsoDate(validTo),
    stale: isStale(validTo),
    passCount,

    getScheduledTimes(
      stopId: string,
      lineId: string,
      dayType: ServiceDayType,
      directionKey: string | null = null,
    ): string[] {
      const rows = byStop.get(stopId)
      if (!rows) {
        return []
      }

      const result = new Set<string>()

      for (const row of rows) {
        const info = tripInfo.get(row.tripId)
        if (!info || info.lineId !== lineId) {
          continue
        }

        // Con un sentido elegido se descartan los trayectos de los demas. Los
        // trayectos que no se han podido emparejar con la red oficial se
        // conservan: es preferible una hora de mas que una tabla vacia.
        if (directionKey && info.directionKey && info.directionKey !== directionKey) {
          continue
        }

        // Si el service_id no aparece en el calendario no se puede clasificar el
        // dia; se incluye para no dejar la tabla vacia.
        const rowDayTypes = dayTypesByServiceId.get(info.serviceId)
        if (rowDayTypes && !rowDayTypes.has(dayType)) {
          continue
        }

        result.add(row.clock)
      }

      return Array.from(result).sort(compareClock)
    },

    /**
     * Salidas de un sentido desde su cabecera.
     *
     * La cabecera es, por definicion, la primera parada del recorrido en la red
     * oficial: `direction.stops[0]`. Consultando ahi con el sentido ya fijado se
     * obtienen las salidas de ese sentido y solo de ese, que es lo que se
     * publica como "horario de la linea".
     *
     * Sin red cargada no hay recorrido del que sacar la cabecera, y entonces no
     * se devuelve nada: inventar una parada daria un horario que parece bueno y
     * no lo es.
     */
    getDirectionDepartures(directionKey: string, dayType: ServiceDayType): string[] {
      const direction = network?.directionByKey.get(directionKey)
      const origin = direction?.stops[0]
      if (!direction || !origin) {
        return []
      }

      return dataset.getScheduledTimes(
        origin.stopId,
        direction.key.split('|')[0],
        dayType,
        direction.key,
      )
    },
  }

  return dataset
}

/**
 * Empareja cada `route_id` del GTFS con el sentido equivalente de la red oficial.
 *
 * Primero por rotulo completo ("Cementerio (295) > Puente Ladrillo (309)"), que
 * cubre los 80 sentidos publicados. Los trayectos que el GTFS trae de mas (29
 * variantes parciales) se asignan por destino dentro de la misma linea.
 */
function mapRoutesToDirections(routes: CsvRow[], network: Network | null): Map<string, string> {
  const result = new Map<string, string>()
  if (!network) {
    return result
  }

  const byLabel = new Map<string, string>()
  const byDestination = new Map<string, string>()

  for (const line of network.lines) {
    for (const direction of line.directions) {
      byLabel.set(`${line.lineId}#${normalizeLabel(direction.label)}`, direction.key)
      const destinationKey = `${line.lineId}#${normalizeLabel(direction.destination)}`
      if (!byDestination.has(destinationKey)) {
        byDestination.set(destinationKey, direction.key)
      }
    }
  }

  for (const row of routes) {
    const routeId = text(row.route_id)
    const lineId = text(row.route_short_name) || routeId
    const label = text(row.route_long_name)
    if (!routeId || !label) {
      continue
    }

    const exact = byLabel.get(`${lineId}#${normalizeLabel(label)}`)
    if (exact) {
      result.set(routeId, exact)
      continue
    }

    const destination = label.split('>').slice(1).join('>')
    const guess = byDestination.get(`${lineId}#${normalizeLabel(destination)}`)
    if (guess) {
      result.set(routeId, guess)
    }
  }

  return result
}

/** Sin tildes, sin puntuacion y sin espacios de mas: los rotulos oficiales varian. */
function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

async function readCsv(zip: JSZip, fileName: string): Promise<CsvRow[]> {
  const file = zip.file(fileName)
  if (!file) {
    return []
  }

  const parsed = Papa.parse<CsvRow>(await file.async('text'), {
    header: true,
    skipEmptyLines: true,
  })

  return parsed.data
}

function text(value: string | undefined): string {
  return String(value ?? '').trim()
}

/** Normaliza "7:05:00" o "25:10:00" a "HH:MM" en rango 00-23. */
function toClock(value: string): string | null {
  const parts = value.split(':')
  if (parts.length < 2) {
    return null
  }

  const hours = Number.parseInt(parts[0], 10)
  const minutes = Number.parseInt(parts[1], 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null
  }

  return `${String(hours % 24).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function compareClock(left: string, right: string): number {
  return left.localeCompare(right)
}

function dayTypeFromGtfsDate(date: string): ServiceDayType {
  const parsed = new Date(
    Number.parseInt(date.slice(0, 4), 10),
    Number.parseInt(date.slice(4, 6), 10) - 1,
    Number.parseInt(date.slice(6, 8), 10),
  )

  const day = parsed.getDay()
  if (day === 0) {
    return 'sunday'
  }
  if (day === 6) {
    return 'saturday'
  }
  return 'weekday'
}

function formatIsoDate(value: string | null): string | null {
  if (!value || value.length !== 8) {
    return null
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

/**
 * Caducado = su ultimo dia de servicio ya paso. El propio ultimo dia todavia
 * vale: comparar con la medianoche en que empieza lo daba por caducado un dia
 * antes de tiempo.
 */
function isStale(validTo: string | null, today = new Date()): boolean {
  if (!validTo || validTo.length !== 8) {
    return true
  }
  return validTo < gtfsDate(today)
}

/** `YYYYMMDD` del dia local, el formato de fechas del GTFS. */
export function gtfsDate(at: Date): string {
  return `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`
}

/** Rango de fechas de servicio de un feed, en `YYYYMMDD`. */
export interface GtfsDateRange {
  from: string
  to: string
}

/**
 * Primer y ultimo dia con servicio declarado.
 *
 * Se juntan las dos fuentes del GTFS: los periodos de calendar.txt
 * (`start_date`..`end_date`, si algun dia de la semana tiene servicio) y las
 * fechas añadidas de calendar_dates.txt (`exception_type` 1). Las fechas
 * quitadas (tipo 2) no amplian nada. Sin ninguna de las dos, null.
 */
export function serviceDateRange(calendar: CsvRow[], calendarDates: CsvRow[]): GtfsDateRange | null {
  let from: string | null = null
  let to: string | null = null
  const widen = (start: string, end: string) => {
    if (!from || start < from) from = start
    if (!to || end > to) to = end
  }

  for (const row of calendar) {
    const start = text(row.start_date)
    const end = text(row.end_date)
    const runs = WEEKDAY_COLUMNS.some((column) => text(row[column]) === '1')
    if (isGtfsDate(start) && isGtfsDate(end) && start <= end && runs) {
      widen(start, end)
    }
  }

  for (const row of calendarDates) {
    const date = text(row.date)
    if (isGtfsDate(date) && text(row.exception_type) === '1') {
      widen(date, date)
    }
  }

  return from && to ? { from, to } : null
}

const WEEKDAY_COLUMNS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

/** Tipo de dia de cada columna de calendar.txt. */
const DAY_TYPE_BY_COLUMN: Record<(typeof WEEKDAY_COLUMNS)[number], ServiceDayType> = {
  monday: 'weekday',
  tuesday: 'weekday',
  wednesday: 'weekday',
  thursday: 'weekday',
  friday: 'weekday',
  saturday: 'saturday',
  sunday: 'sunday',
}

/**
 * Tipos de dia en que circula cada service_id.
 *
 * Un servicio puede valer para varios (calendar.txt de lunes a domingo), asi
 * que es un conjunto y no un solo tipo.
 */
export function serviceDayTypes(calendar: CsvRow[], calendarDates: CsvRow[]): Map<string, Set<ServiceDayType>> {
  const result = new Map<string, Set<ServiceDayType>>()
  const add = (serviceId: string, dayType: ServiceDayType) => {
    const set = result.get(serviceId)
    if (set) {
      set.add(dayType)
    } else {
      result.set(serviceId, new Set([dayType]))
    }
  }

  for (const row of calendar) {
    const serviceId = text(row.service_id)
    if (!serviceId) continue
    for (const column of WEEKDAY_COLUMNS) {
      if (text(row[column]) === '1') {
        add(serviceId, DAY_TYPE_BY_COLUMN[column])
      }
    }
  }

  for (const row of calendarDates) {
    const serviceId = text(row.service_id)
    const date = text(row.date)
    if (serviceId && isGtfsDate(date) && text(row.exception_type) === '1') {
      add(serviceId, dayTypeFromGtfsDate(date))
    }
  }

  return result
}

function isGtfsDate(value: string): boolean {
  return /^\d{8}$/.test(value)
}

/** Lee un fichero CSV del zip (vacio si no esta). Lo usa tambien la validacion del feed. */
export { readCsv as readGtfsCsv }
export type { CsvRow as GtfsRow }

export function currentDayType(reference = new Date()): ServiceDayType {
  const day = reference.getDay()
  if (day === 0) {
    return 'sunday'
  }
  if (day === 6) {
    return 'saturday'
  }
  return 'weekday'
}

/** Margen con el que se avisa de que una estimacion por horario puede fallar. */
export const SCHEDULE_ESTIMATE_ERROR_MINUTES = 5

/**
 * Proximos pasos programados de las lineas de una parada, con la forma de una
 * llegada.
 *
 * Es el recurso para cuando la fuente en tiempo real no contesta: la persona lo
 * pide a mano en la parada y la pantalla lo marca como estimado (+/- 5 min).
 * Nunca se mezcla con llegadas reales: en cuanto la fuente vuelve a dar datos,
 * la parada vuelve a enseñar solo esos.
 *
 * Cerca de medianoche se miran tambien los pasos del dia siguiente con SU tipo
 * de dia, y las horas de madrugada del dia de hoy (los "25:10" del GTFS, que
 * `toClock` deja en "01:10" y pertenecen al servicio del dia que empezo).
 */
export function estimateArrivalsFromSchedule(
  schedule: ScheduleDataset,
  stopId: string,
  lineIds: string[],
  now = new Date(),
  horizonMinutes = 90,
  perLine = 3,
): Arrival[] {
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const today = currentDayType(now)
  const tomorrow = currentDayType(new Date(now.getTime() + 24 * 60 * 60_000))
  const result: Arrival[] = []

  for (const lineId of lineIds) {
    const minutesAhead = new Set<number>()

    for (const clock of schedule.getScheduledTimes(stopId, lineId, today)) {
      const at = clockToMinutes(clock)
      const diff = at - nowMinutes
      if (diff >= 0 && diff <= horizonMinutes) {
        minutesAhead.add(diff)
      } else if (at < 5 * 60 && diff + 1440 <= horizonMinutes) {
        minutesAhead.add(diff + 1440)
      }
    }

    if (nowMinutes + horizonMinutes >= 1440) {
      for (const clock of schedule.getScheduledTimes(stopId, lineId, tomorrow)) {
        const diff = clockToMinutes(clock) + 1440 - nowMinutes
        if (diff <= horizonMinutes) {
          minutesAhead.add(diff)
        }
      }
    }

    const next = Array.from(minutesAhead).sort((left, right) => left - right).slice(0, perLine)
    for (const minutesUntil of next) {
      result.push({
        stopId,
        lineId,
        minutesUntil,
        status: 'scheduled',
        estimatedClock: formatMinutesOfDay(nowMinutes + minutesUntil),
        observedAt: now.getTime(),
      })
    }
  }

  return result.sort((left, right) => left.minutesUntil - right.minutesUntil)
}

function clockToMinutes(clock: string): number {
  const [hours, minutes] = clock.split(':').map((part) => Number.parseInt(part, 10))
  return hours * 60 + minutes
}

function formatMinutesOfDay(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}
