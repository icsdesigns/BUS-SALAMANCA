package com.icuas.salbus;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Puente entre la interfaz web y {@link BusTrackingService}.
 *
 * La app web no puede seguir consultando cuando pasa a segundo plano (Android
 * congela los temporizadores del WebView), asi que delega los avisos de "proximo
 * bus" en un servicio en primer plano y se limita a reflejar sus resultados.
 *
 * La web manda SIEMPRE las listas completas ({@code sync}), no altas y bajas
 * sueltas: asi no hay forma de que las dos partes discrepen sobre que hay vivo.
 *
 * Ademas de los avisos, {@code sync} lleva los controles de puntualidad. Sus
 * pasos detectados se quedan en disco y la web los recoge con {@code takePasses}
 * cuando vuelve a abrirse: emparejarlos con el horario oficial necesita el GTFS,
 * que solo existe en la parte web.
 */
@CapacitorPlugin(name = "BusTracking")
public class BusTrackingPlugin extends Plugin {

    @Override
    public void load() {
        BusTrackingService.setListener(this);
    }

    @Override
    protected void handleOnDestroy() {
        // El servicio debe sobrevivir a la destruccion de la actividad; solo se
        // desengancha el puente para no retener una instancia muerta.
        BusTrackingService.setListener(null);
        super.handleOnDestroy();
    }

    /**
     * Sustituye los avisos vivos por los que llegan. Con la lista vacia se
     * detiene el servicio entero.
     */
    @PluginMethod
    public void sync(PluginCall call) {
        JSArray incoming = call.getArray("jobs");
        List<String> encoded = new ArrayList<>();

        if (incoming != null) {
            try {
                for (Object item : incoming.toList()) {
                    JSONObject job = item instanceof JSONObject
                        ? (JSONObject) item
                        : new JSONObject(String.valueOf(item));

                    String id = job.optString("id", "");
                    String stopId = job.optString("stopId", "");
                    String lineId = job.optString("lineId", "");

                    if (id.isEmpty() || stopId.isEmpty() || lineId.isEmpty()) {
                        continue;
                    }

                    // El id ya lleva un "|" dentro (stopId|lineId), asi que los
                    // campos se separan con un caracter de control que no puede
                    // aparecer en ninguno de ellos.
                    encoded.add(String.join(BusTrackingService.FIELD_SEPARATOR,
                        id,
                        stopId,
                        clean(job.optString("stopName", stopId)),
                        lineId,
                        clean(job.optString("destination", "")),
                        String.valueOf(job.optInt("busesSeen", 0)),
                        joinStops(job.optJSONArray("routeStops")),
                        clean(job.optString("directionKey", "")),
                        String.valueOf(job.optInt("skip", 0))));
                }
            } catch (Exception error) {
                call.reject("Lista de avisos no valida: " + error.getMessage());
                return;
            }
        }

        List<String> encodedMonitors = new ArrayList<>();
        JSArray incomingMonitors = call.getArray("monitors");

        if (incomingMonitors != null) {
            try {
                for (Object item : incomingMonitors.toList()) {
                    JSONObject monitor = item instanceof JSONObject
                        ? (JSONObject) item
                        : new JSONObject(String.valueOf(item));

                    String id = monitor.optString("id", "");
                    String stopId = monitor.optString("stopId", "");
                    String lineId = monitor.optString("lineId", "");

                    if (id.isEmpty() || stopId.isEmpty() || lineId.isEmpty()) {
                        continue;
                    }

                    encodedMonitors.add(String.join(BusTrackingService.FIELD_SEPARATOR,
                        id,
                        stopId,
                        clean(monitor.optString("stopName", stopId)),
                        lineId,
                        String.valueOf(monitor.optInt("startMinutes", 0)),
                        String.valueOf(monitor.optInt("endMinutes", 0))));
                }
            } catch (Exception error) {
                call.reject("Lista de controles no valida: " + error.getMessage());
                return;
            }
        }

        Intent intent = new Intent(getContext(), BusTrackingService.class);
        String[] monitorArray = encodedMonitors.toArray(new String[0]);

        // Sin avisos y con todas las franjas cerradas no hay nada que consultar
        // ahora mismo: se deja anotado que hay que medir y se programa el
        // despertar. Arrancar el servicio para pararlo acto seguido haria
        // parpadear una notificacion cada vez que se abriera la app.
        if (encoded.isEmpty() && !BusTrackingService.anyWindowActive(monitorArray)) {
            BusTrackingService.planBackgroundWork(getContext(), monitorArray);
            getContext().stopService(intent);
            call.resolve();
            return;
        }

        intent.setAction(BusTrackingService.ACTION_SYNC);
        intent.putExtra(BusTrackingService.EXTRA_JOBS, encoded.toArray(new String[0]));
        intent.putExtra(BusTrackingService.EXTRA_MONITORS, monitorArray);
        intent.putExtra(BusTrackingService.EXTRA_INTERVAL, call.getInt("intervalSeconds", 15));
        intent.putExtra(BusTrackingService.EXTRA_VIBRATE,
            Boolean.TRUE.equals(call.getBoolean("vibrateOnApproach", true)));
        intent.putExtra(BusTrackingService.EXTRA_TARGET, call.getInt("busTarget", 1));

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("No se pudo iniciar el servicio: " + error.getMessage());
        }
    }

    /** Detiene todos los avisos. */
    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), BusTrackingService.class);
        intent.setAction(BusTrackingService.ACTION_STOP);
        getContext().stopService(intent);
        call.resolve();
    }

    /**
     * Estado del servicio para reconciliar al abrir la app.
     *
     * {@code stopped} son los avisos que la persona usuaria detuvo desde la
     * notificacion, posiblemente con la app cerrada. Sin ese dato, la web veria
     * su aviso guardado, no encontraria el servicio vivo y lo revivria.
     */
    @PluginMethod
    public void status(PluginCall call) {
        Set<String> stopped = BusTrackingService.readStoppedIds(getContext());

        JSArray ids = new JSArray();
        for (String id : stopped) {
            ids.put(id);
        }

        JSObject result = new JSObject();
        result.put("running", BusTrackingService.isRunning());
        result.put("stopped", ids);
        call.resolve(result);
    }

    /**
     * Pasos de puntualidad detectados en segundo plano.
     *
     * Se entregan y se borran de una vez: si se leyeran ahora y se borraran
     * despues, un cierre a destiempo de la app los contaria dos veces.
     */
    @PluginMethod
    public void takePasses(PluginCall call) {
        JSONArray stored = BusTrackingService.takePasses(getContext());

        JSArray passes = new JSArray();
        for (int index = 0; index < stored.length(); index += 1) {
            JSONObject item = stored.optJSONObject(index);
            if (item == null) {
                continue;
            }

            JSObject pass = new JSObject();
            pass.put("monitorId", item.optString("monitorId", ""));
            pass.put("at", item.optLong("at", 0L));
            pass.put("reason", item.optString("reason", "gone"));
            passes.put(pass);
        }

        JSObject result = new JSObject();
        result.put("passes", passes);
        call.resolve(result);
    }

    /**
     * Avisos renovados con "Siguiente bus" mientras la app estaba cerrada.
     *
     * Se entregan y se borran de una vez, como los pasos: la web los vuelve a
     * crear ANTES de su primera sincronizacion, que si no los quitaria del
     * servicio.
     */
    @PluginMethod
    public void takeRenewed(PluginCall call) {
        JSArray jobs = new JSArray();
        for (String raw : BusTrackingService.takeRenewedJobs(getContext())) {
            JSObject job = decodeJob(raw);
            if (job != null) {
                jobs.put(job);
            }
        }

        JSObject result = new JSObject();
        result.put("jobs", jobs);
        call.resolve(result);
    }

    /** La web ya ha aplicado las bajas: se olvidan para no repetirlas. */
    @PluginMethod
    public void clearStopped(PluginCall call) {
        BusTrackingService.clearStoppedIds(getContext());
        call.resolve();
    }

    /**
     * Dice si la pantalla "Seguir" esta delante dibujando el recorrido.
     *
     * Con ella delante el servicio recorre la ventana ENTERA en vez de parar en
     * el autobus: parar basta para el "a 4 paradas" de la notificacion, pero el
     * recorrido dibujado necesita las ocho paradas. Se avisa desde la web porque
     * el servicio no puede saber que pestaña se esta mirando.
     */
    @PluginMethod
    public void setRouteWatch(PluginCall call) {
        BusTrackingService.setRouteWatch(Boolean.TRUE.equals(call.getBoolean("watching", false)));
        call.resolve();
    }


    /** Invocado desde el servicio en cada ciclo para que la UI se mantenga al dia. */
    void emitArrivalUpdate(
        String jobId,
        String stopId,
        String lineId,
        int minutes,
        boolean arriving,
        int status,
        int busesSeen,
        boolean finished,
        int stopsAway,
        int nextMinutes,
        boolean nextArriving,
        int skip
    ) {
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        payload.put("stopId", stopId);
        payload.put("lineId", lineId);
        payload.put("minutes", minutes);
        payload.put("arriving", arriving);
        payload.put("status", statusName(status));
        payload.put("busesSeen", busesSeen);
        payload.put("finished", finished);
        // -1 es "no consta", y es distinto de 0, que es "en tu parada".
        payload.put("stopsAway", stopsAway);
        // El autobus de detras (-1 si no consta), para el aviso que sigue al
        // segundo: sin el la pantalla solo tendria el tiempo del primero.
        payload.put("nextMinutes", nextMinutes);
        payload.put("nextArriving", nextArriving);
        payload.put("skip", skip);
        payload.put("at", System.currentTimeMillis());
        notifyListeners("arrivalUpdate", payload);
    }

    /**
     * Lo que el servicio ha visto en las paradas anteriores durante su barrido.
     *
     * Es dato que ya tenia: lo consultaba para localizar el autobus y lo tiraba.
     * Compartirlo es lo que permite que la pantalla "Seguir" dibuje el recorrido
     * SIN pedir nada por su cuenta. Con el servicio vivo la web no consulta esas
     * paradas —dos clientes contra una fuente que admite una peticion cada dos
     * segundos es justo lo que la bloquea—, asi que sin esto el recorrido salia
     * con siete rayas y un solo tiempo, el de la parada del aviso.
     */
    void emitRouteUpdate(String jobId, String lineId, JSONArray stops) {
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        payload.put("lineId", lineId);
        payload.put("stops", stops);
        payload.put("at", System.currentTimeMillis());
        notifyListeners("routeUpdate", payload);
    }

    /**
     * Por donde va el barrido del recorrido AHORA MISMO.
     *
     * `emitRouteUpdate` cuenta lo que se ha averiguado; esto cuenta lo que se
     * esta averiguando, que es lo unico que puede explicar los quince segundos
     * que hay entre una parada y la siguiente. Sin ello la pantalla "Seguir"
     * enseñaba un recorrido inmovil y sin ningun indicio de estar trabajando:
     * ni la parada en curso en azul, ni las que esperan turno.
     *
     * `route` va entero en cada aviso para que la web pueda BORRAR el estado de
     * las paradas de este aviso antes de aplicar el nuevo: sin la lista
     * completa, una parada que dejara de estar en cola se quedaria encendida.
     */
    void emitRouteProgress(String jobId, String[] route, JSONArray queued, String loading) {
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        payload.put("route", new JSONArray(java.util.Arrays.asList(route)));
        payload.put("queued", queued);
        payload.put("loading", loading == null ? JSONObject.NULL : loading);
        payload.put("at", System.currentTimeMillis());
        notifyListeners("routeProgress", payload);
    }

    /** Un autobus mas ha pasado por la parada y el aviso sigue con el siguiente. */
    void emitBusPassed(String jobId, String stopId, String lineId, int busesSeen, int target, int skip) {
        JSObject payload = new JSObject();
        // Autobuses que aun quedan por dejar pasar: si baja, el que acaba de
        // pasar era uno de los que no se seguian y no cuenta.
        payload.put("skip", skip);
        payload.put("jobId", jobId);
        payload.put("stopId", stopId);
        payload.put("lineId", lineId);
        payload.put("busesSeen", busesSeen);
        payload.put("target", target);
        payload.put("at", System.currentTimeMillis());
        notifyListeners("busPassed", payload);
    }

    /** Detenido desde el boton "Detener" de su notificacion. */
    void emitJobStopped(String jobId) {
        JSObject payload = new JSObject();
        payload.put("jobId", jobId);
        notifyListeners("jobStopped", payload);
    }

    /** Renovado desde el boton "Siguiente bus" con la app escuchando. */
    void emitJobRenewed(String raw) {
        JSObject job = decodeJob(raw);
        if (job != null) {
            notifyListeners("jobRenewed", job);
        }
    }

    /** Lo que la web necesita para volver a crear un aviso a partir de su cadena. */
    private static JSObject decodeJob(String raw) {
        String[] parts = raw.split(java.util.regex.Pattern.quote(BusTrackingService.FIELD_SEPARATOR), 9);
        if (parts.length < 5 || parts[0].isEmpty()) {
            return null;
        }

        JSObject job = new JSObject();
        job.put("id", parts[0]);
        job.put("stopId", parts[1]);
        job.put("stopName", parts[2]);
        job.put("lineId", parts[3]);
        job.put("directionKey", parts.length > 7 && !parts[7].isEmpty() ? parts[7] : JSONObject.NULL);
        return job;
    }

    /**
     * Recorrido de un aviso: ids de parada separados por comas.
     *
     * Los ids de parada son numericos, asi que la coma no puede aparecer dentro
     * de uno y no hace falta gastar otro caracter de control en separarlos.
     */
    private static String joinStops(JSONArray stops) {
        if (stops == null) {
            return "";
        }

        StringBuilder joined = new StringBuilder();

        for (int index = 0; index < stops.length(); index += 1) {
            String stopId = stops.optString(index, "").trim();
            if (stopId.isEmpty()) {
                continue;
            }
            if (joined.length() > 0) {
                joined.append(',');
            }
            joined.append(stopId);
        }

        return joined.toString();
    }

    /** El separador de campos del intent no puede colarse dentro de un campo. */
    private static String clean(String value) {
        return value == null ? "" : value.replace(BusTrackingService.FIELD_SEPARATOR, " ");
    }

    private static String statusName(int status) {
        switch (status) {
            case ArrivalsClient.STATUS_OK:
                return "ok";
            case ArrivalsClient.STATUS_EMPTY:
                return "empty";
            case ArrivalsClient.STATUS_THROTTLED:
                return "throttled";
            default:
                return "error";
        }
    }
}
