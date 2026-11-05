// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import AppKit
import SwiftUI

@MainActor
final class WindowManager {
    static let shared = WindowManager()

    private var enrolWindow: NSWindow?
    private var statusWindow: NSWindow?
    private var blockedWindows: [String: NSWindow] = [:]

    private func makeWindow<V: View>(title: String, view: V) -> NSWindow {
        let window = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = title
        let hosting = NSHostingController(rootView: view)
        hosting.sizingOptions = []
        window.contentViewController = hosting
        window.setContentSize(hosting.view.fittingSize)
        window.isReleasedWhenClosed = false
        window.center()
        return window
    }

    private func present(_ window: NSWindow) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
    }

    private func showWithoutFocus(_ window: NSWindow) {
        window.orderFrontRegardless()
    }

    func refit() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for window in [self.enrolWindow].compactMap({ $0 }) + Array(self.blockedWindows.values) {
                guard let view = window.contentViewController?.view else { continue }
                view.layoutSubtreeIfNeeded()
                let size = view.fittingSize
                if size != window.contentRect(forFrameRect: window.frame).size {
                    var frame = window.frame
                    let newFrame = window.frameRect(forContentRect: NSRect(origin: .zero, size: size))
                    frame.origin.y += frame.height - newFrame.height
                    frame.size = newFrame.size
                    window.setFrame(frame, display: true, animate: false)
                }
            }
        }
    }

    func showEnrol(prefill: EnrolLink?) {
        enrolWindow?.close()
        let window = makeWindow(title: "Enrol this Mac", view: EnrolView(model: AppModel.shared, prefill: prefill, close: { [weak self] in self?.enrolWindow?.close() }))
        enrolWindow = window
        present(window)
    }

    func showStatus() {
        if statusWindow == nil {
            statusWindow = makeWindow(title: "Guard setup", view: StatusPanel(model: AppModel.shared))
        }
        present(statusWindow!)
    }

    func showBlocked(_ decision: DecisionEvent) {
        if let existing = blockedWindows[decision.eventId] { showWithoutFocus(existing); return }
        if blockedWindows.count >= 3, let oldest = blockedWindows.keys.sorted().first {
            blockedWindows.removeValue(forKey: oldest)?.close()
        }
        let id = decision.eventId
        let window = makeWindow(title: decision.action == "asked" ? "Needs IT's OK" : "Blocked by Vibtra Guard",
                                view: BlockedView(model: AppModel.shared, decision: decision, close: { [weak self] in
                                    self?.blockedWindows.removeValue(forKey: id)?.close()
                                }))
        window.level = .floating
        blockedWindows[id] = window
        showWithoutFocus(window)
    }
}
