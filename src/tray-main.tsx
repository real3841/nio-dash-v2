import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CompactTrayPanel } from "./components/CompactTrayPanel";
import { installNativeFetchBridge } from "./platform/transport";
import "./tray.css";

installNativeFetchBridge();

createRoot(document.getElementById("tray-root")!).render(
  <StrictMode>
    <CompactTrayPanel />
  </StrictMode>,
);
