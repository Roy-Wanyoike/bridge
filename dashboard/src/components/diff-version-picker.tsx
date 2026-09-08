'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { Select } from '@/components/ui/input';

/**
 * From/to version selector for the compatibility report. Selecting a version
 * navigates to the same page with updated query params (server-rendered).
 */
export function DiffVersionPicker({
  basePath,
  versions,
  from,
  to,
}: {
  basePath: string;
  versions: { version: string }[];
  from: string;
  to: string;
}) {
  const router = useRouter();
  const ordered = React.useMemo(() => [...versions].map((v) => v.version), [versions]);

  const navigate = (nextFrom: string, nextTo: string) => {
    router.push(`${basePath}/diff?from=${encodeURIComponent(nextFrom)}&to=${encodeURIComponent(nextTo)}`);
  };

  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="sr-only">Base version</span>
        <span>from</span>
        <Select
          value={from}
          onChange={(e) => navigate(e.target.value, to)}
          className="h-8 w-24 font-mono text-xs"
        >
          {ordered.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      </label>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="sr-only">Target version</span>
        <span>to</span>
        <Select
          value={to}
          onChange={(e) => navigate(from, e.target.value)}
          className="h-8 w-24 font-mono text-xs"
        >
          {ordered.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}
