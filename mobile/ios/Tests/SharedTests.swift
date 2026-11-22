import XCTest

final class SharedTests: XCTestCase {
    func testWavHeader() {
        let wav = Wav.encode(pcm: Data(count: 10))
        XCTAssertEqual(wav.count, 54)
        XCTAssertEqual(String(data: wav.prefix(4), encoding: .ascii), "RIFF")
        XCTAssertEqual(String(data: wav.subdata(in: 8..<12), encoding: .ascii), "WAVE")
        XCTAssertEqual(UInt16(wav[24]) | UInt16(wav[25]) << 8, UInt16(16_000 & 0xFFFF))
    }

    func testPcmClamps() {
        let pcm = Wav.pcm16([0, 2, -2])
        XCTAssertEqual(pcm.count, 6)
        XCTAssertEqual(Int16(bitPattern: UInt16(pcm[2]) | UInt16(pcm[3]) << 8), Int16.max)
    }

    func testJoinable() {
        XCTAssertEqual(TextJoin.joinable(before: "Hi", insert: "there"), " there")
        XCTAssertEqual(TextJoin.joinable(before: "Hi ", insert: "there"), "there")
        XCTAssertEqual(TextJoin.joinable(before: "Hi", insert: ", ok"), ", ok")
        XCTAssertEqual(TextJoin.joinable(before: "", insert: "x"), "x")
    }

    func testAuthParsing() {
        let s = AuthSession.from(json: [
            "access_token": "a", "refresh_token": "r", "expires_in": 3600,
            "user": ["id": "u1", "email": "a@b.co"],
        ])
        XCTAssertEqual(s?.userId, "u1")
        XCTAssertEqual(s?.email, "a@b.co")
        XCTAssertEqual(s?.isExpired, false)
    }

    func testResultParsing() {
        let r = DictationResult.from(json: [
            "raw": "hi", "text": "Hi.", "mode": "engineer", "label": "x",
            "guarded": ["number 99"], "timing": ["total_ms": 812],
        ])
        XCTAssertEqual(r.mode, .engineer)
        XCTAssertEqual(r.guarded, ["number 99"])
        XCTAssertEqual(r.totalMs, 812)
    }

    func testStorePendingResultRoundTrip() {
        let defaults = UserDefaults(suiteName: "pf-tests-\(UUID().uuidString)")!
        let store = SharedStore(defaults: defaults)
        store.pendingResult = ("id1", "Hello")
        XCTAssertEqual(store.pendingResult?.id, "id1")
        XCTAssertEqual(store.pendingResult?.text, "Hello")
        store.heartbeat = Date()
        XCTAssertTrue(store.sessionIsLive)
        store.heartbeat = Date().addingTimeInterval(-10)
        XCTAssertFalse(store.sessionIsLive)
    }

    func testSignInLinkParams() {
        let ok = URL(string: "promptflow://auth#access_token=a&expires_in=3600&refresh_token=r1&token_type=bearer&type=magiclink")!
        XCTAssertEqual(API.linkParams(ok)["refresh_token"], "r1")
        let bad = URL(string: "promptflow://auth#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired")!
        XCTAssertEqual(API.linkParams(bad)["error_description"], "Email link is invalid or has expired")
    }
}
