package com.icuas.salbus;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Servicio en primer plano que mantiene vivos los avisos de "proximo bus".
 *
 * Es la unica forma fiable de seguir actualizando en Android cuando la app pasa a
 * segundo plano: los temporizadores del WebView se congelan, pero un servicio en
 * primer plano con notificacion persistente sigue ejecutandose.
 *
 * Desde la v4.4 puede llevar mas de un aviso a la vez (hasta {@link #MAX_JOBS}).
 * Cada uno tiene su propia notificacion y su propia cuenta de autobuses, y se
 * consultan en serie dentro de cada ciclo para no disparar dos peticiones
 * simultaneas contra una fuente que limita por IP.
 *
 * El seguimiento de un aviso no termina con el primer autobus: cuenta los pasos
 * reales de la linea y sigue avisando del siguiente hasta completar
 * {@link #targetBuses}, salvo que se detenga a mano antes.
 *
 * El servicio lleva ademas los CONTROLES DE PUNTUALIDAD: miden cuando pasa de
 * verdad una linea por una parada dentro de una franja horaria, y
 * eso solo sale bien si se consulta sin parar durante toda la franja: con la app
 * en segundo plano el WebView se congela y se perdia justo el paso que se queria
 * medir. Dentro de la franja el servicio consulta y mantiene el movil despierto
 * con un WakeLock parcial; fuera de ella se queda en espera y despierta con una
 * alarma del sistema al empezar la siguiente, sin gastar bateria mientras tanto.
 *
 * Los pasos detectados se guardan en disco y la app los recoge cuando vuelve a
 * abrirse ({@code takePasses}): el emparejado con el horario oficial necesita el
 * GTFS, que vive en la parte web.
 */
public class BusTrackingService extends Service {

    /** Sustituye la lista de avisos vivos por la que llega en el intent. */
    public static final String ACTION_SYNC = "com.icuas.salbus.TRACKING_SYNC";

    /** Detiene el servicio entero (lo pide la app, no la persona usuaria). */
    public static final String ACTION_STOP = "com.icuas.salbus.TRACKING_STOP";

    /** Detiene UN aviso desde el boton de su notificacion. */
    public static final String ACTION_STOP_JOB = "com.icuas.salbus.TRACKING_STOP_JOB";

    /**
     * Despertar programado.
     *
     * Lo dispara la alarma del sistema cuando toca empezar una franja de
     * puntualidad. NO trae lista de avisos: reanuda con la que ya hay.
     */
    public static final String ACTION_TICK = "com.icuas.salbus.TRACKING_TICK";

    /**
     * Boton "Siguiente bus" del aviso de completado: vuelve a crear el aviso
     * que acaba de terminar, con la cuenta a cero.
     *
     * Trae el aviso entero en el intent (mismo formato que {@link #EXTRA_JOBS})
     * porque para entonces el servicio puede estar apagado y sin recuerdo de el.
     */
    public static final String ACTION_RENEW_JOB = "com.icuas.salbus.TRACKING_RENEW_JOB";

    public static final String EXTRA_JOBS = "jobs";
    public static final String EXTRA_MONITORS = "monitors";
    public static final String EXTRA_JOB_ID = "jobId";
    public static final String EXTRA_INTERVAL = "intervalSeconds";
    public static final String EXTRA_VIBRATE = "vibrateOnApproach";
    public static final String EXTRA_TARGET = "busTarget";
    public static final String EXTRA_JOB = "job";
    public static final String EXTRA_NOTIFICATION_ID = "notificationId";

    /**
     * Separador de campos de cada aviso dentro del intent.
     *
     * NO puede ser "|": el id de un aviso ya ES `stopId|lineId`, asi que un "|"
     * como separador partia el id en dos y corria TODOS los campos un puesto. La
     * parada que se consultaba pasaba a ser el id de la linea, y la linea que se
     * buscaba, el nombre de la parada: el aviso no encontraba nunca su autobus y
     * repetia "sin paso previsto" en cada ciclo.
     */
    public static final String FIELD_SEPARATOR = "\u001F";

    private static final String CHANNEL_ID = "salbus-seguimiento";

    /**
     * Ids de notificacion, uno por ranura de aviso. Cada aviso reescribe siempre
     * el mismo id: dos ids serian dos notificaciones, y la que se deja de
     * escribir se queda congelada en la barra.
     */
    private static final int NOTIFICATION_ID_BASE = 4201;

    /** Aviso final, ya no persistente, cuando se completa un seguimiento. */
    private static final int SUMMARY_NOTIFICATION_ID = 4210;

    /** Controles de puntualidad simultaneos que admite el servicio. */
    public static final int MAX_MONITORS = 6;

    /** Ritmo de consulta de un control de puntualidad fuera del momento critico. */
    private static final long MONITOR_INTERVAL_MS = 30_000L;

    /** Contador (en minutos) a partir del cual se da por entrante el autobus. */
    private static final int ARM_MINUTES = 3;

    /** Subida del contador que delata que lo que se ve ya es el bus siguiente. */
    private static final int JUMP_MINUTES = 3;

    /** Dos pasos de la misma linea no pueden estar mas juntos que esto. */
    private static final long MIN_GAP_MS = 90_000L;

    /** Un paso estimado no puede arrastrarse mas de esto hacia atras. */
    private static final long MAX_BACKDATE_MS = 5 * 60_000L;

    /**
     * Tope de espera entre despertares.
     *
     * Aunque la siguiente franja quede muy lejos se vuelve a mirar cada pocas
     * horas: asi un cambio de hora o una alarma que el sistema no llego a
     * entregar no se llevan por delante la medida del dia siguiente.
     */
    private static final long MAX_IDLE_MS = 6 * 60 * 60_000L;

    /**
     * Margen del WakeLock.
     *
     * Se renueva en cada ciclo, asi que el limite solo actua si el servicio
     * muere de forma anormal: nunca deja el movil despierto para siempre.
     */
    private static final long WAKE_LOCK_TIMEOUT_MS = 10 * 60_000L;

    /** Pasos guardados a la espera de que la app los recoja. */
    private static final int MAX_PENDING_PASSES = 200;

    /** Avisos simultaneos que admite el servicio. */
    public static final int MAX_JOBS = 2;

    /** Tope de autobuses por aviso; el numero real lo elige la app. */
    public static final int MAX_TARGET_BUSES = 3;

    /** Ciclos seguidos sin ver la linea, tras haberla tenido encima, para darla por pasada. */
    private static final int MISSING_STREAK_TO_PASS = 2;

    /**
     * Paradas anteriores que se miran para localizar el autobus.
     *
     * Son las OCHO anteriores a la del aviso, la misma ventana que dibuja la
     * pestana Seguir. Coincide con ROUTE_WINDOW_STOPS de src/services/bus-position.ts.
     *
     * Que sean ocho no significa ocho peticiones: la busqueda va de la parada
     * del aviso hacia atras y se PARA en la primera que tenga el autobus
     * encima, que es lo unico que hace falta saber para decir "a N paradas".
     * Cuando esta cerca —justo cuando el dato sirve para algo— se encuentra a
     * la primera o a la segunda. El tope de ocho solo dice hasta donde se puede
     * llegar buscando cuando viene de lejos; antes eran seis y por eso el aviso
     * se quedaba sin saber por donde venia justo en esos casos.
     */
    private static final int ROUTE_WINDOW_STOPS = 8;

    /** Por encima de estos minutos no se busca: el autobus puede ni haber salido. */
    private static final int ROUTE_SCAN_MAX_MINUTES = 20;

    /**
     * Cada cuanto se vuelve a buscar por donde viene.
     *
     * No en cada ciclo: el ciclo son 15 s y la busqueda puede costar seis
     * peticiones. A este ritmo el coste maximo es de ~8 peticiones por medio
     * minuto —una cada cuatro segundos— muy por debajo del limite de la fuente,
     * y treinta segundos de retraso no llegan a valer media parada.
     */
    private static final long ROUTE_SWEEP_MS = 30_000L;

    /** Pasado este tiempo, la ultima localizacion deja de ensenarse. */
    private static final long ROUTE_FIX_MAX_AGE_MS = 120_000L;

    /**
     * La pantalla "Seguir" esta delante, dibujando el recorrido parada a parada.
     *
     * Cambia dos cosas de la busqueda:
     *
     *  - Se recorre la ventana ENTERA en vez de parar en el autobus. Parar en el
     *    autobus basta para decir "a 4 paradas", que es lo unico que necesita la
     *    notificacion; pero el recorrido dibujado necesita las ocho, y sin ellas
     *    la pantalla salia con siete rayas y un solo tiempo.
     *  - Lo que se ve en cada parada se manda a la web (emitRouteUpdate). El
     *    servicio ya estaba consultando esas paradas y tirando el dato: la web
     *    lo unico que podia hacer era volver a pedirlo, y dos clientes contra
     *    una fuente que admite una peticion cada dos segundos es justo lo que la
     *    bloquea. Un solo dueño de la cola, y lo que consulta lo comparte.
     */
    private static volatile boolean routeWatch = false;

    static void setRouteWatch(boolean watching) {
        routeWatch = watching;
    }


    /** Minutos restantes a partir de los cuales se avisa con una vibracion corta. */
    private static final int VIBRATION_THRESHOLD_MINUTES = 3;

    /** Espera tras un 429, duplicandose hasta el maximo. */
    private static final long BACKOFF_BASE_MS = 15_000L;
    private static final long BACKOFF_MAX_MS = 120_000L;

    /** Separacion entre las consultas de dos avisos dentro del mismo ciclo. */
    private static final long JOB_SPACING_MS = 2_000L;

    /**
     * Avisos detenidos a mano desde la notificacion.
     *
     * Se guardan en disco porque la app puede estar cerrada cuando ocurre: sin
     * esto, al volver a abrirla veria su aviso guardado, no encontraria el
     * servicio vivo y lo revivria, resucitando una notificacion que la persona
     * usuaria acababa de quitar.
     */
    private static final String PREFS = "salbus.tracking";
    private static final String PREF_STOPPED = "stoppedJobIds";

    /**
     * Avisos renovados con "Siguiente bus" mientras la app no escuchaba.
     *
     * Mismo motivo que {@link #PREF_STOPPED}, al reves: al volver a abrirse, la
     * app no conoceria el aviso renovado y su primera sincronizacion lo borraria
     * del servicio. Se guarda la cadena completa del aviso para que la app pueda
     * volver a crearlo tal cual.
     */
    private static final String PREF_RENEWED = "renewedJobs";

    /**
     * Pasos de puntualidad detectados que la app aun no ha recogido.
     *
     * Van a disco porque casi siempre se detectan con la app cerrada: es el
     * unico sitio donde pueden esperar a que vuelva a abrirse.
     */
    private static final String PREF_PASSES = "pendingPasses";

    /**
     * Controles de puntualidad tal y como los mando la app.
     *
     * El servicio se apaga entre franja y franja, asi que cuando la alarma lo
     * despierta ya no recuerda nada: los lee de aqui. La app puede llevar dias
     * sin abrirse y las franjas se siguen midiendo igual.
     */
    private static final String PREF_MONITORS = "backgroundMonitors";

    private static volatile boolean running = false;

    /** La instancia del plugin recibe las actualizaciones para reflejarlas en la UI. */
    @Nullable
    private static volatile BusTrackingPlugin listener = null;

    private HandlerThread workerThread;
    private Handler worker;

    private final List<Job> jobs = new ArrayList<>();
    private final List<Monitor> monitors = new ArrayList<>();

    /** Mantiene la CPU viva dentro de una franja de puntualidad. */
    @Nullable
    private PowerManager.WakeLock wakeLock;

    private long intervalMs = 15_000L;
    private long backoffMs = BACKOFF_BASE_MS;
    private boolean vibrateOnApproach = true;

    /**
     * Autobuses que ve pasar cada aviso antes de cerrarse.
     *
     * Es un ajuste de la app, no una constante: quien pone un aviso casi siempre
     * espera EL proximo autobus, y encadenar tres dejaba la notificacion viva
     * mucho despues de haberse subido al primero.
     */
    private int targetBuses = 1;

    /** Un aviso: una parada, una linea y todo lo que hay que recordar de ella. */
    private static final class Job {
        final String id;
        final String stopId;
        final String stopName;
        final String lineId;
        final String destination;
        /**
         * Sentido elegido en la app. El servicio no lo usa (le llega ya el
         * recorrido resuelto), solo lo guarda para devolverlo intacto si el
         * aviso se renueva con "Siguiente bus".
         */
        String directionKey = "";

        /** Deteccion de pasos: se arma cuando el bus esta encima y se cierra al alejarse. */
        boolean armed = false;
        int lastMinutes = -1;
        int missingStreak = 0;
        int busesSeen = 0;
        /**
         * Autobuses que hay que dejar pasar antes del que se sigue: 0 sigue al
         * proximo, 1 al que viene detras. Los pasos se siguen detectando con el
         * primero (es el unico que la fuente pone a cero minutos); cada paso
         * mientras quede alguno por dejar pasar solo descuenta, sin sumar a
         * busesSeen, y a partir de ahi el aviso sigue exactamente igual que uno
         * normal.
         */
        int skip = 0;
        /** El autobus de detras en la ultima consulta, para la pantalla; -1 si no consta. */
        int nextMinutes = -1;
        boolean nextArriving = false;
        /** La vibracion de los 3 minutos ya se ha dado para el autobus en curso. */
        boolean warnedAt3 = false;
        /** La ultima consulta de este aviso se topo con el limite de la fuente. */
        boolean throttled = false;

        /**
         * Paradas anteriores del recorrido, de la mas cercana a la mas lejana.
         *
         * Llegan ya resueltas desde la web: la red de lineas es un JSON que solo
         * existe alli, y el servicio tiene que poder contar paradas sin ella.
         * Vacio cuando por la parada del aviso pasa mas de un sentido de la
         * linea y no se puede saber por cual viene.
         */
        String[] route = new String[0];

        /** Paradas anteriores a las que consta el autobus, o -1 si no consta. */
        int stopsAway = -1;
        /** Cuando se averiguo, para poder callarse cuando envejezca. */
        long stopsAwayAt = 0L;
        /** Ultima busqueda, se salde con hallazgo o no. */
        long routeSweptAt = 0L;

        Job(String id, String stopId, String stopName, String lineId, String destination) {
            this.id = id;
            this.stopId = stopId;
            this.stopName = stopName;
            this.lineId = lineId;
            this.destination = destination;
        }

        /** La localizacion sigue siendo defendible. */
        boolean hasFreshFix(long now) {
            return stopsAway >= 0 && now - stopsAwayAt <= ROUTE_FIX_MAX_AGE_MS;
        }

        /** "en tu parada" / "a 1 parada" / "a 4 paradas", o vacio si no consta. */
        String whereText(long now) {
            if (!hasFreshFix(now)) {
                return "";
            }
            if (stopsAway == 0) {
                return "en tu parada";
            }
            return stopsAway == 1 ? "a 1 parada" : "a " + stopsAway + " paradas";
        }
    }

    /**
     * Un control de puntualidad: una linea, una parada y una franja del dia.
     *
     * La deteccion de pasos es la misma que la de src/services/punctuality.ts,
     * regla por regla: se arma cuando el contador baja a {@link #ARM_MINUTES} y
     * se da el paso por hecho cuando el contador SUBE de golpe (ya se esta viendo
     * el autobus siguiente) o cuando la linea desaparece de la parada.
     */
    private static final class Monitor {
        final String id;
        final String stopId;
        final String stopName;
        final String lineId;
        /** Franja en minutos del dia; el final nunca es menor que el principio. */
        final int startMinutes;
        final int endMinutes;

        boolean armed = false;
        /** Ultimo contador visto, o -1 si la linea no aparecia. */
        int lastMinutes = -1;
        /** Instante estimado de paso mientras esta armado, o 0. */
        long expectedPassAt = 0L;
        int missingStreak = 0;
        /** Ultimo paso registrado, para no contar dos veces el mismo autobus. */
        long lastPassAt = 0L;
        /** Regla que detecto el ultimo paso: "jump" o "gone". Util en el registro. */
        String reason = "gone";

        Monitor(String id, String stopId, String stopName, String lineId, int startMinutes, int endMinutes) {
            this.id = id;
            this.stopId = stopId;
            this.stopName = stopName;
            this.lineId = lineId;
            this.startMinutes = startMinutes;
            this.endMinutes = endMinutes;
        }

        boolean isWithinWindow(int minutesOfDay) {
            return minutesOfDay >= startMinutes && minutesOfDay < endMinutes;
        }

        /** Olvida la deteccion en curso: fuera de la franja no significa nada. */
        void reset() {
            armed = false;
            lastMinutes = -1;
            expectedPassAt = 0L;
            missingStreak = 0;
        }

        /**
         * Una observacion.
         *
         * @param minutes contador de la fuente, o -1 si la linea no figura.
         * @return instante estimado del paso, o 0 si todavia no hay paso.
         */
        long observe(int minutes, long at) {
            if (minutes < 0) {
                missingStreak += 1;
                boolean overdue = expectedPassAt > 0L && at >= expectedPassAt;

                if (armed && (missingStreak >= MISSING_STREAK_TO_PASS || overdue)) {
                    return commit(at, -1);
                }

                lastMinutes = -1;
                return 0L;
            }

            missingStreak = 0;

            boolean jumped = armed && lastMinutes >= 0 && minutes >= lastMinutes + JUMP_MINUTES;
            if (jumped) {
                // El contador que se acaba de leer ya es el del bus siguiente.
                return commit(at, minutes);
            }

            if (minutes <= ARM_MINUTES) {
                armed = true;
                // Vale la ultima estimacion: es la mejor informada sobre cuando
                // entra de verdad el autobus.
                expectedPassAt = at + minutes * 60_000L;
            }

            lastMinutes = minutes;
            return 0L;
        }

        /** Cierra un paso y deja el control listo para el autobus siguiente. */
        private long commit(long at, int minutes) {
            long passAt = expectedPassAt <= 0L
                ? at
                : Math.min(at, Math.max(expectedPassAt, at - MAX_BACKDATE_MS));

            // Con contador nuevo el paso se dedujo del salto; sin el, de que la
            // linea haya desaparecido de la parada.
            reason = minutes < 0 ? "gone" : "jump";

            armed = false;
            expectedPassAt = 0L;
            missingStreak = 0;
            lastMinutes = minutes;

            // Rebote de la fuente: el mismo autobus no puede pasar dos veces.
            if (lastPassAt > 0L && passAt - lastPassAt < MIN_GAP_MS) {
                return 0L;
            }

            lastPassAt = passAt;

            if (minutes >= 0 && minutes <= ARM_MINUTES) {
                armed = true;
                expectedPassAt = at + minutes * 60_000L;
            }

            return passAt;
        }
    }

    /**
     * Las consultas de un ciclo.
     *
     * Dos avisos —o un aviso y un control— sobre la MISMA parada comparten
     * respuesta: la fuente oficial limita por IP y pedirle dos veces lo mismo en
     * el mismo segundo solo acerca el 429.
     */
    private static final class Cycle {
        private final Map<String, ArrivalsClient.Result> byStop = new HashMap<>();
        private boolean fetched = false;

        ArrivalsClient.Result get(String stopId) {
            ArrivalsClient.Result cached = byStop.get(stopId);
            if (cached != null) {
                return cached;
            }

            if (fetched) {
                sleep(JOB_SPACING_MS);
            }
            fetched = true;

            ArrivalsClient.Result result = ArrivalsClient.fetch(stopId);
            byStop.put(stopId, result);
            return result;
        }
    }

    public static boolean isRunning() {
        return running;
    }

    public static void setListener(@Nullable BusTrackingPlugin plugin) {
        listener = plugin;
    }

    /** Ids de los avisos que la persona usuaria detuvo desde la notificacion. */
    static Set<String> readStoppedIds(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new LinkedHashSet<>(prefs.getStringSet(PREF_STOPPED, new LinkedHashSet<String>()));
    }

    static void clearStoppedIds(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(PREF_STOPPED)
            .apply();
    }

    private void rememberStopped(String jobId) {
        Set<String> stored = readStoppedIds(this);
        stored.add(jobId);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putStringSet(PREF_STOPPED, stored)
            .apply();
    }

    /** Un aviso renovado deja de contar como retirado, o la app lo borraria al abrirse. */
    private void forgetStopped(String jobId) {
        Set<String> stored = readStoppedIds(this);
        if (!stored.remove(jobId)) {
            return;
        }
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putStringSet(PREF_STOPPED, stored)
            .apply();
    }

    /**
     * Entrega los avisos renovados con la app cerrada Y los borra: se leen una
     * sola vez, como los pasos de puntualidad.
     */
    static synchronized String[] takeRenewedJobs(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> stored = prefs.getStringSet(PREF_RENEWED, new LinkedHashSet<String>());
        prefs.edit().remove(PREF_RENEWED).apply();
        return stored.toArray(new String[0]);
    }

    private synchronized void rememberRenewed(String raw) {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> stored = new LinkedHashSet<>(prefs.getStringSet(PREF_RENEWED, new LinkedHashSet<String>()));
        String id = raw.split(Pattern.quote(FIELD_SEPARATOR), 2)[0];
        // Una sola entrada por aviso: pulsar dos veces no crea dos.
        stored.removeIf((item) -> item.split(Pattern.quote(FIELD_SEPARATOR), 2)[0].equals(id));
        stored.add(raw);
        prefs.edit().putStringSet(PREF_RENEWED, stored).apply();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        workerThread = new HandlerThread("salbus-tracking");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Recreacion del sistema sin datos: no hay nada que reanudar, pero el
        // plan de fondo (franjas guardadas y alarma) sigue en pie. Borrarlo aqui
        // dejaria la puntualidad muda hasta la proxima vez que se abriera la app.
        if (intent == null) {
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_STOP.equals(intent.getAction())) {
            stopEverything();
            return START_NOT_STICKY;
        }

        if (ACTION_STOP_JOB.equals(intent.getAction())) {
            stopJob(valueOf(intent.getStringExtra(EXTRA_JOB_ID)));
            return START_REDELIVER_INTENT;
        }

        if (ACTION_RENEW_JOB.equals(intent.getAction())) {
            return renewJob(intent);
        }

        // Despertar de la alarma: empieza una franja de puntualidad. No trae
        // listas, asi que no puede pasar por el camino de "sin nada = parar".
        if (ACTION_TICK.equals(intent.getAction())) {
            // El servicio viene de estar apagado: los controles solo existen ya
            // en disco.
            if (monitors.isEmpty()) {
                applyMonitors(readStoredMonitors(this));
            }

            if (jobs.isEmpty() && monitors.isEmpty()) {
                stopEverything();
                return START_NOT_STICKY;
            }

            running = true;
            startInForeground(buildForegroundNotification());
            worker.removeCallbacksAndMessages(null);
            worker.post(this::poll);
            return START_REDELIVER_INTENT;
        }

        // Un aviso por cadena, con sus campos separados por FIELD_SEPARATOR: el
        // intent solo admite tipos simples y asi no hay que arrastrar JSON.
        String[] incoming = intent.getStringArrayExtra(EXTRA_JOBS);
        String[] incomingMonitors = intent.getStringArrayExtra(EXTRA_MONITORS);

        boolean nothingToDo = (incoming == null || incoming.length == 0)
            && (incomingMonitors == null || incomingMonitors.length == 0);

        if (nothingToDo) {
            stopEverything();
            return START_NOT_STICKY;
        }

        int seconds = intent.getIntExtra(EXTRA_INTERVAL, 15);
        // Nunca por debajo de 15 s: cuatro actualizaciones por minuto es el ritmo
        // objetivo y tambien el suelo que protege a la fuente oficial.
        intervalMs = Math.max(15, seconds) * 1000L;
        vibrateOnApproach = intent.getBooleanExtra(EXTRA_VIBRATE, true);
        targetBuses = Math.min(MAX_TARGET_BUSES, Math.max(1, intent.getIntExtra(EXTRA_TARGET, 1)));

        applyJobs(incoming == null ? new String[0] : incoming);
        applyMonitors(incomingMonitors == null ? new String[0] : incomingMonitors);

        if (jobs.isEmpty() && monitors.isEmpty()) {
            stopEverything();
            return START_NOT_STICKY;
        }

        startInForeground(buildForegroundNotification());
        running = true;

        worker.removeCallbacksAndMessages(null);
        worker.post(this::poll);

        // START_REDELIVER_INTENT: si el sistema mata el servicio, lo recrea con los
        // mismos datos de seguimiento.
        return START_REDELIVER_INTENT;
    }

    /**
     * Sustituye los controles de puntualidad conservando el estado de deteccion
     * de los que ya estaban: reabrir la app a mitad de franja no puede borrar el
     * autobus que se tenia medio detectado.
     */
    private void applyMonitors(String[] incoming) {
        List<Monitor> next = new ArrayList<>();

        for (String raw : incoming) {
            if (next.size() >= MAX_MONITORS) {
                break;
            }

            String[] parts = raw.split(Pattern.quote(FIELD_SEPARATOR), 6);
            if (parts.length < 6) {
                continue;
            }

            Monitor monitor = new Monitor(
                parts[0], parts[1], parts[2], parts[3], parseInt(parts, 4), parseInt(parts, 5));

            Monitor previous = findMonitor(parts[0]);
            if (previous != null) {
                monitor.armed = previous.armed;
                monitor.lastMinutes = previous.lastMinutes;
                monitor.expectedPassAt = previous.expectedPassAt;
                monitor.missingStreak = previous.missingStreak;
                monitor.lastPassAt = previous.lastPassAt;
            }

            next.add(monitor);
        }

        monitors.clear();
        monitors.addAll(next);
        storeMonitors(this, incoming);
    }

    @Nullable
    private Monitor findMonitor(String id) {
        for (Monitor monitor : monitors) {
            if (monitor.id.equals(id)) {
                return monitor;
            }
        }
        return null;
    }

    /**
     * Sustituye la lista de avisos conservando el estado (autobuses contados,
     * deteccion en curso) de los que ya estaban: reactivar la app o cambiar el
     * otro aviso no puede reiniciar la cuenta de este.
     */
    private void applyJobs(String[] incoming) {
        List<Job> next = new ArrayList<>();

        for (String raw : incoming) {
            if (next.size() >= MAX_JOBS) {
                break;
            }

            Job job = parseJob(raw);
            if (job == null) {
                continue;
            }
            String[] parts = raw.split(Pattern.quote(FIELD_SEPARATOR), 9);
            Job previous = findJob(job.id);

            if (previous != null) {
                job.armed = previous.armed;
                job.lastMinutes = previous.lastMinutes;
                job.missingStreak = previous.missingStreak;
                job.busesSeen = previous.busesSeen;
                // Como los autobuses contados: lo que ya se dejo pasar aqui no
                // vuelve a contar porque la web reenvie el valor de partida.
                job.skip = Math.min(job.skip, previous.skip);
                job.warnedAt3 = previous.warnedAt3;
                // La localizacion tambien se conserva: la web reenvia la lista
                // entera cada vez que cambia cualquier cosa (un ajuste, el otro
                // aviso), y empezar de cero en cada sincronizacion borraria el
                // recuento cada pocos segundos.
                job.stopsAway = previous.stopsAway;
                job.stopsAwayAt = previous.stopsAwayAt;
                job.routeSweptAt = previous.routeSweptAt;
            } else {
                // Se acota al ultimo autobus pendiente: crear el aviso significa
                // que aun queda alguno por ver, y con la cuenta ya completa nunca
                // llegaria a terminar.
                job.busesSeen = Math.min(targetBuses - 1, Math.max(0, parseInt(parts, 5)));
            }

            next.add(job);
        }

        jobs.clear();
        jobs.addAll(next);
        cancelSpareNotifications();
    }

    /**
     * Un aviso a partir de su cadena: id, parada, nombre, linea, destino,
     * autobuses vistos, recorrido, sentido y autobuses que dejar pasar,
     * separados por FIELD_SEPARATOR. Los dos ultimos llegaron despues: una
     * cadena sin ellos sigue valiendo.
     */
    @Nullable
    private static Job parseJob(String raw) {
        String[] parts = raw.split(Pattern.quote(FIELD_SEPARATOR), 9);
        if (parts.length < 5) {
            return null;
        }

        Job job = new Job(parts[0], parts[1], parts[2], parts[3], parts[4]);
        job.route = parseRoute(parts, 6);
        job.directionKey = parts.length > 7 ? parts[7] : "";
        job.skip = Math.min(1, Math.max(0, parseInt(parts, 8)));
        return job;
    }

    /**
     * La cadena de un aviso recien empezado, con la cuenta de autobuses a cero.
     *
     * Sin autobuses que dejar pasar: "Siguiente bus" sigue al que viene ahora,
     * aunque el aviso original fuera del segundo.
     */
    private static String encodeFresh(Job job) {
        return String.join(FIELD_SEPARATOR,
            job.id, job.stopId, job.stopName, job.lineId, job.destination, "0",
            String.join(",", job.route), job.directionKey, "0");
    }

    /**
     * "Siguiente bus": el aviso que acaba de completarse vuelve a empezar.
     *
     * Sigue la regla de la app de que solo un aviso esta activo a la vez: el
     * renovado es lo ultimo que se ha tocado, asi que si hubiera otro vivo se
     * retira del servicio (en la app queda en pausa, no se borra).
     */
    private int renewJob(Intent intent) {
        // Llega por startForegroundService: hay que ponerse en primer plano
        // enseguida aunque luego resulte que no hay nada que hacer.
        String raw = valueOf(intent.getStringExtra(EXTRA_JOB));
        Job job = parseJob(raw);

        NotificationManager manager = getSystemService(NotificationManager.class);
        int summaryId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0);
        if (manager != null && summaryId != 0) {
            manager.cancel(summaryId);
        }

        if (job == null) {
            if (!running) {
                // Sin stopEverything: borraria las franjas de puntualidad
                // guardadas, que no tienen nada que ver con este boton.
                startInForeground(buildMonitorNotification());
                stopForeground(Service.STOP_FOREGROUND_REMOVE);
                stopSelf();
            }
            return START_NOT_STICKY;
        }

        // El servicio puede venir de estar apagado: recupera lo que habia.
        if (monitors.isEmpty()) {
            applyMonitors(readStoredMonitors(this));
        }
        intervalMs = Math.max(15, intent.getIntExtra(EXTRA_INTERVAL, 15)) * 1000L;
        vibrateOnApproach = intent.getBooleanExtra(EXTRA_VIBRATE, vibrateOnApproach);
        targetBuses = Math.min(MAX_TARGET_BUSES, Math.max(1, intent.getIntExtra(EXTRA_TARGET, targetBuses)));

        // Pulsar otra vez (o que el sistema reentregue el intent) no reinicia un
        // aviso que ya esta en marcha.
        if (findJob(job.id) == null) {
            jobs.clear();
            jobs.add(job);
            cancelSpareNotifications();
            forgetStopped(job.id);

            BusTrackingPlugin plugin = listener;
            if (plugin != null) {
                plugin.emitJobRenewed(raw);
            } else {
                rememberRenewed(raw);
            }
        }

        running = true;
        startInForeground(buildForegroundNotification());
        worker.removeCallbacksAndMessages(null);
        worker.post(this::poll);
        return START_REDELIVER_INTENT;
    }

    /**
     * Recorrido de un aviso: ids de parada separados por comas.
     *
     * Los ids son numericos, asi que la coma no puede aparecer dentro de uno y
     * no hace falta otro separador de control.
     */
    private static String[] parseRoute(String[] parts, int index) {
        if (parts.length <= index || parts[index].isEmpty()) {
            return new String[0];
        }

        String[] raw = parts[index].split(",");
        List<String> stops = new ArrayList<>();

        for (String stopId : raw) {
            String trimmed = stopId.trim();
            if (!trimmed.isEmpty() && stops.size() < ROUTE_WINDOW_STOPS) {
                stops.add(trimmed);
            }
        }

        return stops.toArray(new String[0]);
    }

    private static int parseInt(String[] parts, int index) {
        if (parts.length <= index) {
            return 0;
        }
        try {
            return Integer.parseInt(parts[index]);
        } catch (NumberFormatException error) {
            return 0;
        }
    }

    @Nullable
    private Job findJob(String id) {
        for (Job job : jobs) {
            if (job.id.equals(id)) {
                return job;
            }
        }
        return null;
    }

    /** Ranuras de notificacion que ya no usa ningun aviso. */
    private void cancelSpareNotifications() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        for (int slot = jobs.size(); slot < MAX_JOBS; slot += 1) {
            manager.cancel(NOTIFICATION_ID_BASE + slot);
        }
    }

    private void startInForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID_BASE, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID_BASE, notification);
        }
    }

    /** Detiene un aviso a peticion de la persona usuaria y lo deja anotado. */
    private void stopJob(String jobId) {
        Job job = findJob(jobId);
        if (job == null) {
            return;
        }

        rememberStopped(jobId);
        jobs.remove(job);
        cancelSpareNotifications();
        notifyJobStopped(jobId);

        if (jobs.isEmpty() && monitors.isEmpty()) {
            stopEverything();
            return;
        }

        // El aviso que queda pasa a la ranura 0, que es la que sostiene el
        // servicio en primer plano; si no queda ninguno, la sostiene el control
        // de puntualidad, que sigue midiendo por su cuenta.
        startInForeground(buildForegroundNotification());
    }

    /**
     * Se acabo: ni avisos ni controles.
     *
     * Borra tambien el plan de fondo (controles guardados y alarma): dejarlo
     * puesto reviviria el servicio por una franja que ya no quiere nadie.
     */
    private void stopEverything() {
        running = false;
        if (worker != null) {
            worker.removeCallbacksAndMessages(null);
        }
        jobs.clear();
        monitors.clear();
        planBackgroundWork(this, new String[0]);
        releaseWakeLock();
        stopSelf();
    }

    private void poll() {
        if (!running) {
            return;
        }

        if (jobs.isEmpty() && monitors.isEmpty()) {
            stopEverything();
            return;
        }

        List<Monitor> measuring = monitorsInWindow();

        // Fuera de su franja, un control olvida lo que estuviera detectando: un
        // autobus que quedo "entrando" ayer no puede contarse como paso de hoy.
        for (Monitor monitor : monitors) {
            if (!measuring.contains(monitor)) {
                monitor.reset();
            }
        }

        if (jobs.isEmpty() && measuring.isEmpty()) {
            // Nada que consultar todavia: a esperar la siguiente franja sin
            // gastar bateria.
            goIdle();
            return;
        }

        // Dentro de una franja hay que llegar hasta el final: el WakeLock es lo
        // que impide que el movil se duerma entre consulta y consulta.
        acquireWakeLock();

        Cycle cycle = new Cycle();
        long nextDelay = jobs.isEmpty() ? MONITOR_INTERVAL_MS : intervalMs;

        for (int index = 0; index < jobs.size(); index += 1) {
            if (!running) {
                return;
            }

            Job job = jobs.get(index);

            if (pollJob(job, index, cycle)) {
                // El aviso ha terminado y se ha retirado de la lista: se repite
                // este indice, que ahora ocupa el siguiente.
                index -= 1;
                continue;
            }

            if (job.throttled) {
                nextDelay = Math.max(nextDelay, backoffMs);
            }
        }

        for (Monitor monitor : measuring) {
            if (!running) {
                return;
            }

            if (pollMonitor(monitor, cycle)) {
                nextDelay = Math.max(nextDelay, backoffMs);
            }

            // Con un autobus ya encima se aprieta el ritmo: es justo el momento
            // en que se decide a que hora ha pasado.
            if (monitor.armed) {
                nextDelay = Math.min(nextDelay, intervalMs);
            }
        }

        if (jobs.isEmpty() && monitors.isEmpty()) {
            stopEverything();
            return;
        }

        if (jobs.isEmpty()) {
            // Sin avisos, la notificacion en primer plano es la del control.
            updateForegroundNotification();
        }

        worker.postDelayed(this::poll, nextDelay);
    }

    /** Controles cuya franja incluye este momento. */
    private List<Monitor> monitorsInWindow() {
        int now = minutesOfDay(System.currentTimeMillis());
        List<Monitor> active = new ArrayList<>();

        for (Monitor monitor : monitors) {
            if (monitor.isWithinWindow(now)) {
                active.add(monitor);
            }
        }

        return active;
    }

    /**
     * Un ciclo de un control de puntualidad.
     *
     * @return true si la fuente esta limitando y conviene espaciar el siguiente.
     */
    private boolean pollMonitor(Monitor monitor, Cycle cycle) {
        ArrivalsClient.Result result = cycle.get(monitor.stopId);

        if (result.status == ArrivalsClient.STATUS_THROTTLED) {
            backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
            return true;
        }

        // Un error de red no dice nada de la parada: tratarlo como "el autobus
        // ya no aparece" inventaria pasos que nunca ocurrieron.
        if (result.status != ArrivalsClient.STATUS_OK && result.status != ArrivalsClient.STATUS_EMPTY) {
            return false;
        }

        backoffMs = BACKOFF_BASE_MS;

        ArrivalsClient.Arrival arrival =
            result.status == ArrivalsClient.STATUS_OK ? result.findLine(monitor.lineId) : null;

        int minutes = arrival == null ? -1 : (arrival.arriving ? 0 : arrival.minutes);
        long passAt = monitor.observe(minutes, System.currentTimeMillis());

        if (passAt > 0L) {
            // El emparejado con el horario oficial lo hace la app: el GTFS vive
            // alli. Aqui solo se guarda el paso en bruto.
            rememberPass(monitor.id, passAt, monitor.reason);
        }

        return false;
    }

    /**
     * Hasta la siguiente franja, el servicio se apaga del todo.
     *
     * Quedarse esperando en primer plano gastaria el tope diario de horas que
     * Android 15 le pone a un servicio de tipo dataSync, y ese tope se agotaria
     * sin haber medido nada. Quien lo trae de vuelta es una alarma del sistema:
     * es lo unico que llega en punto con el movil dormido.
     */
    private void goIdle() {
        releaseWakeLock();
        running = false;
        worker.removeCallbacksAndMessages(null);
        scheduleWakeUp(this, nextWindowStart());
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /**
     * Un ciclo de un aviso.
     *
     * @return true si el aviso ha completado su objetivo y ya no esta en la lista.
     */
    private boolean pollJob(Job job, int slot, Cycle cycle) {
        ArrivalsClient.Result result = cycle.get(job.stopId);
        job.throttled = result.status == ArrivalsClient.STATUS_THROTTLED;

        if (job.throttled) {
            // La fuente esta limitando: se espera mas y se mantiene el ultimo texto.
            backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
            notifyUi(job, result.status, -1, false);
            return false;
        }

        backoffMs = BACKOFF_BASE_MS;

        ArrivalsClient.Arrival arrival =
            result.status == ArrivalsClient.STATUS_OK ? result.findLine(job.lineId) : null;
        ArrivalsClient.Arrival next =
            result.status == ArrivalsClient.STATUS_OK ? result.findLine(job.lineId, 1) : null;
        job.nextMinutes = next == null ? -1 : (next.arriving ? 0 : next.minutes);
        job.nextArriving = next != null && next.arriving;

        if (arrival != null) {
            int minutes = arrival.arriving ? 0 : arrival.minutes;
            job.missingStreak = 0;

            if (minutes <= 3) {
                job.armed = true;
            }

            // Se alejo tras haber estado encima: ese autobus ya ha pasado y el
            // tiempo que se ve ahora es el del siguiente.
            if (job.armed && job.lastMinutes >= 0 && job.lastMinutes <= 2 && minutes >= 6) {
                return registerBusPassed(job, slot);
            }

            job.lastMinutes = minutes;

            // El autobus que se sigue: el primero, o el de detras mientras quede
            // uno por dejar pasar. La deteccion de arriba va siempre con el
            // primero; lo que se ensena y lo que vibra, con este.
            int followed = job.skip > 0 ? job.nextMinutes : minutes;

            // Vibracion corta al entrar en los 3 minutos, una sola vez por
            // autobus: repetirla en cada consulta seria un zumbido cada 15 s.
            if (vibrateOnApproach && !job.warnedAt3 && followed >= 0
                && followed <= VIBRATION_THRESHOLD_MINUTES) {
                job.warnedAt3 = true;
                vibrateShort();
            }

            // Por donde viene, con la misma deteccion que "ver por donde viene".
            // Solo con el primero: el barrido encuentra el autobus mas adelantado,
            // y con el segundo diria donde esta el que se deja pasar.
            if (job.skip > 0) {
                job.stopsAway = -1;
            } else {
                sweepRoute(job, minutes, cycle);
            }

            String where = job.whereText(System.currentTimeMillis());
            String title = job.skip > 0
                ? followed < 0
                    ? "Línea " + job.lineId + " · 2º bus sin estimación"
                    : followed <= 0
                        ? "Línea " + job.lineId + " · 2º bus llegando"
                        : "Línea " + job.lineId + " · 2º bus en " + followed + " min"
                : minutes <= 0
                    ? "Línea " + job.lineId + " · Llegando"
                    : "Línea " + job.lineId + " · En " + minutes + " min";

            // A continuacion del tiempo: los minutos dicen cuando llega y las
            // paradas dicen si ese numero se puede creer.
            if (!where.isEmpty()) {
                title = title + " · " + where;
            }

            update(job, slot, title, body(job));
            notifyUi(job, result.status, minutes, arrival.arriving);
            return false;
        }

        if (result.status == ArrivalsClient.STATUS_EMPTY || result.status == ArrivalsClient.STATUS_OK) {
            // La linea deja de aparecer justo despues de pasar: es la otra forma
            // de detectar el paso, ademas del salto de minutos.
            job.missingStreak += 1;

            if (job.armed && job.missingStreak >= MISSING_STREAK_TO_PASS) {
                return registerBusPassed(job, slot);
            }

            update(job, slot, "Línea " + job.lineId + " · sin paso previsto", body(job));
            notifyUi(job, result.status, -1, false);
            return false;
        }

        // Un error de red no dice nada del autobus: no cuenta como ausencia.
        update(job, slot, "Línea " + job.lineId + " · sin conexión", body(job));
        notifyUi(job, result.status, -1, false);
        return false;
    }

    /**
     * Busca en que parada anterior esta el autobus.
     *
     * La fuente oficial NUNCA dice donde esta un autobus: por cada parada solo
     * publica "linea N, M minutos". Lo unico que delata una presencia es que ese
     * contador caiga a cero o uno. Asi que se mira eso mismo en las paradas
     * anteriores del recorrido, que llegan ordenadas de la mas cercana a la mas
     * lejana, y se para en LA PRIMERA que lo cumpla: siendo la mas cercana de
     * las que lo tienen, es la mas avanzada, y un autobus solo avanza.
     *
     * Ese orden no es cosmetico, es lo que hace la busqueda barata. Cuando el
     * autobus esta cerca —justo cuando el dato sirve para algo— se encuentra a
     * la primera o a la segunda consulta. Y no se mira mas atras de donde puede
     * estar segun lo que falta: con cinco minutos por delante no tiene sentido
     * consultar la parada de hace diez.
     */
    private void sweepRoute(Job job, int minutes, Cycle cycle) {
        long now = System.currentTimeMillis();

        if (job.route.length == 0) {
            return;
        }

        // Lejos no se busca: "a trece paradas" no cambia lo que nadie va a
        // hacer, y costaria el maximo de peticiones cuando menos falta hace.
        if (minutes < 0 || minutes > ROUTE_SCAN_MAX_MINUTES) {
            job.stopsAway = -1;
            return;
        }

        if (now - job.routeSweptAt < ROUTE_SWEEP_MS) {
            return;
        }

        job.routeSweptAt = now;

        // Se recorre la ventana ENTERA hacia atras. No se recorta por los
        // minutos que faltan: ese calculo daba por sentado un ritmo fijo entre
        // paradas, y en cuanto el autobus acumulaba retraso o trafico la
        // busqueda se paraba antes de llegar a el, con lo que el aviso se
        // quedaba sin decir por donde venia justo cuando mas se preguntaba.
        //
        // Lo que sigue acotando el COSTE es la salida anticipada: en cuanto se
        // cierra el tramo de paradas seguidas con el autobus encima, las de mas
        // atras ya no cambian la respuesta. Salvo con la pantalla "Seguir"
        // delante, que dibuja las ocho y por tanto las necesita todas.
        boolean watching = routeWatch;
        int depth = job.route.length;
        int found = -1;
        // Tramo de paradas SEGUIDAS con el autobus "llegando". Con paradas
        // cercanas el mismo autobus sale en dos o tres a la vez, y se situa en
        // la mas lejana de ellas: la busqueda no se cierra al encontrarlo, sino
        // en la primera parada de mas atras que ya no lo tiene encima.
        boolean runOpen = false;

        // Con la pantalla "Seguir" delante, el barrido se cuenta MIENTRAS ocurre.
        //
        // Antes solo se mandaba el resultado, y solo al terminar: dieciseis
        // segundos en los que el recorrido dibujado no se movia ni decia por
        // que. La web no podia pintar "esperando turno" ni "consultando" porque
        // el unico que sabia por que parada iba la busqueda era este servicio, y
        // se lo callaba hasta el final. Ahora se anuncia la cola entera al
        // empezar y cada parada al entrar en turno, que es lo que hace que el
        // punto de estado diga la verdad.
        if (watching) {
            emitRouteProgress(job, queuedFrom(job, 0), null);
        }

        for (int index = 0; index < depth; index += 1) {
            if (!running) {
                // Se sale por el final para vaciar la cola en pantalla; volver
                // aqui mismo dejaria el punto azul encendido en la ultima parada
                // consultada hasta el siguiente barrido.
                break;
            }

            if (watching) {
                emitRouteProgress(job, queuedFrom(job, index + 1), job.route[index]);
            }

            ArrivalsClient.Result result = cycle.get(job.route[index]);

            // Un 429 o un error de red no dicen nada de esa parada: seguir
            // buscando hacia atras daria por descartada una parada que no se ha
            // llegado a mirar, y el autobus acabaria "mas lejos" de lo que esta.
            if (result.status == ArrivalsClient.STATUS_THROTTLED) {
                backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
                break;
            }

            if (result.status != ArrivalsClient.STATUS_OK) {
                // Una parada sin respuesta corta el tramo: no se puede afirmar
                // que el autobus siga "llegando" en ella.
                runOpen = false;
                if (found > 0 && !watching) {
                    break;
                }
                continue;
            }

            ArrivalsClient.Arrival arrival = result.findLine(job.lineId);

            // Lo consultado se comparte con la web, tenga o no autobus encima:
            // "por aqui no viene" es tan dibujable como "aqui esta".
            //
            // Se manda parada A PARADA, en cuanto se sabe, y no en un lote al
            // acabar: el barrido dura mas de quince segundos y agrupar el
            // resultado dejaba el recorrido dibujado congelado todo ese rato
            // para luego rellenarse de golpe.
            try {
                JSONObject entry = new JSONObject();
                entry.put("stopId", job.route[index]);
                entry.put("minutes", arrival == null ? -1 : arrival.minutes);
                entry.put("arriving", arrival != null && arrival.arriving);

                JSONArray one = new JSONArray();
                one.put(entry);

                BusTrackingPlugin plugin = listener;
                if (plugin != null) {
                    plugin.emitRouteUpdate(job.id, job.lineId, one);
                }
            } catch (Exception ignored) {
                /* una parada sin serializar no invalida el resto del barrido */
            }

            boolean atStop = arrival != null && (arrival.arriving || arrival.minutes <= 1);

            if (atStop && (found < 0 || runOpen)) {
                // La primera que lo tiene encima abre el tramo mas avanzado; las
                // que siguen hacia atras, seguidas, lo llevan a la mas lejana.
                // +1 porque route[0] es la parada ANTERIOR a la del aviso.
                found = index + 1;
                runOpen = true;
            } else if (!atStop && found > 0) {
                runOpen = false;

                if (!watching) {
                    break;
                }
            }
        }

        // La cola se vacia SIEMPRE al terminar, tambien si el barrido se corto
        // por un 429 o porque el servicio se esta parando: una parada que se
        // quedara marcada "consultando" para siempre miente igual que no
        // marcarla.
        if (watching) {
            emitRouteProgress(job, new JSONArray(), null);
        }

        if (found > 0) {
            job.stopsAway = found;
            job.stopsAwayAt = now;
        } else {
            // No consta en ninguna de las miradas. Puede estar mas atras del
            // tope, entre dos paradas sin llegar a "llegando", o la fuente puede
            // no estar publicando esa linea ahora. Se calla en vez de repetir lo
            // anterior.
            job.stopsAway = -1;
        }
    }

    /**
     * Las paradas del recorrido que aun esperan turno, desde `from` hasta el
     * final de la ventana.
     */
    private JSONArray queuedFrom(Job job, int from) {
        JSONArray pending = new JSONArray();
        for (int index = from; index < job.route.length; index += 1) {
            pending.put(job.route[index]);
        }
        return pending;
    }

    /** Por donde va el barrido del recorrido, para el punto de estado de la web. */
    private void emitRouteProgress(Job job, JSONArray queued, @Nullable String loading) {
        BusTrackingPlugin plugin = listener;
        if (plugin != null) {
            plugin.emitRouteProgress(job.id, job.route, queued, loading);
        }
    }

    /**
     * Da por pasado un autobus y prepara el siguiente.
     *
     * @return true si con este ya se han visto los {@link #targetBuses} y el
     *     aviso se ha retirado de la lista.
     */
    private boolean registerBusPassed(Job job, int slot) {
        // El que ha pasado era el que se dejaba pasar: el seguido pasa a ser el
        // primero y a partir de aqui todo es como en un aviso normal. No suma a
        // busesSeen ni reinicia la vibracion, que ya iba por el seguido.
        if (job.skip > 0) {
            job.skip -= 1;
            job.armed = false;
            job.lastMinutes = -1;
            job.missingStreak = 0;
            job.stopsAway = -1;
            job.stopsAwayAt = 0L;
            job.routeSweptAt = 0L;
            notifyPassed(job);
            return false;
        }

        job.busesSeen += 1;
        job.armed = false;
        job.lastMinutes = -1;
        job.missingStreak = 0;
        job.warnedAt3 = false;
        // La localizacion era la del autobus que acaba de pasar. Arrastrarla al
        // siguiente diria "a 1 parada" de un autobus que aun no ha salido.
        job.stopsAway = -1;
        job.stopsAwayAt = 0L;
        job.routeSweptAt = 0L;

        if (job.busesSeen >= targetBuses) {
            finish(job, slot);
            return true;
        }

        notifyPassed(job);
        return false;
    }

    /**
     * Aviso final y retirada del seguimiento: ha cumplido su objetivo.
     *
     * El aviso se BORRA, no se pausa: solo caben dos y uno terminado solo
     * ocuparia un hueco. Quien quiera seguir con el siguiente autobus tiene el
     * boton "Siguiente bus" en la propia notificacion, que lo vuelve a crear.
     */
    private void finish(Job job, int slot) {
        int summaryId = SUMMARY_NOTIFICATION_ID + slot;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            Notification summary = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_salbus)
                .setContentTitle("Línea " + job.lineId + " · aviso completado")
                .setContentText(targetBuses > 1
                    ? "Han pasado " + targetBuses + " autobuses por " + job.stopName + "."
                    : "Tu autobús ha pasado por " + job.stopName + ".")
                .setContentIntent(openAppIntent())
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .addAction(new Notification.Action.Builder(
                    null, "Siguiente bus", renewIntent(job, summaryId)).build())
                .build();
            manager.notify(summaryId, summary);
        }

        jobs.remove(job);
        cancelSpareNotifications();

        BusTrackingPlugin plugin = listener;
        if (plugin == null) {
            // Nadie escucha (la app se cerro del todo): se anota como retirado
            // para que al abrirla no lo reviva con la cuenta antigua.
            rememberStopped(job.id);
        }
        // La UI lo lee de `finished` para cerrar el aviso en pantalla.
        notifyUi(job, ArrivalsClient.STATUS_OK, -1, false, true);
    }

    /**
     * Boton "Siguiente bus". Lleva el aviso entero y los ajustes con que corria:
     * al pulsarlo el servicio puede estar apagado y no recordar nada.
     */
    private PendingIntent renewIntent(Job job, int summaryId) {
        Intent intent = new Intent(this, BusTrackingService.class);
        intent.setAction(ACTION_RENEW_JOB);
        intent.putExtra(EXTRA_JOB, encodeFresh(job));
        intent.putExtra(EXTRA_NOTIFICATION_ID, summaryId);
        intent.putExtra(EXTRA_INTERVAL, (int) (intervalMs / 1000L));
        intent.putExtra(EXTRA_VIBRATE, vibrateOnApproach);
        intent.putExtra(EXTRA_TARGET, targetBuses);

        // requestCode propio por ranura y distinto del de "Detener", para que un
        // boton no herede los extras de otro.
        int requestCode = 2000 + summaryId;
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;

        // Con el servicio apagado hay que arrancarlo en primer plano: un
        // startService normal lo rechaza Android 8+ desde segundo plano.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return PendingIntent.getForegroundService(this, requestCode, intent, flags);
        }
        return PendingIntent.getService(this, requestCode, intent, flags);
    }

    /**
     * Cuerpo del aviso: direccion y hora de la ultima actualizacion.
     *
     * La linea y los minutos que faltan ya van en el titulo, asi que aqui no se
     * repiten; tampoco el nombre de la parada, que se eligio al crear el aviso.
     * Antes salia ademas "Autobús 1 de 1", que con el ajuste por defecto no
     * decia nada, y la direccion aparecia dos veces: tras el nombre de la
     * parada y otra vez como contador.
     */
    private String body(Job job) {
        return job.destination + "\nActualizado a las " + clock();
    }

    /**
     * Patron de aviso: TRES toques cortos.
     *
     * El toque unico y largo de antes se confundia con cualquier otra
     * notificacion del telefono, que es justo lo que no puede pasar: este aviso
     * significa "sal ya", y tenerlo que sacar del bolsillo para comprobar de
     * quien era le quitaba el sentido. Tres pulsos seguidos no se parecen a
     * nada mas y se reconocen sin mirar.
     *
     * El patron se lee como espera/vibra/espera/vibra…: arranca en 0 para que
     * el primer toque sea inmediato.
     *
     * La parte web lleva su propia copia de estos numeros (vibrateShort en
     * main.ts): tienen que sonar igual con la app delante y con ella cerrada.
     */
    private static final long[] APPROACH_PATTERN = { 0L, 90L, 120L, 90L, 120L, 90L };

    private void vibrateShort() {
        Vibrator vibrator = resolveVibrator();
        if (vibrator == null || !vibrator.hasVibrator()) {
            return;
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // -1: no se repite. El patron ya es el aviso completo.
                vibrator.vibrate(VibrationEffect.createWaveform(APPROACH_PATTERN, -1));
            } else {
                vibrator.vibrate(APPROACH_PATTERN, -1);
            }
        } catch (Exception ignored) {
            /* algunos fabricantes lo bloquean en modo de ahorro */
        }
    }

    @Nullable
    private Vibrator resolveVibrator() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager manager = getSystemService(VibratorManager.class);
            return manager == null ? null : manager.getDefaultVibrator();
        }
        return getSystemService(Vibrator.class);
    }

    private void notifyUi(Job job, int status, int minutes, boolean arriving) {
        notifyUi(job, status, minutes, arriving, false);
    }

    private void notifyUi(Job job, int status, int minutes, boolean arriving, boolean finished) {
        BusTrackingPlugin plugin = listener;
        if (plugin != null) {
            // La localizacion se manda solo mientras vale: envejecida es peor
            // que ninguna, porque la pantalla no tendria como saber que lo esta.
            int stopsAway = job.hasFreshFix(System.currentTimeMillis()) ? job.stopsAway : -1;
            plugin.emitArrivalUpdate(
                job.id, job.stopId, job.lineId, minutes, arriving, status, job.busesSeen, finished,
                stopsAway, job.nextMinutes, job.nextArriving, job.skip);
        }
    }

    private void notifyPassed(Job job) {
        BusTrackingPlugin plugin = listener;
        if (plugin != null) {
            plugin.emitBusPassed(job.id, job.stopId, job.lineId, job.busesSeen, targetBuses, job.skip);
        }
    }

    private void notifyJobStopped(String jobId) {
        BusTrackingPlugin plugin = listener;
        if (plugin != null) {
            plugin.emitJobStopped(jobId);
        }
    }

    private void update(Job job, int slot, String title, String body) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID_BASE + slot, buildNotification(job, title, body));
        }
    }

    private PendingIntent openAppIntent() {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        return PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification(Job job, String title, String body) {
        PendingIntent contentIntent = openAppIntent();

        Intent stopIntent = new Intent(this, BusTrackingService.class);
        stopIntent.setAction(ACTION_STOP_JOB);
        stopIntent.putExtra(EXTRA_JOB_ID, job.id);
        // Un requestCode por aviso: con el mismo, el segundo PendingIntent
        // reutilizaria los extras del primero y el boton pararia el aviso ajeno.
        PendingIntent stopPending = PendingIntent.getService(
            this,
            1 + Math.abs(job.id.hashCode() % 1000),
            stopIntent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new Notification.Builder(this, CHANNEL_ID)
            // Icono monocromo con fondo transparente: Android solo usa el alfa.
            .setSmallIcon(R.drawable.ic_stat_salbus)
            .setContentTitle(title)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentText(body.replace('\n', ' '))
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(new Notification.Action.Builder(null, "Detener", stopPending).build())
            .build();
    }

    /* -------------------------------------------------------------- *
     * Puntualidad: despertares, WakeLock y pasos guardados              *
     * -------------------------------------------------------------- */

    /**
     * Notificacion que sostiene el servicio en primer plano.
     *
     * Con avisos vivos es la del primero; sin ellos, la del control de
     * puntualidad, que es lo unico que queda haciendo trabajo.
     */
    private Notification buildForegroundNotification() {
        if (!jobs.isEmpty()) {
            Job first = jobs.get(0);
            return buildNotification(first, "Línea " + first.lineId + " · actualizando…", first.destination);
        }

        return buildMonitorNotification();
    }

    private void updateForegroundNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID_BASE, buildForegroundNotification());
        }
    }

    /** Estado de los controles: midiendo ahora, o esperando a la siguiente franja. */
    private Notification buildMonitorNotification() {
        List<Monitor> measuring = monitorsInWindow();

        String title;
        String body;

        if (!measuring.isEmpty()) {
            Monitor first = measuring.get(0);
            title = "Puntualidad · midiendo";
            body = "Línea " + first.lineId + " en " + first.stopName
                + "\nHasta las " + formatMinutes(first.endMinutes)
                + (measuring.size() > 1 ? " · " + (measuring.size() - 1) + " control(es) más" : "");
        } else {
            title = "Puntualidad · en espera";
            Monitor next = nextMonitor();
            body = next == null
                ? "Sin franjas pendientes."
                : "Línea " + next.lineId + " en " + next.stopName
                    + "\nEmpieza a las " + formatMinutes(next.startMinutes);
        }

        return new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_salbus)
            .setContentTitle(title)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentText(body.replace('\n', ' '))
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build();
    }

    /** El control cuya franja empieza antes a partir de ahora. */
    @Nullable
    private Monitor nextMonitor() {
        long now = System.currentTimeMillis();
        Monitor best = null;
        long bestAt = 0L;

        for (Monitor monitor : monitors) {
            long at = startOfWindow(now, monitor.startMinutes);
            if (best == null || at < bestAt) {
                best = monitor;
                bestAt = at;
            }
        }

        return best;
    }

    /**
     * Cuando hay que volver a mirar.
     *
     * Nunca mas tarde de {@link #MAX_IDLE_MS}: asi una franja recien creada, un
     * cambio de hora o una alarma que el sistema no llego a entregar no dejan el
     * servicio dormido el resto del dia.
     */
    private long nextWindowStart() {
        long now = System.currentTimeMillis();
        long best = 0L;

        for (Monitor monitor : monitors) {
            long at = startOfWindow(now, monitor.startMinutes);
            if (best == 0L || at < best) {
                best = at;
            }
        }

        long cap = now + MAX_IDLE_MS;
        return best == 0L ? cap : Math.min(best, cap);
    }

    /** Proxima vez que el reloj marque ese minuto del dia (hoy o mañana). */
    private static long startOfWindow(long now, int startMinutes) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(now);
        calendar.set(Calendar.HOUR_OF_DAY, startMinutes / 60);
        calendar.set(Calendar.MINUTE, startMinutes % 60);
        calendar.set(Calendar.SECOND, 0);
        calendar.set(Calendar.MILLISECOND, 0);

        if (calendar.getTimeInMillis() <= now) {
            calendar.add(Calendar.DAY_OF_MONTH, 1);
        }

        return calendar.getTimeInMillis();
    }

    private static int minutesOfDay(long at) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(at);
        return calendar.get(Calendar.HOUR_OF_DAY) * 60 + calendar.get(Calendar.MINUTE);
    }

    private static String formatMinutes(int dayMinutes) {
        int normalized = ((dayMinutes % 1440) + 1440) % 1440;
        return String.format(new Locale("es", "ES"), "%02d:%02d", normalized / 60, normalized % 60);
    }

    /**
     * Alarma de despertar.
     *
     * Es lo unico que vuelve en punto con el movil dormido: los temporizadores
     * del Handler cuentan tiempo de actividad, y con la pantalla apagada se
     * quedan parados hasta que algo despierta al sistema.
     *
     * {@code setAndAllowWhileIdle} no necesita permiso de alarma exacta; puede
     * llegar con unos minutos de margen, que para abrir una franja de al menos
     * quince es de sobra.
     */
    static void scheduleWakeUp(Context context, long at) {
        AlarmManager alarm = context.getSystemService(AlarmManager.class);
        if (alarm == null) {
            return;
        }

        try {
            alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, wakeUpIntent(context));
        } catch (Exception ignored) {
            /* algunos fabricantes limitan las alarmas en ahorro de bateria */
        }
    }

    private static void cancelWakeUp(Context context) {
        AlarmManager alarm = context.getSystemService(AlarmManager.class);
        if (alarm != null) {
            alarm.cancel(wakeUpIntent(context));
        }
    }

    /**
     * La alarma despierta a un receptor, no al servicio.
     *
     * Asi el arranque del servicio en primer plano ocurre dentro de codigo
     * propio y se puede capturar el fallo si el sistema no lo permite; con la
     * alarma apuntando al servicio, esa negativa tumbaba la app.
     */
    private static PendingIntent wakeUpIntent(Context context) {
        Intent intent = new Intent(context, BusTrackingReceiver.class);
        intent.setAction(BusTrackingReceiver.ACTION_WAKE);

        return PendingIntent.getBroadcast(
            context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /* -------------------------------------------------------------- *
     * Plan de fondo: que hay que medir y cuando volver a mirar        *
     * -------------------------------------------------------------- */

    /**
     * Deja anotado lo que hay que medir y programa el proximo despertar.
     *
     * Con la lista vacia hace lo contrario: borra el plan y quita la alarma.
     * Lo usa tambien la app cuando no hay nada que hacer ahora mismo, para no
     * arrancar un servicio que se pararia acto seguido.
     */
    static void planBackgroundWork(Context context, String[] encodedMonitors) {
        storeMonitors(context, encodedMonitors);

        if (encodedMonitors == null || encodedMonitors.length == 0) {
            cancelWakeUp(context);
            return;
        }

        scheduleWakeUp(context, nextWindowStart(encodedMonitors));
    }

    /** ¿Hay alguna franja abierta en este momento? */
    static boolean anyWindowActive(String[] encodedMonitors) {
        if (encodedMonitors == null) {
            return false;
        }

        int now = minutesOfDay(System.currentTimeMillis());

        for (String raw : encodedMonitors) {
            String[] parts = raw.split(Pattern.quote(FIELD_SEPARATOR), 6);
            if (parts.length < 6) {
                continue;
            }

            int start = parseInt(parts, 4);
            int end = parseInt(parts, 5);

            if (now >= start && now < end) {
                return true;
            }
        }

        return false;
    }

    static String[] readStoredMonitors(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        try {
            JSONArray stored = new JSONArray(prefs.getString(PREF_MONITORS, "[]"));
            String[] encoded = new String[stored.length()];
            for (int index = 0; index < stored.length(); index += 1) {
                encoded[index] = stored.optString(index, "");
            }
            return encoded;
        } catch (Exception error) {
            return new String[0];
        }
    }

    private static void storeMonitors(Context context, String[] encodedMonitors) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        if (encodedMonitors == null || encodedMonitors.length == 0) {
            prefs.edit().remove(PREF_MONITORS).apply();
            return;
        }

        JSONArray stored = new JSONArray();
        for (String raw : encodedMonitors) {
            stored.put(raw);
        }

        prefs.edit().putString(PREF_MONITORS, stored.toString()).apply();
    }

    /** Comienzo de la siguiente franja a partir de una lista ya codificada. */
    private static long nextWindowStart(String[] encodedMonitors) {
        long now = System.currentTimeMillis();
        long best = 0L;

        for (String raw : encodedMonitors) {
            String[] parts = raw.split(Pattern.quote(FIELD_SEPARATOR), 6);
            if (parts.length < 6) {
                continue;
            }

            int start = parseInt(parts, 4);
            int end = parseInt(parts, 5);
            int nowMinutes = minutesOfDay(now);

            // Una franja ya abierta se atiende ahora mismo.
            long at = nowMinutes >= start && nowMinutes < end ? now : startOfWindow(now, start);

            if (best == 0L || at < best) {
                best = at;
            }
        }

        long cap = now + MAX_IDLE_MS;
        return best == 0L ? cap : Math.min(best, cap);
    }

    /**
     * Mantiene la CPU viva mientras se esta midiendo.
     *
     * Se renueva en cada ciclo con su propio limite: si el servicio muriera de
     * forma anormal, el sistema lo suelta solo.
     */
    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager power = getSystemService(PowerManager.class);
            if (power == null) {
                return;
            }
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "salbus:seguimiento");
            wakeLock.setReferenceCounted(false);
        }

        try {
            wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        } catch (Exception ignored) {
            /* sin WakeLock se sigue midiendo, solo que menos fino */
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {
                /* ya lo habia soltado su propio limite */
            }
        }
    }

    /** Anota un paso detectado hasta que la app pueda recogerlo. */
    private void rememberPass(String monitorId, long passAt, String reason) {
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray stored = new JSONArray(prefs.getString(PREF_PASSES, "[]"));

            JSONObject pass = new JSONObject();
            pass.put("monitorId", monitorId);
            pass.put("at", passAt);
            pass.put("reason", reason);
            stored.put(pass);

            JSONArray trimmed = stored;
            if (stored.length() > MAX_PENDING_PASSES) {
                trimmed = new JSONArray();
                for (int index = stored.length() - MAX_PENDING_PASSES; index < stored.length(); index += 1) {
                    trimmed.put(stored.get(index));
                }
            }

            prefs.edit().putString(PREF_PASSES, trimmed.toString()).apply();
        } catch (Exception ignored) {
            /* la medida es un extra: nunca puede tumbar el servicio */
        }
    }

    /**
     * Entrega los pasos guardados y los borra en la misma llamada.
     *
     * Leer y borrar por separado dejaria la puerta abierta a contar dos veces el
     * mismo paso si la app se cerrara justo en medio.
     */
    static JSONArray takePasses(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(PREF_PASSES, "[]");
        prefs.edit().remove(PREF_PASSES).apply();

        try {
            return new JSONArray(raw);
        } catch (Exception error) {
            return new JSONArray();
        }
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Seguimiento de autobús",
            // IMPORTANCE_LOW: se ve y se actualiza, pero no suena en cada refresco.
            NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Aviso persistente con los minutos que faltan para tu autobús.");
        channel.setShowBadge(false);
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    /** Hora de la ultima actualizacion, sin segundos: es lo que se muestra. */
    private String clock() {
        return new SimpleDateFormat("HH:mm", new Locale("es", "ES")).format(new Date());
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private static String valueOf(@Nullable String value) {
        return value == null ? "" : value;
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseWakeLock();
        if (worker != null) {
            worker.removeCallbacksAndMessages(null);
        }
        if (workerThread != null) {
            workerThread.quitSafely();
        }
        super.onDestroy();
    }
}
