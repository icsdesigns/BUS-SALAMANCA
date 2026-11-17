import { Capacitor, registerPlugin } from '@capacitor/core'

import {
  isNewer,
  isReleaseMature,
  isUpdateMandatory,
  pendingSince,
  readRelease,
  type GitHubRelease,
  type ReleaseInfo,
} from './release-parser'

export {
  isNewer,
  isReleaseMature,
  isUpdateMandatory,
  MANDATORY_AFTER_MS,
  parseTag,
  pendingSince,
  readRelease,
  RELEASE_GRACE_MS,
} from './release-parser'
export type { ReleaseInfo } from './release-parser'

/**
 * Canal de actualizacion contra las releases de GitHub.
 *
 * LA TRAMPA DEL CORS. La app corre en una WebView cuyo origen es localhost, asi
 * que todo `fetch` esta sujeto a CORS:
 *
 *   - api.github.com SI manda Access-Control-Allow-Origin: *
 *   - la URL de descarga de un asset NO (redirige a release-assets.githubusercontent.com)
 *
 * Es decir: la API se consulta desde aqui, pero el asset no se puede leer desde
 * JavaScript. Por eso el versionCode publicado sale de la ETIQUETA de la
 * release, que ya viene en la respuesta de la API, y no de un latest.json que
 * habria que descargar. La APK la baja el codigo nativo, que no pasa por CORS.
 */

const REPO = 'SILAB3D/BUS-SALAMANCA'
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`
/** Las ultimas publicaciones, para saber desde cuando esta pendiente la instalada. */
const RELEASE_LIST_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`

/** Sin cobertura, la consulta se queda colgada y el arranque no debe esperarla. */
const CHECK_TIMEOUT_MS = 12_000

/** Version de la app: la instalada, o la del archivo que espera para instalarse. */
export interface VersionInfo {
  versionName: string
  versionCode: number
}

export interface UpdaterPlugin {
  canInstall(): Promise<{ granted: boolean }>
  openInstallSettings(): Promise<void>
  /** Lo que dice el sistema que hay instalado, no lo que crea el bundle web. */
  currentVersion(): Promise<VersionInfo>
  /** `versionCode` es el del APK descargado, leído del propio archivo. */
  pendingUpdate(): Promise<{ ready: boolean, path: string | null } & VersionInfo>
  /** Tira la descarga guardada cuando ya no sirve. */
  clearPending(): Promise<void>
  download(options: { url: string }): Promise<{ path: string, bytes: number }>
  install(options: { path: string }): Promise<void>
  addListener(
    event: 'downloadProgress',
    handler: (payload: { bytes: number, total: number, percent: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

export const Updater = registerPlugin<UpdaterPlugin>('Updater')

export type CheckOutcome =
  /**
   * `mandatory`: la instalada lleva diez dias o mas sin la primera version que
   * le falta; la ventana de actualizar ya no se puede cerrar.
   */
  | { status: 'update', release: ReleaseInfo, mandatory: boolean }
  | { status: 'current', versionCode: number }
  | { status: 'unsupported' }
  | { status: 'error', message: string }

export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/**
 * Version de esta compilacion segun el bundle. Se lee de forma perezosa del
 * global que inyecta Vite para que el modulo tambien se pueda importar fuera del
 * bundle, donde ese global no existe.
 */
function bundledVersion(): VersionInfo {
  return {
    versionName: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
    versionCode: typeof __APP_VERSION_CODE__ === 'number' ? __APP_VERSION_CODE__ : 0,
  }
}

/**
 * Que version hay instalada DE VERDAD.
 *
 * En Android lo dice el sistema, no el numero incrustado en el bundle: ese
 * numero se queda congelado si la WebView sirve una copia vieja de la pagina, y
 * con el la app se ofrecia a si misma la actualizacion que acababa de instalar.
 * Tambien delata una instalacion que no llego a completarse, en vez de darla por
 * buena.
 */
export async function readInstalledVersion(): Promise<VersionInfo> {
  if (!isNativeAndroid()) {
    return bundledVersion()
  }

  try {
    const current = await Updater.currentVersion()
    // Un 0 solo puede venir de un fallo al consultar al sistema; el numero del
    // bundle es entonces la mejor aproximacion disponible.
    return current.versionCode > 0 ? current : bundledVersion()
  } catch {
    return bundledVersion()
  }
}

/**
 * Consulta la ultima release y decide si hay novedad.
 *
 * Devuelve el motivo exacto en vez de un booleano a proposito: la comprobacion
 * automatica del arranque se calla los errores para no molestar, y con un
 * booleano un fallo real (sin cobertura, 403 por limite de peticiones,
 * repositorio privado) se veria EXACTAMENTE IGUAL que «no hay novedades». La
 * comprobacion manual de Ajustes usa este mismo motivo para poder contarlo.
 */
export async function checkForUpdate(): Promise<CheckOutcome> {
  if (!isNativeAndroid()) {
    return { status: 'unsupported' }
  }

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)

  try {
    const response = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })

    if (response.status === 404) {
      // Es tambien lo que responde un repositorio privado a una peticion sin
      // credenciales, que es el fallo mas facil de dejar pasar.
      return {
        status: 'error',
        message: 'No hay ninguna publicación disponible (¿el repositorio es público?)',
      }
    }

    if (response.status === 403) {
      return { status: 'error', message: 'GitHub ha limitado las consultas; inténtalo más tarde' }
    }

    if (!response.ok) {
      return { status: 'error', message: `GitHub respondió ${response.status}` }
    }

    const release = readRelease((await response.json()) as GitHubRelease)
    if (!release) {
      return { status: 'error', message: 'La última publicación no trae ninguna APK utilizable' }
    }

    const installed = await readInstalledVersion()

    if (!isNewer(release, installed.versionCode)) {
      return { status: 'current', versionCode: installed.versionCode }
    }

    // Recien publicada: durante sus primeras seis horas no se ofrece ni se
    // descarga, se responde como si no hubiera novedad. Ver RELEASE_GRACE_MS.
    if (!isReleaseMature(release)) {
      return { status: 'current', versionCode: installed.versionCode }
    }

    return {
      status: 'update',
      release,
      mandatory: await isMandatory(release, installed.versionCode, controller.signal),
    }
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? 'La consulta ha tardado demasiado'
        : error instanceof Error
          ? error.message
          : String(error)
    return { status: 'error', message }
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * ¿Obliga ya a actualizar? Mira la lista de publicaciones para contar desde la
 * primera que le falta a la instalada (ver `pendingSince`). Si la lista no
 * llega, cuenta desde la ultima publicada, que es lo minimo seguro: nunca
 * adelanta la obligacion.
 */
async function isMandatory(
  latest: ReleaseInfo,
  installedVersionCode: number,
  signal: AbortSignal,
): Promise<boolean> {
  let since: number | null = latest.publishedAt ? Date.parse(latest.publishedAt) : null
  if (since !== null && !Number.isFinite(since)) {
    since = null
  }

  try {
    const response = await fetch(RELEASE_LIST_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal,
    })
    if (response.ok) {
      const list = (await response.json()) as unknown
      if (Array.isArray(list)) {
        since = pendingSince(list as GitHubRelease[], installedVersionCode) ?? since
      }
    }
  } catch {
    // Sin la lista se queda la fecha de la ultima publicada.
  }

  return isUpdateMandatory(since)
}
