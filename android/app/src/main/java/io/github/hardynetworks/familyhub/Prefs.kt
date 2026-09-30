package io.github.hardynetworks.familyhub

import android.content.Context

/** Small app settings: the FamilyHub server address and the Firebase config it hands out. */
object Prefs {
    private const val FILE = "familyhub"

    fun serverUrl(c: Context): String? = c.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString("server", null)

    fun setServerUrl(c: Context, url: String?) {
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().apply {
            if (url == null) remove("server") else putString("server", url)
        }.apply()
    }

    fun pushConfig(c: Context): String? = c.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString("pushConfig", null)

    fun setPushConfig(c: Context, json: String?) {
        c.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().apply {
            if (json == null) remove("pushConfig") else putString("pushConfig", json)
        }.apply()
    }

    /** Normalise what someone typed: add https://, drop trailing slashes and a pasted /kiosk or /login. */
    fun normalise(input: String): String {
        var u = input.trim()
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://$u"
        u = u.trimEnd('/')
        for (suffix in listOf("/kiosk", "/login", "/settings")) if (u.endsWith(suffix)) u = u.removeSuffix(suffix)
        return u.trimEnd('/')
    }
}
