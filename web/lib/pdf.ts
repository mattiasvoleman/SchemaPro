// PDF rendering of the weekly master timetable (one table per weekday).

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export interface PdfLesson {
  dayOfWeek: number; // ISO 1-7
  startTime: string; // HH:MM
  endTime: string;
  subject: string;
  group: string;
  teacher: string;
  room: string;
}

export function exportTimetablePdf(options: {
  title: string;
  subtitle?: string;
  dayNames: string[]; // index 0 = Monday
  columnLabels: { time: string; subject: string; group: string; teacher: string; room: string };
  lessons: PdfLesson[];
  filename?: string;
}): void {
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text(options.title, 14, 16);
  if (options.subtitle) {
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text(options.subtitle, 14, 22);
    doc.setTextColor(0);
  }

  let cursorY = options.subtitle ? 30 : 24;
  const { time, subject, group, teacher, room } = options.columnLabels;

  for (let day = 1; day <= 7; day++) {
    const dayLessons = options.lessons
      .filter((lesson) => lesson.dayOfWeek === day)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    if (dayLessons.length === 0) continue;

    if (cursorY > 250) {
      doc.addPage();
      cursorY = 16;
    }

    doc.setFontSize(12);
    doc.text(options.dayNames[day - 1] ?? String(day), 14, cursorY);

    autoTable(doc, {
      startY: cursorY + 2,
      head: [[time, subject, group, teacher, room]],
      body: dayLessons.map((lesson) => [
        `${lesson.startTime}–${lesson.endTime}`,
        lesson.subject,
        lesson.group,
        lesson.teacher,
        lesson.room,
      ]),
      margin: { left: 14, right: 14 },
      styles: { fontSize: 9, cellPadding: 1.5 },
      headStyles: { fillColor: [99, 102, 241] },
      theme: "grid",
    });

    cursorY =
      (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  }

  doc.save(options.filename ?? "timetable.pdf");
}
