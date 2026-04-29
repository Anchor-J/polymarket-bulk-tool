import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Polymarket 地址批量分析",
  description: "Batch analyze public Polymarket account data by address."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
