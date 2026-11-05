// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import AppKit
import UserNotifications

@MainActor
final class BlockNotifier: NSObject, UNUserNotificationCenterDelegate {
    private var gate = BlockNoticeGate()
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert]) { _, _ in }
    }

    func handle(_ decision: DecisionEvent) {
        guard gate.admit(decision) else { return }
        let notice = BlockNotice(decision)
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.userInfo = ["eventId": notice.eventId]
        content.threadIdentifier = "guard-blocks"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: notice.identifier, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let id = response.notification.request.content.userInfo["eventId"] as? String,
              id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { return }
        await MainActor.run { _ = NSWorkspace.shared.open(AgentClient.blockPage(eventId: id)) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }
}
