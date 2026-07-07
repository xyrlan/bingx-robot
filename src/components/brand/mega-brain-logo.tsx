import { BrainCircuit } from 'lucide-react';

type MegaBrainLogoProps = {
  /** Size of the square mark, e.g. "w-8 h-8" */
  className?: string;
};

/**
 * Mega Brain brand mark: brain-circuit glyph on a violet→cyan gradient tile.
 * Matches the favicon at src/app/icon.svg.
 */
export function MegaBrainLogo({ className = 'w-8 h-8' }: MegaBrainLogoProps) {
  return (
    <span
      aria-hidden
      className={`inline-flex items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 text-white shrink-0 ${className}`}
    >
      <BrainCircuit className="w-[62%] h-[62%]" strokeWidth={2} />
    </span>
  );
}
