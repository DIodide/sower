import SwiftUI

@main
struct SowerApp: App {
    @State private var settings = SettingsStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(settings)
        }
    }
}

struct RootView: View {
    enum Tab: Hashable { case pipeline, settings }

    @State private var selectedTab: Tab = .pipeline

    var body: some View {
        TabView(selection: $selectedTab) {
            PipelineView(openSettings: { selectedTab = .settings })
                .tabItem { Label("Pipeline", systemImage: "tray.full") }
                .tag(Tab.pipeline)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
    }
}
