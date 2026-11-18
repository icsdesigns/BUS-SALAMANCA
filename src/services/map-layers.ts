/**
 * Reconciliacion de lo dibujado en un mapa.
 *
 * El mapa del buscador se repintaba con `clearLayers()` y vuelta a empezar cada
 * vez que cambiaba el encuadre, la parada elegida o la posicion del GPS. Quitar
 * un marcador de Leaflet cierra su globo, y el propio globo, al abrirse,
 * desplaza el mapa para caber en pantalla: ese desplazamiento provocaba un
 * repintado, el repintado quitaba el marcador y el cartel de la parada se
 * cerraba nada mas abrirse, sin dar tiempo a pulsar "Ver tiempos".
 *
 * Aqui se decide, sin saber nada de Leaflet, que piezas se quedan, cuales
 * cambian de aspecto en su sitio y cuales se quitan. Va aparte para poder
 * probarlo sin navegador.
 */

/** Una pieza que se quiere en el mapa. */
export interface WantedLayer<T> {
  /** Identidad estable: la misma parada en el mismo dibujo da el mismo id. */
  id: string
  /** Aspecto. Si no cambia, la pieza ya dibujada se deja tal cual. */
  sig: string
  create: () => T
}

/** Una pieza que ya esta en el mapa. */
export interface DrawnLayer<T> {
  layer: T
  sig: string
  /** Ya no toca dibujarla, pero tiene el globo abierto: se quita al cerrarlo. */
  orphan: boolean
}

export interface LayerOps<T> {
  add(layer: T): void
  remove(layer: T): void
  /** Si tiene un globo abierto en este momento. */
  isOpen(layer: T): boolean
  /**
   * Pasa a `current` el aspecto de `next` sin quitarla del mapa (y sin cerrar,
   * por tanto, su globo). Devuelve false si no se puede y hay que sustituirla.
   */
  restyle(current: T, next: T): boolean
}

/**
 * Lleva `drawn` (y el mapa) a lo que dice `wanted` tocando solo lo que cambia:
 *
 *  - Lo que sigue igual no se toca: ni se quita ni se vuelve a poner.
 *  - Lo que solo cambia de aspecto (pasa a ser la parada elegida, cambia su
 *    numero) se retoca en su sitio si `restyle` sabe hacerlo.
 *  - Lo que ya no toca se quita, salvo lo que tiene el globo abierto: eso se
 *    queda, marcado como huerfano, hasta que la persona cierre el globo.
 */
export function reconcileLayers<T>(
  drawn: Map<string, DrawnLayer<T>>,
  wanted: ReadonlyArray<WantedLayer<T>>,
  ops: LayerOps<T>,
): void {
  const ids = new Set(wanted.map((item) => item.id))

  for (const [id, entry] of drawn) {
    if (ids.has(id)) {
      entry.orphan = false
      continue
    }
    if (ops.isOpen(entry.layer)) {
      entry.orphan = true
      continue
    }
    ops.remove(entry.layer)
    drawn.delete(id)
  }

  for (const item of wanted) {
    const current = drawn.get(item.id)

    if (current && current.sig === item.sig) {
      continue
    }

    const next = item.create()

    if (current) {
      if (ops.restyle(current.layer, next)) {
        current.sig = item.sig
        continue
      }
      ops.remove(current.layer)
    }

    ops.add(next)
    drawn.set(item.id, { layer: next, sig: item.sig, orphan: false })
  }
}

/** Quita lo que solo seguia en el mapa por tener el globo abierto, ya cerrado. */
export function sweepOrphanLayers<T>(drawn: Map<string, DrawnLayer<T>>, ops: LayerOps<T>): void {
  for (const [id, entry] of drawn) {
    if (entry.orphan && !ops.isOpen(entry.layer)) {
      ops.remove(entry.layer)
      drawn.delete(id)
    }
  }
}
