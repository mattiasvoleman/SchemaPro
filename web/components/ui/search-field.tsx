import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface SearchFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  id: string;
  /** The field's name ("Sök klass"). Visible unless hideLabel; always the input's accessible name. */
  label: string;
  /** Visually hides the label when the context already says what is searched (it stays for screen readers). */
  hideLabel?: boolean;
  value: string;
  onValueChange: (value: string) => void;
  /** On the outer wrapper. */
  className?: string;
}

/**
 * A labelled search box: the Search icon inside the left edge, a type=search
 * input after it, held to max-w-sm. Replaces the placeholder-only boxes on
 * groups and people. Use it inside a FilterBar, where its label lines up
 * with the FilterFields beside it. A search that matches nothing shows an
 * in-table "Inget matchar …" row, never the page's empty state.
 */
export function SearchField({
  id,
  label,
  hideLabel = false,
  value,
  onValueChange,
  className,
  ...inputProps
}: SearchFieldProps) {
  return (
    <div className={cn("w-full max-w-sm space-y-1.5", className)}>
      <Label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </Label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={id}
          type="search"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          className="pl-9"
          {...inputProps}
        />
      </div>
    </div>
  );
}
