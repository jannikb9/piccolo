import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri } from "./lib/api";
import { queryClient } from "./lib/queries";
import "./styles.css";

if (isTauri) {
  document.documentElement.dataset.tauri = "";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
