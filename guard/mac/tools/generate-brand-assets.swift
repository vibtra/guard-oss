// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import AppKit
import Foundation

let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../../..").standardizedFileURL
let source = try String(contentsOf: repository.appendingPathComponent("apps/console/src/brand/marks.ts"), encoding: .utf8)
let expression = try NSRegularExpression(pattern: #"export const VIBTRA_MARK_PATH\s*=\s*"([^"]+)""#)
guard let match = expression.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
      let range = Range(match.range(at: 1), in: source) else { fatalError("Vibtra mark not found") }
let geometry = String(source[range])
let assets = repository.appendingPathComponent("guard/mac/VibtraGuard/Brand.xcassets")
let icon = assets.appendingPathComponent("AppIcon.appiconset")
let mark = assets.appendingPathComponent("VibtraMark.imageset")
for directory in [assets, icon, mark] { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
let info: [String: Any] = ["author": "xcode", "version": 1]
func writeJSON(_ value: [String: Any], to directory: URL) throws {
    try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        .write(to: directory.appendingPathComponent("Contents.json"))
}
try writeJSON(["info": info], to: assets)
let svg = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#000000" d="\(geometry)"/></svg>

"""
try svg.write(to: mark.appendingPathComponent("mark.svg"), atomically: true, encoding: .utf8)
try writeJSON(["info": info, "images": [["idiom": "universal", "filename": "mark.svg"]],
               "properties": ["preserves-vector-representation": true, "template-rendering-intent": "template"]], to: mark)

guard geometry.allSatisfy({ $0.isNumber || ". -MLZ".contains($0) }) else { fatalError("Unsupported mark path command") }
let tokenExpression = try NSRegularExpression(pattern: #"[MLZ]|-?(?:\d+(?:\.\d*)?|\.\d+)"#)
let tokens = tokenExpression.matches(in: geometry, range: NSRange(geometry.startIndex..., in: geometry)).map {
    String(geometry[Range($0.range, in: geometry)!])
}
let path = NSBezierPath()
var index = 0
while index < tokens.count {
    let command = tokens[index]; index += 1
    if command == "Z" { path.close(); continue }
    guard ["M", "L"].contains(command), index + 1 < tokens.count,
          let x = Double(tokens[index]), let y = Double(tokens[index + 1]) else { fatalError("Invalid mark path") }
    index += 2
    let point = NSPoint(x: 256 + x * 8, y: 768 - y * 8)
    if command == "M" { path.move(to: point) } else { path.line(to: point) }
}

var images: [[String: String]] = []
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = points * scale
        let filename = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                      colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let context = NSGraphicsContext(bitmapImageRep: bitmap)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.cgContext.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
        shadow.shadowBlurRadius = 24
        shadow.shadowOffset = NSSize(width: 0, height: -12)
        shadow.set()
        NSColor(calibratedWhite: 0.98, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 96, y: 96, width: 832, height: 832), xRadius: 184, yRadius: 184).fill()
        NSGraphicsContext.restoreGraphicsState()
        NSColor(calibratedWhite: 45.0 / 255, alpha: 1).setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
        try bitmap.representation(using: .png, properties: [:])!.write(to: icon.appendingPathComponent(filename))
        images.append(["idiom": "mac", "size": "\(points)x\(points)", "scale": "\(scale)x", "filename": filename])
    }
}
try writeJSON(["info": info, "images": images], to: icon)
print("Generated macOS AppIcon and template VibtraMark from the canonical company geometry.")
