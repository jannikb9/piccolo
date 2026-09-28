import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri } from "./lib/api";
import { shikiThemes } from "./lib/codeThemes";
import { queryClient } from "./lib/queries";
import { useStore } from "./store";
import "./styles.css";

if (isTauri) {
  document.documentElement.dataset.tauri = "";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Syntax highlighting runs in web workers so scrolling large diffs stays smooth. */}
      <WorkerPoolContextProvider
        poolOptions={{ workerFactory: () => new DiffsWorker(), poolSize: 4 }}
        highlighterOptions={{ theme: shikiThemes(useStore.getState().codeTheme), lineDiffType: "word-alt" }}
      >
        <App />
      </WorkerPoolContextProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
