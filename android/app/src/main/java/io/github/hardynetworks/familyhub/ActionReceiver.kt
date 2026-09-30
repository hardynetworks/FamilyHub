package io.github.hardynetworks.familyhub

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlin.concurrent.thread

/** Handles the Approve / Not yet buttons on a chore notification without opening the app. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val url = intent.getStringExtra(EXTRA_URL) ?: return
        val id = intent.getIntExtra(EXTRA_ID, 0)
        val approve = intent.getBooleanExtra(EXTRA_APPROVE, true)
        val pending = goAsync()
        thread(name = "approval") {
            val text = try {
                // The link carries its own one-time key, so no sign-in is needed.
                val r = Http.request(url, "POST")
                when {
                    r.code in 200..299 -> if (approve) "Approved ✓" else "Sent back to try again"
                    r.code == 409 -> "Already handled"
                    else -> "Couldn't reach FamilyHub (${r.code})"
                }
            } catch (e: Exception) {
                "Couldn't reach FamilyHub. Check Wi-Fi or VPN."
            }
            try {
                val n = NotificationCompat.Builder(context, FamilyHubApp.CH_APPROVALS)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setColor(ContextCompat.getColor(context, R.color.accent))
                    .setContentTitle(text)
                    .setAutoCancel(true)
                    .setTimeoutAfter(4000)
                    .setContentIntent(PushService.openApp(context, "/chores", id))
                    .build()
                NotificationManagerCompat.from(context).notify(id, n)
            } catch (_: SecurityException) {
            }
            pending.finish()
        }
    }

    companion object {
        private const val EXTRA_URL = "url"
        private const val EXTRA_ID = "id"
        private const val EXTRA_APPROVE = "approve"

        fun intent(c: Context, id: Int, url: String, approve: Boolean): PendingIntent {
            val i = Intent(c, ActionReceiver::class.java).putExtra(EXTRA_URL, url).putExtra(EXTRA_ID, id).putExtra(EXTRA_APPROVE, approve)
            return PendingIntent.getBroadcast(c, id * 2 + if (approve) 0 else 1, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
    }
}
