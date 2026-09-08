import type { Metadata, Viewport } from 'next';
import { AppShell } from '@/components/app-shell';
import { getRegistryClient, isDemoMode } from '@/lib/registry-client';
import './globals.css';

const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(CONSOLE_URL),
  title: {
    default: 'BRIDGE Registry Console',
    template: '%s | BRIDGE Registry Console',
  },
  description:
    'Multilingual contract compilation and compatibility: browse contracts, versions, dependency graph and compatibility reports.',
  openGraph: {
    type: 'website',
    siteName: 'BRIDGE Registry Console',
    title: { default: 'BRIDGE Registry Console', template: '%s | BRIDGE Registry Console' },
    description:
      'Browse contracts, versions, dependency graph and compatibility reports for the BRIDGE registry.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0c',
  colorScheme: 'dark',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let orgs: Awaited<ReturnType<typeof getOrgs>> = [];
  try {
    orgs = await getOrgs();
  } catch {
    orgs = [];
  }

  return (
    <html lang="en">
      <body>
        <AppShell orgs={orgs} demoMode={isDemoMode()}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}

async function getOrgs() {
  const client = getRegistryClient();
  return client.listOrgs();
}
