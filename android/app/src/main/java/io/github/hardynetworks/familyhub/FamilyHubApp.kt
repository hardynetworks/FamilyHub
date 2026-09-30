package io.github.hardynetworks.familyhub

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import org.json.JSONObject

class FamilyHubApp : Application() {
    override fun onCreate() {
        super.onCreate()
        createChannels(this)
        // Firebase is configured at runtime from the FamilyHub server (no google-services.json),
        // so a cold start from a push message needs the saved config.
        Prefs.pushConfig(this)?.let { initFirebase(this, it) }
    }

    companion object {
        const val CH_APPROVALS = "approvals"
        const val CH_DOORBELL = "doorbell"
        const val CH_GENERAL = "general"

        fun createChannels(c: Context) {
            val nm = c.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CH_APPROVALS, "Chore approvals", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "When a child marks a chore done"
                },
            )
            nm.createNotificationChannel(
                NotificationChannel(CH_DOORBELL, "Doorbell", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "When someone rings the doorbell"
                },
            )
            nm.createNotificationChannel(NotificationChannel(CH_GENERAL, "General", NotificationManager.IMPORTANCE_DEFAULT))
        }

        /** Initialise (or re-initialise) the default FirebaseApp from the server's config JSON. */
        fun initFirebase(c: Context, json: String): Boolean {
            return try {
                val j = JSONObject(json)
                val opts = FirebaseOptions.Builder()
                    .setApplicationId(j.getString("appId"))
                    .setApiKey(j.getString("apiKey"))
                    .setProjectId(j.getString("projectId"))
                    .setGcmSenderId(j.getString("senderId"))
                    .build()
                val existing = FirebaseApp.getApps(c).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
                if (existing != null) {
                    if (existing.options.applicationId == opts.applicationId && existing.options.apiKey == opts.apiKey) return true
                    existing.delete()
                }
                FirebaseApp.initializeApp(c, opts)
                true
            } catch (e: Exception) {
                false
            }
        }
    }
}
