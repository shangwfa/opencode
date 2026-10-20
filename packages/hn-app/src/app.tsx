import { Navigate, Route, Routes } from "react-router"
import { AuthGate } from "@/components/auth-gate"
import { AuthProvider } from "@/lib/auth"
import { LoginPage } from "@/pages/login"
import { AppLayout } from "@/components/layout"
import { HomePage } from "@/pages/home"
import { RequirementChatPage } from "@/pages/requirement-chat"
import { FreeChatPage } from "@/pages/free-chat"
import { ProjectIntakePage } from "@/pages/project-intake"
import { ProjectIntakeSessionPage } from "@/pages/project-intake/ProjectIntakeSessionPage"
import { DashboardPage } from "@/pages/dashboard"
import { GitProvidersPage } from "@/pages/git-providers"
import { AppsPage } from "@/pages/apps"
import { RequirementsPage } from "@/pages/requirements"
import { AppDetailPage } from "@/pages/app-detail"
import { AgentRegistryPage } from "@/pages/agent-registry"
import { CdpPage } from "@/pages/cdp"
import { SessionPage } from "@/pages/session"
import { NotFoundPage } from "@/pages/not-found"

export function App() {
  return (
  <AuthProvider>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* 应用工作台：独立布局（自己的侧栏菜单，不复用 L1 图标栏） */}
      <Route
        path="/apps/:appId"
        element={
          <AuthGate>
            <AppDetailPage />
          </AuthGate>
        }
      />
      <Route element={<AuthGate><AppLayout /></AuthGate>}>
        <Route path="/" element={<HomePage />} />
        <Route path="/requirement-chat/:repo/:sessionId" element={<RequirementChatPage />} />
        <Route path="/requirement-chat/:repo" element={<Navigate to="/apps" replace />} />
        <Route path="/requirement-chat" element={<Navigate to="/apps" replace />} />
        <Route path="/free-chat" element={<FreeChatPage />} />
        <Route path="/free-chat/session/:sessionId" element={<FreeChatPage />} />
        <Route path="/project-intake" element={<ProjectIntakePage />} />
        <Route path="/project-intake/:dir/:sessionId" element={<ProjectIntakeSessionPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/git-providers" element={<GitProvidersPage />} />
        <Route path="/apps" element={<AppsPage />} />
        <Route path="/requirements" element={<RequirementsPage />} />
        <Route path="/agent-registry" element={<AgentRegistryPage />} />
        <Route path="/cdp" element={<CdpPage />} />
        <Route path="/session/:sessionId" element={<SessionPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  </AuthProvider>
  )
}
