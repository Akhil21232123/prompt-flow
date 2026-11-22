import SwiftUI

struct OnboardingView: View {
    var finished: () -> Void
    @State private var step = 0

    var body: some View {
        VStack {
            switch step {
            case 0: welcome
            case 1: microphone
            case 2: keyboard
            default: signIn
            }
        }
        .padding(28)
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: step)
    }

    private var welcome: some View {
        VStack(spacing: 18) {
            Spacer()
            Orb(phase: .ready, mode: .dictate, level: 0) { step = 1 }
            Text("PromptFlow").font(.largeTitle.bold())
            Text("Speak anywhere you can type. Clean text in messages, and prompts that get more out of every AI.")
                .multilineTextAlignment(.center)
                .foregroundStyle(Brand.muted)
            Spacer()
            GradientButton(title: "Get started") { step = 1 }
        }
        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)).combined(with: .opacity))
    }

    @EnvironmentObject var engine: FlowEngine
    @State private var micAllowed = false

    private var microphone: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            Image(systemName: "mic.circle.fill").font(.system(size: 56)).foregroundStyle(Brand.gradient(.dictate))
            Text("Allow the microphone").font(.title.bold())
            Text("PromptFlow listens only during a Flow Session, and iOS shows the orange mic dot whenever it does.")
                .foregroundStyle(Brand.muted)
            Spacer()
            GradientButton(title: micAllowed ? "Continue" : "Allow microphone") {
                if micAllowed { step = 2 } else {
                    Task {
                        micAllowed = await engine.requestMicrophone()
                        if micAllowed { step = 2 }
                    }
                }
            }
            Button("Skip for now") { step = 2 }.frame(maxWidth: .infinity).foregroundStyle(Brand.muted)
        }
        .onAppear { micAllowed = engine.micAllowed }
        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)).combined(with: .opacity))
    }

    private var keyboard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            Image(systemName: "keyboard.fill").font(.system(size: 52)).foregroundStyle(Brand.gradient(.engineer))
            Text("Add the PromptFlow keyboard").font(.title.bold())
            VStack(alignment: .leading, spacing: 10) {
                Label("Open Settings → General → Keyboard → Keyboards", systemImage: "1.circle.fill")
                Label("Add New Keyboard → PromptFlow", systemImage: "2.circle.fill")
                Label("Tap PromptFlow → turn on Allow Full Access", systemImage: "3.circle.fill")
            }
            .foregroundStyle(.white)
            Text("Full Access lets the keyboard talk to the PromptFlow app, which does the listening. PromptFlow never sees what you type with other keyboards.")
                .font(.footnote)
                .foregroundStyle(Brand.muted)
            Spacer()
            GradientButton(title: "Open Settings", mode: .engineer) {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            Button("I've added it") { step = 3 }.frame(maxWidth: .infinity).foregroundStyle(Brand.muted)
        }
        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)).combined(with: .opacity))
    }

    private var signIn: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            Text("Sign in").font(.title.bold())
            Text("Your dictionary, snippets and styles sync across iPhone, Android and Mac.")
                .foregroundStyle(Brand.muted)
            AccountForm(onSignedIn: finished)
            Spacer()
            Button("Later") { finished() }.frame(maxWidth: .infinity).foregroundStyle(Brand.muted)
        }
        .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)).combined(with: .opacity))
    }
}

/// Email + 6-digit code sign-in.
struct AccountForm: View {
    var onSignedIn: () -> Void
    @State private var email = ""
    @State private var code = ""
    @State private var sent = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 12) {
            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 14).fill(Brand.surfaceHigh))
            if sent {
                Label("Check your email on this phone and tap the link. PromptFlow opens signed in.",
                      systemImage: "envelope.open.fill")
                    .font(.subheadline)
                    .foregroundStyle(Brand.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                TextField("Or enter the code, if your email has one", text: $code)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.numberPad)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Brand.surfaceHigh))
                    .onChange(of: code) { _, v in code = String(v.filter(\.isNumber).prefix(6)) }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            GradientButton(title: sent ? "Sign in with code" : "Email me a sign-in link",
                           enabled: !busy && email.contains("@") && (!sent || code.count == 6)) {
                busy = true
                error = nil
                Task {
                    defer { busy = false }
                    do {
                        if sent {
                            try await API.shared.verifyCode(email: email, code: code)
                        } else {
                            try await API.shared.sendCode(email: email)
                            withAnimation { sent = true }
                        }
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .promptflowSignedIn)) { _ in
            onSignedIn()
        }
        .onReceive(NotificationCenter.default.publisher(for: .promptflowSignInFailed)) { note in
            error = note.object as? String
        }
    }
}
