package io.github.hardynetworks.familyhub

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.concurrent.thread

/** First launch (or "Change server"): ask for the FamilyHub address and check it answers. */
class SetupActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_setup)
        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(v.paddingLeft, b.top + 32, v.paddingRight, b.bottom + 32)
            insets
        }
        val url = findViewById<EditText>(R.id.url)
        val msg = findViewById<TextView>(R.id.message)
        val connect = findViewById<Button>(R.id.connect)
        Prefs.serverUrl(this)?.let { url.setText(it) }

        fun go() {
            val typed = url.text.toString()
            if (typed.isBlank()) return
            val base = Prefs.normalise(typed)
            connect.isEnabled = false
            connect.setText(R.string.setup_checking)
            msg.text = ""
            thread {
                val ok = try {
                    val r = Http.request("$base/api/health", timeoutMs = 8000)
                    r.code == 200 && r.body.contains("\"ok\"")
                } catch (e: Exception) {
                    false
                }
                runOnUiThread {
                    connect.isEnabled = true
                    connect.setText(R.string.setup_connect)
                    if (ok) {
                        Prefs.setServerUrl(this, base)
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                        finish()
                    } else {
                        msg.text = "Couldn't reach FamilyHub at $base. Check the address, and that this phone is on your home network or VPN."
                    }
                }
            }
        }
        connect.setOnClickListener { go() }
        url.setOnEditorActionListener { _, id, _ ->
            if (id == EditorInfo.IME_ACTION_GO) {
                go()
                true
            } else {
                false
            }
        }
    }
}
