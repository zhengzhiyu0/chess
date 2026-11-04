import UIKit
import WebKit

/// Reads the old persistent origin once per plugin instance. Import and the
/// durable once-only migration marker belong to the Flutter domain layer.
final class LegacyStorageReader: NSObject, WKNavigationDelegate {
    private static let origin = "capacitor://localhost"
    private static let script = """
    (() => {
      if (location.protocol !== 'capacitor:' || location.hostname !== 'localhost') {
        throw new Error('Unexpected legacy storage origin');
      }
      const values = {};
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key && key.startsWith('maia-coach.')) {
          const value = localStorage.getItem(key);
          if (value !== null) values[key] = value;
        }
      }
      return JSON.stringify(values);
    })()
    """
    private var webView: WKWebView?
    private var pending: [NativeReply] = []
    private var cached: [String: String]?
    private var timeout: DispatchWorkItem?

    /// Separate handler prevents reader -> webView -> configuration -> reader
    /// retain cycles. This handler serves only a blank document, never app code.
    private final class DocumentHandler: NSObject, WKURLSchemeHandler {
        func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
            guard let url = urlSchemeTask.request.url, url.scheme == "capacitor", url.host == "localhost" else {
                urlSchemeTask.didFailWithError(URLError(.unsupportedURL))
                return
            }
            let html = Data("""
            <!doctype html><meta charset="utf-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; form-action 'none'">
            <title>Legacy storage migration</title>
            """.utf8)
            urlSchemeTask.didReceive(URLResponse(url: url, mimeType: "text/html", expectedContentLength: html.count, textEncodingName: "utf-8"))
            urlSchemeTask.didReceive(html)
            urlSchemeTask.didFinish()
        }

        func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
    }

    func read(reply: NativeReply) {
        if let cached { reply.finish(cached); return }
        guard UIApplication.shared.applicationState != .background else { reply.fail(NativeFailure.cancelled); return }
        pending.append(reply)
        if webView != nil { return }
        let configuration = WKWebViewConfiguration()
        // The old Capacitor configuration used the default persistent data store.
        configuration.websiteDataStore = .default()
        configuration.setURLSchemeHandler(DocumentHandler(), forURLScheme: "capacitor")
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
        view.isHidden = true
        view.navigationDelegate = self
        webView = view
        let timer = DispatchWorkItem { [weak self] in
            self?.finish(error: NativeFailure(code: "migration_timeout", message: "Legacy localStorage read timed out; original data is preserved"))
        }
        timeout = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timer)
        view.load(URLRequest(url: URL(string: "\(Self.origin)/flutter-migration")!))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url?.scheme == "capacitor" && url?.host == "localhost" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript(Self.script) { [weak self, weak webView] value, error in
            guard let self, let webView, self.webView === webView else { return }
            if let error { self.finish(error: error); return }
            do {
                guard let text = value as? String, let data = text.data(using: .utf8),
                      let storage = try JSONSerialization.jsonObject(with: data) as? [String: String] else {
                    throw NativeFailure(code: "migration_failed", message: "Invalid legacy localStorage snapshot")
                }
                self.cached = storage
                NativeRuntimeLog.record("legacy localStorage read keys=\(storage.count) bytes=\(data.count)", subsystem: "Migration")
                self.finish(value: storage)
            } catch { self.finish(error: error) }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(error: error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(error: error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(error: NativeFailure(code: "migration_failed", message: "Legacy storage WebKit process terminated"))
    }

    func cancel() {
        if !pending.isEmpty { finish(error: NativeFailure.cancelled) }
    }

    private func finish(value: Any? = nil, error: Error? = nil) {
        timeout?.cancel()
        timeout = nil
        let view = webView
        webView = nil
        view?.navigationDelegate = nil
        view?.stopLoading()
        let replies = pending
        pending.removeAll()
        for reply in replies {
            if let error { reply.fail(error) }
            else { reply.finish(value) }
        }
    }
}
