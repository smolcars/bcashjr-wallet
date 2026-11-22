import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { callDesktopJson } from "../desktop_json.ts";
import "./styles.css";

interface DesktopBindings {
  fitDesktopWindow(screen: string): Promise<string>;
  focusDesktopContent(): Promise<unknown>;
}

const desktopBindings = (globalThis as unknown as { bindings?: DesktopBindings }).bindings;

async function mountApp() {
  if (desktopBindings?.fitDesktopWindow) {
    const desktopScreen = screen as Screen & { availLeft?: number; availTop?: number };
    await callDesktopJson((request) => desktopBindings.fitDesktopWindow(request), {
      availWidth: desktopScreen.availWidth,
      availHeight: desktopScreen.availHeight,
      availLeft: desktopScreen.availLeft ?? 0,
      availTop: desktopScreen.availTop ?? 0,
      devicePixelRatio: globalThis.devicePixelRatio,
    }).catch(() => undefined);
    // Native window activation must finish before transferring keyboard focus
    // into WebView2. React's input autofocus alone cannot make that handoff.
    await desktopBindings.focusDesktopContent().catch(() => undefined);
  }

  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void mountApp();
