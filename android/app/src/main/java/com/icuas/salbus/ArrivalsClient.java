package com.icuas.salbus;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Cliente de llegadas para el servicio en segundo plano.
 *
 * Replica la misma logica que `src/services/arrival-parser.ts`:
 *  - envia un User-Agent de navegador (sin el, la fuente responde 403),
 *  - lee el JSON de la API oficial y calcula los minutos desde la hora prevista,
 *  - descarta la fila repetida que las cabeceras publican por cada sentido,
 *  - distingue "sin servicio" de un error de red, y el muro de verificacion de
 *    Cloudflare de un rechazo de verdad.
 *
 * LA FUENTE CAMBIO: hasta 2026 esto raspaba el HTML de `/tiempos-de-llegada/`.
 * El sitio se rehizo en Next.js y ese HTML ya no trae llegadas.
 */
final class ArrivalsClient {

    static final int STATUS_OK = 0;
    static final int STATUS_EMPTY = 1;
    static final int STATUS_THROTTLED = 2;
    static final int STATUS_ERROR = 3;

    private static final String BASE_URL = "https://salamancadetransportes.com/api/siri/arrivals";

    private static final String USER_AGENT =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) "
            + "Chrome/120.0.0.0 Mobile Safari/537.36";

    /** Mismo umbral que la web: por debajo de esto el autobus esta entrando. */
    private static final int ARRIVING_DISTANCE_METERS = 200;

    /**
     * Y ademas dentro de este minuto. La distancia sola no basta: en una
     * cabecera el autobus que acaba de llegar esta a veinte metros pero no sale
     * hasta dentro de nueve minutos.
     */
    private static final int ARRIVING_MAX_MINUTES = 1;

    private ArrivalsClient() {
    }

    static final class Arrival {
        final String lineId;
        final int minutes;
        final boolean arriving;

        Arrival(String lineId, int minutes, boolean arriving) {
            this.lineId = lineId;
            this.minutes = minutes;
            this.arriving = arriving;
        }
    }

    static final class Result {
        final int status;
        final List<Arrival> arrivals = new ArrayList<>();

        Result(int status) {
            this.status = status;
        }

        Arrival findLine(String lineId) {
            Arrival best = null;
            for (Arrival arrival : arrivals) {
                if (!arrival.lineId.equals(lineId)) {
                    continue;
                }
                if (best == null || arrival.minutes < best.minutes) {
                    best = arrival;
                }
            }
            return best;
        }

        /**
         * El autobus numero {@code index} de la linea, contando desde cero y en
         * orden de llegada: 0 es el proximo, 1 el que viene detras. {@code null}
         * si la fuente no publica tantos.
         */
        Arrival findLine(String lineId, int index) {
            if (index <= 0) {
                return findLine(lineId);
            }
            List<Arrival> line = lineArrivals(lineId);
            return index < line.size() ? line.get(index) : null;
        }

        /** Todos los autobuses de la linea, en orden de llegada. */
        List<Arrival> lineArrivals(String lineId) {
            List<Arrival> line = new ArrayList<>();
            for (Arrival arrival : arrivals) {
                if (arrival.lineId.equals(lineId)) {
                    line.add(arrival);
                }
            }
            java.util.Collections.sort(line, (left, right) -> Integer.compare(left.minutes, right.minutes));
            return line;
        }
    }

    static Result fetch(String stopId) {
        HttpURLConnection connection = null;

        try {
            String url = BASE_URL + "?stop=" + URLEncoder.encode(stopId, "UTF-8");
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestProperty("User-Agent", USER_AGENT);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Accept-Language", "es-ES,es;q=0.9");
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);

            int code = connection.getResponseCode();

            if (code == 429) {
                return new Result(STATUS_THROTTLED);
            }

            String body = readBody(connection, code);

            // El muro de verificacion de Cloudflare llega como un 403 con una
            // pagina HTML. Es un limite de ritmo, no un rechazo: hay que
            // esperar y reintentar, no dar la parada por perdida.
            if (looksLikeChallenge(body)) {
                return new Result(STATUS_THROTTLED);
            }

            if (code != 200) {
                return new Result(STATUS_ERROR);
            }

            return parse(body, System.currentTimeMillis());
        } catch (Exception error) {
            return new Result(STATUS_ERROR);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String readBody(HttpURLConnection connection, int code) throws Exception {
        StringBuilder body = new StringBuilder();
        java.io.InputStream stream =
            code >= 400 ? connection.getErrorStream() : connection.getInputStream();

        if (stream == null) {
            return "";
        }

        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"))) {
            String line;
            while ((line = reader.readLine()) != null) {
                body.append(line).append('\n');
            }
        }

        return body.toString();
    }

    static boolean looksLikeChallenge(String body) {
        return body != null
            && (body.contains("_cf_chl_opt")
                || body.contains("/cdn-cgi/challenge-platform")
                || body.contains("<title>Just a moment...</title>"));
    }

    static Result parse(String body, long observedAt) {
        JSONArray rows;

        try {
            JSONObject payload = new JSONObject(body);
            if (payload.optString("error", "").length() > 0) {
                return new Result(STATUS_ERROR);
            }
            rows = payload.optJSONArray("data");
        } catch (Exception error) {
            return new Result(STATUS_ERROR);
        }

        if (rows == null) {
            return new Result(STATUS_ERROR);
        }

        Result result = new Result(STATUS_OK);

        // Una cabecera publica el mismo vehiculo dos veces, una por sentido.
        // Si las dos caen en el mismo minuto son la misma expedicion.
        Set<String> seen = new HashSet<>();

        for (int index = 0; index < rows.length(); index += 1) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null) {
                continue;
            }

            String lineId = row.optString("lineCode", "").trim();
            if (lineId.isEmpty()) {
                continue;
            }

            long expectedAt = parseInstant(row.optString("expectedArrival", ""));
            if (expectedAt < 0) {
                expectedAt = parseInstant(row.optString("aimedArrival", ""));
            }
            if (expectedAt < 0) {
                continue;
            }

            int minutes = (int) Math.max(0, Math.round((expectedAt - observedAt) / 60000.0));

            String vehicle = row.optString("vehicleId", "");
            if (vehicle.isEmpty()) {
                vehicle = row.optString("directionName", "");
            }
            if (!seen.add(lineId + "|" + vehicle + "|" + minutes)) {
                continue;
            }

            int distance = parseDistance(row.optString("distance", ""));
            boolean arriving = minutes <= 0
                || (distance >= 0 && distance <= ARRIVING_DISTANCE_METERS && minutes <= ARRIVING_MAX_MINUTES);

            result.arrivals.add(new Arrival(lineId, minutes, arriving));
        }

        if (result.arrivals.isEmpty()) {
            return new Result(STATUS_EMPTY);
        }

        return result;
    }

    /** "1234 m" -> 1234. Devuelve -1 si no se entiende. */
    private static int parseDistance(String value) {
        if (value == null) {
            return -1;
        }

        StringBuilder digits = new StringBuilder();
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character >= '0' && character <= '9') {
                digits.append(character);
            } else if (digits.length() > 0) {
                break;
            }
        }

        if (digits.length() == 0) {
            return -1;
        }

        try {
            return Integer.parseInt(digits.toString());
        } catch (NumberFormatException error) {
            return -1;
        }
    }

    /**
     * ISO-8601 a epoch ms, o -1 si no se entiende.
     *
     * La fuente manda `expectedArrival` con huso ("...+02:00") y `aimedArrival`
     * sin el. `SimpleDateFormat` con "Z" no acepta los dos puntos del huso, asi
     * que se quitan antes; sin huso se interpreta en la zona del dispositivo,
     * que para esta app es la de Salamanca.
     */
    private static long parseInstant(String value) {
        if (value == null || value.isEmpty()) {
            return -1;
        }

        String normalized = value.trim();
        boolean zoned = normalized.length() > 6
            && (normalized.charAt(normalized.length() - 6) == '+'
                || normalized.charAt(normalized.length() - 6) == '-')
            && normalized.charAt(normalized.length() - 3) == ':';

        String pattern;
        if (normalized.endsWith("Z")) {
            normalized = normalized.substring(0, normalized.length() - 1) + "+0000";
            pattern = "yyyy-MM-dd'T'HH:mm:ssZ";
        } else if (zoned) {
            normalized = normalized.substring(0, normalized.length() - 3)
                + normalized.substring(normalized.length() - 2);
            pattern = "yyyy-MM-dd'T'HH:mm:ssZ";
        } else {
            pattern = "yyyy-MM-dd'T'HH:mm:ss";
        }

        try {
            return new SimpleDateFormat(pattern, Locale.US).parse(normalized).getTime();
        } catch (ParseException error) {
            return -1;
        }
    }
}
