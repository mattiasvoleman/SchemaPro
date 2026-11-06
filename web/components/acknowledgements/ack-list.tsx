"use client";

import { ClipboardCheck } from "lucide-react";
import { useAckList } from "@/lib/ack-queries";
import { isDone, reminderOf, type AckListItem } from "@/lib/ack";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { useAckText } from "./use-ack-text";

/** The id of the button that opens a request, so the page can hand focus back to it. */
export const openerId = (id: string) => `ack-open-${id}`;

/**
 * The requests the reader may see, newest first, with counts and no names: how
 * many of the pupils are done, how many guardians still wait and what became of
 * the reminder. Who the pupils and the guardians are is behind the title, in the
 * request itself, where the gateway records the reading.
 */
export function AckList({
  audience,
  onOpen,
}: {
  audience: "admin" | "teacher";
  onOpen: (item: Pick<AckListItem, "id" | "title">) => void;
}) {
  const { t, day } = useAckText();
  const list = useAckList();

  if (list.isLoading) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (list.isError || !list.data) {
    return <LoadError variant="inline" title={t("list.loadFailed")} hint={t("list.loadFailedHint")} />;
  }
  if (list.data.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        headingLevel={3}
        title={t("list.emptyTitle")}
        description={t(`list.empty.${audience}`)}
      />
    );
  }

  const reminder = (item: AckListItem): string => {
    const kind = reminderOf(item);
    return kind === "DUE" ? t("list.reminder.DUE", { date: day(item.remindAt!) }) : t(`list.reminder.${kind}`);
  };

  return (
    <TableCard caption={t("list.caption")} tableClassName="min-w-[46rem]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("list.colMessage")}</TableHead>
          <TableHead scope="col">{t("list.colRule")}</TableHead>
          <TableHead scope="col">{t("list.colDone")}</TableHead>
          <TableHead scope="col">{t("list.colWaiting")}</TableHead>
          <TableHead scope="col">{t("list.colReminder")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.data.map((item) => (
          <TableRow key={item.id}>
            <TableCell className="max-w-xs">
              <Button
                id={openerId(item.id)}
                type="button"
                variant="link"
                className="h-auto whitespace-normal p-0 text-left font-medium"
                onClick={() => onOpen(item)}
              >
                {item.title}
              </Button>
              <div className="text-xs text-muted-foreground">
                {t("list.sentBy", { date: day(item.createdAt), author: item.authorName })}
              </div>
            </TableCell>
            <TableCell>{t(`rule.${item.rule}.short`)}</TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-2">
                <span>{t("list.doneOf", { met: item.met, pupils: item.pupils })}</span>
                {isDone(item) ? <Badge variant="success">{t("list.allDone")}</Badge> : null}
              </div>
            </TableCell>
            <TableCell>{t("list.waiting", { count: item.waiting })}</TableCell>
            <TableCell>{reminder(item)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableCard>
  );
}
