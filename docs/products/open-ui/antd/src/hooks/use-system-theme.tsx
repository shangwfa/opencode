"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { ConfigProvider, theme } from "antd";

const PRIMARY = "#ed0e3b";

type ThemeMode = "light" | "dark";

interface ThemeContextType {
  mode: ThemeMode;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function getSystemMode(): ThemeMode {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function AntdProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(getSystemMode);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setMode(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    document.body.setAttribute("data-theme", mode);
    document.documentElement.style.setProperty("--app-primary", PRIMARY);
    document.documentElement.style.setProperty("--app-primary-bg", mode === "dark" ? "#2d0a12" : "#fef0f2");
  }, [mode]);

  return (
    <ThemeContext.Provider value={{ mode }}>
      <ConfigProvider
        theme={{
          algorithm: mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: {
            colorPrimary: PRIMARY,
            colorInfo: PRIMARY,
            colorLink: PRIMARY,
            colorLinkActive: "#d10d34",
            colorLinkHover: "#f0284d",
            borderRadius: 8,
          },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeMode {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within an AntdProvider");
  }
  return ctx.mode;
}