import type { Network } from './services/network'
import { averageMinutes } from './services/punctuality'
import type { MonitorRuntime } from './services/punctuality'
import type { ReleaseInfo } from './services/release-parser'
import type { GeoPoint, PlanOutcome } from './services/routing'
import type { ScheduleDataset, ServiceDayType, StopFeed } from './types'

/** Version con la que se COMPILO este bundle. Sale de package.json via Vite. */
export const APP_VERSION = `v${__APP_VERSION__}`

/** versionCode de esta compilacion, segun el bundle. */
export const APP_VERSION_CODE = __APP_VERSION_CODE__

/**
 * Las pestañas de la aplicación.
 *
 * 'info' se llamaba 'mapas' y era solo el planificador de rutas experimental.
 * Ahora recoge las DOS cosas que se consultan y no se miran cada dos minutos:
 * cómo llegar de un punto a otro y los horarios oficiales de cada línea. Eso
 * segundo no es experimental —sale del GTFS que ya viaja dentro de la app— así
 * que la pestaña existe siempre; lo que sigue dependiendo del interruptor de
 * Ajustes es el apartado "Cómo llegar".
 */
export type TabId = 'inicio' | 'buscar' | 'monitor' | 'seguimiento' | 'info' | 'ajustes'

/** Los dos apartados de la pestaña Info. */
export type InfoSection = 'llegar' | 'lineas'

/**
 * Los dos apartados de Ajustes.
 *
 * Un ajuste que HACE algo (un interruptor, un permiso, un botón) y un panel que
 * solo CUENTA algo (cada cuánto se pide cada cosa, cuántas consultas van) no se
 * leen igual ni se buscan por lo mismo, y mezclados obligaban a recorrer nueve
 * tarjetas para encontrar el único interruptor que se venía a tocar. Se abre en
 * 'funciones' porque a Ajustes se entra a cambiar algo, no a leer.
 */
export type SettingsSection = 'funciones' | 'informacion'
/**
 * Como se busca una parada.
 *
 * 'parada' fusiona lo que antes eran dos modos distintos —por nombre y por
 * linea—: eran la misma busqueda con el mismo resultado, y obligar a elegir
 * cual de las dos antes de escribir nada solo anadia un paso. Ahora el texto y
 * los desplegables de linea y sentido conviven y se combinan entre si.
 */
export type SearchMode = 'parada' | 'cerca' | 'mapa'
export type PermissionState = 'granted' | 'denied' | 'unknown'

export interface FavouriteStop {
  stopId: string
  alias: string | null
  addedAt: number
}

/**
 * Aviso de proximo bus.
 *
 * Es la UNICA funcion de seguimiento que existe. Antes habia dos —el
 * aviso, que notificaba los minutos, y "ver por donde viene", que dibujaba el
 * recorrido— y eran la misma pregunta partida en dos: quien espera un autobus
 * quiere saber cuanto falta Y por donde viene, no una cosa o la otra. Tenerlas
 * separadas obligaba ademas a elegir cual de las dos gastaba el unico turno
 * disponible en la cola de consultas.
 *
 * Fusionadas, un aviso publica su notificacion persistente y ademas ensena las
 * paradas anteriores con el autobus situado en una de ellas.
 */
export interface TrackingJob {
  id: string
  stopId: string
  stopName: string
  lineId: string
  /**
   * Sentido por el que viene el autobus, para poder decir a cuantas paradas
   * esta ademas de cuantos minutos faltan.
   *
   * Es `null` cuando la red no permite deducirlo sin inventar: por esa parada
   * pasa mas de un sentido de la misma linea (el 5 % de los casos) y la fuente
   * oficial solo dice "Linea N", nunca hacia donde va. Sin sentido, el aviso
   * funciona igual pero no cuenta paradas: mejor no decirlo que decirlo mal,
   * porque el numero llevaria a mirar a la calle equivocada.
   */
  directionKey: string | null
  /**
   * Siempre `true` desde que no hay pausa. Se conserva por los avisos guardados
   * con versiones anteriores, que lo traen.
   */
  active: boolean
  startedAt: number
  lastMinutes: number | null
  lastNotifiedAt: number
  /** Se arma cuando el bus se acerca; al desaparecer o alejarse se da por pasado. */
  armed: boolean
  missingStreak: number
  /** Autobuses ya vistos pasar; el aviso termina al llegar a TRACKING_BUS_TARGET. */
  busesSeen: number
  /**
   * Autobuses que dejar pasar antes del que se sigue: 0 es el proximo, 1 el que
   * viene detras, 2 el siguiente... Sube al crear el aviso eligiendo el 2º
   * autobus y con cada pulsacion de "Saltar" (hasta MAX_TRACKING_SKIP).
   *
   * Los pasos se siguen detectando con el primero, que es el unico que la
   * fuente pone a cero minutos. Cada paso mientras quede alguno por dejar pasar
   * solo descuenta —no suma a busesSeen—, y desde ahi el aviso es uno normal.
   */
  skip: number
  /**
   * El aviso corto (vibracion) de "quedan 3 minutos" ya se ha dado para el
   * autobus que se espera ahora. Se reinicia con cada autobus que pasa, de modo
   * que vibra una vez por autobus y no una vez por consulta.
   */
  warnedAt3: boolean
}

/**
 * Tope de autobuses que puede seguir un aviso. El numero real lo elige la
 * persona usuaria en Ajustes; este es solo el maximo que admite el selector.
 */
export const TRACKING_BUS_TARGET_MAX = 3

/**
 * Autobuses que un aviso puede tener por delante a la vez sin contarlos: con
 * "Saltar" se llega a seguir el 4º, que es mas de lo que la fuente suele
 * publicar con hora para una misma linea.
 *
 * El servicio nativo lleva su propia copia (MAX_SKIP en BusTrackingService).
 */
export const MAX_TRACKING_SKIP = 3

export function clampSkip(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
  return Math.min(MAX_TRACKING_SKIP, Math.max(0, number))
}

/** Autobuses que ve pasar un aviso antes de darse por terminado. */
export function trackingBusTarget(): number {
  return clampBusTarget(state.settings.trackingBusTarget)
}

export function clampBusTarget(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.min(TRACKING_BUS_TARGET_MAX, Math.max(1, Math.round(value)))
}

/**
 * Minutos restantes a los que el aviso da un toque corto de vibracion.
 *
 * El servicio nativo (BusTrackingService) lleva su propia copia de este numero:
 * tiene que poder avisar con la app cerrada, cuando esta parte ni se ejecuta.
 */
export const TRACKING_WARN_MINUTES = 3

/** Monitorizacion: registra pasos reales en una franja para calcular medias. */
export interface MonitorJob {
  id: string
  stopId: string
  stopName: string
  lineId: string
  /** Sentido elegido; sin el, el horario mezcla los dos sentidos de la parada. */
  directionKey: string | null
  startMinutes: number
  endMinutes: number
  createdAt: number
}

/** Un paso real observado. Es el dato en bruto: todo lo demas se calcula de aqui. */
export interface MonitorPass {
  /** Instante estimado del paso (epoch ms). */
  at: number
  /** Fecha local YYYY-MM-DD, para no contar dos veces el mismo dia. */
  date: string
  dayType: ServiceDayType
  /** Minuto del dia en que paso. */
  minutes: number
  /** Salida programada a la que se ha podido asociar, o null. */
  slot: string | null
  /** Desvio en minutos frente a esa salida (positivo = tarde). */
  delta: number | null
  /** Regla que lo detecto: salto del contador o desaparicion de la linea. */
  reason: 'jump' | 'gone'
}

export type MonitorPasses = Record<string, MonitorPass[]>

/**
 * Una linea del registro de un control de puntualidad.
 *
 * La pantalla de puntualidad se llenaba —o no— sin decir por que. Un control
 * puede pasarse una franja entera sin anotar una sola hora por motivos que no
 * se ven desde fuera: la parada no devuelve esa linea, la fuente esta
 * limitando, el movil durmio entre consulta y consulta, o el paso se detecto
 * pero el horario oficial no tenia ninguna salida cerca. Cada consulta deja
 * aqui lo que vio y lo que decidio, y eso es lo que ensena la tarjeta.
 */
export interface MonitorTrace {
  at: number
  /** Minutos que devolvio la fuente para esa linea, o `null` si no figuraba. */
  minutes: number | null
  /** Estaba el control con un autobus "entrando" cuando se observo. */
  armed: boolean
  /** Que ocurrio, ya redactado para leerse. */
  note: string
  level: 'info' | 'warn' | 'error'
}

/** Lineas de registro que se conservan por control. */
export const MAX_TRACE_PER_MONITOR = 60

/** Cuantos pasos se conservan por control (unos dos meses de una franja diaria). */
export const MAX_PASSES_PER_MONITOR = 400

/* ------------------------------------------------------------------ *
 * Limites de las funciones de seguimiento                              *
 * ------------------------------------------------------------------ */

/**
 * Avisos de "proximo bus" que puede haber a la vez: UNO.
 *
 * Un aviso consulta su parada cada 15 s y ademas rastrea las paradas anteriores
 * para situar el autobus; la fuente oficial limita por IP y solo admite una
 * peticion cada dos segundos. Con dos, los dos llegan tarde. Antes se podian
 * tener dos creados y alternar con pausa/reanudar; ahora crear uno nuevo
 * sustituye al que hubiera, sin preguntar: lo ultimo que se pide es lo que se
 * quiere mirar.
 */
export const MAX_TRACKING_JOBS = 1

/* ------------------------------------------------------------------ *
 * Ritmo de refresco                                                    *
 * ------------------------------------------------------------------ */

/**
 * Cada cuanto se reevalua QUE hay que refrescar. No es cuanto se le pide a la
 * web: eso lo marca la cola de `arrivals.ts`, que separa las peticiones 2 s.
 */
export const TICK_MS = 1_000

/** Cadencia minima entre lotes automaticos completos. */
export const AUTO_CYCLE_MS = 20_000

/** Ciclo del servicio nativo para un aviso de proximo bus. */
export const TRACKING_INTERVAL_SECONDS = 15

/**
 * Frescura objetivo de una parada segun el uso que se le este dando.
 *
 * Una parada solo se vuelve a pedir cuando su dato pasa de estos milisegundos,
 * asi que esto ES la frecuencia de actualizacion de cada funcion. Viven aqui y
 * no en `main.ts` porque Ajustes las enseña: un numero contado en dos sitios
 * acaba diciendo dos cosas distintas.
 */
export const FRESHNESS = {
  /** Parada abierta en pantalla (desplegada, ficha del buscador, aviso activo). */
  focused: 15_000,
  /** Resto de paradas guardadas visibles. Hoy solo se usa en el repaso de arranque. */
  visible: 45_000,
  /**
   * Paradas anteriores de un aviso MIENTRAS SE MIRA su pestana.
   *
   * Es el recorrido entero, dibujado parada a parada. Solo se sostiene con la
   * pestana Seguir delante: son ocho paradas por ciclo contra una fuente que
   * admite una peticion cada dos segundos.
   */
  routeVisible: 20_000,

  /**
   * Paradas anteriores de un aviso FUERA de su pestana o en segundo plano.
   *
   * Ahi el recorrido no se dibuja —nadie lo mira— y lo unico que hace falta es
   * el "a N paradas" de la notificacion, que se resuelve buscando de tu parada
   * hacia atras y parando en la primera que tenga el autobus encima. Mas
   * espaciado porque es informacion secundaria: lo que el aviso tiene que
   * clavar es el tiempo de SU parada, y esa va aparte a 15 s. Un autobus urbano
   * tarda minuto y medio entre paradas, asi que medio minuto de retraso en el
   * recuento no llega a valer media parada.
   */
  routeBackground: 30_000,
  /** Parada de un control de puntualidad dentro de su franja. */
  monitor: 30_000,
}

/* La deteccion de por donde viene el autobus vive en
   `src/services/bus-position.ts`: es logica pura, se comparte entre "ver por
   donde viene" y el aviso de proximo bus, y esta portada a Java en el servicio
   nativo. Tenerla aparte es lo que permite comprobarla desde Node. */

/**
 * Fase de refresco de una parada concreta. Las consultas van SIEMPRE en serie
 * (la fuente oficial limita por IP), asi que en una lista larga conviven
 * paradas ya actualizadas, una en curso y varias esperando turno.
 */
export type StopSyncPhase = 'queued' | 'loading'

export interface LogEntry {
  id: string
  at: number
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
}

/**
 * Fase del aviso de actualizacion. El boton principal absorbe el estado en su
 * propia etiqueta (Actualizar → Descargando… 45 % → Instalar → Reintentar) en
 * vez de ir anadiendo elementos al aviso.
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  release: ReleaseInfo | null
  /** -1 mientras no haya Content-Length: no se inventa un porcentaje. */
  percent: number
  /** Ruta local de la APK ya descargada; sobrevive a un permiso denegado. */
  downloadedPath: string | null
  /** El permiso de «instalar apps desconocidas» se concede fuera de la app. */
  canInstall: boolean
  error: string | null
  /** El aviso se puede posponer; vuelve en el siguiente arranque. */
  dismissed: boolean
  /** Resultado de la comprobacion MANUAL de Ajustes, que si cuenta lo que pasa. */
  manualMessage: { text: string, tone: 'info' | 'warn' | 'error' } | null
  manualChecking: boolean
}

export interface AppState {
  ready: boolean
  bootPhase: string
  bootError: string | null

  network: Network | null
  schedule: ScheduleDataset | null
  scheduleError: string | null

  tab: TabId
  toast: { message: string, tone: 'info' | 'error' | 'success' } | null

  feeds: Record<string, StopFeed>
  /**
   * Paradas en las que se han pedido los pasos del horario GTFS porque la fuente
   * en tiempo real no contestaba. Solo en memoria: se borra en cuanto la parada
   * vuelve a recibir datos reales, y el siguiente fallo vuelve a ofrecer el boton.
   */
  scheduleFallbackStops: Record<string, true>
  /** Paradas en cola o en curso dentro del ciclo de refresco actual. */
  stopSync: Record<string, StopSyncPhase>
  refreshing: boolean
  refreshQueueLabel: string | null
  lastRefreshAt: number | null

  search: {
    mode: SearchMode
    query: string
    lineId: string
    directionKey: string
    selectedStopId: string | null
    /** El mapa pasa a pantalla completa al elegir linea y sentido. */
    mapExpanded: boolean
    /**
     * Panel de "acotar por linea", desplegado a mano.
     *
     * Lo lleva el estado y no el navegador: el repintado es incremental y borra
     * los atributos que ya no vienen en el HTML, asi que el `open` de un
     * `<details>` desaparecia en el siguiente latido del reloj.
     */
    lineFilterOpen: boolean
  }

  /**
   * Ubicacion del dispositivo, compartida por "paradas cercanas" (Buscar) y por
   * el planificador de rutas (Mapas).
   *
   * Vive fuera de `maps` porque las dos pantallas la necesitan y la pestana
   * experimental se vacia entera al salir de ella: tenerla ahi dentro obligaba
   * a volver a localizar cada vez que se cambiaba de pestana.
   */
  geo: GeoState

  favourites: FavouriteStop[]
  expandedStopId: string | null
  /**
   * LA parada (una sola) cuya lista de llegadas esta desplegada mas alla de
   * ARRIVALS_PREVIEW.
   *
   * Es un unico hueco a proposito: la vista compacta es la predeterminada y se
   * recupera sola. Al abrir cualquier otra parada este hueco se vacia, asi que
   * haber desplegado una no deja desplegadas las que se abran despues.
   */
  arrivalsExpandedStopId: string | null

  trackings: TrackingJob[]
  /**
   * A cuantas paradas viene el autobus de cada aviso, segun el SERVICIO nativo.
   *
   * Mientras el servicio vive es el unico que mira las paradas anteriores: que
   * lo hicieran los dos serian el doble de peticiones contra una fuente que
   * limita por IP, y ademas dos recuentos que podrian discrepar. Con la app en
   * el navegador —o sin servicio— esto queda vacio y el recuento se calcula
   * aqui, con los datos que ya hay en `feeds`.
   *
   * No se guarda en disco: una posicion de hace horas no es una posicion.
   */
  trackingStopsAway: Record<string, { stopsAway: number, at: number }>
  monitors: MonitorJob[]
  monitorPasses: MonitorPasses
  monitorRuntime: Record<string, MonitorRuntime>
  monitorDayView: Record<string, ServiceDayType>
  /** Ultima vez que cada control miro su parada; alimenta el estado en pantalla. */
  monitorSeenAt: Record<string, number>
  /** Registro de lo que ve y decide cada control, para poder explicar un hueco. */
  monitorTrace: Record<string, MonitorTrace[]>
  /** Controles cuyo registro esta desplegado en la pantalla de puntualidad. */
  monitorTraceOpen: Record<string, boolean>

  sheet:
    | { kind: 'stop-actions', stopId: string }
    | { kind: 'pick-line', stopId: string, purpose: 'tracking' | 'monitor' }
    | { kind: 'rename', stopId: string }
    | null

  draft: {
    lineId: string
    directionKey: string
    /** Aviso nuevo: 0 sigue al 1er autobus disponible, 1 al 2º. */
    skip: number
    startMinutes: number
    endMinutes: number
    alias: string
  }

  permissions: {
    notifications: PermissionState
    battery: PermissionState
  }

  settings: AppSettings

  maps: MapsState

  /** La pestaña Info: qué apartado está abierto y qué línea se está mirando. */
  info: InfoState

  /** Apartado abierto de Ajustes. No se guarda: cada visita empieza en funciones. */
  settingsSection: SettingsSection

  tour: TourState

  /**
   * Version realmente instalada, la que dice el sistema.
   *
   * Arranca con la del bundle y se corrige nada mas abrir la app. No son
   * siempre lo mismo: si la WebView sirviera una copia vieja de la pagina, el
   * numero del bundle se quedaria congelado y la app se ofreceria a si misma la
   * actualizacion que acaba de instalar.
   */
  installed: { versionName: string, versionCode: number }

  update: UpdateState

  logs: LogEntry[]
}

/* ------------------------------------------------------------------ *
 * Ubicacion del dispositivo                                            *
 * ------------------------------------------------------------------ */

/**
 * Donde estas, y por que no se sabe cuando no se sabe.
 *
 * NO se guarda en disco. Una ubicacion es del momento en que se pidio, y
 * arrancar la app con la posicion de ayer marcada en el mapa enganaria.
 */
export interface GeoState {
  /** Ultima lectura conocida, con su margen de error en metros. */
  location: { point: GeoPoint, accuracy: number, at: number } | null
  locating: boolean
  /**
   * Se le esta preguntando al sistema si la ubicacion esta encendida.
   *
   * Es un paso ANTERIOR a localizar, y por eso tiene su propio indicador: la
   * comprobacion tarda un instante, mientras que `locating` puede tardar veinte
   * segundos. Enseñar "buscando tu ubicacion…" durante la comprobacion prometia
   * una busqueda que a lo mejor ni llegaba a empezar.
   */
  checkingService: boolean
  /** Motivo por el que no hay ubicacion, ya redactado para leerse en pantalla. */
  error: string | null
  /**
   * Que falta exactamente para poder localizar.
   *
   * Desde la pagina los dos fallos se ven igual —la geolocalizacion no
   * responde— pero se arreglan en pantallas distintas del sistema: 'service' es
   * el interruptor de ubicacion del telefono, 'permission' es el permiso de
   * SALBUS. Decir "activa la ubicacion" sin decir donde no ayuda a nadie.
   */
  blocked: 'service' | 'permission' | null
}

export function emptyGeoState(): GeoState {
  return { location: null, locating: false, checkingService: false, error: null, blocked: null }
}

/* ------------------------------------------------------------------ *
 * Pestana experimental "Mapas"                                         *
 * ------------------------------------------------------------------ */

/** Un extremo de la ruta: donde estoy, o una parada elegida a mano. */
export interface RoutePoint {
  kind: 'location' | 'stop'
  label: string
  lat: number
  lon: number
  /** Solo cuando el punto ES una parada de la red. */
  stopId?: string
}

/**
 * Todo lo del planificador de rutas vive aqui dentro y NO se guarda en disco.
 *
 * La pestana quedo reducida a las rutas: las paradas cercanas se buscan ahora
 * en Buscar, que es donde se busca una parada. Al salir de la pestana esto se
 * vacia entero, asi que apagada no ocupa ni memoria. Lo unico que sobrevive es
 * la ubicacion, que vive aparte (`state.geo`) porque tambien la usa Buscar.
 */
export interface MapsState {
  /** El mapa de la pestaña, a pantalla completa. */
  expanded: boolean

  origin: RoutePoint | null
  destination: RoutePoint | null
  /** Campo que se esta rellenando; con null no hay buscador abierto. */
  picking: 'origin' | 'destination' | null
  query: string

  plan: PlanOutcome | null
  planning: boolean
  /** Tramo del itinerario resaltado en el mapa. */
  focusedLeg: number | null
}

/* ------------------------------------------------------------------ *
 * Pestana "Info"                                                       *
 * ------------------------------------------------------------------ */

/**
 * Qué se está consultando en la pestaña Info.
 *
 * La línea y el sentido NO se guardan en disco a propósito: son una consulta
 * puntual ("¿a qué hora sale el último 4?"), no una preferencia. Arrancar la
 * app con una línea ya elegida haría creer que ese horario es el de tu parada.
 */
export interface InfoState {
  section: InfoSection
  /** Línea cuyo horario se está mirando; vacío mientras no se elija ninguna. */
  lineId: string
  /** Sentido dentro de esa línea; vacío hasta elegirlo. */
  directionKey: string
}

export function emptyInfoState(): InfoState {
  return { section: 'llegar', lineId: '', directionKey: '' }
}

export function emptyMapsState(): MapsState {
  return {
    expanded: false,
    origin: null,
    destination: null,
    picking: null,
    query: '',
    plan: null,
    planning: false,
    focusedLeg: null,
  }
}

/* ------------------------------------------------------------------ *
 * Ajustes de la persona usuaria                                        *
 * ------------------------------------------------------------------ */

export interface AppSettings {
  /**
   * Vibracion corta cuando el aviso de proximo bus detecta que quedan 3 minutos.
   * Una sola vez por autobus.
   */
  vibrateOnApproach: boolean

  /**
   * Autobuses que sigue un aviso antes de terminar (1 a TRACKING_BUS_TARGET_MAX).
   *
   * Por defecto uno: quien pone un aviso casi siempre espera EL proximo autobus,
   * y encadenar tres dejaba la notificacion viva mucho despues de haberse
   * subido al primero.
   */
  trackingBusTarget: number

  /**
   * Pestana experimental "Mapas" (planificador de rutas).
   *
   * Apagada por defecto y apagada de verdad: con este ajuste en false la
   * pestana no existe, no se pide la ubicacion, no se crea ningun mapa y no se
   * calcula nada. Lo experimental no puede robarle recursos —ni turno en la
   * cola de consultas— a lo que ya funciona.
   */
  experimentalMaps: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  vibrateOnApproach: true,
  trackingBusTarget: 1,
  experimentalMaps: false,
}

/* ------------------------------------------------------------------ *
 * Tour de bienvenida                                                   *
 * ------------------------------------------------------------------ */

export interface TourState {
  open: boolean
  step: number
}

/** Llegadas que se ven de una parada antes de pulsar "Ver mas". */
export const ARRIVALS_PREVIEW = 5

/**
 * A partir de aqui el dato de una parada se considera caducado y su ficha
 * enseña la animacion de carga aunque todavia no le haya tocado turno.
 *
 * Un minuto: los tiempos de la fuente vienen en minutos enteros, asi que a los
 * sesenta segundos el numero de la pantalla ya no es el numero. Avisar antes de
 * que llegue el refresco evita leer como bueno algo que esta por cambiar.
 */
export const ARRIVALS_STALE_MS = 60_000

const KEYS = {
  favourites: 'salbus.favourites',
  /** Formato antiguo: un unico aviso guardado como objeto suelto. */
  tracking: 'salbus.tracking',
  trackings: 'salbus.trackings',
  settings: 'salbus.settings',
  tourVersion: 'salbus.tourVersion',
  monitors: 'salbus.monitors',
  monitorStats: 'salbus.monitorStats',
  monitorPasses: 'salbus.monitorPasses',
  monitorRuntime: 'salbus.monitorRuntime',
  monitorTrace: 'salbus.monitorTrace',
  /** Formato antiguo: los "ver por donde viene", retirados al fusionarse. */
  follows: 'salbus.follows',
  logs: 'salbus.logs',
  tab: 'salbus.tab',
  /** Compilacion que se mando instalar la ultima vez (ver readInstallAttempt). */
  updateAttempt: 'salbus.updateAttempt',
}

/**
 * Avisos de proximo bus guardados.
 *
 * Hasta la v4.3 solo podia haber uno y se guardaba como objeto suelto en
 * `salbus.tracking`. Ese formato se migra a la lista actual para no perder el
 * aviso en curso al actualizar.
 */
function readTrackings(): TrackingJob[] {
  const stored = readJson<TrackingJob[]>(KEYS.trackings, [])
  const list = Array.isArray(stored) && stored.length > 0
    ? stored
    : [readJson<TrackingJob | null>(KEYS.tracking, null)].filter(
        (item): item is TrackingJob => item !== null,
      )

  // Hasta la v6.3 podia haber dos (uno de ellos en pausa). Se queda el que
  // estaba activo, y entre iguales el mas reciente.
  return list
    .filter((job) => job && typeof job.id === 'string')
    .sort((left, right) =>
      Number(right.active !== false) - Number(left.active !== false)
      || (right.startedAt ?? 0) - (left.startedAt ?? 0))
    .slice(0, MAX_TRACKING_JOBS)
    .map((job) => ({
      ...job,
      // Los avisos guardados antes de que existiera el recuento de paradas no
      // traen sentido; `resolveTrackingDirection` se lo pone al arrancar, que
      // es cuando la red ya esta cargada.
      directionKey: typeof job.directionKey === 'string' ? job.directionKey : null,
      busesSeen: typeof job.busesSeen === 'number' ? job.busesSeen : 0,
      skip: clampSkip(job.skip),
      warnedAt3: job.warnedAt3 === true,
      // Ya no hay pausa: el aviso que queda es el que trabaja.
      active: true,
    }))
}

/**
 * Tira los "ver por donde viene" guardados.
 *
 * La modalidad ya no existe: el aviso hace las dos cosas. No se convierten en
 * avisos a proposito —un recorrido no publicaba notificacion ni vibraba, y
 * convertirlo pondria a sonar el movil de quien nunca pidio que sonara—, asi
 * que se retiran y quien los quiera los vuelve a crear como aviso.
 */
function dropLegacyFollows(): void {
  try {
    window.localStorage.removeItem(KEYS.follows)
  } catch {
    /* almacenamiento no disponible */
  }
}

// La modalidad "ver por donde viene" ya no existe: lo que quedara guardado de
// ella se retira al arrancar, antes de montar el estado.
dropLegacyFollows()

export const state: AppState = {
  ready: false,
  bootPhase: 'Iniciando…',
  bootError: null,

  network: null,
  schedule: null,
  scheduleError: null,

  tab: readTab(),
  toast: null,

  feeds: {},
  scheduleFallbackStops: {},
  stopSync: {},
  refreshing: false,
  refreshQueueLabel: null,
  lastRefreshAt: null,

  search: {
    mode: 'parada',
    query: '',
    lineId: '',
    directionKey: '',
    selectedStopId: null,
    mapExpanded: false,
    lineFilterOpen: false,
  },

  geo: emptyGeoState(),

  favourites: readJson<FavouriteStop[]>(KEYS.favourites, []).filter(
    (item) => typeof item?.stopId === 'string',
  ),
  expandedStopId: null,
  arrivalsExpandedStopId: null,

  // busesSeen no existia en versiones anteriores: un aviso guardado sin el empieza a contar de cero.
  trackings: readTrackings(),
  trackingStopsAway: {},
  monitors: readJson<MonitorJob[]>(KEYS.monitors, [])
    .filter((item) => typeof item?.id === 'string')
    .map((item) => ({ ...item, directionKey: item.directionKey ?? null })),
  monitorPasses: readPasses(),
  monitorRuntime: readJson<Record<string, MonitorRuntime>>(KEYS.monitorRuntime, {}),
  monitorDayView: {},
  monitorSeenAt: {},
  monitorTrace: readJson<Record<string, MonitorTrace[]>>(KEYS.monitorTrace, {}),
  monitorTraceOpen: {},
  sheet: null,

  draft: {
    lineId: '',
    directionKey: '',
    skip: 0,
    startMinutes: 7 * 60,
    endMinutes: 8 * 60,
    alias: '',
  },

  update: {
    phase: 'idle',
    release: null,
    percent: -1,
    downloadedPath: null,
    canInstall: false,
    error: null,
    dismissed: false,
    manualMessage: null,
    manualChecking: false,
  },

  permissions: {
    notifications: 'unknown',
    battery: 'unknown',
  },

  settings: readSettings(),

  maps: emptyMapsState(),

  info: emptyInfoState(),

  settingsSection: 'funciones',

  // El tour se abre solo la primera vez que se arranca cada version nueva.
  tour: { open: readTourVersion() !== APP_VERSION, step: 0 },

  installed: { versionName: __APP_VERSION__, versionCode: APP_VERSION_CODE },

  logs: readJson<LogEntry[]>(KEYS.logs, []),
}

/* ------------------------------------------------------------------ *
 * Persistencia                                                         *
 * ------------------------------------------------------------------ */

export function persistFavourites(): void {
  writeJson(KEYS.favourites, state.favourites)
}

export function persistTrackings(): void {
  writeJson(KEYS.trackings, state.trackings)
  // El formato antiguo se retira: dejarlo escrito revivria avisos ya borrados.
  try {
    window.localStorage.removeItem(KEYS.tracking)
  } catch {
    /* almacenamiento no disponible */
  }
}

export function persistSettings(): void {
  writeJson(KEYS.settings, state.settings)
}

function readTourVersion(): string | null {
  try {
    return window.localStorage.getItem(KEYS.tourVersion)
  } catch {
    return null
  }
}

/** Marca el tour de ESTA version como visto; volvera con la siguiente. */
export function markTourSeen(): void {
  try {
    window.localStorage.setItem(KEYS.tourVersion, APP_VERSION)
  } catch {
    /* almacenamiento no disponible */
  }
}

export function persistMonitors(): void {
  writeJson(KEYS.monitors, state.monitors)
}

export function persistMonitorPasses(): void {
  writeJson(KEYS.monitorPasses, state.monitorPasses)
}

export function persistMonitorRuntime(): void {
  writeJson(KEYS.monitorRuntime, state.monitorRuntime)
}

/**
 * Registra un paso observado. Un mismo dia y una misma salida programada solo
 * cuentan una vez: si se repite, gana la observacion mas reciente.
 */
export function addMonitorPass(monitorId: string, pass: MonitorPass): void {
  const previous = state.monitorPasses[monitorId] ?? []
  const filtered = previous.filter(
    (item) => !(item.date === pass.date && item.slot !== null && item.slot === pass.slot),
  )

  state.monitorPasses[monitorId] = [...filtered, pass]
    .sort((left, right) => left.at - right.at)
    .slice(-MAX_PASSES_PER_MONITOR)

  persistMonitorPasses()
}

export function persistMonitorTrace(): void {
  writeJson(KEYS.monitorTrace, state.monitorTrace)
}

/**
 * Anota lo observado por un control.
 *
 * Se guarda en disco porque la franja se mide tambien con la app cerrada: al
 * volver a abrirla, el registro es lo unico que puede contar que ocurrio
 * mientras nadie miraba. Se descarta la repeticion inmediata del mismo mensaje
 * para que media hora de "la linea no figura" no tape las tres lineas que
 * importan.
 */
export function addMonitorTrace(monitorId: string, entry: MonitorTrace): void {
  const list = state.monitorTrace[monitorId] ?? []
  const last = list[list.length - 1]

  if (last && last.note === entry.note && last.minutes === entry.minutes && entry.at - last.at < 120_000) {
    return
  }

  state.monitorTrace[monitorId] = [...list, entry].slice(-MAX_TRACE_PER_MONITOR)
  persistMonitorTrace()
}

export function clearMonitorTrace(monitorId: string): void {
  delete state.monitorTrace[monitorId]
  persistMonitorTrace()
}

export function localDateKey(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

/**
 * Lee los pasos guardados y, la primera vez, convierte el formato antiguo
 * (`salbus.monitorStats`: medias por hora programada) para no perder historico.
 */
function readPasses(): MonitorPasses {
  const stored = readJson<MonitorPasses>(KEYS.monitorPasses, {})
  if (Object.keys(stored).length > 0) {
    return stored
  }

  const legacy = readJson<Record<string, Record<string, Record<string, { slot: string, byDate: Record<string, number> }>>>>(
    KEYS.monitorStats,
    {},
  )

  const migrated: MonitorPasses = {}

  for (const [monitorId, byDayType] of Object.entries(legacy)) {
    for (const [dayType, bySlot] of Object.entries(byDayType ?? {})) {
      for (const sample of Object.values(bySlot ?? {})) {
        for (const [date, minutes] of Object.entries(sample?.byDate ?? {})) {
          const at = new Date(`${date}T00:00:00`).getTime() + minutes * 60_000
          const list = migrated[monitorId] ?? (migrated[monitorId] = [])
          list.push({
            at,
            date,
            dayType: dayType as ServiceDayType,
            minutes,
            slot: sample.slot,
            delta: minutes - parseClockToMinutes(sample.slot),
            reason: 'gone',
          })
        }
      }
    }
  }

  return migrated
}

/**
 * Compilacion que se lanzo a instalar y todavia no se ha confirmado.
 *
 * Android no avisa de si una instalacion salio bien: la app se va al instalador
 * del sistema y, cuando vuelve, lo unico que puede hacer es MIRAR que version
 * hay. Dejando anotado que se intento la 1014, al arrancar se sabe si de verdad
 * se instalo o si aquello se quedo a medias, en vez de volver a ofrecer lo mismo
 * en silencio, que es como se llega a un bucle sin explicacion.
 */
export function readInstallAttempt(): number {
  try {
    return Number.parseInt(window.localStorage.getItem(KEYS.updateAttempt) ?? '0', 10) || 0
  } catch {
    return 0
  }
}

export function writeInstallAttempt(versionCode: number): void {
  try {
    if (versionCode > 0) {
      window.localStorage.setItem(KEYS.updateAttempt, String(versionCode))
    } else {
      window.localStorage.removeItem(KEYS.updateAttempt)
    }
  } catch {
    /* almacenamiento no disponible */
  }
}

export function persistTab(): void {
  try {
    window.localStorage.setItem(KEYS.tab, state.tab)
  } catch {
    /* almacenamiento no disponible */
  }
}

export function log(level: LogEntry['level'], scope: string, message: string): void {
  const previous = state.logs[0]
  // Evita inundar el registro con el mismo mensaje repetido.
  if (previous && previous.message === message && previous.scope === scope && Date.now() - previous.at < 30_000) {
    return
  }

  state.logs = [
    { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), level, scope, message },
    ...state.logs,
  ].slice(0, 200)

  writeJson(KEYS.logs, state.logs)
}

export function clearLogs(): void {
  state.logs = []
  writeJson(KEYS.logs, state.logs)
}

/* ------------------------------------------------------------------ *
 * Utilidades de estado                                                 *
 * ------------------------------------------------------------------ */

export function isFavourite(stopId: string): boolean {
  return state.favourites.some((item) => item.stopId === stopId)
}

export function favouriteLabel(stopId: string, fallback: string): string {
  const favourite = state.favourites.find((item) => item.stopId === stopId)
  return favourite?.alias?.trim() || fallback
}

export function minutesOfDay(reference = new Date()): number {
  return reference.getHours() * 60 + reference.getMinutes()
}

export function isWithinWindow(job: MonitorJob, reference = new Date()): boolean {
  const now = minutesOfDay(reference)
  return now >= job.startMinutes && now < job.endMinutes
}

/**
 * Hay algun control de puntualidad dentro de su franja ahora mismo.
 *
 * Mientras lo haya, medir manda: la pestana Seguir se apaga entera y su turno
 * en la cola de consultas se lo queda la parada que se esta midiendo. Una
 * franja dura minutos; un recorrido puede esperar.
 */
export function anyMonitorWindowOpen(reference = new Date()): boolean {
  return state.monitors.some((monitor) => isWithinWindow(monitor, reference))
}

export function formatMinutesClock(dayMinutes: number): string {
  const normalized = ((dayMinutes % 1440) + 1440) % 1440
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`
}

export function parseClockToMinutes(clock: string): number {
  const [hours = '0', minutes = '0'] = clock.split(':')
  return (Number.parseInt(hours, 10) || 0) * 60 + (Number.parseInt(minutes, 10) || 0)
}

/* ------------------------------------------------------------------ *
 * Puntualidad                                                          *
 * ------------------------------------------------------------------ */

/**
 * Salidas programadas de un control: las de su línea y sentido por esa parada,
 * acotadas a su franja horaria.
 *
 * Acotarlas es esencial: si se aceptaba cualquier salida del día, un paso de las
 * 08:02 en una franja de 07:00 a 08:00 se atribuía a la salida de las 08:05 y la
 * muestra desaparecía de la tabla, que solo enseña las salidas de la franja.
 */
export function monitorSlots(job: MonitorJob, dayType: ServiceDayType): string[] {
  const all = state.schedule?.getScheduledTimes(job.stopId, job.lineId, dayType, job.directionKey) ?? []

  return all.filter((clock) => {
    const minutes = parseClockToMinutes(clock)
    return minutes >= job.startMinutes && minutes < job.endMinutes
  })
}

export interface MonitorRow {
  slot: string
  /** Media de los pasos observados, en minutos del día. */
  average: number | null
  /** Desvío medio frente a la salida programada (positivo = tarde). */
  delta: number | null
  samples: number
  /** Último paso asociado a esta salida. */
  lastAt: number | null
}

export interface MonitorSummary {
  rows: MonitorRow[]
  /** Pasos observados sin ninguna salida programada cerca. */
  unmatched: MonitorPass[]
  /** Todos los pasos de ese tipo de día, del más reciente al más antiguo. */
  passes: MonitorPass[]
  days: number
}

/** Resume lo observado por un control para un tipo de día. */
export function summariseMonitor(job: MonitorJob, dayType: ServiceDayType): MonitorSummary {
  const passes = (state.monitorPasses[job.id] ?? []).filter((pass) => pass.dayType === dayType)
  const bySlot = new Map<string, MonitorPass[]>()

  for (const pass of passes) {
    if (!pass.slot) {
      continue
    }
    const list = bySlot.get(pass.slot)
    if (list) {
      list.push(pass)
    } else {
      bySlot.set(pass.slot, [pass])
    }
  }

  const rows = monitorSlots(job, dayType).map((slot) => {
    const items = bySlot.get(slot) ?? []
    const average = averageMinutes(items.map((item) => item.minutes))

    return {
      slot,
      average,
      delta: average === null ? null : average - parseClockToMinutes(slot),
      samples: items.length,
      lastAt: items.length > 0 ? Math.max(...items.map((item) => item.at)) : null,
    }
  })

  return {
    rows,
    unmatched: passes.filter((pass) => !pass.slot).slice(-12).reverse(),
    passes: [...passes].reverse(),
    days: new Set(passes.map((pass) => pass.date)).size,
  }
}

/* ------------------------------------------------------------------ *
 * localStorage helpers                                                 *
 * ------------------------------------------------------------------ */

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return fallback
    }
    const parsed = JSON.parse(raw) as T
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* cuota agotada o almacenamiento bloqueado */
  }
}

function readTab(): TabId {
  // "info" SI esta en la lista, al contrario que la antigua "mapas": ya no es
  // una pestana experimental que pueda no existir, porque los horarios de linea
  // salen del GTFS que viaja dentro de la app y estan siempre disponibles.
  const valid: TabId[] = ['inicio', 'buscar', 'monitor', 'seguimiento', 'info', 'ajustes']
  try {
    // "paradas" existio hasta la v4.4 como pestaña propia; ahora vive dentro de
    // Inicio, asi que quien la tuviera guardada aterriza justo donde estaba.
    const raw = window.localStorage.getItem(KEYS.tab)
    // "mapas" es el nombre antiguo de "info": quien la tuviera abierta al
    // cerrar la app aterriza en la pestana equivalente y no en Inicio.
    const migrated = raw === 'mapas' ? 'info' : (raw as TabId | null)
    return migrated && valid.includes(migrated) ? migrated : 'inicio'
  } catch {
    return 'inicio'
  }
}

function readSettings(): AppSettings {
  const stored = readJson<Partial<AppSettings>>(KEYS.settings, {})
  const settings = { ...DEFAULT_SETTINGS, ...stored }
  // Guardado por una version anterior (o a mano): se acota antes de usarlo.
  settings.trackingBusTarget = clampBusTarget(settings.trackingBusTarget)
  return settings
}
