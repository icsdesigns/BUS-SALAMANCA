package com.icuas.salbus;

import android.content.Context;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Pantallas de ajustes DEL SISTEMA que la app necesita poder abrir.
 *
 * El permiso de ubicacion y el interruptor general de ubicacion del telefono son
 * dos cosas distintas, y desde la pagina web solo se ve el sintoma comun: la
 * geolocalizacion no responde. Sin poder distinguirlos, "activa la ubicacion"
 * era un texto que quien lo leia no sabia donde cumplir; `isLocationEnabled()`
 * dice cual de los dos falta y `openLocationSettings()` lleva justo alli.
 */
@CapacitorPlugin(name = "DeviceSettings")
public class DeviceSettingsPlugin extends Plugin {

    /** Esta encendido el interruptor general de ubicacion del telefono. */
    @PluginMethod
    public void isLocationEnabled(PluginCall call) {
        JSObject ret = new JSObject();

        try {
            LocationManager manager =
                (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);

            if (manager == null) {
                ret.put("enabled", true);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ret.put("enabled", manager.isLocationEnabled());
            } else {
                // Antes de Android 9 no hay un interruptor unico que consultar:
                // se mira si queda algun proveedor encendido.
                ret.put(
                    "enabled",
                    manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                        || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                );
            }
        } catch (Exception e) {
            // No poder comprobarlo no es lo mismo que estar apagado: se da por
            // encendido para no acusar al sistema de algo que no se ha visto.
            ret.put("enabled", true);
        }

        call.resolve(ret);
    }

    /**
     * Tiene SALBUS ya concedido el permiso de ubicacion.
     *
     * Se pregunta sin pedirlo: Inicio solo enseña la parada mas cercana a quien ya
     * lo tiene dado, y nunca debe sacar el dialogo por su cuenta. Desde la pagina
     * esa consulta no es fiable dentro del WebView, que no siempre refleja el
     * permiso de Android.
     *
     * Hacen falta LOS DOS permisos, precisa y aproximada: es lo mismo que exige
     * Capacitor (BridgeWebChromeClient) antes de dar la ubicacion a la pagina.
     * Con solo la aproximada, la primera llamada a `geolocation` lanzaria el
     * dialogo del sistema para pedir la precisa, justo lo que Inicio no puede
     * hacer.
     */
    @PluginMethod
    public void hasLocationPermission(PluginCall call) {
        JSObject ret = new JSObject();

        boolean granted =
            getContext().checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
            && getContext().checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;

        ret.put("granted", granted);
        call.resolve(ret);
    }

    /** Abre los ajustes de ubicacion del sistema. */
    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudieron abrir los ajustes de ubicacion", e);
        }
    }

    /** Abre la ficha de la app, donde viven sus permisos. */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo abrir la ficha de la aplicacion", e);
        }
    }
}
