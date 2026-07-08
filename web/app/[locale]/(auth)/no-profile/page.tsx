"use client";

import { useTranslations } from "next-intl";
import { ShieldAlert } from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function NoProfilePage() {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const signOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 pt-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-warning/15">
          <ShieldAlert className="h-6 w-6 text-warning" />
        </div>
        <p className="text-sm text-muted-foreground">{t("noProfile")}</p>
        <Button variant="outline" onClick={signOut}>
          {tCommon("signOut")}
        </Button>
      </CardContent>
    </Card>
  );
}
