import type { Metadata } from "next";
import "./globals.css";

const siteTitle = "MyLifeJourney - Your Personalized Life Storybook";
const siteDescription =
  "Create a beautiful personalized storybook from your life events. Add dates, photos, and memories to generate a printable slambook.";
const siteUrl = "https://mylifejourney.ai";
const ogImage = {
  url: "/og-image.svg",
  width: 1200,
  height: 630,
  alt: "MyLifeJourney — Your personalized life storybook",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: siteTitle,
  description: siteDescription,
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: siteUrl,
    siteName: "MyLifeJourney",
    type: "website",
    locale: "en_US",
    images: [ogImage],
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    images: [ogImage.url],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
