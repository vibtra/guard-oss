// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import AppKit
import Combine
import SwiftUI

@MainActor
final class GuardWindowChrome: ObservableObject {
    @Published var sidebarVisibility: NavigationSplitViewVisibility = .all
}

@MainActor
final class GuardDesktopWindow: NSWindow {
    let chrome = GuardWindowChrome()
    private(set) var sidebarButton: NSButton!
    private var sidebarObservation: AnyCancellable?

    init(model: AppModel, initialPane: GuardPane = .overview, restoreFrame: Bool = true) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 720),
                   styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        title = "Vibtra Guard"
        tabbingMode = .disallowed
        isReleasedWhenClosed = false
        contentMinSize = NSSize(width: 820, height: 520)

        let hosting = NSHostingView(rootView: GuardDesktop(model: model, chrome: chrome, initialPane: initialPane))
        hosting.sizingOptions = []
        hosting.autoresizingMask = [.width, .height]
        contentView = hosting
        installSidebarControl()

        if restoreFrame {
            if !setFrameUsingName("GuardDesktop") { center() }
            setFrameAutosaveName("GuardDesktop")
            fitOnScreen()
        }
    }

    private func installSidebarControl() {
        let accessory = NSTitlebarAccessoryViewController()
        accessory.layoutAttribute = .left
        accessory.view = NSView(frame: NSRect(x: 0, y: 0, width: 40, height: 52))
        let button = NSButton(image: NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: nil)!,
                              target: self, action: #selector(toggleSidebar))
        button.frame = NSRect(x: 4, y: 12, width: 32, height: 28)
        button.bezelStyle = .texturedRounded
        button.isBordered = false
        button.setAccessibilityIdentifier("guard.sidebar.toggle")
        accessory.view.addSubview(button)
        sidebarButton = button
        addTitlebarAccessoryViewController(accessory)
        sidebarObservation = chrome.$sidebarVisibility.sink { [weak button] visibility in
            let title = visibility == .detailOnly ? "Show Sidebar" : "Hide Sidebar"
            button?.toolTip = title
            button?.setAccessibilityLabel(title)
        }
    }

    @objc private func toggleSidebar() {
        withAnimation { chrome.sidebarVisibility = chrome.sidebarVisibility == .detailOnly ? .all : .detailOnly }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == [.command, .control],
           event.charactersIgnoringModifiers?.lowercased() == "s" {
            toggleSidebar()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    func fitOnScreen() {
        guard let visible = (screen ?? NSScreen.main)?.visibleFrame else { return }
        var fitted = frame
        fitted.size.width = min(fitted.width, visible.width)
        fitted.size.height = min(fitted.height, visible.height)
        fitted.origin.x = max(visible.minX, min(fitted.minX, visible.maxX - fitted.width))
        fitted.origin.y = max(visible.minY, min(fitted.minY, visible.maxY - fitted.height))
        if fitted != frame { setFrame(fitted, display: true) }
    }
}
