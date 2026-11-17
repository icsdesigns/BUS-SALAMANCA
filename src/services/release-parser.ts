/**
 * Lectura de una release de GitHub. Sin dependencias a proposito, igual que
 * `arrival-parser.ts`: es la logica que decide si se ofrece una actualizacion,
 * y tiene que poder comprobarse sin navegador ni dispositivo.
 */

export interface ReleaseInfo {
  /** Etiqueta completa, p. ej. `v4.3.0-b1007`. */
  tag: string
  versionName: string
  versionCode: number
  apkUrl: string
  publishedAt: string | null
}

export interface GitHubRelease {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string
  assets?: Array<{ name?: string, browser_download_url?: string }>
}

/**
 * `v4.3.0-b1007` → { versionName: '4.3.0', versionCode: 1007 }.
 *
 * El versionCode sale de la ETIQUETA y no de un fichero adjunto porque los
 * assets de una release no se pueden leer desde JavaScript (ver el CORS en
 * `updates.ts`). La etiqueta ya viene en la respuesta de la API.
 *
 * Una etiqueta sin `-b<numero>` no sirve: sin versionCode no hay comparacion
 * posible, y ofrecer una actualizacion a ciegas es peor que no ofrecer ninguna.
 */
export function parseTag(tag: string): { versionName: string, versionCode: number } | null {
  const match = /^v?(.+)-b(\d+)$/.exec(tag.trim())
  if (!match) {
    return null
  }

  const versionCode = Number.parseInt(match[2], 10)
  return Number.isFinite(versionCode) ? { versionName: match[1], versionCode } : null
}

export function readRelease(payload: GitHubRelease | null | undefined): ReleaseInfo | null {
  if (!payload?.tag_name || payload.draft) {
    return null
  }

  const parsed = parseTag(payload.tag_name)
  if (!parsed) {
    return null
  }

  const apk = (payload.assets ?? []).find((asset) => asset.name?.toLowerCase().endsWith('.apk'))
  if (!apk?.browser_download_url) {
    return null
  }

  return {
    tag: payload.tag_name,
    versionName: parsed.versionName,
    versionCode: parsed.versionCode,
    apkUrl: apk.browser_download_url,
    publishedAt: payload.published_at ?? null,
  }
}

/**
 * Decide si la release publicada es mas nueva que la instalada. Android solo
 * acepta actualizar a un versionCode estrictamente mayor, asi que la
 * comparacion es la misma que hara el sistema.
 */
export function isNewer(release: ReleaseInfo, installedVersionCode: number): boolean {
  return release.versionCode > installedVersionCode
}

/**
 * Espera desde que se publica una release hasta que se ofrece.
 *
 * Una version recien publicada no se ofrece al momento: durante las primeras
 * seis horas se trata como si no existiera ("ya tienes la ultima") y no se
 * descarga nada. Da margen para retirar o corregir una publicacion con un fallo
 * antes de que llegue a los moviles, y evita que dos publicaciones seguidas
 * obliguen a instalar dos veces en una tarde.
 */
export const RELEASE_GRACE_MS = 6 * 60 * 60 * 1000

/**
 * ¿Han pasado ya las seis horas desde que se publico?
 *
 * Sin fecha de publicacion (GitHub siempre la manda en una release publicada,
 * asi que solo puede venir de una respuesta rara) no se retiene: bloquear para
 * siempre una version por un dato ausente es peor que ofrecerla. Una fecha
 * ilegible tampoco. Una fecha en el futuro —reloj del movil atrasado— cuenta
 * como recien publicada, que es lo prudente.
 */
export function isReleaseMature(
  release: Pick<ReleaseInfo, 'publishedAt'>,
  now: number = Date.now(),
  graceMs: number = RELEASE_GRACE_MS,
): boolean {
  if (!release.publishedAt) {
    return true
  }

  const published = Date.parse(release.publishedAt)
  if (!Number.isFinite(published)) {
    return true
  }

  return now - published >= graceMs
}

/** Lo que dice la comprobacion: solo se ofrece lo mas nuevo Y ya asentado. */
export function shouldOffer(
  release: ReleaseInfo,
  installedVersionCode: number,
  now: number = Date.now(),
): boolean {
  return isNewer(release, installedVersionCode) && isReleaseMature(release, now)
}

/**
 * Actualizacion obligatoria: cuando la instalada lleva DIEZ DIAS sin ponerse al
 * dia, la ventana de actualizar deja de poder cerrarse.
 *
 * Los diez dias cuentan desde la primera release publicada que la instalada no
 * tiene, no desde la ultima: si salen dos versiones seguidas, quien se quedo en
 * la anterior a ambas no vuelve a empezar la cuenta con cada publicacion.
 */
export const MANDATORY_AFTER_MS = 10 * 24 * 60 * 60 * 1000

/**
 * Fecha de publicacion (ms) de la release mas antigua que la instalada aun no
 * tiene, entre las de la lista. Ignora borradores, prereleases, etiquetas que no
 * se entienden y fechas ilegibles. `null` si no hay ninguna pendiente con fecha.
 */
export function pendingSince(
  releases: readonly GitHubRelease[],
  installedVersionCode: number,
): number | null {
  let oldest: number | null = null

  for (const release of releases) {
    if (!release.tag_name || release.draft || release.prerelease || !release.published_at) {
      continue
    }
    const parsed = parseTag(release.tag_name)
    if (!parsed || parsed.versionCode <= installedVersionCode) {
      continue
    }
    const published = Date.parse(release.published_at)
    if (!Number.isFinite(published)) {
      continue
    }
    if (oldest === null || published < oldest) {
      oldest = published
    }
  }

  return oldest
}

/**
 * ¿Ha pasado el plazo? Una fecha en el futuro (reloj del movil atrasado) nunca
 * obliga: ante la duda, no se bloquea la app.
 */
export function isUpdateMandatory(
  since: number | null,
  now: number = Date.now(),
  limitMs: number = MANDATORY_AFTER_MS,
): boolean {
  return since !== null && now - since >= limitMs
}
