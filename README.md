# SALBUS

Aplicación Android (Capacitor + Vite + TypeScript) para consultar los tiempos de
llegada de los autobuses urbanos de Salamanca, seguir un autobús por su recorrido
y medir la puntualidad real de una línea.

## Estructura

```
src/
  main.ts                  Arranque, enrutado, motor de refresco y avisos
  dom.ts                   Repintado incremental (no recrea el DOM en cada tick)
  state.ts                 Estado de la app y persistencia en localStorage
  views.ts                 Las seis pantallas y las hojas inferiores
  ui.ts                    Iconos, formato y componentes compartidos
  style.css                Sistema de diseño (tokens, claro/oscuro)
  services/
    arrivals.ts            Cliente de llegadas con cola y control de ritmo
    arrival-parser.ts      Lectura del panel oficial (sin red: se puede probar)
    punctuality.ts         Detección de pasos reales y desvío frente al horario
    bus-position.ts        En qué parada está el autobús (regla compartida)
    routing.ts             Paradas cercanas y cálculo de rutas (experimental)
    streets.ts             Callejero peatonal: por dónde se anda de verdad
    network.ts             Red oficial de líneas, sentidos y paradas
    schedule.ts            Horario programado a partir del GTFS estático
    gtfs-feed.ts           Descarga, validación y elección del GTFS oficial vigente
    notifications.ts       Notificaciones locales
    widget.ts              Puente con el widget de la pantalla de inicio
public/data/
  network.json             Red oficial generada (27 líneas · 80 sentidos)
  streets.json             Callejero peatonal de OpenStreetMap (carga diferida)
  gtfs.zip                 GTFS estático incluido: reserva si no hay uno descargado
android/                   Proyecto nativo, servicio en primer plano incluido
  app/src/main/java/com/icuas/salbus/
tools/                     Generadores y comprobaciones
```

### El nombre

Todo se llama **SALBUS**: la app, la carpeta del proyecto, `package.json`, el
paquete de código Java (`com.icuas.salbus`) y el `namespace` de Gradle.

Con **una excepción deliberada**: el `applicationId` de Android sigue siendo
`com.icuas.bussalamanca` y no puede cambiar nunca. Ese identificador *es* la
identidad de la app instalada; con otro, el sistema ve una aplicación distinta,
la instalada deja de tener ruta de actualización, quedan dos iconos y las
paradas, avisos e historial —que viven en el almacenamiento de ese
identificador— se quedan en la vieja. Por eso `appId` en `capacitor.config.ts`
tampoco se toca: Capacitor lo copia tal cual al `applicationId`.

## Fuentes de información

Todo procede de **Salamanca de Transportes**:

| Dato | Origen | Actualización |
| --- | --- | --- |
| Llegadas en tiempo real | `salamancadetransportes.com/api/siri/arrivals?stop=<parada>` | En vivo |
| Líneas, sentidos y paradas | `salamancadetransportes.com/informacion-de-lineas/lineas/` | `npm run data:network` |
| Horario programado | GTFS oficial vía Mobility Database (`mdb-2823`); reserva: `public/data/gtfs.zip` | Solo, cada pocos días |
| Calles para los paseos | OpenStreetMap vía Overpass | `npm run data:streets` |

La página de líneas incrusta, por cada línea, los atributos
`data-paradas-trayecto-{uno..cuatro}` con la **secuencia ordenada de paradas de
cada sentido** (referencia, nombre y coordenadas). De ahí sale `network.json`,
que cubre las 27 líneas, sus 80 trayectos y las 349 paradas de la red.

### La fuente de llegadas cambió en 2026

Hasta septiembre de 2026 las llegadas se **raspaban del HTML** de
`/tiempos-de-llegada/?ref=<parada>`: una página PHP que traía ya pintado un
panel con una fila por línea («4 minutos», «LLEGANDO A PARADA»).

El sitio oficial se rehízo en Next.js y ese panel pasó a pintarlo el navegador
**después** de cargar la página. El HTML dejó de contener ninguna llegada, así
que el raspado devolvía siempre «La respuesta no contiene el panel de llegadas»
y **todas las paradas aparecían como «Sin conexión»** aunque hubiera cobertura.

Ahora se lee el JSON de `/api/siri/arrivals?stop=<parada>`, que es el que
consume la propia web. Trae **más** información que el panel anterior:

| Campo | Contenido |
| --- | --- |
| `lineCode`, `lineName` | Línea y su nombre (los códigos coinciden con `network.json`) |
| `expectedArrival` | **Hora** de paso prevista, con huso — no un contador ya redondeado |
| `aimedArrival` | Hora programada |
| `delay` | Desvío sobre el horario, duración ISO-8601 con signo (`-PT8M`) |
| `distance` | Distancia del vehículo a la parada (`"1234 m"`) |
| `vehicleId`, `latitude`, `longitude` | Identificador y **posición** del autobús |
| `directionName` | Sentido, con las referencias de cabecera y destino |

Dos consecuencias en el parser (`src/services/arrival-parser.ts`):

- **Los minutos se calculan**, restando la hora prevista al instante de la
  consulta, en vez de leerse. La hora de paso que se muestra ya no se deduce
  sumando minutos: la dice la fuente.
- **Hay que descartar la fila repetida de las cabeceras.** La fuente publica
  cada paso por sentido, y en una cabecera el mismo vehículo figura a la vez
  como el que llega y como el que sale. Si las dos filas caen en el mismo
  minuto son la misma expedición contada dos veces; si caen en minutos
  distintos (llega a y cuarto, sale a y media) son dos pasos de verdad.

Y un matiz de `«llegando»`: la web oficial lo marca por distancia (menos de
200 m). La distancia **sola** no vale, porque en una cabecera el autobús que
acaba de terminar está a veinte metros pero no sale hasta dentro de nueve
minutos. Hace falta además que quede un minuto o menos.

> El horario programado se usa en Info (horarios de cabecera), en la pantalla de
> puntualidad y, **solo si se pide a mano**, como estimación de llegada en una
> parada cuya fuente en vivo no contesta (botón «Ver tiempos estimados por
> horario», marcado ±5 min). Esas estimaciones nunca se mezclan con tiempos
> reales y desaparecen en cuanto la parada vuelve a recibir datos de la fuente.

### El horario oficial se descarga solo

Salamanca de Transportes publica su GTFS en el Punto de Acceso Nacional
(`nap.transportes.gob.es`, fichero 1598), pero ahí hace falta registro y clave.
Mobility Database lo replica a diario sin autenticación como **`mdb-2823`**, y
de ahí lo descarga la app (`GTFS_FEED_URL` en `src/services/gtfs-feed.ts`: si la
ruta cambia, basta con tocar esa constante). Cada versión cubre unas dos semanas.

- **Al arrancar** no se toca la red: se elige entre el feed descargado
  (IndexedDB, base `salbus-gtfs`) y el incluido (`public/data/gtfs.zip`). Gana el
  descargado si cubre hoy; si no, el que cubra hoy; si ninguno, el que termine
  más tarde, y la app avisa de que está caducado (`pickFeed`).
- **Cuándo se descarga** (`downloadDue`), al arrancar y cada vez que la app
  vuelve a primer plano: si no hay feed guardado, si el guardado no cubre hoy, si
  le quedan menos de 5 días o si la última descarga tiene más de 3 días. Tras un
  fallo, o tras bajar un feed que no mejora nada, se esperan 6 horas antes del
  siguiente intento automático. Nunca retrasa el arranque.
- **Validación** antes de adoptarlo: que sea un zip con `routes`, `trips`,
  `stop_times`, `stops` y `calendar` o `calendar_dates`; que declare fechas; que
  conozca al menos el 60 % de las paradas y de las líneas de `network.json`; que
  el horario se pueda construir (algún paso por parada), y que **sea más útil**
  que el que se usa (cubre hoy, o termina más tarde). Si algo falla se descarta y
  sigue el anterior.
- **Se cambia en caliente**: el horario nuevo sustituye al anterior sin
  reiniciar la app.
- Se guardan el zip y sus metadatos: fecha de descarga, rango de servicio
  (de `calendar.txt` y `calendar_dates.txt`) y `Last-Modified` si la fuente lo
  manda.
- En **Android** se descarga con `CapacitorHttp` (`responseType: 'arraybuffer'`,
  que el plugin nativo devuelve en base64), sin CORS. En el **navegador** se
  intenta un `fetch`; si la fuente no admite CORS falla y se sigue con lo que haya.
- Info y Ajustes › Acerca de y datos dicen de dónde sale el horario y sus fechas
  («Horario oficial del 15 al 30 de noviembre · actualizado hace 2 h»), avisan si
  está caducado, y Ajustes tiene el botón **Buscar horario nuevo**.

El incluido declara servicio del 2026-03-16 al 2026-03-31 (día a día en
`calendar_dates.txt`): ya solo es la reserva para el primer arranque sin
conexión. El servicio nativo de Android no lee el GTFS (los pasos medidos en
segundo plano se emparejan con el horario en la parte web), así que no necesita
recibir el feed descargado.

## Ritmo de consultas a la fuente

La web oficial está tras Cloudflare con un limitador por IP. Medido el
2026-08-17 contra el HTML `?ref=<parada>` y reverificado el 2026-09-19 contra
`/api/siri/arrivals?stop=<parada>`:

- responde **403** si el `User-Agent` no es de navegador (sigue igual);
- la API nueva contesta en **~0,4 s**, frente a los ~3 s de la página HTML;
- admite una ráfaga de **6–8 peticiones** desde reposo y luego devuelve **429**;
- se recupera en **6–10 s**;
- **1 petición cada 2 s se sostiene indefinidamente** sin ningún bloqueo.

> **Pasarse no cuesta un 429, cuesta un muro.** Insistiendo de verdad (unas 37
> peticiones en tres segundos, midiendo) Cloudflare deja de responder 429 y
> planta su **página de verificación**: un HTML con un **403** que dura varios
> minutos y afecta a **toda la IP**, no solo a la parada que se pidió. Por eso
> el cliente lo reconoce (`looksLikeChallenge`) y lo trata como saturación
> —espera, reintenta y conserva el último dato bueno— en lugar de como un
> rechazo, que dejaba la parada en «Sin conexión» y tiraba lo que ya sabía.

Por eso todas las consultas pasan por **una sola cola**, que lleva un cubo de
fichas calcado del de la fuente pero más corto (4 fichas, una cada 1,4 s, frente
a las 6–8 y ~1,2 s medidas), con caché por parada y espera progresiva ante un
429. Lo importante de ese modelo es que el límite no es un cronómetro: desde
reposo se puede pedir una ráfaga, y sostenidamente hay que bajar a ~1 cada 2 s.
Tratarlo como cronómetro —que es lo que se hacía— desperdiciaba la ráfaga
entera. Ver *El cupo de la fuente es una ráfaga, no un cronómetro*.


Consecuencia visible: en una lista larga los tiempos **no son de un mismo
instante**. Cada parada del recorrido de un aviso lleva a su derecha un punto con
la fase en la que está (`syncState` en `src/ui.ts`), y la tarjeta incluye la
leyenda de colores:

| Color | Significado |
| --- | --- |
| Azul, parpadeando | Se está consultando ahora |
| Aro ámbar | En cola, esperando turno |
| Verde | Dato de hace menos de un minuto |
| Gris | Dato más antiguo |
| Ámbar sólido | La fuente limitó la consulta (429) |
| Rojo | Sin conexión con la fuente |

El estado por parada vive en `state.stopSync`; lo alimentan `onStart`/`onFeed` de
`fetchStopsSequentially`.

### Qué se actualiza, cada cuánto y con qué condición

Todas estas frecuencias salen de repartir **una sola cola** entre funciones que
la quieren a la vez. Por eso la columna que manda no es «cada cuánto» sino
«cuándo»: casi todo está apagado la mayor parte del tiempo, y eso es lo que
permite que lo encendido llegue a tiempo.


| Qué | Cada cuánto | Cuándo |
| --- | --- | --- |
| Paradas guardadas | 45 s | Todas, cada vez que se abre Inicio y ninguna está desplegada |
| Parada desplegada | 15 s | Solo ella: al abrirla se corta el repaso de las demás |
| Ficha de una parada | 15 s | Buscador y mapa; el globo del mapa ya la adelanta |
| Aviso de próximo bus | 15 s | Solo si está activo; con la app cerrada, el servicio nativo |
| Por dónde viene · mirándolo | 20 s por parada | Las 8 paradas anteriores enteras, con la pestaña Seguir delante |
| Por dónde viene · de fondo | 30 s | Las mismas 8, pero parando en la parada donde aparezca el autobús |

| Puntualidad | 30 s (15 s con bus entrando) | Solo dentro de la franja del control |

Los números viven **una sola vez**, en `FRESHNESS` de `src/state.ts`. Ajustes →
*Frecuencias de actualización* los lee de ahí: contarlos en dos sitios acaba
siempre con dos cifras distintas, y la que se enseña es la que no se cumple.

### El cupo de la fuente es una ráfaga, no un cronómetro

La fuente oficial limita por IP con un **cubo de fichas**: admite unas 6–8
consultas seguidas desde reposo y luego repone a ~1 ficha cada 1,2 s (medido el
2026-08-17). El cliente lo trataba como un cronómetro —una consulta cada 2 s,
siempre— y con eso tiraba la ráfaga entera a la basura. Peor: el llamador
*además* esperaba cada respuesta antes de pedir la siguiente, así que la latencia
se sumaba al espaciado en vez de solaparse.

Ahora la cola lleva su propio cubo, deliberadamente **más corto que el medido**
(4 fichas y una cada 1,4 s), porque pasarse cuesta un bloqueo de 6–10 s y
quedarse corto solo cuesta esperar un poco más. Un 429 vacía el cubo y frena la
reposición al ritmo degradado, así que una ráfaga no puede encadenar bloqueos.

Medido contra la fuente real, mismo recorrido y misma sesión:

| | antes | ahora |
|---|---|---|
| 8 paradas de un recorrido, desde reposo | 29,5 s | **7,1 s** |
| Parada abierta con un repaso de fondo en marcha | 3,3 s | **1,0 s** |

Cero bloqueos en las dos medidas, y el cubo terminó con ficha de sobra.

### Lo que estás mirando no hace cola

De las cuatro fichas, **una no la puede gastar el tráfico de fondo**, y de los
huecos de peticiones en vuelo **hay uno reservado igual**. Las dos reservas
hacen falta: con solo la ficha, la parada recién abierta tenía ficha pero seguía
esperando a que terminara una de las peticiones en curso, y eso son los ~3 s que
tarda la fuente en contestar.

Y dentro de un lote cada parada lleva **su propia prioridad**, no una para todo
el lote (`priorityOf`). Entre diez paradas guardadas puede ir la que alguien
tiene abierta en pantalla; antes esperaba turno como las demás porque la
prioridad solo servía para ordenar lotes enteros entre sí.

### Qué se pide a la vez y qué no

- **A la vez** (`fetchStopsInParallel`) todo lo que no depende de nada: las
  paradas guardadas, la que está abierta, las de un control. Entran de golpe en
  la cola y es ella la que reparte el ritmo.
- **Una a una** (`fetchStopsSequentially`) solo la búsqueda del autobús hacia
  atrás, porque *decide si sigue preguntando según lo que devolvió la parada
  anterior*: para en la primera que lo tenga encima. Pedirlas a la vez sería
  perder justamente el ahorro que la hace barata.

Un dato se pinta como **«al día» durante 40 s** (`SYNC_FRESH_MS` en `src/ui.ts`).
Son el doble del ciclo de un recorrido activo, así que verde significa «entró en
uno de los dos últimos ciclos». Con el minuto de antes, una parada podía haberse
saltado dos ciclos enteros y seguir pintada de verde.

### El repaso de arranque

Al abrir la app se hace **una** pasada por todas las paradas guardadas
(`primeFavourites`). No es un capricho: la fuente tarda lo suyo, así que la
primera parada que se desplegaba se quedaba mirando un esqueleto. Esa espera se
adelanta al arranque, donde ya hay una pantalla de bienvenida y una lista que
mirar. Entran todas de golpe en la cola y es ella la que reparte el ritmo.


Es **una sola vez por sesión**, y no es la única pasada: al entrar en Inicio se
repasan también todas (ver abajo).

### Inicio pone al día todas las guardadas, salvo cuando abres una

Al entrar en Inicio se repasan **todas** las paradas guardadas. Es lo que hace
que desplegar una la abra con algo puesto en vez de un hueco vacío: la cola va a
dos segundos por consulta, así que un dato que no se haya pedido antes de tocar
la tarjeta se hace esperar delante de los ojos.

Y en cuanto se despliega una, **manda ella sola**: el repaso en curso se corta
(`cancelRefreshCycle` invalida el ciclo, y el lote se para en la siguiente parada
sin llegar a pedirla) y esa parada pasa a la cabeza de la cola con prioridad
alta. Sin eso, la parada recién abierta esperaba turno detrás de nueve que nadie
está mirando: veinte segundos de reloj delante de un hueco.

### Mientras se consulta, se dice

Una consulta tarda lo que tarda —hay una sola cola, a una petición cada dos
segundos— y ese rato, sin decir nada, se lee como que la app se ha colgado. La
lista de llegadas enseña una barra de progreso en dos casos, que para quien mira
significan lo mismo (*lo que hay en pantalla no es lo definitivo*):

- la parada está **en la cola** (esperando turno o ya pidiendo);
- el dato en pantalla **pasa del minuto** (`ARRIVALS_STALE_MS`), así que toca
  refresco aunque todavía no le hayan dado turno.

Sin ningún dato todavía va el esqueleto completo, con el motivo escrito
(*«Esperando turno en la cola de consultas…»*). Con dato puesto, la lista sigue
siendo legible —es lo mejor que se sabe— pero se atenúa un punto para que deje de
leerse como firme.


## Buscar: tres formas de llegar a la misma parada

**Parada**, **Mapa** y **Cerca**. Antes eran *Nombre*, *Línea* y *Mapa*, con las
paradas cercanas viviendo aparte, en la pestaña experimental.


**Nombre y Línea se fusionaron en una sola búsqueda.** Eran la misma pregunta
—dónde está esta parada— y obligaban a decidir cuál antes de escribir nada: quien
sabía el nombre no podía acotar por línea, y quien elegía línea se comía el
recorrido entero sin poder filtrarlo. Ahora el texto y el filtro de línea
conviven y se combinan:

- solo texto → paradas de toda la red que casan con lo escrito;
- solo línea y sentido → su recorrido, numerado en orden;
- los dos → ese recorrido filtrado por el texto, **conservando el número de
  orden real**, que es lo que dice si la parada va antes o después.

El filtro de línea va plegado, ocupando una línea que dice qué filtro hay puesto
—nunca se filtra sin saberlo—. Su estado lo lleva `state.search.lineFilterOpen` y
no un `<details>`: el repintado es incremental y borra los atributos que ya no
vienen en el HTML nuevo, así que un `open` puesto por el navegador se perdía en
el siguiente latido del reloj y el panel se cerraba solo cada segundo.

**Las paradas cercanas se mudaron aquí desde la pestaña Mapas, con su mapa.** De
allí venía el problema: al tocar una parada su ficha se abría por encima… con los
mandos del mapa montados sobre ella. Los botones de ampliar y centrar (z-index
1200), los controles de Leaflet (800) y sus globos (700) flotan sobre el mapa y
no sabían nada de la ficha, que se abre a 620.

Eso se arregla **en el propio mapa**, no quitándolo: `isolation: isolate` sobre
`.map-shell` encierra todos esos números puertas adentro y ordena el mapa entero
**como un bloque** frente al resto de la página; y, con la ficha abierta, se
apagan además sus mandos (`.is-behind-dialog`), porque un botón visible detrás de
un diálogo sigue pidiendo que lo toquen. Con eso resuelto el mapa se queda, que
es donde más dice: una lista de metros no sitúa, y saber si la parada está en tu
acera o al otro lado de la avenida sí.

El mapa de "Cerca" **reutiliza el mismo contenedor y la misma instancia de
Leaflet** que el modo "Mapa" (`#stop-map`): son dos vistas de la misma pantalla,
y dos instancias obligarían a mantener dos encuadres de acuerdo entre sí. Ahí ni
se agrupa ni se recorta —son ocho paradas contadas— y van numeradas con el mismo
criterio que la lista de abajo, para que las dos digan lo mismo: la 1 del mapa es
la 1 de la lista.

## Buscar por mapa

**Sin línea ni sentido elegidos el mapa enseña la red entera, pero no de
cualquier manera**: se agrupa y se recorta al encuadre (ver abajo). Es la forma
natural de usar un mapa —«esta es mi calle, esta es mi parada»— y antes obligaba
a saber de antemano qué línea pasa por ella. El botón «Ampliar» funciona también
ahí, que es justo donde más falta hace para acertarle con el dedo. Si ya se sabe
dónde estás, el mapa arranca centrado ahí: la parada que se busca en un mapa de
toda la ciudad casi siempre es una de las de al lado.

### Agrupar y recortar: por qué 349 chinchetas no caben

Dibujar las 349 paradas desde el zoom mínimo dejaba el mapa inservible, y no
tanto por lo que se veía —a esa distancia las chinchetas son una mancha— como por
lo que costaba: Leaflet no descarta nada por su cuenta, cada marcador es un nodo
del documento, y cada arrastre del dedo obliga a recolocarlos todos. Dos reglas
lo arreglan:

- **Agrupar por debajo de `CLUSTER_MAX_ZOOM` (16).** Las paradas caen en una
  rejilla cuya casilla se estrecha con cada nivel de acercamiento, así que los
  grupos se van partiendo solos hasta salir una a una. Cada grupo dice cuántas
  lleva dentro y, al tocarlo, encuadra su contenido: el mismo desglose de golpe.
  Un grupo de una sola parada no es un grupo y se dibuja como parada.
- **Recortar al encuadre.** Solo se dibuja lo que se está mirando, con un margen
  (`bounds.pad(0.35)`) para que arrastrar un poco no deje huecos. Medido: 349
  marcadores pasan a 33 con el mapa cerca, y a unas 65 formas —grupos más paradas
  sueltas— con la ciudad entera en pantalla.

Con un recorrido elegido **no se agrupa ni se recorta**: son treinta paradas, el
número de orden *es* la información y el trazado tiene que verse entero.

El repintado tiene su propia firma (`mapPaintKey`), aparte de la del encuadre
(`mapSignature`): son dos preguntas distintas —si hay que reencuadrar el mapa y
si hay que volver a colocar los marcadores— y acercar el mapa cambia la segunda
sin tocar la primera. El encuadre entra en la firma redondeado, o cada fotograma
de una inercia contaría como un encuadre nuevo.


Al abrir el globo de una parada **se lanza ya la consulta de sus tiempos**, antes
de pulsar «Ver tiempos». Quien abre el globo casi siempre acaba pulsando el
botón, y esa consulta tarda: adelantándola, para cuando se pulsa el dato suele
estar puesto. «Ver tiempos» ya no fuerza otra consulta si la que se adelantó
sigue fresca (`ensureStopFresh`), que era lo que anulaba la ventaja.

Al elegir línea y sentido el mapa pasa a **pantalla completa**, y se vuelve al
buscador con la ✕ de la esquina superior derecha. El contenedor `#stop-map` no
cambia de sitio en el árbol al ampliarse: solo cambia cómo se coloca (`.map-shell.is-expanded`),
porque moverlo obligaría a reconstruir Leaflet en cada apertura. Tras el cambio
de tamaño hay que llamar a `invalidateSize()` **antes** de `fitBounds()`: si no,
el encuadre se calcula con el tamaño anterior y el recorrido sale diminuto.

Las paradas se dibujan con chinchetas (`L.divIcon`) del color de la línea y su
número de orden en el recorrido. Como una línea entera solo cabe en pantalla muy
alejado, y ahí treinta chinchetas se solapan, el tamaño se escala con el zoom
(`applyZoomScale`: clases `is-far` e `is-mid` sobre el contenedor). Al pulsar una
parada se abre un globo con su nombre, su código y las líneas que pasan por ella;
los tiempos no van en el globo, porque abrirían una consulta por cada parada que
se tocara.

Lo que va encima de las teselas —grupos, chinchetas, «estás aquí»— lleva colores
fijos y no los del tema: las teselas de OpenStreetMap son siempre claras, también
con la aplicación en modo oscuro, y con `var(--surface)` los números salían azul
oscuro sobre azul oscuro.


## La tarjeta de una parada guardada

Dos exigencias que no caben juntas en una cabecera: enseñar **todas** las líneas
que pasan por la parada —son lo que la identifica de un vistazo— y que **todas
las tarjetas plegadas midan lo mismo**, o la lista se lee como si estuviera rota.

Entre el código, el nombre y los botones, a los distintivos les quedaban unos
90 px. La parada más concurrida de la red tiene **trece** líneas: ahí solo podían
salir cortados o con barra de desplazamiento. Por eso bajan a una **franja propia
de ancho completo**, con hueco fijo para dos filas: los trece entran con sitio de
sobra, y una parada de una sola línea ocupa exactamente lo mismo que una de
trece. Ese hueco de más es el precio de que la lista no suba y baje de escalón en
escalón.

La otra mitad del problema era el nombre. El bloque de texto reserva **dos
líneas**, que bastan para las 349 paradas de la red (la más larga son 47
caracteres y entra justa) y también para una parada renombrada, que enseña el
alias arriba y el nombre oficial debajo. Es un **mínimo, no un recorte**: en una
pantalla muy estrecha un nombre que necesite tres líneas se sigue leyendo entero,
porque plantarse en la acera equivocada es peor que una tarjeta desigual.

El botón de actualizar solo aparece **desplegada**. Plegada no se enseña ni un
tiempo, así que refrescar era pedirle a la fuente un dato que nadie iba a ver.

De las llegadas se enseñan **cinco** (`ARRIVALS_PREVIEW`); el resto se piden con
«Ver más». Esa vista compacta es la predeterminada y **se recupera sola**: el
estado guarda un único hueco de «desplegada» (`arrivalsExpandedStopId`, no un
registro por parada), y abrir cualquier parada lo vacía. Haber desplegado una no
deja desplegadas las que se abran después, que era lo que convertía la lista de
paradas guardadas en una tira interminable.

## Repintado de la interfaz

La pantalla se repinta una vez por segundo para envejecer los minutos y las
antigüedades. Ese repintado es **incremental** (`src/dom.ts`): se compara el HTML
nuevo con el DOM vivo y solo se tocan los nodos que han cambiado. Reescribir todo
con `innerHTML`, como se hacía antes, destruía el elemento sobre el que el
sistema había abierto un desplegable y lo cerraba al instante.

- `data-morph="skip"` marca lo que gestiona otro (el contenedor de Leaflet).
- `data-key` da identidad estable a los elementos de una lista.
- Los campos con el foco nunca se sobrescriben.

`npm run ui:stability` lo comprueba en Chrome: desplegable, tarjetas, foco,
texto escrito y posición del cursor tras varios ciclos de refresco.

## Medición de puntualidad

La fuente oficial no publica «el autobús ha pasado»: solo cuántos minutos faltan.
El paso se deduce en `src/services/punctuality.ts`:

1. **Armado**: el contador baja a 3 minutos o menos y se anota la hora estimada
   de paso (`ahora + minutos`).
2. **Paso por salto**: estando armado el contador sube 3 minutos o más, señal de
   que lo que se ve ya es la expedición siguiente.
3. **Paso por desaparición**: estando armado la línea deja de figurar en dos
   consultas seguidas (o en una si ya se rebasó la hora estimada).

La hora que se guarda es la **estimada con el contador**, no el instante en que
se detecta: con consultas cada 30 s, «ahora» llega tarde.

Cada paso se asocia a la salida programada más cercana **de la franja del control
y del sentido elegido** (±15 min). Los pasos sin salida cercana también se
guardan y se muestran aparte: son la señal más clara de que el horario oficial se
ha quedado atrás.

La medición **no necesita la app abierta**: dentro de la franja la lleva el mismo
servicio nativo que los avisos (ver [Funcionamiento en segundo plano](#funcionamiento-en-segundo-plano)).
La detección está portada a mano en `BusTrackingService.Monitor` con las mismas
constantes que `punctuality.ts`; `npm test` comprueba que no se separen, porque
si lo hicieran la misma parada mediría distinto según quién la estuviera mirando.

`npm run test:punctuality -- --stop 222 --line 4 --minutes 90` graba la fuente
real con el mismo parser y la misma lógica que la app, y escribe lo observado.

### Por qué a veces no se apunta ninguna hora

Una tabla vacía no dice nada de por qué está vacía, y los motivos son varios y
ninguno se ve desde fuera: la línea no figura en el panel de esa parada, la
fuente está limitando por IP, el móvil se durmió entre consulta y consulta, o el
paso **sí** se detectó pero el horario oficial no tenía ninguna salida cerca a la
que atribuirlo.

Por eso cada control lleva su **registro** (`state.monitorTrace`, desplegable en
su tarjeta). Cada consulta deja anotado lo que vio y lo que decidió con ello:
«faltan 5 min, todavía por encima de los 3 a los que se vigila», «la línea deja
de figurar, 1 de 2 consultas», «paso anotado a las 07:35, programado 07:32,
+3 min». Se guarda en disco, porque la franja se mide también con la app cerrada
y al volver a abrirla el registro es lo único que puede contar qué pasó.

Encima de eso hay un **vigilante** (`superviseMonitors`, un latido por segundo)
que hace lo que la detección de pasos no puede hacer sola, porque esa solo se
ejecuta cuando *llega* un dato:

- anota cuándo empieza y cuándo termina cada franja;
- **avisa cuando una franja abierta lleva más de 3 minutos sin una sola consulta
  buena**. Ese era el caso que dejaba la pantalla vacía sin explicación;
- sostiene una **notificación persistente mientras se mide**, con la línea, la
  parada, la hora de fin y los pasos anotados hoy. No es decorativa: declara al
  sistema que hay trabajo en curso, y sobre todo le dice a quien lleva el móvil
  por qué la app sigue despierta. La publica solo la web, y solo para los
  controles que **no** lleva el servicio nativo, que ya publica la suya.

## El aviso de próximo bus

Es la **única** función de seguimiento. Antes eran dos —el aviso, que
notificaba los minutos, y «ver por dónde viene», que dibujaba el recorrido— y
eran la misma pregunta partida en dos: quien espera un autobús quiere saber
cuánto falta **y** por dónde viene, no una cosa o la otra. Tenerlas separadas
obligaba además a elegir cuál de las dos gastaba el único turno disponible en la
cola de consultas.

Fusionadas, un aviso hace las dos cosas: publica su notificación persistente con
los minutos y el «a N paradas», y en su tarjeta dibuja las ocho paradas
anteriores con el autobús situado en una de ellas.

> Los «ver por dónde viene» que hubiera guardados **se retiran** al actualizar
> (`dropLegacyFollows`). No se convierten en avisos a propósito: un recorrido no
> publicaba notificación ni vibraba, y convertirlo pondría a sonar el móvil de
> quien nunca pidió que sonara.

| | Cuántos | Notas |
| --- | --- | --- |
| **Creados** | **2** | por ejemplo el de la ida y el de la vuelta; se conservan enteros y se alterna de un toque |
| **Actualizándose a la vez** | **1** | reanudar uno pausa automáticamente el otro |

Al crear uno por encima del tope se pregunta **cuál se sustituye**, en vez de
rechazar la acción.

**Solo uno se mantiene actualizado.** Un aviso activo consulta su parada cada
15 s y además rastrea las paradas anteriores; la fuente admite una petición cada
dos segundos. Con dos, los dos llegan tarde. Reanudar uno pausa el otro: no hay
nada que elegir ni ningún error que leer, y el botón lo avisa antes de pulsarlo.

Un aviso en pausa se conserva entero —parada, línea, sentido, autobuses ya
vistos— y vuelve de un toque. Lo que sí desaparece al pausar es **su
notificación**, y por eso desaparece: una notificación persistente que ya no se
actualiza es peor que ninguna, porque se queda enseñando una hora que dejó de ser
verdad. Su tarjeta tampoco dibuja el recorrido: sin consultas, las ocho filas
solo podrían enseñar un guion cada una.

### El aviso no se pausa solo: se degrada

Un aviso vive de sonar cuando **no** se está mirando la pantalla, así que
pausarlo al salir de su pestaña sería tanto como borrarlo. Lo que se ajusta es
cuánto rastrea, que es la parte cara:

| Dónde estás | Qué hace el aviso |
| --- | --- |
| En la pestaña Seguir | recorrido entero: 8 paradas cada 20 s, dibujadas una a una |
| En otra pestaña, o la app en segundo plano | solo el «a N paradas»: busca hacia atrás y para en la primera que tenga el autobús encima |
| Con una franja de puntualidad abierta | sigue dando la hora, pero no rastrea nada |

La última merece una nota. Medir a qué hora pasa de verdad un autobús exige no
perderse una sola consulta de **esa** parada, y dibujar un recorrido pide ocho
por ciclo. Pero apagar el aviso entero durante la franja sería apagar una
notificación que alguien está esperando, así que se le quita lo caro —el
rastreo— y se le deja lo esencial: la hora. La pestaña lo dice donde se ve.

## El widget de la pantalla de inicio

Entre **una y cuatro** paradas guardadas, y cada una es un atajo a «Avisarme del
próximo bus» de **esa** parada. Es lo único que hace: no enseña tiempos.

Que no los enseñe es una decisión, no una carencia. Un widget que dijera «3 min»
tendría que consultar la fuente por su cuenta, y la fuente **admite una petición
cada dos segundos por IP**: un widget refrescándose en segundo plano competiría
con el aviso de próximo bus y con la app abierta por el mismo cupo, y el precio
lo pagaría justo lo que sí es tiempo real. Lo que el widget ahorra es otra cosa:
los **cuatro toques** que separaban la pantalla de inicio de un aviso creado.

### Cuántas paradas se ven

**Lo decide el tamaño al que lo hayas estirado**, y nada más. El widget es
redimensionable, el lanzador avisa de cada estirón en
`onAppWidgetOptionsChanged`, y de la altura que reporta salen las filas:

| Alto | Paradas |
| --- | --- |
| 110 dp (2 celdas) | 1 |
| 180 dp (3 celdas) | 2 |
| 250 dp (4 celdas) | 3 |
| 320 dp (5 celdas) | 4 |

El mínimo son **dos celdas** porque en una sola no cabe una fila entera —nombre
y número de parada—, y una fila cortada por la mitad es peor que un widget algo
más alto. La división es hacia abajo por lo mismo: mejor un hueco al final que
una cuarta parada asomando.

**No hay un ajuste dentro de la app para esto**, a propósito. El tamaño ya se
elige arrastrando el widget; un número aparte en Ajustes permitiría pedir cuatro
paradas en un widget donde solo caben dos, y entonces habría que decidir cuál de
las dos cifras gana.

### Cómo se ve una parada

Cada fila lleva tres cosas, en este orden: el **número de parada** en una
insignia azul, el **nombre** en negrita y una **campana** al final. El número va
delante porque es lo que la gente se sabe de memoria y lo que distingue dos
paradas que se llaman parecido; antes era texto gris debajo del nombre, donde
pesaba lo mismo que él. La campana tampoco es un adorno: es lo que anuncia que
pulsar abre el aviso y no la ficha de la parada, y por eso la segunda línea pone
«Avisarme del próximo bus».

**Por debajo de 220 dp de ancho esa segunda línea se quita.** En un widget
estrecho no cabe entera y se quedaba en «Avisarme d…», que no dice nada y encima
le robaba el sitio al nombre. Y el ancho mínimo al que el lanzador deja
encogerlo es **180 dp**: más estrecho, la insignia y la campana se comen la fila
y el nombre desaparece del todo.

Las paradas van **centradas en vertical**. Las alturas de la rejilla no son
múltiplos exactos de una fila y siempre sobran dp: repartidos arriba y abajo no
se notan, amontonados al final dejaban el widget cojo.

### Verlo sin arrastrarlo al escritorio

Mirar un cambio de estética en el widget de verdad cuesta una instalación, una
visita al selector de widgets y un arrastre por cada tamaño y cada tema. La
compilación de **debug** trae una actividad que dibuja los mismos layouts a los
tamaños de la rejilla, todos en una pantalla:

```bash
cd android && gradlew installDebug
adb shell am start -n com.icuas.bussalamanca/com.icuas.salbus.WidgetPreviewActivity
adb shell cmd uimode night yes   # y el tema oscuro
```

No es el widget: no hay `RemoteViews` ni `PendingIntent`, porque lo que se
comprueba es cómo se ve, no a dónde lleva. Las filas se rellenan igual que en
`FavouritesWidget` y las paradas que caben salen de su misma
`rowsForHeight`. **Solo existe en debug**: el fusionador de manifiestos la añade
desde `app/src/debug`, y de la APK de release no forma parte.

### Por qué el widget no lee las paradas guardadas

Porque no puede. Las favoritas viven en el `localStorage` de la WebView y el
widget se dibuja **fuera** de ella: cuando el lanzador pide pintarlo, la app
puede llevar días sin abrirse y no hay ninguna página a la que preguntar.

Así que la app le deja una **copia** en `SharedPreferences` (`WidgetStore`) cada
vez que esa lista cambia —al guardar, al quitar y al renombrar— y en cada
arranque. El widget lee solo de esa copia, y por eso `updatePeriodMillis` es
**0**: no hay nada que caduque solo, y un refresco periódico solo gastaría
batería para volver a pintar lo mismo.

El nombre que se copia es el **mismo que se lee en Inicio**, alias incluido. Un
widget que llamara a la parada de otra forma que la app se leería como una parada
distinta.

Con la app recién instalada y nunca abierta la copia está vacía, y el widget lo
dice en vez de mentir con una lista a medias. Pulsar ese texto abre SALBUS, que
es exactamente lo que hace falta para llenarlo.

### El toque se pregunta, no se emite

Pulsar una parada abre la app con un intent propio
(`FavouritesWidget.ACTION_OPEN_STOP`) que lleva dentro el código de la parada, y
la web levanta con él la hoja de siempre. **La misma hoja**, incluida la pregunta
de cuál se sustituye cuando ya hay dos avisos: el widget es un atajo a una
función que ya existe, y dos versiones de la misma ventana acabarían ofreciendo
cosas distintas. La elección de línea y sentido necesita la red oficial, que solo
existe en la parte web, así que el widget no podría resolverla por su cuenta
aunque quisiera.

La parada **se pregunta** (`Widget.pendingStop()`), no llega por evento. Pulsar
el widget trae la app desde cero o desde segundo plano, y en los dos casos el
aviso llegaría antes de que la página tuviera oyentes. La parte nativa la guarda
y la web la recoge al arrancar y cada vez que vuelve a primer plano; al leerla se
olvida, porque si no, volver a la app dentro de tres días abriría la hoja de un
toque que ya se atendió.

Dos detalles que parecen menores y no lo son. El extra del intent **se borra**
tras leerlo: sin eso, girar el teléfono reconstruye la actividad, se vuelve a
leer el mismo intent y reaparece una hoja que ya se había cerrado. Y cada fila
lleva un **código de petición distinto**: dos `PendingIntent` se consideran el
mismo cuando coinciden acción, datos y código —los extras *no* cuentan—, así que
sin eso las cuatro paradas acabarían abriendo la primera.

## En qué parada está el autobús

**Se deduce contando paradas**, en `src/services/bus-position.ts`. Lo único que
delata una presencia física en los datos que maneja el localizador es que el
contador de una parada caiga a cero o uno. Todo lo demás es deducción.

> **Esto ya se puede hacer mejor.** Cuando se escribió, la fuente no publicaba
> posiciones: por cada parada decía «línea N, M minutos» y nada más. La API de
> 2026 trae `vehicleId`, `latitude` y `longitude` **en cada llegada**, así que
> el autobús se podría situar sin deducir nada y sin gastar una consulta por
> parada anterior. El localizador sigue contando paradas —es lo que había y
> funciona, y el servicio nativo lleva la misma regla portada a Java—, pero es
> el candidato obvio a rehacerse con el dato real.

La deducción es esta: se mira ese mismo indicio en las paradas **anteriores** del
recorrido —que salen de `network.json` en el orden real del trayecto, no por
cercanía geométrica— y se toma **la más avanzada** que lo cumpla.

Lo de «la más avanzada» no es un detalle de estilo. Las paradas de una ventana no
se consultan de golpe —el cupo de la fuente no da para tanto—, así que sus datos
**no son del mismo instante**: puede quedar un «llegando» rezagado de hace medio minuto y
otro más adelante recién traído. Como un autobús solo avanza, el índice mayor es
siempre la verdad más nueva. Por eso cada parada del recorrido de un aviso lleva
su punto de color: la diferencia de medio minuto entre dos renglones es el precio
de una fuente que no deja preguntar más deprisa, no un error.

Es **una sola implementación** para las dos funciones que cuentan paradas. Dos
acabarían situando el mismo autobús en dos sitios distintos con los mismos datos
delante.

### El aviso de próximo bus también cuenta paradas

La notificación dice, a continuación del tiempo, a cuántas paradas viene:

```
Línea 4 · En 7 min · a 4 paradas
Línea 4 · Llegando · en tu parada
```

Los minutos dicen cuándo llega; las paradas dicen si ese número se puede creer.
Un «en 2 min · a 5 paradas» avisa de que el contador va a dar un salto.

**La ventana son siempre las ocho paradas anteriores** (`ROUTE_WINDOW_STOPS`),
las mismas que dibuja la pestaña Seguir. Buscar cuesta peticiones contra una
fuente que solo admite una cada dos segundos, y salen del mismo turno que
necesita el tiempo de **tu** parada, así que ocho paradas no significan ocho
peticiones. Lo que cambia es hasta dónde hay que llegar dentro de la ventana:

- **Con la pestaña Seguir delante se recorre entera**, porque se dibuja parada a
  parada y hay que poder verlas todas.
- **Fuera de ella —otra pestaña, o la app en segundo plano— se busca de tu parada
  hacia atrás y se PARA en la primera que tenga el autobús encima.** Siendo la
  más cercana de las que lo tienen, es la más avanzada, y las de más atrás ya no
  cambian la respuesta. Con el autobús cerca —justo cuando el dato sirve— se
  encuentra a la primera o a la segunda consulta.
- **Por encima de 20 minutos no se busca** (`shouldScanRoute`). El autobús puede
  ni haber salido, «a trece paradas» no cambia lo que nadie va a hacer, y
  costaría la ventana entera justo cuando menos falta hace.

Lo que **ya no se hace** es recortar la ventana por los minutos que faltan. Ese
cálculo —«a minuto y medio por parada, con cinco minutos por delante basta con
mirar cuatro»— daba por sentado un ritmo fijo, y en cuanto el autobús acumulaba
retraso o tráfico la búsqueda se paraba antes de llegar a él: el aviso se quedaba
sin decir por dónde venía justo cuando más se pregunta. El coste real lo pone el
corte al encontrarlo, no un tope calculado de antemano.

En la app, el corte lo aplica el propio lote de refresco: las paradas del rastreo
entran en el plan marcadas con su aviso (`scan`), y en cuanto una devuelve el
autobús las que quedan de ese aviso se saltan sin pedirse (`shouldSkip`). El
servicio nativo hace lo mismo con su propio bucle, que sale en cuanto encuentra.

### Con el servicio vivo, la pantalla dibuja con lo que él ya consultó

**La web no consulta las paradas anteriores mientras el servicio está vivo**: dos
clientes contra una fuente que admite una petición cada dos segundos es justo lo
que la bloquea, y serían además dos recuentos capaces de discrepar. Pero el
servicio se quedaba el dato para él: consultaba esas paradas, sacaba su «a 4
paradas» y tiraba lo demás. Resultado en el móvil: el recuento salía bien y el
recorrido dibujado salía con **siete rayas y un solo tiempo**, el de la parada
del aviso.

Se arregla sin una sola petición más, por los dos lados:

- **El servicio comparte lo que ve.** Cada barrido emite un evento `routeUpdate`
  con lo que encontró en cada parada, y la web lo mete en la misma caché
  (`state.feeds`) que usa todo lo demás, así que el recorrido se dibuja con el
  código de siempre. Una parada donde esa línea no aparece no se guarda como
  hueco sino como «por aquí no viene», que es dibujable y distinto de «todavía no
  se ha mirado».
- **La web le dice si se está mirando** (`setRouteWatch`, desde `goToTab` y desde
  `visibilitychange`). El servicio no puede saber qué pestaña hay delante, y la
  diferencia le cambia el trabajo: mirándolo recorre la ventana entera porque hay
  ocho paradas que dibujar; sin mirarlo vuelve a parar en el autobús, que es todo
  lo que necesita la notificación.

Un 429 **interrumpe** la búsqueda en vez de seguir hacia atrás: dar por
descartada una parada que no se ha llegado a mirar dejaría el autobús «más lejos»
de lo que está. Y la localización caduca a los dos minutos: un autobús en marcha
deja de estar donde estaba, así que se calla en vez de envejecer el número.

**Hace falta saber el sentido**, porque las paradas anteriores solo existen
dentro de un recorrido concreto, y la fuente nunca dice hacia dónde va el
autobús. Sale de dos sitios, en este orden:

1. **De la red oficial**, cuando la respuesta es única. Por el **93 %** de los
   pares parada-línea pasa un solo sentido y no hay nada que decidir. Los
   trayectos parciales no cuentan como duda: son variantes del mismo sentido.
2. **De quien crea el aviso**, cuando no lo es. En el 5 % de paradas por las que
   la línea pasa en los dos sentidos, la hoja de «Avisarme del próximo bus»
   añade el desplegable de sentido. Deducirlo ahí sería jugárselo a cara o cruz
   y mandar a mirar a la acera de enfrente; preguntarlo no cuesta nada, porque
   **quien está esperando ya sabe cuál es su autobús** —es el que quiere coger—.

Ese desplegable **solo aparece cuando hay algo que elegir**: preguntarlo en el
93 % restante sería una pregunta sin respuestas. Y el sentido elegido no filtra
el aviso, solo sirve para contar paradas: la fuente publica «Línea 4, 7 minutos»
sin decir hacia dónde va, así que la notificación suena con cualquier autobús de
la línea. La hoja lo dice donde se elige, para que nadie cuente con un filtro que
no existe.

Los avisos guardados de antes reciben el sentido al arrancar solo si no admite
duda (`backfillTrackingDirections`). Los de una parada con dos sentidos se quedan
sin él: nadie llegó a elegirlo, y ponerlo entonces sería adivinar. Se arreglan
volviendo a crear el aviso, que ya lo pregunta.

Con la app cerrada quien busca es el servicio nativo, que lleva la regla portada
a mano en `BusTrackingService.sweepRoute` (barre cada 30 s, no en cada ciclo) y
recibe el recorrido ya resuelto en `BusTracking.sync`: la red de líneas es un
JSON que solo existe en la parte web. Mientras el servicio vive, la web **no**
busca en paralelo —serían el doble de peticiones y dos recuentos capaces de
discrepar— y se limita a reflejar el suyo. `npm test` comprueba que las
constantes de las dos copias no se separen.

## Mapas (experimental)

Pestaña **apagada de fábrica**. Se enciende en Ajustes → Experimental, y apagada
no existe: no aparece en la barra, no se puede abrir aunque quedara guardada como
última pestaña, no crea ningún mapa y no pide la ubicación. Al apagarla —incluso
estando dentro— se sueltan en el acto el mapa, el `watchPosition` y lo calculado.

Una sola función: **el planificador de rutas**. Las paradas cercanas vivían aquí
y se mudaron a Buscar, que es donde se busca una parada —y donde, además, no hay
un mapa montándose sobre la ficha—.

**La ubicación es de la app, no de esta pestaña.** Vive en `state.geo` y la usan
las dos pantallas: las paradas cercanas de Buscar y el «desde mi ubicación» de
las rutas. Antes vivía dentro de `state.maps`, que se vacía entero al salir de la
pestaña, así que cambiar de pantalla obligaba a volver a localizar.

Se obtiene con `navigator.geolocation`; en Android es Capacitor quien saca el
diálogo del permiso al llamarla, así que no hace falta plugin propio, solo
`ACCESS_COARSE_LOCATION` y `ACCESS_FINE_LOCATION` en el manifiesto. Se piden
**las dos** cosas: `getCurrentPosition`, que responde enseguida (vale incluso una
lectura cacheada), y `watchPosition`, que la va afinando. Solo con el seguimiento
la primera posición puede tardar o no llegar según el sistema y la pantalla se
queda en "Buscando tu ubicación…" —pasó en las pruebas—; solo con la lectura
suelta, las "paradas más cercanas" salían de otro barrio, porque el primer dato
trae cientos de metros de error. Una posición peor nunca pisa a una mejor, o las
paradas se moverían hacia atrás en pantalla. El `watchPosition` se suelta cuando
no queda ninguna de las dos pantallas mirando.

Los mapas llevan **botón de ampliar**, igual que el del buscador y por el mismo
mecanismo: el contenedor no se mueve del árbol, solo cambia cómo se coloca,
porque moverlo obligaría a reconstruir Leaflet.


Cuando la ubicación no llega, la app **distingue qué falta y lleva hasta allí**.
El interruptor general de ubicación del teléfono y el permiso de SALBUS son dos
cosas distintas que desde la página se ven igual —la geolocalización no
responde— y se arreglan en pantallas distintas del sistema. Se le pregunta al
sistema en vez de suponerlo (`DeviceSettings.isLocationEnabled`), porque un GPS
que tarda bajo techo da exactamente el mismo error que uno apagado, y el botón
que aparece abre la pantalla concreta: los ajustes de ubicación, o la ficha de
permisos de la app. Decir «activa la ubicación» sin llevar hasta donde se activa
deja el problema donde estaba.

Origen y destino se eligen entre "mi ubicación" y las paradas de la red; no hay buscador de calles porque no hay geocodificador sin conexión. El
cálculo (`src/services/routing.ts`) es un Dijkstra sobre las paradas donde el
coste es el TIEMPO: cada arista de autobús va de la parada de subida a la de
bajada de un mismo sentido, así que el camino ya sale troceado en tramos. Hay
penalización por transbordo (cambiar de autobús cansa: sin ella el cálculo
proponía dos saltos para ganar un minuto) y tope de dos.

El tiempo dentro del autobús se **estima** con la distancia real entre paradas
del recorrido a 17 km/h más una espera por parada. El GTFS daría minutos
exactos, pero son 543.000 filas y cambia cada dos semanas: indexarlas por trayecto encarecería el
arranque de TODA la app por una función experimental. La espera en parada sí sale
del horario cuando lo hay, como frecuencia (mediana de los huecos entre salidas
de la franja, dividida entre dos) y no como "la próxima salida a las 08:12": una
hora concreta de un feed que no se ha podido renovar acaba siendo mentira, una frecuencia envejece
mucho mejor.

### Los paseos van por las calles

El cálculo medía los tramos a pie **en línea recta**. En una ciudad eso no es una
aproximación: entre dos puntos separados 200 m en el mapa puede haber un río, una
vía de tren o una manzana entera, y el error iba **siempre** en la misma
dirección —a menos—, porque la recta es el camino más corto que existe.

`public/data/streets.json` es el callejero peatonal de Salamanca sacado de
OpenStreetMap (`npm run data:streets`): unos 100.000 nodos y 123.000 tramos, ~2 MB.
Van en enteros de millonésimas de grado y **diferenciales** respecto al nodo
anterior, con los nodos ordenados por posición, así que casi todos los números
son de tres o cuatro cifras en vez de ocho. El JSON crudo de Overpass eran varias
decenas de megas.

**No se carga al arrancar.** Lo pide `src/services/streets.ts` la primera vez que
se entra en «Rutas», una sola vez por sesión. Que una función en pruebas
encareciera el arranque de toda la app sería lo contrario de lo que se busca. Si
el fichero no está, la ruta sale igual con la estimación en recta y lo dice: cada
tramo a pie que no se haya medido por las calles lleva la coletilla «en línea
recta».

El camino se resuelve con un **A\*** sobre listas de adyacencia planas y un
montículo binario. Con cien mil nodos, una cola que se reordena en cada inserción
convertía un cálculo de milisegundos en varios segundos con la pantalla
congelada; y la estimación (distancia en recta) nunca puede pasarse, que es la
condición para que el primer camino encontrado sea de verdad el más corto.

**El afinado se hace después de elegir la ruta, no dentro del cálculo.** Es una
cuestión de coste: el Dijkstra de `planRoute` evalúa paseos entre cientos de
pares de paradas, y resolver cada uno sobre el callejero dejaría la pantalla
parada varios segundos. Un itinerario ya elegido tiene dos o tres tramos a pie, y
esos sí se miden exactos —son los que se leen y se andan—. La contrapartida está
dicha y se compensa: como la recta se queda corta siempre, una ruta podía ganar
por medio minuto gracias a un paseo que en realidad cruzaba una manzana; por eso
`refineWalking` devuelve minutos nuevos y **se vuelve a ordenar con ellos**. Si la
alternativa pasa a ser mejor, es la alternativa la que se recomienda.

Los transbordos ya se valoraban y se siguen valorando igual: penalización fija de
4 minutos además de la espera real (cambiar de autobús cansa y se falla) y tope
de dos. Lo que cambia es que ahora el paseo del transbordo se mide por donde se
cruza de verdad.

> Lo experimental no le quita recursos a lo demás: esta pestaña **no consulta ni
> un solo tiempo de llegada**. Esa fuente limita por IP y su cola es para el
> aviso de próximo bus. La única consulta que hace es la de la ficha de una
> parada, y solo cuando se toca a propósito.

## Funcionamiento en segundo plano

Los avisos de «próximo bus» los mantiene un **servicio en primer plano** nativo
(`BusTrackingService`), no el WebView: Android congela los temporizadores de la
página al pasar a segundo plano. El servicio recibe solo los avisos activos —uno, por
definición—, con su notificación y su cuenta de autobuses, y los consulta **en
serie** dentro de cada ciclo y envía los datos a la interfaz mediante el plugin `BusTracking` para
que pantalla y notificaciones digan siempre lo mismo.

La web manda siempre la **lista completa** de avisos activos (`BusTracking.sync`),
nunca altas y bajas sueltas: así las dos partes no pueden discrepar sobre cuántos
avisos hay vivos.

Un aviso detenido desde el botón «Detener» de su notificación queda anotado en
las preferencias del servicio. Al volver a abrir la app se leen esas bajas y el
aviso se retira: antes la app veía su aviso guardado, no encontraba el servicio
vivo y lo revivía, con lo que reaparecía la notificación que se acababa de
quitar.

Cuando faltan 3 minutos el móvil da una **vibración corta**, una sola vez por
autobús (se rearma cuando ese autobús pasa). Se desactiva desde Ajustes.

La notificación del aviso enseña **cinco datos y ninguno repetido**: la línea, el
tiempo que falta y a cuántas paradas viene el autobús en el título, la dirección
y la hora de la última actualización en el cuerpo. El recuento de paradas
aparece solo cuando consta (ver [En qué parada está el
autobús](#en-qué-parada-está-el-autobús)): la fuente no publica posiciones, así
que unas veces se deduce y otras no, y un hueco en blanco haría pensar que la app
se ha quedado colgada. El aviso de «ya ha pasado» lo publica **solo** el
servicio; la web se lo salta cuando el cierre viene de él (`finishTracking(id,
true)`), porque publicando los dos salían dos notificaciones idénticas.

### Puntualidad con la app cerrada

Los controles de puntualidad viajan en el mismo `BusTracking.sync`. Dentro de su
franja el servicio los consulta cada 30 s (cada 15 s con un autobús ya entrando)
y sostiene un **WakeLock parcial**: sin él el móvil se duerme entre consulta y
consulta y se pierde justo el paso que se quería medir.

Entre franja y franja el servicio **se apaga del todo**. Quedarse esperando en
primer plano agotaría el tope diario de horas que Android 15 le pone a un
servicio de tipo `dataSync`, y lo agotaría sin haber medido nada. Quien lo trae
de vuelta es una alarma (`setAndAllowWhileIdle`, sin permiso de alarma exacta)
que despierta a `BusTrackingReceiver`; ese receptor arranca el servicio dentro de
los segundos de permiso que el sistema concede al entregar la alarma, y si el
sistema se niega reprograma en lugar de tumbar la app. El mismo receptor atiende
al arranque del móvil, que se lleva por delante servicio y alarmas.

Las franjas se guardan en las preferencias del servicio, así que se siguen
midiendo aunque la app lleve días sin abrirse. Los pasos detectados se anotan
también en disco y la app los recoge con `takePasses`, que los **entrega y los
borra a la vez**: leerlos sin borrarlos los contaría otra vez en el siguiente
arranque. El emparejado con el horario programado se hace en la web, que es donde
vive el GTFS. Mientras el servicio lleva un control, la web no detecta pasos de
ese control: hacerlo en los dos sitios apuntaría el mismo autobús dos veces.

El icono pequeño de la notificación (`res/drawable/ic_stat_salbus.xml`) es una
silueta monocroma **sin fondo**: Android descarta el color y usa solo el canal
alfa, así que un icono con fondo se vería como un cuadrado blanco.

## Actualización automática

> **Seis horas de espera y diez días de plazo.** Una versión nueva no se ofrece
> sola hasta seis horas después de publicarse (`RELEASE_GRACE_MS`); la búsqueda
> manual de Ajustes se salta esa espera. Desde que sale la
> primera versión que la instalada no tiene, hay diez días para actualizar
> (`MANDATORY_AFTER_MS`): pasados, la ventana de actualizar ya no tiene X ni
> «Ahora no». Los diez días se cuentan con la lista de releases
> (`/releases?per_page=30`), así que una publicación nueva no reinicia la cuenta;
> si la lista no llega, se cuenta desde la última publicada. Sin conexión no se
> bloquea nada: sin poder descargar, obligar solo dejaría la app inservible.

> **Qué versión tengo instalada lo dice el sistema**, no el número que Vite
> incrusta en el bundle. Ese número se queda congelado si la WebView sirve una
> copia vieja de la página, y con él la app se ofrecía a sí misma la
> actualización que acababa de instalar, en bucle. `Updater.currentVersion()`
> lee el `PackageManager`, que además delata una instalación que no llegó a
> completarse en vez de darla por buena.
>
> Y una descarga guardada **sólo vale para su versión**: el plugin lee el
> `versionCode` del propio APK con `getPackageArchiveInfo()`. Antes servía para
> cualquier release, así que quien tenía un APK a medio instalar de una versión
> anterior pulsaba «Instalar», reinstalaba la vieja, y volvía a ver el mismo
> aviso al abrir.
>
> **El `versionName` es el del commit que marca la versión.** Aquí las versiones
> se marcan escribiendo su nombre como título del commit (`v5.1`, `v5`, `4.9`),
> así que el nombre ya está escrito: repetirlo en `package.json` era escribirlo
> dos veces, y las dos copias acabaron diciendo cosas distintas —los commits iban
> por la v5.1 con `package.json` todavía en la 4.8.0—. Se busca hacia atrás el
> primer título que sea sólo dígitos y puntos, porque después de marcar una
> versión pueden venir commits normales, que no renombran nada. `package.json`
> queda de reserva para cuando se compila desde un zip, sin historia de git.
>
> Dos releases seguidas pueden llamarse igual —ningún commit nuevo marcó
> versión—. Lo que las distingue siempre es la **compilación** (`-b1018`), y por
> eso la ventana de aviso y la pantalla de Ajustes la enseñan.
>
> **Cualquier versión instalada salta directamente a la última.** No hay cadena
> de actualizaciones que seguir: la app consulta siempre `/releases/latest` y
> compara ese `versionCode` con el que le dice el sistema, sea el que sea. Una
> instalación de hace veinte publicaciones se pone al día en un solo paso, igual
> que la de ayer. Es lo que se gana con un `versionCode` que sólo crece y un APK
> completo por release —no diferencial—: no existe un salto intermedio que se
> pueda quedar a medias.

Un `git push` a `main` acaba convertido en una actualización instalada en el
móvil. El workflow `.github/workflows/release.yml` compila y **firma** la APK,
la publica como release, y la app la ofrece al abrirse.

```
git push a main
      │
      ▼
GitHub Actions ── compila y firma ──▶ Release (tag: v<versionName>-b<versionCode>)
      │
      ▼
La app, al arrancar
   1. GET api.github.com/.../releases/latest   (JavaScript, con CORS)
   2. compara versionCode con el suyo
   3. descarga la APK                          (Java, sin CORS)
   4. lanza el instalador del sistema
      │
      ▼
1 toque → instalada, datos intactos
```

**Android no permite que una app normal instale nada en silencio.** Eso exige
ser *device owner* o app de sistema. Comprobar, descargar y preparar sí es
automático; el último paso es un diálogo del sistema que se confirma a mano.

### La trampa del CORS

La app corre en una WebView cuyo origen es `localhost`, así que todo `fetch`
está sujeto a CORS:

| Petición | ¿Manda `Access-Control-Allow-Origin`? |
| --- | --- |
| `api.github.com/.../releases/latest` | **Sí**, `*` |
| La URL de descarga de un asset | **No** (redirige a `release-assets.githubusercontent.com`) |

Por eso el `versionCode` publicado sale de la **etiqueta** de la release
(`v4.3.0-b1007` → 1007), que ya viene en la respuesta de la API, y no de un
`latest.json` adjunto que la WebView no podría leer. La APK sí se descarga del
asset, pero eso lo hace `UpdaterPlugin.java`, que no pasa por CORS.

### El versionado

`versionCode` = `VERSION_CODE_BASE` + número de commits. Crece solo en cada
push, sin que haya que acordarse de subirlo. La base es **1000** porque las
versiones anteriores a este sistema llegaron a mano hasta la 430, muy por
encima del número de commits: sin ella la primera release automática habría
salido por debajo de lo ya instalado y el móvil no la habría reconocido.

`versionName` = el título del último commit que sea un nombre de versión
(`git log -200 --pretty=%s`, primer título que sean sólo dígitos y puntos:
`v5.1`, `v5`, `4.9`). Las versiones aquí se marcan así, escribiendo el nombre en
el commit, de modo que el nombre ya está puesto y no hay que escribirlo otra vez
en `package.json` —que es lo que llevó a que los commits fueran por la v5.1 con
`package.json` en la 4.8.0—. Se busca hacia atrás porque después de marcar una
versión pueden venir commits normales: la versión sigue siendo la misma, con un
`versionCode` mayor, hasta que otro commit la renombre.

Las dos fórmulas viven por duplicado, en `tools/version.mjs` (que alimenta al
bundle vía `vite.config.ts` y al workflow) y en `android/app/build.gradle`,
porque Gradle no puede importar JavaScript. **`npm test` comprueba que las dos
coinciden**: si se separan, la app compara su `versionCode` contra otro número
y el canal falla en silencio, o enseña un nombre distinto del que se publicó.

*Contrapartida:* no se puede reescribir la historia de `main`. Un rebase o un
`push --force` que reduzca el número de commits deja las releases nuevas por
debajo de lo instalado.

### El fallo silencioso

La comprobación del arranque **calla sus errores**: sin cobertura, o con
GitHub limitando por peticiones, la app sigue funcionando sin molestar. El
precio es que un fallo real se ve exactamente igual que «no hay novedades».

Por eso Ajustes → *Actualizaciones* incluye una comprobación **manual** que sí
cuenta lo que ocurre: versión encontrada, ya al día, o el error exacto. No es
un adorno; es la única forma de distinguir «no hay nada» de «está roto».

### La clave de firma

Android identifica una app por `applicationId` + firma. Una APK firmada con
otra clave no es una actualización sino una app distinta, y la instalación
falla con `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

- La clave vive **fuera del repositorio**, en `../salbus-keystore/`.
- `android/keystore.properties` y `*.jks` están en `.gitignore`.
- En CI viaja como secret en base64 y se reconstruye en el runner.
- **Si se pierde, ningún dispositivo con la app instalada podrá actualizarse
  nunca más**: habría que desinstalar y reinstalar, perdiendo los datos locales.

Secrets necesarios en *Settings → Secrets and variables → Actions*, pestaña
**Secrets** (no *Variables*): `SALBUS_KEYSTORE_BASE64`,
`SALBUS_KEYSTORE_PASSWORD`, `SALBUS_KEY_ALIAS`, `SALBUS_KEY_PASSWORD`.

El repositorio debe ser **público**: la app consulta la API sin credenciales y
en uno privado recibiría un 404 y no ofrecería nada nunca. Meter un token en
la APK no es una opción, porque cualquiera puede extraerlo.

### Compilar una release a mano

```powershell
npm run build
npx cap sync android
cd android; .\gradlew.bat assembleRelease
```

Sin clave de firma disponible la tarea **falla a propósito**, en vez de
producir una APK firmada en debug que ningún móvil aceptaría como
actualización.

## Comandos

```bash
npm install

npm run dev            # navegador (usa el proxy de vite.config.ts)
npm run build          # comprobación de tipos + empaquetado

npm test               # comprobaciones de lógica con fixtures
npm run test:live      # además consulta la fuente oficial
npm run ui:check       # detecta desbordes de maquetación
npm run ui:stability   # el refresco no destruye la interfaz
npm run test:punctuality -- --stop 222 --line 4   # graba la fuente real

npm run data:network   # regenera public/data/network.json
npm run data:streets   # regenera public/data/streets.json (OpenStreetMap)
npm run assets:icons   # regenera iconos y splash desde public/favicon.svg

npm run android:sync   # build + cap sync
npm run android:build  # genera el APK de depuración
npm run android:open   # abre Android Studio
```

## Mantenimiento

- **Red de líneas**: `npm run data:network` cuando cambien recorridos o paradas.
- **Callejero**: `npm run data:streets` de tanto en tanto; OpenStreetMap cambia
  poco y una calle nueva solo afecta a la pestaña experimental.
- **Horario programado**: se actualiza solo (ver «El horario oficial se descarga
  solo»). Si Mobility Database cambia la ruta, actualizar `GTFS_FEED_URL` en
  `src/services/gtfs-feed.ts`. Sustituir `public/data/gtfs.zip` por un feed
  reciente solo mejora el primer arranque sin conexión; conviene que siga
  encajando con `network.json`.
- **Icono**: editar `public/favicon.svg` y `public/icon-mono.svg`, después
  `npm run assets:icons`.
