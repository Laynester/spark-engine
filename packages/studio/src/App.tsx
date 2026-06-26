import { useState } from "react";
import { WelcomeScreen } from "./WelcomeScreen";
import { StudioLayout } from "./StudioLayout";
import type { WorkspaceManifest } from "./workspace";

type View =
  | { type: "welcome" }
  | { type: "studio"; manifest: WorkspaceManifest; path: string };

export function App() {
  const [view, setView] = useState<View>({ type: "welcome" });

  const handleOpenWorkspace = (manifest: WorkspaceManifest, path: string) => {
    setView({ type: "studio", manifest, path });
  };

  const handleBackToWelcome = () => {
    setView({ type: "welcome" });
  };

  switch (view.type) {
    case "welcome":
      return <WelcomeScreen onOpenWorkspace={handleOpenWorkspace} />;
    case "studio":
      return (
        <StudioLayout
          manifest={view.manifest}
          workspacePath={view.path}
          onBack={handleBackToWelcome}
        />
      );
  }
}
