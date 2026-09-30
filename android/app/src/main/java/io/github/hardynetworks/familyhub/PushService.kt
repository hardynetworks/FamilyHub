package io.github.hardynetworks.familyhub

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Receives FamilyHub push messages (data-only) and turns them into Android notifications. */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Push.sendToken(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        val title = d["title"] ?: getString(R.string.app_name)
        val body = d["body"] ?: ""
        when (d["type"]) {
            "approval" -> showApproval(this, title, body, d["url"], d["approveUrl"], d["denyUrl"])
            "doorbell" -> show(this, FamilyHubApp.CH_DOORBELL, title, body, "/?doorbell=" + (d["cameraId"] ?: ""), NotificationCompat.CATEGORY_ALARM)
            else -> show(this, FamilyHubApp.CH_GENERAL, title, body, "/", null)
        }
    }

    companion object {
        private fun canNotify(c: Context) =
            Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

        /** Tapping a notification opens the app at this FamilyHub path. */
        fun openApp(c: Context, path: String, req: Int): PendingIntent {
            val i = Intent(c, MainActivity::class.java).putExtra(MainActivity.EXTRA_PATH, path).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            return PendingIntent.getActivity(c, req, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        fun show(c: Context, channel: String, title: String, body: String, path: String, category: String?) {
            if (!canNotify(c)) return
            val id = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()
            val n = NotificationCompat.Builder(c, channel)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(ContextCompat.getColor(c, R.color.accent))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(openApp(c, path, id))
            if (category != null) n.setCategory(category)
            try {
                NotificationManagerCompat.from(c).notify(id, n.build())
            } catch (_: SecurityException) {
            }
        }

        fun showApproval(c: Context, title: String, body: String, url: String?, approveUrl: String?, denyUrl: String?) {
            if (!canNotify(c)) return
            val id = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()
            val n = NotificationCompat.Builder(c, FamilyHubApp.CH_APPROVALS)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(ContextCompat.getColor(c, R.color.accent))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(openApp(c, "/chores", id))
            if (approveUrl != null) n.addAction(0, "Approve", ActionReceiver.intent(c, id, approveUrl, true))
            if (denyUrl != null) n.addAction(0, "Not yet", ActionReceiver.intent(c, id, denyUrl, false))
            try {
                NotificationManagerCompat.from(c).notify(id, n.build())
            } catch (_: SecurityException) {
            }
        }
    }
}
