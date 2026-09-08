import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function NotFound() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <FileQuestion className="h-10 w-10 text-muted-foreground/60" aria-hidden="true" />
      <h1 className="text-lg font-semibold">Contract not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The contract, project or version you requested does not exist in this registry scope.
      </p>
      <Link href="/contracts" className={cn(buttonVariants(), 'mt-2')}>
        Browse contracts
      </Link>
    </div>
  );
}
