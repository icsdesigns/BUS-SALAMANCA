/**
 * Comprobaciones automaticas de la logica pura (parser, red oficial, horario).
 * No necesita navegador ni dispositivo.
 *
 * Uso:  node tools/selftest.mjs           (usa fixtures locales)
 *       node tools/selftest.mjs --live    (ademas consulta la fuente oficial)
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/* ------------------------------------------------------------------ *
 * Fixtures sinteticos                                                  *
 * ------------------------------------------------------------------ */

/**
 * Instante de referencia de los fixtures.
 *
 * La fuente ya no da un contador de minutos sino la HORA de paso, asi que los
 * minutos dependen de cuando se consulte. Se fija aqui y se le pasa al parser
 * como `observedAt` para que las pruebas no dependan del reloj.
 */
const NOW = Date.parse('2026-09-19T12:00:00+02:00')

/** Una fila del JSON oficial, con la forma real medida el 2026-09-19. */
function siriRow(lineCode, minutesFromNow, extra = {}) {
  return {
    lineCode,
    lineName: `Línea ${lineCode}`,
    distance: extra.distance ?? `${1000 + minutesFromNow * 100} m`,
    expectedArrival: new Date(NOW + minutesFromNow * 60_000).toISOString(),
    aimedArrival: '2026-09-19T12:00:00',
    vehicleId: extra.vehicleId ?? `bus-${lineCode}-${minutesFromNow}`,
    bearing: '0',
    speed: '0',
    longitude: '-5.6544',
    latitude: '40.9776',
    directionName: extra.directionName ?? 'Origen (1) > Destino (2)',
    delay: extra.delay ?? 'PT0S',
    ...extra,
  }
}

function buildPayload(rows) {
  return JSON.stringify({ data: rows })
}

async function main() {
  // Se compilan los modulos reales de la app: las pruebas se hacen contra el
  // codigo que se ejecuta, no contra una copia paralela.
  const build = await compileSources([
    'arrival-parser.ts',
    'punctuality.ts',
    'network.ts',
    'schedule.ts',
    'release-parser.ts',
    'routing.ts',
    'streets.ts',
    'bus-position.ts',
  ])

  const { parseStopFeed } = await import(pathToUrl(path.join(build, 'arrival-parser.js')))

  section('1 · Parser de llegadas')

  {
    const body = buildPayload([siriRow('4', 4), siriRow('13', 12), siriRow('92', 28)])
    const feed = parseStopFeed('103', body, NOW)
    check('lee una parada normal', feed.status === 'ok' && feed.arrivals.length === 3)
    check(
      'asigna cada tiempo a su línea',
      feed.arrivals[0].lineId === '4' && feed.arrivals[0].minutesUntil === 4,
      JSON.stringify(feed.arrivals[0]),
    )
    check(
      'la hora de paso sale de la fuente, no de sumar minutos',
      feed.arrivals[0].estimatedClock === '12:04',
      feed.arrivals[0].estimatedClock,
    )
    check(
      'ordena por tiempo restante',
      feed.arrivals.map((item) => item.minutesUntil).join() === '4,12,28',
    )
  }

  {
    // Un autobus encima de la parada: 0 minutos y a 0 metros.
    const body = buildPayload([
      siriRow('9', 0, { distance: '0 m' }),
      siriRow('1', 1, { distance: '35 m' }),
      siriRow('4', 6),
    ])
    const feed = parseStopFeed('222', body, NOW)
    check(
      'marca los inminentes con estado "arriving"',
      feed.arrivals.filter((item) => item.status === 'arriving').length === 2,
      JSON.stringify(feed.arrivals.map((item) => [item.lineId, item.minutesUntil, item.status])),
    )
    check(
      'no marca "arriving" lo que aún tarda',
      feed.arrivals.find((item) => item.lineId === '4').status === 'scheduled',
    )
  }

  {
    /*
     * Regresion de cabecera. La fuente publica el mismo vehiculo una vez por
     * sentido: en una cabecera aparece como el que llega Y como el que sale.
     * Si las dos filas caen en el mismo minuto son la misma expedicion contada
     * dos veces y en pantalla serian dos renglones identicos; si caen en
     * minutos distintos son dos pasos de verdad y los dos interesan.
     */
    const body = buildPayload([
      siriRow('11', 0, { vehicleId: '158', distance: '0 m', directionName: 'Los Cipreses (268) > Buenos Aires (16)' }),
      siriRow('11', 0, { vehicleId: '158', distance: '0 m', directionName: 'Buenos Aires (16) > Los Cipreses (268)' }),
      siriRow('1', 1, { vehicleId: '151', distance: '0 m', directionName: 'Buenos Aires (16) > Chinchibarra (351)' }),
      siriRow('1', 9, { vehicleId: '151', distance: '20 m', directionName: 'Chinchibarra (351) > Buenos Aires (16)' }),
    ])
    const feed = parseStopFeed('16', body, NOW)
    check(
      'no repite el mismo autobús por venir en los dos sentidos',
      feed.arrivals.filter((item) => item.lineId === '11').length === 1,
      `${feed.arrivals.filter((item) => item.lineId === '11').length} filas de la línea 11`,
    )
    check(
      'conserva los dos pasos reales por una cabecera',
      feed.arrivals.filter((item) => item.lineId === '1').length === 2,
    )
    check(
      'el autobús parado en cabecera no es "llegando" si aún tarda',
      feed.arrivals.find((item) => item.lineId === '1' && item.minutesUntil === 9).status === 'scheduled',
    )
  }

  {
    const feed = parseStopFeed('212', buildPayload([]), NOW)
    check('distingue "sin servicio" de un error', feed.status === 'empty' && feed.arrivals.length === 0)
  }

  {
    const feed = parseStopFeed('1', '<html><body>Error 500</body></html>', NOW)
    check('marca como error una respuesta que no es JSON', feed.status === 'error')
  }

  {
    const feed = parseStopFeed('1', JSON.stringify({ error: "El parámetro 'stop' es obligatorio" }), NOW)
    check(
      'traslada el error que declara la API',
      feed.status === 'error' && feed.message.includes('obligatorio'),
      feed.message ?? 'null',
    )
  }

  {
    // El muro de Cloudflare es un limite de ritmo, no una avería: si se tratara
    // como error la parada quedaria en "Sin conexión" y perderia el último dato.
    const challenge =
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head>'
      + '<body><script>window._cf_chl_opt = {};</script></body></html>'
    const feed = parseStopFeed('103', challenge, NOW)
    check('el muro de verificación se trata como saturación, no como error',
      feed.status === 'throttled', feed.status)
  }

  {
    // Sin hora prevista no se puede situar el paso: la fila se descarta sin
    // romper las demas.
    const body = buildPayload([
      { lineCode: '4', expectedArrival: 'no es una fecha' },
      { lineCode: '', expectedArrival: new Date(NOW).toISOString() },
      siriRow('8', 3),
    ])
    const feed = parseStopFeed('103', body, NOW)
    check('descarta filas ilegibles sin perder el resto',
      feed.status === 'ok' && feed.arrivals.length === 1 && feed.arrivals[0].lineId === '8',
      JSON.stringify(feed.arrivals))
  }

  section('2 · Red oficial')

  const network = JSON.parse(await fs.readFile(path.join(projectRoot, 'public', 'data', 'network.json'), 'utf8'))

  check('se han descargado las 27 líneas', network.lines.length === 27, `${network.lines.length}`)
  check('todas las líneas tienen al menos un sentido', network.lines.every((line) => line.directions.length > 0))

  const bidirectional = network.lines.filter((line) => {
    const ways = new Set(line.directions.map((direction) => direction.way))
    return ways.has('ida') && ways.has('vuelta')
  })
  // 91 y 92 son circulares nocturnas y solo tienen un sentido por definición.
  check(
    'todas las líneas no circulares tienen ida y vuelta',
    bidirectional.length === network.lines.length - 2,
    `${bidirectional.length} de ${network.lines.length}`,
  )

  check(
    'ningún sentido está vacío',
    network.lines.every((line) => line.directions.every((direction) => direction.stops.length >= 2)),
  )

  check(
    'todas las paradas tienen coordenadas válidas',
    Object.values(network.stopsById).every(
      (stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon) && Math.abs(stop.lat - 40.96) < 0.3,
    ),
  )

  check(
    'origen y destino declarados en cada sentido',
    network.lines.every((line) =>
      line.directions.every((direction) => direction.origin.length > 0 && direction.destination.length > 0),
    ),
  )

  // La ida y la vuelta deben ser recorridos distintos, no el mismo repetido.
  const mirrored = network.lines.filter((line) => {
    const forward = line.directions.find((direction) => direction.way === 'ida' && !direction.partial)
    const backward = line.directions.find((direction) => direction.way === 'vuelta' && !direction.partial)
    if (!forward || !backward) {
      return true
    }
    return forward.stops[0].stopId !== backward.stops[backward.stops.length - 1].stopId
      ? false
      : true
  })
  check(
    'la vuelta termina donde empieza la ida en la mayoría de líneas',
    mirrored.length >= network.lines.length - 6,
    `${mirrored.length} de ${network.lines.length}`,
  )

  section('3 · Cobertura parada ↔ línea')

  const stopIds = Object.keys(network.stopsById)
  check('la red cubre las 349 paradas del GTFS', stopIds.length === 349, `${stopIds.length}`)
  check(
    'toda parada pertenece al menos a una línea',
    stopIds.every((stopId) => (network.linesByStopId[stopId] ?? []).length > 0),
  )

  const ambiguous = stopIds.filter((stopId) => {
    const lines = network.linesByStopId[stopId] ?? []
    return lines.some((lineId) => {
      const line = network.lines.find((item) => item.lineId === lineId)
      const through = line.directions.filter(
        (direction) => !direction.partial && direction.stops.some((stop) => stop.stopId === stopId),
      )
      return through.length > 1
    })
  })
  console.log(
    `  info paradas donde una línea pasa en ambos sentidos: ${ambiguous.length} (se muestra el nombre de la línea, no un destino inventado)`,
  )

  section('4 · Iconografía')

  const mono = await fs.readFile(path.join(projectRoot, 'public', 'icon-mono.svg'), 'utf8')
  check('el icono de notificación no tiene fondo', !/<rect[^>]*width="24"[^>]*height="24"[^>]*fill="(?!none)/.test(mono))

  const drawable = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_stat_salbus.xml'),
    'utf8',
  )
  check('existe el drawable monocromo de Android', drawable.includes('<vector') && drawable.includes('pathData'))

  const css = await fs.readFile(path.join(projectRoot, 'src', 'style.css'), 'utf8')
  const splashDuration = css.match(/animation:\s*splash-out[^;]*?([\d.]+)s\s+forwards/)
  check(
    'la animación de carga dura 1 s',
    /animation: splash-out 0\.32s ease 1s forwards/.test(css),
    splashDuration?.[0] ?? 'no encontrada',
  )

  section('5 · Puntualidad')

  const { observe, matchSlot, ARM_MINUTES } = await import(pathToUrl(path.join(build, 'punctuality.js')))

  // Un recorrido tipico: el autobus se acerca, entra y aparece el siguiente.
  const minute = 60_000
  const t0 = new Date('2026-08-18T07:30:00').getTime()

  function feedSequence(values, options = {}) {
    const step = options.stepMs ?? 30_000
    let runtime
    const passes = []

    values.forEach((minutes, index) => {
      const at = t0 + index * step
      const detection = observe(runtime, { minutes, at })
      runtime = detection.runtime
      if (detection.passAt !== null) {
        passes.push({ at: detection.passAt, reason: detection.reason })
      }
    })

    return { runtime, passes }
  }

  check(
    'se detecta el paso cuando el contador salta a la siguiente expedicion',
    feedSequence([6, 5, 3, 2, 1, 8, 7]).passes.length === 1,
  )

  check(
    'se detecta el paso en una linea frecuente (el siguiente bus ya viene a 4 min)',
    feedSequence([5, 3, 1, 4, 4, 3]).passes.length === 1,
    'la regla anterior exigia un salto hasta 6 min y no registraba nada',
  )

  check(
    'se detecta el paso cuando la linea desaparece del panel',
    feedSequence([4, 2, 1, null, null]).passes.length === 1,
  )

  check(
    'no se inventa un paso si el autobus nunca llego a acercarse',
    feedSequence([12, 10, 9, null, null]).passes.length === 0,
  )

  check(
    'el ruido de un minuto arriba o abajo no cuenta como paso',
    feedSequence([3, 2, 3, 2, 3, 2]).passes.length === 0,
  )

  check(
    'un mismo autobus no se cuenta dos veces',
    feedSequence([2, 1, null, null, null, null]).passes.length === 1,
  )

  check(
    `se arma con ${ARM_MINUTES} minutos o menos`,
    feedSequence([ARM_MINUTES]).runtime.armed === true && feedSequence([ARM_MINUTES + 1]).runtime.armed === false,
  )

  // La hora del paso sale del contador, no del instante en que se nota: si la
  // última consulta vio "1 min" y la siguiente llega dos minutos después, el
  // autobús pasó al principio de ese hueco, no al final.
  const estimated = feedSequence([5, 1, null], { stepMs: 2 * minute }).passes[0]
  check(
    'la hora del paso se estima con el contador, no con el momento de detectarlo',
    estimated.at === t0 + 3 * minute,
    `estimado ${new Date(estimated.at).toISOString()} · detectado ${new Date(t0 + 4 * minute).toISOString()}`,
  )

  check('un paso se asocia a la salida programada mas cercana', matchSlot(7 * 60 + 34, ['07:30', '07:45']).slot === '07:30')
  check('el desvio sale con signo', matchSlot(7 * 60 + 34, ['07:30']).delta === 4)
  check('un paso adelantado da desvio negativo', matchSlot(7 * 60 + 28, ['07:30']).delta === -2)
  check('sin ninguna salida cerca no se inventa emparejamiento', matchSlot(7 * 60 + 34, ['09:00']).slot === null)
  check('sin salidas programadas devuelve null', matchSlot(450, []).slot === null)

  section('6 · Horario programado por sentido')

  const { buildNetwork } = await import(pathToUrl(path.join(build, 'network.js')))
  const { loadSchedule, currentDayType, estimateArrivalsFromSchedule } = await import(
    pathToUrl(path.join(build, 'schedule.js')),
  )

  const server = await serveDirectory(path.join(projectRoot, 'public'))
  try {
    const net = buildNetwork(
      JSON.parse(await fs.readFile(path.join(projectRoot, 'public', 'data', 'network.json'), 'utf8')),
    )
    const schedule = await loadSchedule(net, `${server.origin}/data/gtfs.zip`)

    check('el horario declara su rango de validez', Boolean(schedule.validFrom && schedule.validTo),
      `${schedule.validFrom} → ${schedule.validTo}`)
    check('se detecta que el GTFS incluido esta caducado', schedule.stale === true, `caduca ${schedule.validTo}`)

    // Parada con los dos sentidos de una misma linea: es donde el horario sin
    // filtrar mezclaba idas y vueltas y el desvio salia siempre "en hora".
    let sample = null
    for (const line of net.lines) {
      for (const stop of line.directions[0]?.stops ?? []) {
        const through = net.getDirectionsThroughStop(stop.stopId, line.lineId).filter((item) => !item.partial)
        if (through.length < 2) continue
        const all = schedule.getScheduledTimes(stop.stopId, line.lineId, 'weekday')
        const one = schedule.getScheduledTimes(stop.stopId, line.lineId, 'weekday', through[0].key)
        if (all.length > 0 && one.length > 0 && one.length < all.length) {
          sample = { stopId: stop.stopId, lineId: line.lineId, all, one, key: through[0].key }
          break
        }
      }
      if (sample) break
    }

    check('el horario se puede acotar a un solo sentido', sample !== null,
      sample ? `parada ${sample.stopId} L${sample.lineId}: ${sample.all.length} → ${sample.one.length} salidas` : 'sin caso')

    if (sample) {
      check(
        'el sentido filtrado es un subconjunto del total',
        sample.one.every((clock) => sample.all.includes(clock)),
      )
    }

    const times = schedule.getScheduledTimes('222', '4', 'weekday')
    check('hay horario programado de la linea 4 en la parada 222', times.length > 0, `${times.length} salidas`)
    check('las horas vienen en formato HH:MM ordenadas', times.every((clock) => /^\d{2}:\d{2}$/.test(clock))
      && times.join() === [...times].sort().join())
    check('el tipo de dia actual es uno de los tres', ['weekday', 'saturday', 'sunday'].includes(currentDayType()))

    // Estimacion por horario cuando no hay tiempos reales. Un martes a las 10:00
    // la linea 4 pasa por la 222 varias veces en hora y media.
    const tuesday = new Date(2026, 8, 22, 10, 0)
    const estimates = estimateArrivalsFromSchedule(schedule, '222', ['4'], tuesday)
    check('el horario da pasos estimados de la linea 4 en la 222', estimates.length > 0, `${estimates.length} pasos`)
    check('como mucho tres pasos por linea', estimates.length <= 3)
    check(
      'los pasos estimados estan dentro de la hora y media y ordenados',
      estimates.every((item, index) => item.minutesUntil >= 0 && item.minutesUntil <= 90
        && (index === 0 || estimates[index - 1].minutesUntil <= item.minutesUntil)),
    )
    check(
      'la hora estimada cuadra con los minutos que faltan',
      estimates.every((item) => {
        const [h, m] = item.estimatedClock.split(':').map(Number)
        return h * 60 + m === 600 + item.minutesUntil
      }),
    )
    check(
      'cada paso estimado existe en el horario programado',
      estimates.every((item) => times.includes(item.estimatedClock)),
    )
    check(
      'una linea que no pasa por la parada no da estimaciones',
      estimateArrivalsFromSchedule(schedule, '222', ['no-existe'], tuesday).length === 0,
    )

    // Cerca de medianoche se cuentan los pasos del dia siguiente.
    const lastWeekday = times[times.length - 1]
    const [lastH, lastM] = lastWeekday.split(':').map(Number)
    const beforeLast = new Date(2026, 8, 22, lastH, lastM - 10)
    const lateEstimates = estimateArrivalsFromSchedule(schedule, '222', ['4'], beforeLast)
    check('el ultimo paso del dia sale diez minutos antes', lateEstimates.some((item) => item.minutesUntil === 10),
      `ultimo ${lastWeekday}: ${lateEstimates.map((item) => item.estimatedClock).join(', ')}`)
  } finally {
    await server.close()
  }

  if (process.argv.includes('--live')) {
    section('7 · Fuente oficial en vivo')

    const userAgent =
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

    const endpoint = 'https://salamancadetransportes.com/api/siri/arrivals?stop=103'

    const withUa = await fetch(endpoint, { headers: { 'User-Agent': userAgent } })
    check('la fuente responde 200 con User-Agent de navegador', withUa.status === 200, `HTTP ${withUa.status}`)

    const feed = parseStopFeed('103', await withUa.text())
    check('la respuesta real se parsea', feed.status === 'ok' || feed.status === 'empty', feed.status)
    console.log(`  info parada 103 → ${feed.arrivals.map((item) => `L${item.lineId}:${item.minutesUntil}`).join(' ')}`)

    // Las líneas que devuelve la API tienen que ser líneas que la app conozca:
    // si la fuente renumerara, los tiempos no se podrían atribuir a nada.
    const knownLines = new Set(network.lines.map((line) => line.lineId))
    check(
      'las líneas que devuelve la fuente existen en la red descargada',
      feed.arrivals.every((item) => knownLines.has(item.lineId)),
      feed.arrivals.map((item) => item.lineId).join(','),
    )

    await new Promise((resolve) => setTimeout(resolve, 2500))

    const withoutUa = await fetch(endpoint, { headers: { 'User-Agent': '' } })
    check('sin User-Agent de navegador la fuente rechaza', withoutUa.status === 403, `HTTP ${withoutUa.status}`)
  }

  section('6 bis · Cupo de consultas a la fuente')

  {
    const arrivalsSource = await fs.readFile(
      path.join(projectRoot, 'src', 'services', 'arrivals.ts'), 'utf8')

    const constant = (name) => {
      const match = new RegExp('const ' + name + ' = ([0-9_]+)').exec(arrivalsSource)
      return match ? Number(match[1].replace(/_/g, '')) : null
    }

    // La fuente limita con un cubo de fichas, no con un cronometro: medido el
    // 2026-08-17 daba 6-8 de rafaga y ~1 ficha cada 1,2 s. Lo que se use aqui
    // tiene que quedarse POR DEBAJO, porque pasarse cuesta un bloqueo de 6-10 s
    // y quedarse corto solo cuesta esperar un poco mas.
    check('la ráfaga se queda por debajo de la medida',
      constant('BURST_CAPACITY') > 0 && constant('BURST_CAPACITY') <= 6,
      String(constant('BURST_CAPACITY')))
    check('la reposición es más lenta que la medida',
      constant('REFILL_MS') >= 1_200, String(constant('REFILL_MS')))
    check('el ritmo sostenido no baja del medido como seguro',
      constant('REFILL_MS') <= 2_000)

    // Lo que garantiza que la parada MIRADA no haga cola: el trafico de fondo
    // no puede vaciar el cubo ni ocupar todos los huecos en vuelo.
    check('queda una consulta reservada para lo que se está mirando',
      constant('RESERVED_FOR_FOCUS') >= 1
        && /const floor = priority === 0 \? 0 : RESERVED_FOR_FOCUS/.test(arrivalsSource))
    check('y también un hueco en vuelo reservado',
      constant('MAX_IN_FLIGHT_BACKGROUND') >= 1
        && arrivalsSource.includes('const MAX_IN_FLIGHT = MAX_IN_FLIGHT_BACKGROUND + 1')
        && /const slots = next\.priority === 0 \? MAX_IN_FLIGHT : MAX_IN_FLIGHT_BACKGROUND/
          .test(arrivalsSource))

    // Nunca se vuelve al ataque despues de un 429: el cubo se vacia y la
    // reposicion se frena al mismo ritmo degradado que el espaciado.
    check('un bloqueo vacía el cupo en vez de encadenar otro',
      /function registerThrottle\(\)[\s\S]{0,400}tokens = 0/.test(arrivalsSource))
    check('tras un bloqueo el cupo se repone más despacio',
      /const rate = spacingMs > MIN_REQUEST_SPACING_MS \? spacingMs : REFILL_MS/
        .test(arrivalsSource))

    // El aviso de "~N s" tiene que contar la rafaga, o promete el doble de
    // espera de la que hay.
    check('la espera anunciada cuenta la ráfaga',
      /export function estimateBatchDurationMs[\s\S]{0,400}Math\.floor\(tokens\)/
        .test(arrivalsSource))
  }

  section('7 · Canal de actualización')

  const { parseTag, readRelease, isNewer } = await import(
    pathToUrl(path.join(build, 'release-parser.js'))
  )
  const { resolveVersion, VERSION_CODE_BASE, versionFromSubject, commitVersionName } = await import(
    pathToUrl(path.join(projectRoot, 'tools', 'version.mjs'))
  )

  const version = resolveVersion()

  // La formula del versionCode vive por duplicado (tools/version.mjs y
  // android/app/build.gradle) porque Gradle no puede importar JavaScript. Si
  // las dos se separan, la app compara su versionCode contra otro numero y el
  // canal falla EN SILENCIO: o se ofrece una actualizacion ya instalada, o no
  // se ofrece ninguna nunca.
  const gradle = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'build.gradle'),
    'utf8',
  )

  check('Gradle declara la misma base de versionCode que tools/version.mjs',
    gradle.includes('ext.VERSION_CODE_BASE = ' + VERSION_CODE_BASE),
    String(VERSION_CODE_BASE))
  check('Gradle cuenta los commits para el versionCode',
    gradle.includes("'rev-list', '--count', 'HEAD'"))
  // El nombre de la version es el del commit que la marca ("v5.1"). Escribirlo
  // ademas en package.json era escribir lo mismo dos veces, y las dos copias
  // acabaron diciendo cosas distintas.
  check('Gradle toma el versionName del commit, con package.json de reserva',
    gradle.includes('gitVersionName(providers) ?: readPackageVersion(rootProject.projectDir)')
      && gradle.includes("'log', '-200', '--pretty=%s'"))

  check('un commit con nombre de version da el nombre',
    versionFromSubject('v5.1') === '5.1'
      && versionFromSubject('v5') === '5'
      && versionFromSubject(' 4.9 ') === '4.9')
  check('un commit normal no renombra la version',
    versionFromSubject('arreglar el mapa') === null
      && versionFromSubject('v5.1 y algo mas') === null
      && versionFromSubject('') === null)
  check('el nombre sale de la historia real del repositorio',
    commitVersionName() === version.versionName, String(commitVersionName()))

  // Las versiones anteriores a este sistema llegaron a mano hasta la 430: por
  // debajo de ese numero el movil no reconoceria la release como actualizacion.
  check('el versionCode calculado supera al ultimo publicado a mano',
    version.versionCode > 430, String(version.versionCode))

  check('la etiqueta combina version y compilacion',
    version.tag === `v${version.versionName}-b${version.versionCode}`, version.tag)
  check('la etiqueta se lee de vuelta sin perder nada',
    parseTag(version.tag)?.versionCode === version.versionCode
      && parseTag(version.tag)?.versionName === version.versionName)
  check('una etiqueta sin compilacion se descarta', parseTag('v4.3.0') === null)
  check('una etiqueta vacia se descarta', parseTag('') === null)

  const release = {
    tag_name: 'v4.4.0-b1010',
    published_at: '2026-08-20T10:00:00Z',
    assets: [
      { name: 'notas.txt', browser_download_url: 'https://x/notas.txt' },
      { name: 'SALBUS-v4.4.0-b1010.apk', browser_download_url: 'https://x/app.apk' },
    ],
  }

  check('se elige el asset .apk y no otro adjunto',
    readRelease(release)?.apkUrl === 'https://x/app.apk')
  check('la release publicada aporta su versionCode',
    readRelease(release)?.versionCode === 1010)
  check('un borrador no se ofrece', readRelease({ ...release, draft: true }) === null)
  check('una release sin APK no se ofrece',
    readRelease({ ...release, assets: [{ name: 'n.txt', browser_download_url: 'https://x/n' }] }) === null)

  const parsed = readRelease(release)
  check('solo se ofrece un versionCode estrictamente mayor', isNewer(parsed, 1009) === true)
  check('un versionCode igual no se ofrece', isNewer(parsed, 1010) === false)
  check('un versionCode menor no se ofrece', isNewer(parsed, 1011) === false)

  // Lo que hace que CUALQUIER version instalada salte directamente a la ultima:
  // no hay cadena de actualizaciones que seguir. Se consulta SIEMPRE la ultima
  // release publicada y se compara con el versionCode que dice el sistema, sea
  // el que sea. Una version de hace veinte publicaciones se actualiza en un
  // paso, igual que la de ayer.
  check('desde cualquier version se salta directamente a la ultima',
    isNewer(parsed, 1) === true && isNewer(parsed, 431) === true)

  const latestOnly = await fs.readFile(
    path.join(projectRoot, 'src', 'services', 'updates.ts'), 'utf8')
  check('siempre se consulta la ultima release, no la siguiente',
    latestOnly.includes('/releases/latest') && !latestOnly.includes('releases?page'))
  check('la comparacion usa el versionCode que dice el sistema',
    latestOnly.includes('const installed = await readInstalledVersion()')
      && latestOnly.includes('isNewer(release, installed.versionCode)'))

  // Con nombres de version libres ("5.1", "5") la etiqueta tiene que seguir
  // leyendose: es de donde sale el versionCode publicado.
  check('una etiqueta con nombre corto se lee igual',
    parseTag('v5-b1020')?.versionName === '5' && parseTag('v5-b1020')?.versionCode === 1020)
  check('una etiqueta con nombre de dos cifras se lee igual',
    parseTag('v5.1-b1021')?.versionName === '5.1')

  const mainSourceForUpdates = await fs.readFile(
    path.join(projectRoot, 'src', 'main.ts'), 'utf8')

  // El plugin nativo y el permiso son la otra mitad: sin ellos la app
  // detectaria la actualizacion pero no podria instalarla.
  const manifest = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    'utf8',
  )
  check('el manifiesto pide REQUEST_INSTALL_PACKAGES',
    manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES'))
  check('el manifiesto declara el FileProvider que expone la APK',
    manifest.includes('.fileprovider'))

  const filePaths = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'xml', 'file_paths.xml'),
    'utf8',
  )
  check('el FileProvider cubre la cache, que es donde se descarga la APK',
    filePaths.includes('cache-path'))

  const mainActivity = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas',
      'salbus', 'MainActivity.java'),
    'utf8',
  )
  check('UpdaterPlugin esta registrado en MainActivity',
    mainActivity.includes('registerPlugin(UpdaterPlugin.class)'))

  // La version instalada la dice el SISTEMA, no el numero incrustado en el
  // bundle: ese numero se congela si la WebView sirve una copia vieja de la
  // pagina, y con el la app se ofrecia a si misma lo que acababa de instalar.
  const updater = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas',
      'salbus', 'UpdaterPlugin.java'),
    'utf8',
  )
  const updatesSource = await fs.readFile(
    path.join(projectRoot, 'src', 'services', 'updates.ts'), 'utf8')

  check('la version instalada se lee del sistema, no del bundle',
    updater.includes('public void currentVersion(PluginCall call)')
      && updatesSource.includes('await Updater.currentVersion()')
      && /const installed = await readInstalledVersion\(\)/.test(updatesSource))

  // Una descarga guardada solo vale para SU version: reutilizarla para otra
  // reinstalaba la anterior, y al abrir la app volvia a ofrecerse lo mismo.
  check('la descarga guardada dice a que compilacion pertenece',
    updater.includes('getPackageArchiveInfo')
      && updatesSource.includes('pendingUpdate(): Promise<{ ready: boolean, path: string | null } & VersionInfo>'))
  check('una descarga que no corresponde se tira en vez de instalarse',
    updater.includes('public void clearPending(PluginCall call)')
      && mainSourceForUpdates.includes('pending.versionCode === versionCode')
      && mainSourceForUpdates.includes('await Updater.clearPending()'))

  // Android no dice si una instalacion salio bien: la app se va al instalador y,
  // al volver, solo puede mirar que version hay. Sin dejar anotado que se
  // intento, una instalacion que no cuaja vuelve a ofrecerse en silencio, una y
  // otra vez: es asi como se llega a un bucle sin explicacion.
  const stateSourceForUpdates = await fs.readFile(
    path.join(projectRoot, 'src', 'state.ts'), 'utf8')

  check('queda anotado que compilacion se mando instalar',
    stateSourceForUpdates.includes('export function writeInstallAttempt(')
      && mainSourceForUpdates.includes('writeInstallAttempt(update.release.versionCode)'))
  check('una instalacion que no se completa se avisa, no se repite en silencio',
    mainSourceForUpdates.includes('function reviewInstallAttempt()')
      && mainSourceForUpdates.includes('La instalación anterior no llegó a completarse'))
  check('tras un intento fallido la descarga se rehace desde cero',
    /reviewInstallAttempt\(\)[\s\S]*?Updater\.clearPending\(\)/.test(mainSourceForUpdates))

  // El runner tiene que cumplir el requisito de Node del CLI de Capacitor. Con
  // una version por debajo, `cap sync` aborta antes de copiar nada y el build
  // falla sin haber llegado a Gradle.
  const workflow = await fs.readFile(
    path.join(projectRoot, '.github', 'workflows', 'release.yml'),
    'utf8',
  )
  const capacitorCli = JSON.parse(await fs.readFile(
    path.join(projectRoot, 'node_modules', '@capacitor', 'cli', 'package.json'),
    'utf8',
  ))

  const requiredNode = Number(/(\d+)/.exec(capacitorCli.engines?.node ?? "")?.[1] ?? 0)
  const workflowNode = Number(/node-version:\s*(\d+)/.exec(workflow)?.[1] ?? 0)

  check('el workflow usa una version de Node valida para el CLI de Capacitor',
    workflowNode >= requiredNode && requiredNode > 0,
    `workflow ${workflowNode} · Capacitor exige ${capacitorCli.engines?.node}`)
  check('el workflow clona la historia entera para poder contar los commits',
    workflow.includes('fetch-depth: 0'))

  /* ---------------------------------------------------------------- *
   * El nombre                                                          *
   * ---------------------------------------------------------------- */

  // build.gradle ya se leyo arriba, para las comprobaciones del versionCode.
  const capacitorConfig = await fs.readFile(
    path.join(projectRoot, 'capacitor.config.ts'), 'utf8')
  const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))

  // El applicationId ES la identidad de la app instalada. Cambiarlo por
  // com.icuas.salbus dejaria a quien ya la tiene sin ruta de actualizacion y sin
  // sus paradas guardadas: se veria como una app distinta.
  check('el applicationId sigue siendo el de la app ya instalada',
    /applicationId "com\.icuas\.bussalamanca"/.test(gradle)
      && capacitorConfig.includes("appId: 'com.icuas.bussalamanca'"),
    'cambiarlo rompe la actualizacion de todo el mundo')

  // El resto del proyecto si se llama SALBUS.
  check('el codigo nativo vive en el paquete com.icuas.salbus',
    /namespace = "com\.icuas\.salbus"/.test(gradle)
      && mainActivity.includes('package com.icuas.salbus;'))
  check('el nombre de la app es SALBUS en todas partes',
    pkg.name === 'salbus'
      && capacitorConfig.includes("appName: 'SALBUS'")
      && (await fs.readFile(path.join(projectRoot, 'android', 'app', 'src', 'main', 'res',
        'values', 'strings.xml'), 'utf8')).includes('<string name="app_name">SALBUS</string>'))

  // Perder la clave de firma rompe el canal para siempre; publicarla es peor.
  const ignored = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8')
  check('la clave de firma esta excluida de git',
    ignored.includes('*.jks') && ignored.includes('android/keystore.properties'))

  /* ---------------------------------------------------------------- *
   * 8 · Segundo plano y notificaciones                                 *
   * ---------------------------------------------------------------- */

  section('8 · Segundo plano y notificaciones')

  const style = await fs.readFile(path.join(projectRoot, 'src', 'style.css'), 'utf8')
  const zIndexOf = (selector) => {
    const block = new RegExp(`\\${selector}\\s*\\{[^}]*\\}`).exec(style)?.[0] ?? ''
    return Number(/z-index:\s*(\d+)/.exec(block)?.[1] ?? 0)
  }

  // La hoja de "Avisos" se abre DESDE la ficha de la parada (la que sale al
  // tocar una parada en el mapa): por debajo de ella no se ve.
  check('la hoja de avisos se dibuja por encima de la ficha de parada',
    zIndexOf('.sheet') > zIndexOf('.modal') && zIndexOf('.sheet-backdrop') > zIndexOf('.modal-backdrop'),
    `hoja ${zIndexOf('.sheet')} · ficha ${zIndexOf('.modal')}`)

  const service = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas',
      'salbus', 'BusTrackingService.java'),
    'utf8',
  )

  // El aviso se queda en linea + tiempo (titulo) y direccion + hora (cuerpo).
  // Repetir la parada o el contador "Autobús 1 de 1" solo alargaba el texto.
  check('el aviso de proximo bus no repite datos en el cuerpo',
    !service.includes('private String progress(Job job)')
      && service.includes('private String body(Job job)'))
  check('el aviso lleva la hora de actualizacion en hh:mm',
    service.includes('new SimpleDateFormat("HH:mm"'))

  const mainSource = await fs.readFile(path.join(projectRoot, 'src', 'main.ts'), 'utf8')

  // El servicio ya publica su aviso de "completado": publicar otro desde la web
  // dejaba dos notificaciones identicas cada vez que pasaba el autobus.
  check('el cierre de un aviso no duplica la notificacion del servicio',
    /async function finishTracking\(id: string, alreadyNotified = false\)/.test(mainSource)
      && mainSource.includes('finishTracking(update.jobId, true)'))

  // Puntualidad en segundo plano: sin esto, medir exigia dejar la app delante
  // durante toda la franja.
  check('el servicio recibe tambien los controles de puntualidad',
    service.includes('EXTRA_MONITORS') && service.includes('private void applyMonitors('))
  check('la app manda los controles al servicio',
    /monitors: monitors\.map\(/.test(mainSource))
  check('el servicio mantiene el movil despierto dentro de la franja',
    service.includes('PowerManager.PARTIAL_WAKE_LOCK') && service.includes('acquireWakeLock()'))
  check('el servicio despierta solo al empezar la siguiente franja',
    service.includes('setAndAllowWhileIdle') && service.includes('ACTION_TICK'))
  check('el manifiesto concede el permiso de WakeLock',
    manifest.includes('android.permission.WAKE_LOCK'))

  // La deteccion nativa es un porte a mano de src/services/punctuality.ts: si
  // los numeros dejan de coincidir, la misma parada mediria distinto segun
  // quien la estuviera observando.
  const punctuality = await fs.readFile(
    path.join(projectRoot, 'src', 'services', 'punctuality.ts'), 'utf8')
  const constantOf = (source, name, pattern) => Number(pattern.exec(source)?.[1] ?? -1)

  check('el servicio se arma con los mismos minutos que la web',
    constantOf(service, 'ARM', /ARM_MINUTES = (\d+)/)
      === constantOf(punctuality, 'ARM', /ARM_MINUTES = (\d+)/))
  check('el salto que delata el paso es el mismo en las dos partes',
    constantOf(service, 'JUMP', /JUMP_MINUTES = (\d+)/)
      === constantOf(punctuality, 'JUMP', /JUMP_MINUTES = (\d+)/))
  check('las consultas seguidas sin ver la linea son las mismas',
    constantOf(service, 'MISS', /MISSING_STREAK_TO_PASS = (\d+)/)
      === constantOf(punctuality, 'MISS', /MISSING_STREAK = (\d+)/))

  // Los pasos se entregan y se borran de una vez: leerlos sin borrarlos los
  // contaria otra vez en el siguiente arranque.
  check('los pasos medidos se recogen una sola vez',
    service.includes('static JSONArray takePasses(Context context)')
      && mainSource.includes('await BusTracking.takePasses()'))
  check('con el servicio midiendo, la web no detecta pasos por su cuenta',
    mainSource.includes('if (nativeMonitorIds.has(monitor.id)) {'))

  // Entre franja y franja el servicio se apaga: un servicio dataSync tiene un
  // tope diario de horas en Android 15, y esperar despierto lo agotaria.
  const receiver = await fs.readFile(
    path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas',
      'salbus', 'BusTrackingReceiver.java'),
    'utf8',
  )
  check('el servicio se apaga entre franjas en lugar de esperar despierto',
    service.includes('stopForeground(Service.STOP_FOREGROUND_REMOVE)')
      && service.includes('private void goIdle()'))
  check('el despertador esta declarado en el manifiesto',
    manifest.includes('.BusTrackingReceiver')
      && manifest.includes('com.icuas.salbus.TRACKING_WAKE'))
  check('el despertador vuelve a programarse tras reiniciar el movil',
    receiver.includes('Intent.ACTION_BOOT_COMPLETED')
      && manifest.includes('android.intent.action.BOOT_COMPLETED'))
  check('las franjas sobreviven a que la app se cierre',
    service.includes('static String[] readStoredMonitors(Context context)')
      && service.includes('storeMonitors(this, incoming)'))

  // "Siguiente bus": el aviso completado se borra para no ocupar hueco, y solo
  // sigue si se pulsa el boton de su notificacion final.
  {
    const plugin = await fs.readFile(
      path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas',
        'salbus', 'BusTrackingPlugin.java'),
      'utf8',
    )
    const finishBody = /private void finish\(Job job, int slot\) \{[\s\S]*?\n    \}/.exec(service)?.[0] ?? ''

    check('el aviso completado ofrece "Siguiente bus"',
      finishBody.includes('"Siguiente bus"') && finishBody.includes('renewIntent(job, summaryId)'))
    check('sin pulsarlo, el aviso completado se retira del servicio',
      finishBody.includes('jobs.remove(job);'))
    check('con la app cerrada, el aviso completado no se revive al abrirla',
      finishBody.includes('rememberStopped(job.id)'))
    check('el boton arranca el servicio aunque este apagado',
      service.includes('PendingIntent.getForegroundService(this, requestCode, intent, flags)')
        && service.includes('return renewJob(intent);'))
    check('el aviso renovado empieza con la cuenta a cero',
      /job\.lineId, job\.destination, "0",/.test(service))
    check('el renovado deja de contar como detenido',
      service.includes('forgetStopped(job.id);'))
    check('la app recoge los renovados con la app abierta y con ella cerrada',
      plugin.includes('notifyListeners("jobRenewed", job)')
        && plugin.includes('public void takeRenewed(PluginCall call)')
        && mainSource.includes("BusTracking.addListener('jobRenewed'")
        && mainSource.includes('await BusTracking.takeRenewed()'))
    // Antes de sincronizar: la primera sincronizacion con la lista antigua lo
    // quitaria del servicio justo despues de renovarlo.
    check('los renovados se recogen antes de la primera sincronizacion',
      /await BusTracking\.takeRenewed\(\)[\s\S]*?await syncTrackingService\(\)/.test(mainSource))
    check('el sentido elegido viaja con el aviso para no perderlo al renovar',
      plugin.includes('clean(job.optString("directionKey", ""))')
        && mainSource.includes("directionKey: job.directionKey ?? '',"))
    check('sin servicio nativo, la notificacion de la web tambien lleva el boton',
      /showArrivalAlert\([\s\S]{0,200}\{ stopId: job\.stopId, lineId: job\.lineId, directionKey: job\.directionKey \}/.test(mainSource))
  }

  /* ---------------------------------------------------------------- *
   * 9 · Mapas: cercanas y rutas (experimental)                         *
   * ---------------------------------------------------------------- */

  section('9 · Mapas: paradas cercanas y rutas')

  const routing = await import(pathToUrl(path.join(build, 'routing.js')))

  // Distancia conocida: la Plaza Mayor de Salamanca y la Catedral Nueva estan a
  // unos 400 m. Un error en la formula se ve enseguida con un caso real.
  {
    const plaza = { lat: 40.9650, lon: -5.6640 }
    const catedral = { lat: 40.9613, lon: -5.6647 }
    const meters = routing.distanceMeters(plaza, catedral)
    check('la distancia entre dos puntos conocidos es la real',
      meters > 380 && meters < 460, Math.round(meters) + ' m')
    check('la distancia de un punto a si mismo es cero',
      routing.distanceMeters(plaza, plaza) < 0.001)
  }

  // Red de juguete: una linea recta de cinco paradas separadas ~500 m, y una
  // segunda linea que la cruza. Con datos inventados el resultado esperado se
  // puede calcular a mano, que es lo que hace util la prueba.
  const stopAt = (id, index) => ({
    stopId: id,
    stopName: 'Parada ' + id,
    lat: 40.96 + index * 0.0045,
    lon: -5.66,
  })

  const lineA = {
    key: 'A|uno',
    slot: 'uno',
    way: 'ida',
    partial: false,
    circular: false,
    label: 'A1 > A5',
    origin: 'A1',
    destination: 'Norte',
    stopCount: 5,
    stops: ['A1', 'A2', 'A3', 'A4', 'A5'].map(stopAt),
  }

  // Cruza en A3 y se aleja hacia el este.
  const lineB = {
    key: 'B|uno',
    slot: 'uno',
    way: 'ida',
    partial: false,
    circular: false,
    label: 'A3 > B3',
    origin: 'A3',
    destination: 'Este',
    stopCount: 3,
    stops: [
      lineA.stops[2],
      { stopId: 'B2', stopName: 'Parada B2', lat: 40.969, lon: -5.6535 },
      { stopId: 'B3', stopName: 'Parada B3', lat: 40.969, lon: -5.647 },
    ],
  }

  const fixedWait = () => 5

  {
    // De la primera parada a la ultima de la misma linea: sin transbordos.
    const plan = routing.planRoute({
      origin: lineA.stops[0],
      destination: lineA.stops[4],
      originName: 'Origen',
      destinationName: 'Destino',
      directions: [lineA, lineB],
      waitMinutes: fixedWait,
    })

    check('encuentra la ruta directa de una sola linea',
      plan.status === 'ok' && plan.best.transfers === 0
        && plan.best.legs.filter((leg) => leg.kind === 'bus').length === 1,
      plan.status)

    const bus = plan.status === 'ok' ? plan.best.legs.find((leg) => leg.kind === 'bus') : null
    check('el tramo en autobus va de la parada de subida a la de bajada',
      bus?.from.stopId === 'A1' && bus?.to.stopId === 'A5' && bus?.stops.length === 5)

    // Origen y destino SON paradas: no debe colarse ningun paseo de cero metros.
    check('no aparecen paseos de cero metros',
      plan.status === 'ok'
        && plan.best.legs.every((leg) => leg.kind !== 'walk' || leg.meters >= 30))
  }

  {
    // Cruzando de la linea A a la B: obliga a un transbordo en A3.
    const plan = routing.planRoute({
      origin: lineA.stops[0],
      destination: lineB.stops[2],
      originName: 'Origen',
      destinationName: 'Destino',
      directions: [lineA, lineB],
      waitMinutes: fixedWait,
    })

    check('resuelve una ruta con transbordo',
      plan.status === 'ok' && plan.best.transfers === 1, plan.status)

    const lines = plan.status === 'ok'
      ? plan.best.legs.filter((leg) => leg.kind === 'bus').map((leg) => leg.lineId)
      : []
    check('usa las dos lineas en el orden correcto',
      lines.join('-') === 'A-B', lines.join('-'))
  }

  {
    // Dos puntos pegados: proponer un autobus para cruzar la calle es absurdo.
    const plan = routing.planRoute({
      origin: { lat: 40.96, lon: -5.66 },
      destination: { lat: 40.9615, lon: -5.66 },
      originName: 'Origen',
      destinationName: 'Destino',
      directions: [lineA, lineB],
      waitMinutes: fixedWait,
    })
    check('para dos manzanas propone ir andando', plan.status === 'walk', plan.status)
  }

  {
    // Un destino en mitad del campo, sin ninguna parada cerca.
    const plan = routing.planRoute({
      origin: lineA.stops[0],
      destination: { lat: 41.5, lon: -5.0 },
      originName: 'Origen',
      destinationName: 'Destino',
      directions: [lineA, lineB],
      waitMinutes: fixedWait,
    })
    check('dice claramente que no se puede llegar', plan.status === 'unreachable', plan.status)
  }

  {
    // La espera se inyecta: el modulo no puede inventarsela.
    const conWait = (minutes) => routing.planRoute({
      origin: lineA.stops[0],
      destination: lineA.stops[4],
      originName: 'Origen',
      destinationName: 'Destino',
      directions: [lineA, lineB],
      waitMinutes: () => minutes,
    })

    const corta = conWait(2)
    const larga = conWait(20)
    check('la espera en parada cuenta en el total',
      corta.status === 'ok' && larga.status === 'ok'
        && Math.round(larga.best.totalMinutes - corta.best.totalMinutes) === 18,
      corta.status === 'ok' && larga.status === 'ok'
        ? Math.round(larga.best.totalMinutes - corta.best.totalMinutes) + ' min'
        : 'sin ruta')
  }

  // Paradas cercanas: orden y corte por distancia.
  {
    const here = { lat: 40.96, lon: -5.66 }
    const nearby = routing.nearestStops(here, lineA.stops, 3, 900)
    check('las paradas cercanas salen de menor a mayor distancia',
      nearby.length === 2 && nearby[0].stop.stopId === 'A1' && nearby[1].stop.stopId === 'A2',
      nearby.map((n) => n.stop.stopId).join(','))
    check('una parada lejana no se cuela entre las cercanas',
      nearby.every((entry) => entry.meters <= 900))
    check('cada parada cercana trae su tiempo andando',
      nearby[0].minutes >= 0 && nearby[1].minutes > nearby[0].minutes)
  }

  // La red REAL: es la prueba que de verdad protege, porque el calculo corre
  // sobre 80 sentidos y 349 paradas, no sobre el juguete de arriba.
  {
    const payload = JSON.parse(
      await fs.readFile(path.join(projectRoot, 'public', 'data', 'network.json'), 'utf8'),
    )
    const realDirections = payload.lines.flatMap((line) => line.directions)
    const from = payload.stopsById['309']
    const to = payload.stopsById['326']

    const started = Date.now()
    const plan = routing.planRoute({
      origin: from,
      destination: to,
      originName: from.stopName,
      destinationName: to.stopName,
      directions: realDirections,
    })
    const elapsed = Date.now() - started

    check('cruza la ciudad real de punta a punta',
      plan.status === 'ok' && plan.best.legs.some((leg) => leg.kind === 'bus'), plan.status)
    check('el calculo sobre la red real es instantaneo',
      elapsed < 1500, elapsed + ' ms')

    if (plan.status === 'ok') {
      const signature = (itinerary) => itinerary.legs
        .filter((leg) => leg.kind === 'bus')
        .map((leg) => leg.lineId)
        .join('-')

      check('las alternativas no repiten la ruta recomendada',
        plan.alternatives.every((alt) => signature(alt) !== signature(plan.best)))
      check('no hay dos tramos a pie seguidos',
        plan.best.legs.every((leg, index) =>
          !(leg.kind === 'walk' && plan.best.legs[index + 1]?.kind === 'walk')))
      check('el total es la suma de sus partes',
        Math.abs(plan.best.totalMinutes
          - (plan.best.walkMinutes + plan.best.rideMinutes + plan.best.waitMinutes)) < 0.001)
    }
  }

  // La pestana es experimental: apagada no puede existir ni dejar rastro.
  {
    const stateSource = await fs.readFile(path.join(projectRoot, 'src', 'state.ts'), 'utf8')
    const viewsSource = await fs.readFile(path.join(projectRoot, 'src', 'views.ts'), 'utf8')
    const mainSource = await fs.readFile(path.join(projectRoot, 'src', 'main.ts'), 'utf8')

    check('la pestana Mapas viene apagada de fabrica',
      /experimentalMaps: false/.test(stateSource))
    // Lo experimental es AHORA el apartado "Como llegar", no la pestana entera:
    // los horarios de linea salen del GTFS que ya viaja dentro de la app.
    check('apagado, "Como llegar" no dibuja mapa ni pide ubicacion',
      viewsSource.includes('function renderComoLlegar()')
        && viewsSource.includes('if (!state.settings.experimentalMaps)')
        && viewsSource.includes("'Cómo llegar está apagado'"))
    check('la pestana Info existe siempre, sin depender del experimento',
      viewsSource.includes("{ id: 'info', label: 'Info', iconName: 'info' }")
        && /function visibleTabs\(\): TabDefinition\[\] \{\s*\n\s*return TABS/.test(viewsSource))
    check('una pestana Mapas guardada aterriza en Info',
      /const valid: TabId\[\] = \['inicio', 'buscar', 'monitor', 'seguimiento', 'info', 'ajustes'\]/
        .test(stateSource)
        && stateSource.includes("raw === 'mapas' ? 'info'"))
    check('al salir de la pestana se suelta el mapa y la ubicacion',
      mainSource.includes('function closeMaps()')
        && mainSource.includes("if (previous === 'info' && tab !== 'info')")
        && mainSource.includes('function stopWatchingLocation()'))
    check('el manifiesto pide los permisos de ubicacion',
      manifest.includes('android.permission.ACCESS_COARSE_LOCATION')
        && manifest.includes('android.permission.ACCESS_FINE_LOCATION'))

    // La ubicacion se pide por partida doble: una lectura suelta que llega
    // enseguida y un seguimiento que la afina. Solo con el seguimiento, la
    // primera posicion puede no llegar nunca y la pantalla se queda "buscando".
    check('la ubicacion se pide con lectura rapida Y seguimiento',
      mainSource.includes('navigator.geolocation.getCurrentPosition(acceptPosition')
        && mainSource.includes('navigator.geolocation.watchPosition(acceptPosition'))
    check('una posicion peor no pisa a una mejor',
      mainSource.includes('accuracy <= known.accuracy'))
    // Tocar "Mi ubicacion" antes de que el sistema sepa donde estas dejaba el
    // buscador abierto sin hacer nada: habia que volver a tocarlo a ciegas.
    check('"Mi ubicacion" rellena el campo en cuanto llega la posicion',
      mainSource.includes('let pendingLocationField')
        && mainSource.includes('pendingLocationField && state.maps.picking === pendingLocationField'))
    // La ubicacion la usan dos pantallas (Buscar y Mapas), asi que no puede
    // vivir dentro del estado de una de ellas: salir de Mapas lo vacia entero.
    check('la ubicacion vive fuera de la pestana experimental',
      mainSource.includes('state.geo.location')
        && !mainSource.includes('state.maps.location'))
  }

  // Al abrir Inicio se ponen al dia TODAS las guardadas: la que se despliegue
  // tiene que abrirse con algo puesto, no en blanco esperando su turno.
  check('al abrir Inicio se actualizan todas las paradas guardadas',
    /for \(const favourite of state\.favourites\) \{\s*\n\s*add\(favourite\.stopId/
      .test(mainSourceForUpdates))
  // Pero con una desplegada manda ella sola: esperar turno detras de nueve
  // paradas que nadie mira son veinte segundos mirando un hueco vacio.
  check('la parada desplegada aparta el repaso de las demas',
    /if \(state\.expandedStopId\) \{\s*\n\s*add\(state\.expandedStopId, FRESHNESS\.focused, 'high'\)/
      .test(mainSourceForUpdates)
      && mainSourceForUpdates.includes('cancelRefreshCycle()')
      && mainSourceForUpdates.includes('shouldStop: () => refreshCycle !== cycle'))

  section('10 · Callejero peatonal')

  {
    const { buildStreetGraph, nearestNode, walkPath } = await import(
      pathToUrl(path.join(build, 'streets.js'))
    )
    const { refineWalking } = routing

    // Un grafo minusculo con una forma que la linea recta no puede resolver:
    // dos aceras paralelas unidas solo por un extremo. En recta son 20 m; a pie
    // hay que rodear.
    //
    //   A ── B ── C        (acera norte)
    //   |
    //   D ── E ── F        (acera sur, sin union con C)
    const grid = (() => {
      const points = [
        [40.9700, -5.6700], // 0  D
        [40.9700, -5.6690], // 1  E
        [40.9700, -5.6680], // 2  F
        [40.9710, -5.6700], // 3  A
        [40.9710, -5.6690], // 4  B
        [40.9710, -5.6680], // 5  C
      ]

      // El formato en disco guarda diferencias sucesivas en millonesimas.
      const lat = []
      const lon = []
      let previousLat = 0
      let previousLon = 0
      for (const [pointLat, pointLon] of points) {
        const currentLat = Math.round(pointLat * 1e6)
        const currentLon = Math.round(pointLon * 1e6)
        lat.push(currentLat - previousLat)
        lon.push(currentLon - previousLon)
        previousLat = currentLat
        previousLon = currentLon
      }

      return buildStreetGraph({
        lat,
        lon,
        edges: [0, 1, 1, 2, 3, 4, 4, 5, 0, 3],
        nodeCount: points.length,
        edgeCount: 5,
      })
    })()

    check('las coordenadas diferenciales se reconstruyen enteras',
      Math.abs(grid.lat[0] - 40.97) < 1e-9 && Math.abs(grid.lon[5] + 5.668) < 1e-9)

    check('cada nodo conoce a sus vecinos',
      grid.offsets[1] - grid.offsets[0] === 2 && grid.offsets[3] - grid.offsets[2] === 1)

    check('un punto se engancha a la calle que tiene al lado',
      nearestNode(grid, { lat: 40.97002, lon: -5.66898 }) === 1)

    check('un punto lejos de cualquier calle no se engancha',
      nearestNode(grid, { lat: 41.05, lon: -5.60 }) === null)

    // De F (esquina sureste) a C (esquina noreste) hay ~111 m en linea recta,
    // pero por la calle hay que ir hasta el otro extremo y volver: ~390 m.
    {
      const direct = walkPath(grid, { lat: 40.9700, lon: -5.6680 }, { lat: 40.9710, lon: -5.6680 })
      check('el camino rodea cuando no se puede cruzar', direct !== null && direct.meters > 300,
        direct ? `${Math.round(direct.meters)} m` : 'sin camino')
      check('el camino sale con todos sus puntos para poder dibujarlo',
        direct !== null && direct.points.length >= 6)
    }

    check('dos puntos de la misma calle van en linea',
      (() => {
        const along = walkPath(grid, { lat: 40.9700, lon: -5.6700 }, { lat: 40.9700, lon: -5.6680 })
        return along !== null && Math.abs(along.meters - 168) < 30
      })())

    // El afinado sustituye los metros del tramo a pie y rehace el total.
    {
      // El itinerario de partida es coherente consigo mismo: 111 m en linea
      // recta y los minutos que corresponden a esos metros. Con un total
      // inventado, la comprobacion de que el afinado rehace el total no diria
      // nada.
      const straightMinutes = routing.walkMinutes(111)
      const straight = {
        totalMinutes: straightMinutes,
        walkMinutes: straightMinutes,
        rideMinutes: 0,
        waitMinutes: 0,
        transfers: 0,
        legs: [
          {
            kind: 'walk',
            from: { lat: 40.9700, lon: -5.6680 },
            to: { lat: 40.9710, lon: -5.6680 },
            fromName: 'Aquí',
            toName: 'Allí',
            meters: 111,
            minutes: straightMinutes,
          },
        ],
      }

      const refined = refineWalking(straight, (from, to) => walkPath(grid, from, to))

      check('el afinado alarga el paseo hasta lo que se anda de verdad',
        refined.legs[0].meters > straight.legs[0].meters)
      check('el afinado deja marcado que el tramo va por las calles',
        refined.legs[0].onStreets === true && Array.isArray(refined.legs[0].path))
      check('el afinado rehace el total del itinerario',
        Math.abs(refined.totalMinutes - refined.walkMinutes) < 0.001
          && refined.totalMinutes > straight.totalMinutes)

      // Sin callejero disponible, la ruta tiene que salir igual que antes.
      const untouched = refineWalking(straight, () => null)
      check('sin callejero la ruta no cambia', untouched === straight)
    }

    // El fichero real: si esta, tiene que servir para cruzar Salamanca andando.
    {
      const file = path.join(projectRoot, 'public', 'data', 'streets.json')
      const exists = await fs.stat(file).then(() => true, () => false)

      check('el callejero generado esta en el proyecto', exists)

      if (exists) {
        const payload = JSON.parse(await fs.readFile(file, 'utf8'))
        const city = buildStreetGraph(payload)

        check('el callejero real trae toda la ciudad', city.nodeCount > 20_000,
          `${city.nodeCount} nodos`)

        // Plaza Mayor → Estación de tren. Son unos 1.400 m andando; en linea
        // recta salen ~1.150. La ruta a pie NUNCA puede ser mas corta que la
        // recta, que es la comprobacion que delata un grafo mal montado.
        const started = Date.now()
        const path14 = walkPath(
          city,
          { lat: 40.9653, lon: -5.6642 },
          { lat: 40.9741, lon: -5.6535 },
        )
        const elapsed = Date.now() - started

        check('cruza la ciudad andando por calles reales',
          path14 !== null && path14.meters > 1_100 && path14.meters < 3_000,
          path14 ? `${Math.round(path14.meters)} m` : 'sin camino')
        check('el camino a pie nunca es mas corto que la linea recta',
          path14 !== null && path14.meters >= 1_100)
        check('el calculo a pie no congela la interfaz', elapsed < 1_500, `${elapsed} ms`)
      }
    }

    // No puede cargarse al arrancar: son cien mil nodos por una funcion en
    // pruebas. Se pide al entrar en "Rutas".
    {
      const mainSource = await fs.readFile(path.join(projectRoot, 'src', 'main.ts'), 'utf8')
      check('el callejero se carga solo al abrir "Como llegar"',
        mainSource.includes("if (tab === 'info' && state.info.section === 'llegar' && state.settings.experimentalMaps) {")
          && mainSource.includes('void loadStreetGraph()')
          && !mainSource.includes('await loadStreetGraph()'))
    }
  }

  section('11 · Ritmo, límites y puntualidad')

  {
    const stateSource = await fs.readFile(path.join(projectRoot, 'src', 'state.ts'), 'utf8')
    const mainSource = await fs.readFile(path.join(projectRoot, 'src', 'main.ts'), 'utf8')
    const viewsSource = await fs.readFile(path.join(projectRoot, 'src', 'views.ts'), 'utf8')
    const uiSource = await fs.readFile(path.join(projectRoot, 'src', 'ui.ts'), 'utf8')

    // Una sola funcion activa: dos se quitaban el turno en una cola que solo
    // admite una peticion cada dos segundos.
    check('solo una funcion de seguimiento se mantiene actualizada',
      /export const MAX_ACTIVE_JOBS = 1/.test(stateSource))
    check('reanudar una pausa automaticamente la otra',
      mainSource.includes('enforceActiveLimit(id)'))

    // "Al dia" son 40 s: el doble del ciclo del recorrido de un aviso mirado.
    check('un dato esta al dia durante 40 segundos',
      /const SYNC_FRESH_MS = 40_000/.test(uiSource))
    check('el recorrido que se esta mirando se refresca cada 20 segundos',
      /routeVisible: 20_000/.test(stateSource))
    check('de fondo, el rastreo va mas espaciado',
      /routeBackground: 30_000/.test(stateSource))

    // Las frecuencias viven en un solo sitio porque Ajustes las enseña.
    check('las frecuencias se cuentan en un solo sitio',
      /export const FRESHNESS = \{/.test(stateSource)
        && viewsSource.includes('FRESHNESS.routeVisible')
        && !/const FRESHNESS = \{/.test(mainSource))
    check('Ajustes explica las frecuencias y sus condiciones',
      viewsSource.includes('Frecuencias de actualización')
        && viewsSource.includes('function renderRefreshRulesCard()'))

    // Un aviso se puede pausar, y al pausarlo su notificacion se retira.
    check('el aviso de proximo bus se puede pausar',
      viewsSource.includes('renderJobToggle(tracking.id, tracking.active)'))
    check('al pausar un aviso se cierra su notificacion',
      mainSource.includes('if (!job.active) {')
        && mainSource.includes('await cancelNotification(notificationId(id))'))

    // Midiendo puntualidad NO se pausa el aviso: es una notificacion que
    // alguien espera. Lo que se apaga es su rastreo, que es la parte cara.
    check('midiendo puntualidad el aviso sigue dando la hora',
      !mainSource.includes('pauseFollows')
        && mainSource.includes('const measuring = anyMonitorWindowOpen()'))
    check('midiendo puntualidad no se rastrea el recorrido',
      mainSource.includes('trackingServiceActive || measuring'))

    // El registro de puntualidad: la respuesta a "por que no se apunta nada".
    check('cada control deja registro de lo que ve',
      stateSource.includes('export function addMonitorTrace')
        && mainSource.includes('addMonitorTrace(monitor.id, {')
        && viewsSource.includes('function renderMonitorTrace('))
    check('se avisa cuando una franja lleva minutos sin consultas',
      mainSource.includes('MONITOR_SILENCE_MS')
        && mainSource.includes('function superviseMonitors()'))
    check('mientras se mide hay notificacion persistente',
      mainSource.includes('function syncMonitorNotification(')
        && mainSource.includes('showOngoingNotification('))

    // Repaso de arranque: una pasada por todas las guardadas, a la vez.
    check('al arrancar se precargan todas las paradas guardadas',
      mainSource.includes('async function primeFavourites()')
        && mainSource.includes('await primeFavourites()'))

    // La cola reparte el ritmo; el llamador ya no lo hace de una en una. Medido
    // contra la fuente real: ocho paradas pasaban de 29,5 s a 7,1 s.
    check('los lotes sin dependencias se piden a la vez',
      mainSource.includes('await fetchStopsInParallel(stopIds, {')
        && /const direct = plan\.filter\(\(entry\) => !entry\.scan\)/.test(mainSource)
        && /fetchStopsInParallel\(\s*\n\s*direct\.map/.test(mainSource))
    // La busqueda del autobus hacia atras SI depende de la respuesta anterior:
    // para en la primera parada que lo tenga encima. Esa sigue en serie.
    check('la búsqueda hacia atrás sigue yendo una a una',
      /const scanned = plan\.filter\(\(entry\) => entry\.scan\)/.test(mainSource)
        && /fetchStopsSequentially\(\s*\n\s*scanned\.map/.test(mainSource))
    check('el repaso de arranque se hace una sola vez',
      mainSource.includes('let bootPrimeDone = false')
        && mainSource.includes('bootPrimeDone = true'))

    // El mapa del buscador sin linea elegida, y el adelanto de la consulta.
    check('sin linea elegida el mapa enseña todas las paradas',
      mainSource.includes('const showingAll = !direction')
        && mainSource.includes('direction?.stops ?? state.network.stops'))
    check('tocar una parada del mapa adelanta su consulta',
      mainSource.includes("marker.on('popupopen', () => prefetchStop(stop.stopId))")
        && mainSource.includes('function prefetchStop('))
    check('"Ver tiempos" aprovecha lo ya adelantado',
      mainSource.includes('async function ensureStopFresh(')
        && mainSource.includes('await ensureStopFresh(stopId)'))

    // La animacion de bienvenida dura 1 s exacto, y el numero vive en UN sitio:
    // la hoja de estilo y main.ts tienen que decir lo mismo o la pantalla se
    // retira a media animacion.
    {
      const css = await fs.readFile(path.join(projectRoot, 'src', 'style.css'), 'utf8')
      check('la animacion de inicio dura 1 s',
        /animation: splash-out 0\.32s ease 1s forwards/.test(css)
          && mainSource.includes('const SPLASH_MS = 1_000')
          && mainSource.includes('Math.max(0, SPLASH_MS - elapsed)'))
    }

    // Ubicacion: se lleva a quien mira hasta donde se activa.
    check('se ofrece activar la ubicacion del sistema',
      mainSource.includes('DeviceSettings.openLocationSettings()')
        && viewsSource.includes("data-action=\"open-location-settings\""))
    check('el mapa de "Como llegar" se puede ampliar',
      viewsSource.includes("data-action=\"maps-expand\"")
        && mainSource.includes("case 'maps-expand':"))
  }

  section('12 · Por dónde viene el autobús')

  {
    const stateSource = await fs.readFile(path.join(projectRoot, 'src', 'state.ts'), 'utf8')
    const mainSource = await fs.readFile(path.join(projectRoot, 'src', 'main.ts'), 'utf8')
    const viewsSource = await fs.readFile(path.join(projectRoot, 'src', 'views.ts'), 'utf8')

    // "Ver por donde viene" ya no es una funcion aparte: el aviso hace las dos
    // cosas. Lo que queda de la modalidad antigua tiene que ser SOLO el codigo
    // que retira sus datos guardados.
    check('la modalidad "ver por dónde viene" ya no existe',
      !stateSource.includes('interface FollowJob')
        && !stateSource.includes('MAX_FOLLOW_JOBS')
        && !/state\.follows/.test(mainSource)
        && !/state\.follows/.test(viewsSource))
    check('no queda ni una tarjeta ni una hoja de la modalidad retirada',
      !viewsSource.includes('renderFollowCard')
        && !viewsSource.includes("data-purpose=\"follow\"")
        && !mainSource.includes("purpose === 'follow'"))
    check('lo guardado de la modalidad retirada se tira al arrancar',
      stateSource.includes('function dropLegacyFollows()')
        && stateSource.includes('dropLegacyFollows()')
        && stateSource.includes("window.localStorage.removeItem(KEYS.follows)"))

    // Se pueden tener dos montados —ida y vuelta— pero solo uno trabaja.
    check('se pueden tener dos avisos creados',
      /export const MAX_TRACKING_JOBS = 2/.test(stateSource))
    check('solo uno se mantiene actualizado',
      /export const MAX_ACTIVE_JOBS = 1/.test(stateSource))
    check('reanudar uno pausa el otro',
      mainSource.includes('const turnedOff = job.active ? enforceActiveLimit(id) : []'))

    // La tarjeta del aviso lleva dentro el recorrido; la de Inicio no, que es
    // un vistazo y no la pantalla donde se va a mirar por donde viene.
    check('la tarjeta del aviso dibuja el recorrido',
      viewsSource.includes('function renderTrackingCard(')
        && viewsSource.includes('renderTrackingRoute(tracking)')
        && viewsSource.includes('renderTrackingCard(job)'))
    check('Inicio sigue siendo un vistazo, sin recorrido',
      viewsSource.includes('renderTrackingBanner(job)')
        && !/renderTrackingBanner[\s\S]{0,400}renderTrackingRoute/.test(viewsSource))
    check('la cabecera es la misma en las dos',
      viewsSource.includes('function renderTrackingHead('))

    // El servicio no puede saber que pestana hay delante, y la diferencia le
    // cambia el trabajo: mirandolo hay ocho paradas que dibujar.
    check('se avisa al servicio de si el recorrido se está mirando',
      mainSource.includes('function isWatchingRoute()')
        && mainSource.includes('BusTracking.setRouteWatch({ watching })')
        // La ventana es holgada a proposito: lo que se comprueba es que goToTab
        // avise al servicio, no cuantas lineas mida la funcion.
        && /async function goToTab[\s\S]{0,3000}void syncRouteWatch\(\)/.test(mainSource)
        && /visibilitychange[\s\S]{0,400}void syncRouteWatch\(\)/.test(mainSource))

    // Fuera de la pestana se degrada: sigue avisando, deja de dibujar.
    check('el recorrido entero solo se pide mirándolo',
      mainSource.includes("return state.tab === 'seguimiento' && document.visibilityState === 'visible'")
        && mainSource.includes('const watchingRoute = isWatchingRoute()')
        && mainSource.includes('watchingRoute ? FRESHNESS.routeVisible : FRESHNESS.routeBackground'))
    // La ventana es la misma mire quien mire: lo que cambia es hasta donde se
    // llega dentro de ella. Fuera de la pestana se corta al encontrarlo.
    check('la ventana de busqueda es siempre la misma',
      mainSource.includes('ROUTE_WINDOW_STOPS + 1')
        && !mainSource.includes('routeScanDepth'))
    check('fuera de la pestaña la búsqueda para en el autobús',
      mainSource.includes('located.add(scan.jobId)')
        && mainSource.includes('shouldSkip: (stopId) =>')
        && mainSource.includes('watchingRoute ? undefined : { jobId: job.id, lineId: job.lineId }'))
    check('salir de la pestaña Seguir ya no pausa nada',
      !mainSource.includes('pauseFollows'))
  }

  {
    const {
      locateBus,
      stopsAwayFrom,
      shouldScanRoute,
      describeStopsAway,
      AT_STOP_MINUTES,
      ROUTE_WINDOW_STOPS,
      ROUTE_SCAN_MAX_MINUTES,
      ROUTE_FIX_MAX_AGE_MS,
    } = await import(pathToUrl(path.join(build, 'bus-position.js')))

    // La ventana va de la parada mas lejana a la propia, que es la ultima.
    // Un contador de 0 o 1 es lo unico que delata al autobus.
    check('sitúa el autobús donde el contador está a cero',
      locateBus([9, 7, 5, 0, 3]) === 3)
    check('un contador de un minuto también cuenta como "aquí"',
      locateBus([9, 7, 1]) === 2)
    check('sin ningún contador bajo, el autobús no consta',
      locateBus([9, 7, 5, 4]) === -1)
    check('una parada que no publica esa línea no es un cero',
      locateBus([null, null, 6]) === -1)

    // La regla que sostiene todo: los datos de la ventana NO son del mismo
    // instante, asi que puede haber dos "llegando" a la vez. Gana el mas
    // avanzado, porque un autobus solo avanza.
    check('con dos "llegando" gana el más avanzado del recorrido',
      locateBus([0, 5, 6, 1, 8]) === 3)

    // Paradas seguidas y cercanas: el mismo autobus sale "llegando" en dos o
    // tres a la vez. Esta en la mas lejana de ese tramo, no en la mas avanzada.
    check('con dos "llegando" seguidos, el autobús está en el más lejano',
      locateBus([9, 7, 1, 0, 3]) === 2)
    check('con tres "llegando" seguidos, también en el más lejano',
      locateBus([9, 1, 0, 1, 4]) === 1)
    check('el tramo puede acabar en tu propia parada',
      locateBus([9, 7, 5, 1, 0]) === 3)
    check('un tramo rezagado más atrás no cuenta',
      locateBus([1, 0, 6, 1, 0, 8]) === 3)
    check('un hueco sin dato corta el tramo',
      locateBus([9, 1, null, 0, 5]) === 3)

    check('el autobús en tu propia parada son cero paradas',
      stopsAwayFrom(5, 4) === 0)
    check('una parada antes es una parada',
      stopsAwayFrom(5, 3) === 1)
    check('cuatro paradas antes son cuatro paradas',
      stopsAwayFrom(5, 0) === 4)
    check('sin localización no hay número que dar',
      stopsAwayFrom(5, -1) === null)

    check('"en tu parada" no se cuenta como cero paradas',
      describeStopsAway(0) === 'en tu parada')
    check('una parada va en singular', describeStopsAway(1) === 'a 1 parada')
    check('varias van en plural', describeStopsAway(4) === 'a 4 paradas')
    check('sin dato no se escribe nada', describeStopsAway(null) === '')

    // Ya no se recorta la ventana por los minutos que faltan: eso suponia un
    // ritmo fijo y dejaba de encontrar al autobus en cuanto llevaba retraso.
    // Lo unico que decide el tiempo de espera es SI se busca.
    check('con el autobús encima se busca', shouldScanRoute(0) === true)
    check('a cinco minutos se busca', shouldScanRoute(5) === true)
    check('en el límite todavía se busca',
      shouldScanRoute(ROUTE_SCAN_MAX_MINUTES) === true)
    check('lejos no se busca: costaría la ventana entera cuando menos sirve',
      shouldScanRoute(ROUTE_SCAN_MAX_MINUTES + 1) === false)
    check('sin dato de llegada no se busca', shouldScanRoute(-1) === false)

    // Buscar es caro: cada parada es una peticion contra una fuente que admite
    // una cada dos segundos, y salen del turno que necesita TU parada. Por eso
    // la busqueda para en cuanto encuentra: la ventana entera solo se recorre
    // con la pestana Seguir delante, que es cuando se dibuja.
    check('la ventana entera cabe en un ciclo de refresco',
      ROUTE_WINDOW_STOPS * 2 <= 20,
      `${ROUTE_WINDOW_STOPS} paradas = ${ROUTE_WINDOW_STOPS * 2} s`)

    // La copia portada a Java tiene que decir lo mismo: si se separan, la misma
    // parada cuenta distinto segun si la app esta abierta o cerrada.
    {
      const service = await fs.readFile(
        path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas', 'salbus',
          'BusTrackingService.java'), 'utf8')
      const plugin = await fs.readFile(
        path.join(projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas', 'salbus',
          'BusTrackingPlugin.java'), 'utf8')

      const constant = (name) => {
        const match = new RegExp(name + '\\s*=\\s*([0-9_.]+)').exec(service)
        return match ? Number(match[1].replace(/_/g, '')) : null
      }

      check('el servicio mira la misma ventana que la web',
        constant('ROUTE_WINDOW_STOPS') === ROUTE_WINDOW_STOPS,
        `java ${constant('ROUTE_WINDOW_STOPS')} vs web ${ROUTE_WINDOW_STOPS}`)
      check('deja de buscar a los mismos minutos',
        constant('ROUTE_SCAN_MAX_MINUTES') === ROUTE_SCAN_MAX_MINUTES)
      check('el servicio recorre la ventana entera, sin recortarla por minutos',
        /int depth = job\.route\.length;/.test(service)
          && !service.includes('MINUTES_PER_STOP'))
      check('olvida la localización a la vez que la web',
        constant('ROUTE_FIX_MAX_AGE_MS') === ROUTE_FIX_MAX_AGE_MS)
      check('usa el mismo umbral de "el autobús está aquí"',
        /arrival\.arriving \|\| arrival\.minutes <= 1/.test(service) && AT_STOP_MINUTES === 1)

      // La busqueda va de la parada mas cercana hacia atras y se queda con la
      // primera que lo tenga: siendo la mas cercana de las que lo tienen, es la
      // mas avanzada. Ese orden es lo que la hace barata.
      check('el servicio busca desde la parada más cercana hacia atrás',
        service.includes('found = index + 1;')
          && service.includes('job.stopsAway = found;')
          && service.includes('if (atStop && (found < 0 || runOpen))')
          && service.includes('for (int index = 0; index < depth; index += 1)'))
      // Y sale en cuanto lo encuentra... salvo con la pantalla Seguir delante,
      // que dibuja las ocho paradas y por tanto las necesita todas.
      check('sin nadie mirando el recorrido, la búsqueda para en el autobús',
        /if \(!watching\) \{\s*\n\s*break;/.test(service))
      check('mirando el recorrido se barre la ventana entera',
        service.includes('boolean watching = routeWatch;')
          && service.includes('static void setRouteWatch(boolean watching)'))
      // Lo consultado se comparte con la web en vez de tirarse: es lo que le
      // permite dibujar el recorrido sin pedir una sola consulta mas.
      // Parada a parada, en cuanto se sabe: agrupado al final del barrido, el
      // recorrido dibujado se quedaba quince segundos inmovil.
      check('el servicio comparte lo que ve en cada parada',
        service.includes('plugin.emitRouteUpdate(job.id, job.lineId, one)')
          && plugin.includes('notifyListeners("routeUpdate", payload)'))
      // Y ademas cuenta por donde VA, que es lo unico que puede encender el
      // punto de estado de cada parada mientras el servicio tiene la cola.
      check('el servicio cuenta por que parada va el barrido',
        service.includes('emitRouteProgress(job, queuedFrom(job, index + 1), job.route[index])')
          && service.includes('emitRouteProgress(job, new JSONArray(), null)')
          && plugin.includes('notifyListeners("routeProgress", payload)'))
      check('la web pinta ese estado parada a parada',
        mainSourceForUpdates.includes("BusTracking.addListener('routeProgress'")
          && /routeProgress[\s\S]{0,700}state\.stopSync\[stopId\] = 'queued'/.test(mainSourceForUpdates)
          && /routeProgress[\s\S]{0,900}state\.stopSync\[update\.loading\] = 'loading'/.test(mainSourceForUpdates))
      check('la web integra ese barrido en su propia cache',
        mainSourceForUpdates.includes("BusTracking.addListener('routeUpdate'")
          && /routeUpdate[\s\S]{0,900}state\.feeds\[stop\.stopId\] = \{/.test(mainSourceForUpdates))
      check('un bloqueo de la fuente no adelanta al autobús',
        /STATUS_THROTTLED[\s\S]{0,200}?break;/.test(
          service.slice(service.indexOf('private void sweepRoute'))))

      check('al pasar un autobús se olvida dónde estaba',
        /job\.warnedAt3 = false;\s*\n\s*\/\/[\s\S]{0,180}?job\.stopsAway = -1;/.test(service))
      check('el recuento va detrás del tiempo en el título',
        service.includes('title = title + " · " + where;'))
    }

    // Sobre la red real: la pregunta tiene que ser la excepcion, no la norma.
    {
      const lineById = new Map(network.lines.map((line) => [line.lineId, line]))
      let asked = 0
      let total = 0

      for (const [stopId, lineIds] of Object.entries(network.linesByStopId)) {
        for (const lineId of lineIds) {
          const line = lineById.get(lineId)
          if (!line) {
            continue
          }

          const through = line.directions.filter(
            (direction) => direction.stops.some((stop) => stop.stopId === stopId),
          )
          const complete = through.filter((direction) => !direction.partial)
          const options = through.length <= 1
            ? through
            : (complete.length > 0 ? complete : through)

          total += 1
          if (options.length > 1) {
            asked += 1
          }
        }
      }

      check('crear un aviso no pregunta el sentido casi nunca',
        asked / total < 0.1,
        `${asked} de ${total} pares parada-línea (${Math.round((100 * asked) / total)} %)`)
      check('y cuando no pregunta, el sentido queda resuelto',
        total - asked > 700, `${total - asked} resueltos solos`)
    }

    // El sentido: sin el no hay paradas anteriores que mirar, y adivinarlo
    // mandaria a la acera de enfrente.
    {
      const mainSource = await fs.readFile(path.join(projectRoot, 'src', 'main.ts'), 'utf8')
      const viewsSource = await fs.readFile(path.join(projectRoot, 'src', 'views.ts'), 'utf8')

      check('el aviso resuelve su sentido al crearse',
        mainSource.includes('function resolveTrackingDirection(')
          && mainSource.includes('directionKey: resolveTrackingDirection(stopId, lineId, directionKey)'))

      // Con un solo sentido posible no se pregunta nada; con varios se pregunta,
      // porque quien espera SABE cual es su autobus y la fuente oficial no lo
      // dice nunca. Lo que no se hace en ningun caso es adivinar.
      check('con un solo sentido posible no se pregunta',
        viewsSource.includes("purpose === 'tracking' && trackingDirectionOptions(stopId, selectedLineId).length < 2"))
      check('con varios sentidos se pregunta al crear el aviso',
        viewsSource.includes('export function trackingDirectionOptions(')
          && viewsSource.includes("purpose === 'tracking' ? trackingDirectionOptions(stopId, selectedLineId) : directions"))
      check('lo elegido a mano manda sobre la deducción',
        mainSource.includes('if (chosen && options.some((direction) => direction.key === chosen))'))
      check('el sentido elegido llega hasta el aviso',
        mainSource.includes('await createTracking(stopId, lineId, state.draft.directionKey, state.draft.skip)'))
      check('el desplegable abre con una opción que sí está en la lista',
        mainSource.includes('function defaultDirectionKey(')
          && !mainSource.includes("state.network?.getDirectionsThroughStop(stopId, state.draft.lineId)[0]?.key ?? ''"))

      // Los parciales son variantes del mismo sentido: no cuentan como duda.
      check('un trayecto parcial no cuenta como otro sentido',
        viewsSource.includes('const complete = through.filter((direction) => !direction.partial)')
          && viewsSource.includes('return complete.length > 0 ? complete : through'))

      // Seguir al segundo autobus: se elige al crear el aviso, los pasos se
      // siguen detectando con el primero y el que pasa primero solo descuenta.
      {
        const serviceSource = await fs.readFile(path.join(projectRoot, 'android', 'app', 'src', 'main', 'java',
          'com', 'icuas', 'salbus', 'BusTrackingService.java'), 'utf8')
        const pluginSource = await fs.readFile(path.join(projectRoot, 'android', 'app', 'src', 'main', 'java',
          'com', 'icuas', 'salbus', 'BusTrackingPlugin.java'), 'utf8')
        check('al crear el aviso se puede elegir el segundo autobús',
          viewsSource.includes('data-action="draft-skip"') && mainSource.includes("if (action === 'draft-skip')"))
        check('la tarjeta enseña el autobús que se sigue, no el primero',
          viewsSource.includes('return line[job.skip] ?? null')
            && !viewsSource.includes('feed?.arrivals.find((item) => item.lineId === tracking.lineId)'))
        check('el primero que pasa solo descuenta, en la web y en el servicio',
          mainSource.includes('if (job.skip > 0) {\n    job.skip -= 1')
            && serviceSource.includes('if (job.skip > 0) {\n            job.skip -= 1;'))
        check('el servicio recibe y devuelve cuántos autobuses dejar pasar',
          pluginSource.includes('String.valueOf(job.optInt("skip", 0))')
            && serviceSource.includes('job.skip = Math.min(1, Math.max(0, parseInt(parts, 8)));')
            && pluginSource.includes('payload.put("skip", skip);'))
        check('«Siguiente bus» vuelve a seguir al próximo',
          serviceSource.includes('String.join(",", job.route), job.directionKey, "0");')
            && mainSource.includes('    job.skip = 0\n'))
      }

      check('los avisos ya guardados reciben su sentido al arrancar',
        mainSource.includes('function backfillTrackingDirections()')
          && mainSource.includes('backfillTrackingDirections()'))

      // Una sola implementacion de la regla: dos situarian el mismo autobus en
      // dos sitios distintos con los mismos datos delante.
      check('el recorrido dibujado y el recuento comparten el localizador',
        viewsSource.includes('const busIndex = locateBusInWindow(windowStops, tracking.lineId)')
          && viewsSource.includes('locateBusInWindow(window, job.lineId)'))

      // Con el servicio vivo el rastreo es suyo: hacerlo dos veces seria el
      // doble de peticiones y dos recuentos capaces de discrepar.
      check('la web no rastrea a la vez que el servicio',
        mainSource.includes('!job.directionKey || trackingServiceActive'))
      check('el servicio manda su recuento a la pantalla',
        mainSource.includes("state.trackingStopsAway[update.jobId] = { stopsAway: update.stopsAway"))
      check('un aviso en pausa no arrastra su última localización',
        mainSource.includes('delete state.trackingStopsAway[id]'))
      check('la notificación de la web también dice por dónde viene',
        mainSource.includes('stopsAway: describeStopsAway(trackingStopsAway(job))'))
    }
  }

  section('13 · Widget de paradas favoritas')

  {
    const androidJava = (file) => path.join(
      projectRoot, 'android', 'app', 'src', 'main', 'java', 'com', 'icuas', 'salbus', file)

    const widgetJava = await fs.readFile(androidJava('FavouritesWidget.java'), 'utf8')
    const storeJava = await fs.readFile(androidJava('WidgetStore.java'), 'utf8')
    const widgetInfo = await fs.readFile(
      path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'xml',
        'widget_favourites_info.xml'),
      'utf8',
    )
    const widgetTs = await fs.readFile(
      path.join(projectRoot, 'src', 'services', 'widget.ts'), 'utf8')
    const appManifest = await fs.readFile(
      path.join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8')
    const main = await fs.readFile(path.join(projectRoot, 'src', 'main.ts'), 'utf8')

    const number = (source, pattern) => Number(pattern.exec(source)?.[1] ?? -1)

    // Sin el receptor declarado el widget no existe para el lanzador: no sale
    // en la lista de widgets y nadie puede llegar a colocarlo.
    check('el widget está declarado en el manifiesto',
      appManifest.includes('android:name=".FavouritesWidget"')
        && appManifest.includes('android.appwidget.action.APPWIDGET_UPDATE')
        && appManifest.includes('@xml/widget_favourites_info'))

    // El tamaño personalizable del widget es justo esto: sin `vertical` el
    // número de paradas quedaría clavado en el que cupiera al colocarlo.
    check('el widget se puede redimensionar a lo alto',
      /resizeMode="[^"]*vertical/.test(widgetInfo))

    // El tope de la web y el de la copia nativa tienen que ser el mismo: si la
    // web mandara menos, el widget más grande saldría con huecos.
    check('web y widget cuentan las mismas paradas como máximo',
      number(widgetTs, /WIDGET_MAX_STOPS = (\d+)/) === number(storeJava, /MAX_STOPS = (\d+)/)
        && number(widgetTs, /WIDGET_MAX_STOPS = (\d+)/) === 4)

    // La altura mínima vive en dos archivos —la ficha del widget y el cálculo
    // de filas—; si dejan de coincidir se dibujan filas que no caben.
    check('la altura mínima del widget dice lo mismo en los dos sitios',
      number(widgetInfo, /minResizeHeight="(\d+)dp"/)
        === number(widgetJava, /MIN_HEIGHT_DP = (\d+)/))

    // Y el ancho mínimo, por lo mismo: es el que decide si al nombre de la
    // parada le queda sitio una vez puestas la insignia y la campana.
    check('el ancho mínimo del widget dice lo mismo en los dos sitios',
      number(widgetInfo, /minResizeWidth="(\d+)dp"/)
        === number(widgetJava, /MIN_WIDTH_DP = (\d+)/))

    // En un widget estrecho la fila se queda en una línea. Con el umbral por
    // debajo del ancho mínimo no se estrecharía nunca, y volvería el «Avisarme
    // d...» que le come el sitio al nombre de la parada.
    check('el widget más estrecho posible enseña la fila en una sola línea',
      number(widgetJava, /COMPACT_WIDTH_DP = (\d+)/)
        > number(widgetJava, /MIN_WIDTH_DP = (\d+)/))

    const minRow = number(widgetJava, /MIN_ROW_DP = (\d+)/)
    const gap = number(widgetJava, /ROW_GAP_DP = (\d+)/)
    const chrome = number(widgetJava, /BOX_PADDING_DP = (\d+)/) + number(widgetJava, /HEADER_DP = (\d+)/)
    const minHeight = number(widgetJava, /MIN_HEIGHT_DP = (\d+)/)
    const rowsFor = (height) =>
      Math.max(1, Math.min(4, Math.floor((Math.max(height, minHeight) - chrome + gap) / minRow)))

    // Alturas de la rejilla del lanzador: n celdas de alto miden 70n-30 dp.
    check('cada celda de alto añade una parada al widget',
      rowsFor(110) === 1 && rowsFor(180) === 2 && rowsFor(250) === 3 && rowsFor(320) === 4,
      `110dp ${rowsFor(110)} · 180dp ${rowsFor(180)} · 250dp ${rowsFor(250)} · 320dp ${rowsFor(320)}`)

    // Las paradas se reparten el alto entero: sin el peso en la raíz de la
    // fila volvería el hueco en blanco bajo la última parada.
    const widgetRow = await fs.readFile(
      path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'layout',
        'widget_favourites_row.xml'),
      'utf8',
    )
    check('las paradas del widget llenan todo el alto',
      /<FrameLayout[^>]*android:layout_height="0dp"[^>]*android:layout_weight="1"/.test(widgetRow))
    check('por muy grande que se haga no enseña una quinta parada',
      rowsFor(600) === 4)

    // Dos PendingIntent se consideran el mismo cuando coinciden acción, datos y
    // código: los extras NO cuentan. Sin un código por fila, las cuatro paradas
    // acabarían abriendo la primera.
    check('cada parada del widget abre la suya',
      widgetJava.includes('widgetId * (WidgetStore.MAX_STOPS + 1) + index'))

    // Lo que promete el widget: pulsar una parada lleva al aviso de ESA parada,
    // no a su ficha.
    check('pulsar una parada abre «Avisarme del próximo bus»',
      /async function openWidgetStop/.test(main)
        && /openWidgetStop[\s\S]{0,1200}?openPickLine\(stopId, 'tracking'\)/.test(main))

    // Es la MISMA hoja que dentro de la app, con su pregunta de cuál se
    // sustituye cuando ya no caben más avisos. Dos versiones de la misma
    // ventana acabarían ofreciendo cosas distintas.
    check('desde el widget también se puede sustituir un aviso lleno',
      /openWidgetStop[\s\S]{0,1200}?state\.trackings\.length >= MAX_TRACKING_JOBS/.test(main))

    // El widget no tiene refresco propio: si una de estas tres acciones no lo
    // avisa, se queda enseñando un nombre que ya no es el de esa parada.
    const favouriteWrites = main.split('persistFavourites()').slice(1)
    check('guardar, quitar y renombrar una parada repintan el widget',
      favouriteWrites.filter((tail) => tail.slice(0, 140).includes('refreshWidget()')).length === 3,
      `${favouriteWrites.length} escrituras de favoritas`)

    // La cuarta escritura es la limpieza de paradas desaparecidas de la red, que
    // corre en el arranque: ahí el repintado va después, en el propio arranque.
    check('el arranque deja el widget al día',
      /dropStaleFavourites\(\)[\s\S]{0,400}?refreshWidget\(\)/.test(main))

    // Pulsar el widget trae la app desde cero o desde segundo plano, y en los
    // dos casos el aviso llegaría antes de que la página tuviera oyentes: la
    // parada se pregunta al arrancar y al volver a primer plano.
    check('el toque en el widget se recoge al abrir y al volver a la app',
      (main.match(/void checkWidgetTap\(\)/g) ?? []).length >= 2)
    check('la parada pulsada se atiende una sola vez',
      widgetTs.includes('Widget.pendingStop()')
        && main.includes('pendingWidgetStopId = null'))
  }

  console.log(`\n${passed} correctas · ${failed} fallidas`)
  process.exitCode = failed > 0 ? 1 : 0
}

/* ------------------------------------------------------------------ *
 * Utilidades de la prueba                                              *
 * ------------------------------------------------------------------ */

/** Compila modulos de `src/services` a JavaScript para poder importarlos aqui. */
async function compileSources(files) {
  // Dentro del proyecto: desde el temporal del sistema, Node no encontraría
  // 'jszip' ni 'papaparse' al resolver los import del módulo compilado.
  const outDir = path.join(projectRoot, 'node_modules', '.salbus-selftest')
  await fs.rm(outDir, { recursive: true, force: true })

  // Se invoca el compilador por su script de Node: en Windows, lanzar el .cmd
  // desde execFile falla con EINVAL.
  await run(
    process.execPath,
    [
      path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files.map((file) => path.join('src', 'services', file)),
      '--outDir', outDir,
      '--module', 'esnext',
      '--target', 'es2022',
      '--moduleResolution', 'bundler',
      '--skipLibCheck',
    ],
    { cwd: projectRoot },
  )

  // El compilador conserva la estructura de carpetas del codigo fuente.
  const servicesDir = path.join(outDir, 'services')

  // La app se empaqueta con Vite, que resuelve `import './routing'` sin
  // extension. Node no: cargando el JavaScript emitido tal cual, un modulo que
  // importa a otro (streets → routing) falla con MODULE_NOT_FOUND. Se le pone
  // la extension aqui en vez de escribirla en el codigo fuente, porque el
  // codigo fuente es del empaquetador y no de esta prueba.
  for (const file of await fs.readdir(servicesDir)) {
    if (!file.endsWith('.js')) {
      continue
    }
    const target = path.join(servicesDir, file)
    const source = await fs.readFile(target, 'utf8')
    await fs.writeFile(
      target,
      source.replace(/(from\s+['"]\.[^'"]*?)(['"])/g, (match, specifier, quote) =>
        specifier.endsWith('.js') ? match : `${specifier}.js${quote}`,
      ),
    )
  }

  return servicesDir
}

function pathToUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, '/')}`
}

/** Servidor minimo para poder cargar el GTFS con `fetch`, como hace la app. */
async function serveDirectory(root) {
  const server = http.createServer(async (request, response) => {
    try {
      const file = path.join(root, decodeURIComponent(new URL(request.url, 'http://x').pathname))
      response.writeHead(200)
      response.end(await fs.readFile(file))
    } catch {
      response.writeHead(404)
      response.end()
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

await main()
