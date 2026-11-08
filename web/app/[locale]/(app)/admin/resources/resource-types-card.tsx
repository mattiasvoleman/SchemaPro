"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { LazyDialog, loadConfirm } from "@/components/local/lazy-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { useResourceTypeActions, useResourceTypes } from "@/lib/local-queries";
import type { ResourceTypeResponse } from "@/lib/local";

/** The type form, fetched when first opened. */
const loadTypeDialog = () => import("./resource-dialogs").then((module) => ({ default: module.ResourceTypeDialog }));

/**
 * Resurstyper: the school's own kinds of resource (Surfplattor, Minibuss, Aulan).
 * A kind in use cannot be removed: the row says how many resources have it, and
 * the refusal says which kind and what to do, whether the page knew (the count)
 * or the gateway found out (somebody added a resource a moment ago).
 */
export function ResourceTypesCard() {
  const t = useTranslations("adminResources");
  const tCommon = useTranslations("common");
  const types = useResourceTypes();
  const actions = useResourceTypeActions();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ResourceTypeResponse | null>(null);
  // The kind the confirmation is about stays set while the dialog closes, so its title does not empty under the fade.
  const [deleting, setDeleting] = useState<ResourceTypeResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [inUse, setInUse] = useState<ResourceTypeResponse | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openRename = (type: ResourceTypeResponse) => {
    setEditing(type);
    setDialogOpen(true);
  };
  const askDelete = (type: ResourceTypeResponse) => {
    if (type.resources > 0) {
      setInUse(type);
      return;
    }
    setInUse(null);
    setDeleting(type);
    setConfirmOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await actions.remove.mutateAsync(deleting.id);
      toast.success(tCommon("deleted"));
      setConfirmOpen(false);
    } catch (error) {
      setConfirmOpen(false);
      // The gateway refuses a kind that has resources with a 400, whatever the page knew.
      if (error instanceof ApiError && error.status === 400) {
        setInUse(deleting);
      } else {
        toast.error(error instanceof Error ? error.message : tCommon("error"));
      }
    }
  };

  const list = types.data ?? [];

  return (
    <SectionCard
      id="resource-types"
      title={t("typesTitle")}
      icon={Tags}
      description={t("typesHint")}
      action={
        <Button data-writes="PLANERING" size="sm" variant="outline" onClick={openCreate}>
          <Plus />
          {t("addType")}
        </Button>
      }
    >
      {inUse ? (
        <Notice tone="destructive" title={t("typeInUse", { name: inUse.name })} onDismiss={() => setInUse(null)} dismissLabel={tCommon("close")}>
          {t("typeInUseHint")}
        </Notice>
      ) : null}

      {types.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : types.isError ? (
        <LoadError variant="inline" title={t("typesLoadFailed")} hint={t("loadFailedHint")} />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("typesEmpty")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {list.map((type) => (
            <li key={type.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-medium">{type.name}</span>
                <Badge variant="secondary">{t("resourcesCount", { count: type.resources })}</Badge>
              </div>
              {/* Both actions write: RowActions takes no attribute, so the wrapper carries it. */}
              <div data-writes="PLANERING" className="contents">
                <RowActions
                  name={type.name}
                  actions={[
                    {
                      label: t("rename"),
                      icon: Pencil,
                      ariaLabel: t("renameNamed", { name: type.name }),
                      onSelect: () => openRename(type),
                    },
                    {
                      label: tCommon("delete"),
                      icon: Trash2,
                      ariaLabel: t("deleteTypeNamed", { name: type.name }),
                      onSelect: () => askDelete(type),
                    },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <LazyDialog
        load={loadTypeDialog}
        kind="form"
        props={{ open: dialogOpen, onOpenChange: setDialogOpen, editing }}
      />
      <LazyDialog
        load={loadConfirm}
        kind="confirm"
        props={{
          open: confirmOpen,
          onOpenChange: setConfirmOpen,
          title: tCommon("deleteConfirmTitle", { name: deleting?.name ?? "" }),
          description: t("deleteTypeBody"),
          confirmLabel: tCommon("delete"),
          loading: actions.remove.isPending,
          onConfirm: () => void confirmDelete(),
        }}
      />
    </SectionCard>
  );
}
