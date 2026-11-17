/* ------------------------------------------------------------------ *
 * Red oficial (public/data/network.json)                              *
 * ------------------------------------------------------------------ */

export interface NetworkStop {
  stopId: string
  stopName: string
  lat: number
  lon: number
}

/** Sentido de una linea: 'ida' (trayectos 1 y 3) o 'vuelta' (trayectos 2 y 4). */
export type DirectionWay = 'ida' | 'vuelta'

export interface LineDirection {
  /** `${lineId}|${slot}` */
  key: string
  slot: 'uno' | 'dos' | 'tres' | 'cuatro'
  way: DirectionWay
  /** Los trayectos 3 y 4 son variantes parciales (no cubren la linea completa). */
  partial: boolean
  /** Lineas circulares (91 y 92, servicio nocturno): salen y vuelven al mismo punto. */
  circular: boolean
  /** Rotulo oficial completo, p. ej. "Cementerio (295) > Puente Ladrillo (309)". */
  label: string
  origin: string
  destination: string
  stopCount: number
  stops: NetworkStop[]
}

export interface TransitLine {
  lineId: string
  shortName: string
  /** "Línea 4. CEMENTERIO - PUENTE LADRLLO" */
  name: string
  /** "CEMENTERIO - PUENTE LADRLLO" */
  title: string
  color: string
  directions: LineDirection[]
}

export interface NetworkPayload {
  source: string
  generatedAt: string
  lineCount: number
  directionCount: number
  stopCount: number
  lines: TransitLine[]
  stopsById: Record<string, NetworkStop>
  linesByStopId: Record<string, string[]>
}

/* ------------------------------------------------------------------ *
 * Llegadas en tiempo real                                             *
 * ------------------------------------------------------------------ */

export type ArrivalStatus = 'arriving' | 'scheduled'

export interface Arrival {
  stopId: string
  lineId: string
  /** `null` cuando la web devuelve "LLEGANDO A PARADA" sin minutos concretos. */
  minutesUntil: number
  status: ArrivalStatus
  /** Hora estimada de paso (HH:MM) calculada a partir de los minutos restantes. */
  estimatedClock: string
  /** Momento en que se obtuvo el dato, para poder envejecerlo en pantalla. */
  observedAt: number
}

export type StopFeedStatus =
  /** Datos frescos obtenidos de la fuente oficial. */
  | 'ok'
  /** La parada existe pero la fuente indica que no circula ninguna linea ahora. */
  | 'empty'
  /** La fuente limito la peticion (HTTP 429). Se muestra el ultimo dato conocido. */
  | 'throttled'
  /** Error de red o de formato. */
  | 'error'

export interface StopFeed {
  stopId: string
  stopName: string | null
  status: StopFeedStatus
  arrivals: Arrival[]
  fetchedAt: number
  /** Mensaje corto orientado a la persona usuaria cuando el estado no es 'ok'. */
  message: string | null
}

/* ------------------------------------------------------------------ *
 * Horario estatico GTFS                                               *
 * ------------------------------------------------------------------ */

export type ServiceDayType = 'weekday' | 'saturday' | 'sunday'

export interface ScheduleDataset {
  /** Fecha de validez declarada por el feed (`YYYY-MM-DD`, de calendar.txt y calendar_dates.txt). */
  validFrom: string | null
  validTo: string | null
  /** Su ultimo dia de servicio ya ha pasado. */
  stale: boolean
  /** Pasos por parada leidos de stop_times.txt: cero es un feed inservible. */
  passCount: number
  /**
   * Horas de paso programadas (HH:MM) de una linea por una parada.
   * Con `directionKey` se limitan al sentido indicado; sin el se devuelven los
   * de todos los sentidos que pasan por esa parada.
   */
  getScheduledTimes(
    stopId: string,
    lineId: string,
    dayType: ServiceDayType,
    directionKey?: string | null,
  ): string[]

  /**
   * Salidas (HH:MM) de un sentido desde su CABECERA, para un tipo de dia.
   *
   * Es el horario de la linea tal y como se publica en una marquesina: a que
   * hora sale cada expedicion del principio del recorrido. No es lo mismo que
   * `getScheduledTimes`, que responde "a que hora pasa la linea N por ESTA
   * parada" y solo tiene sentido con una parada delante.
   *
   * Se resuelve mirando la primera parada del sentido en la red oficial, que es
   * exactamente su cabecera.
   */
  getDirectionDepartures(directionKey: string, dayType: ServiceDayType): string[]
}
