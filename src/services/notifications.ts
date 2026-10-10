import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

import type { PermissionState } from '../state'

/**
 * Notificaciones locales.
 *
 * El aviso de "proximo bus" es una notificacion PERSISTENTE (`ongoing`) que se
 * reescribe con el mismo id cada vez que llegan datos nuevos: Android sustituye el
 * contenido en el sitio, sin apilar avisos ni volver a sonar.
 *
 * El icono pequeno de la barra de estado debe ser una silueta monocroma con fondo
 * transparente (`res/drawable/ic_stat_salbus.xml`); Android descarta el color y
 * pinta solo el canal alfa, por lo que un icono con fondo se veria como un cuadro.
 */

const CHANNEL_ID = 'salbus-seguimiento'
const SMALL_ICON = 'ic_stat_salbus'

/**
 * Cuanto vive la notificacion de "aviso completado": pasados 30 minutos ya no dice
 * nada util (el autobus pasó hace rato) y solo ensucia la barra. El servicio
 * nativo hace lo mismo con su propia notificacion (`setTimeoutAfter`); esta es la
 * de la web, la que sale cuando no hay servicio.
 */
export const COMPLETED_ALERT_TTL_MS = 30 * 60 * 1000

/** Donde se apuntan las notificaciones completadas, para limpiarlas tras cerrar la app. */
const COMPLETED_ALERTS_KEY = 'salbus.completedAlerts'

let channelReady = false

export function isNative(): boolean {
  return Capacitor.isNativePlatform()
}

export async function ensureNotificationPermission(): Promise<PermissionState> {
  if (!isNative()) {
    return 'unknown'
  }

  try {
    let status = await LocalNotifications.checkPermissions()
    if (status.display !== 'granted') {
      status = await LocalNotifications.requestPermissions()
    }

    if (status.display === 'granted') {
      await ensureChannel()
      return 'granted'
    }

    return status.display === 'denied' ? 'denied' : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function ensureChannel(): Promise<void> {
  if (channelReady || Capacitor.getPlatform() !== 'android') {
    return
  }

  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Seguimiento de autobus',
      description: 'Aviso persistente con los minutos que faltan para tu autobus.',
      // IMPORTANCE_LOW: visible y actualizable, pero sin sonido en cada refresco.
      importance: 2,
      visibility: 1,
      sound: undefined,
      vibration: false,
    })
    channelReady = true
  } catch {
    /* el canal ya existe o el plugin no lo soporta */
  }
}

export interface TrackingNotification {
  id: number
  lineId: string
  destination: string
  minutes: number | null
  arriving: boolean
  updatedAt: Date
  stale: boolean
  /**
   * Por donde viene, ya redactado ("a 3 paradas", "en tu parada").
   *
   * Cadena vacia cuando no consta, y entonces no se escribe nada: la fuente no
   * publica posiciones, asi que "por donde viene" es una deduccion que unas
   * veces sale y otras no. Un hueco en blanco o un "—" harian pensar que la
   * app se ha quedado colgada.
   */
  stopsAway?: string
}

export async function showTrackingNotification(payload: TrackingNotification): Promise<void> {
  if (!isNative()) {
    return
  }

  await ensureChannel()

  const eta = payload.arriving
    ? 'Llegando a la parada'
    : payload.minutes === null
      ? 'Sin estimacion ahora mismo'
      : payload.minutes <= 0
        ? 'Llegando'
        : `En ${payload.minutes} min`

  const suffix = payload.stale ? ' · dato no confirmado' : ''
  // A continuacion del tiempo, en el titulo: los minutos dicen cuando llega y
  // las paradas dicen si ese numero se puede creer. Un "en 2 min · a 5 paradas"
  // avisa de que el contador va a dar un salto.
  const where = payload.stopsAway ? ` · ${payload.stopsAway}` : ''
  const clock = payload.updatedAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })

  // Cuatro datos y ninguno repetido: linea y tiempo en el titulo, direccion y
  // hora de la ultima actualizacion en el cuerpo. El nombre de la parada sobra,
  // porque ya se eligio al crear el aviso.
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: payload.id,
          title: `Línea ${payload.lineId} · ${eta}${where}`,
          body: `${payload.destination}\nActualizado a las ${clock}${suffix}`,
          channelId: CHANNEL_ID,
          smallIcon: SMALL_ICON,
          ongoing: true,
          autoCancel: false,
          silent: true,
        },
      ],
    })
  } catch {
    /* la notificacion es un extra: nunca debe romper el ciclo de refresco */
  }
}

/** Lo necesario para volver a crear un aviso desde el boton "Siguiente bus". */
export interface NextBusTarget {
  stopId: string
  lineId: string
  directionKey: string | null
}

const NEXT_BUS_TYPE = 'salbus-next-bus'
const NEXT_BUS_ACTION = 'next-bus'

let nextBusTypeReady = false

/**
 * Registra el boton "Siguiente bus" de la notificacion final.
 *
 * Es el de la notificacion que publica la web cuando no hay servicio nativo;
 * el servicio pone el suyo en su propia notificacion.
 */
async function ensureNextBusType(): Promise<void> {
  if (nextBusTypeReady) {
    return
  }

  try {
    await LocalNotifications.registerActionTypes({
      types: [{ id: NEXT_BUS_TYPE, actions: [{ id: NEXT_BUS_ACTION, title: 'Siguiente bus' }] }],
    })
    nextBusTypeReady = true
  } catch {
    /* sin boton, el aviso completado sigue saliendo igual */
  }
}

/** Avisa cuando se pulsa "Siguiente bus" en una notificacion publicada desde la web. */
export async function onNextBusAction(handler: (target: NextBusTarget) => void): Promise<void> {
  if (!isNative()) {
    return
  }

  try {
    await LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
      const target = event.notification?.extra?.nextBus as NextBusTarget | undefined
      if (event.actionId === NEXT_BUS_ACTION && target?.stopId && target.lineId) {
        void LocalNotifications.cancel({ notifications: [{ id: event.notification.id }] }).catch(() => {})
        handler(target)
      }
    })
  } catch {
    /* ignorado a proposito */
  }
}

/**
 * Aviso puntual de que un autobus ya ha pasado.
 *
 * Se reutiliza siempre el mismo `id` a lo largo de un seguimiento para que cada
 * paso sustituya al anterior en lugar de apilar avisos sueltos.
 *
 * @param nextBus Solo en el aviso completado: pone el boton "Siguiente bus",
 *     que vuelve a crear el aviso que acaba de borrarse.
 */
export async function showArrivalAlert(
  id: number,
  lineId: string,
  stopName: string,
  progress?: { seen: number, target: number },
  nextBus?: NextBusTarget,
): Promise<void> {
  if (!isNative()) {
    return
  }

  await ensureChannel()
  if (nextBus) {
    await ensureNextBusType()
  }

  const done = progress ? progress.seen >= progress.target : true

  const title = done
    ? `Línea ${lineId} · aviso completado`
    : `Línea ${lineId} · autobús ${progress?.seen} de ${progress?.target}`

  const body = done
    ? progress && progress.target > 1
      ? `Han pasado ${progress.target} autobuses por ${stopName}.`
      : `Tu autobús ha pasado por ${stopName}.`
    : `Ha pasado por ${stopName}. Seguimos con el siguiente.`

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title,
          body,
          channelId: CHANNEL_ID,
          smallIcon: SMALL_ICON,
          ongoing: false,
          autoCancel: true,
          ...(nextBus && nextBusTypeReady
            ? { actionTypeId: NEXT_BUS_TYPE, extra: { nextBus } }
            : {}),
        },
      ],
    })

    if (done) {
      rememberCompletedAlert(id)
    } else {
      // El mismo id lo reutiliza el aviso de paso de un seguimiento nuevo: la
      // caducidad del completado anterior ya no debe borrarlo.
      forgetCompletedAlert(id)
    }
  } catch {
    /* ignorado a proposito */
  }
}

/* ------------------------------------------------------------------ *
 * Avisos completados: caducan a los 30 minutos                        *
 * ------------------------------------------------------------------ */

interface CompletedAlert {
  notificationId: number
  at: number
}

/** Temporizadores de esta sesion, por id de notificacion (uno por aviso, no se apilan). */
const completedAlertTimers = new Map<number, number>()

function readCompletedAlerts(): CompletedAlert[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COMPLETED_ALERTS_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is CompletedAlert =>
            typeof item?.notificationId === 'number' && typeof item?.at === 'number',
        )
      : []
  } catch {
    return []
  }
}

function writeCompletedAlerts(alerts: CompletedAlert[]): void {
  try {
    window.localStorage.setItem(COMPLETED_ALERTS_KEY, JSON.stringify(alerts))
  } catch {
    /* almacenamiento bloqueado: la limpieza se queda en el temporizador */
  }
}

/** Apunta el aviso completado y programa su retirada a los 30 minutos. */
function rememberCompletedAlert(id: number): void {
  const at = Date.now()
  // El mismo id se reutiliza: el aviso nuevo sustituye al anterior y reinicia los 30 minutos.
  writeCompletedAlerts([...readCompletedAlerts().filter((item) => item.notificationId !== id), { notificationId: id, at }])
  scheduleCompletedAlertExpiry(id, COMPLETED_ALERT_TTL_MS)
}

function forgetCompletedAlert(id: number): void {
  const timer = completedAlertTimers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    completedAlertTimers.delete(id)
  }

  const alerts = readCompletedAlerts()
  if (alerts.some((item) => item.notificationId === id)) {
    writeCompletedAlerts(alerts.filter((item) => item.notificationId !== id))
  }
}

function scheduleCompletedAlertExpiry(id: number, delayMs: number): void {
  const previous = completedAlertTimers.get(id)
  if (previous !== undefined) {
    window.clearTimeout(previous)
  }

  completedAlertTimers.set(
    id,
    window.setTimeout(() => {
      completedAlertTimers.delete(id)
      void purgeCompletedAlerts()
    }, Math.max(0, delayMs)),
  )
}

/**
 * Retira las notificaciones de aviso completado que ya tienen 30 minutos o mas y
 * las borra de la lista. Se llama al arrancar y al volver a primer plano: con la
 * app cerrada el temporizador no corre, y esta es la ocasion de ponerse al dia.
 * Las que aun no caducan reprograman su temporizador por lo que les queda.
 */
export async function purgeCompletedAlerts(): Promise<void> {
  const now = Date.now()
  const alerts = readCompletedAlerts()
  if (alerts.length === 0) {
    return
  }

  const expired = alerts.filter((item) => now - item.at >= COMPLETED_ALERT_TTL_MS)
  const alive = alerts.filter((item) => now - item.at < COMPLETED_ALERT_TTL_MS)

  // La lista se corrige antes de cancelar: si dos llamadas se solapan, la
  // segunda ya no vuelve a cancelar lo mismo.
  writeCompletedAlerts(alive)

  for (const item of alive) {
    if (!completedAlertTimers.has(item.notificationId)) {
      scheduleCompletedAlertExpiry(item.notificationId, COMPLETED_ALERT_TTL_MS - (now - item.at))
    }
  }

  for (const item of expired) {
    const timer = completedAlertTimers.get(item.notificationId)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      completedAlertTimers.delete(item.notificationId)
    }
    await cancelNotification(item.notificationId)
  }
}

/**
 * Notificacion persistente de "estoy midiendo la puntualidad".
 *
 * No es un adorno: durante una franja de control la app tiene que seguir
 * consultando la parada cada pocos segundos, y Android congela los
 * temporizadores de una pagina que nadie mira. Una notificacion `ongoing` es lo
 * que declara al sistema que hay trabajo en curso —y, sobre todo, es lo unico
 * que le dice a quien lleva el movil por que la app sigue despierta—. El
 * servicio nativo publica la suya cuando esta al mando; esta es la de cuando no
 * lo esta (navegador, o el control se quedo fuera de los que admite).
 */
export async function showOngoingNotification(
  id: number,
  title: string,
  body: string,
): Promise<void> {
  if (!isNative()) {
    return
  }

  await ensureChannel()

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title,
          body,
          channelId: CHANNEL_ID,
          smallIcon: SMALL_ICON,
          ongoing: true,
          autoCancel: false,
          silent: true,
        },
      ],
    })
  } catch {
    /* la notificacion es un extra: nunca debe romper el ciclo de refresco */
  }
}

export async function cancelNotification(id: number): Promise<void> {
  if (!isNative()) {
    return
  }

  try {
    await LocalNotifications.cancel({ notifications: [{ id }] })
  } catch {
    /* ignorado a proposito */
  }
}

/** Id numerico estable a partir de una clave de texto. */
export function notificationId(key: string): number {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0
  }
  return Math.abs(hash % 2_000_000) + 1000
}
