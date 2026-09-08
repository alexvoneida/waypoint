import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The one display serif the design direction calls for, reserved for page
// titles and entry titles - everything else (UI, navigation, labels) stays
// on Geist Sans. Fraunces reads with real character at display sizes
// without tipping into decoration, which is what a photography site needs
// from the one place it spends typographic personality. Only the medium
// weight is loaded because that is the only weight the title styles use
// (see .text-page-title etc. in globals.css).
const displaySerif = Fraunces({
  variable: "--font-display-serif",
  subsets: ["latin"],
  weight: ["500"],
  style: ["normal"],
});

export const metadata: Metadata = {
  title: "Waypoint",
  description: "Photographs from a hike, placed on the GPS track that recorded it.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${displaySerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <main className="flex flex-1 flex-col">{children}</main>
      </body>
    </html>
  );
}
