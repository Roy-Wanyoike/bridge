'use client';

import * as React from 'react';
import { ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ClassificationBadge } from '@/components/classification-badge';
import { formatDateTime } from '@/lib/format';
import type { AuditEntry } from '@/lib/types';

/** Row-level audit entry inspector: opens a dialog with the full record. */
export function AuditDetailDialog({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
        Details
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="relative">
          <DialogClose />
          <DialogTitle>Audit entry {entry.id}</DialogTitle>
          <DialogDescription>
            {entry.action} · {formatDateTime(entry.at)}
          </DialogDescription>
          <dl className="mt-4 grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Actor</dt>
            <dd>{entry.actor}</dd>
            <dt className="text-muted-foreground">Action</dt>
            <dd className="font-mono text-[13px]">{entry.action}</dd>
            <dt className="text-muted-foreground">Scope</dt>
            <dd className="font-mono text-[13px]">
              {entry.org} / {entry.project}
            </dd>
            <dt className="text-muted-foreground">Contract</dt>
            <dd className="font-mono text-[13px]">
              {entry.contract}
              {entry.version ? `@${entry.version}` : ''}
            </dd>
            {entry.verdict && (
              <>
                <dt className="text-muted-foreground">Verdict</dt>
                <dd>
                  <ClassificationBadge classification={entry.verdict} />
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Detail</dt>
            <dd className="break-words text-muted-foreground">{entry.detail}</dd>
          </dl>
          <pre className="mt-4 max-h-48 overflow-auto rounded-md border border-border bg-[#0d0d10] p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
            {JSON.stringify(entry, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
