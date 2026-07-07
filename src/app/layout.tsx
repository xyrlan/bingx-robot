import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { getLocale } from "next-intl/server";
import { NextIntlClientProvider } from "next-intl";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { ToastProvider } from "@/components/toast-provider";
import { THEME_COOKIE_NAME } from "@/lib/theme";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mega Brain",
  description: "Automated grid trading bots for the BingX exchange",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const cookieStore = await cookies();
  const themeCookie = cookieStore.get(THEME_COOKIE_NAME)?.value;
  const theme = themeCookie === 'light' || themeCookie === 'dark' ? themeCookie : 'dark';

  const fontVariableClasses = `${inter.variable} ${jetbrainsMono.variable}`;

  return (
    <html lang={locale} data-theme={theme} className={`${theme} ${fontVariableClasses}`}>
      <body className="font-sans antialiased bg-background text-foreground">
        <NextIntlClientProvider>
          <ToastProvider />
          <NuqsAdapter>
            {children}
          </NuqsAdapter>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
