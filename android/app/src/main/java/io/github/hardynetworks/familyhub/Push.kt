package io.github.hardynetworks.familyhub

import android.content.Context
import android.os.Build
import android.webkit.CookieManager
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import kotlin.concurrent.thread

/** Registers this phone with the FamilyHub server for push, using the WebView's sign-in cookie. */
object Push {
    @Volatile private var lastRegistered: String? = null

    fun ensureRegistered(c: Context) {
        val base = Prefs.serverUrl(c) ?: return
        val cookie = CookieManager.getInstance().getCookie(base) ?: return
        thread(name = "push-register") {
            try {
                val cfg = Http.request("$base/api/push/config", cookie = cookie)
                if (cfg.code != 200) return@thread // not signed in yet
                val j = JSONObject(cfg.body)
                if (!j.optBoolean("enabled")) {
                    Prefs.setPushConfig(c, null)
                    return@thread
                }
                Prefs.setPushConfig(c, cfg.body)
                if (!FamilyHubApp.initFirebase(c, cfg.body)) return@thread
                FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> sendToken(c, token) }
            } catch (_: Exception) {
                // Offline or server unreachable: try again next time a page loads.
            }
        }
    }

    fun sendToken(c: Context, token: String) {
        val base = Prefs.serverUrl(c) ?: return
        val cookie = CookieManager.getInstance().getCookie(base) ?: return
        val key = "$base|$token|$cookie"
        if (key == lastRegistered) return
        thread(name = "push-token") {
            try {
                val body = JSONObject().put("token", token).put("platform", "android").put("name", "${Build.MANUFACTURER} ${Build.MODEL}").toString()
                val r = Http.request("$base/api/push/register", "POST", body, cookie)
                if (r.code in 200..299) lastRegistered = key
            } catch (_: Exception) {
            }
        }
    }
}
