import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TrayPanel } from "./TrayPanel";
import { installNativeFetchBridge } from "./platform/transport";
import "./tray.css";

installNativeFetchBridge();

createRoot(document.getElementById("tray-root")!).render(
  <StrictMode>
    <TrayPanel />
  </StrictMode>,
);
