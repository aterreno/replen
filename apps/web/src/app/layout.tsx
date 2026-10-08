import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Replen planner workbench",
  description: "Ordering and replenishment planner workbench (vertical slice, synthetic data)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
