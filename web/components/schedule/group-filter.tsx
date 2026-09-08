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
import type { StudentGroup } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Which groups the grundschema shows — none meaning all of them.
 *
 * It used to be a Select: everything, or one class at a time. A rektor
 * comparing 4.1 with 4.2, or reading the three teaching groups a class is cut
 * into, had to choose between one of them and the whole school at once.
 *
 * AN EMPTY SELECTION IS "ALL", deliberately, rather than a sentinel value
 * beside the ids. "No filter" and "show everything" are the same state here,
 * and giving them two representations is how one of them ends up handled in
 * three places out of four.
 *
 * The two kinds are sectioned rather than mixed. A school has a couple of
 * dozen classes and can have hundreds of teaching groups — Kunskapsskolan has
 * 24 and 300 — so a flat list is a scroll, and the class a rektor wants is
 * somewhere in the middle of it. The search box is there for the same reason
 * and matches both sections at once.
 */
export interface GroupFilterProps {
  groups: StudentGroup[];
  /** Selected group ids; empty means every group. */
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
}

export function GroupFilter({ groups, value, onChange, className }: GroupFilterProps) {
  const t = useTranslations("timetable");
  const tCommon = useTranslations("common");
  const [search, setSearch] = useState("");

  const matching = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("sv");
    const hit = (group: StudentGroup) =>
      !needle || group.name.toLocaleLowerCase("sv").includes(needle);
    return {
      classes: groups.filter((group) => group.kind === "CLASS" && hit(group)),
      teaching: groups.filter((group) => group.kind !== "CLASS" && hit(group)),
    };
  }, [groups, search]);

  const selected = new Set(value);
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id]);

  /*
   * The trigger says what is showing, not what the control is for. One group
   * is named — that is the case a rektor is in most of the time, and the name
   * is the whole answer; several are counted, because four names do not fit a
   * button and truncating them would name some and hide others.
   */
  const label =
    value.length === 0
      ? t("allGroups")
      : value.length === 1
        ? (groups.find((group) => group.id === value[0])?.name ?? t("groupsSelected", { count: 1 }))
        : t("groupsSelected", { count: value.length });

  const section = (title: string, rows: StudentGroup[]) =>
    rows.length === 0 ? null : (
      <>
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        {rows.map((group) => (
          <DropdownMenuCheckboxItem
            key={group.id}
            checked={selected.has(group.id)}
            // Without this the menu closes on every tick, and choosing three
            // groups means opening it three times.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => toggle(group.id)}
          >
            {group.name}
          </DropdownMenuCheckboxItem>
        ))}
      </>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={cn("w-56 justify-between font-normal", className)}
          aria-label={t("filterGroup")}
        >
          <span className="truncate">{label}</span>
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
          {t("allGroups")}
        </button>
        {section(t("filterKindClasses"), matching.classes)}
        {matching.classes.length > 0 && matching.teaching.length > 0 ? (
          <DropdownMenuSeparator />
        ) : null}
        {section(t("filterKindTeachingGroups"), matching.teaching)}
        {matching.classes.length === 0 && matching.teaching.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            {tCommon("noResults")}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
