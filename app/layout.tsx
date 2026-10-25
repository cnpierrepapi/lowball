import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Bricolage_Grotesque({ variable: "--font-display-face", subsets: ["latin"], weight: ["700", "800"] });
const sans = Instrument_Sans({ variable: "--font-sans-body", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono-body", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Lowball",
  description: "Nothing in this shop has a price tag. Haggle with an AI shopkeeper and pay what you talk him down to, in USDC on Solana.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
