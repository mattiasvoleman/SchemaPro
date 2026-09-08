"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Pick several of something, or none meaning all of them.
 *
 * The grundschema's filters used to be Selects: everything, or one at a time.
 * A rektor comparing 4.1 with 4.2, reading the three teaching groups a class
 * is cut into, or looking at what two slöjd rooms hold between them, had to
 * choose between one of them and the whole school.
 *
 * AN EMPTY SELECTION IS "ALL", deliberately, rather than a sentinel value
 * beside the ids. "No filter" and "show everything" are the same state, and
 * giving them two representations is how one of them ends up handled in three
 * places out of four.
 *
 * SECTIONS ARE OPTIONAL and exist for the one list that needs them. A school
 * has a couple of dozen classes and can have hundreds of teaching groups —
 * Kunskapsskolan has 24 and 300 — so mixing those two into one list buries the
 * class a rektor wants. Teachers and rooms are one list each and pass a single
 * unlabelled section.
 */
export interface FilterOption {
  id: string;
  name: string;
}

export interface FilterSection {
  /** Omitted for a single-section list, which needs no heading. */
  label?: string;
  options: FilterOption[];
}

export interface FilterPickerProps {
  sections: FilterSection[];
  /** Selected ids; empty means every option. */
  value: string[];
  onChange: (next: string[]) => void;
  /** What the trigger says, and what a screen reader calls the control. */
  label: string;
  /** What the trigger says when nothing is picked — "Alla lärare". */
  allLabel: string;
  /** Rendered with `{count}` when several are picked. */
  countLabel: (count: number) => string;
  className?: string;
}

export function FilterPicker({
  sections,
  value,
  onChange,
  label,
  allLabel,
  countLabel,
  className,
}: FilterPickerProps) {
  const tCommon = useTranslations("common");
  const [search, setSearch] = useState("");

  const matching = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("sv");
    return sections
      .map((section) => ({
        ...section,
        options: needle
          ? section.options.filter((option) =>
              option.name.toLocaleLowerCase("sv").includes(needle),
            )
          : section.options,
      }))
      .filter((section) => section.options.length > 0);
  }, [sections, search]);

  const selected = new Set(value);
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id]);

  /*
   * The trigger says what is showing, not what the control is for. One is
   * NAMED — that is the case a rektor is in most of the time, and the name is
   * the whole answer; several are counted, because four names do not fit a
   * button and truncating them would name some and hide the rest.
   */
  const chosen =
    value.length === 1
      ? sections.flatMap((section) => section.options).find((option) => option.id === value[0])
      : undefined;
  const triggerLabel =
    value.length === 0 ? allLabel : (chosen?.name ?? countLabel(value.length));

  const empty = matching.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={cn("w-52 justify-between font-normal", className)}
          aria-label={label}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-96 w-64 overflow-y-auto" align="start">
        <div className="p-1">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tCommon("search")}
            className="h-8"
            /*
             * A menu answers printable keys with its own typeahead, which would
             * jump the highlight around while the box is being typed into.
             */
            onKeyDown={(event) => event.stopPropagation()}
          />
        </div>
        <DropdownMenuSeparator />
        <button
          type="button"
          onClick={() => onChange([])}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
        >
          {value.length === 0 ? (
            <Check className="size-4" />
          ) : (
            <X className="size-4 opacity-50" />
          )}
          {allLabel}
        </button>
        {matching.map((section, index) => (
          <div key={section.label ?? index}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {section.label ? <DropdownMenuLabel>{section.label}</DropdownMenuLabel> : null}
            {section.options.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.id}
                checked={selected.has(option.id)}
                // Without this the menu closes on every tick, and choosing
                // three groups means opening it three times.
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggle(option.id)}
              >
                {option.name}
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        ))}
        {empty ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">{tCommon("noResults")}</p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
