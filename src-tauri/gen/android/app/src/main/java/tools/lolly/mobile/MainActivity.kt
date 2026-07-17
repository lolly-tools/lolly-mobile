package tools.lolly.mobile

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File

class MainActivity : TauriActivity() {
  private class PendingShare(val name: String, val mime: String, val bytes: ByteArray)

  // Single inbound-share slot, latest wins. Written on a reader thread, read from the
  // WebView's JavaBridge thread — volatile store publishes the fully-built PendingShare.
  @Volatile private var pendingShare: PendingShare? = null
  @Volatile private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Only ingest on a genuinely fresh launch. setIntent() below only clears
    // in-process state — after a process death (Android reclaiming memory while
    // backgrounded), the system redelivers its own persisted launch Intent, which
    // is still the ORIGINAL ACTION_SEND, and would otherwise resurrect an
    // already-handled share out of nowhere. onNewIntent (live delivery while the
    // activity is already running) is unaffected — it has no such guard.
    if (savedInstanceState == null) ingestShareIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    ingestShareIntent(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    // The export bridge override (bridge-overrides/export.js) calls this after saving a
    // file so the user gets the OS share sheet instead of hunting for the app-private
    // Downloads dir. Exposed to every script in the WebView, so it only ever shares
    // files it can prove live under our own export root — nothing else.
    webView.addJavascriptInterface(ShareBridge(), "LollyShare")
  }

  /** Inbound ACTION_SEND / ACTION_SEND_MULTIPLE: stash the shared file for the JS side. */
  private fun ingestShareIntent(intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    // Consume the intent so an activity recreate doesn't re-ingest the same share.
    setIntent(Intent(this, javaClass))
    val uri: Uri?
    if (action == Intent.ACTION_SEND_MULTIPLE) {
      val uris = if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
      }
      if ((uris?.size ?: 0) > 1) {
        Toast.makeText(this, "Lolly imports one file at a time — using the first", Toast.LENGTH_LONG).show()
      }
      uri = uris?.firstOrNull()
    } else {
      uri = if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
      }
    }
    // Files only in v1 (EXTRA_TEXT-only shares ignored); content:// only — a file:// Uri
    // from another app could point into our own private storage.
    if (uri == null || uri.scheme != "content") return
    val intentType = intent.type
    Thread {
      val name = shareDisplayName(uri)
      val mime = shareMime(intentType, uri)
      val bytes = readShareCapped(uri) ?: return@Thread
      pendingShare = PendingShare(name, mime, bytes)
      // Warm delivery; when the WebView doesn't exist yet the cold-start poll covers it.
      val wv = webView ?: return@Thread
      runOnUiThread {
        wv.evaluateJavascript("window.dispatchEvent(new Event('lolly-share-target'))", null)
      }
    }.start()
  }

  private fun shareDisplayName(uri: Uri): String {
    var name: String? = null
    try {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
      }
    } catch (e: Exception) {
      // fall through to Uri-derived name
    }
    val raw = name ?: uri.lastPathSegment ?: "shared-file"
    // Provider-controlled string: strip path separators and control chars before it
    // travels anywhere near a filename.
    return raw.replace(Regex("[\\\\/\\x00-\\x1f]"), "_").trim().take(160).ifBlank { "shared-file" }
  }

  private fun shareMime(intentType: String?, uri: Uri): String {
    val resolved = intentType?.takeIf { it.isNotBlank() && !it.contains('*') }
      ?: try { contentResolver.getType(uri) } catch (e: Exception) { null }
      ?: "application/octet-stream"
    return if (Regex("^[\\w.+-]+/[\\w.+-]+$").matches(resolved)) resolved else "application/octet-stream"
  }

  /** Reads the stream fully, aborting mid-stream once the cap is exceeded (never buffer-then-check). */
  private fun readShareCapped(uri: Uri): ByteArray? {
    return try {
      contentResolver.openInputStream(uri)?.use { input ->
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          total += n
          if (total > MAX_SHARE_BYTES) {
            runOnUiThread {
              Toast.makeText(this, "File is too large to share to Lolly (48 MB max)", Toast.LENGTH_LONG).show()
            }
            return null
          }
          out.write(buf, 0, n)
        }
        out.toByteArray()
      }
    } catch (e: Exception) {
      null
    }
  }

  inner class ShareBridge {
    /**
     * Share a previously exported file via ACTION_SEND. `relPath` is relative to the
     * export root — getExternalFilesDir(null)/Download, the exact directory
     * tauri-plugin-fs BaseDirectory.Download resolves to on Android — and must stay
     * inside it (canonical-path containment; symlinks and ../ both fail closed).
     * Returns false when the file is missing/out-of-root so the JS side can fall
     * back to its saved-toast message.
     */
    @JavascriptInterface
    fun shareFile(relPath: String, mime: String, title: String): Boolean {
      return try {
        val root = File(getExternalFilesDir(null), "Download").canonicalFile
        val target = File(root, relPath).canonicalFile
        if (!target.path.startsWith(root.path + File.separator) || !target.isFile) return false
        val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", target)
        val safeMime = if (Regex("^[\\w.+-]+/[\\w.+-]+$").matches(mime)) mime else "application/octet-stream"
        val send = Intent(Intent.ACTION_SEND).apply {
          type = safeMime
          putExtra(Intent.EXTRA_STREAM, uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, title.take(120).ifBlank { target.name })
        runOnUiThread { startActivity(chooser) }
        true
      } catch (e: Exception) {
        false
      }
    }

    /** Pending inbound share as {"name","mime","size","chunks"} JSON, or '' when none. */
    @JavascriptInterface
    fun sharedFilePoll(): String {
      val p = pendingShare ?: return ""
      val chunks = (p.bytes.size + SHARE_CHUNK - 1) / SHARE_CHUNK
      return JSONObject()
        .put("name", p.name)
        .put("mime", p.mime)
        .put("size", p.bytes.size)
        .put("chunks", chunks)
        .toString()
    }

    /** Base64 (NO_WRAP) of the i-th 1 MiB raw slice, or '' out of range. */
    @JavascriptInterface
    fun sharedFileChunk(i: Int): String {
      val p = pendingShare ?: return ""
      val start = i.toLong() * SHARE_CHUNK
      if (i < 0 || start >= p.bytes.size) return ""
      val len = minOf(SHARE_CHUNK.toLong(), p.bytes.size - start).toInt()
      return Base64.encodeToString(p.bytes, start.toInt(), len, Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun sharedFileConsumed() {
      pendingShare = null
    }
  }

  companion object {
    private const val MAX_SHARE_BYTES = 48L * 1024 * 1024
    private const val SHARE_CHUNK = 1024 * 1024
  }
}
