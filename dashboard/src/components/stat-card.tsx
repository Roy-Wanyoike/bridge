import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Overview metric tile: icon, big number, label, optional footnote/link. */
export function StatCard({
  icon: Icon,
  value,
  label,
  footnote,
  href,
  className,
}: {
  icon: LucideIcon;
  value: string | number;
  label: string;
  footnote?: string;
  href?: string;
  className?: string;
}) {
  const body = (
    <Card
      className={cn(
        'flex flex-col gap-2 p-5 transition-colors',
        href && 'hover:border-primary/40 hover:bg-secondary/40',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      {footnote && <div className="text-xs text-muted-foreground">{footnote}</div>}
    </Card>
  );
  if (href) {
    return (
      <Link href={href} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
        {body}
      </Link>
    );
  }
  return body;
}
