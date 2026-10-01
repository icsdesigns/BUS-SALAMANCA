import { Capacitor, registerPlugin } from '@capacitor/core'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import './style.css'

import {
  DEFAULT_MAX_AGE_MS,
  fetchStopArrivals,
  fetchStopsInParallel,
  fetchStopsSequentially,
  estimateBatchDurationMs,
  getClientHealth,
} from './services/arrivals'
import { AT_STOP_MINUTES, ROUTE_WINDOW_STOPS } from './services/bus-position'
import { loadNetwork } from './services/network'
import { checkForUpdate, isNativeAndroid, readInstalledVersion, Updater } from './services/updates'
import { ARM_MINUTES, matchSlot, MISSING_STREAK, observe } from './services/punctuality'
import {
  DEFAULT_WAIT_MINUTES,
  isValidPoint,
  planRoute,
  refineWalking,
  type GeoPoint,
  type Itinerary,
  type PlanOutcome,
} from './services/routing'
import { loadStreetGraph, peekStreetGraph, walkPath } from './services/streets'
import { currentDayType, loadSchedule } from './services/schedule'
import { onWidgetStopTap, syncWidgetStops, takeWidgetStop } from './services/widget'
import {
  cancelNotification,
  ensureNotificationPermission,
  isNative,
  notificationId,
  onNextBusAction,
  showArrivalAlert,
  showOngoingNotification,
  showTrackingNotification,
} from './services/notifications'
import {
  addMonitorPass,
  addMonitorTrace,
  anyMonitorWindowOpen,
  APP_VERSION_CODE,
  AUTO_CYCLE_MS,
  FRESHNESS,
  TICK_MS,
  TRACKING_INTERVAL_SECONDS,
  clearLogs,
  clearMonitorTrace,
  formatMinutesClock,
  favouriteLabel,
  isFavourite,
  isWithinWindow,
  localDateKey,
  log,
  monitorSlots,
  parseClockToMinutes,
  persistFavourites,
  persistMonitorPasses,
  persistMonitorRuntime,
  persistMonitors,
  persistSettings,
  persistTab,
  persistTrackings,
  readInstallAttempt,
  writeInstallAttempt,
  emptyMapsState,
  state,
  clampBusTarget,
  trackingBusTarget,
  TRACKING_WARN_MINUTES,
  markTourSeen,
  MAX_TRACKING_SKIP,
  clampSkip,
  type MonitorJob,
  type RoutePoint,
  type InfoSection,
  type SettingsSection,
  type TabId,
  type TrackingJob,
  type SearchMode,
} from './state'
import type { NetworkStop, StopFeed } from './types'
import { patch } from './dom'
import { esc, liveMinutes, readableTextColor } from './ui'
import {
  describeArrival,
  describeStopsAway,
  nearestStopsForView,
  renderApp,
  stopName,
  TOUR_STEPS,
  trackingDirectionOptions,
  trackingArrival,
  trackingStopsAway,
} from './views'

/* ------------------------------------------------------------------ *
 * Plugins nativos                                                      *
 * ------------------------------------------------------------------ */

interface BatteryOptimizationPlugin {
  isIgnoringBatteryOptimizations(): Promise<{ ignored: boolean }>
  requestIgnoreBatteryOptimizations(): Promise<void>
}

/** Lo que el servicio ha visto en una parada anterior durante su barrido. */
interface RouteStopUpdate {
  stopId: string
  /** -1 es "esa parada no publica ahora esa linea", que no es lo mismo que cero. */
  minutes: number
  arriving: boolean
}

/**
 * Barrido del recorrido, tal y como lo vio el SERVICIO.
 *
 * El servicio ya consultaba estas paradas para localizar el autobus y tiraba el
 * dato; la pantalla "Seguir" lo unico que podia hacer era volver a pedirlo, y no
 * lo hace —dos clientes contra una fuente que admite una peticion cada dos
 * segundos es justo lo que la bloquea—, asi que el recorrido salia dibujado con
 * rayas y un solo tiempo. Ahora lo consultado se comparte.
 */
interface RouteUpdate {
  jobId: string
  lineId: string
  stops: RouteStopUpdate[]
  at: number
}

/**
 * Por donde va el barrido del recorrido de un aviso AHORA MISMO.
 *
 * `RouteUpdate` cuenta lo ya averiguado; esto cuenta lo que se esta
 * averiguando. Son datos distintos y hacen falta los dos: con el servicio
 * nativo vivo, la web no consulta ni una sola de esas paradas, asi que sin este
 * aviso no tiene forma de saber cual esta en curso ni cuales esperan turno, y
 * el recorrido se quedaba inmovil un cuarto de minuto sin indicio de estar
 * trabajando.
 *
 * `route` llega entero para poder BORRAR el estado de las paradas de este aviso
 * antes de aplicar el nuevo: sin la lista completa, una parada que saliera de
 * la cola se quedaria encendida para siempre.
 */
interface RouteProgress {
  jobId: string
  route: string[]
  queued: string[]
  loading: string | null
  at: number
}

interface TrackingUpdate {

  /** `${stopId}|${lineId}`: identifica a cuál de los avisos vivos pertenece. */
  jobId: string
  stopId: string
  lineId: string
  minutes: number
  arriving: boolean
  status: 'ok' | 'empty' | 'throttled' | 'error'
  /** Autobuses ya contados por el servicio, que es quien manda mientras esta vivo. */
  busesSeen: number
  /** El aviso ha completado los tres autobuses y se esta cerrando. */
  finished: boolean
  /**
   * Paradas anteriores a las que viene el autobus segun el servicio, o -1 si no
   * consta. Cero es "en tu parada", que es un dato y no una ausencia de dato:
   * por eso el "no se sabe" es -1 y no 0.
   */
  stopsAway: number
  /** El autobús de detrás, -1 si no consta. Versiones antiguas del servicio no lo mandan. */
  nextMinutes?: number
  nextArriving?: boolean
  /** Autobuses que al servicio le quedan por dejar pasar. */
  skip?: number
  /**
   * Todos los autobuses de la línea en la última consulta, en orden de llegada
   * (-1 en minutos si no consta). Con "Saltar" se puede seguir al 3º o al 4º, y
   * con solo el primero y el de detrás la pantalla no tendría su hora.
   */
  line?: { minutes: number, arriving: boolean }[]
  at: number
}

interface BusPassedUpdate {
  jobId: string
  stopId: string
  lineId: string
  busesSeen: number
  target: number
  /** Autobuses que aún quedan por dejar pasar tras este paso. */
  skip?: number
  at: number
}

interface TrackingJobPayload {
  id: string
  stopId: string
  stopName: string
  lineId: string
  destination: string
  busesSeen: number
  /** Paradas anteriores del recorrido, de la mas cercana a la mas lejana. */
  routeStops: string[]
  /**
   * Sentido elegido. El servicio no lo usa: lo devuelve tal cual si el aviso se
   * renueva desde "Siguiente bus", para no tener que volver a preguntarlo.
   */
  directionKey: string
  /** Autobuses que dejar pasar antes del que se sigue (0 = el próximo). */
  skip: number
}

/** Un aviso que se vuelve a crear con el botón "Siguiente bus" de su notificación final. */
interface RenewedJob {
  id: string
  stopId: string
  stopName: string
  lineId: string
  directionKey: string | null
}

/** Un control de puntualidad tal y como lo entiende el servicio nativo. */
interface MonitorJobPayload {
  id: string
  stopId: string
  stopName: string
  lineId: string
  startMinutes: number
  endMinutes: number
}

/** Un paso detectado en segundo plano, todavía sin emparejar con el horario. */
interface NativePass {
  monitorId: string
  at: number
  reason: 'jump' | 'gone'
}

interface BusTrackingPlugin {
  /**
   * Sustituye lo que el servicio tiene vivo por estas listas. Las dos vacías
   * detienen el servicio.
   */
  sync(options: {
    jobs: TrackingJobPayload[]
    /** Controles de puntualidad: se miden dentro de su franja, con la app cerrada. */
    monitors: MonitorJobPayload[]
    intervalSeconds: number
    vibrateOnApproach: boolean
    /** Autobuses que hay que ver pasar antes de cerrar cada aviso (1 a 3). */
    busTarget: number
  }): Promise<void>
  stop(): Promise<void>
  /**
   * "Saltar": el aviso deja de seguir al autobús que seguía y pasa al de detrás.
   * Devuelve los autobuses que le quedan por dejar pasar según el servicio.
   */
  skip(options: { jobId: string }): Promise<{ skip?: number }>
  /** `stopped`: avisos que se detuvieron desde su notificacion, quiza sin la app abierta. */
  status(): Promise<{ running: boolean, stopped: string[] }>
  clearStopped(): Promise<void>
  /**
   * Avisa de si la pantalla "Seguir" esta delante dibujando el recorrido.
   *
   * Con ella delante el servicio recorre la ventana ENTERA en vez de parar en el
   * autobus: parar basta para el "a N paradas" de la notificacion, pero el
   * recorrido dibujado necesita las ocho paradas. El servicio no puede saber por
   * si mismo que pestaña se esta mirando.
   */
  setRouteWatch(options: { watching: boolean }): Promise<void>

  /** Entrega los pasos medidos en segundo plano Y los borra: solo se leen una vez. */
  takePasses(): Promise<{ passes: NativePass[] }>
  /** Avisos renovados con "Siguiente bus" con la app cerrada. Se leen una sola vez. */
  takeRenewed(): Promise<{ jobs: RenewedJob[] }>
  addListener(
    event: 'arrivalUpdate',
    handler: (update: TrackingUpdate) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: 'routeUpdate',
    handler: (update: RouteUpdate) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: 'routeProgress',
    handler: (update: RouteProgress) => void,
  ): Promise<{ remove: () => Promise<void> }>

  addListener(
    event: 'busPassed',
    handler: (update: BusPassedUpdate) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: 'jobStopped',
    handler: (update: { jobId: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: 'jobRenewed',
    handler: (update: RenewedJob) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

/**
 * Pantallas de ajustes del sistema.
 *
 * El interruptor general de ubicacion del telefono y el permiso de SALBUS son
 * dos cosas distintas que desde la pagina se ven igual: la geolocalizacion no
 * responde. Este plugin es lo que permite distinguirlas y llevar a quien mira
 * hasta la pantalla concreta donde se arregla.
 */
interface DeviceSettingsPlugin {
  isLocationEnabled(): Promise<{ enabled: boolean }>
  openLocationSettings(): Promise<void>
  openAppSettings(): Promise<void>
}

const BatteryOptimization = registerPlugin<BatteryOptimizationPlugin>('BatteryOptimization')
const DeviceSettings = registerPlugin<DeviceSettingsPlugin>('DeviceSettings')
const BusTracking = registerPlugin<BusTrackingPlugin>('BusTracking')

/* ------------------------------------------------------------------ *
 * Constantes de refresco                                               *
 * ------------------------------------------------------------------ */

/* TICK_MS, AUTO_CYCLE_MS, FRESHNESS y TRACKING_INTERVAL_SECONDS viven en
   `state.ts`: Ajustes los enseña en la tarjeta "Frecuencias de actualizacion" y
   un numero contado en dos sitios acaba diciendo dos cosas distintas. */

/**
 * Controles de puntualidad que el servicio nativo mide a la vez.
 *
 * Coincide con `MAX_MONITORS` de BusTrackingService: por encima de ese numero el
 * servicio se queda con los primeros, asi que conviene decirlo en el registro en
 * lugar de dejar controles callados que no miden nada.
 */
const MAX_BACKGROUND_MONITORS = 6

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('No se encontró el contenedor #app.')
}

const appRoot = root

let renderQueued = false
let lastAutoCycleAt = 0

/** Última vez que se recogieron los pasos medidos por el servicio nativo. */
let lastDrainAt = 0

/**
 * El servicio nativo esta al mando de los avisos.
 *
 * Mientras lo este, la parte web no publica sus propias notificaciones: serian
 * avisos duplicados, y los de la web se congelarian en cuanto la app pasara a
 * segundo plano. Tampoco cuenta autobuses aqui, para no contar dos veces.
 */
let trackingServiceActive = false

/**
 * Controles de puntualidad que mide el servicio nativo.
 *
 * De los que estan aqui NO se detectan pasos en la web: el servicio consulta
 * también con la app cerrada y ya lleva su propia deteccion, asi que hacerlo en
 * los dos sitios apuntaria el mismo autobus dos veces. Es un conjunto y no un
 * simple interruptor porque el servicio solo admite un numero de controles: los
 * que se queden fuera siguen midiendose aqui, con la app abierta.
 */
let nativeMonitorIds = new Set<string>()
let refreshInFlight = false
let toastTimer: number | null = null

/**
 * El repaso de arranque ya se ha hecho en esta sesion.
 *
 * Es UNA sola pasada por todas las paradas guardadas, en serie. Sirve para
 * disimular el retardo propio de la fuente: cuando alguien despliega su parada
 * el dato ya esta ahi, en vez de mirar dos segundos de esqueleto. Solo una:
 * mantener las diez guardadas al dia en vivo gastaria la cola entera contra una
 * fuente que limita por IP, y plegadas ni siquiera se enseñan tiempos.
 */
let bootPrimeDone = false

/**
 * Elemento al que hay que desplazarse en el proximo repintado.
 *
 * El desplazamiento no puede hacerse en el manejador: el nodo destino todavia
 * no existe hasta que `patch` aplica el HTML nuevo.
 */
let scrollPending: string | null = null
let map: L.Map | null = null
let mapLayer: L.LayerGroup | null = null
let mapSignature = ''
/**
 * Firma de lo ULTIMO DIBUJADO en el mapa del buscador.
 *
 * Va aparte de `mapSignature` porque son dos preguntas distintas: aquella
 * decide si hay que reencuadrar el mapa, y esta si hay que volver a colocar los
 * marcadores. Acercar el mapa cambia lo segundo sin tocar lo primero.
 */
let mapPaintKey = ''

/* ------------------------------------------------------------------ *
 * Arranque                                                             *
 * ------------------------------------------------------------------ */

/**
 * Duracion EXACTA de la pantalla de carga.
 *
 * Tiene que coincidir con las animaciones de `.splash` en `style.css`: la
 * pantalla no se retira antes de que terminen, o el icono se iria a media
 * entrada. Un segundo es lo que tarda en leerse la marca; mas que eso es hacer
 * esperar por una animacion a quien solo quiere saber cuanto falta para su
 * autobus.
 */
const SPLASH_MS = 1_000

void bootstrap()

async function bootstrap(): Promise<void> {
  const splashStartedAt = Date.now()

  render()

  try {
    state.bootPhase = 'Cargando la red de líneas…'
    render()
    state.network = await loadNetwork()
    log('info', 'red', `${state.network.lineCount} líneas y ${state.network.directionCount} sentidos cargados.`)

    // El horario programado solo alimenta la pantalla de puntualidad: si falla,
    // la app sigue siendo plenamente utilizable.
    state.bootPhase = 'Cargando el horario oficial…'
    render()
    try {
      state.schedule = await loadSchedule(state.network)
      if (state.schedule.stale) {
        log('warn', 'horario', `El GTFS incluido caducó el ${state.schedule.validTo ?? 'desconocido'}.`)
      }
    } catch (error) {
      state.scheduleError = 'No se pudo cargar el horario programado; la puntualidad no estará disponible.'
      log('warn', 'horario', errorMessage(error))
    }

    state.ready = true
    dropStaleFavourites()
    backfillTrackingDirections()
    // El widget se pinta con lo ultimo que se le mando: esta es la ocasion de
    // corregirlo si la red oficial acaba de tirar alguna parada guardada.
    refreshWidget()
  } catch (error) {
    state.bootError = `No se pudo iniciar la aplicación: ${errorMessage(error)}`
    log('error', 'arranque', errorMessage(error))
  }

  // La animación dura 1 s exacto; no se retira antes para que no parpadee.
  const elapsed = Date.now() - splashStartedAt
  window.setTimeout(() => dismissSplash(), Math.max(0, SPLASH_MS - elapsed))

  render()

  void setupPermissions()
  // Si la app se ha abierto pulsando una parada del widget, su hoja del aviso
  // sale ahora: la red ya esta cargada y hay lineas que ofrecer.
  void checkWidgetTap()
  void onWidgetStopTap(() => void checkWidgetTap())
  await restoreTrackingService()

  window.setInterval(tick, TICK_MS)
  document.addEventListener('visibilitychange', () => {
    // Al perder la pantalla el recorrido deja de dibujarse, asi que el servicio
    // vuelve a parar la busqueda en cuanto encuentra el autobus. Es la mitad
    // cara del barrido, y nadie la esta mirando.
    void syncRouteWatch()

    if (document.visibilityState !== 'visible') {
      // No hay nada mas que parar: el aviso tiene que seguir vivo justamente
      // aquí, y su rastreo ya se reduce solo al perder la pantalla (el plan de
      // refresco mira `visibilityState`).
      return
    }

    if (document.visibilityState === 'visible') {
      void refreshVisible('manual')
      // Pulsar el widget trae la app desde segundo plano: la parada elegida
      // espera en la parte nativa y se recoge justo aqui.
      void checkWidgetTap()
      // Mientras la app no estaba delante, quien medía era el servicio nativo.
      void drainNativePasses()
      void syncPermissions()
      // El permiso de instalacion se concede en una pantalla de ajustes DEL
      // SISTEMA, y nada dentro de la app avisa de que ha cambiado. Sin releerlo
      // aqui, el aviso seguiria pidiendolo para siempre despues de concederlo.
      void syncInstallPermission()
      // La ubicación del teléfono también se enciende fuera de la app: si había
      // una búsqueda de paradas cercanas esperando por eso, arranca sola.
      void retryNearbyIfServiceBack()
      // Y se mira si hay versión nueva: abrir la app ES el momento de saberlo.
      void checkUpdateOnResume()
    }
  })

  // Una sola pasada por todas las guardadas, en serie, para que la primera
  // parada que se despliegue ya tenga sus tiempos. Despues manda el motor de
  // refresco de siempre.
  await primeFavourites()

  void refreshVisible('auto')
  void setupUpdates()
}

/* ------------------------------------------------------------------ *
 * Actualizacion automatica                                             *
 * ------------------------------------------------------------------ */

async function setupUpdates(): Promise<void> {
  if (!isNativeAndroid()) {
    return
  }

  // Lo primero: qué versión hay instalada DE VERDAD. Todo lo demás (ofrecer o
  // no una actualización, y lo que se enseña en Ajustes) cuelga de este número.
  state.installed = await readInstalledVersion()
  if (state.installed.versionCode !== APP_VERSION_CODE) {
    log(
      'warn',
      'actualización',
      `El sistema dice que hay instalada la compilación ${state.installed.versionCode}, y este bundle es el de la ${APP_VERSION_CODE}.`,
    )
  }
  render()

  reviewInstallAttempt()

  await Updater.addListener('downloadProgress', (payload) => {
    state.update.percent = payload.percent
    render()
  })

  await syncInstallPermission()

  // Comprobacion del arranque: CALLA sus errores. Sin cobertura, o con GitHub
  // limitando por peticiones, la app tiene que seguir funcionando sin molestar.
  // El precio es que un fallo real se ve igual que «no hay novedades»; para eso
  // esta la comprobacion manual de Ajustes.
  //
  // Comparte cronometro con la comprobacion de cada acceso: sin ello, abrir la
  // app y cambiar de aplicacion disparaba dos peticiones seguidas a GitHub.
  lastUpdateCheckAt = Date.now()
  const outcome = await checkForUpdate()

  if (outcome.status === 'update') {
    state.update.release = outcome.release
    // Una descarga anterior solo vale si es EXACTAMENTE la versión que se está
    // ofreciendo. Antes valía cualquiera: quien había descargado una release y
    // no la había instalado se encontraba con que «Instalar» le reinstalaba la
    // vieja, y al abrir la app volvía a ofrecerse la misma actualización.
    state.update.downloadedPath = await adoptPendingDownload(outcome.release.versionCode)
    state.update.phase = state.update.downloadedPath ? 'ready' : 'available'
    log(
      'info',
      'actualización',
      `Disponible la versión ${outcome.release.versionName} (compilación ${outcome.release.versionCode}).`,
    )
    render()
    return
  }

  // Sin novedades: cualquier APK guardada ya está instalada o se ha quedado
  // atrás, y son diez megas de caché que no van a usarse nunca.
  state.update.downloadedPath = await adoptPendingDownload(null)

  if (outcome.status === 'error') {
    log('warn', 'actualización', outcome.message)
  }
}

/**
 * Última vez que se miró si hay versión nueva.
 *
 * La comprobación se repite en CADA acceso a la app, no solo al arrancarla: un
 * móvil puede pasarse semanas sin cerrar SALBUS del todo —Android la mantiene en
 * memoria— y con la comprobación atada al arranque esa instalación se quedaba
 * congelada en una versión vieja sin que nada lo dijera.
 *
 * El minuto de margen es para el ir y venir normal entre aplicaciones: volver
 * cinco veces en un minuto no puede ser cinco peticiones a GitHub, que limita
 * por IP igual que la fuente de llegadas.
 */
let lastUpdateCheckAt = 0

const UPDATE_CHECK_MIN_GAP_MS = 60_000

/**
 * Mira si hay versión nueva al volver a la app.
 *
 * Calla sus errores por el mismo motivo que la del arranque: sin cobertura, o
 * con GitHub limitando, la app tiene que seguir funcionando sin molestar. Quien
 * quiera saber si la comprobación falla de verdad tiene el botón de Ajustes,
 * que sí lo cuenta.
 *
 * No se pisa una actualización ya en marcha: con una descarga o una instalación
 * en curso no hay nada que volver a preguntar.
 */
async function checkUpdateOnResume(): Promise<void> {
  const phase = state.update.phase

  if (!isNativeAndroid() || phase === 'downloading' || phase === 'installing' || phase === 'ready') {
    return
  }

  if (Date.now() - lastUpdateCheckAt < UPDATE_CHECK_MIN_GAP_MS) {
    return
  }

  lastUpdateCheckAt = Date.now()

  const outcome = await checkForUpdate()

  if (outcome.status !== 'update') {
    return
  }

  // La misma versión que ya se estaba ofreciendo no vuelve a anunciarse: quien
  // pulsó "Ahora no" no puede encontrarse el mismo aviso cada vez que cambia de
  // aplicación y vuelve.
  if (state.update.release?.versionCode === outcome.release.versionCode) {
    return
  }

  state.update.release = outcome.release
  state.update.dismissed = false
  state.update.error = null
  state.update.downloadedPath = await adoptPendingDownload(outcome.release.versionCode)
  state.update.phase = state.update.downloadedPath ? 'ready' : 'available'
  log(
    'info',
    'actualización',
    `Disponible la versión ${outcome.release.versionName} (compilación ${outcome.release.versionCode}).`,
  )
  render()
}

/**
 * Recupera la descarga guardada si sirve, y la tira si no.
 *
 * @param versionCode compilación que se está ofreciendo, o `null` si no hay
 *   ninguna: entonces no hay descarga que valga.
 */
async function adoptPendingDownload(versionCode: number | null): Promise<string | null> {
  try {
    const pending = await Updater.pendingUpdate()

    if (pending.ready && pending.path && versionCode !== null && pending.versionCode === versionCode) {
      return pending.path
    }

    if (pending.ready) {
      await Updater.clearPending()
      log(
        'info',
        'actualización',
        `Se descarta una descarga anterior (compilación ${pending.versionCode}) que ya no corresponde.`,
      )
    }
  } catch {
    /* sin descarga previa, o el plugin no está disponible */
  }

  return null
}

/**
 * ¿Se completó la instalación que se lanzó la última vez?
 *
 * Si no, se dice y se tira la descarga guardada para bajarla de nuevo. Callarlo
 * y limitarse a volver a ofrecer la misma versión es justo lo que convierte un
 * fallo puntual en un bucle: la ventana reaparece una y otra vez sin que nada
 * explique por qué sigues en la versión de siempre.
 */
function reviewInstallAttempt(): void {
  const attempted = readInstallAttempt()
  if (attempted <= 0) {
    return
  }

  // Se limpia siempre: este aviso es de un intento concreto y no debe repetirse
  // en cada arranque.
  writeInstallAttempt(0)

  if (state.installed.versionCode >= attempted) {
    log('info', 'actualización', `Instalada la compilación ${state.installed.versionCode}.`)
    return
  }

  state.update.error =
    `La instalación anterior no llegó a completarse: sigues en la compilación ${state.installed.versionCode}. `
    + 'Se descargará de nuevo desde cero.'

  log(
    'warn',
    'actualización',
    `Se mandó instalar la compilación ${attempted} y el sistema sigue con la ${state.installed.versionCode}.`,
  )

  // La APK guardada no vale: puede ser justo la que no se pudo instalar.
  void Updater.clearPending().catch(() => undefined)
  state.update.downloadedPath = null
}

async function syncInstallPermission(): Promise<void> {
  if (!isNativeAndroid()) {
    return
  }

  try {
    const { granted } = await Updater.canInstall()
    if (granted !== state.update.canInstall) {
      state.update.canInstall = granted
      render()
    }
  } catch {
    /* el plugin solo existe en Android */
  }
}

/** Descarga si hace falta e invoca al instalador del sistema. */
async function runUpdate(): Promise<void> {
  const update = state.update
  if (!update.release) {
    return
  }

  update.error = null

  try {
    if (!update.downloadedPath) {
      update.phase = 'downloading'
      update.percent = -1
      render()

      const result = await Updater.download({ url: update.release.apkUrl })
      update.downloadedPath = result.path
    }

    update.phase = 'ready'
    render()

    await syncInstallPermission()
    if (!state.update.canInstall) {
      // La APK ya esta en disco: al conceder el permiso se instala sin
      // volver a descargarla.
      render()
      return
    }

    update.phase = 'installing'
    render()
    // Queda anotado ANTES de lanzar el instalador: a partir de aquí la app puede
    // morir en cualquier momento, y al volver hay que poder distinguir "se
    // instaló" de "no llegó a instalarse".
    writeInstallAttempt(update.release.versionCode)
    await Updater.install({ path: update.downloadedPath })
  } catch (error) {
    const message = errorMessage(error)

    if (message.includes('PERMISSION_REQUIRED')) {
      update.phase = 'ready'
      state.update.canInstall = false
      render()
      return
    }

    update.phase = 'error'
    update.error = message
    // Una descarga rota no debe reutilizarse en el reintento.
    if (message.includes('descargar')) {
      update.downloadedPath = null
    }
    log('error', 'actualización', message)
    render()
  }
}

/** Comprobacion manual: esta SI cuenta lo que ocurre, sea lo que sea. */
async function checkUpdateManually(): Promise<void> {
  state.update.manualChecking = true
  state.update.manualMessage = null
  render()

  await syncInstallPermission()
  const outcome = await checkForUpdate()

  if (outcome.status === 'update') {
    state.update.release = outcome.release
    state.update.downloadedPath = await adoptPendingDownload(outcome.release.versionCode)
    state.update.phase = state.update.downloadedPath ? 'ready' : 'available'
    state.update.dismissed = false
    state.update.manualMessage = {
      text: `Disponible SALBUS v${outcome.release.versionName} (compilación ${outcome.release.versionCode}).`,
      tone: 'info',
    }
  } else if (outcome.status === 'current') {
    // La comprobación devuelve el versionCode REAL del sistema; si una
    // instalación se quedó a medias, aquí se ve el número de siempre.
    state.update.release = null
    state.update.phase = 'idle'
    state.update.downloadedPath = await adoptPendingDownload(null)
    state.update.manualMessage = {
      text: `Ya tienes la última versión (compilación ${outcome.versionCode}).`,
      tone: 'info',
    }
  } else if (outcome.status === 'unsupported') {
    state.update.manualMessage = {
      text: 'Las actualizaciones automáticas solo funcionan en la aplicación de Android.',
      tone: 'warn',
    }
  } else {
    state.update.manualMessage = { text: outcome.message, tone: 'error' }
  }

  state.update.manualChecking = false
  render()
}

function dismissSplash(): void {
  const splash = document.querySelector<HTMLElement>('#splash')
  if (!splash) {
    return
  }

  splash.classList.add('is-done')
  window.setTimeout(() => splash.remove(), 360)
}

function dropStaleFavourites(): void {
  const network = state.network
  if (!network) {
    return
  }

  const before = state.favourites.length
  state.favourites = state.favourites.filter((favourite) => network.stopById.has(favourite.stopId))
  state.monitors = state.monitors.filter((monitor) => network.stopById.has(monitor.stopId))
  state.trackings = state.trackings.filter((job) => network.stopById.has(job.stopId))

  if (state.favourites.length !== before) {
    persistFavourites()
    log('warn', 'paradas', 'Se eliminaron paradas guardadas que ya no existen en la red oficial.')
  }
}

/* ------------------------------------------------------------------ *
 * Widget de la pantalla de inicio                                      *
 * ------------------------------------------------------------------ */

/**
 * Baja al widget los nombres de las paradas guardadas.
 *
 * Se llama cada vez que esa lista cambia —al guardar, al quitar y al renombrar—
 * porque el widget no tiene refresco propio: ensena lo ultimo que se le dejo.
 * El nombre que se manda es el MISMO que se lee en Inicio, alias incluido; un
 * widget que llamara a la parada de otra forma que la app se leeria como una
 * parada distinta.
 */
function refreshWidget(): void {
  void syncWidgetStops(
    state.favourites.map((favourite) => ({
      stopId: favourite.stopId,
      label: favouriteLabel(favourite.stopId, stopName(favourite.stopId)),
    })),
  )
}

/**
 * Parada pulsada en el widget que todavia no se ha podido abrir.
 *
 * El toque puede llegar con la app arrancando, y la hoja del aviso necesita la
 * red oficial para ofrecer lineas: hasta que la red esta, la parada espera aqui.
 */
let pendingWidgetStopId: string | null = null

/** Recoge el toque en el widget, si lo hay, y lo atiende. */
async function checkWidgetTap(): Promise<void> {
  const stopId = await takeWidgetStop()

  if (stopId) {
    pendingWidgetStopId = stopId
  }

  await openWidgetStop()
}

/**
 * Abre la hoja de "Avisarme del proximo bus" de la parada pulsada en el widget.
 *
 * Es la misma hoja que sale desde la app —incluida la pregunta de cual se
 * sustituye cuando ya no caben mas avisos— y no una pantalla aparte: el widget
 * es un atajo a una funcion que ya existe, y dos versiones de la misma ventana
 * acabarian ofreciendo cosas distintas.
 */
async function openWidgetStop(): Promise<void> {
  const stopId = pendingWidgetStopId
  if (!stopId) {
    return
  }

  // Sin red no hay lineas que ofrecer. La parada se queda esperando y el
  // arranque vuelve a pasar por aqui en cuanto la red esta cargada.
  if (!state.ready || !state.network) {
    return
  }

  pendingWidgetStopId = null

  if (!state.network.stopById.has(stopId)) {
    showToast('Esa parada ya no existe en la red oficial', 'error')
    return
  }

  if (state.tab !== 'inicio') {
    await goToTab('inicio')
  }

  // Si ya hay un aviso, el nuevo lo sustituirá al confirmar.
  openPickLine(stopId, 'tracking')
}

/* ------------------------------------------------------------------ *
 * Permisos                                                             *
 * ------------------------------------------------------------------ */

async function setupPermissions(): Promise<void> {
  state.permissions.notifications = await ensureNotificationPermission()
  await syncBatteryPermission(false)
  render()
}

async function syncPermissions(): Promise<void> {
  await syncBatteryPermission(false)
  render()
}

async function syncBatteryPermission(prompt: boolean): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') {
    state.permissions.battery = 'granted'
    return
  }

  try {
    let result = await BatteryOptimization.isIgnoringBatteryOptimizations()

    if (!result.ignored && prompt) {
      await BatteryOptimization.requestIgnoreBatteryOptimizations()
      await wait(600)
      result = await BatteryOptimization.isIgnoringBatteryOptimizations()
    }

    state.permissions.battery = result.ignored ? 'granted' : 'denied'
  } catch {
    state.permissions.battery = 'unknown'
  }
}

/* ------------------------------------------------------------------ *
 * Motor de refresco                                                    *
 * ------------------------------------------------------------------ */

/**
 * Una parada que hay que refrescar en este ciclo.
 *
 * `scan` marca las paradas ANTERIORES de un aviso: van en orden, de la tuya
 * hacia atras, y en cuanto una de ellas resulta tener el autobus encima el
 * resto sobra. Es lo que permite parar la busqueda donde esta el autobus en vez
 * de recorrer siempre las ocho.
 */
interface RefreshEntry {
  stopId: string
  maxAgeMs: number
  priority: 'high' | 'normal'
  /** Aviso al que pertenece esta parada como paso de su busqueda hacia atras. */
  scan?: { jobId: string, lineId: string }
}

/** Paradas que interesan ahora mismo, con su frescura objetivo, mas prioritarias primero. */
function buildRefreshPlan(): RefreshEntry[] {
  const plan = new Map<string, RefreshEntry>()

  const add = (
    stopId: string,
    maxAgeMs: number,
    priority: 'high' | 'normal' = 'normal',
    scan?: { jobId: string, lineId: string },
  ) => {
    const existing = plan.get(stopId)
    if (!existing || maxAgeMs < existing.maxAgeMs) {
      plan.set(stopId, { stopId, maxAgeMs, priority, scan: scan ?? existing?.scan })
    }
  }

  // Mientras hay una franja de puntualidad abierta, medir manda: el aviso sigue
  // dando la hora, pero deja de rastrear el recorrido para no quitarle turno a
  // la parada que se está midiendo.
  const measuring = anyMonitorWindowOpen()

  // 1. Los avisos activos mandan: siempre son lo primero.
  for (const job of state.trackings) {
    if (job.active) {
      add(job.stopId, FRESHNESS.focused, 'high')
    }
  }

  // 1 bis. Y sus paradas ANTERIORES: por dónde viene el autobús.
  //
  // La ventana es SIEMPRE la misma —las ocho paradas anteriores a la tuya— y es
  // la misma que dibuja la pestaña Seguir. Lo que cambia según quién mire es
  // hasta dónde hay que llegar dentro de ella:
  //
  //  - Con la pestaña Seguir delante se recorre ENTERA, porque se dibuja parada
  //    a parada y hay que poder verlas todas.
  //  - Fuera de ella (otra pestaña, o la app en segundo plano) lo único que
  //    hace falta es el "a N paradas" de la notificación: se va de tu parada
  //    hacia atrás y se PARA en la primera que tenga el autobús encima. Las de
  //    más atrás ya no cambian la respuesta, así que no se piden.
  //
  // La diferencia no es cosmética: la ventana entera son ocho paradas por ciclo
  // contra una fuente que admite una petición cada dos segundos. Antes esto se
  // acotaba a ojo —por los minutos que faltaban— y se quedaba corto justo
  // cuando el autobús venía de lejos, que es cuando el recorrido salía en
  // blanco y el aviso no sabía decir por dónde venía.
  const watchingRoute = isWatchingRoute()


  for (const job of state.trackings) {
    // Con el servicio nativo vivo, el rastreo es suyo: hacerlo también aquí
    // sería el doble de peticiones y dos recuentos capaces de discrepar.
    // Y mientras se mide la puntualidad no se rastrea nada: esa cola es de la
    // parada que se está midiendo, y el aviso sigue dando la hora igual.
    if (!job.active || !job.directionKey || trackingServiceActive || measuring) {
      continue
    }

    const window = state.network?.getDirectionWindow(
      job.directionKey,
      job.stopId,
      ROUTE_WINDOW_STOPS + 1,
    ) ?? []

    // De la parada propia hacia atrás: las más cercanas son las que primero
    // delatan al autobús, y son las que antes conviene tener frescas.
    const scanned = window.slice(0, Math.max(0, window.length - 1)).reverse()

    for (const stop of scanned) {
      add(
        stop.stopId,
        watchingRoute ? FRESHNESS.routeVisible : FRESHNESS.routeBackground,
        'normal',
        // Solo fuera de la pestaña se corta la búsqueda al encontrar el
        // autobús: con el recorrido dibujado hacen falta las ocho.
        watchingRoute ? undefined : { jobId: job.id, lineId: job.lineId },
      )
    }
  }

  // 2. Controles de puntualidad dentro de su franja horaria. Con un autobús ya
  // entrando se aprieta el ritmo: es el momento en que se decide si ha pasado.
  for (const monitor of state.monitors) {
    if (isWithinWindow(monitor)) {
      const armed = state.monitorRuntime[monitor.id]?.armed === true
      add(monitor.stopId, armed ? FRESHNESS.focused : FRESHNESS.monitor, 'high')
    }
  }

  // 3. Lo que se esta mirando en pantalla.
  if (state.tab === 'buscar' && state.search.selectedStopId) {
    add(state.search.selectedStopId, FRESHNESS.focused, 'high')
  }

  // Inicio ES la lista de paradas guardadas, y al abrirla se ponen al día
  // TODAS: la parada que se despliegue tiene que abrirse con algo puesto, no en
  // blanco a la espera de una consulta que llega cuando le toque turno.
  //
  // Con una parada desplegada manda ELLA y solo ella: es la única cuyos tiempos
  // se están leyendo, así que se pide con prioridad y el repaso de las demás se
  // aparta hasta que se vuelva a plegar. Quien acaba de abrirla no puede
  // quedarse esperando detrás de nueve paradas que no está mirando.
  if (state.tab === 'inicio') {
    if (state.expandedStopId) {
      add(state.expandedStopId, FRESHNESS.focused, 'high')
    } else {
      for (const favourite of state.favourites) {
        add(favourite.stopId, FRESHNESS.visible)
      }
    }
  }

  return Array.from(plan.values()).sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority === 'high' ? -1 : 1
    }
    return left.maxAgeMs - right.maxAgeMs
  })
}

/**
 * ¿Se está MIRANDO el recorrido ahora mismo?
 *
 * Es lo que distingue «hay que dibujar las ocho paradas» de «basta con saber a
 * cuántas viene». Lo consultan las dos mitades: el plan de refresco de la web y,
 * a través de `syncRouteWatch`, el servicio nativo, que es quien barre el
 * recorrido cuando está vivo.
 */
function isWatchingRoute(): boolean {
  return state.tab === 'seguimiento' && document.visibilityState === 'visible'
}

/**
 * Le dice al servicio si el recorrido se está mirando.
 *
 * El servicio no puede saber qué pestaña hay delante, y la diferencia le cambia
 * el trabajo: mirándolo recorre la ventana entera (hay ocho paradas que dibujar),
 * y sin mirarlo para en cuanto encuentra el autobús, que es todo lo que necesita
 * la notificación. Se le avisa al cambiar de pestaña y al pasar a segundo plano.
 */
let routeWatchSent: boolean | null = null

async function syncRouteWatch(): Promise<void> {
  const watching = isWatchingRoute()

  if (!isNative() || watching === routeWatchSent) {
    return
  }

  routeWatchSent = watching

  try {
    await BusTracking.setRouteWatch({ watching })
  } catch {
    // Un servicio que no esté vivo no tiene nada que ajustar; se reintenta en el
    // siguiente cambio de pestaña.
    routeWatchSent = null
  }
}

/** ¿El autobús de ese aviso está AHORA en esa parada, según lo que ya se sabe? */

function busIsAt(stopId: string, lineId: string): boolean {
  const feed = state.feeds[stopId]
  if (!feed || feed.status === 'error') {
    return false
  }

  const minutes = nextArrivalMinutes(stopId, lineId)
  return minutes >= 0 && minutes <= AT_STOP_MINUTES
}

/**
 * Una pasada por TODAS las paradas guardadas al abrir la app.
 *
 * La fuente oficial tarda lo suyo y solo admite una consulta cada dos segundos,
 * asi que la primera vez que se despliega una parada hay una espera que no
 * depende de la app. Esta pasada la adelanta al arranque, mientras la pantalla
 * de bienvenida y el primer vistazo a la lista ocupan a quien mira.
 *
 * Va en SERIE por la misma cola que todo lo demas (nunca en paralelo: eso es lo
 * que provoca el bloqueo por IP) y se hace una sola vez por sesion. A partir de
 * ahi, en vivo solo se mantiene la parada desplegada, que es la unica que
 * enseña tiempos.
 */
async function primeFavourites(): Promise<void> {
  if (bootPrimeDone || !state.ready) {
    return
  }

  bootPrimeDone = true

  // La desplegada primero, si la hay: es la unica cuyo dato se esta mirando ya.
  const stopIds = [...state.favourites.map((favourite) => favourite.stopId)].sort((left, right) => {
    if (left === state.expandedStopId) return -1
    if (right === state.expandedStopId) return 1
    return 0
  })

  if (stopIds.length === 0) {
    return
  }

  // Ocupa la cola: sin esto el ciclo automatico entraria en medio y pediria las
  // mismas paradas otra vez.
  refreshInFlight = true
  lastAutoCycleAt = Date.now()
  state.refreshing = true

  for (const stopId of stopIds) {
    state.stopSync[stopId] = 'queued'
  }

  const seconds = Math.round(estimateBatchDurationMs(stopIds.length) / 1000)
  state.refreshQueueLabel =
    stopIds.length > 1 ? `Preparando ${stopIds.length} paradas · ~${seconds} s` : null
  render()

  try {
    let done = 0

    // Todas a la vez: ninguna depende de la anterior, y el ritmo lo pone la
    // cola. En serie, diez paradas guardadas eran más de medio minuto de
    // pantalla de bienvenida.
    await fetchStopsInParallel(stopIds, {
      maxAgeMs: FRESHNESS.visible,
      priority: 'normal',
      onStart: (stopId) => {
        state.stopSync[stopId] = 'loading'
        render()
      },
      onFeed: (feed) => {
        done += 1
        delete state.stopSync[feed.stopId]
        applyFeed(feed)
        state.refreshQueueLabel =
          stopIds.length > 1 && done < stopIds.length
            ? `Preparando ${done + 1} de ${stopIds.length}…`
            : null
        render()
      },
    })

    state.lastRefreshAt = Date.now()
    log('info', 'arranque', `${stopIds.length} parada(s) guardada(s) precargadas al abrir la app.`)
  } catch (error) {
    log('warn', 'arranque', `No se pudo precargar las paradas guardadas: ${errorMessage(error)}`)
  } finally {
    refreshInFlight = false
    state.refreshing = false
    state.refreshQueueLabel = null
    for (const stopId of stopIds) {
      delete state.stopSync[stopId]
    }
    render()
  }
}

/** Minutos que faltan para el próximo autobús de esa línea, o -1 si no consta. */
function nextArrivalMinutes(stopId: string, lineId: string): number {
  const arrival = state.feeds[stopId]?.arrivals
    .filter((item) => item.lineId === lineId)
    .sort((left, right) => liveMinutes(left) - liveMinutes(right))[0]

  return arrival ? liveMinutes(arrival) : -1
}

function tick(): void {
  // Reloj y antigüedades se repintan siempre: el repintado es incremental
  // (`patch`), así que no cierra desplegables ni interrumpe lo que se esté
  // haciendo, ni siquiera con una hoja abierta.
  if (state.ready) {
    render()
  }

  // Con un control de puntualidad dentro de su franja se sigue consultando
  // aunque la pantalla no esté en primer plano: perder esas consultas es perder
  // justo el paso que se quería medir.
  const measuring = anyMonitorWindowOpen()

  // Registro, aviso de silencio y notificación persistente de la medición.
  superviseMonitors()

  // Mientras se mide NO se pausa el aviso: es una notificación que alguien está
  // esperando, y apagarla sería tanto como borrarla. Lo que se apaga es su
  // rastreo del recorrido, que es la parte cara; eso lo decide
  // `buildRefreshPlan`, que ya sabe si hay una franja abierta.

  // Con el servicio nativo midiendo, los pasos aparecen en la pantalla de
  // puntualidad al ritmo al que él los detecta, no solo al reabrir la app.
  if (measuring && nativeMonitorIds.size > 0 && Date.now() - lastDrainAt >= AUTO_CYCLE_MS) {
    lastDrainAt = Date.now()
    void drainNativePasses()
  }

  if (refreshInFlight || (document.visibilityState !== 'visible' && !measuring)) {
    return
  }

  if (Date.now() - lastAutoCycleAt < AUTO_CYCLE_MS) {
    return
  }

  void refreshVisible('auto')
}

/**
 * Ciclo de refresco en curso.
 *
 * Cada pasada se queda con su número, y `cancelRefreshCycle` lo invalida: el
 * lote se corta en la siguiente parada, sin llegar a pedirla. Sirve para que
 * abrir una parada guardada aparte en el acto el repaso de las demás, porque la
 * cola va a dos segundos por consulta y esperar turno detrás de nueve paradas
 * que nadie mira son veinte segundos mirando un hueco vacío.
 */
let refreshCycle = 0

function cancelRefreshCycle(): void {
  refreshCycle += 1
}

async function refreshVisible(source: 'auto' | 'manual'): Promise<void> {
  if (refreshInFlight || !state.ready) {
    return
  }

  const plan = buildRefreshPlan().filter((entry) => {
    const feed = state.feeds[entry.stopId]
    return !feed || Date.now() - feed.fetchedAt >= (source === 'manual' ? 0 : entry.maxAgeMs)
  })

  if (plan.length === 0) {
    if (source === 'manual') {
      showToast('Los datos ya están al día', 'info')
    }
    return
  }

  const cycle = ++refreshCycle
  refreshInFlight = true
  lastAutoCycleAt = Date.now()
  state.refreshing = true

  // Todas entran en cola a la vez; se iran marcando "en curso" segun les toque.
  // Es lo que permite distinguir en pantalla lo actualizado de lo que espera.
  for (const entry of plan) {
    state.stopSync[entry.stopId] = 'queued'
  }

  if (plan.length > 1) {
    const seconds = Math.round(estimateBatchDurationMs(plan.length) / 1000)
    state.refreshQueueLabel = `Actualizando ${plan.length} paradas · ~${seconds} s`
  }

  render()

  try {
    let done = 0

    const byStop = new Map(plan.map((entry) => [entry.stopId, entry]))
    // Avisos cuyo autobús ya ha aparecido en este mismo lote Y cuyo tramo de
    // "llegando" ya se ha cerrado: sus paradas de más atrás dejan de tener nada
    // que decir y se saltan sin pedirlas. Mientras el tramo sigue abierto
    // (`sighted`) hay que mirar la anterior, porque con paradas seguidas y
    // cercanas el mismo autobús sale "llegando" en varias y se sitúa en la más
    // lejana de ellas.
    const sighted = new Set<string>()
    const located = new Set<string>()

    const onStart = (stopId: string) => {
      state.stopSync[stopId] = 'loading'
      render()
    }

    const onFeed = (feed: StopFeed) => {
      done += 1
      delete state.stopSync[feed.stopId]
      applyFeed(feed)

      // Aquí es donde se cierra la búsqueda hacia atrás: en la primera parada
      // que ya NO tiene el autobús encima después de haberlo visto. Las de más
      // atrás de ese aviso ya no cambian la respuesta.
      const scan = byStop.get(feed.stopId)?.scan
      if (scan) {
        if (busIsAt(feed.stopId, scan.lineId)) {
          sighted.add(scan.jobId)
        } else if (sighted.has(scan.jobId)) {
          located.add(scan.jobId)
        }
      }

      state.refreshQueueLabel =
        plan.length > 1 && done < plan.length ? `Actualizando ${done + 1} de ${plan.length}…` : null
      render()
    }

    // El lote se parte en dos por una razón de fondo, no de estilo:
    //
    //  - La búsqueda del autobús hacia atrás DEPENDE de lo que devolvió la
    //    parada anterior —para en la primera que lo tenga encima—, así que sus
    //    paradas tienen que ir una detrás de otra.
    //  - Todo lo demás no depende de nada: paradas guardadas, la que está
    //    abierta, las de un control. Pedirlas de una en una era desperdiciar el
    //    cupo de la fuente, que admite una ráfaga. Medido contra la fuente
    //    real: ocho paradas tardaban 29,5 s en serie.
    //
    // Las dos mitades salen a la vez; quien reparte el ritmo es la cola, con su
    // cubo de fichas, no el orden en que se piden.
    const scanned = plan.filter((entry) => entry.scan)
    const direct = plan.filter((entry) => !entry.scan)

    await Promise.all([
      fetchStopsInParallel(
        direct.map((entry) => entry.stopId),
        {
          maxAgeMs: source === 'manual' ? 0 : DEFAULT_MAX_AGE_MS,
          // Cada parada con la suya, no una para todo el lote: entre diez
          // paradas guardadas puede ir la que alguien tiene abierta, y esa
          // tiene ficha y hueco reservados para no hacer cola.
          priorityOf: (stopId) => byStop.get(stopId)?.priority ?? 'normal',
          onStart,
          onFeed,
        },
      ),
      fetchStopsSequentially(
        scanned.map((entry) => entry.stopId),
        {
          maxAgeMs: source === 'manual' ? 0 : DEFAULT_MAX_AGE_MS,
          priorityOf: (stopId) => byStop.get(stopId)?.priority ?? 'normal',
          shouldStop: () => refreshCycle !== cycle,
          shouldSkip: (stopId) => {
            const scan = byStop.get(stopId)?.scan
            return Boolean(scan && located.has(scan.jobId))
          },
          onStart,
          onFeed,
        },
      ),
    ])


    state.lastRefreshAt = Date.now()
  } catch (error) {
    log('error', 'llegadas', errorMessage(error))
  } finally {
    refreshInFlight = false
    state.refreshing = false
    state.refreshQueueLabel = null
    // Un error a mitad de lote dejaria paradas colgadas en "en cola" para
    // siempre. Solo se limpian las de este lote: una consulta suelta en curso
    // (refreshOneStop) lleva su propia marca y la gestiona ella.
    for (const entry of plan) {
      delete state.stopSync[entry.stopId]
    }
    render()
  }
}

/** Refresca una sola parada de inmediato (botón de la tarjeta). */
async function refreshOneStop(stopId: string): Promise<void> {
  state.refreshing = true
  state.stopSync[stopId] = 'loading'
  render()

  try {
    const feed = await fetchStopArrivals(stopId, { maxAgeMs: 0, priority: 'high' })
    applyFeed(feed)
    state.lastRefreshAt = Date.now()

    if (feed.status === 'throttled') {
      showToast('La fuente oficial está limitando las consultas; se muestra el último dato', 'error')
    }
  } finally {
    state.refreshing = false
    delete state.stopSync[stopId]
    render()
  }
}

function applyFeed(feed: StopFeed): void {
  state.feeds[feed.stopId] = feed

  // Con datos reales otra vez, los del horario sobran: la parada vuelve a
  // enseñar solo lo que dice la fuente, y un fallo posterior vuelve a ofrecer el
  // boton en lugar de colar el horario sin que nadie lo pida.
  if (feed.status === 'ok' || feed.status === 'empty') {
    delete state.scheduleFallbackStops[feed.stopId]
  }

  if (feed.status === 'error' && feed.message) {
    log('error', `parada ${feed.stopId}`, feed.message)
  }

  if (feed.status === 'throttled') {
    log('warn', 'fuente', 'La web oficial devolvió 429; se amplía el espaciado entre consultas.')
  }

  evaluateTracking(feed)
  evaluateMonitors(feed)
}

/* ------------------------------------------------------------------ *
 * Avisos de próximo bus                                                *
 * ------------------------------------------------------------------ */

/** Los avisos que consultan y publican notificación ahora mismo. */
function activeTrackings(): TrackingJob[] {
  return state.trackings.filter((job) => job.active)
}

function trackingById(id: string): TrackingJob | undefined {
  return state.trackings.find((job) => job.id === id)
}

/**
 * Pone el servicio nativo exactamente al día: avisos activos y controles de
 * puntualidad.
 *
 * Se mandan SIEMPRE las listas completas, nunca altas y bajas sueltas: es lo que
 * garantiza que la barra de notificaciones enseñe justo lo que hay en pantalla,
 * ni un aviso de más ni uno de menos.
 *
 * Los controles van aquí porque medir a qué hora pasa de verdad un autobús
 * exige consultar durante toda la franja, y con la app en segundo plano el
 * navegador se congela: se perdía justo el paso que se quería medir.
 */
async function syncTrackingService(): Promise<void> {
  const jobs = activeTrackings()
  const monitors = state.monitors.slice(0, MAX_BACKGROUND_MONITORS)

  if (state.monitors.length > monitors.length) {
    log(
      'warn',
      'puntualidad',
      `Solo los ${MAX_BACKGROUND_MONITORS} primeros controles se miden en segundo plano; los demás necesitan la app abierta.`,
    )
  }

  if (!isNative()) {
    trackingServiceActive = false
    nativeMonitorIds = new Set()
    return
  }

  try {
    await BusTracking.sync({
      jobs: jobs.map((job) => ({
        id: job.id,
        stopId: job.stopId,
        stopName: job.stopName,
        lineId: job.lineId,
        destination: describeArrival(job.stopId, job.lineId),
        busesSeen: job.busesSeen,
        // Paradas anteriores del recorrido, de la más cercana a la más lejana.
        // El servicio las recorre en ese orden y para en la primera que tenga
        // el autobús encima: la más cercana que lo tenga es donde está.
        routeStops: trackingRouteStops(job),
        directionKey: job.directionKey ?? '',
        skip: job.skip,
      })),
      monitors: monitors.map((monitor) => ({
        id: monitor.id,
        stopId: monitor.stopId,
        stopName: monitor.stopName,
        lineId: monitor.lineId,
        startMinutes: monitor.startMinutes,
        endMinutes: monitor.endMinutes,
      })),
      intervalSeconds: TRACKING_INTERVAL_SECONDS,
      vibrateOnApproach: state.settings.vibrateOnApproach,
      busTarget: trackingBusTarget(),
    })

    trackingServiceActive = jobs.length > 0
    nativeMonitorIds = new Set(monitors.map((monitor) => monitor.id))

    // El servicio puede acabar de arrancar en un proceso nuevo, donde no sabe
    // nada de qué pestaña hay delante: se le vuelve a decir.
    routeWatchSent = null
    void syncRouteWatch()

    // El servicio publica sus propias notificaciones: cualquier resto de la web
    // sobra, porque ya no se volvería a actualizar.
    for (const job of state.trackings) {
      await cancelNotification(notificationId(job.id))
    }
  } catch (error) {
    trackingServiceActive = false
    nativeMonitorIds = new Set()
    log('warn', 'aviso', `No se pudo sincronizar el servicio en segundo plano: ${errorMessage(error)}`)
    if (jobs.length > 0) {
      showToast('El aviso funcionará solo con la app abierta', 'error')
    } else if (monitors.length > 0) {
      showToast('La puntualidad se medirá solo con la app abierta', 'error')
    }
  }
}

/**
 * Paradas anteriores de un aviso, de la más cercana a la más lejana.
 *
 * Es lo que el servicio nativo necesita para contar paradas con la app cerrada:
 * allí no hay red de líneas cargada —el JSON de la red vive en la parte web— así
 * que la secuencia se le manda ya resuelta y en el orden en que tiene que
 * recorrerla. Vacía cuando el aviso no tiene sentido resuelto, y entonces el
 * servicio se limita a contar minutos, como siempre.
 */
function trackingRouteStops(job: TrackingJob): string[] {
  if (!job.directionKey || !state.network) {
    return []
  }

  const window = state.network.getDirectionWindow(
    job.directionKey,
    job.stopId,
    ROUTE_WINDOW_STOPS + 1,
  )

  return window
    .slice(0, -1)
    .reverse()
    .map((stop) => stop.stopId)
}

/**
 * Recoge los pasos que el servicio midió mientras la app no estaba delante.
 *
 * Llegan en bruto (control e instante): el emparejado con el horario oficial se
 * hace aquí, que es donde vive el GTFS. El servicio los borra al entregarlos,
 * así que esta función nunca puede contar dos veces el mismo autobús.
 */
async function drainNativePasses(): Promise<void> {
  if (!isNative()) {
    return
  }

  try {
    const { passes } = await BusTracking.takePasses()

    if (passes.length === 0) {
      return
    }

    for (const pass of passes) {
      const monitor = state.monitors.find((item) => item.id === pass.monitorId)
      if (monitor) {
        recordPass(monitor, pass.at, pass.reason === 'jump' ? 'jump' : 'gone')
      }
    }

    log('info', 'puntualidad', `${passes.length} paso(s) medidos en segundo plano.`)
  } catch (error) {
    log('warn', 'puntualidad', `No se pudieron recoger las medidas: ${errorMessage(error)}`)
  }
}

/**
 * Sentido por el que viene el autobús de un aviso.
 *
 * Hace falta para poder decir a cuántas paradas está, porque las paradas
 * anteriores del recorrido solo existen dentro de un sentido concreto. La
 * fuente oficial no ayuda: dice "Línea 4, 7 minutos" y nunca hacia dónde va.
 *
 * Se resuelve con la red oficial y solo cuando la respuesta es única. Por el
 * 93 % de los pares parada-línea pasa un solo sentido y no hay nada que decidir;
 * en el 5 % que admite dos, elegir uno sería jugárselo a cara o cruz y mandar a
 * mirar a la acera de enfrente. Ahí se devuelve `null` y el aviso funciona como
 * siempre, contando minutos pero no paradas.
 */
function resolveTrackingDirection(stopId: string, lineId: string, chosen?: string): string | null {
  const options = trackingDirectionOptions(stopId, lineId)

  // Lo elegido a mano manda: por esa parada pasaba la línea en los dos sentidos
  // y quien espera sabe cuál de los dos es el suyo, que es justo lo que la
  // fuente oficial no dice nunca.
  if (chosen && options.some((direction) => direction.key === chosen)) {
    return chosen
  }

  // Un solo recorrido posible: no hay nada que preguntar ni que deducir.
  return options.length === 1 ? options[0].key : null
}

/**
 * Pone el sentido a los avisos que se guardaron antes de que existiera el
 * recuento de paradas. Se hace al arrancar, que es cuando la red ya está
 * cargada y `state.trackings` viene de disco sin él.
 *
 * Solo rellena los que no admiten duda. Los de una parada con dos sentidos se
 * quedan sin él: nadie llegó a elegirlo, y ponerlo ahora sería adivinar. Se
 * resuelven volviendo a crear el aviso, que ya lo pregunta.
 */
function backfillTrackingDirections(): void {
  let changed = false

  for (const job of state.trackings) {
    if (job.directionKey) {
      continue
    }

    const directionKey = resolveTrackingDirection(job.stopId, job.lineId)
    if (directionKey) {
      job.directionKey = directionKey
      changed = true
    }
  }

  if (changed) {
    persistTrackings()
  }
}

/**
 * Crea un aviso nuevo.
 *
 * Solo puede haber uno: si ya había otro (o el mismo, con otro autobús
 * elegido) se retira primero, sin preguntar. Lo último que se pide es lo que se
 * quiere mirar ahora.
 */
async function createTracking(
  stopId: string,
  lineId: string,
  directionKey?: string,
  skip = 0,
): Promise<boolean> {
  const replaced = state.trackings.slice()

  // Se retiran ANTES de crear el nuevo y sincronizando con el servicio: con el
  // mismo id (misma parada y línea) el servicio conservaría la cuenta del
  // anterior en vez de empezar de cero.
  for (const old of replaced) {
    await removeTracking(old.id, false)
  }

  const job = newTrackingJob(stopId, lineId, directionKey, skip)
  state.trackings = [job]
  persistTrackings()

  log(
    'info',
    'aviso',
    `Aviso creado: línea ${lineId} en ${job.stopName} (${trackingBusTarget()} autobús/es${
      job.skip > 0 ? `, desde el ${job.skip + 1}º` : ''
    })${replaced.length > 0 ? `; sustituye al de la línea ${replaced[0].lineId} en ${replaced[0].stopName}` : ''}.`,
  )

  await syncTrackingService()
  await refreshOneStop(stopId)
  return replaced.length > 0
}

function newTrackingJob(stopId: string, lineId: string, directionKey?: string, skip = 0): TrackingJob {
  return {
    id: `${stopId}|${lineId}`,
    stopId,
    stopName: stopName(stopId),
    lineId,
    directionKey: resolveTrackingDirection(stopId, lineId, directionKey),
    active: true,
    startedAt: Date.now(),
    lastMinutes: null,
    lastNotifiedAt: 0,
    armed: false,
    missingStreak: 0,
    busesSeen: 0,
    skip: clampSkip(skip),
    warnedAt3: false,
  }
}

/**
 * "Siguiente bus": vuelve a crear un aviso que acaba de completarse.
 *
 * Al terminar, el aviso se borra para no ocupar uno de los dos huecos; este
 * botón de la notificación final es la única forma de que siga. Con el
 * servicio nativo, él ya lo ha puesto en marcha y aquí solo se refleja; sin él,
 * se crea como cualquier aviso nuevo.
 *
 * @param sync `false` durante la reconexión al abrir la app, que sincroniza
 *     una sola vez al final.
 */
async function renewTracking(renewed: RenewedJob, sync = true): Promise<void> {
  let job = trackingById(renewed.id)

  if (!job) {
    // Solo hay sitio para uno: "Siguiente bus" es lo último que se ha pulsado,
    // así que sustituye a cualquier otro que se hubiera creado mientras tanto
    // (el servicio ya lo ha hecho por su lado al renovar).
    for (const other of state.trackings) {
      delete state.trackingStopsAway[other.id]
      await cancelNotification(notificationId(other.id))
    }
    job = newTrackingJob(renewed.stopId, renewed.lineId, renewed.directionKey ?? undefined)
    state.trackings = [job]
  } else {
    // Pulsado dos veces, o reentregado por el sistema: se reinicia la cuenta.
    state.trackings = [job]
    job.active = true
    job.busesSeen = 0
    // "Siguiente bus" es el que viene ahora, aunque el aviso fuera del segundo.
    job.skip = 0
    job.armed = false
    job.lastMinutes = null
    job.missingStreak = 0
    job.warnedAt3 = false
  }

  persistTrackings()

  log('info', 'aviso', `Aviso renovado con el siguiente bus: línea ${job.lineId} en ${job.stopName}.`)
  showToast(`Te avisaremos del siguiente bus de la línea ${job.lineId}`, 'success')

  if (sync) {
    await syncTrackingService()
    render()
    await refreshOneStop(job.stopId)
  }
}

/** Quita un aviso por completo (ya no existe ni en reposo). */
async function removeTracking(id: string, notify = true): Promise<void> {
  const job = trackingById(id)
  if (!job) {
    return
  }

  state.trackings = state.trackings.filter((item) => item.id !== id)
  delete state.trackingStopsAway[id]
  persistTrackings()

  await cancelNotification(notificationId(id))
  await syncTrackingService()

  log('info', 'aviso', `Aviso retirado: línea ${job.lineId} en ${job.stopName}.`)

  if (notify) {
    showToast('Aviso detenido', 'info')
  }

  render()
}

/**
 * "Saltar": el aviso deja de seguir al autobús que seguía y pasa al siguiente
 * de la línea (para cuando ya no se llega a ese, o se ha decidido no cogerlo).
 *
 * No cuenta como autobús visto: se suma uno a los que hay que dejar pasar, y
 * el aviso sigue igual que si se hubiera creado eligiendo ese autobús.
 */
async function skipTracking(id: string): Promise<void> {
  const job = trackingById(id)
  if (!job) {
    return
  }

  if (job.skip >= MAX_TRACKING_SKIP) {
    showToast('No se puede saltar más: ya sigues a uno de los últimos con hora', 'info')
    return
  }

  if (!trackingArrival({ ...job, skip: job.skip + 1 })) {
    showToast(`Todavía no hay otro autobús de la línea ${job.lineId} con hora`, 'info')
    return
  }

  job.skip += 1
  // La vibración de los 3 minutos ya se dio (o no) por el anterior; el nuevo
  // también tiene derecho a la suya.
  job.warnedAt3 = false
  // El recuento de paradas era del autobús que se seguía.
  delete state.trackingStopsAway[id]

  if (trackingServiceActive) {
    // El servicio es quien lleva la cuenta: se le pide a él que salte y se
    // copia lo que diga, para que pantalla y notificación no discrepen.
    try {
      const result = await BusTracking.skip({ jobId: id })
      if (typeof result.skip === 'number') {
        job.skip = clampSkip(result.skip)
      }
    } catch (error) {
      log('warn', 'aviso', `El servicio no pudo saltar de autobús: ${String(error)}`)
    }
  }

  persistTrackings()
  log('info', 'aviso', `Salto: la línea ${job.lineId} en ${job.stopName} sigue ahora al ${job.skip + 1}º autobús.`)
  showToast(`Ahora sigues al ${job.skip + 1}º autobús de la línea ${job.lineId}`, 'success')
  render()
}

/**
 * Reconecta la interfaz con el servicio nativo tras reabrir la app, para que la
 * pantalla y las notificaciones no cuenten historias distintas.
 */
async function restoreTrackingService(): Promise<void> {
  if (!isNative()) {
    return
  }

  // "Siguiente bus" de la notificación que publica la propia web cuando no hay
  // servicio nativo. Con servicio, el botón es suyo y llega por `jobRenewed`.
  void onNextBusAction((renewed) => {
    void renewTracking({ ...renewed, id: `${renewed.stopId}|${renewed.lineId}`, stopName: stopName(renewed.stopId) })
  })

  try {
    await BusTracking.addListener('arrivalUpdate', (update) => {
      // El servicio sigue consultando en segundo plano; sus datos se integran en
      // la misma cache que usa la interfaz.
      const existing = state.feeds[update.stopId]
      const arrival = {
        stopId: update.stopId,
        lineId: update.lineId,
        minutesUntil: Math.max(0, update.minutes),
        status: update.arriving ? ('arriving' as const) : ('scheduled' as const),
        estimatedClock: new Date(update.at + update.minutes * 60_000).toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        observedAt: update.at,
      }

      // Los de detrás también: son los que enseña un aviso que sigue al 2º (o
      // al 3º tras saltar). Un servicio antiguo solo manda el de detrás.
      const behind = Array.isArray(update.line) && update.line.length > 0
        ? update.line.slice(1)
        : typeof update.nextMinutes === 'number'
          ? [{ minutes: update.nextMinutes, arriving: update.nextArriving === true }]
          : []
      const next = update.minutes >= 0
        ? behind
            .filter((item) => item.minutes >= 0)
            .map((item) => ({
              ...arrival,
              minutesUntil: item.minutes,
              status: item.arriving ? ('arriving' as const) : ('scheduled' as const),
              estimatedClock: new Date(update.at + item.minutes * 60_000).toLocaleTimeString('es-ES', {
                hour: '2-digit',
                minute: '2-digit',
              }),
            }))
        : []

      state.feeds[update.stopId] = {
        stopId: update.stopId,
        stopName: existing?.stopName ?? null,
        status: update.status,
        arrivals: [
          arrival,
          ...next,
          ...(existing?.arrivals ?? []).filter((item) => item.lineId !== update.lineId),
        ],
        fetchedAt: update.at,
        message: null,
      }

      // El servicio es quien cuenta los autobuses mientras vive: la web se limita
      // a copiar su cuenta para que la pantalla diga lo mismo que la notificación.
      const job = trackingById(update.jobId)
      if (job) {
        job.busesSeen = update.busesSeen
        // Lo que queda por dejar pasar lo lleva el servicio: baja con cada paso
        // y sube con "Saltar", también el de la notificación con la app cerrada.
        if (typeof update.skip === 'number') {
          job.skip = clampSkip(update.skip)
        }
        persistTrackings()
      }

      // Mientras el servicio vive, el recuento de paradas es suyo: es el único
      // que sigue mirando las paradas anteriores con la app en segundo plano.
      if (typeof update.stopsAway === 'number' && update.stopsAway >= 0) {
        state.trackingStopsAway[update.jobId] = { stopsAway: update.stopsAway, at: update.at }
      } else {
        delete state.trackingStopsAway[update.jobId]
      }

      if (update.finished) {
        void finishTracking(update.jobId, true)
        return
      }

      render()
    })

    // Las paradas anteriores, con lo que el servicio vio en cada una. Entran en
    // la MISMA cache que todo lo demás (`state.feeds`), así que el recorrido se
    // dibuja con el código de siempre y sin pedir una sola consulta más.
    await BusTracking.addListener('routeUpdate', (update) => {
      for (const stop of update.stops ?? []) {
        if (!stop?.stopId) {
          continue
        }

        const existing = state.feeds[stop.stopId]
        // Sin esa línea en esa parada el dato no es un hueco: es un "por aquí no
        // viene", y se guarda como tal (lista sin esa línea) para que la pantalla
        // pueda distinguirlo de "todavía no se ha mirado".
        const others = (existing?.arrivals ?? []).filter((item) => item.lineId !== update.lineId)

        state.feeds[stop.stopId] = {
          stopId: stop.stopId,
          stopName: existing?.stopName ?? null,
          status: 'ok',
          arrivals:
            stop.minutes >= 0
              ? [
                  {
                    stopId: stop.stopId,
                    lineId: update.lineId,
                    minutesUntil: Math.max(0, stop.minutes),
                    status: stop.arriving ? ('arriving' as const) : ('scheduled' as const),
                    estimatedClock: new Date(update.at + stop.minutes * 60_000).toLocaleTimeString(
                      'es-ES',
                      { hour: '2-digit', minute: '2-digit' },
                    ),
                    observedAt: update.at,
                  },
                  ...others,
                ]
              : others,
          fetchedAt: update.at,
          message: null,
        }
      }

      render()
    })

    // Por donde va el barrido, mientras ocurre. Es lo que enciende el punto
    // azul de la parada en curso y el aro de las que esperan turno: con el
    // servicio vivo la web no pide ni una de esas paradas, así que este aviso es
    // su ÚNICA fuente de estado. Sin él, el recorrido de la pestaña Seguir se
    // quedaba quince segundos quieto y sin nada que dijera que se estaba
    // trabajando.
    await BusTracking.addListener('routeProgress', (update) => {
      // Se borra primero TODO lo de este aviso y luego se aplica el estado que
      // acaba de llegar: al ser un retrato completo y no un incremento, ninguna
      // parada puede quedarse encendida por un aviso que ya no la mira.
      for (const stopId of update.route ?? []) {
        delete state.stopSync[stopId]
      }

      for (const stopId of update.queued ?? []) {
        state.stopSync[stopId] = 'queued'
      }

      if (update.loading) {
        state.stopSync[update.loading] = 'loading'
      }

      render()
    })

    await BusTracking.addListener('busPassed', (update) => {
      const job = trackingById(update.jobId)
      if (!job) {
        return
      }

      // Ha pasado el que se dejaba pasar: no cuenta, y la vibración ya iba por
      // el que se sigue, así que no se reinicia.
      if (typeof update.skip === 'number' && update.skip < job.skip) {
        job.skip = update.skip
        job.armed = false
        job.lastMinutes = null
        job.missingStreak = 0
        persistTrackings()
        log('info', 'aviso', `Ha pasado el primer autobús de la línea ${update.lineId}; ahora se sigue el tuyo.`)
        showToast('Ya ha pasado el primero: ahora viene el tuyo', 'info')
        render()
        return
      }

      job.busesSeen = update.busesSeen
      job.armed = false
      job.lastMinutes = null
      job.missingStreak = 0
      job.warnedAt3 = false
      persistTrackings()

      log(
        'info',
        'aviso',
        `Autobús ${update.busesSeen} de ${update.target} de la línea ${update.lineId} ha pasado por ${stopName(update.stopId)}.`,
      )
      showToast(`Autobús ${update.busesSeen} de ${update.target} ya ha pasado`, 'info')
      render()
    })

    // "Detener" desde la notificación, posiblemente con la app cerrada.
    await BusTracking.addListener('jobStopped', (update) => {
      void removeTracking(update.jobId, false)
    })

    // "Siguiente bus" con la app abierta: el servicio ya lo ha puesto en marcha.
    await BusTracking.addListener('jobRenewed', (update) => {
      void renewTracking(update)
    })

    const status = await BusTracking.status()

    // Un aviso que se detuvo desde su notificación NO se revive: antes se
    // reabría solo al entrar en la app, y la notificación que acababa de
    // quitarse volvía a aparecer.
    if (status.stopped.length > 0) {
      const removed = state.trackings.filter((job) => status.stopped.includes(job.id))
      if (removed.length > 0) {
        state.trackings = state.trackings.filter((job) => !status.stopped.includes(job.id))
        persistTrackings()
        log('info', 'aviso', `${removed.length} aviso(s) detenidos desde la notificación.`)
      }
      await BusTracking.clearStopped()
    }

    // Y al revés: los renovados con "Siguiente bus" con la app cerrada. Van
    // antes de sincronizar, que si no los quitaría del servicio.
    const { jobs: renewed } = await BusTracking.takeRenewed()
    for (const job of renewed) {
      await renewTracking(job, false)
    }

    // Los avisos que ya vieron sus tres autobuses con la app cerrada se cierran
    // en lugar de revivirse.
    for (const job of activeTrackings()) {
      if (job.busesSeen >= trackingBusTarget()) {
        await finishTracking(job.id, true)
      }
    }

    await syncTrackingService()

    // Lo medido con la app cerrada se incorpora antes de pintar nada: es lo que
    // hace que la pantalla de puntualidad ya esté completa al abrirla.
    await drainNativePasses()
  } catch (error) {
    trackingServiceActive = false
    nativeMonitorIds = new Set()
    log('warn', 'aviso', `Servicio en segundo plano no disponible: ${errorMessage(error)}`)
  }
}

function evaluateTracking(feed: StopFeed): void {
  for (const job of activeTrackings()) {
    if (job.stopId === feed.stopId) {
      evaluateTrackingJob(job, feed)
    }
  }
}

function evaluateTrackingJob(job: TrackingJob, feed: StopFeed): void {
  const arrival = feed.arrivals
    .filter((item) => item.lineId === job.lineId)
    .sort((left, right) => liveMinutes(left) - liveMinutes(right))[0]

  // Mientras el servicio nativo vive, es él quien cuenta los pasos: contar también
  // aquí duplicaría autobuses y terminaría el aviso antes de tiempo.
  const countsPasses = !trackingServiceActive

  if (!arrival) {
    // Un fallo de red no dice nada del autobús; solo una respuesta buena sin la
    // línea cuenta como ausencia.
    if (feed.status !== 'ok' && feed.status !== 'empty') {
      return
    }

    job.missingStreak += 1

    // Dos ciclos sin ver la línea después de haberla tenido encima: ha pasado.
    if (countsPasses && job.armed && job.missingStreak >= 2) {
      void registerBusPassed(job)
    }

    return
  }

  const minutes = liveMinutes(arrival)
  job.missingStreak = 0

  if (minutes <= 3) {
    job.armed = true
  }

  // Se alejó tras haber estado encima: el bus ya pasó.
  if (countsPasses && job.armed && job.lastMinutes !== null && job.lastMinutes <= 2 && minutes >= 6) {
    void registerBusPassed(job)
    return
  }

  // Los pasos se detectan con el primero; lo que se enseña y lo que vibra es el
  // que se sigue, que mientras quede uno por dejar pasar es el de detrás.
  const followed = job.skip > 0 ? trackingArrival(job) : arrival
  const followedMinutes = followed ? liveMinutes(followed) : null

  // Vibración de los 3 minutos. Con el servicio nativo vivo la da él, que
  // también funciona con la app en segundo plano; esto es el respaldo para
  // cuando no lo hay (navegador, o servicio no disponible).
  if (!job.warnedAt3 && followedMinutes !== null && followedMinutes <= TRACKING_WARN_MINUTES) {
    job.warnedAt3 = true
    if (!trackingServiceActive) {
      vibrateShort()
    }
  }

  job.lastMinutes = minutes
  job.lastNotifiedAt = Date.now()
  persistTrackings()

  // Con el servicio nativo vivo, la notificación es suya y solo suya: publicar
  // otra desde aquí dejaría un segundo aviso que se congela al irse a segundo
  // plano. Esto es solo el respaldo para cuando el servicio no está disponible.
  if (isNative() && !trackingServiceActive && !document.hidden) {
    void showTrackingNotification({
      id: notificationId(job.id),
      lineId: job.skip > 0 ? `${job.lineId} · ${job.skip + 1}º bus` : job.lineId,
      destination: describeArrival(job.stopId, job.lineId),
      minutes: followedMinutes,
      arriving: followed !== null && (followed.status === 'arriving' || (followedMinutes ?? 1) <= 0),
      updatedAt: new Date(feed.fetchedAt),
      stale: feed.status === 'throttled',
      stopsAway: describeStopsAway(trackingStopsAway(job)),
    })
  }
}

/**
 * Vibración de "quedan 3 minutos": TRES toques cortos.
 *
 * El toque único y largo de antes se confundía con cualquier otra notificación
 * del teléfono, que es justo lo que no puede pasar: este aviso significa "sal
 * ya", y tener que sacar el móvil del bolsillo para ver de quién era le quitaba
 * el sentido. Tres pulsos seguidos no se parecen a nada más y se reconocen sin
 * mirar.
 *
 * Una sola tanda por autobús: el indicador `warnedAt3` se reinicia cuando el
 * autobús pasa, no en cada consulta, que serían cuatro zumbidos por minuto.
 *
 * El servicio nativo lleva su propia copia del patrón (APPROACH_PATTERN en
 * BusTrackingService.java): tiene que sonar igual con la app cerrada. El patrón
 * se lee como espera/vibra/espera/vibra…, y arranca en 0 para que el primer
 * toque sea inmediato.
 */
const APPROACH_PATTERN = [0, 90, 120, 90, 120, 90]

function vibrateShort(): void {
  if (!state.settings.vibrateOnApproach) {
    return
  }

  try {
    navigator.vibrate?.(APPROACH_PATTERN)
  } catch {
    /* el navegador o el sistema pueden tenerlo bloqueado */
  }
}

/**
 * Un autobús más ha pasado. El aviso solo termina cuando se han visto pasar
 * trackingBusTarget(); hasta entonces se rearma y sigue con el siguiente.
 */
async function registerBusPassed(job: TrackingJob): Promise<void> {
  // El que ha pasado era el que se dejaba pasar: no cuenta. Desde aquí el que se
  // sigue es el primero y el aviso sigue como uno normal; la vibración ya iba
  // por él, así que no se reinicia.
  if (job.skip > 0) {
    job.skip -= 1
    job.armed = false
    job.lastMinutes = null
    job.missingStreak = 0
    persistTrackings()
    log('info', 'aviso', `Ha pasado el primer autobús de la línea ${job.lineId}; ahora se sigue el tuyo.`)
    showToast('Ya ha pasado el primero: ahora viene el tuyo', 'info')
    render()
    return
  }

  job.busesSeen += 1
  job.armed = false
  job.lastMinutes = null
  job.missingStreak = 0
  job.warnedAt3 = false
  persistTrackings()

  if (job.busesSeen >= trackingBusTarget()) {
    await finishTracking(job.id)
    return
  }

  // Mismo id en todos los avisos intermedios: se sustituyen en vez de apilarse.
  await showArrivalAlert(notificationId(`${job.id}|done`), job.lineId, job.stopName, {
    seen: job.busesSeen,
    target: trackingBusTarget(),
  })
  log(
    'info',
    'aviso',
    `Autobús ${job.busesSeen} de ${trackingBusTarget()} de la línea ${job.lineId} ha pasado por ${job.stopName}.`,
  )
  showToast(`Autobús ${job.busesSeen} de ${trackingBusTarget()} ya ha pasado`, 'info')
  render()
}

/**
 * Cierra un aviso: ya han pasado todos los autobuses que se esperaban.
 *
 * `alreadyNotified` lo ponen los cierres que vienen del servicio nativo, que ya
 * ha publicado él su aviso de "completado". Sin eso salían DOS notificaciones
 * iguales cada vez que pasaba el autobús: la del servicio y la de aquí.
 */
async function finishTracking(id: string, alreadyNotified = false): Promise<void> {
  const job = trackingById(id)
  if (!job) {
    return
  }

  const target = trackingBusTarget()

  if (!alreadyNotified) {
    await showArrivalAlert(
      notificationId(`${job.id}|done`),
      job.lineId,
      job.stopName,
      { seen: target, target },
      { stopId: job.stopId, lineId: job.lineId, directionKey: job.directionKey },
    )
  }

  const cuantos = target > 1 ? `${target} autobuses` : 'el autobús'

  log('info', 'aviso', `Aviso completado: ha pasado ${cuantos} de la línea ${job.lineId} por ${job.stopName}.`)
  await removeTracking(id, false)
  showToast(`Ya ha pasado ${cuantos} de la línea ${job.lineId}`, 'success')
  render()
}

/* ------------------------------------------------------------------ *
 * Puntualidad                                                          *
 * ------------------------------------------------------------------ */

function evaluateMonitors(feed: StopFeed): void {
  const at = feed.fetchedAt || Date.now()
  const now = new Date(at)
  let touched = false

  for (const monitor of state.monitors) {
    if (monitor.stopId !== feed.stopId) {
      continue
    }

    if (!isWithinWindow(monitor, now)) {
      // Fuera de la franja se olvida el estado: un autobús que quedó "entrando"
      // ayer no puede contarse como un paso de hoy.
      if (state.monitorRuntime[monitor.id]) {
        delete state.monitorRuntime[monitor.id]
        touched = true
      }
      continue
    }

    // Un 429 o un error de red no dicen nada de la parada. Tratarlos como
    // "el autobús ya no aparece" inventaría pasos que nunca ocurrieron.
    if (feed.status !== 'ok' && feed.status !== 'empty') {
      addMonitorTrace(monitor.id, {
        at,
        minutes: null,
        armed: state.monitorRuntime[monitor.id]?.armed === true,
        level: feed.status === 'throttled' ? 'warn' : 'error',
        note:
          feed.status === 'throttled'
            ? 'La fuente limitó la consulta (429). Se descarta: un bloqueo no dice nada de la parada.'
            : `No se pudo consultar la parada (${feed.message ?? 'error de red'}). Se descarta.`,
      })
      continue
    }

    state.monitorSeenAt[monitor.id] = at

    // Con el servicio nativo al mando, la detección es suya: repetirla aquí
    // apuntaría dos veces el mismo autobús mientras la app estuviera abierta.
    // Su estado de detección tampoco se puede reflejar aquí, así que se descarta
    // el de la web para no dejar colgado un "autobús entrando" que ya no avanza.
    if (nativeMonitorIds.has(monitor.id)) {
      if (state.monitorRuntime[monitor.id]) {
        delete state.monitorRuntime[monitor.id]
        touched = true
      }
      addMonitorTrace(monitor.id, {
        at,
        minutes: null,
        armed: false,
        level: 'info',
        note: 'Lo mide el servicio en segundo plano; la app no detecta pasos de este control para no apuntarlos dos veces.',
      })
      continue
    }

    const arrival = feed.arrivals
      .filter((item) => item.lineId === monitor.lineId)
      .sort((left, right) => liveMinutes(left) - liveMinutes(right))[0]

    const before = state.monitorRuntime[monitor.id]
    const minutes = arrival ? liveMinutes(arrival) : null

    const detection = observe(before, { minutes, at })

    state.monitorRuntime[monitor.id] = detection.runtime
    touched = true

    // El registro cuenta lo que se vio Y lo que se decidió con ello. Sin esta
    // segunda mitad, una franja entera sin horas anotadas se ve exactamente
    // igual que una franja en la que la app no llegó a consultar nada.
    if (detection.passAt === null) {
      addMonitorTrace(monitor.id, {
        at,
        minutes,
        armed: detection.runtime.armed,
        level: minutes === null && !detection.runtime.armed ? 'info' : 'info',
        note:
          minutes === null
            ? before?.armed
              ? `La línea ${monitor.lineId} deja de figurar (${detection.runtime.missingStreak} de ${MISSING_STREAK} consultas). Falta una más para dar el paso por bueno.`
              : `La línea ${monitor.lineId} no figura ahora en el panel de la parada.`
            : detection.runtime.armed
              ? `Autobús entrando: faltan ${minutes} min. Se anota como hora estimada de paso.`
              : `Faltan ${minutes} min; todavía por encima de los ${ARM_MINUTES} a los que se empieza a vigilar.`,
      })
    }

    if (detection.passAt !== null && detection.reason) {
      recordPass(monitor, detection.passAt, detection.reason)
    }
  }

  if (touched) {
    persistMonitorRuntime()
  }
}

/**
 * Guarda un paso observado y lo asocia a la salida programada más cercana de la
 * franja del control (±15 min). Si no hay ninguna se guarda igualmente sin hora
 * programada: antes se descartaba, y con ello se perdía justo la información que
 * delata que el horario oficial ya no se cumple.
 */
function recordPass(monitor: MonitorJob, passAt: number, reason: 'jump' | 'gone'): void {
  const at = new Date(passAt)
  const dayType = currentDayType(at)
  const observedMinutes = at.getHours() * 60 + at.getMinutes()
  const match = matchSlot(observedMinutes, monitorSlots(monitor, dayType))
  const deltaText = match.delta === null || match.delta === 0
    ? 'en hora'
    : `${match.delta > 0 ? '+' : ''}${match.delta} min`

  addMonitorPass(monitor.id, {
    at: passAt,
    date: localDateKey(at),
    dayType,
    minutes: observedMinutes,
    slot: match.slot,
    delta: match.delta,
    reason,
  })

  addMonitorTrace(monitor.id, {
    at: passAt,
    minutes: 0,
    armed: false,
    level: match.slot ? 'info' : 'warn',
    note: match.slot
      ? `Paso anotado a las ${formatMinutesClock(observedMinutes)} (${reason === 'jump' ? 'el contador saltó al siguiente autobús' : 'la línea desapareció del panel'}); programado ${match.slot}, ${deltaText}.`
      : `Paso anotado a las ${formatMinutesClock(observedMinutes)}, pero el horario oficial no tiene ninguna salida de esta línea a menos de 15 min: se guarda aparte, sin desvío.`,
  })

  log(
    'info',
    'puntualidad',
    match.slot
      ? `Línea ${monitor.lineId} pasó por ${monitor.stopName} a las ${formatMinutesClock(
          observedMinutes,
        )} (programado ${match.slot}, ${deltaText}).`
      : `Línea ${monitor.lineId} pasó por ${monitor.stopName} a las ${formatMinutesClock(
          observedMinutes,
        )}; el horario oficial no recoge ninguna salida cercana.`,
  )

  render()
}

/* ------------------------------------------------------------------ *
 * Vigilancia de las franjas de puntualidad                             *
 * ------------------------------------------------------------------ */

/** Notificacion persistente que declara "estoy midiendo". */
const MONITOR_NOTIFICATION_ID = notificationId('salbus:monitor-window')

/** Franjas abiertas ahora mismo, con el instante en que se abrieron. */
const monitorWindowOpenedAt: Record<string, number> = {}

/** Ultimo aviso de silencio de cada control, para no repetirlo cada segundo. */
const monitorSilenceWarnedAt: Record<string, number> = {}

/** Sin una consulta buena en este tiempo, algo va mal y hay que decirlo. */
const MONITOR_SILENCE_MS = 3 * 60_000

/** Cada cuanto se reescribe el texto de la notificacion persistente. */
const MONITOR_NOTICE_REFRESH_MS = 30_000

let monitorNoticeShownAt = 0

/**
 * Se ejecuta en cada latido del reloj y hace tres cosas que la deteccion de
 * pasos no puede hacer por si sola, porque solo se ejecuta cuando LLEGA un dato:
 *
 *  1. Deja constancia de cuando empieza y termina cada franja.
 *  2. Avisa en el registro cuando una franja abierta lleva minutos sin una sola
 *     consulta. Ese es el caso que dejaba la pantalla de puntualidad vacia sin
 *     que nada lo explicara: el movil durmiendose entre consulta y consulta.
 *  3. Sostiene la notificacion persistente mientras se mide.
 */
function superviseMonitors(): void {
  const now = Date.now()
  const open = state.monitors.filter((monitor) => isWithinWindow(monitor))
  const openIds = new Set(open.map((monitor) => monitor.id))

  for (const monitor of state.monitors) {
    const inWindow = openIds.has(monitor.id)

    if (inWindow && !monitorWindowOpenedAt[monitor.id]) {
      monitorWindowOpenedAt[monitor.id] = now
      addMonitorTrace(monitor.id, {
        at: now,
        minutes: null,
        armed: false,
        level: 'info',
        note: `Empieza la franja ${formatMinutesClock(monitor.startMinutes)}–${formatMinutesClock(
          monitor.endMinutes,
        )}. ${
          nativeMonitorIds.has(monitor.id)
            ? 'La mide el servicio en segundo plano.'
            : 'La mide la app; necesita quedarse despierta.'
        }`,
      })
      continue
    }

    if (!inWindow && monitorWindowOpenedAt[monitor.id]) {
      delete monitorWindowOpenedAt[monitor.id]
      delete monitorSilenceWarnedAt[monitor.id]
      addMonitorTrace(monitor.id, {
        at: now,
        minutes: null,
        armed: false,
        level: 'info',
        note: `Termina la franja. ${(state.monitorPasses[monitor.id] ?? []).filter(
          (pass) => pass.date === localDateKey(now),
        ).length} paso(s) anotados hoy.`,
      })
    }
  }

  for (const monitor of open) {
    if (nativeMonitorIds.has(monitor.id)) {
      continue
    }

    const since = state.monitorSeenAt[monitor.id] ?? monitorWindowOpenedAt[monitor.id] ?? now
    const silent = now - since

    if (silent < MONITOR_SILENCE_MS || now - (monitorSilenceWarnedAt[monitor.id] ?? 0) < MONITOR_SILENCE_MS) {
      continue
    }

    monitorSilenceWarnedAt[monitor.id] = now
    addMonitorTrace(monitor.id, {
      at: now,
      minutes: null,
      armed: state.monitorRuntime[monitor.id]?.armed === true,
      level: 'warn',
      note: `${Math.round(silent / 60_000)} min sin una sola consulta buena de esta parada. Con la pantalla apagada Android congela la app: revisa el permiso de batería y deja la notificación de medición visible.`,
    })
    log(
      'warn',
      'puntualidad',
      `El control de la línea ${monitor.lineId} en ${monitor.stopName} lleva ${Math.round(
        silent / 60_000,
      )} min sin datos.`,
    )
  }

  syncMonitorNotification(open, now)
}

/**
 * Notificacion persistente mientras dura la medicion.
 *
 * Solo para los controles que NO lleva el servicio nativo: el servicio ya
 * publica la suya, y dos notificaciones diciendo lo mismo son una de mas.
 */
function syncMonitorNotification(open: MonitorJob[], now: number): void {
  const mine = open.filter((monitor) => !nativeMonitorIds.has(monitor.id))

  if (mine.length === 0) {
    if (monitorNoticeShownAt > 0) {
      monitorNoticeShownAt = 0
      void cancelNotification(MONITOR_NOTIFICATION_ID)
    }
    return
  }

  if (now - monitorNoticeShownAt < MONITOR_NOTICE_REFRESH_MS) {
    return
  }

  monitorNoticeShownAt = now

  const first = mine[0]
  const until = Math.max(...mine.map((monitor) => monitor.endMinutes))
  const today = localDateKey(now)
  const passes = mine.reduce(
    (total, monitor) =>
      total + (state.monitorPasses[monitor.id] ?? []).filter((pass) => pass.date === today).length,
    0,
  )

  void showOngoingNotification(
    MONITOR_NOTIFICATION_ID,
    `Midiendo puntualidad · hasta las ${formatMinutesClock(until)}`,
    mine.length === 1
      ? `Línea ${first.lineId} en ${first.stopName}
${passes} paso(s) anotados hoy`
      : `${mine.length} controles en marcha
${passes} paso(s) anotados hoy`,
  )
}

/* ------------------------------------------------------------------ *
 * Render + eventos                                                     *
 * ------------------------------------------------------------------ */

function render(): void {
  if (renderQueued) {
    return
  }

  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    paint()
  })
}

// Solo en el servidor de desarrollo: permite a tools/uicheck.mjs colocar la
// interfaz en estados que de otro modo exigirian un dispositivo (aviso de
// actualizacion, descarga en curso). Vite lo elimina de la compilacion de
// produccion, asi que no viaja en la APK.
if (import.meta.env.DEV) {
  ;(window as unknown as { __salbus?: unknown }).__salbus = {
    state,
    render,
    // Para medir la cola de consultas desde tools/: cuanto tarda un lote y
    // cuanto tarda la parada que alguien acaba de abrir con un lote corriendo.
    health: getClientHealth,
    fetchStopArrivals,
    fetchStopsSequentially,
    fetchStopsInParallel,
  }
}

function paint(): void {
  // Repintado incremental: solo se tocan los nodos que han cambiado. Antes se
  // reescribía todo el HTML cada segundo, y eso cerraba cualquier desplegable
  // abierto (el elemento sobre el que el sistema lo había desplegado dejaba de
  // existir), además de perder foco, cursor y desplazamiento.
  patch(appRoot, renderApp())
  syncMap()
  // Solo hace algo cuando la pestaña experimental está abierta; en cualquier
  // otra pantalla se limita a soltar el mapa si quedaba alguno.
  syncMapsMap()
  applyPendingScroll()
}

/**
 * Lleva la vista hasta la franja recien abierta (la ficha de la parada tras
 * pulsar "Ver tiempos"). Se hace despues de pintar, que es cuando el nodo
 * destino existe ya en el documento.
 */
function applyPendingScroll(): void {
  if (!scrollPending) {
    return
  }

  const target = document.getElementById(scrollPending)
  scrollPending = null

  if (!target) {
    return
  }

  // Un fotograma de margen: con el mapa saliendo de pantalla completa, la
  // posicion final del documento aun no esta asentada.
  //
  // Se desplaza SOLO la pantalla. scrollIntoView mueve también todos los
  // contenedores de encima, incluido el documento, y eso subía el header por
  // debajo de la barra de notificaciones del móvil.
  requestAnimationFrame(() => {
    const screen = document.getElementById('screen')
    if (!screen || !screen.contains(target)) {
      return
    }
    const offset = target.getBoundingClientRect().top - screen.getBoundingClientRect().top
    screen.scrollTo({ top: screen.scrollTop + offset - 12, behavior: 'smooth' })
  })
}

appRoot.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]')
  if (!target) {
    return
  }

  void handleAction(target.dataset.action ?? '', target)
})

appRoot.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement | null
  if (!target) {
    return
  }

  if (target.id === 'stop-query') {
    state.search.query = target.value
    render()
  }

  // Buscador de la pestaña experimental: estado aparte del buscador de siempre,
  // para que escribir en uno no mueva el otro.
  if (target.id === 'maps-query') {
    state.maps.query = target.value
    render()
  }

  if (target.id === 'alias-input') {
    state.draft.alias = target.value
  }

  if (target.dataset.action === 'draft-start') {
    state.draft.startMinutes = parseClockToMinutes(target.value)
  }

  if (target.dataset.action === 'draft-end') {
    state.draft.endMinutes = parseClockToMinutes(target.value)
  }
})

appRoot.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement | null
  if (!target?.dataset.action) {
    return
  }

  const action = target.dataset.action

  if (action === 'pick-search-line') {
    state.search.lineId = target.value
    // El sentido NO se rellena solo: mientras siga en "Seleccionar" no hay
    // recorrido elegido, y el mapa no tiene por que ocupar la pantalla entera.
    state.search.directionKey = ''
    state.search.mapExpanded = false
    render()
  }

  if (action === 'pick-search-direction') {
    state.search.directionKey = target.value
    // Solo con linea Y sentido elegidos a mano: el recorrido es entonces lo
    // unico que interesa mirar, asi que el mapa pasa a pantalla completa.
    if (state.search.mode === 'mapa' && state.search.lineId && state.search.directionKey) {
      state.search.mapExpanded = true
    } else {
      state.search.mapExpanded = false
    }
    render()
  }

  if (action === 'pick-bus-target') {
    state.settings.trackingBusTarget = clampBusTarget(Number(target.value))
    persistSettings()
    // El servicio nativo cuenta los pasos por su cuenta: necesita el numero.
    void syncTrackingService()
    render()
  }

  if (action === 'draft-line') {
    state.draft.lineId = target.value
    const stopId = target.dataset.stop ?? ''
    const purpose = state.sheet?.kind === 'pick-line' ? state.sheet.purpose : 'tracking'
    state.draft.directionKey = defaultDirectionKey(stopId, target.value, purpose)
    render()
  }

  if (action === 'draft-direction') {
    state.draft.directionKey = target.value
  }

  if (action === 'draft-skip') {
    state.draft.skip = target.value === '1' ? 1 : 0
  }

  if (action === 'info-line') {
    state.info.lineId = target.value
    // El sentido NO se hereda de la línea anterior: no existe fuera de ella.
    state.info.directionKey = ''
    render()
  }

  if (action === 'info-direction') {
    state.info.directionKey = target.value
    render()
  }

  if (action === 'monitor-day') {
    const monitorId = target.dataset.monitor ?? ''
    state.monitorDayView[monitorId] = target.value as 'weekday' | 'saturday' | 'sunday'
    render()
  }
})

async function handleAction(action: string, element: HTMLElement): Promise<void> {
  const stopId = element.dataset.stop ?? ''

  switch (action) {
    case 'tab': {
      const tab = element.dataset.tab as TabId | undefined
      if (tab) {
        await goToTab(tab)
      }
      return
    }

    case 'refresh':
      await refreshVisible('manual')
      return

    case 'refresh-stop':
      await refreshOneStop(stopId)
      return

    case 'run-update':
      await runUpdate()
      return

    case 'check-update':
      await checkUpdateManually()
      return

    case 'dismiss-update':
      // Solo hasta el proximo arranque: no se guarda en disco a proposito.
      state.update.dismissed = true
      render()
      return

    case 'open-install-settings':
      try {
        await Updater.openInstallSettings()
      } catch (error) {
        showToast(errorMessage(error), 'error')
      }
      return

    case 'retry-boot':
      window.location.reload()
      return

    case 'search-mode': {
      const mode = element.dataset.mode as SearchMode | undefined
      if (!mode) {
        return
      }

      state.search.mode = mode
      // Linea y sentido se quedan en "Seleccionar" hasta que se elijan a mano.
      if (mode !== 'mapa' || !state.search.lineId || !state.search.directionKey) {
        state.search.mapExpanded = false
      }

      // Entrar en "Cerca" sin ubicacion no puede quedarse en un boton: es la
      // unica cosa que esa pantalla sabe hacer, y pedirla es justo lo que se ha
      // pedido al elegir el modo.
      if (mode === 'cerca') {
        void startNearbySearch()
      }

      render()
      return
    }

    case 'toggle-line-filter':
      state.search.lineFilterOpen = !(state.search.lineFilterOpen || Boolean(state.search.lineId))
      render()
      return

    // El filtro de linea del buscador, de vuelta a "sin filtro". El texto
    // escrito se respeta: quitar el filtro no es empezar de cero.
    case 'clear-line-filter':
      state.search.lineId = ''
      state.search.directionKey = ''
      state.search.lineFilterOpen = false
      state.search.mapExpanded = false
      render()
      return

    // Ampliar ya no exige haber elegido linea: sin ella el mapa enseña las
    // paradas de toda la red, y precisamente ahi es donde mas falta hace verlo
    // grande para acertarle a la parada con el dedo.
    case 'expand-map':
      state.search.mapExpanded = true
      render()
      return

    case 'collapse-map':
      state.search.mapExpanded = false
      render()
      return

    // Desde el globo del mapa. El mapa se queda como esta: la ficha se abre
    // por encima, asi que no hay que salir de la pantalla completa para verla.
    case 'map-select-stop':
    case 'select-stop':
      // La vista compacta es la predeterminada y se REFUERZA: haber desplegado
      // las llegadas de una parada no deja desplegada la siguiente que se abra.
      state.arrivalsExpandedStopId = null
      state.search.selectedStopId = stopId
      render()
      await ensureStopFresh(stopId)
      return

    case 'close-stop':
      state.search.selectedStopId = null
      render()
      return

    case 'expand-stop': {
      const opening = state.expandedStopId !== stopId
      state.expandedStopId = opening ? stopId : null
      // Vista compacta otra vez: desplegar las llegadas vale para ESA parada y
      // ese momento, no para todas las que se abran despues.
      state.arrivalsExpandedStopId = null
      render()

      if (opening) {
        // La parada que se acaba de abrir manda. El repaso de todas las
        // guardadas que corre al entrar en Inicio se corta aqui mismo: si no,
        // esta se quedaba esperando turno detras de nueve paradas que nadie
        // esta mirando, a dos segundos por consulta.
        cancelRefreshCycle()
        void refreshOneStop(stopId)
      }
      return
    }

    case 'toggle-favourite':
      if (isFavourite(stopId)) {
        state.favourites = state.favourites.filter((item) => item.stopId !== stopId)
        showToast('Parada quitada de tus favoritas', 'info')
      } else {
        state.favourites = [...state.favourites, { stopId, alias: null, addedAt: Date.now() }]
        showToast('Parada guardada', 'success')
      }
      persistFavourites()
      refreshWidget()
      render()
      return

    case 'remove-favourite':
      state.favourites = state.favourites.filter((item) => item.stopId !== stopId)
      persistFavourites()
      refreshWidget()
      showToast('Parada quitada', 'info')
      render()
      return

    case 'rename-stop':
      state.draft.alias = state.favourites.find((item) => item.stopId === stopId)?.alias ?? ''
      state.sheet = { kind: 'rename', stopId }
      render()
      return

    case 'confirm-rename': {
      const favourite = state.favourites.find((item) => item.stopId === stopId)
      if (favourite) {
        const alias = state.draft.alias.trim()
        favourite.alias = alias.length > 0 ? alias : null
        persistFavourites()
        refreshWidget()
      }
      state.sheet = null
      render()
      return
    }

    case 'stop-actions':
      state.sheet = { kind: 'stop-actions', stopId }
      render()
      return

    case 'pick-line': {
      const purpose = element.dataset.purpose as 'tracking' | 'monitor' | undefined
      if (!purpose) {
        return
      }

      openPickLine(stopId, purpose)
      return
    }

    case 'confirm-sheet': {
      const purpose = element.dataset.purpose as 'tracking' | 'monitor' | undefined
      await confirmSheet(stopId, purpose)
      return
    }

    case 'close-sheet':
      state.sheet = null
      render()
      return

    case 'stop-tracking':
      await removeTracking(element.dataset.tracking ?? '')
      return

    // Deja el autobús que se seguía y pasa al siguiente de la línea.
    case 'skip-tracking':
      await skipTracking(element.dataset.tracking ?? '')
      return

    // Lista de llegadas: las que pasan de ARRIVALS_PREVIEW se piden a mano, y
    // solo una parada a la vez puede estar desplegada.
    case 'show-schedule-estimate':
      state.scheduleFallbackStops[stopId] = true
      render()
      return

    case 'expand-arrivals':
      state.arrivalsExpandedStopId = stopId
      render()
      return

    case 'collapse-arrivals':
      state.arrivalsExpandedStopId = null
      render()
      return

    case 'toggle-maps': {
      const enabled = !state.settings.experimentalMaps
      state.settings.experimentalMaps = enabled
      persistSettings()

      // Al apagarla se suelta todo lo suyo en el acto: mapa, ubicación y ruta.
      // Si no, un `watchPosition` seguiría vivo con la pestaña ya invisible.
      if (!enabled) {
        closeMaps()
        // La pestaña Info NO se cierra: los horarios de línea siguen ahí y no
        // tienen nada de experimental. Lo que se apaga es su apartado "Cómo
        // llegar", así que basta con llevar el foco al que sigue existiendo.
        if (state.tab === 'info') {
          state.info.section = 'lineas'
        }
      }

      showToast(enabled ? '"Cómo llegar" activado' : '"Cómo llegar" desactivado', 'info')
      render()
      return
    }

    case 'info-section': {
      const section = element.dataset.section as InfoSection | undefined
      if (!section || section === state.info.section) {
        return
      }

      state.info.section = section

      // El callejero solo hace falta para calcular rutas, y son cien mil nodos:
      // se pide al abrir SU apartado, no al entrar en la pestaña.
      if (section === 'llegar' && state.settings.experimentalMaps) {
        void loadStreetGraph()
      } else if (section === 'lineas') {
        // El mapa de rutas no puede quedarse vivo detrás de una tabla de
        // horarios: suelta el seguimiento de la ubicación y la instancia de
        // Leaflet igual que al salir de la pestaña.
        closeMaps()
      }

      render()
      return
    }

    case 'settings-section': {
      const section = element.dataset.section as SettingsSection | undefined
      if (section) {
        state.settingsSection = section
        render()
      }
      return
    }

    case 'locate':
      // "Ya está activada, buscar paradas": se vuelve a preguntar al sistema
      // antes de localizar, porque el interruptor puede seguir apagado y
      // entonces lo que toca es repetir el aviso, no una búsqueda que fallará.
      void startNearbySearch(true)
      return

    // Lleva a la pantalla del sistema donde de verdad se arregla: el
    // interruptor general de ubicación, o los permisos de SALBUS.
    case 'open-location-settings':
      try {
        if (state.geo.blocked === 'permission') {
          await DeviceSettings.openAppSettings()
        } else {
          await DeviceSettings.openLocationSettings()
        }
      } catch (error) {
        showToast(errorMessage(error), 'error')
      }
      return

    // El mapa de "Cómo llegar", a pantalla completa y de vuelta. Igual que
    // el del buscador, el contenedor NO se mueve del árbol: solo cambia cómo se
    // coloca, porque moverlo obligaría a reconstruir Leaflet cada vez.
    case 'maps-expand':
      state.maps.expanded = true
      mapsSignature = ''
      render()
      return

    case 'maps-collapse':
      state.maps.expanded = false
      mapsSignature = ''
      render()
      return

    case 'maps-pick': {
      const field = element.dataset.field as 'origin' | 'destination' | undefined
      if (field) {
        state.maps.picking = field
        state.maps.query = ''
        render()
      }
      return
    }

    case 'maps-pick-cancel':
      state.maps.picking = null
      render()
      return

    case 'maps-pick-here': {
      const point = currentLocationPoint()
      if (!point) {
        // Aún no se sabe dónde está: se pide, se deja el buscador abierto para
        // poder elegir una parada mientras tanto, y se anota el campo para
        // rellenarlo solo en cuanto llegue la posición.
        pendingLocationField = state.maps.picking
        showToast('Buscando tu ubicación…', 'info')
        locateMe()
        return
      }

      applyRoutePoint(point)
      return
    }

    case 'maps-pick-stop': {
      const stop = state.network?.stopById.get(stopId)
      if (stop) {
        applyRoutePoint({
          kind: 'stop',
          label: stop.stopName,
          lat: stop.lat,
          lon: stop.lon,
          stopId: stop.stopId,
        })
      }
      return
    }

    case 'maps-swap': {
      const { origin, destination } = state.maps
      state.maps.origin = destination
      state.maps.destination = origin
      state.maps.plan = null
      mapsSignature = ''
      render()
      return
    }

    case 'maps-plan':
      planMapsRoute()
      return

    case 'maps-focus-leg': {
      const leg = Number.parseInt(element.dataset.leg ?? '', 10)
      state.maps.focusedLeg = Number.isFinite(leg) && state.maps.focusedLeg !== leg ? leg : null
      mapsSignature = ''
      render()
      return
    }

    case 'toggle-vibration':
      state.settings.vibrateOnApproach = !state.settings.vibrateOnApproach
      persistSettings()
      // El servicio nativo lleva su propia copia del ajuste.
      await syncTrackingService()
      showToast(
        state.settings.vibrateOnApproach ? 'Vibración activada' : 'Vibración desactivada',
        'info',
      )
      render()
      return

    case 'tour-next':
      if (state.tour.step >= TOUR_STEPS - 1) {
        closeTour()
        return
      }
      state.tour.step += 1
      render()
      return

    case 'tour-back':
      state.tour.step = Math.max(0, state.tour.step - 1)
      render()
      return

    case 'tour-close':
      closeTour()
      return

    case 'tour-open':
      state.tour = { open: true, step: 0 }
      render()
      return

    case 'remove-monitor': {
      const monitorId = element.dataset.monitor ?? ''
      state.monitors = state.monitors.filter((item) => item.id !== monitorId)
      delete state.monitorPasses[monitorId]
      delete state.monitorRuntime[monitorId]
      delete state.monitorSeenAt[monitorId]
      delete state.monitorTraceOpen[monitorId]
      clearMonitorTrace(monitorId)
      persistMonitors()
      persistMonitorPasses()
      persistMonitorRuntime()
      // El servicio deja de medirlo en el acto: si no, seguiría despertando el
      // móvil por una franja que ya no le importa a nadie.
      await syncTrackingService()
      render()
      return
    }

    case 'request-notifications':
      state.permissions.notifications = await ensureNotificationPermission()
      render()
      return

    case 'request-battery':
      await syncBatteryPermission(true)
      render()
      return

    case 'clear-logs':
      clearLogs()
      render()
      return

    // Registro de un control de puntualidad: es la respuesta a "¿por qué no se
    // está apuntando ninguna hora?", así que se abre y se cierra donde se hace
    // la pregunta, dentro de la propia tarjeta.
    case 'toggle-monitor-trace': {
      const monitorId = element.dataset.monitor ?? ''
      if (state.monitorTraceOpen[monitorId]) {
        delete state.monitorTraceOpen[monitorId]
      } else {
        state.monitorTraceOpen[monitorId] = true
      }
      render()
      return
    }

    case 'clear-monitor-trace':
      clearMonitorTrace(element.dataset.monitor ?? '')
      render()
      return

    default:
      return
  }
}

/**
 * Cambio de pestaña.
 *
 * Es el unico punto por el que se cambia de pantalla, y por eso es donde viven
 * las dos limpiezas que dependen de ello: los recorridos se paran al salir de
 * "Seguir", y el buscador vuelve a "Seleccionar" al entrar en "Buscar".
 */
async function goToTab(tab: TabId): Promise<void> {
  const previous = state.tab

  // Al salir de Seguir el aviso NO se pausa: es justo la función que tiene
  // sentido fuera de su pantalla, porque lo que hace es avisar cuando no se
  // está mirando. Lo que se reduce es su rastreo del recorrido, y de eso se
  // encarga solo `buildRefreshPlan` mirando la pestaña activa.

  // Al salir de Info se suelta TODO lo del planificador: el seguimiento de la
  // ubicación, el mapa y lo calculado. Una función experimental no puede
  // quedarse trabajando por detrás mientras miras otra pantalla.
  if (previous === 'info' && tab !== 'info') {
    closeMaps()
  }

  // El callejero son cien mil nodos por una función en pruebas: se pide al
  // entrar en su apartado, no al arrancar la app, y una sola vez por sesión.
  // Los horarios de línea no lo necesitan, así que no lo cargan.
  if (tab === 'info' && state.info.section === 'llegar' && state.settings.experimentalMaps) {
    void loadStreetGraph()
  }

  if (tab === 'buscar' && previous !== 'buscar') {
    // Los desplegables arrancan siempre sin elegir: al volver al buscador, una
    // linea y un sentido heredados de la visita anterior se leian como una
    // busqueda en curso que nadie habia pedido.
    state.search.lineId = ''
    state.search.directionKey = ''
    state.search.lineFilterOpen = false
    state.search.mapExpanded = false
    state.search.selectedStopId = null
  }

  // Salir de Buscar suelta el seguimiento de la ubicación si no queda quien la
  // mire: es lo único de esa pantalla que sigue trabajando por detrás.
  if (previous === 'buscar' && tab !== 'buscar' && tab !== 'info') {
    stopWatchingLocation()
  }

  state.tab = tab
  state.sheet = null
  persistTab()

  // Entrar en Buscar con "Cerca" ya elegido es pedir las paradas cercanas, y lo
  // primero que hay que resolver es si el teléfono puede saber dónde está.
  if (tab === 'buscar' && state.search.mode === 'cerca') {
    void startNearbySearch()
  }

  render()
  // El servicio barre el recorrido entero solo mientras se está mirando.
  void syncRouteWatch()
  void refreshVisible('auto')
}

/** Abre la hoja de eleccion de linea con el borrador ya preparado. */
function openPickLine(stopId: string, purpose: 'tracking' | 'monitor'): void {
  const lines = state.network?.getLinesForStop(stopId) ?? []
  state.draft.lineId = lines[0]?.lineId ?? ''
  state.draft.directionKey = defaultDirectionKey(stopId, state.draft.lineId, purpose)
  state.draft.skip = 0
  state.sheet = { kind: 'pick-line', stopId, purpose }
  render()

  // "1er / 2º autobús disponible" enseñan cuánto le falta a cada uno: que sea
  // la hora de ahora y no la de la última vez que se miró la parada.
  if (purpose === 'tracking') {
    void refreshOneStop(stopId)
  }
}

/**
 * Sentido con el que abre el desplegable.
 *
 * Un aviso solo ofrece los sentidos entre los que cabe elegir de verdad (los
 * parciales son variantes del mismo, no otro), asi que su valor de partida
 * tiene que salir de esa misma lista o el desplegable abriria con una opcion
 * que no figura en el.
 */
function defaultDirectionKey(
  stopId: string,
  lineId: string,
  purpose: 'tracking' | 'monitor',
): string {
  const options = purpose === 'tracking'
    ? trackingDirectionOptions(stopId, lineId)
    : state.network?.getDirectionsThroughStop(stopId, lineId) ?? []

  return options[0]?.key ?? ''
}

/**
 * Cierra el tour y lo da por visto para ESTA version. Volvera a aparecer solo
 * cuando la app se actualice, que es cuando hay algo nuevo que contar.
 */
function closeTour(): void {
  state.tour = { open: false, step: 0 }
  markTourSeen()
  render()
}

async function confirmSheet(
  stopId: string,
  purpose: 'tracking' | 'monitor' | undefined,
): Promise<void> {
  const lineId = state.draft.lineId
  if (!purpose || !lineId) {
    showToast('Elige una línea', 'error')
    return
  }

  if (purpose === 'tracking') {
    state.sheet = null
    render()
    // El sentido solo se ha preguntado cuando por la parada pasaban varios; si
    // no, el borrador trae el único posible y da igual pasarlo.
    const replaced = await createTracking(stopId, lineId, state.draft.directionKey, state.draft.skip)
    state.tab = 'seguimiento'
    persistTab()
    showToast(
      replaced ? 'Aviso sustituido: te avisaremos cuando se acerque' : 'Te avisaremos cuando se acerque',
      'success',
    )
    render()
    return
  }

  // Puntualidad
  const { startMinutes, endMinutes } = state.draft
  const directionKey = state.draft.directionKey || null
  const duration = endMinutes - startMinutes

  if (duration < 15) {
    showToast('La franja debe durar al menos 15 minutos', 'error')
    return
  }

  if (duration > 120) {
    showToast('La franja no puede superar las 2 horas', 'error')
    return
  }

  const id = `${stopId}|${lineId}|${directionKey ?? 'todos'}|${startMinutes}|${endMinutes}`
  if (state.monitors.some((item) => item.id === id)) {
    showToast('Ese control ya existe', 'error')
    return
  }

  state.monitors = [
    ...state.monitors,
    {
      id,
      stopId,
      stopName: stopName(stopId),
      lineId,
      directionKey,
      startMinutes,
      endMinutes,
      createdAt: Date.now(),
    },
  ]
  persistMonitors()

  // El servicio nativo es quien mide dentro de la franja, también con la app
  // cerrada: se entera del control nuevo ahora, no en el próximo arranque.
  await syncTrackingService()

  state.sheet = null
  state.tab = 'monitor'
  persistTab()
  showToast('Control de puntualidad creado', 'success')
  render()
}

/* ------------------------------------------------------------------ *
 * Mapa                                                                 *
 * ------------------------------------------------------------------ */

function syncMap(): void {
  const container = document.querySelector<HTMLDivElement>('#stop-map')

  if (!container || !state.network) {
    if (map) {
      map.remove()
      map = null
      mapLayer = null
      mapSignature = ''
      mapPaintKey = ''
    }
    return
  }

  if (!map || map.getContainer() !== container) {
    map?.remove()
    map = L.map(container, { zoomControl: false, attributionControl: true })
    L.control.zoom({ position: 'bottomleft' }).addTo(map)
    // Cada gesto sobre el mapa cambia QUE se dibuja, no solo cómo se ve: al
    // acercar los grupos se abren en las paradas que llevan dentro, y al
    // arrastrar entran unas paradas y salen otras. `moveend` cubre las dos
    // cosas (un zoom termina también en un movimiento).
    map.on('moveend', () => {
      applyZoomScale()
      paintStopMarkers()
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map)
    mapLayer = L.layerGroup().addTo(map)
    mapSignature = ''
    mapPaintKey = ''
  }

  // El MISMO mapa sirve a dos modos del buscador, porque son dos vistas de la
  // misma pantalla: "Mapa" (la red, o un recorrido elegido) y "Cerca" (donde
  // estas y las paradas que tienes al lado). Dos instancias de Leaflet
  // obligarian a mantener dos encuadres de acuerdo entre si.
  const nearby = state.search.mode === 'cerca'
  const direction = nearby ? undefined : state.network.directionByKey.get(state.search.directionKey)

  // Sin linea ni sentido elegidos el mapa NO se queda vacio: enseña la red
  // entera para poder tocar directamente la parada que se busca. Es la forma
  // natural de usar un mapa —"esta es mi calle, esta es mi parada"— y antes
  // obligaba a saber de antemano que linea pasa por ella.
  const stops = nearby
    ? nearestStopsForView().map((entry) => entry.stop)
    : direction?.stops ?? state.network.stops

  // La pantalla completa entra en la firma: al cambiar de tamano hay que
  // reencuadrar el recorrido, no solo recalcular el lienzo. El modo tambien,
  // porque cambiar de "Mapa" a "Cerca" cambia lo que hay que encuadrar.
  const signature = `${nearby ? 'cerca' : state.search.directionKey || 'todas'}|${
    state.search.mapExpanded ? 'full' : 'inline'
  }|${state.geo.location ? 'geo' : ''}`


  if (signature === mapSignature) {
    map.invalidateSize()
    // El encuadre no cambia, pero la parada elegida o la ubicacion si: se
    // repintan los marcadores sin mover el mapa de sitio.
    paintStopMarkers()
    return
  }

  mapSignature = signature

  // Al pasar a pantalla completa el contenedor cambia de tamano, pero Leaflet
  // sigue con el anterior en cache. Sin esto el encuadre sale calculado sobre
  // la franja pequena y el recorrido queda diminuto en el centro.
  map.invalidateSize()

  const points: Array<[number, number]> = []
  for (const stop of stops) {
    if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) {
      points.push([stop.lat, stop.lon])
    }
  }

  // En "Cerca" el encuadre tiene que caber TU punto y las paradas: enseñar las
  // paradas sin enseñarte a ti no dice de que lado de la calle estan.
  if (nearby && state.geo.location) {
    points.push([state.geo.location.point.lat, state.geo.location.point.lon])
  }

  // Con un recorrido elegido manda el recorrido. En "Cerca" manda el conjunto
  // de puntos, que ya te incluye. Y en el mapa de la red, si ya se sabe donde
  // estas, el encuadre arranca a tu alrededor: la parada que se busca en un
  // mapa de toda la ciudad casi siempre es una de las de al lado.
  const home = !direction && !nearby ? state.geo.location : null

  if (home) {
    map.setView([home.point.lat, home.point.lon], 16)
  } else if (points.length > 0) {

    map.fitBounds(points, { padding: [34, 34], maxZoom: 16 })
  } else {
    map.setView([40.9701, -5.6635], 13)
  }

  applyZoomScale()
  paintStopMarkers()

  // Segunda pasada: la transicion de tamano del contenedor puede no haber
  // terminado cuando se pinta, y el encuadre quedaria corrido.
  window.setTimeout(() => {
    if (!map) {
      return
    }
    map.invalidateSize()
    if (!home && points.length > 0) {
      map.fitBounds(points, { padding: [34, 34], maxZoom: 16 })
    }
    applyZoomScale()
    paintStopMarkers()
  }, 80)
}

/**
 * "Cerca": tu punto y las paradas que tienes al lado, numeradas.
 *
 * Ni se agrupan ni se recortan al encuadre: son ocho paradas contadas, y el
 * numero —cual tienes mas cerca— ES la informacion, igual que en la lista de
 * abajo. Se numeran con el mismo criterio que ella para que las dos digan lo
 * mismo: la 1 del mapa es la 1 de la lista.
 */
function paintNearbyMarkers(): void {
  if (!map || !mapLayer) {
    return
  }

  const key = `cerca|${state.search.selectedStopId ?? ''}|${
    state.geo.location
      ? `${state.geo.location.point.lat.toFixed(5)},${state.geo.location.point.lon.toFixed(5)}`
      : ''
  }`

  if (key === mapPaintKey) {
    return
  }

  mapPaintKey = key
  mapLayer.clearLayers()
  paintYouAreHere(mapLayer, [])

  nearestStopsForView().forEach((entry, index) => {
    const stop = entry.stop
    const selected = state.search.selectedStopId === stop.stopId

    const marker = L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({
        className: '',
        html: `<span class="map-near${index === 0 ? ' is-first' : ''}${
          selected ? ' is-selected' : ''
        }">${index + 1}</span>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -16],
      }),
      keyboard: false,
      zIndexOffset: selected ? 1000 : 100 - index,
    })

    marker.bindPopup(buildStopPopup(stop), {
      className: 'map-popup',
      closeButton: true,
      maxWidth: 260,
      minWidth: 200,
      autoPanPadding: [16, 16],
    })

    // Igual que en el mapa de la red: abrir el globo ya adelanta la consulta,
    // porque quien lo abre casi siempre acaba pulsando "Ver tiempos".
    marker.on('popupopen', () => prefetchStop(stop.stopId))
    marker.addTo(mapLayer as L.LayerGroup)
  })
}

/** Encuadre redondeado a tres decimales (~100 m): sirve de firma sin repintar por nada. */
function viewKey(bounds: L.LatLngBounds): string {
  const south = bounds.getSouth().toFixed(3)
  const west = bounds.getWest().toFixed(3)
  const north = bounds.getNorth().toFixed(3)
  const east = bounds.getEast().toFixed(3)
  return `${south},${west},${north},${east}`
}

/**
 * A partir de este acercamiento las paradas van una a una.
 *
 * Es el punto en el que dos paradas consecutivas de la misma calle ya se
 * separan lo bastante como para poder acertarle a una con el dedo. Por debajo
 * se agrupan.
 */
const CLUSTER_MAX_ZOOM = 16

/**
 * Dibuja lo que toca segun el acercamiento actual.
 *
 * Se llama tanto al cambiar de busqueda como en cada `zoomend`, y por eso lleva
 * su propia firma: repintar 349 marcadores en cada gesto del mapa es justo lo
 * que hacia que el movil se arrastrara al moverlo.
 */
function paintStopMarkers(): void {
  if (!map || !mapLayer || !state.network) {
    return
  }

  const nearby = state.search.mode === 'cerca'

  if (nearby) {
    paintNearbyMarkers()
    return
  }

  const direction = state.network.directionByKey.get(state.search.directionKey)
  const showingAll = !direction
  const zoom = map.getZoom()


  // Solo se dibuja lo que se está mirando, con un margen para que arrastrar un
  // poco el mapa no deje huecos. Leaflet no descarta nada por su cuenta: cada
  // marcador es un nodo del documento que hay que recolocar en cada gesto, y
  // las 349 paradas de la red arrastraban el mapa entero aunque solo se vieran
  // seis. Con un recorrido elegido no se recorta: son treinta paradas y el
  // recorrido tiene que verse ENTERO, con su trazado.
  const view = map.getBounds().pad(0.35)
  const stops = showingAll
    ? state.network.stops.filter((stop) => view.contains([stop.lat, stop.lon]))
    : direction.stops

  // Con un recorrido elegido las paradas van numeradas y no se agrupan nunca,
  // porque el numero de orden ES la informacion. Sin recorrido, lo que decide
  // el dibujo es el nivel de acercamiento.
  const grouping = showingAll && zoom < CLUSTER_MAX_ZOOM
  const here = state.geo.location?.point
  const key = [
    state.search.directionKey || 'todas',
    state.search.selectedStopId ?? '',
    grouping ? `grupo:${Math.floor(zoom)}` : 'sueltas',
    // El encuadre entra en la firma porque decide QUE paradas se dibujan. Va
    // redondeado: sin eso, cada fotograma de una inercia contaria como un
    // encuadre nuevo y se repintaria el mapa decenas de veces por gesto.
    showingAll ? viewKey(view) : '',
    // El punto de "estás aquí" se afina con cada lectura del GPS: si no entrara
    // en la firma se quedaria clavado donde cayo la primera, que suele ser la
    // peor de todas.
    here ? `${here.lat.toFixed(5)},${here.lon.toFixed(5)}` : '',
  ].join('|')

  if (key === mapPaintKey) {
    return
  }

  mapPaintKey = key
  mapLayer.clearLayers()

  paintYouAreHere(mapLayer, [])

  if (grouping) {
    paintStopClusters(stops, zoom)
    return
  }

  const color = state.network.getLineColor(direction?.key.split('|')[0] ?? '')
  const points: Array<[number, number]> = []

  stops.forEach((stop, index) => {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
      return
    }

    points.push([stop.lat, stop.lon])
    const selected = state.search.selectedStopId === stop.stopId

    // Marcador con icono propio en lugar de un circulo de 6 px: en un movil hay
    // que poder verlo y acertarle con el dedo sin ampliar el mapa. Sin recorrido
    // elegido no hay "numero de orden" que poner, asi que van sin numero.
    const marker = L.marker([stop.lat, stop.lon], {
      icon: buildStopIcon(stop.stopId, showingAll ? null : index + 1, color, selected),
      keyboard: false,
      zIndexOffset: selected ? 1000 : 0,
    })

    marker.bindPopup(buildStopPopup(stop), {
      className: 'map-popup',
      closeButton: true,
      maxWidth: 260,
      minWidth: 200,
      autoPanPadding: [16, 16],
    })

    // Abrir el globo YA lanza la consulta de tiempos. Quien lo abre casi siempre
    // acaba pulsando "Ver tiempos", y esa consulta tarda lo suyo: la fuente no
    // admite mas de una peticion cada dos segundos. Adelantandola aqui, para
    // cuando se pulsa el boton el dato suele estar puesto.
    marker.on('popupopen', () => prefetchStop(stop.stopId))

    marker.addTo(mapLayer as L.LayerGroup)
  })

  // El trazado une las paradas en el orden real del trayecto. Sin recorrido
  // elegido no hay orden que unir: las paradas de la red no son una linea.
  if (!showingAll && points.length > 1) {
    L.polyline(points, { color, weight: 5, opacity: 0.7 }).addTo(mapLayer)
  }
}

/**
 * Las paradas de la red, agrupadas por casillas.
 *
 * Dibujar las 349 desde el acercamiento minimo dejaba el mapa inservible: no
 * por lo que se ve —a esa distancia las chinchetas se solapan hasta ser una
 * mancha— sino por lo que cuesta, porque cada arrastre del dedo obliga a
 * recolocar 349 nodos y el telefono se atasca. Agrupadas son unas pocas
 * decenas de circulos, y cada uno dice cuantas paradas lleva dentro.
 *
 * La casilla se estrecha con cada nivel de acercamiento, asi que los grupos se
 * van partiendo solos hasta que, ya cerca, las paradas salen una a una. Tocar
 * un grupo hace lo mismo de golpe: encuadra lo que tiene dentro.
 */
function paintStopClusters(stops: NetworkStop[], zoom: number): void {
  if (!map || !mapLayer) {
    return
  }

  // Grados de longitud por casilla. El mundo son 360º repartidos en 2^zoom
  // teselas, y se toma un cuarto de tesela: a zoom 13 son unos 900 m, que es la
  // distancia a la que dos paradas dejan de distinguirse en pantalla.
  const cellLon = 360 / 2 ** zoom / 4
  // A la latitud de Salamanca un grado de longitud mide unos tres cuartos de
  // uno de latitud: sin corregirlo las casillas salen rectangulares.
  const cellLat = cellLon * 0.75

  const cells = new Map<string, { stops: NetworkStop[], lat: number, lon: number }>()

  for (const stop of stops) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
      continue
    }

    const key = `${Math.floor(stop.lat / cellLat)}:${Math.floor(stop.lon / cellLon)}`
    const cell = cells.get(key) ?? { stops: [], lat: 0, lon: 0 }
    cell.stops.push(stop)
    cell.lat += stop.lat
    cell.lon += stop.lon
    cells.set(key, cell)
  }

  for (const cell of cells.values()) {
    // Un grupo de una sola parada no es un grupo: se dibuja la parada, que ya
    // se puede tocar y abrir sin tener que acercarse mas.
    if (cell.stops.length === 1) {
      const stop = cell.stops[0]
      const selected = state.search.selectedStopId === stop.stopId
      const marker = L.marker([stop.lat, stop.lon], {
        icon: buildStopIcon(stop.stopId, null, state.network?.getLineColor('') ?? '#1f6feb', selected),
        keyboard: false,
        zIndexOffset: selected ? 1000 : 0,
      })

      marker.bindPopup(buildStopPopup(stop), {
        className: 'map-popup',
        closeButton: true,
        maxWidth: 260,
        minWidth: 200,
        autoPanPadding: [16, 16],
      })
      marker.on('popupopen', () => prefetchStop(stop.stopId))
      marker.addTo(mapLayer)
      continue
    }

    // El grupo se planta en el centro de gravedad de sus paradas, no en el de
    // la casilla: asi cae encima del barrio y no en mitad del campo de al lado.
    const center: [number, number] = [cell.lat / cell.stops.length, cell.lon / cell.stops.length]
    const size = cell.stops.length >= 25 ? 52 : cell.stops.length >= 10 ? 46 : 40

    const marker = L.marker(center, {
      icon: L.divIcon({
        className: '',
        html: `<span class="map-cluster" style="--cluster-size:${size}px">${cell.stops.length}</span>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      }),
      keyboard: false,
      zIndexOffset: 200,
    })

    marker.on('click', () => {
      if (!map) {
        return
      }

      // Encuadrar lo que hay dentro desgrana el grupo en un solo toque. El
      // limite evita que un grupo de dos paradas pegadas dispare el mapa hasta
      // el maximo acercamiento.
      map.fitBounds(
        cell.stops.map((stop) => [stop.lat, stop.lon] as [number, number]),
        { padding: [48, 48], maxZoom: CLUSTER_MAX_ZOOM + 1 },
      )
    })

    marker.addTo(mapLayer)
  }
}

/**
 * Una linea entera cabe en pantalla solo muy alejado, y ahi las chinchetas se
 * amontonan. Alejado se dibujan como puntos; al acercarse recuperan tamano y
 * numero de orden.
 */
function applyZoomScale(): void {
  if (!map) {
    return
  }

  const zoom = map.getZoom()
  const container = map.getContainer()
  container.classList.toggle('is-far', zoom < 14)
  container.classList.toggle('is-mid', zoom >= 14 && zoom < 15.5)
}

/**
 * Chincheta de parada: circulo grande con el numero de orden en el recorrido.
 *
 * Con `order` a `null` (el mapa de toda la red, sin linea elegida) va sin
 * numero y mas pequeña: 349 chinchetas numeradas no se leen, y ese numero no
 * significaria nada sin un recorrido al que pertenecer.
 */
function buildStopIcon(
  stopId: string,
  order: number | null,
  color: string,
  selected: boolean,
): L.DivIcon {
  const plain = order === null
  const size = selected ? 42 : plain ? 22 : 34

  return L.divIcon({
    className: '',
    html: `<span class="map-pin${selected ? ' is-selected' : ''}${plain ? ' is-plain' : ''}" style="--pin:${esc(
      color,
    )};--pin-text:${esc(readableTextColor(color))}" data-stop="${esc(stopId)}">${
      plain ? '' : order
    }</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  })
}

/**
 * Adelanta la consulta de una parada sin abrir su ficha.
 *
 * Va por la misma cola serializada que todo lo demas, con prioridad alta pero
 * sin forzar: si el dato de esa parada aun esta fresco no se pide nada. Lo
 * unico que cambia respecto a abrir la ficha es que aqui nadie esta esperando.
 */
function prefetchStop(stopId: string): void {
  const feed = state.feeds[stopId]

  if (state.stopSync[stopId] !== undefined) {
    return
  }

  if (feed && Date.now() - feed.fetchedAt < FRESHNESS.focused) {
    return
  }

  state.stopSync[stopId] = 'queued'
  render()

  void fetchStopArrivals(stopId, { maxAgeMs: FRESHNESS.focused, priority: 'high' })
    .then((result) => applyFeed(result))
    .catch(() => undefined)
    .finally(() => {
      delete state.stopSync[stopId]
      render()
    })
}

/**
 * Abre la ficha con lo que ya haya y solo pide dato nuevo si hace falta.
 *
 * Antes se forzaba siempre una consulta, con lo que el adelanto del globo del
 * mapa no servia de nada: se volvia a pedir lo mismo y se esperaba otra vez.
 */
async function ensureStopFresh(stopId: string): Promise<void> {
  const feed = state.feeds[stopId]

  if (feed && Date.now() - feed.fetchedAt < FRESHNESS.focused) {
    return
  }

  await refreshOneStop(stopId)
}

/**
 * Ficha reducida de la parada dentro del globo: nombre, codigo y lineas que
 * pasan por ella. Los tiempos no van aqui: pedirlos abriria una consulta por
 * cada parada que se toque, y la fuente oficial limita por IP.
 */
function buildStopPopup(stop: { stopId: string, stopName: string }): string {
  const lines = state.network?.getLinesForStop(stop.stopId) ?? []

  return `
    <div class="map-popup-body">
      <strong class="map-popup-name">${esc(stop.stopName)}</strong>
      <span class="map-popup-code">Parada ${esc(stop.stopId)}</span>
      <span class="map-popup-lines">
        ${
          lines.length === 0
            ? '<em>Sin líneas registradas</em>'
            : lines
                .map(
                  (line) =>
                    `<span class="line-chip is-sm" style="background:${esc(
                      line.color,
                    )};color:${esc(readableTextColor(line.color))}">${esc(line.lineId)}</span>`,
                )
                .join('')
        }
      </span>
      <button class="btn btn-primary btn-sm" type="button" data-action="map-select-stop" data-stop="${esc(
        stop.stopId,
      )}">Ver tiempos</button>
    </div>
  `
}

/* ------------------------------------------------------------------ *
 * Mapas (pestaña experimental)                                         *
 * ------------------------------------------------------------------ */

/** Guarda el extremo recién elegido y cierra el buscador. */
function applyRoutePoint(point: RoutePoint): void {
  const field = state.maps.picking
  if (!field) {
    return
  }

  state.maps[field] = point
  state.maps.picking = null
  state.maps.query = ''
  // El itinerario anterior ya no vale: era de otro trayecto.
  state.maps.plan = null
  state.maps.focusedLeg = null
  mapsSignature = ''
  render()
}

/**
 * Todo lo de la pestaña experimental vive en este bloque y en `routing.ts`.
 *
 * Reglas que se respetan aquí sin excepción, para que lo experimental no pueda
 * estropear lo que ya funciona:
 *
 *  - Mapa, marcadores y seguimiento de la ubicación se crean al entrar y se
 *    destruyen al salir (`closeMaps`). Fuera de la pestaña no queda nada vivo.
 *  - No se pide un solo tiempo de llegada. La fuente oficial limita por IP y su
 *    cola es para el aviso de próximo bus.
 *  - Usa su propia instancia de Leaflet, distinta de la del buscador: compartirla
 *    obligaría a que las dos pantallas se pusieran de acuerdo sobre el encuadre.
 */

let mapsMap: L.Map | null = null
let mapsLayer: L.LayerGroup | null = null
let mapsSignature = ''

/** Id del `watchPosition` en curso, o null si no se está siguiendo nada. */
let locationWatchId: number | null = null

/** Suelta el mapa, el seguimiento de ubicación y lo calculado. */
function closeMaps(): void {
  pendingLocationField = null

  // El seguimiento de la ubicación solo se suelta si no queda nadie mirándola:
  // "paradas cercanas" vive ahora en Buscar y también la usa.
  if (state.tab !== 'buscar') {
    stopWatchingLocation()
  }

  // La ficha de parada se comparte con el buscador y se dibuja fuera de la
  // pantalla actual: dejarla abierta al salir la haría aparecer en la pestaña
  // siguiente, que no es donde se abrió.
  state.search.selectedStopId = null

  if (mapsMap) {
    mapsMap.remove()
    mapsMap = null
    mapsLayer = null
    mapsSignature = ''
  }

  // La ubicación (state.geo) NO se toca: es de la app, no de esta pestaña.
  state.maps = emptyMapsState()
}

function stopWatchingLocation(): void {
  if (locationWatchId !== null) {
    try {
      navigator.geolocation?.clearWatch(locationWatchId)
    } catch {
      /* el navegador puede no tenerlo */
    }
    locationWatchId = null
  }
}

/**
 * Extremo de la ruta que está esperando a que llegue la ubicación.
 *
 * Quien toca "Mi ubicación" antes de que el sistema sepa dónde está no puede
 * quedarse mirando: se anota qué campo quería rellenar y se rellena solo en
 * cuanto hay posición. Antes había que volver a tocar el botón, sin que nada
 * dijera cuándo.
 */
let pendingLocationField: 'origin' | 'destination' | null = null

/**
 * Arranca la búsqueda de paradas cercanas, empezando por lo que puede impedirla.
 *
 * El orden importa y antes estaba al revés: se llamaba a `geolocation`, se
 * esperaba a que fallara y ENTONCES se averiguaba por qué. Con el interruptor
 * de ubicación del teléfono apagado, eso son diez segundos de "buscando tu
 * ubicación…" para acabar en un error, cuando la respuesta se sabía desde el
 * principio. Preguntar primero cuesta milisegundos y convierte una espera
 * inútil en un botón que lleva justo donde hay que ir.
 *
 * El permiso de SALBUS no se puede consultar así —quien lo saca es el propio
 * `geolocation` al pedirlo—, así que ese sigue resolviéndose por el camino de
 * siempre: se intenta, y si lo deniegan se dice.
 *
 * @param force Vuelve a localizar aunque ya se sepa dónde estamos. Lo usan el
 *   botón "Actualizar" de la lista y el de "ya está activada".
 */
async function startNearbySearch(force = false): Promise<void> {
  const geo = state.geo

  if (geo.checkingService || geo.locating) {
    return
  }

  // Ya se sabe dónde estamos: la lista se dibuja con lo que hay y no se gasta
  // ni una comprobación.
  if (geo.location && !force) {
    return
  }

  // Fuera de Android no hay interruptor de sistema que consultar: el navegador
  // gestiona permiso y disponibilidad de una sola vez.
  if (!isNative()) {
    locateMe()
    return
  }

  geo.checkingService = true
  render()

  try {
    const { enabled } = await DeviceSettings.isLocationEnabled()

    if (!enabled) {
      geo.checkingService = false
      geo.locating = false
      geo.blocked = 'service'
      geo.error =
        'La ubicación del teléfono está apagada. Es un interruptor del sistema, no de SALBUS: hasta que se encienda no hay forma de saber qué paradas tienes al lado.'
      log('warn', 'ubicación', 'El servicio de ubicación del sistema está desactivado.')
      render()
      return
    }

    geo.checkingService = false
    geo.blocked = null
    geo.error = null
    locateMe()
  } catch {
    // No poder preguntarlo no es lo mismo que estar apagado: se intenta
    // localizar y, si falla, el diagnóstico de siempre dirá por qué.
    geo.checkingService = false
    locateMe()
  }
}

/**
 * ¿Se ha encendido la ubicación mientras estábamos fuera de la app?
 *
 * Es la otra mitad de `startNearbySearch`: quien toca "activar la ubicación" se
 * va a los ajustes del sistema, la enciende y vuelve. Sin esto volvía a la misma
 * pantalla de aviso y tenía que tocar otro botón para pedir lo que ya había
 * pedido dos veces. Se comprueba solo cuando hay algo esperando —la pestaña
 * Buscar en modo "Cerca", bloqueada por el servicio—, no en cada regreso.
 */
async function retryNearbyIfServiceBack(): Promise<void> {
  if (state.tab !== 'buscar' || state.search.mode !== 'cerca' || state.geo.blocked !== 'service') {
    return
  }

  await startNearbySearch(true)
}

/**
 * Pide la ubicación.
 *
 * En Android es Capacitor quien saca el diálogo del permiso en cuanto la página
 * llama a `geolocation`; por eso no hace falta plugin propio, solo declarar los
 * permisos en el manifiesto.
 *
 * Se piden LAS DOS cosas: una lectura suelta, que llega enseguida (vale incluso
 * una cacheada), y un seguimiento que la va afinando. Solo con el seguimiento la
 * primera posición puede tardar o no llegar nunca según el sistema, y la
 * pantalla se quedaba en "Buscando tu ubicación…"; solo con la lectura suelta,
 * las "paradas más cercanas" salían de un barrio de al lado, porque el primer
 * dato suele traer cientos de metros de error.
 */
function locateMe(): void {
  if (!navigator.geolocation) {
    state.geo.error = 'Este dispositivo no permite compartir la ubicación.'
    state.geo.locating = false
    render()
    return
  }

  state.geo.locating = true
  state.geo.error = null
  render()

  stopWatchingLocation()

  try {
    navigator.geolocation.getCurrentPosition(acceptPosition, rejectPosition, {
      enableHighAccuracy: false,
      timeout: 10_000,
      maximumAge: 60_000,
    })

    locationWatchId = navigator.geolocation.watchPosition(acceptPosition, rejectPosition, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 15_000,
    })
  } catch (error) {
    state.geo.locating = false
    state.geo.error = errorMessage(error)
    render()
  }
}

/**
 * Una lectura de posición.
 *
 * Una posición peor NO pisa a una mejor: la lectura rápida y el seguimiento
 * llegan mezclados, y dejar que una cacheada de 500 m sustituyera a una recién
 * afinada de 20 m movía las paradas cercanas hacia atrás delante de tus ojos.
 */
function acceptPosition(position: GeolocationPosition): void {
  // Se puede haber salido de las dos pantallas que la usan mientras llegaba.
  if (state.tab !== 'info' && state.tab !== 'buscar') {
    stopWatchingLocation()
    return
  }

  const point: GeoPoint = {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
  }

  if (!isValidPoint(point)) {
    return
  }

  const accuracy = position.coords.accuracy ?? Number.NaN
  const known = state.geo.location
  const better = !known
    || !Number.isFinite(known.accuracy)
    || !Number.isFinite(accuracy)
    || accuracy <= known.accuracy
    // Una lectura vieja deja de mandar aunque fuera más precisa: te has movido.
    || Date.now() - known.at > 20_000

  state.geo.locating = false
  state.geo.error = null
  state.geo.blocked = null

  if (!better) {
    render()
    return
  }

  state.geo.location = { point, accuracy, at: Date.now() }
  // Las dos firmas caducan: el mapa de rutas dibuja "estás aquí", y el del
  // buscador centra ahí cuando se pide.
  mapsSignature = ''
  mapPaintKey = ''

  // Alguien está esperando esta posición para rellenar un extremo de la ruta.
  if (pendingLocationField && state.maps.picking === pendingLocationField) {
    const here = currentLocationPoint()
    pendingLocationField = null
    if (here) {
      applyRoutePoint(here)
      return
    }
  }

  render()
}

function rejectPosition(error: GeolocationPositionError): void {
  pendingLocationField = null
  state.geo.locating = false

  // Un fallo de la lectura rápida no puede borrar una posición que ya se tenía;
  // el seguimiento puede seguir dando buenas lecturas después.
  if (!state.geo.location) {
    state.geo.error = describeGeolocationError(error)
    log('warn', 'ubicación', state.geo.error)
    void diagnoseLocationBlock(error)
  }

  if (error.code === error.PERMISSION_DENIED) {
    stopWatchingLocation()
  }

  render()
}

/**
 * Averigua QUE falta para poder localizar y deja preparado el botón que lleva
 * hasta allí.
 *
 * Sin esto, un teléfono con la ubicación apagada enseñaba "el sistema no ha
 * podido calcular dónde estás" y quien lo leía se quedaba mirando: el mensaje
 * era cierto y no servía para nada, porque el interruptor que hay que tocar no
 * está en la app. Se pregunta al sistema en vez de suponerlo, porque un GPS que
 * tarda bajo techo da exactamente el mismo error que uno apagado.
 */
async function diagnoseLocationBlock(error: GeolocationPositionError): Promise<void> {
  if (error.code === error.PERMISSION_DENIED) {
    state.geo.blocked = 'permission'
    render()
    return
  }

  if (!isNative()) {
    state.geo.blocked = null
    return
  }

  try {
    const { enabled } = await DeviceSettings.isLocationEnabled()
    state.geo.blocked = enabled ? null : 'service'

    if (!enabled) {
      state.geo.error =
        'La ubicación del teléfono está apagada. SALBUS no puede saber dónde estás hasta que la enciendas.'
      log('warn', 'ubicación', 'El servicio de ubicación del sistema está desactivado.')
    }
  } catch {
    // No poder preguntarlo no es lo mismo que estar apagado.
    state.geo.blocked = null
  }

  render()
}

function describeGeolocationError(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'Has denegado el permiso de ubicación. Se concede desde los ajustes del sistema, en los permisos de SALBUS.'
    case error.POSITION_UNAVAILABLE:
      return 'El sistema no ha podido calcular dónde estás. Bajo techo suele tardar más; prueba a salir a la calle.'
    case error.TIMEOUT:
      return 'La ubicación ha tardado demasiado en llegar.'
    default:
      return 'No se ha podido obtener la ubicación.'
  }
}

/** El punto que representa "yo", ya sea como origen o como destino. */
function currentLocationPoint(): RoutePoint | null {
  const location = state.geo.location
  if (!location) {
    return null
  }

  return {
    kind: 'location',
    label: 'Mi ubicación',
    lat: location.point.lat,
    lon: location.point.lon,
  }
}

/**
 * Calcula la ruta.
 *
 * La espera en parada sale del horario programado cuando lo hay: es donde más
 * se equivoca una estimación a ojo. Si el GTFS no cubre esa línea se usa un
 * valor fijo, que es peor pero honesto.
 */
function planMapsRoute(): void {
  const { origin, destination } = state.maps
  const network = state.network

  if (!origin || !destination || !network) {
    return
  }

  state.maps.planning = true
  state.maps.focusedLeg = null
  render()

  try {
    const directions = network.lines.flatMap((line) => line.directions)
    const dayType = currentDayType()
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes()
    const waitCache = new Map<string, number>()

    const plan = planRoute({
      origin: { lat: origin.lat, lon: origin.lon },
      destination: { lat: destination.lat, lon: destination.lon },
      originName: origin.label,
      destinationName: destination.label,
      directions,
      waitMinutes: (stopId, lineId, directionKey) => {
        const key = `${stopId}|${directionKey}`
        const cached = waitCache.get(key)
        if (cached !== undefined) {
          return cached
        }

        const wait = estimateWait(stopId, lineId, directionKey, dayType, nowMinutes)
        waitCache.set(key, wait)
        return wait
      },
    })

    // Los tramos a pie se vuelven a medir por el callejero. Ahí es donde estaba
    // el error grande: en línea recta, un paseo que rodea una manzana o cruza al
    // otro lado del río se contaba como si se pudiera atravesar.
    state.maps.plan = refinePlanOnStreets(plan)
    mapsSignature = ''
    // El itinerario aparece por debajo del formulario, fuera de la pantalla: sin
    // llevar la vista hasta él, calcular una ruta parecía no hacer nada.
    scrollPending = 'ruta-resultado'

    if (plan.status === 'ok') {
      log(
        'info',
        'mapas',
        `Ruta calculada: ${Math.round(plan.best.totalMinutes)} min, ${plan.best.transfers} transbordo(s).`,
      )
    }
  } catch (error) {
    state.maps.plan = { status: 'unreachable', reason: errorMessage(error) }
    log('error', 'mapas', errorMessage(error))
  } finally {
    state.maps.planning = false
    render()
  }
}

/**
 * Vuelve a medir a pie lo que se anda, y reordena con el resultado.
 *
 * El cálculo de la ruta usa distancias en línea recta porque evalúa cientos de
 * paseos y hacerlo sobre el callejero congelaría la pantalla. Pero la recta se
 * queda corta SIEMPRE, así que una ruta podía ganar por medio minuto gracias a
 * un paseo que en realidad cruzaba una manzana entera. Aquí se miden de verdad
 * los dos o tres tramos del itinerario ya elegido y se vuelve a ordenar: si la
 * alternativa pasa a ser mejor, es la alternativa la que se recomienda.
 *
 * Sin callejero cargado esto no hace nada y la ruta sigue siendo la de antes.
 */
function refinePlanOnStreets(plan: PlanOutcome): PlanOutcome {
  const graph = peekStreetGraph()

  if (!graph) {
    // Aún no está en memoria: se pide para la próxima ruta. La primera consulta
    // de la sesión sale con la estimación en línea recta, que es exactamente el
    // comportamiento de siempre; a partir de la segunda, afinada.
    void loadStreetGraph().then((loaded) => {
      if (loaded) {
        log('info', 'mapas', 'Callejero peatonal cargado; los paseos ya se miden por las calles.')
      }
    })
    return plan
  }

  const resolve = (from: GeoPoint, to: GeoPoint) => walkPath(graph, from, to)

  if (plan.status === 'walk') {
    return { status: 'walk', walking: refineWalking(plan.walking, resolve) }
  }

  if (plan.status !== 'ok') {
    return plan
  }

  const refined = [plan.best, ...plan.alternatives]
    .map((itinerary) => refineWalking(itinerary, resolve))
    .sort((left, right) => left.totalMinutes - right.totalMinutes)

  const [best, ...alternatives] = refined as [Itinerary, ...Itinerary[]]
  return { status: 'ok', best, alternatives }
}

/**
 * Minutos de espera estimados en una parada.
 *
 * Se calcula la frecuencia real de esa línea en esa parada (la mediana de los
 * huecos entre salidas programadas) y se supone que se llega a la mitad del
 * hueco, que es lo que ocurre cuando no se mira el horario. Usar "la próxima
 * salida a las 08:12" sería más preciso, pero el GTFS incluido caduca y esa
 * hora exacta acabaría siendo mentira; una frecuencia envejece mucho mejor.
 */
function estimateWait(
  stopId: string,
  lineId: string,
  directionKey: string,
  dayType: ReturnType<typeof currentDayType>,
  nowMinutes: number,
): number {
  const schedule = state.schedule
  if (!schedule) {
    return DEFAULT_WAIT_MINUTES
  }

  let times: string[]
  try {
    times = schedule.getScheduledTimes(stopId, lineId, dayType, directionKey)
  } catch {
    return DEFAULT_WAIT_MINUTES
  }

  // Solo la franja de alrededor: a las ocho de la mañana no importa la
  // frecuencia de las tres de la tarde.
  const window = times
    .map((clock) => parseClockToMinutes(clock))
    .filter((minutes) => Math.abs(minutes - nowMinutes) <= 90)
    .sort((left, right) => left - right)

  if (window.length < 2) {
    return DEFAULT_WAIT_MINUTES
  }

  const gaps: number[] = []
  for (let index = 1; index < window.length; index += 1) {
    gaps.push(window[index] - window[index - 1])
  }

  gaps.sort((left, right) => left - right)
  const headway = gaps[Math.floor(gaps.length / 2)]

  // Una frecuencia absurda (un solo paso al día, o datos rotos) no puede
  // convertirse en una espera de hora y media dentro del cálculo.
  return Math.min(DEFAULT_WAIT_MINUTES * 3, Math.max(1, headway / 2))
}

/**
 * Dibuja el mapa de la pestaña.
 *
 * Igual que el del buscador, se repinta solo cuando cambia algo de verdad: la
 * firma evita rehacer marcadores y encuadre en cada latido del reloj.
 */
function syncMapsMap(): void {
  const container = document.querySelector<HTMLDivElement>('#maps-map')

  if (!container || !state.network || state.tab !== 'info' || state.info.section !== 'llegar') {
    if (mapsMap) {
      mapsMap.remove()
      mapsMap = null
      mapsLayer = null
      mapsSignature = ''
    }
    return
  }

  if (!mapsMap || mapsMap.getContainer() !== container) {
    mapsMap?.remove()
    mapsMap = L.map(container, { zoomControl: false, attributionControl: true })
    L.control.zoom({ position: 'bottomleft' }).addTo(mapsMap)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(mapsMap)
    mapsLayer = L.layerGroup().addTo(mapsMap)
    mapsSignature = ''
  }

  const maps = state.maps
  const location = state.geo.location
  const signature = [
    location ? `${location.point.lat.toFixed(5)},${location.point.lon.toFixed(5)}` : '',
    maps.origin ? `${maps.origin.lat},${maps.origin.lon}` : '',
    maps.destination ? `${maps.destination.lat},${maps.destination.lon}` : '',
    maps.plan?.status ?? '',
    maps.focusedLeg ?? '',
    maps.expanded ? 'full' : 'inline',
  ].join('|')

  if (signature === mapsSignature) {
    mapsMap.invalidateSize()
    return
  }

  mapsSignature = signature
  mapsLayer?.clearLayers()
  mapsMap.invalidateSize()

  const bounds: Array<[number, number]> = []
  paintRoute(bounds)

  if (bounds.length === 1) {
    mapsMap.setView(bounds[0], 16)
  } else if (bounds.length > 1) {
    mapsMap.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 })
  } else {
    // Sin nada que enseñar, el centro de Salamanca es mejor que el Atlántico.
    mapsMap.setView([40.9701, -5.6635], 13)
  }

  // El contenedor puede seguir cambiando de tamaño cuando se pinta; sin esta
  // segunda pasada el encuadre queda calculado sobre el tamaño anterior.
  window.setTimeout(() => {
    if (!mapsMap || state.tab !== 'info') {
      return
    }
    mapsMap.invalidateSize()
    if (bounds.length > 1) {
      mapsMap.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 })
    }
  }, 80)
}

/**
 * "Estás aquí": punto azul con su margen de error.
 *
 * Lo comparten los dos mapas —el del buscador y el de rutas—, porque es el
 * mismo dato y el mismo dibujo. Enseñar un punto exacto cuando el GPS dice "en
 * algún sitio de estos 300 m" sería mentir con precisión, así que el círculo va
 * siempre que el margen dé para notarse.
 */
function paintYouAreHere(layer: L.LayerGroup, bounds: Array<[number, number]>): boolean {
  const location = state.geo.location
  if (!location) {
    return false
  }

  const here: [number, number] = [location.point.lat, location.point.lon]
  bounds.push(here)

  if (Number.isFinite(location.accuracy) && location.accuracy > 25) {
    L.circle(here, {
      radius: location.accuracy,
      color: '#1f6feb',
      weight: 1,
      opacity: 0.5,
      fillOpacity: 0.08,
    }).addTo(layer)
  }

  L.marker(here, {
    icon: L.divIcon({
      className: '',
      html: '<span class="map-me"><span class="map-me-dot"></span></span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    }),
    keyboard: false,
    zIndexOffset: 1200,
  }).addTo(layer)

  return true
}

function paintRoute(bounds: Array<[number, number]>): void {
  const maps = state.maps
  if (!mapsLayer) {
    return
  }

  // Sin origen ni destino puestos, lo único que hay que situar es a ti.
  if (!maps.origin && !maps.destination) {
    paintYouAreHere(mapsLayer, bounds)
  }

  for (const [point, kind] of [
    [maps.origin, 'origin'],
    [maps.destination, 'destination'],
  ] as Array<[RoutePoint | null, 'origin' | 'destination']>) {
    if (!point) {
      continue
    }

    bounds.push([point.lat, point.lon])
    L.marker([point.lat, point.lon], {
      icon: L.divIcon({
        className: '',
        html: `<span class="map-end is-${kind}"></span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
      keyboard: false,
      zIndexOffset: 900,
    }).addTo(mapsLayer)
  }

  const plan = maps.plan
  if (!plan || plan.status === 'unreachable') {
    return
  }

  const itinerary = plan.status === 'walk' ? plan.walking : plan.best

  itinerary.legs.forEach((leg, index) => {
    const dimmed = maps.focusedLeg !== null && maps.focusedLeg !== index

    if (leg.kind === 'walk') {
      // Con el callejero cargado el tramo se dibuja por las calles por las que
      // de verdad se anda. La recta de antes no solo medía de menos: enseñaba
      // una línea que atravesaba manzanas, y eso no se puede seguir.
      const points: Array<[number, number]> = (leg.path ?? [leg.from, leg.to]).map(
        (point) => [point.lat, point.lon] as [number, number],
      )
      // Al encuadre solo van los extremos: con el recorrido entero, una curva
      // larga tiraba del mapa hacia atrás sin añadir nada.
      bounds.push([leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon])

      L.polyline(points, {
        color: '#6b7a90',
        weight: 4,
        opacity: dimmed ? 0.25 : 0.85,
        dashArray: '2 8',
        lineCap: 'round',
      }).addTo(mapsLayer as L.LayerGroup)
      return
    }

    const color = state.network?.getLineColor(leg.lineId) ?? '#173764'
    const points = leg.stops
      .filter((stop) => isValidPoint(stop))
      .map((stop) => [stop.lat, stop.lon] as [number, number])

    points.forEach((point) => bounds.push(point))

    L.polyline(points, {
      color,
      weight: dimmed ? 4 : 6,
      opacity: dimmed ? 0.25 : 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(mapsLayer as L.LayerGroup)

    // Solo se marcan subida y bajada: una chincheta por parada intermedia
    // convierte el trazado en un collar ilegible.
    for (const [stop, role] of [
      [leg.from, 'board'],
      [leg.to, 'alight'],
    ] as Array<[typeof leg.from, 'board' | 'alight']>) {
      if (!isValidPoint(stop)) {
        continue
      }

      L.marker([stop.lat, stop.lon], {
        icon: L.divIcon({
          className: '',
          html: `<span class="map-stopdot is-${role}" style="--dot:${esc(color)}"></span>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
          popupAnchor: [0, -9],
        }),
        keyboard: false,
        zIndexOffset: 500,
      })
        .bindPopup(buildStopPopup(stop), { className: 'map-popup', maxWidth: 260, minWidth: 200 })
        .addTo(mapsLayer as L.LayerGroup)
    }
  })
}

/* ------------------------------------------------------------------ *
 * Utilidades                                                           *
 * ------------------------------------------------------------------ */

function showToast(message: string, tone: 'info' | 'error' | 'success'): void {
  state.toast = { message, tone }
  render()

  if (toastTimer !== null) {
    window.clearTimeout(toastTimer)
  }

  toastTimer = window.setTimeout(() => {
    state.toast = null
    toastTimer = null
    render()
  }, 3200)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
