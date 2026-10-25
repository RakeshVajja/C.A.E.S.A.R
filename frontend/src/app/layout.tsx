import type { Metadata } from "next";
import { Source_Serif_4 } from "next/font/google";
import Script from "next/script";
import { AuthProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/toast";
import { THEME_BOOTSTRAP } from "@/lib/theme";
import "./globals.css";

// UI text uses San Francisco (SF Pro / SF Mono) through the system font stack in globals.css:
// Apple's licence does not allow serving SF Pro as a web font, so Apple devices render it natively
// and other systems use their own UI font.

// Serif for page titles and publication titles (design system §3); optical sizing for small titles.
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  axes: ["opsz"],
});

export const metadata: Metadata = {
  title: "CSE Research Hub | Professor Publication Management",
  description: "Centralized scholarly publication aggregation, deduplication, and verification platform for department professors.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={sourceSerif.variable} suppressHydrationWarning>
      <body className="min-h-dvh bg-canvas text-text antialiased">
        {/* Applies a chosen light/dark theme before hydration (data-theme on <html>; see lib/theme.ts). */}
        <Script id="theme-bootstrap" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
