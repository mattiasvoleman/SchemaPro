"use client";

import { use } from "react";
import { LessonLogPage } from "@/components/lesson-log/lesson-log-page";

/**
 * /teacher/lektion/[lessonId]: a lesson's topic and homework, and its note to
 * the substitute (components/lesson-log/lesson-log-page.tsx). Opened from the
 * teacher's week, the register and Mina vikariepass.
 */
export default function TeacherLessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = use(params);
  return <LessonLogPage lessonId={lessonId} />;
}
