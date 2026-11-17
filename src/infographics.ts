/**
 * Infografías animadas: una por pestaña.
 *
 * Cada una es una maqueta en miniatura de la pantalla real —la barra azul de
 * arriba, la barra de pestañas de abajo, las mismas tarjetas y distintivos de
 * línea— con un dedo que pulsa y el resultado de esa pulsación, en tres o cuatro
 * tiempos que se repiten. Se ven en el tour de bienvenida, en Ajustes > Ayuda y
 * en el botón de ayuda de Tráfico e Info.
 *
 * Todo es HTML inline y CSS (`infographics.css`, prefijo `ig-`): nada de vídeo
 * ni de imágenes, para que siga el tema claro u oscuro con las mismas variables
 * que el resto de la app y pese unos pocos kilobytes.
 *
 * Medidas. El escenario mide 30 × 21 em y su tamaño de letra es la treintava
 * parte del ancho disponible (unidades de contenedor), así que la maqueta entera
 * escala con el hueco que tenga —de 280 a 420 px— sin recolocar nada: el dedo
 * puede apuntar a coordenadas fijas en em y siempre cae encima de lo que pulsa.
 *
 * Accesibilidad. El conjunto es `role="img"` con una descripción en español de
 * lo que enseña; la maqueta va `aria-hidden`. Con «reducir movimiento» no se
 * anima nada: se muestra el estado final y los pasos como una lista.
 */

import './infographics.css'
import { icon } from './ui'

export type IgTab = 'inicio' | 'buscar' | 'seguimiento' | 'trafico' | 'info'

export interface IgGuide {
  tab: IgTab
  /** Nombre de la pestaña tal y como aparece en la barra. */
  label: string
  iconName: string
  /** Una o dos frases: qué hay en la pestaña y cómo se usa. */
  summary: string
  /** Los tiempos de la animación, en el orden en que ocurren. */
  steps: string[]
}

export const IG_GUIDES: IgGuide[] = [
  {
    tab: 'inicio',
    label: 'Inicio',
    iconName: 'home',
    summary:
      'Tus paradas guardadas, con el reloj y los cortes de tráfico. Toca una para ver cuándo llega cada línea; la campana abre «Avisarme del próximo bus».',
    steps: ['Toca una parada: ves cuándo llega cada línea', 'La campana abre «Avisarme del próximo bus»', 'Elige la línea y te avisa'],
  },
  {
    tab: 'buscar',
    label: 'Buscar',
    iconName: 'search',
    summary:
      'Encuentra una parada por su nombre o su línea, en el mapa o entre las que tienes cerca. Desde su ficha la guardas en Inicio.',
    steps: ['Escribe una calle o una línea', 'Toca la parada: salen sus tiempos', 'Guárdala y la tendrás en Inicio'],
  },
  {
    tab: 'seguimiento',
    label: 'Seguir',
    iconName: 'route',
    summary:
      'El aviso del próximo bus: los minutos que faltan y por cuántas paradas viene. Sigue avisando aunque cierres la app.',
    steps: ['Abre Seguir: tu aviso, en marcha', 'El autobús avanza parada a parada', 'Te avisa aunque cierres la app'],
  },
  {
    tab: 'trafico',
    label: 'Tráfico',
    iconName: 'warn',
    summary:
      'Los cortes de tráfico del Ayuntamiento, en curso y de los próximos días, con las líneas de autobús a las que pueden afectar.',
    steps: ['Abre Tráfico', 'Mira qué líneas afecta cada corte', 'Desliza: los programados, más abajo'],
  },
  {
    tab: 'info',
    label: 'Info',
    iconName: 'info',
    summary:
      'Los horarios oficiales de cada línea, por sentido y tipo de día, con la primera y la última salida señaladas.',
    steps: ['Abre el selector de línea', 'Elige una: salen sus salidas', 'Primera y última salida, señaladas'],
  },
]

export function igGuide(tab: IgTab): IgGuide {
  return IG_GUIDES.find((guide) => guide.tab === tab) ?? IG_GUIDES[0]
}

export function isIgTab(value: string | undefined | null): value is IgTab {
  return IG_GUIDES.some((guide) => guide.tab === value)
}

/** Descripción para lectores de pantalla: lo que se ve, de principio a fin. */
const ARIA: Record<IgTab, string> = {
  inicio:
    'Animación de la pestaña Inicio: un dedo toca una parada guardada, se despliegan sus próximas llegadas por línea y, al tocar la campana, se abre «Avisarme del próximo bus» para elegir la línea.',
  buscar:
    'Animación de la pestaña Buscar: se escribe «Gran Vía» en el buscador, aparecen las paradas que coinciden, se toca una, se abre su ficha con los tiempos y se guarda en Inicio.',
  seguimiento:
    'Animación de la pestaña Seguir: el aviso del próximo bus muestra la línea 4 a 6 minutos; el autobús avanza parada a parada hasta quedar a una, y llega una notificación aunque la app esté cerrada.',
  trafico:
    'Animación de la pestaña Tráfico: aparecen los cortes de tráfico con su fecha y las líneas afectadas resaltadas; al deslizar hacia arriba se ven los cortes programados más adelante.',
  info:
    'Animación de la pestaña Info: se abre el selector de línea, se elige la línea 4 y aparecen sus horarios de salida de los días laborables, con la primera y la última salida señaladas.',
}

/* ------------------------------------------------------------------ *
 * Piezas comunes                                                       *
 * ------------------------------------------------------------------ */

/** Colores reales de algunas líneas, para que los distintivos se reconozcan. */
const LINE_COLORS: Record<string, [string, string]> = {
  '1': ['#f58a3c', '#1a1a1a'],
  '3': ['#c25bd6', '#ffffff'],
  '4': ['#12a150', '#ffffff'],
  '8': ['#f6b343', '#1a1a1a'],
  '11': ['#e94a9b', '#ffffff'],
}

function chip(lineId: string, extra = ''): string {
  const [background, color] = LINE_COLORS[lineId] ?? ['#173764', '#ffffff']
  return `<span class="ig-chip${extra ? ` ${extra}` : ''}" style="background:${background};color:${color}">${lineId}</span>`
}

const TAB_ICONS: Array<[IgTab, string, string]> = [
  ['inicio', 'home', 'Inicio'],
  ['buscar', 'search', 'Buscar'],
  ['seguimiento', 'route', 'Seguir'],
  ['trafico', 'warn', 'Tráfico'],
  ['info', 'info', 'Info'],
]

function topbar(title: string, from?: string): string {
  const text = from
    ? `<span class="ig-swap"><span class="ig-from">${from}</span><span class="ig-to">${title}</span></span>`
    : title
  return `
    <div class="ig-top">
      <span class="ig-top-mark"></span>
      <span class="ig-top-title">${text}</span>
      <span class="ig-top-btn"></span><span class="ig-top-btn"></span>
    </div>
  `
}

/**
 * Barra de pestañas. `lit` es la que está encendida al empezar; `to`, la que
 * se enciende cuando el dedo la pulsa (Seguir y Tráfico empiezan fuera).
 */
function tabbar(lit: IgTab, to?: IgTab): string {
  return `
    <div class="ig-tabs">
      ${TAB_ICONS.map(([tab, iconName, label]) => {
        const classes = ['ig-tab']
        if (tab === lit && !to) classes.push('is-on')
        if (tab === lit && to) classes.push('is-from')
        if (tab === to) classes.push('is-to')
        return `<span class="${classes.join(' ')}">${icon(iconName)}<span>${label}</span></span>`
      }).join('')}
    </div>
  `
}

function finger(): string {
  return `
    <span class="ig-finger">
      <span class="ig-ring"></span>
      <span class="ig-dot"></span>
    </span>
  `
}

function captions(guide: IgGuide): string {
  return `
    <ol class="ig-steps">
      ${guide.steps
        .map((text, index) => `<li class="ig-step ig-step-${index + 1}"><span class="ig-step-n">${index + 1}</span><span>${text}</span></li>`)
        .join('')}
    </ol>
  `
}

/* ------------------------------------------------------------------ *
 * Las cinco maquetas                                                   *
 * ------------------------------------------------------------------ */

function inicioBody(): string {
  return `
    <div class="ig-clock">
      <strong>08:42</strong><span>Lunes · 2 paradas</span>
    </div>

    <div class="ig-stop ig-in-a">
      <span class="ig-code">222</span>
      <span class="ig-stop-name">C/ Gran Vía, 38</span>
      <span class="ig-chips">${chip('4')}${chip('1')}</span>
      <span class="ig-bell">${icon('bell')}</span>
    </div>

    <div class="ig-arrivals ig-in-panel">
      <div class="ig-arr ig-in-arr1">${chip('4')}<span>Hacia Tejares</span><b>3 min</b></div>
      <div class="ig-arr ig-in-arr2">${chip('1')}<span>Hacia Garrido</span><b>7 min</b></div>
    </div>

    <div class="ig-stop ig-in-b">
      <span class="ig-code">301</span>
      <span class="ig-stop-name">Casa<small>C/ Gran Vía, 45</small></span>
      <span class="ig-chips">${chip('4')}${chip('8')}</span>
      <span class="ig-bell">${icon('bell')}</span>
    </div>
  `
}

function inicioOverlay(): string {
  return `
    <span class="ig-scrim ig-in-scrim"></span>
    <div class="ig-sheet ig-in-sheet">
      <span class="ig-grab"></span>
      <strong>Avisarme del próximo bus</strong>
      <span class="ig-sheet-sub">C/ Gran Vía, 38 · elige la línea</span>
      <div class="ig-sheet-chips">
        <span class="ig-pick ig-in-pick">${chip('4')}</span>${chip('1')}
      </div>
      <span class="ig-btn ig-in-go">${icon('bell')}Avisarme</span>
    </div>
  `
}

function buscarBody(): string {
  return `
    <strong class="ig-h">Buscar parada</strong>
    <div class="ig-seg"><span class="is-on">${icon('search')}Parada</span><span>${icon('map')}Mapa</span><span>${icon('pin')}Cerca</span></div>
    <div class="ig-field ig-bu-field">
      <span class="ig-ph ig-bu-ph">Ej. Gran Vía, Canalejas…</span>
      <span class="ig-typed"><span class="ig-bu-t1">Gra</span><span class="ig-bu-t2">n V</span><span class="ig-bu-t3">ía</span><span class="ig-caret ig-bu-caret"></span></span>
    </div>
    <div class="ig-row ig-bu-r1"><span class="ig-code">222</span><span class="ig-row-name">C/ Gran Vía, 38<span class="ig-chips">${chip('4')}${chip('1')}</span></span>${icon('chevron')}</div>
    <div class="ig-row ig-bu-r2"><span class="ig-code">301</span><span class="ig-row-name">C/ Gran Vía, 45<span class="ig-chips">${chip('4')}${chip('8')}</span></span>${icon('chevron')}</div>
  `
}

function buscarOverlay(): string {
  return `
    <span class="ig-scrim ig-bu-scrim"></span>
    <div class="ig-modal ig-bu-modal">
      <div class="ig-modal-head"><span class="ig-code">222</span><strong>C/ Gran Vía, 38</strong></div>
      <div class="ig-arr">${chip('4')}<span>Hacia Tejares</span><b>3 min</b></div>
      <div class="ig-arr">${chip('1')}<span>Hacia Garrido</span><b>7 min</b></div>
      <div class="ig-modal-btns">
        <span class="ig-btn ig-bu-save"><span class="ig-bu-save-a">${icon('star')}Guardar</span><span class="ig-bu-save-b">${icon('check')}Guardada</span></span>
        <span class="ig-btn is-ghost">${icon('bell')}Avisos</span>
      </div>
    </div>
  `
}

/** Inicio de fondo, para las maquetas que empiezan pulsando otra pestaña. */
function ghostInicio(): string {
  return `
    <div class="ig-ghost">
      <div class="ig-clock"><strong>08:42</strong><span>Lunes · 2 paradas</span></div>
      <div class="ig-stop">
        <span class="ig-code">222</span>
        <span class="ig-stop-name">C/ Gran Vía, 38</span>
        <span class="ig-chips">${chip('4')}${chip('1')}</span>
        <span class="ig-bell">${icon('bell')}</span>
      </div>
    </div>
  `
}

function seguirBody(): string {
  return `
    ${ghostInicio()}
    <div class="ig-track ig-se-card">
      <div class="ig-track-head">
        ${chip('4', 'is-lg')}
        <span class="ig-track-copy"><strong>C/ Gran Vía, 38</strong><span>Hacia Tejares</span></span>
        <span class="ig-track-eta">
          <b class="ig-swap"><span class="ig-se-m1">6</span><span class="ig-se-m2">4</span><span class="ig-se-m3">2</span></b><i>min</i>
          <small class="ig-swap"><span class="ig-se-m1">a 3 paradas</span><span class="ig-se-m2">a 2 paradas</span><span class="ig-se-m3">a 1 parada</span></small>
        </span>
      </div>
      <div class="ig-line">
        <span class="ig-line-rail"></span>
        <span class="ig-line-stop" style="left:2em"></span>
        <span class="ig-line-stop" style="left:9.5em"></span>
        <span class="ig-line-stop" style="left:17em"></span>
        <span class="ig-line-stop is-mine" style="left:24.5em">${icon('pin')}</span>
        <span class="ig-line-bus ig-se-bus">${icon('bus')}</span>
        <span class="ig-line-label">Tu parada</span>
      </div>
    </div>
  `
}

function seguirOverlay(): string {
  return `
    <div class="ig-notif ig-se-notif">
      <span class="ig-notif-icon">${icon('bus')}</span>
      <span class="ig-notif-copy"><strong>Línea 4 · llega en 2 min</strong><span>C/ Gran Vía, 38 · a 1 parada</span></span>
    </div>
  `
}

function traficoBody(): string {
  return `
    ${ghostInicio()}
    <div class="ig-tr-view">
      <div class="ig-tr-list">
        <div class="ig-head-card ig-tr-c0">${icon('warn')}<strong>Cortes de tráfico</strong></div>
        <div class="ig-cut ig-tr-c1">
          <div class="ig-cut-head"><strong>C/ Toro</strong><span class="ig-pill is-warn">En curso</span></div>
          <span class="ig-cut-dates">Hoy, de 8:00 a 14:00</span>
          <span class="ig-cut-lines">Líneas afectadas: <span class="ig-tr-hl">${chip('4')}</span><span class="ig-tr-hl">${chip('8')}</span></span>
        </div>
        <div class="ig-cut ig-tr-c2">
          <div class="ig-cut-head"><strong>Plaza de España</strong><span class="ig-pill">Mañana</span></div>
          <span class="ig-cut-dates">Todo el día</span>
          <span class="ig-cut-lines">Líneas afectadas: ${chip('1')}${chip('3')}</span>
        </div>
        <span class="ig-group">Programados más adelante</span>
        <div class="ig-cut">
          <div class="ig-cut-head"><strong>Av. de Mirat</strong><span class="ig-pill">24 nov</span></div>
          <span class="ig-cut-lines">Líneas afectadas: ${chip('11')}</span>
        </div>
      </div>
    </div>
  `
}

function infoBody(): string {
  const times = ['06:45', '07:05', '07:25', '07:45', '08:05', '08:25', '08:45', '09:05', '…', '22:05', '22:25', '22:45']
  return `
    <div class="ig-head-card">${icon('clock')}<strong>Horarios de las líneas</strong></div>
    <div class="ig-select ig-if-select">
      <span class="ig-if-v0">Seleccionar línea</span>
      <span class="ig-if-v1">${chip('4')}Línea 4 · Tejares</span>
      ${icon('chevronDown')}
    </div>
    <div class="ig-sched ig-if-sched">
      <span class="ig-sched-day">Laborables <i>hoy</i></span>
      <div class="ig-times">
        ${times
          .map((time, index) => {
            const mark = index === 0 ? ' is-first' : index === times.length - 1 ? ' is-last' : ''
            const row = Math.floor(index / 6) + 1
            return `<span class="ig-time ig-if-row${row}${mark}">${time}</span>`
          })
          .join('')}
      </div>
      <span class="ig-sched-legend"><span class="ig-key is-first"></span>Primera<span class="ig-key is-last"></span>Última</span>
    </div>
  `
}

function infoOverlay(): string {
  return `
    <div class="ig-menu ig-if-menu">
      <span>${chip('1')}Línea 1</span>
      <span class="ig-if-opt">${chip('4')}Línea 4</span>
      <span>${chip('8')}Línea 8</span>
    </div>
  `
}

/* ------------------------------------------------------------------ *
 * Montaje                                                              *
 * ------------------------------------------------------------------ */

const SCREENS: Record<IgTab, { title: string, body: () => string, overlay: () => string, lit: IgTab, to?: IgTab }> = {
  inicio: { title: 'Inicio', body: inicioBody, overlay: inicioOverlay, lit: 'inicio' },
  buscar: { title: 'Buscar', body: buscarBody, overlay: buscarOverlay, lit: 'buscar' },
  seguimiento: { title: 'Seguir', body: seguirBody, overlay: seguirOverlay, lit: 'inicio', to: 'seguimiento' },
  trafico: { title: 'Tráfico', body: traficoBody, overlay: () => '', lit: 'inicio', to: 'trafico' },
  info: { title: 'Info', body: infoBody, overlay: infoOverlay, lit: 'info' },
}

/**
 * La infografía de una pestaña, lista para insertar.
 *
 * Lleva `data-key` con la pestaña: el repintado incremental (`dom.ts`) reutiliza
 * un nodo con la misma clave, así que la animación no se reinicia en cada
 * refresco de la app, y al cambiar de pestaña se crea uno nuevo que empieza
 * desde el principio en vez de heredar el bucle a medias.
 *
 * `paused` la deja quieta (dentro de un panel plegado no tiene sentido que
 * siga moviéndose).
 */
export function renderInfographic(tab: IgTab, paused = false): string {
  const guide = igGuide(tab)
  const screen = SCREENS[tab]

  return `
    <figure class="ig ig--${tab}${paused ? ' is-paused' : ''}" role="img" aria-label="${ARIA[tab]}" data-key="ig-${tab}">
      <div class="ig-stage" aria-hidden="true">
        ${topbar(screen.title, screen.to ? 'Inicio' : undefined)}
        <div class="ig-body">${screen.body()}</div>
        ${tabbar(screen.lit, screen.to)}
        ${screen.overlay()}
        ${finger()}
      </div>
      <div aria-hidden="true">${captions(guide)}</div>
    </figure>
  `
}
