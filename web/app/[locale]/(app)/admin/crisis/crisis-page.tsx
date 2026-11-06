"use client";

import { Suspense, lazy, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { useProfile, useReadOnly } from "@/components/profile-context";
import { LoadFailed } from "@/components/crisis/load-failed";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCrisisSettings, useRecentAlarms } from "@/lib/crisis-admin-queries";
import { isOpen, mayAct } from "@/lib/crisis-view";
import { useCrisisRealtime } from "@/lib/use-crisis-realtime";
import { StartPanel } from "./start-panel";

/*
 * /admin/crisis — Krisläge: start an alarm, follow the roll call while it
 * goes, read the protocols of the ones that have, and (for those who decide)
 * say who may start one.
 *
 * The start panel is this page's own code and the first thing a person here
 * needs, so it is not behind a chunk. The live view, the protocol and the
 * settings are React.lazy and mounted when wanted (not next/dynamic, whose
 * loader costs 1.4 KB of its own): a tab's content downloads when its tab is
 * opened, and the live view when an alarm is open. The socket is a further
 * import() inside lib/use-crisis-realtime.ts.
 *
 * Who may do what: the page is DRIFT's (lib/admin-areas.ts PAGE_GATES); a
 * reader (Läsbehörighet) sees all of it and starts, ends and marks nothing;
 * a profile the school has not let start an alarm sees the live view and the
 * protocols (mayAct); the settings are changed by those who decide.
 */

const LiveView = lazy(() => import("./live-view").then((module) => ({ default: module.LiveView })));
const ProtocolTab = lazy(() => import("./protocol-tab").then((module) => ({ default: module.ProtocolTab })));
const SettingsTab = lazy(() => import("./settings-tab").then((module) => ({ default: module.SettingsTab })));

type TabName = "alarm" | "protocol" | "settings";

const Loading = () => (
  <div aria-busy="true">
    <Skeleton className="h-64 w-full" />
  </div>
);

export function CrisisPage({ initialAlarmId }: { initialAlarmId: string | null }) {
  const t = useTranslations("crisis");
  useCrisisRealtime();
  const { profile } = useProfile();
  const readOnly = useReadOnly();
  const settings = useCrisisSettings();
  const recent = useRecentAlarms();
  const [tab, setTab] = useState<TabName>("alarm");
  const [chosenId, setChosenId] = useState<string | null>(initialAlarmId);
  const [protocolId, setProtocolId] = useState<string | null>(null);

  // A link to an alarm (the refused start's) opens the live view on it.
  useEffect(() => {
    if (initialAlarmId) {
      setChosenId(initialAlarmId);
      setTab("alarm");
    }
  }, [initialAlarmId]);

  // Unknown settings do not hold an alarm back (mayAct).
  const allowed = mayAct(profile.adminProfile, settings.data?.startProfiles);
  const canAct = allowed && !readOnly;
  const open = [...(recent.data ?? [])].filter(isOpen).sort((a, b) => Number(b.mode === "LIVE") - Number(a.mode === "LIVE"));
  const shownId = chosenId ?? open[0]?.id ?? null;
  const liveOpen = open.some((alarm) => alarm.mode === "LIVE");

  const toProtocol = (id: string) => {
    setProtocolId(id);
    setTab("protocol");
  };

  return (
    <Page>
      {/* Only the protocol's own paper is printed (protocol-tab.tsx): the live view names every pupil, and a print that did not come from "Skriv ut" must not carry the names a file would leave out. */}
      <div className="print:hidden">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as TabName);
          // The protocol a link or the end of an alarm opened is opened once.
          if (value !== "protocol") setProtocolId(null);
        }}
      >
        <TabsList className="print:hidden">
          <TabsTrigger value="alarm">{t("tabs.alarm")}</TabsTrigger>
          <TabsTrigger value="protocol">{t("tabs.protocol")}</TabsTrigger>
          <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
        </TabsList>

        <TabsContent value="alarm" className="space-y-4 print:hidden">
          {/* A read that is slow or fails never holds the start back: the start panel is here at once, and the database refuses what it must. */}
          {recent.isPending ? (
            <div aria-busy="true">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : null}
          {recent.isError ? <LoadFailed variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} /> : null}
          {shownId !== null ? (
            <Suspense fallback={<Loading />}>
              <LiveView
                alarmId={shownId}
                open={open}
                canAct={canAct}
                onSelect={setChosenId}
                onClose={() => setChosenId(null)}
                onProtocol={toProtocol}
              />
            </Suspense>
          ) : null}
          {/* A live alarm is the one thing not started beside another; an exercise is cut short by it. */}
          {!liveOpen && !readOnly ? (
            <StartPanel allowed={allowed} drillOpen={open.length > 0} onStarted={(id) => setChosenId(id)} />
          ) : null}
          {readOnly && !recent.isPending && shownId === null ? <Notice tone="neutral">{t("noAlarmReader")}</Notice> : null}
        </TabsContent>

        <TabsContent value="protocol">
          <Suspense fallback={<Loading />}>
            <ProtocolTab initialId={protocolId} />
          </Suspense>
        </TabsContent>

        <TabsContent value="settings" className="print:hidden">
          <Suspense fallback={<Loading />}>
            <SettingsTab />
          </Suspense>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
