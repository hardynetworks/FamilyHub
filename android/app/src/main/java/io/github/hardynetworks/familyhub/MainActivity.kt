package io.github.hardynetworks.familyhub

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/** The FamilyHub web app in a full-screen WebView, with native push, back button and pull-to-refresh. */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var errorView: View
    private var base: String = ""
    private var askedForNotifications = false

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val saved = Prefs.serverUrl(this)
        if (saved == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        base = saved
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)

        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        web = findViewById(R.id.web)
        swipe = findViewById(R.id.swipe)
        errorView = findViewById(R.id.error)
        findViewById<Button>(R.id.retry).setOnClickListener {
            errorView.visibility = View.GONE
            web.reload()
        }
        findViewById<Button>(R.id.changeServer).setOnClickListener { changeServer() }

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            userAgentString = "$userAgentString FamilyHubAndroid/${BuildConfigCompat.VERSION}"
        }
        web.addJavascriptInterface(Bridge(), "FamilyHubAndroid")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                val scheme = uri.scheme ?: ""
                // Phone numbers, emails, maps etc. go to the right app.
                if (scheme != "http" && scheme != "https") return openExternal(uri)
                // Google blocks sign-in inside apps: connect Google accounts from a browser instead.
                if (uri.host == "accounts.google.com") return openExternal(uri)
                return false
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                errorView.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView, url: String) {
                swipe.isRefreshing = false
                CookieManager.getInstance().flush()
                if (url.startsWith(base)) {
                    Push.ensureRegistered(applicationContext)
                    maybeAskForNotifications()
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    swipe.isRefreshing = false
                    errorView.visibility = View.VISIBLE
                }
            }
        }

        swipe.setColorSchemeColors(ContextCompat.getColor(this, R.color.accent))
        swipe.setProgressBackgroundColorSchemeColor(ContextCompat.getColor(this, R.color.surface))
        swipe.setOnRefreshListener { web.reload() }
        // Only pull-to-refresh when the page is scrolled to the top.
        swipe.setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) {
                    web.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState)
        } else {
            web.loadUrl(base + (intent.getStringExtra(EXTRA_PATH) ?: "/"))
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(EXTRA_PATH)?.let { if (::web.isInitialized) web.loadUrl(base + it) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        // Came back from "Change server": load the new address.
        val now = Prefs.serverUrl(this)
        if (::web.isInitialized && now != null && now != base) {
            base = now
            web.clearHistory()
            web.loadUrl("$base/")
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    private fun openExternal(uri: Uri): Boolean {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
        }
        return true
    }

    private fun maybeAskForNotifications() {
        if (askedForNotifications || Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        if (Prefs.pushConfig(this) == null) return // push isn't set up on the server
        askedForNotifications = true
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun changeServer() {
        startActivity(Intent(this, SetupActivity::class.java))
    }

    /** window.FamilyHubAndroid in the web app. */
    inner class Bridge {
        @JavascriptInterface
        fun changeServer() = runOnUiThread { this@MainActivity.changeServer() }

        @JavascriptInterface
        fun serverUrl(): String = base

        @JavascriptInterface
        fun version(): String = BuildConfigCompat.VERSION
    }

    companion object {
        const val EXTRA_PATH = "path"
    }
}
