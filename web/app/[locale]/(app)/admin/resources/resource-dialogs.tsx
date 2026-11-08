"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useResourceActions, useResourceTypeActions } from "@/lib/local-queries";
import {
  EMPTY_RESOURCE_FORM,
  LIMITS,
  resourceBody,
  resourceErrors,
  resourceFormOf,
  resourceTypeErrors,
  type ResourceForm,
  type ResourceResponse,
  type ResourceTypeResponse,
} from "@/lib/local";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useSites } from "../rooms/use-sites";

/*
 * The two forms of Resurser, fetched when first opened (components/local/lazy-dialog.tsx).
 * Each form is mounted with the dialog's content, so it starts from the row it is
 * opened on every time and holds nothing between two opens.
 */

interface DialogProps<Row> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row being changed; null for a new one. */
  editing: Row | null;
}

export function ResourceTypeDialog({ open, onOpenChange, editing }: DialogProps<ResourceTypeResponse>) {
  const t = useTranslations("adminResources");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? t("renameType") : t("addType")}</DialogTitle>
          <DialogDescription>{t("typeDialogHint")}</DialogDescription>
        </DialogHeader>
        <TypeForm editing={editing} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function TypeForm({ editing, onDone }: { editing: ResourceTypeResponse | null; onDone: () => void }) {
  const t = useTranslations("adminResources");
  const tCommon = useTranslations("common");
  const actions = useResourceTypeActions();
  const [name, setName] = useState(editing?.name ?? "");
  const [tried, setTried] = useState(false);
  const errors = resourceTypeErrors(name);
  const pending = actions.create.isPending || actions.update.isPending;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (errors.name) return;
    try {
      if (editing) await actions.update.mutateAsync({ id: editing.id, name: name.trim() });
      else await actions.create.mutateAsync({ name: name.trim() });
      toast.success(editing ? tCommon("updated") : tCommon("created"));
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <FormField
        id="resource-type-name"
        label={tCommon("name")}
        error={tried && errors.name ? t(`errors.${errors.name}`, { max: LIMITS.typeName }) : undefined}
      >
        <Input
          value={name}
          maxLength={LIMITS.typeName}
          placeholder={t("typeNamePlaceholder")}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
      </FormField>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {tCommon("save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ResourceDialog({
  open,
  onOpenChange,
  editing,
  types,
}: DialogProps<ResourceResponse> & { types: readonly ResourceTypeResponse[] }) {
  const t = useTranslations("adminResources");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? t("editResource") : t("addResource")}</DialogTitle>
          <DialogDescription>{t("resourceDialogHint")}</DialogDescription>
        </DialogHeader>
        <ResourceFormBody editing={editing} types={types} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ResourceFormBody({
  editing,
  types,
  onDone,
}: {
  editing: ResourceResponse | null;
  types: readonly ResourceTypeResponse[];
  onDone: () => void;
}) {
  const t = useTranslations("adminResources");
  const tCommon = useTranslations("common");
  const actions = useResourceActions();
  const sites = useSites();
  const [form, setForm] = useState<ResourceForm>(() =>
    editing ? resourceFormOf(editing) : { ...EMPTY_RESOURCE_FORM, resourceTypeId: types.length === 1 ? (types[0]?.id ?? "") : "" },
  );
  const [tried, setTried] = useState(false);
  const errors = resourceErrors(form);
  const pending = actions.create.isPending || actions.update.isPending;
  const siteList = sites.data?.sites ?? [];
  // The row's own skolområde stays a choice even if the list of sites could not be read.
  const knownSite = siteList.some((site) => site.id === form.siteId);
  // The ceiling each field's sentence names: a quantity's is not a name's.
  const maxOf = { name: LIMITS.resourceName, resourceTypeId: LIMITS.resourceName, quantity: LIMITS.quantity, place: LIMITS.place };
  const error = (field: keyof typeof errors) => (tried && errors[field] ? t(`errors.${errors[field]}`, { max: maxOf[field] }) : undefined);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    const body = resourceBody(form);
    try {
      if (editing) await actions.update.mutateAsync({ id: editing.id, ...body });
      else await actions.create.mutateAsync(body);
      toast.success(editing ? tCommon("updated") : tCommon("created"));
      onDone();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : tCommon("error"));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <FormField id="resource-name" label={tCommon("name")} error={error("name")}>
        <Input
          value={form.name}
          maxLength={LIMITS.resourceName}
          placeholder={t("namePlaceholder")}
          autoComplete="off"
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <FormField id="resource-type" label={t("typeColumn")} error={error("resourceTypeId")}>
          <NativeSelect
            value={form.resourceTypeId}
            onChange={(event) => setForm({ ...form, resourceTypeId: event.target.value })}
          >
            <option value="">{tCommon("select")}</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id="resource-quantity" label={t("quantityLabel")} hint={t("quantityHint")} error={error("quantity")}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={LIMITS.quantity}
            step={1}
            value={form.quantity}
            onChange={(event) => setForm({ ...form, quantity: event.target.value })}
          />
        </FormField>
      </div>
      {siteList.length > 0 || form.siteId !== "" ? (
        <FormField id="resource-site" label={t("site")} hint={t("siteHint")} optional>
          <NativeSelect value={form.siteId} onChange={(event) => setForm({ ...form, siteId: event.target.value })}>
            <option value="">{t("siteNone")}</option>
            {!knownSite && form.siteId !== "" ? <option value={form.siteId}>{editing?.siteName ?? form.siteId}</option> : null}
            {siteList.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      ) : null}
      <FormField id="resource-place" label={t("place")} hint={t("placeHint")} optional error={error("place")}>
        <Input
          value={form.place}
          maxLength={LIMITS.place}
          placeholder={t("placePlaceholder")}
          onChange={(event) => setForm({ ...form, place: event.target.value })}
        />
      </FormField>
      <div className="flex items-start justify-between gap-4 rounded-md border p-3">
        <div className="space-y-1">
          <Label htmlFor="resource-approval">{t("requiresApproval")}</Label>
          <p className="text-xs text-muted-foreground">{t("requiresApprovalHint")}</p>
        </div>
        <Switch
          id="resource-approval"
          checked={form.requiresApproval}
          onCheckedChange={(checked) => setForm({ ...form, requiresApproval: checked })}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {tCommon("save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
