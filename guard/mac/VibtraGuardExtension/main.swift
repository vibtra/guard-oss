// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

import Foundation
import NetworkExtension

autoreleasepool {
    NEProvider.startSystemExtensionMode()
}
ExtensionState.shared.startXPC()
dispatchMain()
