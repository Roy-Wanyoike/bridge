import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { getRegistryClient, isDemoMode } from '@/lib/registry-client';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'BRIDGE Registry Console',
    template: '%s | BRIDGE Registry Console',
  },
  description:
    'Multilingual contract compilation and compatibility: browse contracts, versions, dependency graph and compatibility reports.',
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
