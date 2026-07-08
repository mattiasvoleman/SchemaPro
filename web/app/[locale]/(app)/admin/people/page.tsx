"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Trash2, UserCheck } from "lucide-react";
import { useCrudMutations, useGroups, usePeople } from "@/lib/queries";
import type { Person, UserRole } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ROLES: UserRole[] = ["STUDENT", "TEACHER", "SCHOOL_ADMIN"];
const NO_GROUP = "__none__";

interface PersonForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: UserRole;
  studentGroupId: string;
}

const EMPTY_FORM: PersonForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  role: "STUDENT",
  studentGroupId: NO_GROUP,
};

export default function PeoplePage() {
  const t = useTranslations("people");
  const tCommon = useTranslations("common");
  const tRoles = useTranslations("roles");
  const { data: people, isLoading } = usePeople();
  const { data: groups } = useGroups();
  const mutations = useCrudMutations<{
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string | null;
    role?: UserRole;
    studentGroupId?: string | null;
    isActive?: boolean;
  }>("/api/v1/users", [["people"]]);

  const [filter, setFilter] = useState<"ALL" | UserRole>("ALL");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  const [deleting, setDeleting] = useState<Person | null>(null);
  const [form, setForm] = useState<PersonForm>(EMPTY_FORM);

  const filtered = useMemo(() => {
    if (!people) return [];
    return filter === "ALL" ? people : people.filter((person) => person.role === filter);
  }, [people, filter]);

  const groupName = (id: string | null) =>
    id ? (groups?.find((group) => group.id === id)?.name ?? "—") : "—";

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (person: Person) => {
    setEditing(person);
    setForm({
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      phone: person.phone ?? "",
      role: person.role,
      studentGroupId: person.studentGroupId ?? NO_GROUP,
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const body = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      phone: form.phone.trim() || null,
      role: form.role,
      studentGroupId:
        form.role === "STUDENT" && form.studentGroupId !== NO_GROUP
          ? form.studentGroupId
          : null,
    };
    try {
      if (editing) {
        await mutations.update.mutateAsync({ id: editing.id, ...body });
        toast.success(tCommon("updated"));
      } else {
        await mutations.create.mutateAsync({ ...body, email: form.email.trim() });
        toast.success(tCommon("created"));
      }
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await mutations.remove.mutateAsync(deleting.id);
      toast.success(tCommon("deleted"));
      setDeleting(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onClick={openCreate}>
            <Plus />
            {t("addPerson")}
          </Button>
        }
      />

      <Tabs
        value={filter}
        onValueChange={(value) => setFilter(value as "ALL" | UserRole)}
        className="mb-4"
      >
        <TabsList>
          <TabsTrigger value="ALL">{t("filterAll")}</TabsTrigger>
          {ROLES.map((role) => (
            <TabsTrigger key={role} value={role}>
              {tRoles(role)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={UserCheck} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tCommon("name")}</TableHead>
                <TableHead>{t("email")}</TableHead>
                <TableHead>{t("role")}</TableHead>
                <TableHead>{t("class")}</TableHead>
                <TableHead>{tCommon("status")}</TableHead>
                <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((person) => (
                <TableRow key={person.id}>
                  <TableCell className="font-medium">
                    {person.firstName} {person.lastName}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{person.email}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{tRoles(person.role)}</Badge>
                  </TableCell>
                  <TableCell>{groupName(person.studentGroupId)}</TableCell>
                  <TableCell>
                    {person.isActive ? (
                      <Badge variant="success">{t("activeState")}</Badge>
                    ) : (
                      <Badge variant="outline">{t("inactive")}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(person)}
                      aria-label={tCommon("edit")}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleting(person)}
                      aria-label={tCommon("delete")}
                    >
                      <Trash2 className="text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editPerson") : t("addPerson")}</DialogTitle>
            {!editing ? <DialogDescription>{t("authHint")}</DialogDescription> : null}
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="person-first">{t("firstName")}</Label>
                <Input
                  id="person-first"
                  value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="person-last">{t("lastName")}</Label>
                <Input
                  id="person-last"
                  value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="person-email">{t("email")}</Label>
              <Input
                id="person-email"
                type="email"
                value={form.email}
                disabled={editing !== null}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="person-phone">
                  {t("phone")}{" "}
                  <span className="text-muted-foreground">({tCommon("optional")})</span>
                </Label>
                <Input
                  id="person-phone"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("role")}</Label>
                <Select
                  value={form.role}
                  onValueChange={(value) => setForm({ ...form, role: value as UserRole })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {tRoles(role)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.role === "STUDENT" ? (
              <div className="space-y-2">
                <Label>{t("class")}</Label>
                <Select
                  value={form.studentGroupId}
                  onValueChange={(value) => setForm({ ...form, studentGroupId: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_GROUP}>{tCommon("none")}</SelectItem>
                    {(groups ?? []).map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={submit}
              disabled={
                form.firstName.trim().length === 0 ||
                form.lastName.trim().length === 0 ||
                (!editing && form.email.trim().length === 0) ||
                mutations.create.isPending ||
                mutations.update.isPending
              }
            >
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tCommon("deleteConfirmTitle", {
          name: deleting ? `${deleting.firstName} ${deleting.lastName}` : "",
        })}
        description={tCommon("deleteConfirmBody")}
        confirmLabel={tCommon("delete")}
        loading={mutations.remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
