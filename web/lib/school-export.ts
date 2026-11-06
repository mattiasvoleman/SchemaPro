import { createClient } from "@/utils/supabase/client";
import { ApiError } from "@/lib/api";
import { pageSchool, schoolHeaders } from "@/lib/school-choice";

/**
 * Hela skolans data (K5): the order's shape as the gateway answers it
 * (GET /api/v1/school-exports), and the fetch of the finished file.
 *
 * The file is a zip of up to a few hundred megabytes, so it is not the JSON
 * the rest of the client carries: this reads the response as a Blob and hands
 * it to the browser as a download. It sends what the client sends (the session's
 * token, the school the page was drawn for). The gateway has held out the
 * persons with a protected identity before a byte leaves it, and says how many
 * on the order (heldOut), which the card shows; this module only hands the
 * file over.
 */

export type SchoolExportStatus = "QUEUED" | "RUNNING" | "READY" | "FAILED" | "EXPIRED";

export interface SchoolExportOrder {
  id: string;
  status: SchoolExportStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  byteSize: number | null;
  sha256: string | null;
  files: Array<{ path: string; rows: number; bytes: number }> | null;
  heldOut: { people: number; links: number } | null;
  errorClass: string | null;
  requestedBy: { id: string; name: string } | null;
  fetchable: boolean;
}

/** What POST /api/v1/school-exports/subject-access answers. */
export interface SubjectAccessAnswer {
  filename: string;
  contentType: "application/zip";
  contentBase64: string;
  subjectIsMarked: boolean;
  relatedIncluded: number;
  relatedHeldOut: number;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");

/** The finished file, saved by the browser under the name the gateway gave it. */
export async function downloadSchoolExport(id: string): Promise<void> {
  if (!API_BASE_URL) throw new ApiError(0, "NEXT_PUBLIC_API_BASE_URL is not configured.");
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ApiError(401, "Not authenticated.");
  const response = await fetch(`${API_BASE_URL}/api/v1/school-exports/${encodeURIComponent(id)}/file`, {
    headers: { Authorization: `Bearer ${session.access_token}`, ...schoolHeaders(pageSchool()) },
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    let code: string | undefined;
    try {
      const problem = (await response.json()) as { detail?: string; message?: string; code?: unknown };
      detail = problem.detail ?? problem.message ?? detail;
      if (typeof problem.code === "string") code = problem.code;
    } catch {
      // A body that is not JSON: keep the status.
    }
    throw new ApiError(response.status, detail, code);
  }
  const filename = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "rastra-skolexport.zip";
  const blob = await response.blob();
  const expected = Number(response.headers.get("Content-Length"));
  // A body cut short is a corrupt zip: say so here rather than let the school open it.
  if (Number.isFinite(expected) && expected > 0 && blob.size !== expected) throw new ApiError(502, "The file was cut short.", "SCHOOL_EXPORT_INCOMPLETE");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
