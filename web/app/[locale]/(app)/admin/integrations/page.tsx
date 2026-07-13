"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface KeyRow {
  id: string;
  name: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export default function IntegrationsPage() {
  const t = useTranslations("integrations");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);

  const { data: keys, isLoading } = useQuery({
    queryKey: ["integrationKeys"],
    queryFn: () => api.get<KeyRow[]>("/api/v1/integration-keys"),
  });

  const create = useMutation({
    mutationFn: (body: { name: string }) =>
      api.post<KeyRow & { key: string }>("/api/v1/integration-keys", body),
    onSuccess: (result) => {
      setFreshKey(result.key);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["integrationKeys"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : tCommon("error")),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/integration-keys/${id}`),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["integrationKeys"] }),
  });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("createTitle")}</CardTitle>
          <CardDescription>{t("createBody")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder={t("namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              onClick={() => create.mutate({ name: name.trim() || "Integration" })}
              disabled={create.isPending}
            >
              {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
              {t("create")}
            </Button>
          </div>
          {freshKey ? (
            <div className="rounded-md border border-warning/50 bg-warning/10 p-3">
              <p className="mb-2 text-sm font-medium">{t("freshKeyTitle")}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded bg-background px-2 py-1 text-xs">
                  {freshKey}
                </code>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(freshKey);
                    toast.success(tCommon("copied"));
                  }}
                >
                  <Copy />
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t("freshKeyHint")}</p>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("docsHint")}</p>
        </CardContent>
      </Card>

      {isLoading ? null : (keys ?? []).length === 0 ? (
        <EmptyState icon={KeyRound} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <div className="space-y-2">
          {(keys ?? []).map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{entry.name}</span>
                  {entry.revokedAt ? (
                    <Badge variant="destructive">{t("revoked")}</Badge>
                  ) : (
                    <Badge variant="success">{t("active")}</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("created")}: {new Date(entry.createdAt).toLocaleDateString()}
                  {entry.lastUsedAt
                    ? ` · ${t("lastUsed")}: ${new Date(entry.lastUsedAt).toLocaleString()}`
                    : ` · ${t("neverUsed")}`}
                </div>
              </div>
              {!entry.revokedAt ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => revoke.mutate(entry.id)}
                  disabled={revoke.isPending}
                >
                  <Trash2 />
                  {t("revoke")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
