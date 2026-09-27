import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Expert Fruit Fly — a brain that learns",
  description:
    "A browser-sized fruit fly connectome that learns tasks (Chrome Dino, bicycle balancing) through reward and punishment, with real-time 3D brain visualization and saveable learned brains.",
  keywords: [
    "fruit fly",
    "connectome",
    "neural simulation",
    "neuroevolution",
    "dopamine learning",
    "spiking neural network",
  ],
  authors: [{ name: "pale-john1960" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Expert Fruit Fly",
    description: "A fruit fly brain that learns by reward & punishment",
    siteName: "Expert Fruit Fly",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
