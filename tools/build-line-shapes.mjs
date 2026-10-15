/**
 * Genera `public/data/line-shapes.json`: el trazado de cada linea y sentido.
 *
 * POR QUE EXISTE
 *
 * Para saber si un corte de trafico puede afectar a una linea hay que saber POR
 * DONDE va la linea, no solo donde para. `network.json` solo trae las paradas
 * (a veces a 600 m una de otra) y el GTFS trae el trazado real, pero en
 * `shapes.txt` son 26.000 puntos dentro de un ZIP de 22 MB que la app tiene que
 * descomprimir entero. Este fichero deja solo lo necesario para cruzar con un
 * corte: el trazado de cada trayecto que tiene servicio, simplificado.
 *
 * DE DONDE SALE
 *
 * De `public/data/gtfs.zip`. Cada `route_id` del GTFS es UN sentido y su
 * `shape_id` es el mismo numero. Se relaciona con la linea de la app por
 * `route_short_name` y con el sentido de `network.json` por el rotulo, con el
 * mismo criterio que `src/services/schedule.ts` (rotulo completo y, si no, el
 * destino dentro de la linea). Se incluyen tambien los trayectos que el GTFS
 * declara sin viajes (lineas 28, 93-96, 98, 99 y 699): la app las muestra como
 * lineas de la red y su servicio es de temporada o de eventos, asi que un corte
 * sobre su trazado sigue siendo informacion util.
 *
 * QUE FORMATO TIENE
 *
 * Los puntos se simplifican con Douglas-Peucker a 5 m (muy por debajo de los
 * 25 m del cruce con los cortes) y se guardan en enteros de 1e-5 grados
 * (~1 m), el primero absoluto y los demas como diferencia con el anterior:
 * `[lat0, lon0, dLat1, dLon1, ...]`. Dos trayectos de una linea con exactamente
 * el mismo trazado se guardan una sola vez.
 *
 * Uso:
 *   npm run data:shapes
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'
import Papa from 'papaparse'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GTFS_FILE = path.join(ROOT, 'public', 'data', 'gtfs.zip')
const NETWORK_FILE = path.join(ROOT, 'public', 'data', 'network.json')
const OUTPUT_FILE = path.join(ROOT, 'public', 'data', 'line-shapes.json')

/** Tolerancia de la simplificacion, en metros. */
const SIMPLIFY_METERS = 5

/** Los puntos van en enteros de 1e-5 grados (~1 m). */
const SCALE = 1e5

const METERS_PER_DEGREE = 111_195

async function main() {
  const zip = await JSZip.loadAsync(await fs.readFile(GTFS_FILE))
  const network = JSON.parse(await fs.readFile(NETWORK_FILE, 'utf8'))

  const [routes, shapes] = await Promise.all([
    readCsv(zip, 'routes.txt'),
    readCsv(zip, 'shapes.txt'),
  ])

  const directionByRouteId = mapRoutesToDirections(routes, network)

  const pointsByShape = new Map()
  for (const row of shapes) {
    const shapeId = text(row.shape_id)
    const lat = Number.parseFloat(row.shape_pt_lat)
    const lon = Number.parseFloat(row.shape_pt_lon)
    const sequence = Number.parseInt(row.shape_pt_sequence, 10)
    if (!shapeId || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue
    }
    const list = pointsByShape.get(shapeId) ?? []
    list.push({ lat, lon, sequence })
    pointsByShape.set(shapeId, list)
  }

  const lines = {}
  let rawPoints = 0
  let keptPoints = 0

  for (const row of routes) {
    const routeId = text(row.route_id)
    const lineId = text(row.route_short_name) || routeId
    // Cada trayecto del GTFS tiene un trazado con su mismo numero.
    const shapeId = routeId
    if (!routeId) {
      continue
    }

    const points = (pointsByShape.get(shapeId) ?? []).sort((a, b) => a.sequence - b.sequence)
    if (points.length < 2) {
      continue
    }

    const simplified = simplify(points, SIMPLIFY_METERS)
    rawPoints += points.length
    keptPoints += simplified.length

    const encoded = encode(simplified)
    const directionKey = directionByRouteId.get(routeId) ?? null
    const list = (lines[lineId] ??= [])

    // El mismo trazado en dos trayectos de la misma linea se guarda una vez.
    const twin = list.find((item) => sameNumbers(item.p, encoded))
    if (twin) {
      if (directionKey && !twin.k.includes(directionKey)) {
        twin.k.push(directionKey)
      }
      continue
    }

    list.push({ k: directionKey ? [directionKey] : [], p: encoded })
  }

  const ordered = Object.fromEntries(
    Object.keys(lines)
      .sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))
      .map((lineId) => [lineId, lines[lineId]]),
  )

  const payload = {
    source: 'public/data/gtfs.zip (shapes.txt)',
    generatedAt: new Date().toISOString(),
    toleranceMeters: SIMPLIFY_METERS,
    scale: SCALE,
    lines: ordered,
  }

  const json = JSON.stringify(payload)
  await fs.writeFile(OUTPUT_FILE, json)

  const shapeCount = Object.values(ordered).reduce((total, list) => total + list.length, 0)
  console.log(
    `${Object.keys(ordered).length} lineas, ${shapeCount} trazados, ${keptPoints} de ${rawPoints} puntos`
      + ` -> ${path.relative(ROOT, OUTPUT_FILE)} (${(json.length / 1024).toFixed(0)} kB)`,
  )
}

/* ------------------------------------------------------------------ *
 * GTFS                                                                 *
 * ------------------------------------------------------------------ */

async function readCsv(zip, name) {
  const file = zip.file(name)
  if (!file) {
    throw new Error(`El GTFS no trae ${name}.`)
  }
  // El BOM del principio estropea el nombre de la primera columna.
  const content = (await file.async('text')).replace(/^﻿/, '')
  return Papa.parse(content, { header: true, skipEmptyLines: true }).data
}

function text(value) {
  return String(value ?? '').trim()
}

/** Mismo criterio que `mapRoutesToDirections` de src/services/schedule.ts. */
function mapRoutesToDirections(routes, network) {
  const result = new Map()
  const byLabel = new Map()
  const byDestination = new Map()

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

function normalizeLabel(value) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/* ------------------------------------------------------------------ *
 * Geometria                                                            *
 * ------------------------------------------------------------------ */

/** Douglas-Peucker iterativo (los trazados tienen miles de puntos). */
function simplify(points, toleranceMeters) {
  const lat0 = points[0].lat
  const cosLat = Math.cos((lat0 * Math.PI) / 180)
  const xy = points.map((point) => ({
    x: point.lon * cosLat * METERS_PER_DEGREE,
    y: point.lat * METERS_PER_DEGREE,
  }))

  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]

  while (stack.length > 0) {
    const [first, last] = stack.pop()
    let worst = -1
    let worstDistance = toleranceMeters

    for (let index = first + 1; index < last; index += 1) {
      const distance = distanceToSegment(xy[index], xy[first], xy[last])
      if (distance > worstDistance) {
        worst = index
        worstDistance = distance
      }
    }

    if (worst >= 0) {
      keep[worst] = 1
      stack.push([first, worst], [worst, last])
    }
  }

  return points.filter((_, index) => keep[index])
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/** `[lat0, lon0, dLat1, dLon1, ...]` en enteros de 1e-5 grados. */
function encode(points) {
  const out = []
  let previousLat = 0
  let previousLon = 0

  for (const point of points) {
    const lat = Math.round(point.lat * SCALE)
    const lon = Math.round(point.lon * SCALE)
    out.push(lat - previousLat, lon - previousLon)
    previousLat = lat
    previousLon = lon
  }

  return out
}

function sameNumbers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

await main()
