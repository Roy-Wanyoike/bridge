import { CopyButton } from '@/components/copy-button';
import { cn } from '@/lib/utils';

/**
 * Terminal-style snippet block with an optional per-line or whole-block copy
 * affordance. Used for pull/generate commands on contract pages.
 */
export function CodeSnippet({
  command,
  className,
  label,
}: {
  command: string;
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={cn(
        'group flex items-center justify-between gap-3 rounded-md border border-border bg-[#0d0d10] px-3 py-2',
        className,
      )}
    >
      <code
        className="overflow-x-auto whitespace-nowrap font-mono text-[13px] leading-6 text-zinc-300"
        aria-label={label ?? 'Command snippet'}
      >
        <span className="select-none text-primary" aria-hidden="true">
          ${' '}
        </span>
        {command}
      </code>
      <CopyButton value={command} className="shrink-0" />
    </div>
  );
}
