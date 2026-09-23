import { acquireWalletDirectoryLock, FileWalletRepository } from "./src/core/storage.ts";
import { type AvailableScreenArea, fitWindowToScreen } from "./src/desktop_window.ts";
import type {
  BpubPreviewRequest,
  CreateWalletRequest,
  RestoreWalletRequest,
  SpendPreviewRequest,
  WalletSettingsUpdate,
} from "./src/core/types.ts";
import { WalletService } from "./src/core/wallet_service.ts";
import {
  browserListenPort,
  capabilityMatches,
  createRpcCapability,
  resolveUiResource,
  shouldUseUiIndexFallback,
} from "./src/server_security.ts";
import { setWindowsWindowAppearance } from "./src/windows_window_background.ts";
import { focusWindowsWebview } from "./src/windows_webview_focus.ts";

type RpcRequest = { method: string; payload?: unknown };

const repository = new FileWalletRepository();
const walletDirectoryLock = await acquireWalletDirectoryLock(repository.directory);
const wallet = new WalletService(repository);
await wallet.initialize();

async function dispatch(request: RpcRequest): Promise<unknown> {
  if (!request || typeof request.method !== "string") throw new Error("Malformed wallet request");
  switch (request.method) {
    case "previewBpub":
      return await wallet.previewBpub(request.payload as BpubPreviewRequest);
    case "confirmBpub":
      return await wallet.confirmBpub(
        String((request.payload as { id?: unknown })?.id ?? ""),
        (request.payload as { acceptHighFee?: unknown })?.acceptHighFee === true,
      );
    case "cancelBpubPreview":
      return await wallet.cancelBpubPreview(
        String((request.payload as { id?: unknown })?.id ?? ""),
      );
    case "resumeBpub":
      return await wallet.resumeBpub(String((request.payload as { id?: unknown })?.id ?? ""));
    case "snapshot":
      return wallet.snapshot();
    case "createWallet":
      return await wallet.createWallet((request.payload ?? {}) as CreateWalletRequest);
    case "restoreWallet":
      return await wallet.restoreWallet(request.payload as RestoreWalletRequest);
    case "unlock":
      return await wallet.unlock(
        String((request.payload as { password?: string })?.password ?? ""),
      );
    case "recoveryPhrase":
      return await wallet.recoveryPhrase();
    case "acknowledgeRecoveryPhrase":
      return await wallet.acknowledgeRecoveryPhrase();
    case "lock":
      return wallet.lock();
    case "newReceiveAddress":
      return await wallet.newReceiveAddress();
    case "sync":
      return await wallet.sync();
    case "fullRescan":
      return await wallet.fullRescan();
    case "updateSettings":
      return await wallet.updateSettings(request.payload as WalletSettingsUpdate);
    case "previewSpend":
      return await wallet.previewSpend(request.payload as SpendPreviewRequest);
    case "confirmSpend":
      return await wallet.confirmSpend(
        String((request.payload as { id?: string })?.id ?? ""),
        (request.payload as { acceptHighFee?: unknown })?.acceptHighFee === true,
        (request.payload as { acceptReplayRisk?: unknown })?.acceptReplayRisk === true,
      );
    case "cancelSpendPreview":
      return await wallet.cancelSpendPreview(
        String((request.payload as { id?: string })?.id ?? ""),
      );
    case "previewReplay":
      return await wallet.previewReplay(
        String((request.payload as { txid?: string })?.txid ?? ""),
      );
    case "confirmReplay":
      return await wallet.confirmReplay(String((request.payload as { id?: string })?.id ?? ""));
    case "cancelReplayPreview":
      return await wallet.cancelReplayPreview(
        String((request.payload as { id?: string })?.id ?? ""),
      );
    case "rebroadcastIntent":
      return await wallet.rebroadcastIntent(
        String((request.payload as { id?: string })?.id ?? ""),
      );
    case "abandonIntent":
      return await wallet.abandonIntent(
        String((request.payload as { id?: string })?.id ?? ""),
      );
    default:
      throw new Error(`Unknown wallet method: ${request.method}`);
  }
}

interface DesktopWindow {
  bind<T>(name: string, handler: (request: T) => unknown | Promise<unknown>): void;
  addEventListener(type: "close", listener: () => void): void;
  focus(): void;
  setPosition(x: number, y: number): void;
  setSize(width: number, height: number): void;
}

interface DesktopWindowConstructor {
  new (options?: { title?: string; width?: number; height?: number }): DesktopWindow;
}

interface DesktopScreenMetrics extends AvailableScreenArea {
  devicePixelRatio: number;
}

const BrowserWindow =
  (Deno as unknown as { BrowserWindow?: DesktopWindowConstructor }).BrowserWindow;
if (BrowserWindow) {
  const window = new BrowserWindow({ title: "BcashJr Wallet", width: 800, height: 600 });
  void setWindowsWindowAppearance(0x09, 0x0c, 0x10).then((appearance) => {
    if (Deno.build.os === "windows" && !appearance.clientBackground) {
      console.warn("Could not apply the native desktop window background");
    }
    if (Deno.build.os === "windows" && !appearance.titleBar) {
      console.warn("Could not apply the native desktop title-bar colors");
    }
  }).catch((error) => console.warn("Could not apply the native desktop window colors", error));
  window.bind<RpcRequest>("walletRpc", dispatch);
  let fittedToScreen = false;
  window.bind<DesktopScreenMetrics>("fitDesktopWindow", (screen) => {
    if (!fittedToScreen) {
      const nativeScaleFactor = Deno.build.os === "windows" ? screen.devicePixelRatio : 1;
      const geometry = fitWindowToScreen(screen, nativeScaleFactor);
      if (geometry) {
        window.setSize(geometry.width, geometry.height);
        window.setPosition(geometry.x, geometry.y);
        fittedToScreen = true;
      }
    }
    window.focus();
    return null;
  });
  window.bind("focusDesktopContent", () => {
    try {
      return focusWindowsWebview();
    } catch (error) {
      // A native focus failure must not prevent the wallet UI from opening.
      console.warn("Could not focus the desktop content", error);
      return false;
    }
  });
  window.addEventListener("close", () => {
    walletDirectoryLock.close();
    Deno.exit(0);
  });
}

const uiRoot = new URL("./dist/ui/", import.meta.url);
const rpcCapability = createRpcCapability();

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

async function staticResponse(pathname: string): Promise<Response> {
  let resource = resolveUiResource(uiRoot, pathname);
  if (!resource) return new Response("Not found", { status: 404, headers: securityHeaders });
  try {
    const bytes = await Deno.readFile(resource);
    const extension = resource.pathname.match(/\.[^.]+$/u)?.[0] ?? "";
    return new Response(bytes, {
      headers: {
        ...securityHeaders,
        "Content-Type": contentTypes[extension] ?? "application/octet-stream",
      },
    });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    if (!shouldUseUiIndexFallback(pathname)) {
      return new Response("Not found", { status: 404, headers: securityHeaders });
    }
    resource = new URL("index.html", uiRoot);
    return new Response(await Deno.readFile(resource), {
      headers: { ...securityHeaders, "Content-Type": contentTypes[".html"] },
    });
  }
}

export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/rpc") {
    if (
      request.method !== "POST" ||
      !capabilityMatches(request.headers.get("x-bcashjr-capability"), rpcCapability)
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Wallet session expired after the server restarted. Open the new private wallet URL printed in the terminal.",
        },
        { status: 403, headers: securityHeaders },
      );
    }
    try {
      const result = await dispatch(await request.json() as RpcRequest);
      return Response.json({ ok: true, result }, { headers: securityHeaders });
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 400, headers: securityHeaders },
      );
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: securityHeaders });
  }
  return await staticResponse(url.pathname);
}

if (import.meta.main) {
  const desktopAddress = Deno.env.get("DENO_SERVE_ADDRESS");
  if (desktopAddress) {
    Deno.serve(handler);
  } else {
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: browserListenPort(Deno.env.get("PORT")),
    }, handler);
    console.log(
      `BcashJr Wallet is running at http://127.0.0.1:${server.addr.port}/#rpc=${rpcCapability}`,
    );
  }
}
