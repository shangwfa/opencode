import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router"
import "@/index.css"
import { App } from "@/app"
import { ToastProvider } from "@/components/toast"
import { LocalProvider } from "@/context/local"
import { PromptControllerProvider } from "@/context/prompt-store"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <LocalProvider>
        <PromptControllerProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </PromptControllerProvider>
      </LocalProvider>
    </HashRouter>
  </StrictMode>,
)
