"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, ClipboardCheck, Loader2, X } from "lucide-react";
import {
  useLeaveRequestActions,
  useLeaveRequests,
  usePeople,
} from "@/lib/queries";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Filter = "PENDING" | "APPROVED" | "REJECTED";

export default function LeaveRequestsPage() {
  const t = useTranslations("adminLeave");
  const tGuardian = useTranslations("guardian");
  const tCommon = useTranslations("common");
  const [filter, setFilter] = useState<Filter>("PENDING");
  const { data: leaves, isLoading } = useLeaveRequests(filter);
  const { data: people } = usePeople();
  const actions = useLeaveRequestActions();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const personName = useMemo(() => {
    const byId = new Map((people ?? []).map((person) => [person.id, person]));
    return (id: string) => {
      const person = byId.get(id);
      return person ? `${person.firstName} ${person.lastName}` : "—";
    };
  }, [people]);

  const decide = async (id: string, status: "APPROVED" | "REJECTED") => {
    try {
      const result = await actions.decide.mutateAsync({
        id,
        status,
        note: notes[id]?.trim() || undefined,
      });
      toast.success(
        status === "APPROVED"
          ? t("approved", { count: (result as { absenceDays?: number }).absenceDays ?? 0 })
          : t("rejected"),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)} className="mb-4">
        <TabsList>
          <TabsTrigger value="PENDING">{tGuardian("statusPENDING")}</TabsTrigger>
          <TabsTrigger value="APPROVED">{tGuardian("statusAPPROVED")}</TabsTrigger>
          <TabsTrigger value="REJECTED">{tGuardian("statusREJECTED")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? null : (leaves ?? []).length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <div className="space-y-3">
          {(leaves ?? []).map((leave) => (
            <Card key={leave.id}>
              <CardContent className="pt-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {personName(leave.studentId)}
                      <span className="ml-2 tabular-nums text-sm text-muted-foreground">
                        {leave.startDate.slice(0, 10)} – {leave.endDate.slice(0, 10)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{leave.reason}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("requestedBy", { name: personName(leave.requestedById) })} ·{" "}
                      {new Date(leave.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  {leave.status === "PENDING" ? (
                    <div className="flex flex-col items-end gap-2">
                      <Input
                        placeholder={t("notePlaceholder")}
                        className="h-8 w-64"
                        value={notes[leave.id] ?? ""}
                        onChange={(e) =>
                          setNotes({ ...notes, [leave.id]: e.target.value })
                        }
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => void decide(leave.id, "APPROVED")}
                          disabled={actions.decide.isPending}
                        >
                          {actions.decide.isPending ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Check />
                          )}
                          {t("approve")}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void decide(leave.id, "REJECTED")}
                          disabled={actions.decide.isPending}
                        >
                          <X />
                          {t("reject")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Badge variant={leave.status === "APPROVED" ? "success" : "destructive"}>
                      {tGuardian(`status${leave.status}`)}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
