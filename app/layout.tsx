import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: {
      default: "Yomu 阅读器",
      template: "%s · Yomu",
    },
    description: "书架、搜书与跨端同步。",
    applicationName: "Yomu 阅读器",
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    },
    appleWebApp: {
      capable: true,
      title: "Yomu",
      statusBarStyle: "black-translucent",
    },
    formatDetection: { telephone: false },
    openGraph: {
      type: "website",
      title: "Yomu 阅读器",
      description: "书架、搜书与跨端同步。",
      siteName: "Yomu 阅读器",
      url: origin,
      locale: "zh_CN",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "Yomu 轻阅读" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Yomu 阅读器",
      description: "书架、搜书与跨端同步。",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
