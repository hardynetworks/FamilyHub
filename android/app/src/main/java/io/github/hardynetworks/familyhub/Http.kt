package io.github.hardynetworks.familyhub

import java.net.HttpURLConnection
import java.net.URL

/** Tiny blocking HTTP helper (always call from a background thread). */
object Http {
    data class Result(val code: Int, val body: String)

    fun request(url: String, method: String = "GET", json: String? = null, cookie: String? = null, timeoutMs: Int = 10_000): Result {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("User-Agent", "FamilyHubAndroid/${BuildConfigCompat.VERSION}")
            if (cookie != null) conn.setRequestProperty("Cookie", cookie)
            if (json != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(json.toByteArray()) }
            } else if (method == "POST") {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(0)
            }
            val code = conn.responseCode
            val stream = if (code >= 400) conn.errorStream else conn.inputStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return Result(code, body)
        } finally {
            conn.disconnect()
        }
    }
}

object BuildConfigCompat {
    const val VERSION = "1"
}
