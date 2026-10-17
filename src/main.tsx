import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installNativeFetchBridge } from "./platform/transport";
import "./styles.css";

installNativeFetchBridge();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
