import type { Metadata } from "next";
import { AntdProvider } from "@/hooks/use-system-theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "antd Chat",
  description: "Generative UI Chat with antd components",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <AntdProvider>{children}</AntdProvider>
      </body>
    </html>
  );
}