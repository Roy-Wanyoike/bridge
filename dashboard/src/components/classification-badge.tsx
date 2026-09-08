import { Badge } from '@/components/ui/badge';
import type { Classification } from '@/lib/types';
import { cn } from '@/lib/utils';

const VARIANT: Record<Classification, 'success' | 'warning' | 'destructive' | 'unknown'> = {
  SAFE: 'success',
  WARNING: 'warning',
  BREAKING: 'destructive',
  UNKNOWN: 'unknown',
};

const DOT: Record<Classification, string> = {
  SAFE: 'bg-[var(--safe)]',
  WARNING: 'bg-[var(--warning)]',
  BREAKING: 'bg-[var(--breaking)]',
  UNKNOWN: 'bg-[var(--unknown)]',
};

export function ClassificationBadge({
  classification,
  className,
  withDot = true,
}: {
  classification: Classification;
  className?: string;
  withDot?: boolean;
}) {
  return (
    <Badge variant={VARIANT[classification]} className={cn('font-mono tracking-wide', className)}>
      {withDot && <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', DOT[classification])} />}
      {classification}
    </Badge>
  );
}

export function VerdictBadge({ verdict }: { verdict?: Classification }) {
  if (!verdict) {
    return (
      <Badge variant="outline" className="font-mono tracking-wide">
        NO DIFFS
      </Badge>
    );
  }
  return <ClassificationBadge classification={verdict} />;
}
