import ExpoModulesCore
import QuickLook

public class HiveWardMobileWebShellModule: Module {
  private var pdfPreview: MobileWebShellPdfPreview?

  public func definition() -> ModuleDefinition {
    Name("HiveWardMobileWebShell")

    AsyncFunction("presentPdf") { (url: URL) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        throw PdfPresenterUnavailableException()
      }
      let preview = MobileWebShellPdfPreview(url: url)
      let controller = QLPreviewController()
      controller.dataSource = preview
      self.pdfPreview = preview
      presenter.present(controller, animated: true)
    }.runOnQueue(.main)

    View(HiveWardMobileWebShellView.self) {
      Events("onLoadState", "onBridgeMessage", "onExternalNavigation")

      Prop("generationDirectory") { (view: HiveWardMobileWebShellView, value: String) in
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { (view: HiveWardMobileWebShellView, value: String) in
        view.setSessionId(value)
      }

      Prop("bridgeEnabled") { (view: HiveWardMobileWebShellView, value: Bool) in
        view.setBridgeEnabled(value)
      }

      AsyncFunction("postBridgeMessage") {
        (view: HiveWardMobileWebShellView, json: String, promise: Promise) in
        try view.postBridgeMessage(json, promise: promise)
      }

      OnViewDidUpdateProps { (view: HiveWardMobileWebShellView) in
        view.propsDidUpdate()
      }
    }
  }
}
