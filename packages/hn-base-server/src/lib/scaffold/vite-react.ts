/**
 * 前端应用脚手架：Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui。
 *
 * 输出为 Git 提交所需的文件动作（create），由 Git Provider 的 commitFiles 写入。
 * 保持最小可运行：`bun install && bun run dev` 即可启动。
 */

export type ScaffoldFile = { path: string; content: string }

export type ScaffoldInput = {
  /** 应用名（用于 package.json name / README） */
  name: string
  /** 应用 ID（仓库名） */
  appId: string
}

function packageJson(input: ScaffoldInput): string {
  return JSON.stringify(
    {
      name: input.appId,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc -b && vite build",
        preview: "vite preview",
      },
      dependencies: {
        "class-variance-authority": "^0.7.1",
        clsx: "^2.1.1",
        "lucide-react": "^0.545.0",
        react: "^19.2.0",
        "react-dom": "^19.2.0",
        "tailwind-merge": "^3.3.1",
      },
      devDependencies: {
        "@tailwindcss/vite": "^4.1.11",
        "@types/node": "^24.12.2",
        "@types/react": "^19.2.0",
        "@types/react-dom": "^19.2.0",
        "@vitejs/plugin-react": "^5.0.0",
        tailwindcss: "^4.1.11",
        typescript: "~5.9.0",
        vite: "^7.3.0",
      },
    },
    null,
    2,
  )
}

const indexHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__APP_NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

const viteConfig = `import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
})
`

const tsconfig = `{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }]
}
`

const tsconfigApp = `{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
`

const tsconfigNode = `{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true,
    "types": ["node"]
  },
  "include": ["vite.config.ts"]
}
`

const mainTsx = `import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { App } from "./App"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`

const appTsx = `import { Button } from "@/components/ui/button"

export function App() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background text-foreground">
      <h1 className="text-2xl font-semibold tracking-tight">__APP_NAME__</h1>
      <p className="text-muted-foreground text-sm">Vite + React + Tailwind CSS v4 + shadcn/ui</p>
      <Button>开始开发</Button>
    </main>
  )
}
`

const indexCss = `@import "tailwindcss";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-border: var(--border);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --radius-lg: var(--radius);
}

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --border: oklch(0.922 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --radius: 0.625rem;
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --border: oklch(1 0 0 / 12%);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
}

* {
  border-color: var(--border);
}

body {
  background-color: var(--background);
  color: var(--foreground);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial,
    "Noto Sans SC", sans-serif;
}
`

const utilsTs = `import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
`

const buttonTsx = `import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        outline: "border bg-background hover:bg-muted",
        ghost: "hover:bg-muted",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  ),
)
Button.displayName = "Button"

export { buttonVariants }
`

const componentsJson = `{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
`

const gitignore = `node_modules
dist
dist-ssr
*.local
.DS_Store
.env
.env.local
*.tsbuildinfo
`

function readme(input: ScaffoldInput): string {
  return `# ${input.name}

由 OpenCode Chat 创建的 **Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui** 项目。

## 开始

\`\`\`bash
bun install
bun run dev
\`\`\`

## 添加 shadcn 组件

\`\`\`bash
npx shadcn@latest add card dialog input
\`\`\`

配置文件见 \`components.json\`，样式入口 \`src/index.css\`。
`
}

export function viteReactScaffold(input: ScaffoldInput): ScaffoldFile[] {
  const replaceName = (text: string) => text.replaceAll("__APP_NAME__", input.name)
  return [
    { path: "package.json", content: packageJson(input) },
    { path: "index.html", content: replaceName(indexHtml) },
    { path: "vite.config.ts", content: viteConfig },
    { path: "tsconfig.json", content: tsconfig },
    { path: "tsconfig.app.json", content: tsconfigApp },
    { path: "tsconfig.node.json", content: tsconfigNode },
    { path: "src/main.tsx", content: mainTsx },
    { path: "src/App.tsx", content: replaceName(appTsx) },
    { path: "src/index.css", content: indexCss },
    { path: "src/lib/utils.ts", content: utilsTs },
    { path: "src/components/ui/button.tsx", content: buttonTsx },
    { path: "components.json", content: componentsJson },
    { path: ".gitignore", content: gitignore },
    { path: "README.md", content: readme(input) },
  ]
}
