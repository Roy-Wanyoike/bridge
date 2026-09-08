'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <AlertTriangle className="h-10 w-10 text-[var(--warning)]" aria-hidden="true" />
      <h1 className="text-lg font-semibold">Could not reach the registry</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The registry service returned an error or is unreachable. Check
        NEXT_PUBLIC_REGISTRY_URL and try again.
      </p>
      <Button variant="outline" className="mt-2" onClick={() => reset()}>
        Retry
      </Button>
    </div>
  );
}
