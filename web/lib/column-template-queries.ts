"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TemplateKind } from "@/lib/column-fields";
import type { MappingTemplate, TemplatePlacement } from "@/lib/column-mapping";

// ---------------------------------------------------------------------------
// A school's saved column mappings, through the gateway (/api/v1/import-templates,
// Kolumnmappning X2). A module of its own, not lib/queries.ts: that one is shared
// by 37 routes and sits on the chunker's merge edge, and these hooks are loaded by
// the mapping dialog alone.
//
// Every administrator reads the templates; Planering writes them (the gateway's
// guard and the database's arms say so). A read that fails, a gateway from before
// the templates (404), a school that may not read: the mapping works without them,
// so the read answers an EMPTY list and the dialog says nothing of it, rather than
// turning a convenience into an error.
// ---------------------------------------------------------------------------

export const TEMPLATE_KEYS = {
  all: ["import-templates"] as const,
  kind: (kind: TemplateKind) => ["import-templates", kind] as const,
};

/** What a write sends: the kind (when made), a name, the header row, and the posts. */
export interface TemplateBody {
  name: string;
  headerRow: number | null;
  placements: TemplatePlacement[];
}

/** The school's templates for one kind of import; an empty list when they cannot be read. */
export function useImportTemplates(kind: TemplateKind | null) {
  return useQuery({
    queryKey: kind === null ? TEMPLATE_KEYS.all : TEMPLATE_KEYS.kind(kind),
    enabled: kind !== null,
    // A convenience, not a dependency: a failed read is "no templates", and is not tried again for the sake of it.
    retry: false,
    queryFn: async (): Promise<MappingTemplate[]> => {
      try {
        const found = await api.get<MappingTemplate[]>(`/api/v1/import-templates?kind=${kind}`);
        return Array.isArray(found) ? found : [];
      } catch {
        return [];
      }
    },
  });
}

/** Saves a mapping as a new template of the kind. The caller reads the gateway's refusal (409 name taken, 403 area, 400 header) from the error. */
export function useCreateImportTemplate(kind: TemplateKind) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: TemplateBody) => api.post<MappingTemplate>("/api/v1/import-templates", { kind, ...body }),
    onSuccess: () => client.invalidateQueries({ queryKey: TEMPLATE_KEYS.kind(kind) }),
  });
}

/** Changes a template: its name, its header row (null for the first) or its posts. */
export function useUpdateImportTemplate(kind: TemplateKind) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<TemplateBody>) => api.patch<MappingTemplate>(`/api/v1/import-templates/${id}`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: TEMPLATE_KEYS.kind(kind) }),
  });
}

export function useDeleteImportTemplate(kind: TemplateKind) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/v1/import-templates/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: TEMPLATE_KEYS.kind(kind) }),
  });
}
