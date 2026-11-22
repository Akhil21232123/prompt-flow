import Foundation

enum Wav {
    static let sampleRate = 16_000

    /// Wraps little-endian 16-bit mono PCM in a WAV header.
    static func encode(pcm: Data, sampleRate: Int = sampleRate) -> Data {
        var out = Data(capacity: 44 + pcm.count)
        func u32(_ v: Int) { var x = UInt32(v).littleEndian; out.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: Int) { var x = UInt16(v).littleEndian; out.append(Data(bytes: &x, count: 2)) }
        out.append(contentsOf: Array("RIFF".utf8)); u32(36 + pcm.count); out.append(contentsOf: Array("WAVE".utf8))
        out.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1)
        u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16)
        out.append(contentsOf: Array("data".utf8)); u32(pcm.count)
        out.append(pcm)
        return out
    }

    /// Float samples (-1...1) to 16-bit PCM.
    static func pcm16(_ samples: [Float]) -> Data {
        var data = Data(capacity: samples.count * 2)
        for s in samples {
            var v = Int16(max(-1, min(1, s)) * Float(Int16.max)).littleEndian
            data.append(Data(bytes: &v, count: 2))
        }
        return data
    }
}

enum TextJoin {
    /// Spacing so dictated text doesn't glue onto the word before it.
    static func joinable(before: String, insert: String) -> String {
        guard let last = before.last, let first = insert.first else { return insert }
        let needsSpace = !last.isWhitespace && !first.isWhitespace
            && !".,!?;:)]}".contains(first) && !"([{".contains(last)
        return needsSpace ? " " + insert : insert
    }
}

extension Wav {
    /**
     Seconds of 16 kHz audio that sound like speech: 50 ms frames above an
     absolute floor and well above the clip's own background noise (capped so
     a clip that is speech end to end still counts).
     */
    static func voicedSeconds(_ samples: [Float]) -> Double {
        let frame = sampleRate / 20
        guard samples.count >= frame else { return 0 }
        var rms: [Float] = []
        rms.reserveCapacity(samples.count / frame)
        var i = 0
        while i + frame <= samples.count {
            var sum: Float = 0
            for j in i..<(i + frame) { sum += samples[j] * samples[j] }
            rms.append((sum / Float(frame)).squareRoot())
            i += frame
        }
        let sorted = rms.sorted()
        let noise = sorted[min(Int(Double(sorted.count) * 0.2), sorted.count - 1)]
        let threshold = max(0.012, min(noise * 3, 0.04))
        return Double(rms.filter { $0 > threshold }.count) * 0.05
    }
}
