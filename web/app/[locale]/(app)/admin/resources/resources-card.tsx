"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Boxes, Pencil, Plus, Trash2 } from "lucide-react";
import { LazyDialog, loadConfirm } from "@/components/local/lazy-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/api";
import { placeText, type ResourceResponse } from "@/lib/local";
import { useResourceActions, useResourceTypes, useResources } from "@/lib/local-queries";

/** The resource form, fetched when first opened. */
const loadResourceDialog = () => import("./resource-dialogs").then((module) => ({ default: module.ResourceDialog }));

/**
 * Resurser: what the school lends out that is not a lokal. A resource has a
 * kind, a quantity (how many there are), a place (a skolområde and words) and
 * whether a booking by staff waits for Drift's decision.
 */
export function ResourcesCard() {
  const t = useTranslations("adminResources");
  const tCommon = useTranslations("common");
  const resources = useResources();
  const types = useResourceTypes();
  const actions = useResourceActions();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ResourceResponse | null>(null);
  const [deleting, setDeleting] = useState<ResourceResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [inUse, setInUse] = useState<ResourceResponse | null>(null);

  const noTypes = types.isSuccess && types.data.length === 0;
  const list = resources.data ?? [];

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (resource: ResourceResponse) => {
    setEditing(resource);
    setDialogOpen(true);
  };
  const askDelete = (resource: ResourceResponse) => {
    setInUse(null);
    setDeleting(resource);
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
      // A resource with a series of external bookings is kept (their days stand on it), also once the series has ended.
      if (error instanceof ApiError && error.status === 409) {
        setInUse(deleting);
      } else {
        toast.error(error instanceof Error ? error.message : tCommon("error"));
      }
    }
  };

  return (
    <SectionCard
      id="resources"
      title={t("resourcesTitle")}
      icon={Boxes}
      description={t("resourcesHint")}
      action={
        <Button
          data-writes="PLANERING"
          size="sm"
          onClick={openCreate}
          disabled={noTypes}
          aria-describedby={noTypes ? "resources-need-type" : undefined}
        >
          <Plus />
          {t("addResource")}
        </Button>
      }
    >
      {noTypes ? (
        <p id="resources-need-type" className="text-sm text-muted-foreground" data-writes="PLANERING">
          {t("needType")}
        </p>
      ) : null}
      {inUse ? (
        <Notice
          tone="destructive"
          title={t("resourceInUse", { name: inUse.name })}
          onDismiss={() => setInUse(null)}
          dismissLabel={tCommon("close")}
        >
          {t("resourceInUseHint")}
        </Notice>
      ) : null}

      {resources.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : resources.isError ? (
        <LoadError variant="inline" title={t("resourcesLoadFailed")} hint={t("loadFailedHint")} />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("resourcesEmpty")}</p>
      ) : (
        <TableCard caption={t("tableCaption")}>
          <TableHeader>
            <TableRow>
              <TableHead>{tCommon("name")}</TableHead>
              <TableHead>{t("typeColumn")}</TableHead>
              <TableHead className="text-right">{t("quantityColumn")}</TableHead>
              <TableHead>{t("placeColumn")}</TableHead>
              <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((resource) => {
              const place = placeText(resource);
              return (
                <TableRow key={resource.id}>
                  <TableCell className="font-medium">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {resource.name}
                      {resource.requiresApproval ? <Badge variant="secondary">{t("approvalBadge")}</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell>{resource.resourceTypeName}</TableCell>
                  <TableCell className="text-right tabular-nums">{resource.quantity}</TableCell>
                  <TableCell>{place ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right">
                    <div data-writes="PLANERING" className="contents">
                      <RowActions
                        name={resource.name}
                        actions={[
                          {
                            label: tCommon("edit"),
                            icon: Pencil,
                            ariaLabel: tCommon("editNamed", { name: resource.name }),
                            onSelect: () => openEdit(resource),
                          },
                          {
                            label: tCommon("delete"),
                            icon: Trash2,
                            ariaLabel: tCommon("deleteNamed", { name: resource.name }),
                            onSelect: () => askDelete(resource),
                          },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </TableCard>
      )}

      <LazyDialog
        load={loadResourceDialog}
        kind="form"
        props={{ open: dialogOpen, onOpenChange: setDialogOpen, editing, types: types.data ?? [] }}
      />
      <LazyDialog
        load={loadConfirm}
        kind="confirm"
        props={{
          open: confirmOpen,
          onOpenChange: setConfirmOpen,
          title: tCommon("deleteConfirmTitle", { name: deleting?.name ?? "" }),
          description: t("deleteResourceBody"),
          confirmLabel: tCommon("delete"),
          loading: actions.remove.isPending,
          onConfirm: () => void confirmDelete(),
        }}
      />
    </SectionCard>
  );
}
