"use client";

import { useTranslations } from "next-intl";
import { CONTACT_MAX, LIMITS, type ContactField, type Errors, type ExternalContactForm } from "@/lib/local";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * Who a series is for: the organisation, the contact, a telephone number and an
 * address (at least one of them) and, if wanted, what it is for. The fields of
 * the registration and of changing them afterwards, so that one sentence of
 * refusal and one limit serve both.
 *
 * `idPrefix` keeps the ids apart when the form is in a dialog that stands over
 * another. What is typed stays in the caller's state and goes to the gateway:
 * no toast, no log and no URL carries a value of it.
 */
export function ContactFields({
  form,
  errors,
  show,
  idPrefix,
  onChange,
}: {
  form: ExternalContactForm;
  errors: Errors<ContactField>;
  /** Whether the errors are said yet (after the first attempt). */
  show: boolean;
  idPrefix: string;
  onChange: (patch: Partial<ExternalContactForm>) => void;
}) {
  const t = useTranslations("adminExternalBookings");
  const error = (field: ContactField) => {
    const code = show ? errors[field] : undefined;
    return code ? t(`errors.${code}`, { max: String(CONTACT_MAX[field]), min: String(LIMITS.contactPhoneMin) }) : undefined;
  };

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <FormField id={`${idPrefix}-organisation`} label={t("organisation")} error={error("organisation")}>
          <Input
            value={form.organisation}
            maxLength={LIMITS.organisation}
            autoComplete="off"
            onChange={(event) => onChange({ organisation: event.target.value })}
          />
        </FormField>
        <FormField id={`${idPrefix}-contact-name`} label={t("contactName")} error={error("contactName")}>
          <Input
            value={form.contactName}
            maxLength={LIMITS.contactName}
            autoComplete="off"
            onChange={(event) => onChange({ contactName: event.target.value })}
          />
        </FormField>
        <FormField id={`${idPrefix}-phone`} label={t("phone")} error={error("contactPhone")}>
          <Input
            type="tel"
            value={form.contactPhone}
            maxLength={LIMITS.contactPhone}
            autoComplete="off"
            onChange={(event) => onChange({ contactPhone: event.target.value })}
          />
        </FormField>
        <FormField id={`${idPrefix}-email`} label={t("email")} error={error("contactEmail")}>
          <Input
            type="email"
            value={form.contactEmail}
            maxLength={LIMITS.contactEmail}
            autoComplete="off"
            onChange={(event) => onChange({ contactEmail: event.target.value })}
          />
        </FormField>
      </div>
      <FormField id={`${idPrefix}-purpose`} label={t("purpose")} optional error={error("purpose")}>
        <Input value={form.purpose} maxLength={LIMITS.purpose} onChange={(event) => onChange({ purpose: event.target.value })} />
      </FormField>
      <FormField id={`${idPrefix}-note`} label={t("note")} optional error={error("note")}>
        <Textarea rows={2} value={form.note} maxLength={LIMITS.note} onChange={(event) => onChange({ note: event.target.value })} />
      </FormField>
    </>
  );
}
